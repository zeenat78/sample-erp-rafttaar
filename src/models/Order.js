import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    productName: { type: String, required: true, trim: true },
    sku: { type: String, trim: true, default: "" },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    // Set only on orders received from Rafttaar: its own line/product ids and
    // the exact unit price in paise (invoices must reconcile to the paisa).
    lineId: { type: String, trim: true },
    productId: { type: String, trim: true },
    unitPricePaise: { type: Number, min: 0 }
  },
  { _id: true }
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, default: "" }
  },
  { _id: false }
);

const addressSchema = new mongoose.Schema(
  {
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true, default: "" },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },
    country: { type: String, trim: true, default: "India" }
  },
  { _id: false }
);

// Everything we know about the Rafttaar side of an order. Present only when
// order.source === "rafttaar". `fulfilmentState` is the precise Rafttaar state;
// order.status is the ERP's own coarser view derived from it.
const rafttaarSchema = new mongoose.Schema(
  {
    orderId: { type: String, trim: true }, // Rafttaar's order id (path param of every call)
    displayCode: { type: String, trim: true },
    platformStatus: { type: String, trim: true },
    fulfilmentState: { type: String, trim: true },
    erpReference: { type: String, trim: true, default: null },
    allowedActions: { type: [String], default: [] },
    delayReason: { type: String, default: null },
    newEta: { type: Date, default: null },
    totals: {
      currency: { type: String, default: "INR" },
      subtotalPaise: Number,
      gstPaise: Number,
      logisticsFeePaise: Number,
      totalPaise: Number
    },
    buyer: { name: String, phone: String },
    placedAt: Date,
    pushedAt: Date,
    acknowledgedAt: Date,
    dispatchedAt: Date,
    deliveredAt: Date,
    recalledAt: Date,
    shipment: {
      id: String,
      carrierShipmentId: String,
      awbNumber: String,
      courierName: String,
      bookingStatus: String,
      shipmentStatus: String,
      labelUrl: String,
      trackingHistory: { type: [{ _id: false, status: String, label: String, occurredAt: Date }], default: [] }
    },
    invoice: {
      id: String,
      invoiceNumber: String,
      status: String, // active | voided
      pdfUrl: String,
      source: String // "erp" (we issued it) | "rafttaar" (Rafttaar issued it)
    },
    isSandbox: { type: Boolean, default: false },
    lastEventSeq: { type: Number, default: null },
    lastSyncedAt: Date,
    lastSyncError: { type: String, default: null }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    customer: { type: customerSchema, required: true },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "At least one order item is required"
      }
    },
    totalAmount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "recalled"],
      default: "pending",
      index: true
    },
    shippingAddress: { type: addressSchema, required: true },
    source: { type: String, enum: ["manual", "rafttaar"], default: "manual", index: true },
    rafttaar: { type: rafttaarSchema, default: undefined }
  },
  { timestamps: true, versionKey: false }
);

// One ERP order per Rafttaar order — also what makes a replayed order.pushed harmless.
orderSchema.index(
  { "rafttaar.orderId": 1 },
  { unique: true, partialFilterExpression: { "rafttaar.orderId": { $type: "string" } } }
);

export const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "recalled"
];

export const Order = mongoose.model("Order", orderSchema);
