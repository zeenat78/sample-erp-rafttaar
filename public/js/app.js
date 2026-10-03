const API_BASE_URL = ["localhost", "127.0.0.1"].includes(location.hostname) || location.hostname.endsWith(".ngrok-free.app") ? "" : "https://sample-erp-rafttaar.onrender.com";

const state = { orders: [], search: "", status: "", source: "" };

const $ = (selector) => document.querySelector(selector);

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Errors keep the backend's stable `code` (and, for Rafttaar refusals, `source`) so the UI can
// show "ORDER_NOT_ACKNOWLEDGED: ..." instead of a bare message.
class ApiError extends Error {
  constructor(payload, status) {
    super(payload.message || "Request failed");
    this.code = payload.code;
    this.source = payload.source;
    this.status = status;
    this.requestId = payload.requestId;
  }
  get pretty() {
    return `${this.code ? `${this.code}: ` : ""}${this.message}`;
  }
}

async function apiRaw(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}/api${path}`, {
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload, response.status);
  return { payload, status: response.status };
}

async function api(path, options = {}) {
  return (await apiRaw(path, options)).payload.data;
}

function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8000 : 3500);
}

function showError(message) {
  const el = $("#error");
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearError() {
  $("#error").classList.add("hidden");
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

function renderStats() {
  const orders = state.orders;
  const stat = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
  $("#stats").innerHTML = [
    stat("Total orders", orders.length),
    stat("Pending", orders.filter((o) => o.status === "pending").length),
    stat("Processing", orders.filter((o) => o.status === "processing").length),
    stat("Delivered", orders.filter((o) => o.status === "delivered").length)
  ].join("");
}

function renderOrders() {
  const body = $("#ordersBody");
  if (!state.orders.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty">No orders found.</td></tr>`;
    return;
  }

  body.innerHTML = state.orders.map((order) => `
    <tr class="order-row">
      <td><span class="order-link" data-id="${order._id}">${escapeHtml(order.orderId)}</span>${order.source === "rafttaar" ? ` <span class="tag">Rafttaar${order.rafttaar?.isSandbox ? " · sandbox" : ""}</span>` : ""}</td>
      <td><div class="customer-name">${escapeHtml(order.customer.name)}</div><div class="sub">${escapeHtml(order.customer.phone)}</div></td>
      <td>${order.items.reduce((sum, item) => sum + item.quantity, 0)}</td>
      <td><strong>${money(order.totalAmount)}</strong></td>
      <td><span class="badge ${order.status}">${cap(order.status)}</span>${order.rafttaar?.fulfilmentState && order.rafttaar.fulfilmentState !== order.status ? `<div class="sub">${escapeHtml(order.rafttaar.fulfilmentState)}</div>` : ""}</td>
      <td>${new Date(order.createdAt).toLocaleDateString("en-IN")}</td>
    </tr>
  `).join("");

  body.querySelectorAll(".order-link").forEach((el) => el.addEventListener("click", () => openOrder(el.dataset.id)));
}

async function loadOrders() {
  clearError();
  try {
    const params = new URLSearchParams();
    if (state.search) params.set("search", state.search);
    if (state.status) params.set("status", state.status);
    const data = await api(`/orders${params.toString() ? `?${params}` : ""}`);
    state.orders = state.source ? data.orders.filter((o) => (o.source || "manual") === state.source) : data.orders;
    renderStats();
    renderOrders();
  } catch (error) {
    showError(error.pretty || error.message);
  }
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modalBody").innerHTML = "";
}

function openModal(title, subtitle, body) {
  $("#modalTitle").textContent = title;
  $("#modalSubtitle").textContent = subtitle;
  $("#modalBody").innerHTML = body;
  $("#modal").classList.remove("hidden");
}

function openCreateOrder() {
  openModal("Create test order", "Creates an order directly in the ERP database (not sent to Rafttaar).", `
    <form id="orderForm" class="form">
      <div class="form-section"><h3>Customer</h3><div class="form-grid">
        <label class="field">Name<input name="customerName" required></label>
        <label class="field">Phone<input name="phone" required></label>
        <label class="field">Email<input name="email" type="email"></label>
      </div></div>
      <div class="form-section"><h3>Order item</h3><div class="form-grid">
        <label class="field">Product<input name="productName" required></label>
        <label class="field">SKU<input name="sku"></label>
        <label class="field">Quantity<input name="quantity" type="number" min="1" value="1" required></label>
        <label class="field">Unit price<input name="price" type="number" min="0" value="999" required></label>
      </div></div>
      <div class="form-section"><h3>Shipping address</h3><div class="form-grid">
        <label class="field full">Address<input name="addressLine1" required></label>
        <label class="field">City<input name="city" required></label>
        <label class="field">State<input name="state" required></label>
        <label class="field">Pincode<input name="pincode" required></label>
      </div></div>
      <div id="formError" class="alert hidden"></div>
      <div class="actions"><button type="button" class="secondary" id="cancelCreate">Cancel</button><button class="primary">Create order</button></div>
    </form>
  `);

  $("#cancelCreate").addEventListener("click", closeModal);
  $("#orderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      orderId: `ORD-${Date.now().toString().slice(-7)}`,
      customer: { name: form.get("customerName"), phone: form.get("phone"), email: form.get("email") },
      items: [{ productName: form.get("productName"), sku: form.get("sku"), quantity: Number(form.get("quantity")), price: Number(form.get("price")) }],
      shippingAddress: { addressLine1: form.get("addressLine1"), city: form.get("city"), state: form.get("state"), pincode: form.get("pincode"), country: "India" }
    };
    try {
      await api("/orders", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      await loadOrders();
    } catch (error) {
      const el = $("#formError");
      el.textContent = error.pretty || error.message;
      el.classList.remove("hidden");
    }
  });
}

