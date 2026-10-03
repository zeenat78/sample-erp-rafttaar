import { Order } from "../models/Order.js";
import { Invoice } from "../models/Invoice.js";
import { Location } from "../models/Location.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { RafttaarAction } from "../models/RafttaarAction.js";
import { RafttaarEvent } from "../models/RafttaarEvent.js";
import { ActionError, assertIdle, executeAction, performAction } from "../integrations/rafttaar/actions.js";
import { getClient, getSettings, isConfigured, loadConfig, maskedKey, updateSettings } from "../integrations/rafttaar/config.js";
import { ingestEvent } from "../integrations/rafttaar/eventProcessor.js";
import { createInvoiceDraft, renderInvoicePdf } from "../integrations/rafttaar/invoiceBuilder.js";
import { deactivateLocation, refreshLocations, syncInventory, syncLocation } from "../integrations/rafttaar/masterData.js";
import { reconcileOrders, syncOrderById } from "../integrations/rafttaar/orderSync.js";
import { bootstrap, pollNow } from "../integrations/rafttaar/poller.js";
import * as webhooks from "../integrations/rafttaar/webhooks.js";

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : fallback);

// ===================================================================== connection

export async function getStatus(req, res) {
  const cfg = loadConfig();
  const settings = await getSettings();
  const [events, pendingActions, deadActions, orders] = await Promise.all([
    RafttaarEvent.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    RafttaarAction.countDocuments({ status: "pending" }),
    RafttaarAction.countDocuments({ status: "dead" }),
    Order.aggregate([{ $match: { source: "rafttaar" } }, { $group: { _id: "$rafttaar.fulfilmentState", n: { $sum: 1 } } }])
  ]);

  const out = {
    configured: isConfigured(cfg),
    environment: cfg.environment,
    keyPreview: maskedKey(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    publicBaseUrl: cfg.publicBaseUrl || null,
    workersEnabled: cfg.workersEnabled,
    sync: {
      mode: settings.syncMode,
      pollIntervalSec: settings.pollIntervalSec,
      cursor: settings.cursor,
      bootstrappedAt: settings.bootstrappedAt,
      lastPollAt: settings.lastPollAt,
      lastPollSuccessAt: settings.lastPollSuccessAt,
      lastPollError: settings.lastPollError,
      lastWebhookAt: settings.lastWebhookAt,
      lastReconcileAt: settings.lastReconcileAt
    },
    webhook: webhooks.describeOurWebhook(settings),
    invoiceSettings: settings.invoice,
    dispatchDefaults: settings.dispatchDefaults,
    counts: {
      eventsByStatus: Object.fromEntries(events.map((e) => [e._id, e.n])),
      ordersByFulfilmentState: Object.fromEntries(orders.map((o) => [o._id || "unknown", o.n])),
      pendingActions,
      deadActions
    }
  };

  if (req.query.live === "true" && out.configured) {
    try {
      const client = getClient();
      const [whoami, status] = await Promise.all([client.whoami(), client.getStatus()]);
      out.live = { ok: true, whoami, status, rateLimit: client.lastRateLimit };
    } catch (error) {
      out.live = { ok: false, error: error.toJSON ? error.toJSON() : { message: error.message } };
    }
  }
  ok(res, out);
}

export async function testConnection(_req, res) {
  const client = getClient();
  const [whoami, status] = await Promise.all([client.whoami(), client.getStatus()]);
  ok(res, { whoami, status, rateLimit: client.lastRateLimit });
}

export async function patchSettings(req, res) {
  const body = req.body || {};
  const patch = {};

  if (body.syncMode !== undefined) {
    if (!["off", "polling", "webhook"].includes(body.syncMode)) throw new ActionError(400, "VALIDATION_ERROR", "syncMode must be off, polling or webhook");
    if (body.syncMode === "webhook") {
      const s = await getSettings();
      if (!s.webhook?.id) throw new ActionError(409, "WEBHOOK_NOT_REGISTERED", "Register the webhook first (Integration -> Webhooks), then switch to webhook mode.");
      if (s.webhook.status === "disabled") throw new ActionError(409, "WEBHOOK_DISABLED", "The registered webhook is disabled on Rafttaar — re-enable it first.");
    }
    patch.syncMode = body.syncMode;
  }
  if (body.pollIntervalSec !== undefined) {
    const n = num(body.pollIntervalSec, NaN);
    if (!(n >= 2 && n <= 3600)) throw new ActionError(400, "VALIDATION_ERROR", "pollIntervalSec must be between 2 and 3600");
    patch.pollIntervalSec = n;
  }
  for (const key of ["sellerGstin", "sellerState", "defaultHsn"]) {
    if (body.invoice?.[key] !== undefined) patch[`invoice.${key}`] = String(body.invoice[key]).trim();
  }
  if (body.invoice?.defaultGstRatePercent !== undefined) {
    const n = num(body.invoice.defaultGstRatePercent, NaN);
    if (!(n >= 0 && n <= 100)) throw new ActionError(400, "VALIDATION_ERROR", "defaultGstRatePercent must be 0-100");
    patch["invoice.defaultGstRatePercent"] = n;
  }
  for (const key of ["weightKg", "lengthCm", "widthCm", "heightCm", "boxCount"]) {
    if (body.dispatchDefaults?.[key] !== undefined) {
      const n = num(body.dispatchDefaults[key], NaN);
      if (!(n > 0)) throw new ActionError(400, "VALIDATION_ERROR", `dispatchDefaults.${key} must be a positive number`);
      patch[`dispatchDefaults.${key}`] = n;
    }
  }
  const s = await updateSettings(patch);
  ok(res, { syncMode: s.syncMode, pollIntervalSec: s.pollIntervalSec, invoice: s.invoice, dispatchDefaults: s.dispatchDefaults });
}

// ===================================================================== sync

export async function syncNow(_req, res) {
  ok(res, await pollNow());
}

export async function syncReconcile(_req, res) {
  ok(res, await reconcileOrders({ client: getClient() }));
}

export async function syncBootstrap(_req, res) {
  ok(res, await bootstrap({ client: getClient() }));
}

export async function listEvents(req, res) {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.type) filter.type = String(req.query.type);
  const limit = Math.min(200, Math.max(1, num(req.query.limit, 50)));
  const events = await RafttaarEvent.find(filter).sort({ seq: -1, createdAt: -1 }).limit(limit).lean();
  ok(res, { events });
}

