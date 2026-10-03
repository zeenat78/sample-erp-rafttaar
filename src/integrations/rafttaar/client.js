import crypto from "node:crypto";
import { RafttaarApiError, RafttaarConfigError } from "./errors.js";

/**
 * Hand-written Rafttaar Partner API client (no SDK) — every operation in
 * openapi/partner-v1.yaml, with the cross-cutting rules the spec asks of an
 * integrator built in once, here, instead of at every call site:
 *
 *  - Bearer auth; `rtk_test_` / `rtk_live_` prefix decides the environment.
 *  - Every write carries an `Idempotency-Key`. A key is generated per logical
 *    call (or supplied by the caller, e.g. the outbox, so a retry days later
 *    still de-duplicates) and REUSED on every internal retry.
 *  - Client-side throttle (token bucket) kept under the key's rate limit
 *    (whoami: 10/s sustained, burst 20), plus 429 + Retry-After handling.
 *  - Retries only what is safe: network errors/timeouts, 408, 429, 5xx.
 *    4xx business errors (ORDER_NOT_ACKNOWLEDGED, INVALID_TRANSITION, ...) are
 *    final and surface as RafttaarApiError with the stable `code`.
 *  - Path params are encoded and "", ".", ".." are rejected (encoding alone
 *    does not stop `..`).
 */

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

class TokenBucket {
  constructor({ ratePerSec, burst, now = () => Date.now(), sleep = sleepDefault }) {
    this.rate = ratePerSec;
    this.capacity = burst;
    this.tokens = burst;
    this.last = now();
    this.now = now;
    this.sleep = sleep;
    this.queue = Promise.resolve();
  }

