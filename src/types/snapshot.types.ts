import type { Document } from "mongoose";

export interface ISnapshot extends Document {
  accountId: string;
  version: number;
  type: string;
  availableBalance: number;
  pendingBalance: number;
  holds: Record<
    string,
    { amount: number; status: "pending" | "captured" | "voided" }
  >;
}