export async function retryEvent(req, res) {
  const doc = await RafttaarEvent.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Event not found" });
  doc.status = "received";
  doc.attempts = 0;
  await doc.save();
  const result = await ingestEvent({ id: doc.eventId, seq: doc.seq, type: doc.type, schemaVersion: doc.schemaVersion, occurredAt: doc.occurredAt, data: doc.data }, doc.source);
  ok(res, { outcome: result.outcome, error: result.event?.error || null });
}

export async function listActions(req, res) {
  const filter = {};
  if (req.query.order) filter.order = req.query.order;
  if (req.query.status) filter.status = String(req.query.status);
  const actions = await RafttaarAction.find(filter).sort({ createdAt: -1 }).limit(num(req.query.limit, 50)).lean();
  ok(res, { actions });
}

export async function retryAction(req, res) {
  const action = await RafttaarAction.findById(req.params.id);
  if (!action) return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Action not found" });
  if (action.status !== "dead") throw new ActionError(409, "NOT_RETRYABLE", "Only actions that exhausted their retries can be retried; start a new action for refused ones.");
  action.status = "pending";
  action.attempts = 0;
  await action.save();
  const result = await executeAction(action);
  ok(res, { status: result.status });
}

// ===================================================================== webhooks

export async function whList(_req, res) {
  ok(res, await webhooks.listWebhooks());
}
export async function whRegister(req, res) {
  ok(res, await webhooks.registerWebhook({ url: req.body?.url, eventTypes: req.body?.eventTypes }), 201);
}
export async function whUpdate(req, res) {
  const { url, eventTypes, status } = req.body || {};
  ok(res, await webhooks.updateWebhook(req.params.id, { ...(url ? { url } : {}), ...(eventTypes ? { eventTypes } : {}), ...(status ? { status } : {}) }));
}
export async function whDelete(req, res) {
  ok(res, await webhooks.deleteWebhook(req.params.id));
}
export async function whRotate(req, res) {
  ok(res, await webhooks.rotateSecret(req.params.id));
}
export async function whTestEvent(req, res) {
  ok(res, await getClient().sendTestWebhookEvent(req.params.id), 202);
}
export async function whDeliveries(req, res) {
  ok(res, await getClient().listWebhookDeliveries(req.params.id));
}
export async function whResend(req, res) {
  ok(res, await getClient().resendWebhookDelivery(req.params.id, req.params.deliveryId), 202);
}

