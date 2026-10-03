import mongoose from "mongoose";

// Local copy of every event we received (poll or webhook). The unique `eventId`
// is the de-duplication guarantee: webhooks are at-least-once and the poller
// can overlap them, so each event must be applied at most once.
const schema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    seq: { type: Number, index: true },
    type: { type: String, required: true, index: true },
    schemaVersion: Number,
    occurredAt: Date,
    data: mongoose.Schema.Types.Mixed,
    source: { type: String, enum: ["poll", "webhook"], required: true },
    isTest: { type: Boolean, default: false },
    status: { type: String, enum: ["received", "processed", "failed", "ignored"], default: "received", index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
    processedAt: Date
  },
  { timestamps: true, versionKey: false }
);

export const RafttaarEvent = mongoose.model("RafttaarEvent", schema);
