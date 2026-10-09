import http from "node:http";
import crypto from "node:crypto";

/**
 * In-process stand-in for the Rafttaar Partner API (the subset of
 * openapi/partner-v1.yaml the ERP uses), including its business rules:
 * acknowledge-before-anything, idempotency keys, fulfilment state machine,
 * numbered event log, 429s on demand. Lets the integration be tested end to
 * end without the real API (and without needing a live key).
 */
export async function startMockRafttaar({ apiKey = "rtk_test_mockkey" } = {}) {
  const state = {
    orders: new Map(), // id -> { order, lock, invoice, shipment }
    events: [],
    seq: 0,
    idem: new Map(),
    locations: new Map(),
    webhooks: [],
    stock: new Map(),
    calls: [], // { method, path, headers, body }
    failNext: [], // [{ match: /regex on "METHOD path"/, status, body, times, delayMs }]
    invoiceSource: "erp"
  };

  const emit = (type, data) => {
    const ev = { id: crypto.randomUUID(), seq: ++state.seq, type, schemaVersion: 1, occurredAt: new Date().toISOString(), data };
    state.events.push(ev);
    return ev;
  };

  const lockView = (o) => ({
    id: o.lock.id,
    order_id: o.order.id,
    business_id: "biz-1",
    integration_id: "int-1",
    fulfilment_state: o.lock.state,
    erp_reference: o.lock.erpReference ?? null,
    pushed_at: o.lock.pushedAt,
    acknowledged_at: o.lock.acknowledgedAt ?? null,
    dispatched_at: o.lock.dispatchedAt ?? null,
    delivered_at: o.lock.deliveredAt ?? null,
    recalled_at: null,
    delayReason: o.lock.delayReason ?? null,
    newEta: o.lock.newEta ?? null
  });

  const orderView = (o) => ({
    ...o.order,
    fulfilmentState: o.lock.state,
    erpReference: o.lock.erpReference ?? null,
    allowedActions: allowed(o.lock.state),
    shipment: o.shipment ? { id: o.shipment.id, awbNumber: o.shipment.awbNumber, courierName: "MockCourier", bookingStatus: "booked" } : null
  });

  const listRow = (o) => ({
    id: o.order.id,
    displayCode: o.order.displayCode,
    placedAt: o.order.placedAt,
    platformStatus: "paid",
    fulfilmentState: o.lock.state,
    erpReference: o.lock.erpReference ?? null,
    allowedActions: allowed(o.lock.state),
    totals: o.totals
  });

  function allowed(s) {
    return { pushed: ["acknowledged", "recalled"], acknowledged: ["confirmed", "packaging", "delayed", "cancelled"], confirmed: ["packaging", "delayed", "cancelled"], packaging: ["delayed", "dispatched", "cancelled"], delayed: ["confirmed", "packaging", "cancelled"] }[s] || [];
  }

  function addOrder({ subtotalPaise = 500000, gstPaise = 90000, fulfilment = "pushed", id = `ord-${crypto.randomUUID()}`, items } = {}) {
    const lines = items || [{ lineId: `line-${crypto.randomUUID().slice(0, 8)}`, productId: "p1", name: "Widget", quantity: 2, unitPricePaise: subtotalPaise / 2 }];
    const o = {
      order: {
        id,
        displayCode: `ORD-${id.slice(-6).toUpperCase()}`,
        platformStatus: "paid",
        placedAt: new Date().toISOString(),
        items: lines,
        deliveryAddress: { name: "Buyer", line1: "1 Test St", city: "Bengaluru", state: "Karnataka", pincode: "560001", phone: "9000000000" },
        buyer: { name: "Buyer", phone: "9000000000" },
        totals: { currency: "INR", totalPaise: subtotalPaise + gstPaise }
      },
      lock: { id: crypto.randomUUID(), state: fulfilment, pushedAt: new Date().toISOString() },
      totals: { currency: "INR", subtotalPaise, gstPaise, logisticsFeePaise: 0, totalPaise: subtotalPaise + gstPaise }
    };
    state.orders.set(id, o);
    emit("order.pushed", { orderId: id, displayCode: o.order.displayCode });
    return o;
  }

  const err = (res, status, code, message = code) =>
    send(res, status, { success: false, statusCode: status, error: code, code, message, details: [], timestamp: new Date().toISOString(), requestId: crypto.randomUUID() });

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", "RateLimit-Limit": "20", "RateLimit-Remaining": "19", "RateLimit-Reset": "1", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }
  const ok = (res, data, status = 200, extra = {}) => send(res, status, { success: true, data, ...extra }, {});

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = undefined;
    }
    const url = new URL(req.url, "http://x");
    const base = "/api/v1/integrations-service/partner/v1";
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    const sig = `${req.method} ${path}`;
    state.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    if (req.headers.authorization !== `Bearer ${apiKey}`) return err(res, 401, "INVALID_API_KEY", "bad key");

    const fi = state.failNext.findIndex((f) => f.match.test(sig));
    if (fi >= 0) {
      const f = state.failNext[fi];
      if (--f.times <= 0) state.failNext.splice(fi, 1);
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.destroy) return req.socket.destroy();
      return send(res, f.status, f.body ?? { success: false, statusCode: f.status, error: f.code || "UPSTREAM", code: f.code || "UPSTREAM", message: "injected" }, f.headers || {});
    }

    // Idempotency for writes.
    const idemKey = req.headers["idempotency-key"];
    if (idemKey && req.method !== "GET") {
      const k = `${idemKey}`;
      const prev = state.idem.get(k);
      if (prev) {
        if (prev.bodyHash !== raw) return err(res, 409, "IDEMPOTENCY_KEY_REUSED");
        return send(res, prev.status, prev.body);
      }
      const origSend = res.end.bind(res);
      res.end = (payload) => {
        if (res.statusCode < 500) state.idem.set(k, { bodyHash: raw, status: res.statusCode, body: payload ? JSON.parse(payload) : undefined });
        return origSend(payload);
      };
    }

    let m;
    if (sig === "GET /whoami") {
      return ok(res, { business: { id: "biz-1", name: "Mock Seller" }, integration: { id: "int-1", erpName: "MockERP", status: "active", syncMode: "polling" }, apiKey: { environment: apiKey.startsWith("rtk_live_") ? "live" : "test", scopes: ["orders:read", "orders:write"] }, rateLimit: { limit: 10, burst: 20, remaining: 19 } });
    }
    if (sig === "GET /status") return ok(res, { ok: true, integration: { status: "active" }, webhooks: { delivered: 0, pending: 0, failed: 0, failureRate: 0 }, rateLimit: { limit: 20, remaining: 19, perSecond: 10 } });

    if (sig === "GET /orders") {
      const all = [...state.orders.values()].reverse().filter((o) => !url.searchParams.get("state") || o.lock.state === url.searchParams.get("state"));
      const limit = Number(url.searchParams.get("limit") || 20);
      const start = Number(url.searchParams.get("cursor") || 0);
      const page = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return ok(res, page.map(listRow), 200, { meta: { total: all.length, nextCursor: next } });
    }
    if ((m = path.match(/^\/orders\/([^/]+)(\/.*)?$/))) {
      const o = state.orders.get(decodeURIComponent(m[1]));
      if (!o) return err(res, 404, "NOT_FOUND");
      const sub = m[2] || "";
      if (req.method === "GET" && sub === "") return ok(res, orderView(o));
      const need = (s) => o.lock.state === "recalled" ? "ORDER_RECALLED" : o.lock.state === "pushed" && s !== "ack" ? "ORDER_NOT_ACKNOWLEDGED" : null;

      if (req.method === "POST" && sub === "/acknowledge") {
        if (o.lock.state !== "pushed") return err(res, 409, "INVALID_TRANSITION");
        o.lock.state = "acknowledged";
        o.lock.acknowledgedAt = new Date().toISOString();
        o.lock.erpReference = body?.erpReference ?? null;
        emit("order.updated", { orderId: o.order.id, fulfilmentState: "acknowledged", reason: null, newEta: null });
        return ok(res, lockView(o));
      }
      if (req.method === "POST" && sub === "/status") {
        const e = need("x");
        if (e) return err(res, 409, e);
        if (!["confirmed", "packaging", "delayed"].includes(body?.status)) return err(res, 400, "VALIDATION_ERROR");
        if (body.status === "delayed" && !body.reason) return err(res, 400, "VALIDATION_ERROR", "reason required");
        if (body.newEta && body.status !== "delayed") return err(res, 400, "VALIDATION_ERROR");
        if (!allowed(o.lock.state).includes(body.status)) return err(res, 409, "INVALID_TRANSITION");
        o.lock.state = body.status;
        o.lock.delayReason = body.reason ?? null;
        o.lock.newEta = body.newEta ?? null;
        emit("order.updated", { orderId: o.order.id, fulfilmentState: body.status, reason: body.reason ?? null, newEta: body.newEta ?? null });
        return ok(res, lockView(o));
      }
      if (req.method === "POST" && sub === "/cancel") {
        const e = need("x");
        if (e) return err(res, 409, e);
        if (!allowed(o.lock.state).includes("cancelled")) return err(res, 409, "INVALID_TRANSITION");
        o.lock.state = "cancelled";
        emit("order.cancelled", { orderId: o.order.id, reason: body?.reason ?? null });
        return ok(res, lockView(o));
      }
      if (sub === "/invoice" && req.method === "POST") {
        const e = need("x");
        if (e) return err(res, 409, e);
        if (state.invoiceSource !== "erp") return err(res, 409, "INVOICE_LOCKED");
        if (o.invoice && o.invoice.status === "active") return err(res, 409, "INVOICE_ALREADY_EXISTS");
        const taxable = body.lines.reduce((a, l) => a + l.taxableValuePaise, 0);
        const tax = body.lines.reduce((a, l) => a + l.cgstPaise + l.sgstPaise + l.igstPaise + l.cessPaise, 0);
        if (taxable !== o.totals.subtotalPaise || tax !== o.totals.gstPaise) return err(res, 409, "INVOICE_TOTAL_MISMATCH");
        if (!/^https:\/\//.test(body.pdf || "")) return err(res, 400, "VALIDATION_ERROR", "pdf must be https");
        o.invoice = { id: crypto.randomUUID(), order_id: o.order.id, invoice_number: body.invoiceNumber, status: "active", pdf_url: body.pdf, lines: body.lines, taxable_value_paise: taxable, tax_paise: tax, grand_total_paise: taxable + tax };
        emit("invoice.generated", { orderId: o.order.id, invoiceId: o.invoice.id, invoiceNumber: body.invoiceNumber });
        return ok(res, o.invoice, 201);
      }
      if (sub === "/invoice" && req.method === "GET") return o.invoice ? ok(res, o.invoice) : err(res, 404, "NOT_FOUND");
      if (sub === "/invoice/pdf") return o.invoice ? ok(res, { pdfUrl: o.invoice.pdf_url }) : err(res, 404, "NOT_FOUND");
      if (sub === "/invoice/void" && req.method === "POST") {
        if (o.shipment) return err(res, 409, "INVOICE_LOCKED");
        if (!o.invoice) return err(res, 404, "NOT_FOUND");
        o.invoice.status = "voided";
        emit("invoice.voided", { orderId: o.order.id, invoiceId: o.invoice.id, reason: body?.reason ?? null });
        return ok(res, o.invoice);
      }
      if (sub === "/dispatch" && req.method === "POST") {
        const e = need("x");
        if (e) return err(res, 409, e);
        if (o.shipment) return err(res, 409, "SHIPMENT_ALREADY_BOOKED");
        if (state.invoiceSource === "erp" && !(o.invoice?.status === "active")) return err(res, 409, "INVOICE_REQUIRED");
        if (o.totals.totalPaise > 5000000 && !body?.ewayBillNo) return err(res, 400, "EWAY_BILL_REQUIRED");
        if (!allowed(o.lock.state).includes("dispatched")) return err(res, 409, "INVALID_TRANSITION");
        o.shipment = { id: crypto.randomUUID(), awbNumber: "AWB" + Math.floor(Math.random() * 1e6), status: "booked" };
        o.lock.state = "dispatched";
        o.lock.dispatchedAt = new Date().toISOString();
        emit("shipment.booked", { orderId: o.order.id, shipmentId: o.shipment.id, awbNumber: o.shipment.awbNumber, courierName: "MockCourier" });
        return ok(res, { shipmentId: o.shipment.id, carrierShipmentId: "c-1", awbNumber: o.shipment.awbNumber, courierName: "MockCourier", bookingStatus: "booked", fulfilmentState: "dispatched" }, 201);
      }
    }
    if ((m = path.match(/^\/shipments\/([^/]+)(\/label)?$/))) {
      const o = [...state.orders.values()].find((x) => x.shipment?.id === m[1]);
      if (!o) return err(res, 404, "NOT_FOUND");
      if (m[2]) return ok(res, { labelUrl: "https://labels.example/x.pdf" });
      return ok(res, { id: o.shipment.id, orderId: o.order.id, awbNumber: o.shipment.awbNumber, courierName: "MockCourier", bookingStatus: "booked", shipmentStatus: o.shipment.status, trackingHistory: [{ status: "booked", label: "Booked", occurredAt: new Date().toISOString() }] });
    }

    if ((m = path.match(/^\/locations\/([^/]+)$/)) && req.method === "PUT") {
      const ext = decodeURIComponent(m[1]);
      const cur = state.locations.get(ext);
      const loc = { id: cur?.id || crypto.randomUUID(), externalId: ext, name: body.name, address: body.address, contact: body.contact || {}, gstin: body.gstin ?? null, isDefault: cur?.isDefault ?? state.locations.size === 0, isActive: true, carrierStatus: "pending", carrierError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.locations.set(ext, loc);
      return ok(res, loc);
    }
    if (sig === "GET /locations") return ok(res, [...state.locations.values()]);
    if ((m = path.match(/^\/locations\/([^/]+)\/deactivate$/))) {
      const loc = [...state.locations.values()].find((l) => l.id === m[1]);
      if (!loc) return err(res, 404, "NOT_FOUND");
      loc.isActive = false;
      return ok(res, loc);
    }

    if (sig === "PUT /inventory") {
      const results = body.map((it) => (it.sku.startsWith("BAD") ? { sku: it.sku, status: "not_found" } : it.sku.startsWith("WH") ? { sku: it.sku, status: "warehouse_managed" } : (state.stock.set(it.sku, it.stockQty), { sku: it.sku, status: "updated", stockQty: it.stockQty, minStockQty: it.minStockQty ?? null })));
      return ok(res, { results, updatedCount: results.filter((r) => r.status === "updated").length, rejectedCount: results.filter((r) => r.status !== "updated").length });
    }

    if (sig === "GET /events") {
      const after = Number(url.searchParams.get("after") || 0);
      const limit = Number(url.searchParams.get("limit") || 50);
      const data = state.events.filter((e) => e.seq > after).slice(0, limit);
      const nextCursor = data.length ? data[data.length - 1].seq : Math.max(after, 0);
      return ok(res, data, 200, { meta: { nextCursor } });
    }

    if (sig === "GET /webhooks") return ok(res, state.webhooks.map(({ secret, ...w }) => w));
    if (sig === "POST /webhooks") {
      if (state.webhooks.length >= 3) return err(res, 409, "WEBHOOK_LIMIT_REACHED");
      if (!/^https:\/\//.test(body.url || "")) return err(res, 400, "VALIDATION_ERROR", "https only");
      const w = { id: crypto.randomUUID(), integration_id: "int-1", url: body.url, secret: `whsec_${crypto.randomBytes(8).toString("hex")}`, event_types: body.eventTypes, status: "active", failure_count: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      state.webhooks.push(w);
      return ok(res, w, 201);
    }
    if ((m = path.match(/^\/webhooks\/([^/]+)(\/[^/]+)?$/))) {
      const w = state.webhooks.find((x) => x.id === m[1]);
      if (!w) return err(res, 404, "NOT_FOUND");
      if (req.method === "DELETE") {
        state.webhooks.splice(state.webhooks.indexOf(w), 1);
        return ok(res, {});
      }
      if (req.method === "PATCH") return ok(res, Object.assign(w, body));
      if (m[2] === "/rotate-secret") {
        w.secret = `whsec_${crypto.randomBytes(8).toString("hex")}`;
        return ok(res, w);
      }
    }

    if (sig === "POST /sandbox/orders") {
      if (!apiKey.startsWith("rtk_test_")) return err(res, 403, "SANDBOX_ONLY");
      const o = addOrder({ subtotalPaise: 500000, gstPaise: 0, id: `sandbox-${crypto.randomUUID()}` });
      return ok(res, orderView(o), 201);
    }
    return err(res, 404, "NOT_FOUND", `mock has no route for ${sig}`);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/integrations-service/partner/v1`;
  return {
    baseUrl,
    apiKey,
    state,
    addOrder,
    emit,
    lockView,
    close: () => new Promise((r) => server.close(r)),
    failNext: (match, opts) => state.failNext.push({ match, times: 1, ...opts })
  };
}
