import mongoose from "mongoose";

// Single-document store (key = "rafttaar") for everything about the connection
// that must survive restarts but is NOT in the .env file: sync mode, the
// poller's resume cursor + lease, and the webhook we registered (including its
// signing secret, which Rafttaar only ever shows once).
// The API key itself and the base URL live in .env only.
const schema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "rafttaar" },

    // Which API environment ("test" | "live") the cursor / webhook below belong to. Switching the key
    // between environments resets them (see poller.js ensureEnvironment) — a sandbox cursor must
    // never be used to read live events, and a sandbox webhook is not a live webhook.
    environment: String,

    syncMode: { type: String, enum: ["off", "polling", "webhook"], default: "polling" },
    pollIntervalSec: { type: Number, default: 10, min: 2 },

    // `after` cursor for GET /events — always the server-provided nextCursor.
    cursor: { type: Number, default: 0 },
    bootstrappedAt: Date, // first full reconcile done; event history before this is skipped
    lastPollAt: Date,
    lastPollSuccessAt: Date,
    lastPollError: { type: String, default: null },
    leaseUntil: Date, // so two ERP instances (local + deployed) do not poll at once
    leaseOwner: String,
    lastWebhookAt: Date,
    lastReconcileAt: Date,

    webhook: {
      id: String,
      url: String,
      secret: String,
      previousSecret: String,
      previousSecretExpiresAt: Date,
      eventTypes: { type: [String], default: [] },
      status: String,
      registeredAt: Date
    },

    // ERP-side defaults used when building invoices / dispatching.
    invoice: {
      sellerGstin: { type: String, default: "" },
      sellerState: { type: String, default: "" },
      defaultHsn: { type: String, default: "9999" },
      defaultGstRatePercent: { type: Number, default: 18 }
    },
    dispatchDefaults: {
      weightKg: { type: Number, default: 1 },
      lengthCm: { type: Number, default: 20 },
      widthCm: { type: Number, default: 15 },
      heightCm: { type: Number, default: 10 },
      boxCount: { type: Number, default: 1 }
    }
  },
  { timestamps: true, versionKey: false }
);

export const RafttaarSetting = mongoose.model("RafttaarSetting", schema);