// ===================================================================== sandbox (rtk_test_ only)

export async function sandboxCreateOrder(_req, res) {
  const client = getClient();
  const created = await client.createSandboxOrder();
  const order = await syncOrderById(created.id, { client });
  ok(res, { remote: created, order }, 201);
}
export async function sandboxAdvance(req, res) {
  ok(res, await getClient().advanceSandboxShipment(req.params.id));
}

// ===================================================================== order actions

async function loadOrder(req) {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ActionError(404, "NOT_FOUND", "Order not found");
  return order;
}

function respondAction(res, result, order) {
  if (result.status === "succeeded") return ok(res, { status: "succeeded", result: result.result, orderId: order._id });
  return ok(
    res,
    {
      status: result.status,
      message: "Rafttaar could not be reached; the action is saved and will be retried automatically with the same idempotency key.",
      actionId: result.action._id
    },
    202
  );
}

export const orderAction = (type) => async (req, res) => {
  const order = await loadOrder(req);
  const result = await performAction(order, type, req.body || {});
  respondAction(res, result, order);
};

export async function orderRefresh(req, res) {
  const order = await loadOrder(req);
  if (order.source !== "rafttaar") throw new ActionError(409, "NOT_A_RAFTTAAR_ORDER", "This order did not come from Rafttaar");
  ok(res, await syncOrderById(order.rafttaar.orderId));
}

export async function orderDetailExtras(req, res) {
  const order = await loadOrder(req);
  const [invoices, actions] = await Promise.all([
    Invoice.find({ order: order._id }).sort({ createdAt: -1 }).lean(),
    RafttaarAction.find({ order: order._id }).sort({ createdAt: -1 }).limit(30).lean()
  ]);
  ok(res, { invoices, actions });
}

export async function invoiceCreate(req, res) {
  const order = await loadOrder(req);
  await assertIdle(order);
  const draft = await createInvoiceDraft(order, req.body || {});
  const result = await performAction(order, "invoice_create", { invoiceId: String(draft._id) });
  respondAction(res, result, order);
}

export async function invoiceVoid(req, res) {
  const order = await loadOrder(req);
  respondAction(res, await performAction(order, "invoice_void", req.body || {}), order);
}

export async function invoiceFromRafttaar(req, res) {
  const order = await loadOrder(req);
  const client = getClient();
  const invoice = await client.getInvoice(order.rafttaar.orderId);
  let pdfUrl = null;
  try {
    pdfUrl = (await client.getInvoicePdf(order.rafttaar.orderId)).pdfUrl;
  } catch {
    /* optional */
  }
  ok(res, { invoice, pdfUrl });
}

export async function shipmentGet(req, res) {
  const order = await loadOrder(req);
  const id = order.rafttaar?.shipment?.id;
  if (!id) throw new ActionError(404, "NO_SHIPMENT", "This order has no shipment yet");
  const shipment = await getClient().getShipment(id);
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        "rafttaar.shipment.awbNumber": shipment.awbNumber ?? null,
        "rafttaar.shipment.courierName": shipment.courierName ?? null,
        "rafttaar.shipment.bookingStatus": shipment.bookingStatus,
        "rafttaar.shipment.shipmentStatus": shipment.shipmentStatus,
        "rafttaar.shipment.trackingHistory": (shipment.trackingHistory || []).map((t) => ({ status: t.status, label: t.label, occurredAt: t.occurredAt ? new Date(t.occurredAt) : undefined }))
      }
    }
  );
  ok(res, shipment);
}

export async function shipmentLabel(req, res) {
  const order = await loadOrder(req);
  const id = order.rafttaar?.shipment?.id;
  if (!id) throw new ActionError(404, "NO_SHIPMENT", "This order has no shipment yet");
  const { labelUrl } = await getClient().getShipmentLabel(id);
  await Order.updateOne({ _id: order._id }, { $set: { "rafttaar.shipment.labelUrl": labelUrl } });
  ok(res, { labelUrl });
}