async function openOrder(id) {
  try {
    const order = await api(`/orders/${id}`);
    const isRafttaar = order.source === "rafttaar";
    openModal(order.orderId, isRafttaar ? "Order received from Rafttaar" : "Order details", `
      <div class="detail-grid">
        <div class="detail-card">
          <h3>Items</h3>
          ${order.items.map((item) => `<div class="item"><div><strong>${escapeHtml(item.productName)}</strong><div class="sub">${escapeHtml(item.sku || "No SKU")} · Qty ${item.quantity}</div></div><strong>${money(item.quantity * item.price)}</strong></div>`).join("")}
          <div class="item"><strong>Total</strong><strong>${money(order.totalAmount)}</strong></div>
        </div>
        <div class="detail-card">
          <h3>Customer</h3>
          <div class="detail-line"><span>Name</span>${escapeHtml(order.customer.name)}</div>
          <div class="detail-line"><span>Phone</span>${escapeHtml(order.customer.phone)}</div>
          <div class="detail-line"><span>Email</span>${escapeHtml(order.customer.email || "—")}</div>
        </div>
        <div class="detail-card">
          <h3>Shipping address</h3>
          <div class="detail-line">${escapeHtml(order.shippingAddress.addressLine1)}</div>
          <div class="detail-line">${escapeHtml(order.shippingAddress.city)}, ${escapeHtml(order.shippingAddress.state)} ${escapeHtml(order.shippingAddress.pincode)}</div>
          <div class="detail-line">${escapeHtml(order.shippingAddress.country)}</div>
        </div>
        <div class="detail-card">
          <h3>Status</h3>
          ${isRafttaar
            ? `<span class="badge ${order.status}">${cap(order.status)}</span><p class="sub" style="margin-top:10px">Driven by Rafttaar — use the actions below.</p>`
            : `<select id="detailStatus">${["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"].map((s) => `<option value="${s}" ${s === order.status ? "selected" : ""}>${cap(s)}</option>`).join("")}</select>`}
          <div class="actions" style="margin-top:14px"><button class="secondary" id="deleteOrder">Delete</button></div>
        </div>
        ${isRafttaar ? `<div class="detail-card full" id="rafttaarPanel"><div class="empty">Loading Rafttaar details…</div></div>` : ""}
      </div>
    `);

    if (!isRafttaar) {
      $("#detailStatus").addEventListener("change", async (event) => {
        try {
          await api(`/orders/${id}`, { method: "PATCH", body: JSON.stringify({ status: event.target.value }) });
          await loadOrders();
        } catch (error) { showError(error.pretty || error.message); }
      });
    } else if (typeof mountRafttaarPanel === "function") {
      mountRafttaarPanel(order, () => openOrder(id));
    }

    $("#deleteOrder").addEventListener("click", async () => {
      if (!confirm(isRafttaar ? "Delete this order from the ERP? It stays on Rafttaar and will reappear on the next reconcile." : "Delete this order?")) return;
      try {
        await api(`/orders/${id}`, { method: "DELETE" });
        closeModal();
        await loadOrders();
      } catch (error) { showError(error.pretty || error.message); }
    });
  } catch (error) {
    showError(error.pretty || error.message);
  }
}

function showView(name) {
  const integration = name === "integration";
  $("#ordersView").classList.toggle("hidden", integration);
  $("#integrationView").classList.toggle("hidden", !integration);
  document.querySelectorAll(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  if (integration && typeof loadIntegration === "function") loadIntegration();
  if (!integration) loadOrders();
}

$("#newOrderBtn").addEventListener("click", openCreateOrder);
$("#closeModal").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (event) => { if (event.target.id === "modal") closeModal(); });
$("#searchInput").addEventListener("input", (event) => { state.search = event.target.value; loadOrders(); });
$("#statusFilter").addEventListener("change", (event) => { state.status = event.target.value; loadOrders(); });
$("#sourceFilter").addEventListener("change", (event) => { state.source = event.target.value; loadOrders(); });
window.addEventListener("hashchange", () => showView(location.hash === "#integration" ? "integration" : "orders"));
loadOrders();
