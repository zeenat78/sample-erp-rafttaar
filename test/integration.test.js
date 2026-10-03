/**
 * End-to-end tests of the whole Rafttaar integration against an in-process mock of
 * the Partner API (test/helpers/mockRafttaar.js) and a THROW-AWAY Mongo database
 * (erp_system_test on the same cluster — dropped at start and end; the real
 * erp_system DB is never touched).
 */
import "dotenv/config";
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { startMockRafttaar } from "./helpers/mockRafttaar.js";
import { signWebhookBody } from "../src/integrations/rafttaar/signature.js";

const baseUri = process.env.MONGODB_URI;
if (!baseUri) throw new Error("MONGODB_URI is required for the integration tests");
const testUri = baseUri.replace(/\/([^/?]*)(\?|$)/, "/erp_system_test$2");

let mock, server, base;
let M; // modules loaded after env is set
const call = async (method, path, body, headers = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text, headers: r.headers };
};

before(async () => {
  mock = await startMockRafttaar();
  process.env.RAFTTAAR_API_KEY = mock.apiKey;
  process.env.RAFTTAAR_BASE_URL = mock.baseUrl;
  process.env.PUBLIC_BASE_URL = "https://erp.example.test";
  process.env.RAFTTAAR_WORKERS = "off";
  await mongoose.connect(testUri);
  await mongoose.connection.dropDatabase();

  const [app, orders, settings, config, actions, poller, ev, locs, inv] = await Promise.all([
    import("../src/app.js"),
    import("../src/models/Order.js"),
    import("../src/models/RafttaarSetting.js"),
    import("../src/integrations/rafttaar/config.js"),
    import("../src/integrations/rafttaar/actions.js"),
    import("../src/integrations/rafttaar/poller.js"),
    import("../src/models/RafttaarEvent.js"),
    import("../src/models/Location.js"),
    import("../src/models/InventoryItem.js")
  ]);
  M = { Order: orders.Order, Setting: settings.RafttaarSetting, config, actions, poller, Event: ev.RafttaarEvent, Location: locs.Location, Inventory: inv.InventoryItem, Action: (await import("../src/models/RafttaarAction.js")).RafttaarAction, Invoice: (await import("../src/models/Invoice.js")).Invoice, ingest: (await import("../src/integrations/rafttaar/eventProcessor.js")).ingestEvent };
  await new Promise((r) => (server = app.default.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
  // never wait on the real throttle in tests
  const { RafttaarClient } = await import("../src/integrations/rafttaar/client.js");
  config.getClient();
  config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await mock.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

beforeEach(() => {
  mock.state.failNext.length = 0;
  mock.state.invoiceSource = "erp";
});

const ingestAll = () => M.poller.pollOnce();

async function erpOrderFor(remoteId) {
  return M.Order.findOne({ "rafttaar.orderId": remoteId });
}

/** New remote order -> synced into the ERP via the real poller. */
async function newOrder(opts) {
  const o = mock.addOrder(opts);
  await ingestAll();
  const erp = await erpOrderFor(o.order.id);
  assert.ok(erp, "order should be created by order.pushed");
  return { remote: o, erp };
}
const act = (erp, path, body) => call("POST", `/api/orders/${erp._id}/rafttaar/${path}`, body ?? {});

test("first connect: reconcile existing orders and jump to the head of the event log", async () => {
  const a = mock.addOrder();
  const b = mock.addOrder();
  const head = mock.state.seq;
  const r = await M.poller.bootstrap();
  assert.equal(r.cursor, head);
  assert.equal(r.reconcile.created >= 2, true);
  assert.ok(await erpOrderFor(a.order.id));
  assert.ok(await erpOrderFor(b.order.id));
  const s = await M.Setting.findOne({ key: "rafttaar" });
  assert.equal(s.cursor, head);
  assert.ok(s.bootstrappedAt);
  const again = await M.poller.pollOnce();
  assert.equal(again.fetched, 0); // nothing replayed from history
});

test("polling: a new order arrives via order.pushed and is mapped correctly", async () => {
  const { erp } = await newOrder({ subtotalPaise: 500000, gstPaise: 90000 });
  assert.equal(erp.source, "rafttaar");
  assert.equal(erp.status, "pending");
  assert.equal(erp.rafttaar.fulfilmentState, "pushed");
  assert.equal(erp.totalAmount, 5900); // total in rupees (subtotal + gst)
  assert.equal(erp.items[0].unitPricePaise, 250000);
  assert.equal(erp.items[0].price, 2500);
  assert.equal(erp.shippingAddress.city, "Bengaluru");
  assert.equal(erp.customer.phone, "9000000000");
});

test("poller advances its cursor to the server nextCursor and replays nothing", async () => {
  const before = (await M.Setting.findOne({ key: "rafttaar" })).cursor;
  mock.addOrder();
  const r = await M.poller.pollOnce();
  assert.equal(r.fetched, 1);
  assert.equal(r.processed, 1);
  assert.equal((await M.Setting.findOne({ key: "rafttaar" })).cursor, before + 1);
  assert.equal((await M.poller.pollOnce()).fetched, 0);
});

test("dedupe: the same event twice is applied once", async () => {
  const o = mock.addOrder();
  const ev = mock.state.events.at(-1);
  const r1 = await M.ingest(ev, "webhook");
  const r2 = await M.ingest(ev, "poll");
  assert.equal(r1.outcome, "processed");
  assert.equal(r2.outcome, "duplicate");
  assert.equal(await M.Event.countDocuments({ eventId: ev.id }), 1);
  assert.equal(await M.Order.countDocuments({ "rafttaar.orderId": o.order.id }), 1);
});

test("out-of-order / replayed events converge to Rafttaar's CURRENT state", async () => {
  const { remote, erp } = await newOrder();
  await act(erp, "acknowledge");
  await act(erp, "status", { status: "confirmed" });
  // an old 'acknowledged' event arrives AFTER the order moved on
  await M.ingest({ id: "late-1", seq: 9999, type: "order.updated", schemaVersion: 1, data: { orderId: remote.order.id, fulfilmentState: "acknowledged" } }, "webhook");
  assert.equal((await erpOrderFor(remote.order.id)).rafttaar.fulfilmentState, "confirmed");
});

test("event for an unknown order is ignored, never blocks the feed", async () => {
  const r = await M.ingest({ id: "ghost-1", seq: 10000, type: "order.updated", schemaVersion: 1, data: { orderId: "does-not-exist", fulfilmentState: "confirmed" } }, "poll");
  assert.equal(r.outcome, "ignored");
  assert.equal(r.final, true);
});

test("unknown event types are stored as ignored", async () => {
  const r = await M.ingest({ id: "future-1", seq: 10001, type: "something.new", schemaVersion: 2, data: {} }, "poll");
  assert.equal(r.outcome, "ignored");
});

test("poller does not skip an event it failed to apply (retry next tick), then parks poison events", async () => {
  const o = mock.addOrder();
  const pushed = mock.state.events.at(-1);
  mock.failNext(new RegExp(`GET /orders/${o.order.id}`), { status: 503, times: 100, code: "UNAVAILABLE" });
  const cursorBefore = (await M.Setting.findOne({ key: "rafttaar" })).cursor;
  // one fast client (no retries) so the 503s surface immediately
  const r1 = await M.poller.pollOnce({ client: new (await import("../src/integrations/rafttaar/client.js")).RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, maxRetries: 0, sleep: async () => {} }) });
  assert.equal(r1.stalled, true);
  assert.ok((await M.Setting.findOne({ key: "rafttaar" })).cursor < pushed.seq, "cursor must stay before the failed event");
  assert.equal(cursorBefore < pushed.seq, true);
  mock.state.failNext.length = 0;
  const r2 = await M.poller.pollOnce();
  assert.equal(r2.processed >= 1, true);
  assert.ok(await erpOrderFor(o.order.id));
});

// ------------------------------------------------------------------ actions

test("full happy path: acknowledge -> confirm -> packaging -> invoice -> dispatch -> delivered", async () => {
  const { remote, erp } = await newOrder({ subtotalPaise: 500000, gstPaise: 90000 });
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { "invoice.sellerState": "Karnataka" } });

  let r = await act(erp, "acknowledge", { erpReference: "SO-1" });
  assert.equal(r.status, 200, r.text);
  assert.equal((await erpOrderFor(remote.order.id)).rafttaar.erpReference, "SO-1");

  assert.equal((await act(erp, "status", { status: "confirmed" })).status, 200);
  assert.equal((await act(erp, "status", { status: "packaging" })).status, 200);
  const o1 = await erpOrderFor(remote.order.id);
  assert.equal(o1.status, "processing");
  assert.deepEqual(o1.rafttaar.allowedActions.includes("dispatched"), true, "allowedActions refreshed after the action");

  // dispatch before the invoice is refused by Rafttaar and surfaced with its code
  r = await act(erp, "dispatch");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "INVOICE_REQUIRED");
  assert.equal(r.json.source, "rafttaar");

  r = await act(erp, "invoice", {});
  assert.equal(r.status, 200, r.text);
  const inv = await M.Invoice.findOne({ rafttaarOrderId: remote.order.id, status: "active" });
  assert.ok(inv);
  const line = inv.lines[0];
  assert.equal(line.taxableValuePaise, 500000);
  assert.equal(line.cgstPaise + line.sgstPaise, 90000); // intra-state: CGST+SGST
  assert.equal(line.igstPaise, 0);
  assert.equal(inv.grandTotalPaise, 590000);
  const sent = mock.state.calls.filter((c) => c.path.endsWith("/invoice") && c.method === "POST").at(-1);
  assert.match(sent.body.pdf, /^https:\/\/erp\.example\.test\/invoices\/[0-9a-f]{48}\.pdf$/);

  r = await act(erp, "dispatch", { packages: { weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 10 }, boxCount: 1 });
  assert.equal(r.status, 200, r.text);
  const o2 = await erpOrderFor(remote.order.id);
  assert.equal(o2.status, "shipped");
  assert.match(o2.rafttaar.shipment.awbNumber, /^AWB/);

  // dispatching again is refused and our copy is re-read from Rafttaar
  r = await act(erp, "dispatch");
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "SHIPMENT_ALREADY_BOOKED");

  // carrier events arrive
  mock.state.orders.get(remote.order.id).lock.state = "delivered";
  mock.state.orders.get(remote.order.id).shipment.status = "delivered";
  mock.emit("shipment.delivered", { orderId: remote.order.id, shipmentId: o2.rafttaar.shipment.id, status: "delivered" });
  await ingestAll();
  const o3 = await erpOrderFor(remote.order.id);
  assert.equal(o3.status, "delivered");
  assert.equal(o3.rafttaar.shipment.trackingHistory.length, 1);
});