// Public (unauthenticated) — Rafttaar stores this URL and hands it back. The path
// segment is an unguessable 48-hex token, so only holders of the link can read it.
export async function invoicePdf(req, res) {
  const token = String(req.params.token || "").replace(/\.pdf$/i, "");
  const invoice = await Invoice.findOne({ pdfToken: token }).lean();
  if (!invoice) return res.status(404).json({ success: false, code: "NOT_FOUND", message: "Invoice not found" });
  const order = await Order.findById(invoice.order).lean();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber.replace(/[^\w.-]+/g, "_")}.pdf"`);
  renderInvoicePdf(invoice, order, res);
}

// ===================================================================== locations

const LOCATION_FIELDS = ["externalId", "name", "address", "contact", "gstin", "isDefault"];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

export async function locList(_req, res) {
  ok(res, await Location.find().sort({ createdAt: 1 }).lean());
}

export async function locUpsert(req, res) {
  const externalId = String(req.params.externalId || req.body?.externalId || "").trim();
  if (!externalId) throw new ActionError(400, "VALIDATION_ERROR", "externalId is required");
  const fields = pick({ ...req.body, externalId }, LOCATION_FIELDS);
  let loc = await Location.findOne({ externalId });
  if (loc) {
    loc.set(fields);
    await loc.save();
  } else {
    loc = await Location.create({ ...fields, isDefault: fields.isDefault ?? (await Location.countDocuments()) === 0 });
  }
  const synced = req.body?.sync === false ? loc : await syncLocation(loc);
  ok(res, { location: synced, warning: !synced.contact?.email ? "No contact email: the carrier needs one to register the pickup." : undefined });
}

export async function locSync(req, res) {
  const loc = await Location.findOne({ externalId: req.params.externalId });
  if (!loc) throw new ActionError(404, "NOT_FOUND", "Location not found");
  ok(res, await syncLocation(loc));
}

export async function locRefresh(_req, res) {
  ok(res, await refreshLocations());
}

export async function locDeactivate(req, res) {
  const loc = await Location.findOne({ externalId: req.params.externalId });
  if (!loc) throw new ActionError(404, "NOT_FOUND", "Location not found");
  ok(res, await deactivateLocation(loc));
}

export async function locRemote(_req, res) {
  ok(res, await getClient().listLocations());
}

// ===================================================================== inventory

export async function invList(_req, res) {
  ok(res, await InventoryItem.find().sort({ sku: 1 }).lean());
}

export async function invUpsert(req, res) {
  const items = Array.isArray(req.body) ? req.body : req.body?.items;
  if (!Array.isArray(items) || !items.length) throw new ActionError(400, "VALIDATION_ERROR", "Send an array of { sku, stockQty, minStockQty?, locationExternalId?, productName? }");
  for (const it of items) {
    if (!it?.sku || !String(it.sku).trim()) throw new ActionError(400, "VALIDATION_ERROR", "Every item needs a sku");
    if (!Number.isInteger(Number(it.stockQty)) || Number(it.stockQty) < 0) throw new ActionError(400, "VALIDATION_ERROR", `stockQty for ${it.sku} must be a non-negative integer`);
  }
  await InventoryItem.bulkWrite(
    items.map((it) => ({
      updateOne: {
        filter: { sku: String(it.sku).trim(), locationExternalId: it.locationExternalId ? String(it.locationExternalId).trim() : "" },
        update: {
          $set: {
            stockQty: Number(it.stockQty),
            ...(it.minStockQty !== undefined && it.minStockQty !== null && it.minStockQty !== "" ? { minStockQty: Number(it.minStockQty) } : {}),
            ...(it.productName ? { productName: it.productName } : {}),
            "sync.status": "never"
          }
        },
        upsert: true
      }
    })),
    { ordered: false }
  );
  const summary = req.query.sync === "false" ? null : await syncInventory({ skus: items.map((i) => String(i.sku).trim()) });
  ok(res, { saved: items.length, sync: summary });
}

export async function invSync(_req, res) {
  ok(res, await syncInventory());
}

export async function invDelete(req, res) {
  const r = await InventoryItem.findByIdAndDelete(req.params.id);
  if (!r) throw new ActionError(404, "NOT_FOUND", "Inventory row not found");
  ok(res, { deleted: true });
}

