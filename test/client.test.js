import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { RafttaarClient, parseRetryAfter } from "../src/integrations/rafttaar/client.js";
import { RafttaarApiError } from "../src/integrations/rafttaar/errors.js";
import { startMockRafttaar } from "./helpers/mockRafttaar.js";

let mock;
const make = (over = {}) => new RafttaarClient({ apiKey: mock.apiKey, baseUrl: mock.baseUrl, sleep: async () => {}, ratePerSec: 1000, burst: 1000, ...over });
before(async () => {
  mock = await startMockRafttaar();
});
after(() => mock.close());

test("whoami with bearer auth; test key detected", async () => {
  const c = make();
  assert.equal(c.environment, "test");
  const w = await c.whoami();
  assert.equal(w.business.name, "Mock Seller");
  assert.equal(mock.state.calls.at(-1).headers.authorization, `Bearer ${mock.apiKey}`);
});

test("bad key -> RafttaarApiError with stable code, not retried", async () => {
  const c = new RafttaarClient({ apiKey: "rtk_test_wrong", baseUrl: mock.baseUrl, sleep: async () => {} });
  const before = mock.state.calls.length;
  await assert.rejects(c.whoami(), (e) => e instanceof RafttaarApiError && e.code === "INVALID_API_KEY" && e.status === 401 && !e.retryable);
  assert.equal(mock.state.calls.length - before, 1);
});

test("rejects bad configuration up front", () => {
  assert.throws(() => new RafttaarClient({ baseUrl: "x" }), /RAFTTAAR_API_KEY/);
  assert.throws(() => new RafttaarClient({ apiKey: "abc", baseUrl: "x" }), /rtk_/);
  assert.throws(() => new RafttaarClient({ apiKey: "rtk_test_x" }), /BASE_URL/);
});

test("every write carries an Idempotency-Key; reads do not", async () => {
  const c = make();
  const o = mock.addOrder();
  await c.getOrder(o.order.id);
  assert.equal(mock.state.calls.at(-1).headers["idempotency-key"], undefined);
  await c.acknowledgeOrder(o.order.id, { erpReference: "X" });
  assert.match(mock.state.calls.at(-1).headers["idempotency-key"], /^[0-9a-f-]{36}$/);
});

test("5xx is retried with the SAME idempotency key and the action happens once", async () => {
  const c = make();
  const o = mock.addOrder();
  mock.failNext(/POST .*acknowledge/, { status: 503, times: 2, code: "UNAVAILABLE" });
  const lock = await c.acknowledgeOrder(o.order.id, { erpReference: "R1" });
  assert.equal(lock.fulfilment_state, "acknowledged");
  const posts = mock.state.calls.filter((x) => x.method === "POST" && x.path.endsWith(`${o.order.id}/acknowledge`));
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((p) => p.headers["idempotency-key"])).size, 1);
});

test("replaying a key returns the stored result (no double action)", async () => {
  const c = make();
  const o = mock.addOrder();
  const key = "fixed-key-1";
  const a = await c.acknowledgeOrder(o.order.id, { erpReference: "R" }, { idempotencyKey: key });
  const b = await c.acknowledgeOrder(o.order.id, { erpReference: "R" }, { idempotencyKey: key });
  assert.equal(a.id, b.id);
  assert.equal(mock.state.events.filter((e) => e.data.orderId === o.order.id && e.type === "order.updated").length, 1);
});

test("business 4xx is final and carries the code", async () => {
  const c = make();
  const o = mock.addOrder();
  await assert.rejects(c.updateOrderStatus(o.order.id, { status: "confirmed" }), (e) => e.code === "ORDER_NOT_ACKNOWLEDGED" && e.status === 409 && !e.retryable);
});

test("429 honours Retry-After", async () => {
  const waits = [];
  const c = make({ sleep: async (ms) => waits.push(ms) });
  mock.failNext(/GET \/whoami/, { status: 429, code: "RATE_LIMITED", headers: { "Retry-After": "2" } });
  await c.whoami();
  assert.ok(waits[0] >= 2000, `waited ${waits[0]}`);
});

test("network failure is retried then surfaces as a retryable NETWORK_ERROR", async () => {
  const c = make({ maxRetries: 1 });
  mock.failNext(/GET \/whoami/, { destroy: true, times: 5 });
  await assert.rejects(c.whoami(), (e) => e.status === null && e.retryable && ["NETWORK_ERROR", "TIMEOUT"].includes(e.code));
  mock.state.failNext.length = 0;
});

test("request timeout is enforced", async () => {
  const c = make({ timeoutMs: 100, maxRetries: 0 });
  mock.failNext(/GET \/whoami/, { status: 200, delayMs: 400, body: { success: true, data: {} } });
  await assert.rejects(c.whoami(), (e) => e.code === "TIMEOUT");
});

test("path params are encoded; empty, '.' and '..' are refused before any request", async () => {
  const c = make();
  const before = mock.state.calls.length;
  for (const bad of ["", ".", ".."]) await assert.rejects(c.getOrder(bad), /Invalid orderId/);
  assert.equal(mock.state.calls.length, before);
  await assert.rejects(c.getOrder("a/b?c"), (e) => e.code === "NOT_FOUND");
  assert.equal(mock.state.calls.at(-1).path, "/orders/a%2Fb%3Fc");
});

test("a non-JSON gateway error becomes a typed error", async () => {
  const c = make({ maxRetries: 0 });
  mock.failNext(/GET \/whoami/, { status: 502, body: undefined });
  await assert.rejects(c.whoami(), (e) => e instanceof RafttaarApiError && e.status === 502);
});

test("client-side throttle spaces requests (token bucket)", async () => {
  const waits = [];
  let t = 0;
  const c = new RafttaarClient({
    apiKey: mock.apiKey,
    baseUrl: mock.baseUrl,
    ratePerSec: 2,
    burst: 2,
    now: () => t,
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    }
  });
  for (let i = 0; i < 5; i++) await c.whoami();
  assert.ok(waits.length >= 2, "must wait for tokens after the burst");
  assert.ok(waits.every((w) => w >= 400), "wait is about 1/rate");
});

test("order list pagination and events cursor (an empty page still carries a position)", async () => {
  const c = make();
  for (let i = 0; i < 5; i++) mock.addOrder();
  const seen = [];
  for await (const o of c.iterateOrders({ limit: 2 })) seen.push(o.id);
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.length >= 5);
  const page = await c.listEvents({ after: 0, limit: 2 });
  assert.equal(page.data.length, 2);
  assert.equal(page.meta.nextCursor, page.data[1].seq);
  const empty = await c.listEvents({ after: 99999 });
  assert.equal(empty.data.length, 0);
  assert.equal(empty.meta.nextCursor, 99999);
});

test("parseRetryAfter handles seconds, dates and junk", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("soon"), null);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000);
});
