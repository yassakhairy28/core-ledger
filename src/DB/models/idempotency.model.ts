import { model, Schema } from "mongoose";

export const IdempotencySchema = new Schema({
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
  },
  response: {
    type: Schema.Types.Mixed,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: "1d",
  }, // Expire entries after 24h
});

export const IdempotencyModel = model('Idempotency', IdempotencySchema);