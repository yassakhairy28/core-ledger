import { model, Schema } from "mongoose";
import type { ISnapshot } from "../../types/snapshot.types.js";

export const SnapshotSchema = new Schema<ISnapshot>(
  {
    accountId: {
      type: String,
      required: true,
      unique: true,
    },
    version: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      required: true,
    },
    availableBalance: {
      type: Number,
      required: true,
    },
    pendingBalance: {
      type: Number,
      required: true,
    },
    holds: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

export const SnapshotModel = model("Snapshot", SnapshotSchema);
