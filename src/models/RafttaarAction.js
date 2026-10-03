import mongoose from "mongoose";

// Outbox + audit log of everything the ERP asked Rafttaar to do. A row is
// written BEFORE the call, with its idempotency key, so if Rafttaar (or the
// network) fails we can retry later with the SAME key and never double-act
// (e.g. double-book a shipment). Also the support trail: what/when/result.
const schema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },
    rafttaarOrderId: { type: String, index: true },
    type: {
      type: String,
      required: true,
      enum: ["acknowledge", "status", "cancel", "invoice_create", "invoice_void", "dispatch"]
    },
    payload: mongoose.Schema.Types.Mixed,
    idempotencyKey: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "succeeded", "failed", "dead"], default: "pending", index: true },
    attempts: { type: Number, default: 0 },
    nextRetryAt: { type: Date, index: true },
    lastError: { code: String, message: String, httpStatus: Number, requestId: String },
    result: mongoose.Schema.Types.Mixed,
    completedAt: Date
  },
  { timestamps: true, versionKey: false }
);

export const RafttaarAction = mongoose.model("RafttaarAction", schema);
