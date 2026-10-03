import { Order } from "../../models/Order.js";
import { Invoice } from "../../models/Invoice.js";
import { InventoryItem } from "../../models/InventoryItem.js";
import { RafttaarEvent } from "../../models/RafttaarEvent.js";
import { getClient } from "./config.js";
import { RafttaarApiError } from "./errors.js";
import { erpStatusFor } from "./mapper.js";
import { syncOrderById } from "./orderSync.js";

export const MAX_EVENT_ATTEMPTS = 5;

/**
 * Apply ONE Rafttaar event to the ERP, exactly once.
 *
 * Design rules (what makes this safe for both webhooks and polling):
 *  - the event is stored first, keyed by its unique id -> a duplicate delivery
 *    (webhooks are at-least-once, the poller may overlap) is a no-op;
 *  - handlers re-read current state from Rafttaar instead of applying the
 *    event as a diff -> out-of-order and replayed events converge to the truth;
 *  - an order the API says does not exist (404) is "ignored", not "failed":
 *    test events and events for orders we no longer hold must not block the
 *    cursor.
 *
 * Returns { outcome: "processed" | "duplicate" | "ignored" | "failed", final, event }.
 * `final` = this event will never be retried (the poller may advance past it).
 */
export async function ingestEvent(raw, source, { client } = {}) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.type) {
    return { outcome: "ignored", final: true, event: null, reason: "malformed event" };
  }

  let doc = await RafttaarEvent.findOne({ eventId: raw.id });
  if (!doc) {
    try {
      doc = await RafttaarEvent.create({
        eventId: raw.id,
        seq: raw.seq,
        type: raw.type,
        schemaVersion: raw.schemaVersion,
        occurredAt: raw.occurredAt ? new Date(raw.occurredAt) : undefined,
        data: raw.data,
        source,
        isTest: Boolean(raw.isTest || raw.test)
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      doc = await RafttaarEvent.findOne({ eventId: raw.id });
    }
  }

  if (doc.status === "processed" || doc.status === "ignored") return { outcome: "duplicate", final: true, event: doc };
  if (doc.status === "failed" && doc.attempts >= MAX_EVENT_ATTEMPTS) return { outcome: "failed", final: true, event: doc };

  doc.attempts += 1;
  try {
    const handler = HANDLERS[raw.type];
    if (!handler) {
      doc.status = "ignored";
      doc.error = `No handler for event type ${raw.type}`;
    } else {
      const note = await handler(raw, client || getClient());
      doc.status = "processed";
      doc.error = note || null;
    }
    doc.processedAt = new Date();
    await doc.save();
    return { outcome: doc.status, final: true, event: doc };
  } catch (error) {
    if (error instanceof RafttaarApiError && error.code === "NOT_FOUND") {
      doc.status = "ignored";
      doc.error = `Not found on Rafttaar: ${error.message}`;
      doc.processedAt = new Date();
      await doc.save();
      return { outcome: "ignored", final: true, event: doc };
    }
    doc.status = "failed";
    doc.error = String(error?.message || error).slice(0, 500);
    await doc.save();
    return { outcome: "failed", final: doc.attempts >= MAX_EVENT_ATTEMPTS, event: doc, error };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function syncOrderEvent(event, client) {
  const orderId = event.data?.orderId;
  // The "send test event" button emits a synthetic event with no real order: acknowledge it, apply nothing.
  if (!orderId) return "no orderId (synthetic test event) - nothing to apply";
  try {
    await syncOrderById(orderId, { eventSeq: event.seq, client });
  } catch (error) {
    // After a cancel/recall Rafttaar may stop serving the order; trust the event for the state change.
    if (error instanceof RafttaarApiError && error.code === "NOT_FOUND" && ["order.cancelled", "order.recalled"].includes(event.type)) {
      const state = event.type === "order.cancelled" ? "cancelled" : "recalled";
      const res = await Order.updateOne(
        { "rafttaar.orderId": orderId },
        { $set: { "rafttaar.fulfilmentState": state, status: erpStatusFor(state), "rafttaar.lastEventSeq": event.seq } }
      );
      if (res.matchedCount) return `order not served by Rafttaar; applied ${state} from event`;
    }
    throw error;
  }
}

async function invoiceEvent(event, client) {
  const { orderId, invoiceId, invoiceNumber } = event.data || {};
  if (!orderId) return "no orderId (synthetic test event) - nothing to apply";
  const voided = event.type === "invoice.voided";

  const ours = invoiceNumber ? await Invoice.findOne({ invoiceNumber }).lean() : null;
  const set = {
    "rafttaar.invoice.id": invoiceId,
    "rafttaar.invoice.status": voided ? "voided" : "active",
    "rafttaar.invoice.source": ours ? "erp" : "rafttaar"
  };
  if (invoiceNumber) set["rafttaar.invoice.invoiceNumber"] = invoiceNumber;

  if (!voided) {
    try {
      const { pdfUrl } = await client.getInvoicePdf(orderId);
      if (pdfUrl) set["rafttaar.invoice.pdfUrl"] = pdfUrl;
    } catch {
      /* the PDF URL is a nicety; the invoice itself is already recorded */
    }
  } else if (ours) {
    await Invoice.updateOne({ _id: ours._id }, { $set: { status: "voided", voidReason: event.data?.reason || ours.voidReason } });
  }
  const res = await Order.updateOne({ "rafttaar.orderId": orderId }, { $set: set });
  return res.matchedCount ? null : "order not held locally";
}

async function shipmentEvent(event, client) {
  const { orderId, shipmentId, status, awbNumber, courierName } = event.data || {};
  if (!orderId) return "no orderId (synthetic test event) - nothing to apply";

  // Authoritative order state first (dispatched/delivered/...).
  let missing = false;
  try {
    await syncOrderById(orderId, { eventSeq: event.seq, client });
  } catch (error) {
    if (error instanceof RafttaarApiError && error.code === "NOT_FOUND") missing = true;
    else throw error;
  }

  const set = {};
  if (shipmentId) set["rafttaar.shipment.id"] = shipmentId;
  if (awbNumber) set["rafttaar.shipment.awbNumber"] = awbNumber;
  if (courierName) set["rafttaar.shipment.courierName"] = courierName;
  const shipmentStatus = event.type === "shipment.booked" ? "booked" : status;
  if (shipmentStatus) set["rafttaar.shipment.shipmentStatus"] = shipmentStatus;
  if (event.type === "shipment.failed") set["rafttaar.lastSyncError"] = "Shipment failed — check the carrier and re-dispatch if needed";

  // Full tracking history, when the API will give it to us.
  if (shipmentId) {
    try {
      const shipment = await client.getShipment(shipmentId);
      set["rafttaar.shipment.awbNumber"] = shipment.awbNumber ?? set["rafttaar.shipment.awbNumber"] ?? null;
      set["rafttaar.shipment.courierName"] = shipment.courierName ?? set["rafttaar.shipment.courierName"] ?? null;
      set["rafttaar.shipment.bookingStatus"] = shipment.bookingStatus;
      set["rafttaar.shipment.shipmentStatus"] = shipment.shipmentStatus || set["rafttaar.shipment.shipmentStatus"];
      set["rafttaar.shipment.trackingHistory"] = (shipment.trackingHistory || []).map((t) => ({
        status: t.status,
        label: t.label,
        occurredAt: t.occurredAt ? new Date(t.occurredAt) : undefined
      }));
    } catch {
      /* sandbox shipment ids are not always readable; the event data is enough */
    }
  }
  if (event.type === "shipment.delivered") {
    set["rafttaar.fulfilmentState"] = "delivered";
    set.status = "delivered";
    set["rafttaar.deliveredAt"] = event.occurredAt ? new Date(event.occurredAt) : new Date();
  }

  if (Object.keys(set).length) await Order.updateOne({ "rafttaar.orderId": orderId }, { $set: set });
  return missing ? "order not served by Rafttaar; shipment details applied from event" : null;
}

async function inventoryRejectedEvent(event) {
  const { sku, reason } = event.data || {};
  if (!sku) return "no sku (synthetic test event) - nothing to apply";
  await InventoryItem.updateMany(
    { sku },
    { $set: { "sync.status": reason === "warehouse_managed" ? "warehouse_managed" : "invalid", "sync.syncedAt": new Date(), "sync.message": `Rejected by Rafttaar: ${reason}` } }
  );
  return null;
}

const HANDLERS = {
  "order.pushed": syncOrderEvent,
  "order.updated": syncOrderEvent,
  "order.cancelled": syncOrderEvent,
  "order.recalled": syncOrderEvent,
  "invoice.generated": invoiceEvent,
  "invoice.voided": invoiceEvent,
  "shipment.booked": shipmentEvent,
  "shipment.status_changed": shipmentEvent,
  "shipment.delivered": shipmentEvent,
  "shipment.failed": shipmentEvent,
  "inventory.rejected": inventoryRejectedEvent
};

export const HANDLED_EVENT_TYPES = Object.keys(HANDLERS);
