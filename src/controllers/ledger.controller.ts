import type { Request, Response } from "express";
import { LedgerEngine } from "../ledger/engine.js";
import type { LedgerCommand } from "../ledger/engine.js";
import { ApiError } from "../middlewares/error.handler.middleware.js";

const engine = new LedgerEngine();

const parseErrorStatus = (error: unknown): number => {
  if (!(error instanceof Error)) return 500;
  if (error.message.includes("not found")) return 404;
  if (error.message.includes("already being processed")) return 409;
  if (error.message.includes("Idempotency-Key is required")) return 400;
  if (error.message.includes("Insufficient funds")) return 400;
  if (error.message.includes("does not exist")) return 400;
  if (error.message.includes("must be")) return 400;
  if (error.message.includes("not balanced")) return 400;
  return 400;
};

export class LedgerController {
  private static getIdempotencyKey(req: Request): string {
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new ApiError("missing required 'Idempotency-Key' header", 400);
    }
    return idempotencyKey;
  }

  public async open_account(req: Request, res: Response) {
    try {
      const command: LedgerCommand = {
        type: "open_account",
        accountId: req.body.account_id,
        accountType: req.body.account_type,
      };
      const result = await engine.processCommand(
        command,
        LedgerController.getIdempotencyKey(req),
      );
      res.status(200).json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async transfer(req: Request, res: Response) {
    try {
      const command: LedgerCommand = {
        type: "transfer",
        fromAccountId: req.body.from_account_id,
        toAccountId: req.body.to_account_id,
        amount: req.body.amount,
      };
      const result = await engine.processCommand(
        command,
        LedgerController.getIdempotencyKey(req),
      );
      res.status(200).json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async place_hold(req: Request, res: Response) {
    try {
      const command: LedgerCommand = {
        type: "place_hold",
        accountId: req.body.account_id,
        holdId: req.body.hold_id,
        amount: req.body.amount,
      };
      const result = await engine.processCommand(
        command,
        LedgerController.getIdempotencyKey(req),
      );
      res.status(200).json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async capture_hold(req: Request, res: Response) {
    try {
      const command: LedgerCommand = {
        type: "capture_hold",
        accountId: req.body.account_id,
        holdId: req.params.id as string,
      };
      const result = await engine.processCommand(
        command,
        LedgerController.getIdempotencyKey(req),
      );
      res.status(200).json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async void_hold(req: Request, res: Response) {
    try {
      const command: LedgerCommand = {
        type: "void_hold",
        accountId: req.body.account_id,
        holdId: req.params.id as string,
      };
      const result = await engine.processCommand(
        command,
        LedgerController.getIdempotencyKey(req),
      );
      res.status(200).json(result);
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async get_balance(req: Request, res: Response) {
    try {
      const accountId = req.params.id as string;
      if (!(await engine.accountExists(accountId))) {
        return res.status(404).json({ error: "Account not found" });
      }
      const { state, version } = await engine.getAccountState(accountId);
      res.status(200).json({
        account_id: state.accountId,
        type: state.type,
        available_balance: state.availableBalance,
        pending_balance: state.pendingBalance,
        version,
      });
    } catch (error: unknown) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  public async get_statement(req: Request, res: Response) {
    try {
      const accountId = req.params.id as string;
      const statement = await engine.getAccountStatement(accountId);
      res.status(200).json({ account_id: accountId, statement });
    } catch (error: unknown) {
      const status =
        error instanceof ApiError
          ? (error.statusCode ?? 400)
          : parseErrorStatus(error);
      res.status(status).json({ error: (error as Error).message });
    }
  }

  public async verify_invariants(req: Request, res: Response) {
    try {
      const report = await engine.verifyInvariants();
      const statusCode = report.status === "SUCCESS" ? 200 : 500;
      res.status(statusCode).json(report);
    } catch (error: unknown) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
