// Values below mirror openapi/partner-v1.yaml (the single source of truth for
// the Rafttaar Partner API). If the spec changes, change them here.

export const EVENT_TYPES = [
  "order.pushed",
  "order.updated",
  "order.cancelled",
  "order.recalled",
  "invoice.generated",
  "invoice.voided",
  "shipment.booked",
  "shipment.status_changed",
  "shipment.delivered",
  "shipment.failed",
  "inventory.rejected"
];

export const FULFILMENT_STATES = [
  "pushed",
  "acknowledged",
  "confirmed",
  "packaging",
  "delayed",
  "dispatched",
  "delivered",
  "cancelled",
  "recalled"
];

// Rafttaar fulfilment state -> the ERP's own (coarser) order status.
// The precise state is always kept in order.rafttaar.fulfilmentState.
export const ERP_STATUS_BY_FULFILMENT = {
  pushed: "pending",
  acknowledged: "confirmed",
  confirmed: "confirmed",
  packaging: "processing",
  delayed: "processing",
  dispatched: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
  recalled: "recalled"
};

// States in which the order is finished from the ERP's point of view.
export const TERMINAL_FULFILMENT_STATES = ["delivered", "cancelled", "recalled"];

export const ORDER_STATUS_ACTIONS = ["confirmed", "packaging", "delayed"];

export const SANDBOX_SHIPMENT_STATUSES = ["booked", "picked_up", "in_transit", "out_for_delivery", "delivered"];

export const MAX_WEBHOOKS = 3;
export const MAX_INVENTORY_ITEMS_PER_CALL = 500;
