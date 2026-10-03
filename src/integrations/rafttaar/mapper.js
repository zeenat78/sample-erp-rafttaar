import { ERP_STATUS_BY_FULFILMENT } from "./constants.js";

export const paiseToRupees = (paise) => Number((Number(paise || 0) / 100).toFixed(2));
export const rupeesToPaise = (rupees) => Math.round(Number(rupees || 0) * 100);

const str = (v, fallback = "") => (v === undefined || v === null || String(v).trim() === "" ? fallback : String(v).trim());
const date = (v) => (v ? new Date(v) : null);

export const erpStatusFor = (fulfilmentState) => ERP_STATUS_BY_FULFILMENT[fulfilmentState] || "pending";

export const isSandboxOrderId = (id) => String(id || "").startsWith("sandbox-");

/**
 * Rafttaar GET /orders/{id} (+ optionally the GET /orders list row, which also
 * carries placedAt and the full totals breakdown) -> the fields of an ERP Order.
 *
 * The address field set is only loosely specified ("full postal address"), so
 * this accepts both Rafttaar's `line1` and the ERP's own `addressLine1` and
 * never leaves a required ERP field empty.
 */
export function mapRemoteOrder(remote, listItem = null) {
  const addr = remote.deliveryAddress || {};
  const buyer = remote.buyer || {};
  const items = (remote.items || []).map((it) => ({
    productName: str(it.name, "Item"),
    sku: str(it.sku || it.productCode || ""),
    quantity: Number(it.quantity) || 1,
    price: paiseToRupees(it.unitPricePaise),
    lineId: str(it.lineId),
    productId: str(it.productId),
    unitPricePaise: Number(it.unitPricePaise) || 0
  }));

  const totals = { ...(listItem?.totals || {}), ...(remote.totals || {}) };
  const totalPaise =
    totals.totalPaise ?? items.reduce((sum, it) => sum + it.unitPricePaise * it.quantity, 0);

  return {
    orderId: str(remote.displayCode || listItem?.displayCode || remote.id),
    customer: {
      name: str(buyer.name || addr.name, "Rafttaar buyer"),
      phone: str(buyer.phone || addr.phone, "-"),
      email: str(addr.email || buyer.email)
    },
    items,
    totalAmount: paiseToRupees(totalPaise),
    status: erpStatusFor(remote.fulfilmentState),
    shippingAddress: {
      addressLine1: str(addr.line1 || addr.addressLine1, "-"),
      addressLine2: str(addr.line2 || addr.addressLine2),
      city: str(addr.city, "-"),
      state: str(addr.state, "-"),
      pincode: str(addr.pincode, "-"),
      country: str(addr.country, "India")
    },
    source: "rafttaar",
    rafttaar: {
      orderId: remote.id,
      displayCode: str(remote.displayCode || listItem?.displayCode),
      platformStatus: str(remote.platformStatus || listItem?.platformStatus),
      fulfilmentState: remote.fulfilmentState || listItem?.fulfilmentState,
      erpReference: remote.erpReference ?? listItem?.erpReference ?? null,
      allowedActions: remote.allowedActions || listItem?.allowedActions || [],
      totals: {
        currency: totals.currency || "INR",
        subtotalPaise: totals.subtotalPaise,
        gstPaise: totals.gstPaise,
        logisticsFeePaise: totals.logisticsFeePaise,
        totalPaise
      },
      buyer: { name: buyer.name || addr.name, phone: buyer.phone || addr.phone },
      placedAt: date(listItem?.placedAt),
      isSandbox: isSandboxOrderId(remote.id),
      lastSyncedAt: new Date(),
      lastSyncError: null
    },
    // Shipment is only present once dispatched; never overwrite a known shipment with null.
    shipment: remote.shipment || null
  };
}

/**
 * Flatten a mapped order into a Mongo $set using dotted paths, so syncing from
 * Rafttaar refreshes what Rafttaar owns without clobbering ERP-only data we
 * hold under rafttaar.* (our issued invoice, shipment label, timestamps).
 */
export function toSetOperator(mapped) {
  const { rafttaar, shipment, ...top } = mapped;
  const set = { ...top };
  for (const [k, v] of Object.entries(rafttaar)) {
    if (v === undefined) continue;
    if (k === "totals" || k === "buyer") {
      for (const [k2, v2] of Object.entries(v)) if (v2 !== undefined) set[`rafttaar.${k}.${k2}`] = v2;
    } else if (k === "placedAt" && !v) {
      continue; // keep the earlier placedAt when this sync had no list row
    } else {
      set[`rafttaar.${k}`] = v;
    }
  }
  if (shipment) {
    set["rafttaar.shipment.id"] = shipment.id;
    set["rafttaar.shipment.awbNumber"] = shipment.awbNumber ?? null;
    set["rafttaar.shipment.courierName"] = shipment.courierName ?? null;
    set["rafttaar.shipment.bookingStatus"] = shipment.bookingStatus ?? null;
  }
  return set;
}

/** OrderLock (snake_case, returned by every lifecycle write) -> dotted $set. */
export function lockToSet(lock) {
  const set = {
    "rafttaar.fulfilmentState": lock.fulfilment_state,
    status: erpStatusFor(lock.fulfilment_state),
    "rafttaar.erpReference": lock.erp_reference ?? null,
    "rafttaar.delayReason": lock.delayReason ?? null,
    "rafttaar.newEta": date(lock.newEta),
    "rafttaar.lastSyncedAt": new Date(),
    "rafttaar.lastSyncError": null
  };
  const times = {
    pushed_at: "pushedAt",
    acknowledged_at: "acknowledgedAt",
    dispatched_at: "dispatchedAt",
    delivered_at: "deliveredAt",
    recalled_at: "recalledAt"
  };
  for (const [from, to] of Object.entries(times)) if (lock[from]) set[`rafttaar.${to}`] = new Date(lock[from]);
  return set;
}
