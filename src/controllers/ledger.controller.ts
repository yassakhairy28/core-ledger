import type { Request, Response } from "express";
import mongoose from "mongoose";
import { LedgerEngine } from "../ledger/engine.js";
import type {
  account_state,
  account_type,
  ledger_command,
  ledger_event_data,
} from "../ledger/engine.js";
import { ApiError } from "../middlewares/error.handler.middleware.js";
import { SnapshotModel } from "../DB/models/snapshot.model.js";
import { EventModel } from "../DB/models/event.model.js";

const engine = new LedgerEngine();

export class LedgerController {
  /**
   * الـ Wrapper المركزي لإدارة الـ ACID Transactions لضمان الـ Atomicity والـ Crash Recovery
   */
  private static async execute_in_transaction(
    req: Request,
    res: Response,
    command: ledger_command,
  ) {
    const idempotency_key = req.headers["idempotency-key"] as string;

    if (!idempotency_key) {
      return res
        .status(400)
        .json({ error: "missing required 'Idempotency-Key' header" });
    }

    const shouldRetryError = (err: any) => {
      return (
        err?.code === 11000 ||
        err?.code === 112 ||
        err?.errorLabels?.includes("TransientTransactionError") ||
        err?.errorLabels?.includes("UnknownTransactionCommitResult") ||
        /write conflict/i.test(err?.message || "")
      );
    };

    const isTransactionUnsupported = (err: any) =>
      err?.message?.includes(
        "Transaction numbers are only allowed on a replica set member or mongos",
      );

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const session = await mongoose.startSession();
      let transactionStarted = false;

      try {
        await session.startTransaction();
        transactionStarted = true;
      } catch (transactionError: any) {
        await session.endSession();
        throw new ApiError(
          "MongoDB transactions are required for safe ledger operations. Please use a replica set or sharded cluster.",
          500,
        );
      }

      try {
        const result = await engine.process_command(
          command,
          idempotency_key,
          session,
        );

        await session.commitTransaction();
        return res.status(200).json(result);
      } catch (error: any) {
        try {
          if (transactionStarted) {
            await session.abortTransaction();
          }
        } catch (abortError: any) {
          console.warn("Abort transaction failed:", abortError.message);
        } finally {
          session.endSession();
        }

        if (shouldRetryError(error) && attempt < maxAttempts) {
          continue;
        }

        const statusCode = error.statusCode || 400;
        return res.status(statusCode).json({ error: error.message });
      }
    }

    return res
      .status(500)
      .json({ error: "Ledger request could not complete after retries." });
  }

  // POST /accounts
  public async open_account(req: Request, res: Response) {
    const command: ledger_command = {
      type: "open_account",
      accountId: req.body.account_id,
      accountType: req.body.account_type,
    };
    await LedgerController.execute_in_transaction(req, res, command);
  }

  // POST /transfers
  public async transfer(req: Request, res: Response) {
    const command: ledger_command = {
      type: "transfer",
      fromAccountId: req.body.from_account_id,
      toAccountId: req.body.to_account_id,
      amount: req.body.amount,
    };
    await LedgerController.execute_in_transaction(req, res, command);
  }

  // POST /holds
  public async place_hold(req: Request, res: Response) {
    const command: ledger_command = {
      type: "place_hold",
      accountId: req.body.account_id,
      holdId: req.body.hold_id,
      amount: req.body.amount,
    };
    await LedgerController.execute_in_transaction(req, res, command);
  }

  // POST /holds/:id/capture
  public async capture_hold(req: Request, res: Response) {
    const command: ledger_command = {
      type: "capture_hold",
      holdId: req.params.id as string,
      accountId: req.body.account_id,
    };
    await LedgerController.execute_in_transaction(req, res, command);
  }

  // POST /holds/:id/void
  public async void_hold(req: Request, res: Response) {
    const command: ledger_command = {
      type: "void_hold",
      holdId: req.params.id as string,
      accountId: req.body.account_id,
    };
    await LedgerController.execute_in_transaction(req, res, command);
  }

  // GET /accounts/:id/balance
  public async get_balance(req: Request, res: Response) {
    try {
      const account_id = req.params.id as string;
      const { state, version } = await engine.get_account_state(account_id);
      return res.status(200).json({
        account_id: state.accountId,
        type: state.type,
        available_balance: state.availableBalance,
        pending_balance: state.pendingBalance,
        version,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }

  /**
   * الـ Audit Endpoint للتأكد من الـ Invariants والـ Deterministic Replay (Byte-for-byte)
   */
  public async verify_invariants(req: Request, res: Response) {
    try {
      const snapshots = await SnapshotModel.find({}).lean();

      let global_system_balance = 0;
      let is_system_valid = true;
      const validation_errors: string[] = [];

      for (const snap of snapshots) {
        global_system_balance += snap.availableBalance + snap.pendingBalance;

        if (snap.type === "customer" && snap.availableBalance < 0) {
          is_system_valid = false;
          validation_errors.push(
            `Account ${snap.accountId} (customer) violated overdraft constraint: ${snap.availableBalance}`,
          );
        }

        // إعادة بناء الحالة للحساب من الصفر بناءً على الـ Event Log فقط
        let replayed_state: account_state = {
          accountId: snap.accountId,
          type: snap.type as account_type,
          availableBalance: 0,
          pendingBalance: 0,
          holds: {},
        };

        const all_account_events = await EventModel.find({
          aggregateId: snap.accountId,
        })
          .sort({ version: 1 })
          .lean();

        for (const ev of all_account_events) {
          replayed_state = LedgerEngine.apply_event(
            replayed_state,
            ev.data as ledger_event_data,
          );
        }

        const current_db_state = {
          accountId: snap.accountId,
          type: snap.type,
          availableBalance: snap.availableBalance,
          pendingBalance: snap.pendingBalance,
          holds: snap.holds || {},
        };

        if (
          JSON.stringify(replayed_state) !== JSON.stringify(current_db_state)
        ) {
          is_system_valid = false;
          validation_errors.push(
            `Replay state mismatch for account ${snap.accountId}. Byte-for-byte drift detected.`,
          );
        }
      }

      // تشك الـ Closed System (Zero-Sum)
      if (global_system_balance !== 0) {
        is_system_valid = false;
        validation_errors.push(
          `Closed system violation! Global balance sum across all accounts is: ${global_system_balance}`,
        );
      }

      if (is_system_valid) {
        return res.status(200).json({
          status: "SUCCESS",
          message:
            "All invariants passed successfully. System state is integer-tight.",
          meta: {
            total_accounts: snapshots.length,
            global_sum: global_system_balance,
          },
        });
      } else {
        return res.status(500).json({
          status: "FAILED",
          message: "System invariants broken!",
          errors: validation_errors,
        });
      }
    } catch (error: any) {
      return res.status(500).json({ status: "ERROR", error: error.message });
    }
  }
}
