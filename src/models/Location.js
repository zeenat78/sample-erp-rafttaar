import mongoose from "mongoose";

// The ERP's own warehouse master. `externalId` is the ERP's warehouse code and
// is what Rafttaar keys on (PUT /locations/{externalId}) — upserting the same
// code never creates a duplicate on their side.
const schema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: {
      line1: { type: String, required: true, trim: true },
      line2: { type: String, trim: true, default: "" },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
      country: { type: String, trim: true, default: "India" }
    },
    contact: {
      name: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, default: "" } // the carrier needs a valid email to register the pickup
    },
    gstin: { type: String, trim: true, default: "" },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    rafttaar: {
      id: String, // Rafttaar's own location id (used by dispatch/inventory/deactivate)
      carrierStatus: String, // pending | ready | failed
      carrierError: String,
      isDefault: Boolean,
      isActive: Boolean,
      syncedAt: Date,
      syncError: String
    }
  },
  { timestamps: true, versionKey: false }
);

export const Location = mongoose.model("Location", schema);
