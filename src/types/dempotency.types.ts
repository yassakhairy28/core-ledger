import type { Document } from "mongoose";

export interface IdempotencyDocument extends Document {
  idempotencyKey: string;
  response: any;
  createdAt: Date;
}
