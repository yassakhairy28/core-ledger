import type { Document } from "mongoose";
import type { LedgerEventData } from "./ledger.types.js";

export interface EventDocument extends Document {
  idempotencyKey: string;
  aggregateId: string;
  version: number;
  timestamp: number;
  data: LedgerEventData;
}