test("validation happens before anything is sent to Rafttaar", async () => {
  const { erp } = await newOrder();
  const callsBefore = mock.state.calls.length;
  assert.equal((await act(erp, "status", { status: "delayed" })).json.code, "VALIDATION_ERROR"); // reason required
  assert.equal((await act(erp, "status", { status: "confirmed", newEta: "2026-12-01" })).json.code, "VALIDATION_ERROR"); // newEta only with delayed
  assert.equal((await act(erp, "status", { status: "shipped" })).json.code, "VALIDATION_ERROR");
  assert.equal(mock.state.calls.length, callsBefore);
});

test("a business refusal is final: recorded as failed, order state re-read", async () => {
  const { remote, erp } = await newOrder();
  const r = await act(erp, "status", { status: "confirmed" }); // not acknowledged yet
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "ORDER_NOT_ACKNOWLEDGED");
  const a = await M.Action.findOne({ rafttaarOrderId: remote.order.id, type: "status" });
  assert.equal(a.status, "failed");
  assert.equal(a.lastError.code, "ORDER_NOT_ACKNOWLEDGED");
});

test("delayed: reason + ETA reach Rafttaar and come back on the order", async () => {
  const { remote, erp } = await newOrder();
  await act(erp, "acknowledge");
  const r = await act(erp, "status", { status: "delayed", reason: "Awaiting restock", newEta: "2026-10-20" });
  assert.equal(r.status, 200, r.text);
  const o = await erpOrderFor(remote.order.id);
  assert.equal(o.rafttaar.fulfilmentState, "delayed");
  assert.equal(o.rafttaar.delayReason, "Awaiting restock");
  assert.ok(o.rafttaar.newEta);
});

