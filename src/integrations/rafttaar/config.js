import { RafttaarClient } from "./client.js";
import { RafttaarConfigError } from "./errors.js";
import { RafttaarSetting } from "../../models/RafttaarSetting.js";

// Connection details come from the environment (.env locally, Render env vars
// when deployed) — never from Mongo and never from the browser.
export function loadConfig(env = process.env) {
  const apiKey = (env.RAFTTAAR_API_KEY || "").trim();
  return {
    apiKey,
    baseUrl: (env.RAFTTAAR_BASE_URL || "").trim().replace(/\/+$/, ""),
    environment: apiKey.startsWith("rtk_live_") ? "live" : apiKey.startsWith("rtk_test_") ? "test" : "unknown",
    // Public https origin of THIS service. Needed for the webhook URL we register
    // and for the invoice PDF URLs Rafttaar stores. ngrok URL locally, Render URL when deployed.
    publicBaseUrl: (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, ""),
    // Background workers (poller + outbox). Set RAFTTAAR_WORKERS=off to run the API only.
    workersEnabled: (env.RAFTTAAR_WORKERS || "on").toLowerCase() !== "off"
  };
}

export const isConfigured = (cfg = loadConfig()) => Boolean(cfg.apiKey && cfg.baseUrl);

export const maskedKey = (key) => (key ? `${key.slice(0, 9)}…${key.slice(-4)}` : null);

let cached = null;
let cachedFor = null;

/** Shared client (one token bucket for the whole process, so the rate limit holds). */
export function getClient() {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    throw new RafttaarConfigError("Rafttaar is not configured: set RAFTTAAR_API_KEY and RAFTTAAR_BASE_URL in the environment");
  }
  const sig = `${cfg.apiKey}|${cfg.baseUrl}`;
  if (!cached || cachedFor !== sig) {
    cached = new RafttaarClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    cachedFor = sig;
  }
  return cached;
}

// Test hook.
export function _setClientForTests(client) {
  cached = client;
  cachedFor = client ? `${loadConfig().apiKey}|${loadConfig().baseUrl}` : null;
}

export async function getSettings() {
  return RafttaarSetting.findOneAndUpdate({ key: "rafttaar" }, { $setOnInsert: { key: "rafttaar" } }, { upsert: true, new: true });
}

export async function updateSettings(patch) {
  await getSettings();
  return RafttaarSetting.findOneAndUpdate({ key: "rafttaar" }, { $set: patch }, { new: true });
}
