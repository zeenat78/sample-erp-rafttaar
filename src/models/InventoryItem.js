import mongoose from "mongoose";

// Stock per (SKU, warehouse). Rafttaar sums stock across locations, so — as the
// spec says — we send one item per location, never a combined total.
const schema = new mongoose.Schema(
  {
    sku: { type: String, required: true, trim: true },
    productName: { type: String, trim: true, default: "" },
    locationExternalId: { type: String, trim: true, default: "" }, // "" = seller's default location
    stockQty: { type: Number, required: true, min: 0 },
    minStockQty: { type: Number, min: 0, default: null },
    sync: {
      status: { type: String, enum: ["never", "updated", "not_found", "warehouse_managed", "invalid", "error"], default: "never" },
      syncedAt: Date,
      message: String
    }
  },
  { timestamps: true, versionKey: false }
);
schema.index({ sku: 1, locationExternalId: 1 }, { unique: true });

export const InventoryItem = mongoose.model("InventoryItem", schema);
