import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import orderRoutes from "./routes/orderRoutes.js";
import rafttaarRoutes from "./routes/rafttaarRoutes.js";
import { inventoryRoutes, locationRoutes } from "./routes/masterDataRoutes.js";
import { invoicePdf } from "./controllers/rafttaarController.js";
import { receiveWebhook } from "./integrations/rafttaar/webhooks.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan("dev"));

// Rafttaar webhook receiver. It MUST be mounted before express.json(): the HMAC
// signature is computed over the exact bytes Rafttaar sent, and re-serialising a
// parsed body changes them. express.raw() hands the handler the untouched Buffer.
app.post("/webhooks/rafttaar", express.raw({ type: "*/*", limit: "1mb" }), receiveWebhook);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ success: true, message: "ERP backend is running", timestamp: new Date().toISOString() });
});

app.use("/api/orders", orderRoutes);
app.use("/api/rafttaar", rafttaarRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/inventory", inventoryRoutes);

// Public invoice PDFs: Rafttaar stores this URL and serves it back, so it has to be reachable without a login.
app.get("/invoices/:token", invoicePdf);

app.use(express.static(path.join(__dirname, "../public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.use(notFound);
app.use(errorHandler);

export default app;
