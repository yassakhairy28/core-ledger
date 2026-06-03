import { model, Schema } from "mongoose";
import type { EventDocument } from "../../types/ledger.types.js";

const eventSchema = new Schema<EventDocument>({
  idempotencyKey: {
    type: String,
    required: true,
    unique: true,
  },
  aggregateId: {
    type: String,
    required: true,
    index: true,
  },
  version: {
    type: Number,
    required: true,
  },
  timestamp: {
    type: Number,
    required: true,
  },
  data: {
    type: Schema.Types.Mixed,
    required: true,
  },
}, { timestamps: true });

eventSchema.index({ aggregateId: 1, version: 1 }, { unique: true });

export const EventModel = model("Event", eventSchema);
