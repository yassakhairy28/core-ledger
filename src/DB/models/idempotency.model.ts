import { model, Schema } from "mongoose";

export const IdempotencySchema = new Schema({
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
  },
  status: {
    type: String,
    required: true,
    enum: ["processing", "completed", "failed"],
    default: "processing",
  },
  response: {
    type: Schema.Types.Mixed,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: "1d",
  }, // Expire entries after 24h
});

export const IdempotencyModel = model("Idempotency", IdempotencySchema);
