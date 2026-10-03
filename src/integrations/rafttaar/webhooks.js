import { RafttaarSetting } from "../../models/RafttaarSetting.js";
import { getClient, getSettings, loadConfig } from "./config.js";
import { EVENT_TYPES, MAX_WEBHOOKS } from "./constants.js";
import { ActionError } from "./actions.js";
import { ingestEvent } from "./eventProcessor.js";
import { SignatureError, verifyWebhookSignature } from "./signature.js";

export const WEBHOOK_PATH = "/webhooks/rafttaar";

export function webhookUrlFor(publicBaseUrl = loadConfig().publicBaseUrl) {
  return `${publicBaseUrl}${WEBHOOK_PATH}`;
}

const maskSecret = (s) => (s ? `${s.slice(0, 6)}…` : null);

/** What the UI is allowed to see about the webhook we registered (never the secret). */
export function describeOurWebhook(settings) {
  const w = settings.webhook;
  if (!w?.id) return null;
  return {
    id: w.id,
    url: w.url,
    eventTypes: w.eventTypes,
    status: w.status,
    registeredAt: w.registeredAt,
    secretPreview: maskSecret(w.secret),
    rotationGraceUntil: w.previousSecretExpiresAt && new Date(w.previousSecretExpiresAt) > new Date() ? w.previousSecretExpiresAt : null
  };
}

/**
 * Remote webhooks (all of them, max 3 per integration) with a flag for the one
 * THIS ERP owns. Webhooks created by someone else (e.g. a webhook.site test
 * endpoint) are shown but never touched unless the user acts on them.
 */
export async function listWebhooks({ client = getClient() } = {}) {
  const settings = await getSettings();
  const remote = await client.listWebhooks();
  return {
    limit: MAX_WEBHOOKS,
    ours: describeOurWebhook(settings),
    webhooks: remote.map((w) => ({ ...w, isOurs: w.id === settings.webhook?.id }))
  };
}

export async function registerWebhook({ url, eventTypes, client = getClient() } = {}) {
  const settings = await getSettings();
  if (settings.webhook?.id) {
    const remote = await client.listWebhooks();
    if (remote.some((w) => w.id === settings.webhook.id)) {
      throw new ActionError(409, "WEBHOOK_ALREADY_REGISTERED", "This ERP already has a registered Rafttaar webhook. Update or delete it first.");
    }
  }
  const finalUrl = url || (loadConfig().publicBaseUrl ? webhookUrlFor() : "");
  if (!/^https:\/\//.test(finalUrl)) {
    throw new ActionError(
      400,
      "PUBLIC_URL_REQUIRED",
      "A public https URL is required (Rafttaar rejects http/localhost). Set PUBLIC_BASE_URL (ngrok URL locally, Render URL when deployed) or pass `url`."
    );
  }
  const created = await client.createWebhook({ url: finalUrl, eventTypes: eventTypes?.length ? eventTypes : EVENT_TYPES });
  // The signing secret is returned exactly once — persist it immediately.
  await RafttaarSetting.updateOne(
    { key: "rafttaar" },
    {
      $set: {
        webhook: {
          id: created.id,
          url: created.url,
          secret: created.secret,
          eventTypes: created.event_types,
          status: created.status,
          registeredAt: new Date()
        }
      }
    }
  );
  return describeOurWebhook(await getSettings());
}

export async function rotateSecret(webhookId, { client = getClient() } = {}) {
  const settings = await getSettings();
  const ours = settings.webhook?.id === webhookId;
  const rotated = await client.rotateWebhookSecret(webhookId);
  if (ours) {
    // Rafttaar signs with BOTH secrets for 24h; keep the old one so deliveries in flight still verify.
    await RafttaarSetting.updateOne(
      { key: "rafttaar" },
      {
        $set: {
          "webhook.previousSecret": settings.webhook.secret,
          "webhook.previousSecretExpiresAt": new Date(Date.now() + 24 * 3600 * 1000),
          "webhook.secret": rotated.secret
        }
      }
    );
  }
  return { rotated: true, ours, note: ours ? "New secret stored; the old one stays valid for 24h." : "This webhook belongs to someone else — its new secret is NOT stored here and is lost unless you copy it from the response.", secret: ours ? undefined : rotated.secret };
}

export async function updateWebhook(webhookId, patch, { client = getClient() } = {}) {
  const updated = await client.updateWebhook(webhookId, patch);
  const settings = await getSettings();
  if (settings.webhook?.id === webhookId) {
    await RafttaarSetting.updateOne(
      { key: "rafttaar" },
      { $set: { "webhook.url": updated.url, "webhook.eventTypes": updated.event_types, "webhook.status": updated.status } }
    );
  }
  return updated;
}

export async function deleteWebhook(webhookId, { client = getClient() } = {}) {
  await client.deleteWebhook(webhookId);
  const settings = await getSettings();
  if (settings.webhook?.id === webhookId) {
    await RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { webhook: {}, ...(settings.syncMode === "webhook" ? { syncMode: "polling" } : {}) } });
  }
  return { deleted: true };
}

// -------------------------------------------------------------- receiving
export function candidateSecrets(settings, env = process.env) {
  const w = settings.webhook || {};
  const list = [w.secret, env.RAFTTAAR_WEBHOOK_SECRET];
  if (w.previousSecret && w.previousSecretExpiresAt && new Date(w.previousSecretExpiresAt) > new Date()) list.push(w.previousSecret);
  return list.filter(Boolean);
}

/**
 * Express handler for POST /webhooks/rafttaar. Mounted with express.raw() so
 * `req.body` is the exact byte string Rafttaar signed. Answers within the 10s
 * Rafttaar allows: 2xx = delivered, anything else = it retries with backoff.
 */
export async function receiveWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));
  const settings = await getSettings();

  try {
    verifyWebhookSignature(raw, req.get("Rafttaar-Signature"), candidateSecrets(settings));
  } catch (error) {
    if (!(error instanceof SignatureError)) throw error;
    return res.status(401).json({ success: false, code: "INVALID_SIGNATURE", message: error.message });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, code: "INVALID_JSON", message: "Body is not valid JSON" });
  }
  // The delivery headers duplicate the envelope; trust the signed body, fall back to headers.
  event.id = event.id || req.get("Rafttaar-Event-Id");
  event.type = event.type || req.get("Rafttaar-Event-Type");

  RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { lastWebhookAt: new Date() } }).catch(() => {});
  const result = await ingestEvent(event, "webhook");

  if (result.outcome === "failed" && !result.final) {
    // Let Rafttaar retry later; the poller/reconcile is the backstop.
    return res.status(500).json({ success: false, code: "PROCESSING_FAILED", message: "Temporary processing failure, please retry" });
  }
  return res.status(200).json({ success: true, outcome: result.outcome });
}
