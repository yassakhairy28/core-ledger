import mongoose from "mongoose";
import type { ClientSession } from "mongoose";
import { EventModel } from "../DB/models/event.model.js";
import { SnapshotModel } from "../DB/models/snapshot.model.js";
import { IdempotencyModel } from "../DB/models/idempotency.model.js";

export type AccountType = "customer" | "system" | "liability";
export type HoldStatus = "pending" | "captured" | "voided";

export interface HoldInfo {
  holdId: string;
  accountId: string;
  amount: number;
  status: HoldStatus;
}

export interface AccountState {
  accountId: string;
  type: AccountType;
  availableBalance: number;
  pendingBalance: number;
  holds: Record<string, HoldInfo>;
}

export interface AccountStateWithVersion {
  state: AccountState;
  version: number;
  lastEventId: string;
}

export type LedgerCommand =
  | { type: "open_account"; accountId: string; accountType: AccountType }
  | {
      type: "transfer";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | { type: "place_hold"; accountId: string; holdId: string; amount: number }
  | { type: "capture_hold"; holdId: string; accountId: string }
  | { type: "void_hold"; holdId: string; accountId: string };

export type LedgerEventData =
  | { type: "account_opened"; accountId: string; accountType: AccountType }
  | {
      type: "transfer_debit";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | {
      type: "transfer_credit";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | { type: "hold_placed"; accountId: string; holdId: string; amount: number }
  | {
      type: "hold_captured";
      accountId: string;
      holdId: string;
      amount: number;
    }
  | { type: "hold_voided"; accountId: string; holdId: string; amount: number };

export interface LedgerEventDocument {
  _id?: string;
  commandId: string;
  idempotencyKey: string;
  aggregateId: string;
  version: number;
  timestamp: number;
  data: LedgerEventData;
}

export interface ProcessResult {
  success: true;
  command: LedgerCommand["type"];
}

export interface AccountStatementLine {
  eventId: string;
  commandId: string;
  timestamp: number;
  type: LedgerEventData["type"];
  data: LedgerEventData;
  availableBalance: number;
  pendingBalance: number;
  totalBalance: number;
}

export interface InvariantReport {
  status: "SUCCESS" | "FAILED";
  errors: string[];
  globalBalance: number;
  inspectedAccounts: number;
}

const INTERNAL_SETTLEMENT_ACCOUNT_ID = "__system_settlement__";
const TRANSACTION_RETRY_LIMIT = 3;

export class LedgerEngine {
  private static readonly eventsProjection = {
    __v: 0,
  };

  public async processCommand(
    command: LedgerCommand,
    idempotencyKey: string,
  ): Promise<ProcessResult> {
    if (!idempotencyKey?.trim()) {
      throw new Error("Idempotency-Key is required");
    }

    return this.executeWithRetry(async (session) => {
      const existingIdempotency = await IdempotencyModel.findOne({
        idempotencyKey,
      })
        .session(session)
        .lean();

      if (existingIdempotency) {
        if (existingIdempotency.status === "completed") {
          return existingIdempotency.response as ProcessResult;
        }

        if (existingIdempotency.status === "processing") {
          throw new Error("Idempotency-Key is already being processed");
        }
      }

      await IdempotencyModel.create(
        [
          {
            idempotencyKey,
            status: "processing",
          },
        ],
        { session },
      );

      const affectedAccounts = this.getAffectedAccounts(command).sort();
      const accountStates: Record<string, AccountStateWithVersion> = {};
      for (const accountId of affectedAccounts) {
        accountStates[accountId] = await this.getAccountState(
          accountId,
          session,
        );
      }

      const events = this.buildEvents(command, accountStates, idempotencyKey);
      if (!this.verifyBalance(events)) {
        throw new Error("Generated events are not balanced");
      }

      await EventModel.insertMany(
        events.map((event) => ({
          commandId: event.commandId,
          idempotencyKey: event.idempotencyKey,
          aggregateId: event.aggregateId,
          version: event.version,
          timestamp: event.timestamp,
          data: event.data,
        })),
        { session },
      );

      const updatedAccountIds = Array.from(
        new Set(events.map((event) => event.aggregateId)),
      ).sort();

      for (const accountId of updatedAccountIds) {
        const updatedState = await this.getAccountState(accountId, session);
        await SnapshotModel.updateOne(
          { accountId },
          {
            $set: {
              version: updatedState.version,
              type: updatedState.state.type,
              availableBalance: updatedState.state.availableBalance,
              pendingBalance: updatedState.state.pendingBalance,
              holds: updatedState.state.holds,
              lastEventId: updatedState.lastEventId,
            },
          },
          { upsert: true, session },
        );
      }

      const response: ProcessResult = {
        success: true,
        command: command.type,
      };

      await IdempotencyModel.updateOne(
        { idempotencyKey },
        {
          $set: {
            status: "completed",
            response,
            updatedAt: new Date(),
          },
        },
        { session },
      );

      return response;
    });
  }

  public async getAccountState(
    accountId: string,
    session?: ClientSession,
  ): Promise<AccountStateWithVersion> {
    const snapshot = await SnapshotModel.findOne({ accountId })
      .session(session ?? null)
      .lean();

    const baseState: AccountStateWithVersion = snapshot
      ? {
          state: {
            accountId: snapshot.accountId,
            type: snapshot.type as AccountType,
            availableBalance: snapshot.availableBalance,
            pendingBalance: snapshot.pendingBalance,
            holds: snapshot.holds as Record<string, HoldInfo>,
          },
          version: snapshot.version,
          lastEventId: snapshot.lastEventId,
        }
      : {
          state: {
            accountId,
            type:
              accountId === INTERNAL_SETTLEMENT_ACCOUNT_ID
                ? "system"
                : "customer",
            availableBalance: 0,
            pendingBalance: 0,
            holds: {},
          },
          version: 0,
          lastEventId: "",
        };

    const events = await EventModel.find({
      aggregateId: accountId,
      version: { $gt: baseState.version },
    })
      .sort({ version: 1, commandId: 1 })
      .session(session ?? null)
      .lean();

    let currentState = baseState.state;
    let currentVersion = baseState.version;
    let lastEventId = baseState.lastEventId;

    for (const event of events) {
      currentState = LedgerEngine.apply_event(currentState, event.data);
      currentVersion = event.version;
      lastEventId = event._id?.toString() ?? lastEventId;
    }

    return {
      state: currentState,
      version: currentVersion,
      lastEventId,
    };
  }

  public async accountExists(accountId: string): Promise<boolean> {
    const count = await SnapshotModel.countDocuments({ accountId }).exec();
    return count > 0;
  }

  public async getAccountStatement(
    accountId: string,
  ): Promise<AccountStatementLine[]> {
    const snapshot = await SnapshotModel.findOne({ accountId }).lean();
    if (!snapshot) {
      throw new Error("Account not found");
    }

    const events = await EventModel.find({ aggregateId: accountId })
      .sort({ version: 1, commandId: 1 })
      .lean();

    let state: AccountState = {
      accountId,
      type: snapshot.type as AccountType,
      availableBalance: 0,
      pendingBalance: 0,
      holds: {},
    };

    const statement: AccountStatementLine[] = [];

    for (const event of events) {
      state = LedgerEngine.apply_event(state, event.data);
      statement.push({
        eventId: event._id?.toString() ?? "",
        commandId: event.commandId,
        timestamp: event.timestamp,
        type: event.data.type,
        data: event.data,
        availableBalance: state.availableBalance,
        pendingBalance: state.pendingBalance,
        totalBalance: state.availableBalance + state.pendingBalance,
      });
    }

    return statement;
  }

  public async verifyInvariants(): Promise<InvariantReport> {
    const errors: string[] = [];
    let globalBalance = 0;

    const snapshots = await SnapshotModel.find().lean();
    const allEvents = await EventModel.find().sort({ _id: 1 }).lean();

    const eventsByCommand = new Map<
      string,
      Array<(typeof allEvents)[number]>
    >();
    for (const event of allEvents) {
      const group = eventsByCommand.get(event.commandId) ?? [];
      group.push(event);
      eventsByCommand.set(event.commandId, group);
    }

    for (const [commandId, events] of eventsByCommand.entries()) {
      const delta = events.reduce(
        (acc, event) => acc + this.balanceDelta(event.data),
        0,
      );
      if (delta !== 0) {
        errors.push(`Command ${commandId} is not balanced: delta=${delta}`);
      }
    }

    for (const snapshot of snapshots) {
      globalBalance += snapshot.availableBalance + snapshot.pendingBalance;

      if (snapshot.type === "customer" && snapshot.availableBalance < 0) {
        errors.push(
          `Customer account ${snapshot.accountId} has negative available balance ${snapshot.availableBalance}`,
        );
      }

      const replayed = await this.replayAccountFromSnapshot(
        snapshot.accountId,
        snapshot.version,
      );

      if (
        replayed.state.availableBalance !== snapshot.availableBalance ||
        replayed.state.pendingBalance !== snapshot.pendingBalance ||
        JSON.stringify(replayed.state.holds) !== JSON.stringify(snapshot.holds)
      ) {
        errors.push(
          `Snapshot drift detected for account ${snapshot.accountId}`,
        );
      }

      const pendingHoldSum = Object.values(replayed.state.holds)
        .filter((hold) => hold.status === "pending")
        .reduce((sum, hold) => sum + hold.amount, 0);

      if (pendingHoldSum !== replayed.state.pendingBalance) {
        errors.push(
          `Pending hold mismatch for account ${snapshot.accountId}: expected=${pendingHoldSum} actual=${replayed.state.pendingBalance}`,
        );
      }
    }

    if (globalBalance !== 0) {
      errors.push(`Closed system global balance is not zero: ${globalBalance}`);
    }

    return {
      status: errors.length === 0 ? "SUCCESS" : "FAILED",
      errors,
      globalBalance,
      inspectedAccounts: snapshots.length,
    };
  }

  private async replayAccountFromSnapshot(
    accountId: string,
    snapshotVersion: number,
  ): Promise<AccountStateWithVersion> {
    const snapshot = await SnapshotModel.findOne({ accountId }).lean();
    const base: AccountStateWithVersion = snapshot
      ? {
          state: {
            accountId,
            type: snapshot.type as AccountType,
            availableBalance: snapshot.availableBalance,
            pendingBalance: snapshot.pendingBalance,
            holds: snapshot.holds as Record<string, HoldInfo>,
          },
          version: snapshot.version,
          lastEventId: snapshot.lastEventId,
        }
      : {
          state: {
            accountId,
            type:
              accountId === INTERNAL_SETTLEMENT_ACCOUNT_ID
                ? "system"
                : "customer",
            availableBalance: 0,
            pendingBalance: 0,
            holds: {},
          },
          version: snapshotVersion,
          lastEventId: "",
        };

    const events = await EventModel.find({
      aggregateId: accountId,
      version: { $gt: base.version },
    })
      .sort({ version: 1, commandId: 1 })
      .lean();

    let state = base.state;
    let version = base.version;
    let lastEventId = base.lastEventId;

    for (const event of events) {
      state = LedgerEngine.apply_event(state, event.data);
      version = event.version;
      lastEventId = event._id?.toString() ?? lastEventId;
    }

    return { state, version, lastEventId };
  }

  private verifyBalance(events: ReadonlyArray<LedgerEventDocument>): boolean {
    return (
      events.reduce((acc, event) => acc + this.balanceDelta(event.data), 0) ===
      0
    );
  }

  private balanceDelta(event: LedgerEventData): number {
    switch (event.type) {
      case "account_opened":
        return 0;
      case "transfer_debit":
        return -event.amount;
      case "transfer_credit":
        return event.amount;
      case "hold_placed":
        return 0;
      case "hold_captured":
        return 0;
      case "hold_voided":
        return 0;
      default:
        const _exhaustive_check: never = event;
        return 0;
    }
  }

  private getAffectedAccounts(command: LedgerCommand): string[] {
    switch (command.type) {
      case "open_account":
        return [command.accountId];
      case "transfer":
        return [command.fromAccountId, command.toAccountId];
      case "place_hold":
        return [command.accountId];
      case "capture_hold":
        return [command.accountId, INTERNAL_SETTLEMENT_ACCOUNT_ID];
      case "void_hold":
        return [command.accountId];
    }
  }

  private buildEvents(
    command: LedgerCommand,
    states: Record<string, AccountStateWithVersion>,
    idempotencyKey: string,
  ): LedgerEventDocument[] {
    const now = Date.now();
    const rows: LedgerEventDocument[] = [];

    switch (command.type) {
      case "open_account": {
        const account = states[command.accountId];
        if (!account || account.version !== 0) {
          throw new Error("Account already exists");
        }

        rows.push({
          commandId: idempotencyKey,
          idempotencyKey: `${idempotencyKey}-open`,
          aggregateId: command.accountId,
          version: account.version + 1,
          timestamp: now,
          data: {
            type: "account_opened",
            accountId: command.accountId,
            accountType: command.accountType,
          },
        });
        break;
      }
      case "transfer": {
        const from = states[command.fromAccountId];
        const to = states[command.toAccountId];
        if (!from || !to || from.version === 0 || to.version === 0) {
          throw new Error("One or both accounts do not exist");
        }
        if (!Number.isInteger(command.amount) || command.amount <= 0) {
          throw new Error("Amount must be a positive integer");
        }
        if (
          !from ||
          !to ||
          (from.state.type === "customer" &&
            from.state.availableBalance < command.amount)
        ) {
          throw new Error("Insufficient funds for transfer");
        }

        rows.push(
          {
            commandId: idempotencyKey,
            idempotencyKey: `${idempotencyKey}-from`,
            aggregateId: command.fromAccountId,
            version: from.version + 1,
            timestamp: now,
            data: {
              type: "transfer_debit",
              fromAccountId: command.fromAccountId,
              toAccountId: command.toAccountId,
              amount: command.amount,
            },
          },
          {
            commandId: idempotencyKey,
            idempotencyKey: `${idempotencyKey}-to`,
            aggregateId: command.toAccountId,
            version: to.version + 1,
            timestamp: now,
            data: {
              type: "transfer_credit",
              fromAccountId: command.fromAccountId,
              toAccountId: command.toAccountId,
              amount: command.amount,
            },
          },
        );
        break;
      }
      case "place_hold": {
        const account = states[command.accountId];
        if (!account || account.version === 0) {
          throw new Error("Account does not exist");
        }
        if (!Number.isInteger(command.amount) || command.amount <= 0) {
          throw new Error("Hold amount must be a positive integer");
        }
        if (
          !account ||
          (account.state.type === "customer" &&
            account.state.availableBalance < command.amount)
        ) {
          throw new Error("Insufficient funds for hold");
        }
        if (!account) {
          throw new Error("Account does not exist");
        }
        if (account.state.holds[command.holdId]) {
          throw new Error("Hold already exists");
        }

        rows.push({
          commandId: idempotencyKey,
          idempotencyKey: `${idempotencyKey}-hold`,
          aggregateId: command.accountId,
          version: account.version + 1,
          timestamp: now,
          data: {
            type: "hold_placed",
            accountId: command.accountId,
            holdId: command.holdId,
            amount: command.amount,
          },
        });
        break;
      }
      case "capture_hold": {
        const account = states[command.accountId];
        if (!account || account.version === 0) {
          throw new Error("Account does not exist");
        }
        const hold = account.state.holds[command.holdId];
        if (!hold || hold.status !== "pending") {
          throw new Error("Hold not found or not pending");
        }

        const systemAccount = states[INTERNAL_SETTLEMENT_ACCOUNT_ID];
        if (!systemAccount) {
          throw new Error("Internal settlement account state unavailable");
        }

        rows.push(
          {
            commandId: idempotencyKey,
            idempotencyKey: `${idempotencyKey}-capture`,
            aggregateId: command.accountId,
            version: account.version + 1,
            timestamp: now,
            data: {
              type: "hold_captured",
              accountId: command.accountId,
              holdId: command.holdId,
              amount: hold.amount,
            },
          },
          {
            commandId: idempotencyKey,
            idempotencyKey: `${idempotencyKey}-settlement`,
            aggregateId: INTERNAL_SETTLEMENT_ACCOUNT_ID,
            version: systemAccount.version + 1,
            timestamp: now,
            data: {
              type: "transfer_credit",
              fromAccountId: command.accountId,
              toAccountId: INTERNAL_SETTLEMENT_ACCOUNT_ID,
              amount: hold.amount,
            },
          },
        );
        break;
      }
      case "void_hold": {
        const account = states[command.accountId];
        if (!account || account.version === 0) {
          throw new Error("Account does not exist");
        }
        const hold = account.state.holds[command.holdId];
        if (!hold || hold.status !== "pending") {
          throw new Error("Hold not found or not pending");
        }

        rows.push({
          commandId: idempotencyKey,
          idempotencyKey: `${idempotencyKey}-void`,
          aggregateId: command.accountId,
          version: account.version + 1,
          timestamp: now,
          data: {
            type: "hold_voided",
            accountId: command.accountId,
            holdId: command.holdId,
            amount: hold.amount,
          },
        });
        break;
      }
      default:
        const _exhaustive_check: never = command;
        throw new Error("Unhandled command type");
    }

    return rows;
  }

  private async executeWithRetry(
    work: (session: ClientSession) => Promise<ProcessResult>,
    attempt = 0,
  ): Promise<ProcessResult> {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const result = await work(session);
      await session.commitTransaction();
      return result;
    } catch (error: unknown) {
      await session.abortTransaction().catch(() => undefined);
      if (attempt < TRANSACTION_RETRY_LIMIT && this.isTransientError(error)) {
        return this.executeWithRetry(work, attempt + 1);
      }
      throw error;
    } finally {
      session.endSession();
    }
  }

  private isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return /E11000|duplicate key|WriteConflict|Transaction.*aborted|TransientTransactionError|UnknownTransactionCommitResult/i.test(
      error.message,
    );
  }

  public static apply_event(
    state: AccountState,
    event: LedgerEventData,
  ): AccountState {
    const nextState = JSON.parse(JSON.stringify(state)) as AccountState;

    switch (event.type) {
      case "account_opened":
        nextState.type = event.accountType;
        nextState.availableBalance = 0;
        nextState.pendingBalance = 0;
        nextState.holds = {};
        break;
      case "transfer_debit":
        if (nextState.accountId === event.fromAccountId) {
          nextState.availableBalance -= event.amount;
        }
        break;
      case "transfer_credit":
        if (nextState.accountId === event.toAccountId) {
          nextState.availableBalance += event.amount;
        }
        break;
      case "hold_placed":
        if (nextState.accountId === event.accountId) {
          nextState.availableBalance -= event.amount;
          nextState.pendingBalance += event.amount;
          nextState.holds = nextState.holds || {};
          nextState.holds[event.holdId] = {
            holdId: event.holdId,
            accountId: event.accountId,
            amount: event.amount,
            status: "pending",
          };
        }
        break;
      case "hold_captured":
        if (nextState.accountId === event.accountId) {
          const hold = nextState.holds?.[event.holdId];
          if (hold && hold.status === "pending") {
            nextState.pendingBalance -= event.amount;
            hold.status = "captured";
          }
        }
        break;
      case "hold_voided":
        if (nextState.accountId === event.accountId) {
          const hold = nextState.holds?.[event.holdId];
          if (hold && hold.status === "pending") {
            nextState.availableBalance += event.amount;
            nextState.pendingBalance -= event.amount;
            hold.status = "voided";
          }
        }
        break;
      default:
        const _exhaustive_check: never = event;
        throw new Error("Unhandled event type");
    }

    return nextState;
  }
}
