export type AccountType = "customer" | "system" | "liability";

export interface AccountState {
  accountId: string;
  type: AccountType;
  availableBalance: number;
  pendingBalance: number;
}

// 3. شكل الـ Hold (الحجز المؤقت للفلوس)
export interface HoldInfo {
  holdId: string;
  accountId: string;
  amount: number;
  status: "pending" | "captured" | "voided";
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
  | { type: "capture_hold"; holdId: string }
  | { type: "void_hold"; holdId: string };

export type LedgerEventData =
  | { type: "account_opened"; accountId: string; accountType: AccountType }
  | {
      type: "money_transferred";
      fromAccountId: string;
      toAccountId: string;
      amount: number;
    }
  | { type: "hold_placed"; accountId: string; holdId: string; amount: number }
  | { type: "hold_captured"; holdId: string; accountId: string; amount: number }
  | { type: "hold_voided"; holdId: string; accountId: string; amount: number };

export interface EventDocument {
  _id?: string;
  idempotencyKey: string;
  aggregateId: string;
  version: number;
  timestamp: number;
  data: LedgerEventData;
}
