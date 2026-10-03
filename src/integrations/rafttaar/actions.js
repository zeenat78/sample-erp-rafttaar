import crypto from "node:crypto";
import { Order } from "../../models/Order.js";
import { Invoice } from "../../models/Invoice.js";
import { Location } from "../../models/Location.js";
import { RafttaarAction } from "../../models/RafttaarAction.js";
import { getClient, getSettings } from "./config.js";
import { ORDER_STATUS_ACTIONS } from "./constants.js";
import { RafttaarApiError } from "./errors.js";
import { applyLock, syncOrderById } from "./orderSync.js";

/**
 * Outbound actions ERP -> Rafttaar (acknowledge, confirm/packaging/delayed,
 * cancel, invoice, void invoice, dispatch).
 *
 * How a real connector avoids "we clicked dispatch, the network blipped, did it
 * book or not?": every action is first written to Mongo (RafttaarAction) WITH
 * its Idempotency-Key, then sent. If Rafttaar / the network fails, the row stays
 * `pending` and the outbox worker retries with the SAME key — Rafttaar returns
 * the stored result instead of repeating the action, so a shipment is never
 * double-booked. Business refusals (4xx: ORDER_NOT_ACKNOWLEDGED, INVALID_TRANSITION,
 * EWAY_BILL_REQUIRED...) are final: surfaced to the caller with Rafttaar's code.
 */

export class ActionError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ActionError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
// After these, our local copy is probably stale: re-read the truth from Rafttaar.
const STALE_STATE_CODES = new Set(["INVALID_TRANSITION", "ORDER_RECALLED", "ORDER_CANCELLED", "SHIPMENT_ALREADY_BOOKED", "INVOICE_ALREADY_EXISTS"]);

const isoDate = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function validatePayload(type, payload = {}) {
  switch (type) {
    case "acknowledge":
      return { erpReference: payload.erpReference ? String(payload.erpReference).trim() : undefined };
    case "status": {
      if (!ORDER_STATUS_ACTIONS.includes(payload.status)) {
        throw new ActionError(400, "VALIDATION_ERROR", `status must be one of: ${ORDER_STATUS_ACTIONS.join(", ")}`);
      }
      const out = { status: payload.status };
      if (payload.status === "delayed") {
        if (!payload.reason || !String(payload.reason).trim()) {
          throw new ActionError(400, "VALIDATION_ERROR", "A customer-facing reason is required when marking an order delayed");
        }
        out.reason = String(payload.reason).trim();
        if (payload.newEta) {
          const eta = isoDate(payload.newEta);
          if (!eta) throw new ActionError(400, "VALIDATION_ERROR", "newEta is not a valid date");
          out.newEta = eta;
        }
      } else if (payload.newEta) {
        throw new ActionError(400, "VALIDATION_ERROR", "newEta is only allowed together with status=delayed");
      }
      return out;
    }
    case "cancel":
      return { reason: payload.reason ? String(payload.reason).trim() : undefined };
    case "dispatch":
      return {
        locationExternalId: payload.locationExternalId || undefined,
        locationId: payload.locationId || undefined,
        packages: payload.packages,
        boxCount: payload.boxCount,
        ewayBillNo: payload.ewayBillNo ? String(payload.ewayBillNo).trim() : undefined
      };
    case "invoice_create":
      if (!payload.invoiceId) throw new ActionError(400, "VALIDATION_ERROR", "invoiceId (local draft) is required");
      return { invoiceId: String(payload.invoiceId) };
    case "invoice_void":
      return { reason: payload.reason ? String(payload.reason).trim() : undefined };
    default:
      throw new ActionError(400, "VALIDATION_ERROR", `Unknown action ${type}`);
  }
}

/** Throws unless this is a Rafttaar order with no action still in flight (one at a time per order). */
export async function assertIdle(order) {
  if (order.source !== "rafttaar" || !order.rafttaar?.orderId) {
    throw new ActionError(409, "NOT_A_RAFTTAAR_ORDER", "This order did not come from Rafttaar");
  }
  const busy = await RafttaarAction.findOne({ order: order._id, status: "pending" }).lean();
  if (busy) {
    throw new ActionError(409, "ACTION_IN_PROGRESS", `Another action (${busy.type}) for this order is still being delivered to Rafttaar. Wait for it to finish.`);
  }
}

