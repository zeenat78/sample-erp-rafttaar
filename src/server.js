import "dotenv/config";
import app from "./app.js";
import { connectDatabase } from "./db.js";
import { startOutboxWorker, stopOutboxWorker } from "./integrations/rafttaar/actions.js";
import { isConfigured, loadConfig } from "./integrations/rafttaar/config.js";
import { startPoller, stopPoller } from "./integrations/rafttaar/poller.js";

const port = Number(process.env.PORT || 5000);

try {
  await connectDatabase();
  const server = app.listen(port, () => console.log(`ERP running at http://localhost:${port}`));

  const cfg = loadConfig();
  if (isConfigured(cfg) && cfg.workersEnabled) {
    startPoller(); // no-op while sync mode is "off" or "webhook"
    startOutboxWorker();
    console.log(`Rafttaar integration active (${cfg.environment} key)`);
  } else {
    console.log("Rafttaar integration idle (set RAFTTAAR_API_KEY + RAFTTAAR_BASE_URL, and leave RAFTTAAR_WORKERS unset/on)");
  }

  const shutdown = async () => {
    stopOutboxWorker();
    await stopPoller();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error("Failed to start ERP:", error);
  process.exit(1);
}
