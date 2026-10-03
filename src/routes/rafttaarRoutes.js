import { Router } from "express";
import * as c from "../controllers/rafttaarController.js";

// Everything under /api/rafttaar — the ERP's own control surface for the
// integration. The browser calls THESE; only the backend ever calls Rafttaar.
const router = Router();

// connection + settings
router.get("/status", c.getStatus);
router.post("/connection/test", c.testConnection);
router.patch("/settings", c.patchSettings);

// sync (poll / reconcile) and the local event + action logs
router.post("/sync/poll", c.syncNow);
router.post("/sync/reconcile", c.syncReconcile);
router.post("/sync/bootstrap", c.syncBootstrap);
router.get("/events", c.listEvents);
router.post("/events/:id/retry", c.retryEvent);
router.get("/actions", c.listActions);
router.post("/actions/:id/retry", c.retryAction);

// webhooks
router.get("/webhooks", c.whList);
router.post("/webhooks/register", c.whRegister);
router.patch("/webhooks/:id", c.whUpdate);
router.delete("/webhooks/:id", c.whDelete);
router.post("/webhooks/:id/rotate-secret", c.whRotate);
router.post("/webhooks/:id/test-event", c.whTestEvent);
router.get("/webhooks/:id/deliveries", c.whDeliveries);
router.post("/webhooks/:id/deliveries/:deliveryId/resend", c.whResend);

// sandbox helpers (rtk_test_ keys only — Rafttaar answers SANDBOX_ONLY otherwise)
router.post("/sandbox/orders", c.sandboxCreateOrder);
router.post("/sandbox/shipments/:id/advance", c.sandboxAdvance);

// remote views
router.get("/remote/locations", c.locRemote);

export default router;
