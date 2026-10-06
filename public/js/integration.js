// Rafttaar integration UI. Loaded after app.js (shares $, api, apiRaw, escapeHtml, money, toast, openModal...).
// The browser only ever talks to THIS ERP's /api/rafttaar/* — never to Rafttaar directly.
// All dynamic values are passed through escapeHtml before they reach innerHTML.

const E = escapeHtml;
// Rafttaar issues every invoice, so the ERP no longer creates or voids its own. The backend routes and
// invoiceBuilder stay for sellers still on invoiceSource=erp; flip this to bring the UI back.
const INVOICE_CREATION_UI = false;

const when = (d) => (d ? new Date(d).toLocaleString("en-IN") : "—");
const kv = (label, value) => `<div class="detail-line"><span>${E(label)}</span>${value === undefined || value === null || value === "" ? "—" : E(value)}</div>`;

async function guarded(fn, { reload } = {}) {
  try {
    const out = await fn();
    if (reload) await reload();
    return out;
  } catch (error) {
    toast(error.pretty || error.message, "error");
    return null;
  }
}

// ============================================================ order panel (inside the order modal)

const TERMINAL = ["delivered", "cancelled", "recalled"];

async function mountRafttaarPanel(order, refreshModal) {
  const host = $("#rafttaarPanel");
  if (!host) return;
  let extras = { invoices: [], actions: [] };
  let locations = [];
  try {
    [extras, locations] = await Promise.all([api(`/orders/${order._id}/rafttaar`), api("/locations").catch(() => [])]);
  } catch (error) {
    host.innerHTML = `<div class="alert">${E(error.pretty || error.message)}</div>`;
    return;
  }

  const r = order.rafttaar || {};
  const state = r.fulfilmentState;
  const allowed = new Set(r.allowedActions || []);
  const sh = r.shipment || {};
  const activeInvoice = extras.invoices.find((i) => i.status === "active");
  const done = TERMINAL.includes(state);
  const btn = (id, label, cls = "secondary") => `<button class="${cls}" data-act="${id}">${E(label)}</button>`;

  const buttons = [];
  if (state === "pushed") buttons.push(btn("acknowledge", "Acknowledge", "primary"));
  if (!done && state !== "pushed") {
    if (allowed.has("confirmed")) buttons.push(btn("confirmed", "Confirm"));
    if (allowed.has("packaging")) buttons.push(btn("packaging", "Mark packaging"));
    if (allowed.has("delayed")) buttons.push(btn("delayed", "Mark delayed"));
    if (INVOICE_CREATION_UI) {
      if (!activeInvoice) buttons.push(btn("invoice", "Create invoice"));
      else if (!["dispatched", "delivered"].includes(state)) buttons.push(btn("void", "Void invoice"));
    }
    if (allowed.has("dispatched") || ["acknowledged", "confirmed", "packaging", "delayed"].includes(state)) buttons.push(btn("dispatch", "Dispatch", "primary"));
    if (allowed.has("cancelled")) buttons.push(btn("cancel", "Cancel order"));
  }
  buttons.push(btn("refresh", "Refresh from Rafttaar"));
  if (sh.id) buttons.push(btn("tracking", "Tracking"), btn("label", "Shipping label"));

  host.innerHTML = `
    <h3>Rafttaar</h3>
    <div class="detail-grid inner">
      <div>
        ${kv("Rafttaar order", r.displayCode)}
        ${kv("Fulfilment state", state)}
        ${kv("Platform status", r.platformStatus)}
        ${kv("ERP reference", r.erpReference)}
        ${state === "delayed" ? kv("Delay reason", r.delayReason) + kv("New ETA", when(r.newEta)) : ""}
        ${r.lastSyncError ? `<div class="alert inline">${E(r.lastSyncError)}</div>` : ""}
        ${r.isSandbox ? `<p class="sub">Sandbox order (rtk_test_) — dispatch is simulated with “Advance shipment”.</p>` : ""}
      </div>
      <div>
        ${kv("Invoice", r.invoice?.invoiceNumber ? `${r.invoice.invoiceNumber} (${r.invoice.status}${r.invoice.source ? `, ${r.invoice.source}` : ""})` : "none")}
        ${r.invoice?.pdfUrl ? `<div class="detail-line"><span>Invoice PDF</span><a href="${E(r.invoice.pdfUrl)}" target="_blank" rel="noopener">Open</a></div>` : ""}
        ${kv("AWB", sh.awbNumber)}
        ${kv("Courier", sh.courierName)}
        ${kv("Shipment status", sh.shipmentStatus || sh.bookingStatus)}
        ${kv("Last synced", when(r.lastSyncedAt))}
      </div>
    </div>
    ${extras.actions.filter((a) => a.status === "pending").map((a) => `<div class="alert inline">⏳ <b>${E(a.type)}</b> is waiting to be retried${a.lastError ? ` — Rafttaar answered ${E(a.lastError.code)}${a.lastError.httpStatus ? ` (HTTP ${E(a.lastError.httpStatus)})` : ""}` : ""}. Next try: ${E(when(a.nextRetryAt))}. It keeps its Idempotency-Key, so a retry can never double-act. If the input was wrong, abandon it and submit again.</div>`).join("")}
    <div class="actions left" id="rtActions">${buttons.join("")}</div>
    <div id="rtForm"></div>
    <div id="rtTracking"></div>
    <h3 style="margin-top:18px">Action history</h3>
    ${extras.actions.length ? `<table class="mini"><thead><tr><th>When</th><th>Action</th><th>Status</th><th>Detail</th><th></th></tr></thead><tbody>
      ${extras.actions.map((a) => `<tr><td>${E(when(a.createdAt))}</td><td>${E(a.type)}${a.payload?.status ? ` → ${E(a.payload.status)}` : ""}</td><td><span class="tag ${E(a.status)}">${E(a.status)}</span>${a.attempts > 1 ? ` <span class="sub">${E(a.attempts)} tries</span>` : ""}</td><td class="sub">${E(a.lastError ? `${a.lastError.code}: ${a.lastError.message}` : "")}</td><td>${["pending", "dead"].includes(a.status) ? `<button class="secondary sm danger" data-abandon="${E(a._id)}">Abandon</button>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<p class="sub">No actions yet.</p>`}
  `;

  const form = $("#rtForm");
  const post = (path, body) => apiRaw(`/orders/${order._id}/rafttaar/${path}`, { method: "POST", body: JSON.stringify(body || {}) });
  const run = async (path, body, okMsg) => {
    const out = await guarded(() => post(path, body));
    if (!out) return;
    toast(out.status === 202 ? "Saved — Rafttaar unreachable, will retry automatically" : okMsg, out.status === 202 ? "warn" : "ok");
    await refreshModal();
    loadOrders();
  };
  const showForm = (html, onSubmit) => {
    form.innerHTML = `<form class="form inline-form">${html}<div class="actions left"><button class="primary">Submit</button><button type="button" class="secondary" id="rtFormCancel">Close</button></div></form>`;
    $("#rtFormCancel").addEventListener("click", () => (form.innerHTML = ""));
    form.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await onSubmit(Object.fromEntries(new FormData(e.currentTarget)));
    });
  };

  const handlers = {
    acknowledge: () =>
      showForm(`<label class="field">Your ERP document / reference no. (optional)<input name="erpReference" placeholder="SO-2026-0001"></label>`, (f) =>
        run("acknowledge", { erpReference: f.erpReference }, "Order acknowledged")),
    confirmed: () => run("status", { status: "confirmed" }, "Order confirmed"),
    packaging: () => run("status", { status: "packaging" }, "Marked as packaging"),
    delayed: () =>
      showForm(
        `<label class="field full">Reason (shown to the buyer — write it for them)<input name="reason" required placeholder="Awaiting a restock"></label>
         <label class="field">New delivery estimate<input name="newEta" type="date"></label>`,
        (f) => run("status", { status: "delayed", reason: f.reason, newEta: f.newEta ? new Date(f.newEta).toISOString() : undefined }, "Marked delayed")
      ),
    cancel: () =>
      showForm(`<label class="field full">Reason<input name="reason" placeholder="Out of stock"></label>`, (f) => {
        if (confirm("Cancel this order on Rafttaar? The buyer will be notified and refunded.")) return run("cancel", { reason: f.reason }, "Order cancelled");
      }),
    invoice: () =>
      showForm(
        `<p class="sub full">Invoice lines and GST are taken from Rafttaar's own order totals (Rafttaar rejects anything that does not reconcile). Only usable when this seller's invoice source is the ERP.</p>
         <label class="field">Default HSN code<input name="hsn" placeholder="from settings"></label>
         <label class="field">Seller GSTIN<input name="sellerGstin" placeholder="from settings"></label>`,
        (f) => run("invoice", { hsn: f.hsn || undefined, sellerGstin: f.sellerGstin || undefined }, "Invoice issued")
      ),
    void: () =>
      showForm(`<label class="field full">Reason<input name="reason" placeholder="Corrected GST rate"></label>`, (f) => run("invoice/void", { reason: f.reason }, "Invoice voided")),
    dispatch: () =>
      showForm(
        `<label class="field">Pickup location<select name="locationExternalId"><option value="">Seller default</option>${locations
          .filter((l) => l.isActive && l.rafttaar?.id)
          .map((l) => `<option value="${E(l.externalId)}">${E(l.name)} (${E(l.rafttaar.carrierStatus || "?")})</option>`)
          .join("")}</select></label>
         <label class="field">Weight (kg)<input name="weightKg" type="number" step="0.1" min="0.1" placeholder="default"></label>
         <label class="field">Length (cm)<input name="lengthCm" type="number" min="1"></label>
         <label class="field">Width (cm)<input name="widthCm" type="number" min="1"></label>
         <label class="field">Height (cm)<input name="heightCm" type="number" min="1"></label>
         <label class="field">Boxes<input name="boxCount" type="number" min="1" value="1"></label>
         <label class="field full">E-way bill no. (required above ₹50,000)<input name="ewayBillNo"></label>`,
        (f) => {
          const packages = {};
          for (const k of ["weightKg", "lengthCm", "widthCm", "heightCm"]) if (f[k]) packages[k] = Number(f[k]);
          return run(
            "dispatch",
            { locationExternalId: f.locationExternalId || undefined, packages: Object.keys(packages).length ? packages : undefined, boxCount: Number(f.boxCount) || 1, ewayBillNo: f.ewayBillNo || undefined },
            "Shipment booked"
          );
        }
      ),
    refresh: async () => {
      if (await guarded(() => post("refresh"))) {
        toast("Refreshed from Rafttaar");
        await refreshModal();
        loadOrders();
      }
    },
    tracking: async () => {
      const s = await guarded(() => api(`/orders/${order._id}/rafttaar/shipment`));
      if (!s) return;
      $("#rtTracking").innerHTML = `<h3 style="margin-top:18px">Tracking · ${E(s.awbNumber || "AWB pending")}</h3>${(s.trackingHistory || [])
        .map((t) => `<div class="item"><div><strong>${E(t.label || t.status)}</strong></div><span class="sub">${E(when(t.occurredAt))}</span></div>`)
        .join("") || `<p class="sub">No tracking events yet.</p>`}`;
    },
    label: async () => {
      const out = await guarded(() => api(`/orders/${order._id}/rafttaar/shipment/label`));
      if (out?.labelUrl) window.open(out.labelUrl, "_blank", "noopener");
    }
  };
  $("#rtActions").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) handlers[b.dataset.act]?.();
  });
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-abandon]");
    if (!b) return;
    if (!confirm("Abandon this action? If Rafttaar already processed it, it will be recorded as done instead.")) return;
    const r = await guarded(() => api(`/rafttaar/actions/${b.dataset.abandon}/abandon`, { method: "POST", body: "{}" }));
    if (r) {
      toast(r.outcome === "already_applied" ? `Rafttaar already shows this order as ${r.state} — the earlier attempt went through.` : "Action abandoned — you can submit it again.", r.outcome === "already_applied" ? "warn" : "ok");
      await refreshModal();
      loadOrders();
    }
  });
}

