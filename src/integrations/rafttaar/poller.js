import os from "node:os";
import { RafttaarSetting } from "../../models/RafttaarSetting.js";
import { getClient, getSettings, isConfigured, loadConfig } from "./config.js";
import { ingestEvent } from "./eventProcessor.js";
import { reconcileOrders } from "./orderSync.js";

/**
 * Event intake by polling GET /events, plus the safety net for webhook mode.
 *
 * Rules taken from the spec and from how real ERP connectors behave:
 *  - the resume position is ALWAYS the server's meta.nextCursor (also for an
 *    empty page), persisted in Mongo — a restart resumes exactly there;
 *  - the cursor never moves past an event we failed to apply (it is retried on
 *    the next tick; after MAX_EVENT_ATTEMPTS the event is parked as failed and
 *    skipped so one poison event cannot freeze the feed);
 *  - first connect = reconcile (GET /orders) and jump the cursor to the head of
 *    the log, instead of replaying months of history;
 *  - a Mongo lease so a local instance and the deployed one never poll at once.
 */

const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = 45_000;
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_TICK = 20;
const WEBHOOK_SAFETY_RECONCILE_MS = 15 * 60 * 1000;

let timer = null;
let started = false;
let inFlight = null;
let failures = 0;

const log = (...a) => console.log("[rafttaar:poller]", ...a);

async function acquireLease() {
  const now = new Date();
  const doc = await RafttaarSetting.findOneAndUpdate(
    { key: "rafttaar", $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }, { leaseOwner: INSTANCE_ID }] },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: INSTANCE_ID } },
    { new: true }
  );
  return Boolean(doc);
}

export async function releaseLease() {
  await RafttaarSetting.updateOne({ key: "rafttaar", leaseOwner: INSTANCE_ID }, { $set: { leaseUntil: null } });
}

/** Walk the log to its end without applying anything; returns the head cursor. */
async function findHeadCursor(client, from = 0) {
  let cursor = from;
  for (let i = 0; i < 1000; i++) {
    const page = await client.listEvents({ after: cursor, limit: PAGE_LIMIT });
    const next = Number(page.meta.nextCursor);
    if (!page.data.length) return Number.isFinite(next) ? Math.max(next, cursor) : cursor;
    cursor = Number.isFinite(next) ? next : page.data[page.data.length - 1].seq;
  }
  return cursor;
}

export async function bootstrap({ client = getClient() } = {}) {
  await getSettings(); // make sure the settings document exists before we write the cursor into it
  const head = await findHeadCursor(client, 0);
  const stats = await reconcileOrders({ client });
  await RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { cursor: head, bootstrappedAt: new Date() } });
  log(`bootstrapped: cursor=${head} reconcile=${JSON.stringify(stats)}`);
  return { cursor: head, reconcile: stats };
}

/** One pass over new events. Returns what happened. */
export async function pollOnce({ client = getClient() } = {}) {
  let settings = await getSettings();
  if (!settings.bootstrappedAt) {
    await bootstrap({ client });
    settings = await getSettings();
  }

  let cursor = settings.cursor || 0;
  const result = { fetched: 0, processed: 0, duplicates: 0, ignored: 0, failed: 0, cursor, stalled: false };

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const { data, meta } = await client.listEvents({ after: cursor, limit: PAGE_LIMIT });
    result.fetched += data.length;

    let stalled = false;
    let lastOk = cursor;
    for (const event of data) {
      const r = await ingestEvent(event, "poll", { client });
      if (r.outcome === "processed") result.processed++;
      else if (r.outcome === "duplicate") result.duplicates++;
      else if (r.outcome === "ignored") result.ignored++;
      else result.failed++;

      if (r.outcome === "failed" && !r.final) {
        stalled = true; // retry this event next tick; do not move past it
        break;
      }
      lastOk = Math.max(lastOk, Number(event.seq));
    }

    const next = Number(meta.nextCursor);
    cursor = stalled ? lastOk : Number.isFinite(next) ? Math.max(next, lastOk) : lastOk;
    await RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { cursor } });
    result.cursor = cursor;
    if (stalled) {
      result.stalled = true;
      break;
    }
    if (data.length < PAGE_LIMIT) break; // reached the end of the log
  }
  return result;
}

async function runTick({ force = false } = {}) {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return { skipped: "not_configured" };

  const settings = await getSettings();
  if (!force && settings.syncMode === "off") return { skipped: "sync_off" };
  if (!(await acquireLease())) return { skipped: "lease_held_elsewhere" };

  const client = getClient();
  try {
    let result;
    if (settings.syncMode === "polling" || force) {
      result = await pollOnce({ client });
    } else {
      // Webhook mode: webhooks are the feed; reconcile now and then in case one was missed.
      const last = settings.lastReconcileAt ? new Date(settings.lastReconcileAt).getTime() : 0;
      result = { skipped: "webhook_mode" };
      if (Date.now() - last > WEBHOOK_SAFETY_RECONCILE_MS) {
        result = { safetyReconcile: await reconcileOrders({ client, onlyActive: true }) };
      }
    }
    await RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { lastPollAt: new Date(), lastPollSuccessAt: new Date(), lastPollError: null } });
    failures = 0;
    return result;
  } catch (error) {
    failures++;
    await RafttaarSetting.updateOne(
      { key: "rafttaar" },
      { $set: { lastPollAt: new Date(), lastPollError: `${error.code || error.name}: ${error.message}`.slice(0, 300) } }
    );
    throw error;
  }
}

/** Run a tick now (used by the "Sync now" button). Never overlaps itself. */
export async function pollNow() {
  if (inFlight) return inFlight;
  inFlight = runTick({ force: true }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function loop() {
  let delay = 5_000;
  try {
    const settings = await getSettings();
    delay = (settings.pollIntervalSec || 10) * 1000;
    if (!inFlight) {
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
      await inFlight;
    }
  } catch (error) {
    log(`tick failed (${failures}x): ${error.message}`);
    delay = Math.min(60_000, delay * 2 ** Math.min(failures, 4));
    // A revoked/invalid key or a disabled integration will not fix itself in seconds — stop hammering the API.
    if ([401, 403].includes(error.status)) delay = 5 * 60_000;
  }
  if (started) timer = setTimeout(loop, delay);
}

export function startPoller() {
  if (started) return;
  started = true;
  log(`started (${INSTANCE_ID})`);
  timer = setTimeout(loop, 2_000);
}

export async function stopPoller() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    if (inFlight) await inFlight.catch(() => {});
    await releaseLease();
  } catch {
    /* shutting down */
  }
}