/** Create the outbox row and try it now. Returns { status: "succeeded"|"queued", action, result? }. */
export async function performAction(order, type, rawPayload, { client } = {}) {
  await assertIdle(order);
  const payload = validatePayload(type, rawPayload);

  const action = await RafttaarAction.create({
    order: order._id,
    rafttaarOrderId: order.rafttaar.orderId,
    type,
    payload,
    idempotencyKey: crypto.randomUUID(),
    // Safety net: if this process dies mid-call, the outbox worker picks the row up after a minute.
    nextRetryAt: new Date(Date.now() + CLAIM_MS)
  });
  return executeAction(action, { client });
}

async function callRafttaar(client, action) {
  const id = action.rafttaarOrderId;
  const opts = { idempotencyKey: action.idempotencyKey };
  const p = action.payload || {};

  switch (action.type) {
    case "acknowledge":
      return client.acknowledgeOrder(id, { erpReference: p.erpReference }, opts);
    case "status":
      return client.updateOrderStatus(id, { status: p.status, reason: p.reason, newEta: p.newEta }, opts);
    case "cancel":
      return client.cancelOrder(id, { reason: p.reason }, opts);
    case "dispatch": {
      const settings = await getSettings();
      const d = settings.dispatchDefaults || {};
      let locationId = p.locationId;
      if (!locationId && p.locationExternalId) {
        const loc = await Location.findOne({ externalId: p.locationExternalId }).lean();
        if (!loc?.rafttaar?.id) throw new ActionError(409, "LOCATION_NOT_SYNCED", `Location ${p.locationExternalId} has not been synced to Rafttaar yet`);
        locationId = loc.rafttaar.id;
      }
      const packages = p.packages && Object.keys(p.packages).length ? p.packages : { weightKg: d.weightKg, lengthCm: d.lengthCm, widthCm: d.widthCm, heightCm: d.heightCm };
      return client.dispatchOrder(id, { locationId, packages, boxCount: p.boxCount || d.boxCount || 1, ewayBillNo: p.ewayBillNo }, opts);
    }
    case "invoice_create": {
      const inv = await Invoice.findById(p.invoiceId).lean();
      if (!inv) throw new ActionError(404, "NOT_FOUND", "Local invoice draft disappeared");
      return client.createInvoice(id, (await import("./invoiceBuilder.js")).toApiInvoice(inv), opts);
    }
    case "invoice_void":
      return client.voidInvoice(id, { reason: p.reason }, opts);
    default:
      throw new Error(`unhandled action ${action.type}`);
  }
}

async function applyResult(action, result, client) {
  const orderId = action.order;
  switch (action.type) {
    case "acknowledge":
    case "status":
    case "cancel":
      await applyLock(orderId, result);
      break;
    case "dispatch": {
      await Order.updateOne(
        { _id: orderId },
        {
          $set: {
            status: "shipped",
            "rafttaar.fulfilmentState": result.fulfilmentState || "dispatched",
            "rafttaar.dispatchedAt": new Date(),
            "rafttaar.shipment.id": result.shipmentId ?? null,
            "rafttaar.shipment.carrierShipmentId": result.carrierShipmentId ?? null,
            "rafttaar.shipment.awbNumber": result.awbNumber ?? null,
            "rafttaar.shipment.courierName": result.courierName ?? null,
            "rafttaar.shipment.bookingStatus": result.bookingStatus ?? null,
            "rafttaar.lastSyncError": null
          }
        }
      );
      break;
    }
    case "invoice_create": {
      const inv = await Invoice.findByIdAndUpdate(action.payload.invoiceId, { $set: { status: "active", rafttaarInvoiceId: result.id } }, { new: true });
      await Order.updateOne(
        { _id: orderId },
        {
          $set: {
            "rafttaar.invoice.id": result.id,
            "rafttaar.invoice.invoiceNumber": result.invoice_number || inv?.invoiceNumber,
            "rafttaar.invoice.status": "active",
            "rafttaar.invoice.pdfUrl": result.pdf_url,
            "rafttaar.invoice.source": "erp"
          }
        }
      );
      break;
    }
    case "invoice_void": {
      await Invoice.updateOne({ rafttaarOrderId: action.rafttaarOrderId, status: "active" }, { $set: { status: "voided", voidReason: action.payload?.reason } });
      await Order.updateOne({ _id: orderId }, { $set: { "rafttaar.invoice.status": "voided" } });
      break;
    }
  }
  // The lock/lifecycle answers do not carry allowedActions; re-read the order so the UI offers
  // exactly what Rafttaar now allows (best effort — the follow-up event does the same).
  if (["acknowledge", "status", "cancel", "dispatch"].includes(action.type)) {
    await syncOrderById(action.rafttaarOrderId, { client }).catch(() => {});
  }
  // Booking returns before the carrier assigns the AWB; take another look right away (best effort).
  if (action.type === "dispatch" && result.shipmentId && !result.awbNumber) {
    try {
      const s = await client.getShipment(result.shipmentId);
      if (s?.awbNumber) await Order.updateOne({ _id: orderId }, { $set: { "rafttaar.shipment.awbNumber": s.awbNumber, "rafttaar.shipment.shipmentStatus": s.shipmentStatus } });
    } catch {
      /* the shipment.booked event will carry it */
    }
  }
}

