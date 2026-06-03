export type AccountType = "customer" | "system" | "liability";

export interface AccountState {
  accountId: string;
  type: AccountType;
  availableBalance: number;
  pendingBalance: number;
}

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

export interface EventDocument {
  _id?: string;
  commandId: string;
  idempotencyKey: string;
  aggregateId: string;
  version: number;
  timestamp: number;
  data: LedgerEventData;
}