// ============================================================ integration page

const itState = { data: null, tab: "overview" };

async function loadIntegration() {
  const body = $("#integrationBody");
  try {
    itState.data = await api("/rafttaar/status?live=true");
  } catch (error) {
    body.innerHTML = `<div class="alert">${E(error.pretty || error.message)}</div>`;
    return;
  }
  renderIntegration();
}

const TABS = [
  ["overview", "Overview"],
  ["webhooks", "Webhooks"],
  ["locations", "Locations"],
  ["inventory", "Inventory"],
  ["events", "Events"],
  ["actions", "Actions"],
  ["sandbox", "Sandbox"],
  ["settings", "Settings"]
];

function renderIntegration() {
  const body = $("#integrationBody");
  body.innerHTML = `
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${itState.tab === id ? "active" : ""}" data-tab="${id}">${E(label)}</button>`).join("")}</div>
    <div id="tabBody"></div>`;
  body.querySelector(".tabs").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]");
    if (!t) return;
    itState.tab = t.dataset.tab;
    renderIntegration();
  });
  runTab(itState.tab);
}

const tabBody = () => $("#tabBody");
// Fresh container per render: drops the previous render's click listeners so re-rendering a tab never stacks handlers.
function runTab(name) {
  const old = $("#tabBody");
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  return TAB_RENDERERS[name]();
}
const card = (title, inner, extra = "") => `<section class="card pad"><div class="card-title"><h2>${E(title)}</h2>${extra}</div>${inner}</section>`;

const TAB_RENDERERS = {
  overview() {
    const d = itState.data;
    const live = d.live;
    const who = live?.ok ? live.whoami : null;
    tabBody().innerHTML = `
      <div class="grid2">
        ${card("Connection", `
          ${kv("Configured", d.configured ? "yes" : "no — set RAFTTAAR_API_KEY / RAFTTAAR_BASE_URL")}
          ${kv("Environment", d.environment)}
          ${kv("API key", d.keyPreview)}
          ${kv("Base URL", d.baseUrl)}
          ${kv("Public URL of this ERP", d.publicBaseUrl || "not set (PUBLIC_BASE_URL) — needed for webhooks & invoice PDFs")}
          ${live && !live.ok ? `<div class="alert inline">${E(live.error?.code || "")}: ${E(live.error?.message || "")}</div>` : ""}
        `)}
        ${card("Linked seller", who ? `
          ${kv("Business", who.business?.name)}
          ${kv("Business code", who.business?.businessCode)}
          ${kv("Integration", `${who.integration?.erpName || "—"} (${who.integration?.status})`)}
          ${kv("Scopes", (who.apiKey?.scopes || []).join(", "))}
          ${kv("Rate limit", `${who.rateLimit?.limit}/s, burst ${who.rateLimit?.burst}`)}
          ${kv("Rafttaar health", live.status?.ok ? "ok" : "not ok")}
        ` : `<p class="sub">Not connected.</p>`)}
        ${card("Sync", `
          ${kv("Mode", d.sync.mode)}
          ${kv("Event cursor", d.sync.cursor)}
          ${kv("Last poll", `${when(d.sync.lastPollSuccessAt)}${d.sync.lastPollError ? ` — last error: ${d.sync.lastPollError}` : ""}`)}
          ${kv("Last webhook received", when(d.sync.lastWebhookAt))}
          ${kv("Last full reconcile", when(d.sync.lastReconcileAt))}
          ${kv("Background workers", d.workersEnabled ? "running" : "off")}
          <div class="actions left"><button class="secondary" id="itReconcile">Reconcile orders now</button><button class="secondary" id="itBootstrap" title="Skip event history and jump to the end of the log">Re-bootstrap</button></div>
        `)}
        ${card("Pipeline", `
          ${kv("Events", Object.entries(d.counts.eventsByStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet")}
          ${kv("Rafttaar orders", Object.entries(d.counts.ordersByFulfilmentState).map(([k, v]) => `${k}: ${v}`).join(", ") || "none yet")}
          ${kv("Actions waiting to retry", d.counts.pendingActions)}
          ${kv("Actions given up", d.counts.deadActions)}
        `)}
      </div>`;
    $("#itReconcile").addEventListener("click", () =>
      guarded(async () => { const s = await api("/rafttaar/sync/reconcile", { method: "POST", body: "{}" }); toast(`Reconciled: ${s.created} new, ${s.updated} updated, ${s.errors} errors`); }, { reload: loadIntegration }));
    $("#itBootstrap").addEventListener("click", () => {
      if (confirm("Skip all event history and start from the end of the log?")) guarded(() => api("/rafttaar/sync/bootstrap", { method: "POST", body: "{}" }).then(() => toast("Re-bootstrapped")), { reload: loadIntegration });
    });
  },

  async webhooks() {
    tabBody().innerHTML = `<div class="empty">Loading…</div>`;
    const wh = await guarded(() => api("/rafttaar/webhooks"));
    if (!wh) return;
    const d = itState.data;
    tabBody().innerHTML = `
      ${card("Sync mode", `
        <p class="sub">Rafttaar delivers events one of two ways — pick one. <b>Polling</b> asks Rafttaar for new events every ${E(d.sync.pollIntervalSec)}s. <b>Webhook</b> has Rafttaar call this ERP the moment something happens (needs a public https URL; a periodic reconcile still runs as a safety net).</p>
        <div class="toolbar flush"><select id="itMode">${["off", "polling", "webhook"].map((m) => `<option value="${m}" ${d.sync.mode === m ? "selected" : ""}>${m}</option>`).join("")}</select><button class="primary" id="itModeSave">Save mode</button></div>`)}
      ${card(`Webhooks on Rafttaar (${wh.webhooks.length}/${wh.limit})`, `
        ${wh.webhooks.length ? `<table class="mini"><thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Failures</th><th></th></tr></thead><tbody>
          ${wh.webhooks.map((w) => `<tr>
            <td>${E(w.url)} ${w.isOurs ? `<span class="tag">this ERP</span>` : `<span class="tag muted">external</span>`}</td>
            <td class="sub">${E((w.event_types || []).length)} types</td>
            <td><span class="tag ${E(w.status)}">${E(w.status)}</span></td>
            <td>${E(w.failure_count)}</td>
            <td class="row-actions">
              <button class="secondary sm" data-wh="test" data-id="${E(w.id)}">Test event</button>
              <button class="secondary sm" data-wh="deliveries" data-id="${E(w.id)}">Deliveries</button>
              <button class="secondary sm" data-wh="rotate" data-id="${E(w.id)}">Rotate secret</button>
              <button class="secondary sm" data-wh="${w.status === "active" ? "disable" : "enable"}" data-id="${E(w.id)}">${w.status === "active" ? "Pause" : "Resume"}</button>
              <button class="secondary sm danger" data-wh="delete" data-id="${E(w.id)}">Delete</button>
            </td></tr>`).join("")}
        </tbody></table>` : `<p class="sub">No webhooks registered.</p>`}
        ${wh.ours ? "" : `<div class="actions left"><button class="primary" id="whRegister">Register this ERP's webhook</button><span class="sub">URL: ${E(d.publicBaseUrl ? `${d.publicBaseUrl}/webhooks/rafttaar` : "set PUBLIC_BASE_URL first")}</span></div>`}
        <p class="sub">Webhooks marked “external” were created by someone else for this seller; they are shown, not managed, unless you click them.</p>
      `)}
      <div id="whDetail"></div>`;

    $("#itModeSave").addEventListener("click", () =>
      guarded(() => api("/rafttaar/settings", { method: "PATCH", body: JSON.stringify({ syncMode: $("#itMode").value }) }).then(() => toast("Sync mode saved")), { reload: loadIntegration }));
    $("#whRegister")?.addEventListener("click", () =>
      guarded(() => api("/rafttaar/webhooks/register", { method: "POST", body: "{}" }).then(() => toast("Webhook registered")), { reload: () => runTab("webhooks") }));

    tabBody().addEventListener("click", async (e) => {
      const b = e.target.closest("[data-wh]");
      if (!b) return;
      const id = b.dataset.id;
      const again = () => runTab("webhooks");
      switch (b.dataset.wh) {
        case "test":
          return guarded(() => api(`/rafttaar/webhooks/${id}/test-event`, { method: "POST", body: "{}" }).then(() => toast("Test event queued — check Deliveries")));
        case "deliveries": {
          const rows = await guarded(() => api(`/rafttaar/webhooks/${id}/deliveries`));
          if (!rows) return;
          $("#whDetail").innerHTML = card("Delivery log (30 days)", rows.length ? `<table class="mini"><thead><tr><th>#</th><th>Event</th><th>Attempt</th><th>Status</th><th>HTTP</th><th>Next retry</th><th></th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td>${E(r.eventNumber ?? "")}</td><td>${E(r.eventType || "")}</td><td>${E(r.attempt)}</td><td><span class="tag ${E(r.status)}">${E(r.status)}</span></td><td>${E(r.responseStatus ?? "—")}</td><td class="sub">${E(r.nextRetryAt ? when(r.nextRetryAt) : "—")}</td><td><button class="secondary sm" data-resend="${E(r.id)}" data-wid="${E(id)}">Resend</button></td></tr>`).join("")}</tbody></table>` : `<p class="sub">No deliveries yet.</p>`);
          return;
        }
        case "rotate":
          if (!confirm("Rotate the signing secret? The old one keeps working for 24h.")) return;
          return guarded(async () => {
            const r = await api(`/rafttaar/webhooks/${id}/rotate-secret`, { method: "POST", body: "{}" });
            toast(r.ours ? "Secret rotated and stored" : `Rotated. New secret (copy it now): ${r.secret}`, "ok");
          }, { reload: again });
        case "disable":
        case "enable":
          return guarded(() => api(`/rafttaar/webhooks/${id}`, { method: "PATCH", body: JSON.stringify({ status: b.dataset.wh === "disable" ? "disabled" : "active" }) }), { reload: again });
        case "delete":
          if (!confirm("Delete this webhook permanently?")) return;
          return guarded(() => api(`/rafttaar/webhooks/${id}`, { method: "DELETE" }), { reload: () => loadIntegration() });
      }
    });
    tabBody().addEventListener("click", (e) => {
      const b = e.target.closest("[data-resend]");
      if (b) guarded(() => api(`/rafttaar/webhooks/${b.dataset.wid}/deliveries/${b.dataset.resend}/resend`, { method: "POST", body: "{}" }).then(() => toast("Delivery re-queued")));
    });
  },

  async locations() {
    tabBody().innerHTML = `<div class="empty">Loading…</div>`;
    const locs = await guarded(() => api("/locations"));
    if (!locs) return;
    tabBody().innerHTML = `
      ${card("Warehouses / pickup locations", `
        <p class="sub">Your ERP's own warehouse codes. Saving also registers them with Rafttaar's carrier network; a location must reach <b>ready</b> before it can be used for dispatch. The carrier needs a contact email. (Note: Rafttaar only accepts location writes with a live key.)</p>
        ${locs.length ? `<table class="mini"><thead><tr><th>Code</th><th>Name</th><th>Address</th><th>Carrier</th><th></th></tr></thead><tbody>
          ${locs.map((l) => `<tr><td><b>${E(l.externalId)}</b>${l.isDefault ? ` <span class="tag">default</span>` : ""}${l.isActive ? "" : ` <span class="tag muted">inactive</span>`}</td><td>${E(l.name)}</td><td class="sub">${E(l.address.line1)}, ${E(l.address.city)} ${E(l.address.pincode)}</td>
          <td>${l.rafttaar?.carrierStatus ? `<span class="tag ${E(l.rafttaar.carrierStatus)}">${E(l.rafttaar.carrierStatus)}</span>` : `<span class="tag muted">not synced</span>`}${l.rafttaar?.carrierError ? `<div class="sub">${E(l.rafttaar.carrierError)}</div>` : ""}${l.rafttaar?.syncError ? `<div class="sub err">${E(l.rafttaar.syncError)}</div>` : ""}</td>
          <td class="row-actions"><button class="secondary sm" data-loc="sync" data-id="${E(l.externalId)}">Sync</button><button class="secondary sm danger" data-loc="deactivate" data-id="${E(l.externalId)}">Deactivate</button></td></tr>`).join("")}
        </tbody></table>` : `<p class="sub">No locations yet.</p>`}
        <div class="actions left"><button class="secondary" id="locRefresh">Refresh carrier status</button></div>`)}
      ${card("Add / update a location", `<form id="locForm" class="form"><div class="form-grid">
        <label class="field">Code (your warehouse code)<input name="externalId" required placeholder="WH-BLR-01"></label>
        <label class="field">Name<input name="name" required></label>
        <label class="field full">Address line 1<input name="line1" required></label>
        <label class="field">City<input name="city" required></label>
        <label class="field">State<input name="state" required></label>
        <label class="field">Pincode<input name="pincode" required></label>
        <label class="field">Contact name<input name="contactName"></label>
        <label class="field">Contact phone<input name="phone"></label>
        <label class="field">Contact email (needed by the carrier)<input name="email" type="email"></label>
        <label class="field">GSTIN<input name="gstin"></label>
        </div><div class="actions left"><button class="primary">Save &amp; sync</button></div></form>`)}`;
    $("#locForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      guarded(async () => {
        const r = await api(`/locations/${encodeURIComponent(f.externalId)}`, {
          method: "PUT",
          body: JSON.stringify({ name: f.name, address: { line1: f.line1, city: f.city, state: f.state, pincode: f.pincode }, contact: { name: f.contactName, phone: f.phone, email: f.email }, gstin: f.gstin })
        });
        toast(r.warning || "Location saved and synced", r.warning ? "warn" : "ok");
      }, { reload: () => runTab("locations") });
    });
    $("#locRefresh").addEventListener("click", () => guarded(() => api("/locations/refresh", { method: "POST", body: "{}" }).then(() => toast("Carrier status refreshed")), { reload: () => runTab("locations") }));
    tabBody().addEventListener("click", (e) => {
      const b = e.target.closest("[data-loc]");
      if (!b) return;
      const id = encodeURIComponent(b.dataset.id);
      if (b.dataset.loc === "deactivate" && !confirm("Deactivate this location? It can no longer be used for new dispatches.")) return;
      guarded(() => api(`/locations/${id}/${b.dataset.loc}`, { method: "POST", body: "{}" }).then(() => toast("Done")), { reload: () => runTab("locations") });
    });
  },

  async inventory() {
    tabBody().innerHTML = `<div class="empty">Loading…</div>`;
    const items = await guarded(() => api("/inventory"));
    if (!items) return;
    tabBody().innerHTML = `
      ${card("Stock", `
        <p class="sub">One row per SKU per warehouse — Rafttaar adds them up. The SKU must already exist in the seller's Rafttaar catalogue. Each row shows what Rafttaar answered for it. (Rafttaar only accepts inventory writes with a live key.)</p>
        ${items.length ? `<table class="mini"><thead><tr><th>SKU</th><th>Warehouse</th><th>Stock</th><th>Min</th><th>Rafttaar</th><th></th></tr></thead><tbody>
          ${items.map((i) => `<tr><td><b>${E(i.sku)}</b><div class="sub">${E(i.productName || "")}</div></td><td>${E(i.locationExternalId || "default")}</td><td>${E(i.stockQty)}</td><td>${E(i.minStockQty ?? "—")}</td>
            <td><span class="tag ${E(i.sync?.status)}">${E(i.sync?.status || "never")}</span>${i.sync?.message ? `<div class="sub">${E(i.sync.message)}</div>` : ""}</td>
            <td><button class="secondary sm danger" data-inv="${E(i._id)}">Remove</button></td></tr>`).join("")}</tbody></table>` : `<p class="sub">No stock rows yet.</p>`}
        <div class="actions left"><button class="primary" id="invSync">Sync all to Rafttaar</button></div>`)}
      ${card("Set stock", `<form id="invForm" class="form"><div class="form-grid">
        <label class="field">SKU<input name="sku" required></label>
        <label class="field">Product name<input name="productName"></label>
        <label class="field">Stock quantity<input name="stockQty" type="number" min="0" required></label>
        <label class="field">Low-stock threshold<input name="minStockQty" type="number" min="0"></label>
        <label class="field">Warehouse code (blank = default)<input name="locationExternalId"></label>
        </div><div class="actions left"><button class="primary">Save &amp; sync</button></div></form>`)}`;
    $("#invForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget));
      guarded(async () => {
        const r = await api("/inventory", { method: "PUT", body: JSON.stringify([f]) });
        toast(r.sync ? `Synced: ${r.sync.updated} updated, ${r.sync.rejected} rejected` : "Saved");
      }, { reload: () => runTab("inventory") });
    });
    $("#invSync").addEventListener("click", () => guarded(() => api("/inventory/sync", { method: "POST", body: "{}" }).then((s) => toast(`Synced: ${s.updated} updated, ${s.rejected} rejected`)), { reload: () => runTab("inventory") }));
    tabBody().addEventListener("click", (e) => {
      const b = e.target.closest("[data-inv]");
      if (b) guarded(() => api(`/inventory/${b.dataset.inv}`, { method: "DELETE" }), { reload: () => runTab("inventory") });
    });
  },

  async events() {
    tabBody().innerHTML = `<div class="empty">Loading…</div>`;
    const { events } = (await guarded(() => api("/rafttaar/events?limit=100"))) || {};
    if (!events) return;
    tabBody().innerHTML = card("Events received (poll + webhook)", events.length ? `<table class="mini"><thead><tr><th>Seq</th><th>Type</th><th>Via</th><th>Status</th><th>Note</th><th>When</th><th></th></tr></thead><tbody>
      ${events.map((v) => `<tr><td>${E(v.seq ?? "")}</td><td>${E(v.type)}</td><td>${E(v.source)}</td><td><span class="tag ${E(v.status)}">${E(v.status)}</span></td><td class="sub">${E(v.error || "")}</td><td class="sub">${E(when(v.occurredAt || v.createdAt))}</td>
      <td>${v.status === "failed" ? `<button class="secondary sm" data-ev="${E(v._id)}">Retry</button>` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="sub">No events yet.</p>`);
    tabBody().addEventListener("click", (e) => {
      const b = e.target.closest("[data-ev]");
      if (b) guarded(() => api(`/rafttaar/events/${b.dataset.ev}/retry`, { method: "POST", body: "{}" }).then((r) => toast(`Retry: ${r.outcome}`)), { reload: () => runTab("events") });
    });
  },

  async actions() {
    tabBody().innerHTML = `<div class="empty">Loading…</div>`;
    const { actions } = (await guarded(() => api("/rafttaar/actions?limit=100"))) || {};
    if (!actions) return;
    tabBody().innerHTML = card("Outbox — everything this ERP asked Rafttaar to do", actions.length ? `<table class="mini"><thead><tr><th>When</th><th>Order</th><th>Action</th><th>Status</th><th>Tries</th><th>Detail</th><th></th></tr></thead><tbody>
      ${actions.map((a) => `<tr><td class="sub">${E(when(a.createdAt))}</td><td class="sub">${E(a.rafttaarOrderId || "")}</td><td>${E(a.type)}${a.payload?.status ? ` → ${E(a.payload.status)}` : ""}</td><td><span class="tag ${E(a.status)}">${E(a.status)}</span></td><td>${E(a.attempts)}</td><td class="sub">${E(a.lastError ? `${a.lastError.code}: ${a.lastError.message}` : a.nextRetryAt && a.status === "pending" ? `retry ${when(a.nextRetryAt)}` : "")}</td>
      <td class="row-actions">${a.status === "dead" ? `<button class="secondary sm" data-act-retry="${E(a._id)}">Retry</button>` : ""}${["pending", "dead"].includes(a.status) ? ` <button class="secondary sm danger" data-act-abandon="${E(a._id)}">Abandon</button>` : ""}</td></tr>`).join("")}</tbody></table>
      <p class="sub">Each row carries its own Idempotency-Key, so a retry after a network failure can never double-book a shipment.</p>` : `<p class="sub">No actions yet.</p>`);
    tabBody().addEventListener("click", (e) => {
      const b = e.target.closest("[data-act-retry]");
      if (b) guarded(() => api(`/rafttaar/actions/${b.dataset.actRetry}/retry`, { method: "POST", body: "{}" }).then((r) => toast(`Retry: ${r.status}`)), { reload: () => runTab("actions") });
      const ab = e.target.closest("[data-act-abandon]");
      if (ab && confirm("Abandon this action? If Rafttaar already processed it, it will be recorded as done instead.")) {
        guarded(() => api(`/rafttaar/actions/${ab.dataset.actAbandon}/abandon`, { method: "POST", body: "{}" }).then((r) => toast(r.outcome === "already_applied" ? `Already applied on Rafttaar (${r.state})` : "Abandoned")), { reload: () => runTab("actions") });
      }
    });
  },

  sandbox() {
    const test = itState.data.environment === "test";
    tabBody().innerHTML = card("Sandbox (rtk_test_ keys only)", test ? `
      <p class="sub">Create a synthetic order (no buyer, no payment) that is pushed to this ERP just like a real one, then walk it through acknowledge → confirm → packaging in the Orders screen. Dispatch of a sandbox order is simulated with “Advance shipment”.</p>
      <div class="actions left"><button class="primary" id="sbOrder">Create sandbox order</button></div>
      <form id="sbForm" class="toolbar flush"><input name="id" placeholder="Sandbox order id (first call) or shipment id" style="width:420px" required><button class="secondary">Advance shipment</button></form>
      <div id="sbOut" class="sub"></div>` : `<p class="sub">Sandbox endpoints refuse live keys (SANDBOX_ONLY).</p>`);
    if (!test) return;
    $("#sbOrder").addEventListener("click", () => guarded(async () => {
      const r = await api("/rafttaar/sandbox/orders", { method: "POST", body: "{}" });
      $("#sbOut").textContent = `Created ${r.remote.displayCode} — id ${r.remote.id}`;
      toast("Sandbox order created and synced to Orders");
    }));
    $("#sbForm").addEventListener("submit", (e) => {
      e.preventDefault();
      guarded(async () => {
        const r = await api(`/rafttaar/sandbox/shipments/${encodeURIComponent(new FormData(e.currentTarget).get("id"))}/advance`, { method: "POST", body: "{}" });
        $("#sbOut").textContent = `Shipment ${r.id} is now ${r.status} (AWB ${r.awbNumber}). Use this shipment id for the next step.`;
        toast(`Shipment ${r.status}`);
      });
    });
  },

  settings() {
    const d = itState.data;
    const i = d.invoiceSettings || {};
    const s = d.dispatchDefaults || {};
    tabBody().innerHTML = `
      ${card("Polling", `<form id="setPoll" class="toolbar flush"><label class="field">Poll every (seconds)<input name="pollIntervalSec" type="number" min="2" max="3600" value="${E(d.sync.pollIntervalSec)}"></label><button class="primary">Save</button></form>`)}
      ${!INVOICE_CREATION_UI ? "" : card("Invoice defaults", `<form id="setInv" class="form"><div class="form-grid">
        <label class="field">Seller GSTIN<input name="sellerGstin" value="${E(i.sellerGstin)}"></label>
        <label class="field">Seller state (decides CGST+SGST vs IGST)<input name="sellerState" value="${E(i.sellerState)}"></label>
        <label class="field">Default HSN<input name="defaultHsn" value="${E(i.defaultHsn)}"></label>
        <label class="field">Fallback GST rate % (only if Rafttaar sends no GST breakdown)<input name="defaultGstRatePercent" type="number" min="0" max="100" value="${E(i.defaultGstRatePercent)}"></label>
        </div><div class="actions left"><button class="primary">Save</button></div></form>`)}
      ${card("Dispatch defaults", `<form id="setDisp" class="form"><div class="form-grid">
        <label class="field">Weight (kg)<input name="weightKg" type="number" step="0.1" value="${E(s.weightKg)}"></label>
        <label class="field">Length (cm)<input name="lengthCm" type="number" value="${E(s.lengthCm)}"></label>
        <label class="field">Width (cm)<input name="widthCm" type="number" value="${E(s.widthCm)}"></label>
        <label class="field">Height (cm)<input name="heightCm" type="number" value="${E(s.heightCm)}"></label>
        <label class="field">Boxes<input name="boxCount" type="number" min="1" value="${E(s.boxCount)}"></label>
        </div><div class="actions left"><button class="primary">Save</button></div></form>`)}`;
    const save = (formId, build) =>
      $(formId).addEventListener("submit", (e) => {
        e.preventDefault();
        guarded(() => api("/rafttaar/settings", { method: "PATCH", body: JSON.stringify(build(Object.fromEntries(new FormData(e.currentTarget)))) }).then(() => toast("Saved")), { reload: loadIntegration });
      });
    save("#setPoll", (f) => ({ pollIntervalSec: Number(f.pollIntervalSec) }));
    if (INVOICE_CREATION_UI) save("#setInv", (f) => ({ invoice: f }));
    save("#setDisp", (f) => ({ dispatchDefaults: f }));
  }
};

$("#itTest").addEventListener("click", () =>
  guarded(async () => {
    const r = await api("/rafttaar/connection/test", { method: "POST", body: "{}" });
    toast(`Connected to ${r.whoami.business?.name} (${r.whoami.apiKey?.environment} key)`);
  }));
$("#itPoll").addEventListener("click", () =>
  guarded(async () => {
    const r = await api("/rafttaar/sync/poll", { method: "POST", body: "{}" });
    toast(r.skipped ? `Skipped: ${r.skipped}` : `Fetched ${r.fetched} events (${r.processed} applied)`);
  }, { reload: () => (itState.data ? loadIntegration() : null) }));

if (location.hash === "#integration") showView("integration");