const errInfo = (e) => ({ code: e.code, message: String(e.message).slice(0, 500), httpStatus: e.status ?? null, requestId: e.requestId ?? null });

/** Try one delivery attempt of an outbox row. Throws only for final (non-retryable) failures. */
export async function executeAction(action, { client } = {}) {
  client = client || getClient();
  action.attempts += 1;
  try {
    const result = await callRafttaar(client, action);
    await applyResult(action, result, client);
    action.status = "succeeded";
    action.result = result;
    action.lastError = undefined;
    action.completedAt = new Date();
    action.nextRetryAt = undefined;
    await action.save();
    return { status: "succeeded", action, result };
  } catch (error) {
    if (error instanceof RafttaarApiError && error.retryable) {
      if (action.attempts >= MAX_ATTEMPTS) {
        action.status = "dead";
      } else {
        action.nextRetryAt = new Date(Date.now() + (error.retryAfterMs ?? RETRY_DELAYS_MS[action.attempts - 1]));
      }
      action.lastError = errInfo(error);
      await action.save();
      return { status: action.status === "dead" ? "dead" : "queued", action, error };
    }

    // Final failure.
    action.status = "failed";
    action.lastError = errInfo(error);
    action.completedAt = new Date();
    action.nextRetryAt = undefined;
    await action.save();

    if (action.type === "invoice_create") {
      await Invoice.updateOne({ _id: action.payload.invoiceId }, { $set: { status: "voided", voidReason: `Rejected by Rafttaar: ${error.code}` } });
    }
    if (error instanceof RafttaarApiError && STALE_STATE_CODES.has(error.code)) {
      await syncOrderById(action.rafttaarOrderId, { client }).catch(() => {});
    }
    throw error;
  }
}

// --------------------------------------------------------------- outbox worker
let timer = null;
let started = false;
const TICK_MS = 20_000;
const CLAIM_MS = 60_000;

async function claimDue() {
  const now = new Date();
  return RafttaarAction.findOneAndUpdate(
    { status: "pending", nextRetryAt: { $lte: now } },
    { $set: { nextRetryAt: new Date(now.getTime() + CLAIM_MS) } }, // lease: another instance won't grab it
    { new: true, sort: { nextRetryAt: 1 } }
  );
}

export async function processDueActions({ client } = {}) {
  let n = 0;
  for (let i = 0; i < 25; i++) {
    const action = await claimDue();
    if (!action) break;
    n++;
    try {
      await executeAction(action, { client });
    } catch {
      /* final failure already recorded on the row */
    }
  }
  return n;
}

export function startOutboxWorker() {
  if (started) return;
  started = true;
  const loop = async () => {
    try {
      await processDueActions();
    } catch (error) {
      console.log("[rafttaar:outbox] tick failed:", error.message);
    }
    if (started) timer = setTimeout(loop, TICK_MS);
  };
  timer = setTimeout(loop, 5_000);
}

export function stopOutboxWorker() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
