import { Router } from "express";
import { createOrder, deleteOrder, getOrder, listOrders, updateOrder } from "../controllers/orderController.js";
import * as r from "../controllers/rafttaarController.js";

const router = Router();

router.get("/", listOrders);
router.post("/", createOrder);
router.get("/:id", getOrder);
router.patch("/:id", updateOrder);
router.delete("/:id", deleteOrder);

// Rafttaar order lifecycle (orders with source=rafttaar only).
router.get("/:id/rafttaar", r.orderDetailExtras);
router.post("/:id/rafttaar/refresh", r.orderRefresh);
router.post("/:id/rafttaar/acknowledge", r.orderAction("acknowledge"));
router.post("/:id/rafttaar/status", r.orderAction("status"));
router.post("/:id/rafttaar/cancel", r.orderAction("cancel"));
router.post("/:id/rafttaar/dispatch", r.orderAction("dispatch"));
router.post("/:id/rafttaar/invoice", r.invoiceCreate);
router.post("/:id/rafttaar/invoice/void", r.invoiceVoid);
router.get("/:id/rafttaar/invoice", r.invoiceFromRafttaar);
router.get("/:id/rafttaar/shipment", r.shipmentGet);
router.get("/:id/rafttaar/shipment/label", r.shipmentLabel);

export default router;
