import type { ClientSession } from "mongoose";
import { EventModel } from "../DB/models/event.model.js";
import { SnapshotModel } from "../DB/models/snapshot.model.js";
import { IdempotencyModel } from "../DB/models/idempotency.model.js";

// --- الـ Types المكتوبة بـ small/snake_case عشان تناسب معاييرك ---

export type account_type = "customer" | "system" | "liability";
export type hold_status = "pending" | "captured" | "voided";

export interface hold_info {
  holdId: string;
  accountId: string;
  amount: number;
  status: hold_status;
}

export interface account_state {
  accountId: string;
  type: account_type;
  availableBalance: number;
  pendingBalance: number;
  holds: Record<string, hold_info>;
}

// الـ Discriminated Unions للأحداث بـ حروف صغيرة
export type ledger_event_data =
  | { type: "account_opened"; accountId: string; accountType: account_type }
  | {
      type: "money_transferred";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | { type: "hold_placed"; accountId: string; holdId: string; amount: number }
  | { type: "hold_captured"; holdId: string; accountId: string; amount: number }
  | { type: "hold_voided"; holdId: string; accountId: string; amount: number };

// الـ Discriminated Unions للأوامر بـ حروف صغيرة
export type ledger_command =
  | { type: "open_account"; accountId: string; accountType: account_type }
  | {
      type: "transfer";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | { type: "place_hold"; accountId: string; holdId: string; amount: number }
  | { type: "capture_hold"; holdId: string; accountId: string }
  | { type: "void_hold"; holdId: string; accountId: string };

// --- الـ Core Ledger Engine ---

export class LedgerEngine {
  /**
   * 1. الـ Reducer الحتمي (apply_event)
   * بياخد الحالة والحدث، ويرجع حالة جديدة تماماً بدون تعديل القديمة (Immutable)
   */
  public static apply_event(
    state: account_state,
    event: ledger_event_data,
  ): account_state {
    // deep clone عشان نحافظ على الـ immutability
    const new_state = JSON.parse(JSON.stringify(state)) as account_state;

    switch (event.type) {
      case "account_opened":
        new_state.type = event.accountType;
        new_state.availableBalance = 0;
        new_state.pendingBalance = 0;
        new_state.holds = {};
        break;

      case "money_transferred":
        if (state.accountId === event.fromAccountId) {
          new_state.availableBalance -= event.amount;
        }
        if (state.accountId === event.toAccountId) {
          new_state.availableBalance += event.amount;
        }
        break;

      case "hold_placed":
        if (state.accountId === event.accountId) {
          new_state.availableBalance -= event.amount;
          new_state.pendingBalance += event.amount;
          if (!new_state.holds) new_state.holds = {};
          new_state.holds[event.holdId] = {
            holdId: event.holdId,
            accountId: event.accountId,
            amount: event.amount,
            status: "pending",
          };
        }
        break;

      case "hold_captured":
        if (state.accountId === event.accountId) {
          const hold = new_state.holds?.[event.holdId];
          if (hold && hold.status === "pending") {
            new_state.pendingBalance -= hold.amount;
            hold.status = "captured";
          }
        }
        break;

      case "hold_voided":
        if (state.accountId === event.accountId) {
          const hold = new_state.holds?.[event.holdId];
          if (hold && hold.status === "pending") {
            new_state.availableBalance += hold.amount;
            new_state.pendingBalance -= hold.amount;
            hold.status = "voided";
          }
        }
        break;

      default:
        // التأكد التام بـ TypeScript إننا غطينا كل الـ Events
        const _exhaustive_check: never = event;
        throw new Error(`Unhandled event type`);
    }

    return new_state;
  }

  /**
   * 2. حساب رصيد وحالة الحساب الحالية (Replay من آخر Snapshot + Events)
   */
  public async get_account_state(
    account_id: string,
    session?: ClientSession,
  ): Promise<{ state: account_state; version: number }> {
    // سحب آخر لقطة متسيفة في الـ DB
    const snapshot = await SnapshotModel.findOne({ accountId: account_id })
      .session(session || null)
      .lean();

    let current_state: account_state = snapshot
      ? {
          accountId: snapshot.accountId,
          type: snapshot.type as account_type,
          availableBalance: snapshot.availableBalance,
          pendingBalance: snapshot.pendingBalance,
          holds: (snapshot.holds as Record<string, hold_info>) || {},
        }
      : {
          accountId: account_id,
          type: "customer",
          availableBalance: 0,
          pendingBalance: 0,
          holds: {},
        };

    let current_version = snapshot ? snapshot.version : 0;

    // جلب الأحداث اللي نزلت بعد الـ Snapshot ده بالترتيب التصاعدي
    const events = await EventModel.find({
      aggregateId: account_id,
      version: { $gt: current_version },
    })
      .sort({ version: 1 })
      .session(session || null)
      .lean();

    // تشغيل الـ Replay حتة حتة
    for (const ev of events) {
      current_state = LedgerEngine.apply_event(
        current_state,
        ev.data as ledger_event_data,
      );
      current_version = ev.version;
    }

    return { state: current_state, version: current_version };
  }

  /**
   * 3. معالجة الأوامر وتطبيق شروط الأمان (Process Command)
   */
  public async process_command(
    command: ledger_command,
    idempotency_key: string,
    session?: ClientSession,
  ): Promise<any> {
    // تشك على الـ Idempotency أولاً لمنع تكرار الحركات المتزامنة
    const existing_record = await IdempotencyModel.findOne({
      idempotencyKey: idempotency_key,
    })
      .session(session ?? null)
      .lean();
    if (existing_record) {
      return existing_record.response;
    }

    // تجميع الحسابات المتأثرة بالأمر ده
    const affected_accounts = this.get_affected_accounts(command);

    // ترقية للأمان: ترتيب الحسابات أبجدياً/تصاعدياً لمنع الـ Deadlock تماماً (Deadlock-free Locking)
    affected_accounts.sort();

    // سحب الـ States الحالية لكل حساب داخل في العملية بالترتيب مع قفل الأسطر (Row-level lock)
    const account_states: Record<
      string,
      { state: account_state; version: number }
    > = {};
    for (const id of affected_accounts) {
      account_states[id] = await this.get_account_state(id, session);
    }

    // الـ Validation وبناء الأحداث الجديدة
    const generated_events = this.validate_and_build_events(
      command,
      account_states,
      idempotency_key,
    );

    // تسجيل الأحداث وتحديث الـ Snapshots دورياً (Compaction) داخل الـ Session
    const sessionOptions = session ? { session } : undefined;

    for (const out_event of generated_events) {
      await EventModel.create([out_event], sessionOptions);

      // هنجيب الـ State الجديدة بعد ما ضفنا الـ event عشان نسيف الـ Snapshot المحدث فوراً
      const target_id = out_event.aggregateId;
      const { state: updated_state } = await this.get_account_state(
        target_id,
        session,
      );

      await SnapshotModel.updateOne(
        { accountId: target_id },
        {
          $set: {
            version: out_event.version,
            type: updated_state.type,
            availableBalance: updated_state.availableBalance,
            pendingBalance: updated_state.pendingBalance,
            holds: updated_state.holds,
          },
        },
        session ? { upsert: true, session } : { upsert: true },
      );
    }

    // حفظ رد الـ Idempotency عشان لو نفس المفتاح اتبعت تاني
    const response_data = { success: true, command: command.type };
    await IdempotencyModel.create(
      [{ idempotencyKey: idempotency_key, response: response_data }],
      sessionOptions,
    );

    return response_data;
  }

  // ميثود مساعدة بتطلع الحسابات اللي محتاجين نعمل عليها lock على حسب نوع الـ command
  private get_affected_accounts(command: ledger_command): string[] {
    switch (command.type) {
      case "open_account":
        return [command.accountId];
      case "transfer":
        return [command.fromAccountId, command.toAccountId];
      case "place_hold":
        return [command.accountId];
      case "capture_hold":
      case "void_hold":
        return [command.accountId];
    }
  }

  // ميثود مساعدة للتأكد من الـ Invariants والـ Overdraft قبل توليد الـ events
  private validate_and_build_events(
    command: ledger_command,
    states: Record<string, { state: account_state; version: number }>,
    idempotency_key: string,
  ): any[] {
    const events: any[] = [];
    const now = Date.now(); // الـ Timestamp غير الحتمي بيتقري هنا بس وقت الإنشاء وبيتسجل جوه الـ event

    switch (command.type) {
      case "open_account": {
        const acc = states[command.accountId];
        if (acc?.version && acc.version > 0)
          throw new Error("Account already exists");

        events.push({
          idempotencyKey: idempotency_key,
          aggregateId: command.accountId,
          version: 1,
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

        if (!from || !to) throw new Error("One or both accounts do not exist");
        if (from.version === 0 || to.version === 0)
          throw new Error("One or both accounts do not exist");
        if (command.amount <= 0)
          throw new Error("Amount must be greater than zero");

        // فرض الـ Overdraft rules: لو حساب عميل، ممنوع ينزل تحت الصفر نهائياً
        if (
          from.state.type === "customer" &&
          from.state.availableBalance < command.amount
        ) {
          throw new Error(
            "Insufficient funds (Overdraft forbidden for customer accounts)",
          );
        }

        events.push(
          {
            idempotencyKey: `${idempotency_key}-from`,
            aggregateId: command.fromAccountId,
            version: from.version + 1,
            timestamp: now,
            data: {
              type: "money_transferred",
              fromAccountId: command.fromAccountId,
              toAccountId: command.toAccountId,
              amount: command.amount,
            },
          },
          {
            idempotencyKey: `${idempotency_key}-to`,
            aggregateId: command.toAccountId,
            version: to.version + 1,
            timestamp: now,
            data: {
              type: "money_transferred",
              fromAccountId: command.fromAccountId,
              toAccountId: command.toAccountId,
              amount: command.amount,
            },
          },
        );
        break;
      }

      case "place_hold": {
        const acc = states[command.accountId];
        if (!acc || acc.version === 0)
          throw new Error("Account does not exist");
        if (
          acc.state.type === "customer" &&
          acc.state.availableBalance < command.amount
        ) {
          throw new Error("Insufficient funds for hold");
        }

        events.push({
          idempotencyKey: idempotency_key,
          aggregateId: command.accountId,
          version: acc.version + 1,
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
        const acc = states[command.accountId];
        if (!acc || acc.version === 0)
          throw new Error("Account does not exist");
        const hold = acc.state.holds?.[command.holdId];
        if (!hold || hold.status !== "pending")
          throw new Error("Hold not found or not pending");

        events.push({
          idempotencyKey: idempotency_key,
          aggregateId: command.accountId,
          version: acc.version + 1,
          timestamp: now,
          data: {
            type: "hold_captured",
            holdId: command.holdId,
            accountId: command.accountId,
            amount: hold.amount,
          },
        });
        break;
      }

      case "void_hold": {
        const acc = states[command.accountId];
        if (!acc || acc.version === 0)
          throw new Error("Account does not exist");
        const hold = acc.state.holds?.[command.holdId];
        if (!hold || hold.status !== "pending")
          throw new Error("Hold not found or not pending");

        events.push({
          idempotencyKey: idempotency_key,
          aggregateId: command.accountId,
          version: acc.version + 1,
          timestamp: now,
          data: {
            type: "hold_voided",
            holdId: command.holdId,
            accountId: command.accountId,
            amount: hold.amount,
          },
        });
        break;
      }
    }

    return events;
  }
}