test("cancel", async () => {
  const { remote, erp } = await newOrder();
  await act(erp, "acknowledge");
  assert.equal((await act(erp, "cancel", { reason: "Out of stock" })).status, 200);
  assert.equal((await erpOrderFor(remote.order.id)).status, "cancelled");
});

test("OUTBOX: Rafttaar down -> action queued (202); retried later with the SAME idempotency key; done exactly once", async () => {
  const { remote, erp } = await newOrder();
  mock.failNext(new RegExp(`POST .*${remote.order.id}/acknowledge`), { status: 503, times: 50, code: "UNAVAILABLE" });
  const slow = new (await import("../src/integrations/rafttaar/client.js")).RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, maxRetries: 0, sleep: async () => {} });
  M.config._setClientForTests(slow);
  const r = await act(erp, "acknowledge", { erpReference: "RETRY-1" });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.data.status, "queued");
  const queued = await M.Action.findOne({ rafttaarOrderId: remote.order.id, type: "acknowledge" });
  assert.equal(queued.status, "pending");
  assert.ok(queued.nextRetryAt > new Date());

  // second action on the same order is refused while one is in flight
  assert.equal((await act(erp, "status", { status: "confirmed" })).json.code, "ACTION_IN_PROGRESS");

  // Rafttaar recovers; the outbox worker retries
  mock.state.failNext.length = 0;
  await M.Action.updateOne({ _id: queued._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  const n = await M.actions.processDueActions({ client: slow });
  assert.equal(n, 1);
  const done = await M.Action.findById(queued._id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.attempts, 2);
  const acks = mock.state.calls.filter((c) => c.path.endsWith(`${remote.order.id}/acknowledge`) && c.method === "POST");
  assert.equal(new Set(acks.map((c) => c.headers["idempotency-key"])).size, 1, "same key on every attempt");
  assert.equal((await erpOrderFor(remote.order.id)).rafttaar.fulfilmentState, "acknowledged");
  M.config._setClientForTests(new (await import("../src/integrations/rafttaar/client.js")).RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
});

test("manual status edits are blocked on Rafttaar orders", async () => {
  const { erp } = await newOrder();
  const r = await call("PATCH", `/api/orders/${erp._id}`, { status: "delivered" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "USE_RAFTTAAR_ACTIONS");
});

// ------------------------------------------------------------------ invoices

test("invoice: inter-state sale uses IGST; PDF is served publicly; duplicate refused; void then re-issue", async () => {
  const { remote, erp } = await newOrder({ subtotalPaise: 100001, gstPaise: 18001, items: [
    { lineId: "l1", productId: "p1", name: "A", quantity: 1, unitPricePaise: 40001 },
    { lineId: "l2", productId: "p2", name: "B", quantity: 3, unitPricePaise: 20000 }
  ] });
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { "invoice.sellerState": "Maharashtra" } });
  await act(erp, "acknowledge");
  const r = await act(erp, "invoice", { hsn: "8504" });
  assert.equal(r.status, 200, r.text);
  const inv = await M.Invoice.findOne({ rafttaarOrderId: remote.order.id, status: "active" });
  assert.equal(inv.lines.reduce((a, l) => a + l.igstPaise, 0), 18001); // allocation sums EXACTLY (odd paise)
  assert.equal(inv.lines.reduce((a, l) => a + l.taxableValuePaise, 0), 100001);
  assert.ok(inv.lines.every((l) => l.cgstPaise === 0 && l.sgstPaise === 0 && l.hsn === "8504"));

  const pdf = await fetch(`${base}/invoices/${inv.pdfToken}.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
  assert.equal((await fetch(`${base}/invoices/${"0".repeat(48)}.pdf`)).status, 404);

  assert.equal((await act(erp, "invoice", {})).json.code, "INVOICE_ALREADY_EXISTS");
  assert.equal((await act(erp, "invoice/void", { reason: "wrong HSN" })).status, 200);
  assert.equal((await M.Invoice.findOne({ _id: inv._id })).status, "voided");
  const r2 = await act(erp, "invoice", { hsn: "8505" });
  assert.equal(r2.status, 200, r2.text);
  const numbers = (await M.Invoice.find({ rafttaarOrderId: remote.order.id })).map((i) => i.invoiceNumber);
  assert.equal(new Set(numbers).size, 2, "a voided invoice number is never reused");
});

test("invoice: seller whose invoices are issued by Rafttaar -> INVOICE_LOCKED surfaced, draft voided", async () => {
  const { remote, erp } = await newOrder();
  await act(erp, "acknowledge");
  mock.state.invoiceSource = "rafttaar";
  const r = await act(erp, "invoice", {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "INVOICE_LOCKED");
  assert.equal((await M.Invoice.find({ rafttaarOrderId: remote.order.id, status: "active" })).length, 0);
  assert.equal((await M.Invoice.findOne({ rafttaarOrderId: remote.order.id })).status, "voided");
});

test("invoice requires a public https URL (Rafttaar stores a link, not the file)", async () => {
  const { erp } = await newOrder();
  await act(erp, "acknowledge");
  const saved = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "http://localhost:5000";
  const r = await act(erp, "invoice", {});
  process.env.PUBLIC_BASE_URL = saved;
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "PUBLIC_URL_REQUIRED");
});

// ------------------------------------------------------------------ webhooks

test("webhook: register -> signed delivery is applied; bad/missing signature rejected; duplicate harmless", async () => {
  const reg = await call("POST", "/api/rafttaar/webhooks/register", {});
  assert.equal(reg.status, 201, reg.text);
  assert.equal(reg.json.data.url, "https://erp.example.test/webhooks/rafttaar");
  assert.equal(/whsec_[0-9a-f]{16}/.test(JSON.stringify(reg.json)), false, "the full secret is never returned to the browser");
  const secret = mock.state.webhooks[0].secret;

  const o = mock.addOrder();
  const ev = mock.state.events.at(-1);
  const raw = JSON.stringify(ev);
  const send = (body, sig) => call("POST", "/webhooks/rafttaar", body, sig ? { "Rafttaar-Signature": sig } : {});

  assert.equal((await send(raw)).status, 401); // no signature
  assert.equal((await send(raw, signWebhookBody(raw, "whsec_wrong"))).status, 401);
  assert.equal(await erpOrderFor(o.order.id), null, "nothing applied for rejected deliveries");

  const ok = await send(raw, signWebhookBody(raw, secret));
  assert.equal(ok.status, 200, ok.text);
  assert.ok(await erpOrderFor(o.order.id));
  const dup = await send(raw, signWebhookBody(raw, secret));
  assert.equal(dup.status, 200);
  assert.equal(dup.json.outcome, "duplicate");

  // synthetic "test event" (no orderId) is acknowledged with 200, not retried forever
  const t = JSON.stringify({ id: "test-evt-1", seq: 777777, type: "order.updated", schemaVersion: 1, occurredAt: new Date().toISOString(), data: { orderId: null } });
  assert.equal((await send(t, signWebhookBody(t, secret))).status, 200);
});

test("webhook: failure to apply -> 500 so Rafttaar retries; rotated secret: old still accepted during grace", async () => {
  const secret = mock.state.webhooks[0].secret;
  const o = mock.addOrder();
  mock.state.orders.delete(o.order.id); // pushed event for an order Rafttaar then stops serving -> NOT_FOUND -> ignored (200)
  const ev = mock.state.events.at(-1);
  const raw = JSON.stringify(ev);
  assert.equal((await call("POST", "/webhooks/rafttaar", raw, { "Rafttaar-Signature": signWebhookBody(raw, secret) })).status, 200);

  const o2 = mock.addOrder();
  const raw2 = JSON.stringify(mock.state.events.at(-1));
  mock.failNext(new RegExp(`GET /orders/${o2.order.id}`), { status: 503, times: 100, code: "UNAVAILABLE" });
  const slow = new (await import("../src/integrations/rafttaar/client.js")).RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, maxRetries: 0, sleep: async () => {} });
  M.config._setClientForTests(slow);
  const bad = await call("POST", "/webhooks/rafttaar", raw2, { "Rafttaar-Signature": signWebhookBody(raw2, secret) });
  assert.equal(bad.status, 500);
  mock.state.failNext.length = 0;

  const rot = await call("POST", `/api/rafttaar/webhooks/${mock.state.webhooks[0].id}/rotate-secret`, {});
  assert.equal(rot.status, 200, rot.text);
  const newSecret = mock.state.webhooks[0].secret;
  assert.notEqual(newSecret, secret);
  const o3 = mock.addOrder();
  const raw3 = JSON.stringify(mock.state.events.at(-1));
  M.config._setClientForTests(new (await import("../src/integrations/rafttaar/client.js")).RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
  assert.equal((await call("POST", "/webhooks/rafttaar", raw3, { "Rafttaar-Signature": signWebhookBody(raw3, secret) })).status, 200, "old secret accepted in the 24h grace");
  assert.equal((await call("POST", "/webhooks/rafttaar", raw3, { "Rafttaar-Signature": signWebhookBody(raw3, newSecret) })).status, 200);
  assert.ok(await erpOrderFor(o3.order.id));
});

test("webhook: cannot switch to webhook mode before registering one; cannot register twice", async () => {
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { webhook: {} } });
  assert.equal((await call("PATCH", "/api/rafttaar/settings", { syncMode: "webhook" })).json.code, "WEBHOOK_NOT_REGISTERED");
  assert.equal((await call("PATCH", "/api/rafttaar/settings", { syncMode: "nope" })).status, 400);
  mock.state.webhooks.length = 0;
  assert.equal((await call("POST", "/api/rafttaar/webhooks/register", {})).status, 201);
  assert.equal((await call("POST", "/api/rafttaar/webhooks/register", {})).json.code, "WEBHOOK_ALREADY_REGISTERED");
  assert.equal((await call("PATCH", "/api/rafttaar/settings", { syncMode: "webhook" })).status, 200);
  await call("PATCH", "/api/rafttaar/settings", { syncMode: "polling" });
});

// ------------------------------------------------------------------ master data

test("locations: upsert is idempotent per warehouse code; carrier status refresh; deactivate", async () => {
  const body = { name: "Main", address: { line1: "1 St", city: "Pune", state: "Maharashtra", pincode: "411001" }, contact: { name: "A", phone: "9", email: "w@example.com" } };
  const a = await call("PUT", "/api/locations/WH-1", body);
  assert.equal(a.status, 200, a.text);
  const b = await call("PUT", "/api/locations/WH-1", { ...body, name: "Main renamed" });
  assert.equal(b.json.data.location.name, "Main renamed");
  assert.equal(mock.state.locations.size, 1);
  assert.equal(await M.Location.countDocuments(), 1);
  const loc = await M.Location.findOne({ externalId: "WH-1" });
  assert.equal(loc.rafttaar.carrierStatus, "pending");
  assert.equal(loc.isDefault, true);
  mock.state.locations.get("WH-1").carrierStatus = "ready";
  await call("POST", "/api/locations/refresh", {});
  assert.equal((await M.Location.findOne({ externalId: "WH-1" })).rafttaar.carrierStatus, "ready");
  const noEmail = await call("PUT", "/api/locations/WH-2", { ...body, contact: { name: "A" } });
  assert.match(noEmail.json.data.warning, /email/i);
  assert.equal((await call("POST", "/api/locations/WH-1/deactivate", {})).json.data.isActive, false);
  assert.equal((await call("PUT", "/api/locations/ ", body)).status >= 400, true);
});

test("inventory: per-item result statuses are stored; >500 items go in batches", async () => {
  const r = await call("PUT", "/api/inventory", [{ sku: "OK-1", stockQty: 10, minStockQty: 2 }, { sku: "BAD-1", stockQty: 5 }, { sku: "WH-1", stockQty: 1 }]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.sync.updated, 1);
  assert.equal(r.json.data.sync.rejected, 2);
  const rows = Object.fromEntries((await M.Inventory.find()).map((i) => [i.sku, i.sync.status]));
  assert.deepEqual([rows["OK-1"], rows["BAD-1"], rows["WH-1"]], ["updated", "not_found", "warehouse_managed"]);

  assert.equal((await call("PUT", "/api/inventory", [{ sku: "X", stockQty: -1 }])).json.code, "VALIDATION_ERROR");
  assert.equal((await call("PUT", "/api/inventory", [{ stockQty: 1 }])).json.code, "VALIDATION_ERROR");

  const big = Array.from({ length: 600 }, (_, i) => ({ sku: `BULK-${i}`, stockQty: i }));
  await call("PUT", "/api/inventory?sync=false", big);
  const before = mock.state.calls.filter((c) => c.method === "PUT" && c.path === "/inventory").length;
  const s = await call("POST", "/api/inventory/sync", {});
  assert.equal(s.status, 200, s.text);
  assert.equal(mock.state.calls.filter((c) => c.method === "PUT" && c.path === "/inventory").length - before, 2); // 603 rows -> 2 calls of <=500
  assert.ok(mock.state.calls.filter((c) => c.method === "PUT" && c.path === "/inventory").every((c) => c.body.length <= 500));
});

test("inventory.rejected event marks the SKU as warehouse-managed", async () => {
  await M.ingest({ id: "inv-rej-1", seq: 20000, type: "inventory.rejected", schemaVersion: 1, data: { sku: "OK-1", reason: "warehouse_managed" } }, "poll");
  assert.equal((await M.Inventory.findOne({ sku: "OK-1" })).sync.status, "warehouse_managed");
});

// ------------------------------------------------------------------ reconcile + status

test("reconcile repairs a missed event (no webhook, no poll needed)", async () => {
  const { remote, erp } = await newOrder();
  mock.state.orders.get(remote.order.id).lock.state = "acknowledged"; // changed on Rafttaar, event lost
  const s = await call("POST", "/api/rafttaar/sync/reconcile", {});
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.data.updated >= 1);
  assert.equal((await erpOrderFor(remote.order.id)).rafttaar.fulfilmentState, "acknowledged");
  assert.ok(erp);
});

test("status endpoint never leaks the API key or webhook secret", async () => {
  const r = await call("GET", "/api/rafttaar/status?live=true");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.live.ok, true);
  const txt = JSON.stringify(r.json);
  assert.equal(txt.includes(mock.apiKey), false);
  assert.equal(/whsec_[0-9a-f]{16}/.test(txt), false);
  assert.match(r.json.data.keyPreview, /^rtk_test_…/);
});

test("when Rafttaar is unreachable the ERP answers 502 with a code, not a crash", async () => {
  const { RafttaarClient } = await import("../src/integrations/rafttaar/client.js");
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: "http://127.0.0.1:1", maxRetries: 0, sleep: async () => {} }));
  const r = await call("POST", "/api/rafttaar/connection/test", {});
  assert.equal(r.status, 502);
  assert.match(r.json.code, /NETWORK_ERROR|TIMEOUT/);
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
});

test("sandbox helper refuses live keys at Rafttaar (SANDBOX_ONLY passes through)", async () => {
  const { RafttaarClient } = await import("../src/integrations/rafttaar/client.js");
  // a live-prefixed key against a mock that enforces SANDBOX_ONLY
  const liveMock = await startMockRafttaar({ apiKey: "rtk_live_mock" });
  M.config._setClientForTests(new RafttaarClient({ apiKey: "rtk_live_mock", baseUrl: liveMock.baseUrl, sleep: async () => {} }));
  const r = await call("POST", "/api/rafttaar/sandbox/orders", {});
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "SANDBOX_ONLY");
  await liveMock.close();
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
});

test("switching the key between environments resets cursor, bootstrap and webhook (a sandbox cursor must never read live events)", async () => {
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { environment: "live", cursor: 123, bootstrappedAt: new Date(), webhook: { id: "w-old", secret: "s" }, syncMode: "webhook" } });
  assert.equal(await M.poller.ensureEnvironment(), true); // configured key is rtk_test_ -> "test"
  const s = await M.Setting.findOne({ key: "rafttaar" });
  assert.equal(s.environment, "test");
  assert.equal(s.cursor, 0);
  assert.equal(s.bootstrappedAt, undefined);
  assert.equal(s.webhook?.id, undefined);
  assert.equal(s.syncMode, "polling");
  assert.equal(await M.poller.ensureEnvironment(), false); // stable afterwards
});

// ------------------------------------------------------------------ dispatch input + abandon

async function readyToDispatch() {
  const { remote, erp } = await newOrder({ subtotalPaise: 500000, gstPaise: 90000 });
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { "invoice.sellerState": "Karnataka" } });
  await act(erp, "acknowledge");
  await act(erp, "status", { status: "confirmed" });
  await act(erp, "status", { status: "packaging" });
  assert.equal((await act(erp, "invoice", {})).status, 200);
  return { remote, erp };
}

test("dispatch: fields left blank are filled from the saved defaults (dimensions without a weight used to reach the carrier API half-empty)", async () => {
  const { erp } = await readyToDispatch();
  await M.Setting.updateOne({ key: "rafttaar" }, { $set: { "dispatchDefaults.weightKg": 3 } });
  const r = await act(erp, "dispatch", { packages: { lengthCm: "110", widthCm: 21, heightCm: 1, weightKg: "" }, boxCount: 2 });
  assert.equal(r.status, 200, r.text);
  const sent = mock.state.calls.filter((c) => c.method === "POST" && c.path.endsWith("/dispatch")).at(-1).body;
  assert.deepEqual(sent.packages, { weightKg: 3, lengthCm: 110, widthCm: 21, heightCm: 1 });
  assert.equal(sent.boxCount, 2);
});

test("dispatch: nonsense package input is rejected before anything is sent", async () => {
  const { erp } = await readyToDispatch();
  const before = mock.state.calls.length;
  for (const bad of [{ packages: { weightKg: -1 } }, { packages: { lengthCm: "abc" } }, { boxCount: 0 }, { boxCount: 1.5 }, { boxCount: 500 }]) {
    const r = await act(erp, "dispatch", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.code, "VALIDATION_ERROR");
  }
  assert.equal(mock.state.calls.length, before);
});

test("an opaque 500 from Rafttaar queues the dispatch; abandoning unblocks the order; a corrected retry then works", async () => {
  const { remote, erp } = await readyToDispatch();
  const { RafttaarClient } = await import("../src/integrations/rafttaar/client.js");
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, maxRetries: 0, sleep: async () => {} }));
  mock.failNext(new RegExp(`POST .*${remote.order.id}/dispatch`), { status: 500, times: 100, body: { statusCode: 500, message: "Internal Server Error" } });

  const r = await act(erp, "dispatch", { packages: { weightKg: 1 } });
  assert.equal(r.status, 202, r.text);
  const queued = await M.Action.findOne({ rafttaarOrderId: remote.order.id, type: "dispatch", status: "pending" });
  assert.equal(queued.lastError.httpStatus, 500);
  assert.equal((await act(erp, "dispatch")).json.code, "ACTION_IN_PROGRESS"); // order is blocked while it waits

  mock.state.failNext.length = 0;
  const ab = await call("POST", `/api/rafttaar/actions/${queued._id}/abandon`, {});
  assert.equal(ab.status, 200, ab.text);
  assert.equal(ab.json.data.outcome, "abandoned");
  const after = await M.Action.findById(queued._id);
  assert.equal(after.status, "failed");
  assert.equal(after.lastError.code, "ABANDONED");

  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
  assert.equal((await act(erp, "dispatch", { packages: { weightKg: 2 } })).status, 200);
  assert.equal((await erpOrderFor(remote.order.id)).status, "shipped");
});

test("abandon never causes a double booking: if the 'failed' attempt actually went through, it is recorded as done", async () => {
  const { remote, erp } = await readyToDispatch();
  const { RafttaarClient } = await import("../src/integrations/rafttaar/client.js");
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, maxRetries: 0, sleep: async () => {} }));
  // Rafttaar books the shipment but the response is lost (we see a 502)
  const rec = mock.state.orders.get(remote.order.id);
  mock.failNext(new RegExp(`POST .*${remote.order.id}/dispatch`), { status: 502, times: 100 });
  const r = await act(erp, "dispatch", {});
  assert.equal(r.status, 202);
  rec.lock.state = "dispatched";
  rec.shipment = { id: "11111111-1111-4111-8111-111111111111", awbNumber: "AWB1", status: "booked" };
  mock.state.failNext.length = 0;

  const queued = await M.Action.findOne({ rafttaarOrderId: remote.order.id, type: "dispatch", status: "pending" });
  const ab = await call("POST", `/api/rafttaar/actions/${queued._id}/abandon`, {});
  assert.equal(ab.json.data.outcome, "already_applied");
  assert.equal((await M.Action.findById(queued._id)).status, "succeeded");
  assert.equal((await erpOrderFor(remote.order.id)).rafttaar.fulfilmentState, "dispatched");
  assert.equal((await call("POST", `/api/rafttaar/actions/${queued._id}/abandon`, {})).json.code, "NOT_ABANDONABLE");
  M.config._setClientForTests(new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, ratePerSec: 1000, burst: 1000, sleep: async () => {} }));
});