  // Serialised so concurrent callers cannot all grab the same token.
  take() {
    const run = async () => {
      for (;;) {
        const t = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
        this.last = t;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const date = Date.parse(value); // HTTP-date form
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const seg = (value, name) => {
  const s = String(value ?? "");
  if (s === "" || s === "." || s === "..") throw new RafttaarConfigError(`Invalid ${name}: "${s}"`);
  return encodeURIComponent(s);
};

export class RafttaarClient {
  constructor({
    apiKey,
    baseUrl,
    timeoutMs = 15_000,
    maxRetries = 3,
    ratePerSec = 8, // stay under the 10/s sustained limit
    burst = 10,
    maxRetryDelayMs = 30_000,
    fetchImpl = globalThis.fetch,
    sleep = sleepDefault,
    now = () => Date.now(),
    onRateLimit = null
  } = {}) {
    if (!apiKey) throw new RafttaarConfigError("RAFTTAAR_API_KEY is not configured");
    if (!/^rtk_(test|live)_/.test(apiKey)) throw new RafttaarConfigError("API key must start with rtk_test_ or rtk_live_");
    if (!baseUrl) throw new RafttaarConfigError("RAFTTAAR_BASE_URL is not configured");

    this.apiKey = apiKey;
    this.environment = apiKey.startsWith("rtk_live_") ? "live" : "test";
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.onRateLimit = onRateLimit;
    this.bucket = new TokenBucket({ ratePerSec, burst, now, sleep });
    this.lastRateLimit = null;
  }

  /**
   * Low-level call. Returns { status, body, headers }. Throws RafttaarApiError.
   * `idempotencyKey`: pass one to make a retry (even from a later process) safe;
   * otherwise one is minted per call for writes.
   */
  async request(method, path, { query, body, idempotencyKey, signal } = {}) {
    const isWrite = WRITE_METHODS.has(method);
    const key = isWrite ? idempotencyKey || crypto.randomUUID() : undefined;

    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (key) headers["Idempotency-Key"] = key;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new RafttaarApiError({ code: "ABORTED", message: "Request aborted by caller" });
      await this.bucket.take();

      let err;
      try {
        const res = await this._fetchOnce(url, { method, headers, body: payload, signal });
        this._captureRateLimit(res.headers);
        const parsed = await this._parse(res);
        if (res.status >= 200 && res.status < 300) {
          return { status: res.status, body: parsed, headers: res.headers };
        }
        err = this._toApiError(res, parsed);
      } catch (e) {
        if (e instanceof RafttaarApiError) throw e;
        if (signal?.aborted) throw new RafttaarApiError({ code: "ABORTED", message: "Request aborted by caller", cause: e });
        err = new RafttaarApiError({
          status: null,
          code: e?.name === "TimeoutError" || e?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
          message: e?.cause?.code ? `${e.message} (${e.cause.code})` : e?.message || "Network error",
          cause: e
        });
      }

      lastError = err;
      if (!err.retryable || attempt === this.maxRetries) throw err;
      await this.sleep(this._delay(attempt, err));
    }
    throw lastError;
  }

  async _fetchOnce(url, init) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return this.fetch(url, { ...init, signal, redirect: "manual" });
  }

  async _parse(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { __nonJson: true, raw: text.slice(0, 500) };
    }
  }

  _toApiError(res, parsed) {
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    if (parsed && !parsed.__nonJson && typeof parsed === "object") {
      return new RafttaarApiError({
        status: res.status,
        code: parsed.error || parsed.code,
        message: parsed.message,
        details: parsed.details,
        requestId: parsed.requestId,
        retryAfterMs
      });
    }
    // 3xx (we never follow redirects), HTML error pages from a proxy, etc.
    return new RafttaarApiError({
      status: res.status,
      code: res.status >= 300 && res.status < 400 ? "UNEXPECTED_REDIRECT" : "NON_JSON_RESPONSE",
      message: `Unexpected response (HTTP ${res.status})${parsed?.raw ? `: ${parsed.raw.slice(0, 120)}` : ""}`,
      retryAfterMs
    });
  }

  _captureRateLimit(headers) {
    const limit = headers.get("ratelimit-limit");
    if (limit == null) return;
    this.lastRateLimit = {
      limit: Number(limit),
      remaining: Number(headers.get("ratelimit-remaining")),
      resetSec: Number(headers.get("ratelimit-reset")),
      at: new Date().toISOString()
    };
    this.onRateLimit?.(this.lastRateLimit);
  }

  _delay(attempt, err) {
    const backoff = Math.min(this.maxRetryDelayMs, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
    const wait = err.retryAfterMs != null ? Math.max(err.retryAfterMs, 250) : backoff;
    return Math.min(wait, this.maxRetryDelayMs);
  }

  // ---------------------------------------------------------------- Meta
  async whoami() {
    return (await this.request("GET", "/whoami")).body.data;
  }
  async getStatus() {
    return (await this.request("GET", "/status")).body.data;
  }

  // -------------------------------------------------------------- Orders
  /** @returns {{data: object[], meta: {total:number, nextCursor:string|null}}} */
  async listOrders({ state, limit, cursor } = {}) {
    const { body } = await this.request("GET", "/orders", { query: { state, limit, cursor } });
    return { data: body.data ?? [], meta: body.meta ?? {} };
  }
  /** Walks every page (newest first). */
  async *iterateOrders({ state, limit = 100 } = {}) {
    let cursor;
    do {
      const page = await this.listOrders({ state, limit, cursor });
      for (const o of page.data) yield o;
      cursor = page.meta.nextCursor || null;
    } while (cursor);
  }
  async getOrder(orderId) {
    return (await this.request("GET", `/orders/${seg(orderId, "orderId")}`)).body.data;
  }
  async acknowledgeOrder(orderId, { erpReference } = {}, opts = {}) {
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/acknowledge`, {
        body: erpReference ? { erpReference } : {},
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }
  async updateOrderStatus(orderId, { status, reason, newEta }, opts = {}) {
    const body = { status };
    if (reason !== undefined && reason !== null && reason !== "") body.reason = reason;
    if (newEta !== undefined && newEta !== null && newEta !== "") body.newEta = newEta;
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/status`, { body, idempotencyKey: opts.idempotencyKey })
    ).body.data;
  }
  async cancelOrder(orderId, { reason } = {}, opts = {}) {
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/cancel`, {
        body: reason ? { reason } : {},
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }

  // ------------------------------------------------------------ Invoices
  async getInvoice(orderId) {
    return (await this.request("GET", `/orders/${seg(orderId, "orderId")}/invoice`)).body.data;
  }
  async createInvoice(orderId, invoice, opts = {}) {
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/invoice`, {
        body: invoice,
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }
  async getInvoicePdf(orderId) {
    return (await this.request("GET", `/orders/${seg(orderId, "orderId")}/invoice/pdf`)).body.data;
  }
  async voidInvoice(orderId, { reason } = {}, opts = {}) {
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/invoice/void`, {
        body: reason ? { reason } : {},
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }

  // ----------------------------------------------------------- Shipments
  async dispatchOrder(orderId, { locationId, packages, boxCount, ewayBillNo } = {}, opts = {}) {
    const body = {};
    if (locationId) body.locationId = locationId;
    if (packages) body.packages = packages;
    if (boxCount) body.boxCount = boxCount;
    if (ewayBillNo) body.ewayBillNo = ewayBillNo;
    return (
      await this.request("POST", `/orders/${seg(orderId, "orderId")}/dispatch`, { body, idempotencyKey: opts.idempotencyKey })
    ).body.data;
  }
  async getShipment(shipmentId) {
    return (await this.request("GET", `/shipments/${seg(shipmentId, "shipmentId")}`)).body.data;
  }
  async getShipmentLabel(shipmentId) {
    return (await this.request("GET", `/shipments/${seg(shipmentId, "shipmentId")}/label`)).body.data;
  }

  // ----------------------------------------------------------- Locations
  async upsertLocation(externalId, location, opts = {}) {
    return (
      await this.request("PUT", `/locations/${seg(externalId, "externalId")}`, {
        body: location,
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }
  async listLocations() {
    return (await this.request("GET", "/locations")).body.data ?? [];
  }
  async deactivateLocation(locationId, opts = {}) {
    return (
      await this.request("POST", `/locations/${seg(locationId, "locationId")}/deactivate`, {
        idempotencyKey: opts.idempotencyKey
      })
    ).body.data;
  }

  // ----------------------------------------------------------- Inventory
  /** items: [{ sku, locationId?, stockQty, minStockQty? }] (max 500). */
  async upsertInventory(items, opts = {}) {
    return (await this.request("PUT", "/inventory", { body: items, idempotencyKey: opts.idempotencyKey })).body.data;
  }

  // -------------------------------------------------------------- Events
  /** @returns {{data: object[], meta: {nextCursor:number}}} */
  async listEvents({ after, limit } = {}) {
    const { body } = await this.request("GET", "/events", { query: { after, limit } });
    return { data: body.data ?? [], meta: body.meta ?? {} };
  }

  // ------------------------------------------------------------ Webhooks
  async listWebhooks() {
    return (await this.request("GET", "/webhooks")).body.data ?? [];
  }
  /** The `secret` in the result is shown ONCE — the caller must store it. */
  async createWebhook({ url, eventTypes }, opts = {}) {
    return (await this.request("POST", "/webhooks", { body: { url, eventTypes }, idempotencyKey: opts.idempotencyKey })).body.data;
  }
  async updateWebhook(webhookId, patch, opts = {}) {
    return (
      await this.request("PATCH", `/webhooks/${seg(webhookId, "webhookId")}`, { body: patch, idempotencyKey: opts.idempotencyKey })
    ).body.data;
  }
  async deleteWebhook(webhookId) {
    return (await this.request("DELETE", `/webhooks/${seg(webhookId, "webhookId")}`)).body;
  }
  async rotateWebhookSecret(webhookId, opts = {}) {
    return (
      await this.request("POST", `/webhooks/${seg(webhookId, "webhookId")}/rotate-secret`, { idempotencyKey: opts.idempotencyKey })
    ).body.data;
  }
  async sendTestWebhookEvent(webhookId) {
    return (await this.request("POST", `/webhooks/${seg(webhookId, "webhookId")}/test-event`)).body.data;
  }
  async listWebhookDeliveries(webhookId) {
    return (await this.request("GET", `/webhooks/${seg(webhookId, "webhookId")}/deliveries`)).body.data ?? [];
  }
  async resendWebhookDelivery(webhookId, deliveryId) {
    return (
      await this.request("POST", `/webhooks/${seg(webhookId, "webhookId")}/deliveries/${seg(deliveryId, "deliveryId")}/resend`)
    ).body.data;
  }

  // ------------------------------------------------- Sandbox (rtk_test_ only)
  async createSandboxOrder(opts = {}) {
    return (await this.request("POST", "/sandbox/orders", { body: {}, idempotencyKey: opts.idempotencyKey })).body.data;
  }
  async advanceSandboxShipment(id) {
    return (await this.request("POST", `/sandbox/shipments/${seg(id, "id")}/advance`, { body: {} })).body.data;
  }
}
