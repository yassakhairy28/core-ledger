import type { Document } from "mongoose";

export interface IdempotencyDocument extends Document {
  idempotencyKey: string;
  status: "processing" | "completed" | "failed";
  response: unknown;
  createdAt: Date;
}
