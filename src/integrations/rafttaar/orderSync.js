import { Order } from "../../models/Order.js";
import { RafttaarSetting } from "../../models/RafttaarSetting.js";
import { getClient } from "./config.js";
import { lockToSet, mapRemoteOrder, toSetOperator, erpStatusFor } from "./mapper.js";

/**
 * Create-or-update the ERP copy of a Rafttaar order from Rafttaar's own state.
 * Idempotent by construction (keyed on rafttaar.orderId, unique index): a
 * replayed or out-of-order event just re-syncs to whatever Rafttaar says NOW,
 * which is why event handlers fetch state instead of applying diffs.
 */
export async function upsertOrderFromRemote(remote, { listItem = null, eventSeq = null } = {}) {
  const mapped = mapRemoteOrder(remote, listItem);
  const set = toSetOperator(mapped);
  if (eventSeq != null) set["rafttaar.lastEventSeq"] = eventSeq;

  return Order.findOneAndUpdate(
    { "rafttaar.orderId": remote.id },
    { $set: set },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}

export async function syncOrderById(rafttaarOrderId, { eventSeq = null, client = getClient() } = {}) {
  const remote = await client.getOrder(rafttaarOrderId);
  return upsertOrderFromRemote(remote, { eventSeq });
}

/** Apply an OrderLock (the result of acknowledge/status/cancel) to the local order. */
export async function applyLock(orderId, lock) {
  return Order.findByIdAndUpdate(orderId, { $set: lockToSet(lock) }, { new: true });
}

export async function markSyncError(rafttaarOrderId, message) {
  await Order.updateOne({ "rafttaar.orderId": rafttaarOrderId }, { $set: { "rafttaar.lastSyncError": String(message).slice(0, 500) } });
}

/**
 * Full reconcile against GET /orders — what a real ERP does on first connect
 * and after downtime / missed webhooks, because the event log is an
 * optimisation, while this list is the source of truth for "what do I hold".
 *  - orders we have never seen -> fetch full detail and create them;
 *  - orders we know -> refresh state/totals from the list row (no extra call)
 *    and only fetch detail if the state moved.
 * Returns counts for the UI/log.
 */
export async function reconcileOrders({ client = getClient(), onlyActive = false } = {}) {
  const stats = { seen: 0, created: 0, updated: 0, unchanged: 0, errors: 0 };

  for await (const row of client.iterateOrders({ limit: 100 })) {
    stats.seen++;
    if (onlyActive && ["delivered", "cancelled", "recalled"].includes(row.fulfilmentState)) {
      const known = await Order.exists({ "rafttaar.orderId": row.id, "rafttaar.fulfilmentState": row.fulfilmentState });
      if (known) {
        stats.unchanged++;
        continue;
      }
    }
    try {
      const local = await Order.findOne({ "rafttaar.orderId": row.id }).select("rafttaar.fulfilmentState rafttaar.erpReference").lean();
      if (!local) {
        const remote = await client.getOrder(row.id);
        await upsertOrderFromRemote(remote, { listItem: row });
        stats.created++;
      } else if (
        local.rafttaar?.fulfilmentState !== row.fulfilmentState ||
        (local.rafttaar?.erpReference ?? null) !== (row.erpReference ?? null)
      ) {
        const remote = await client.getOrder(row.id);
        await upsertOrderFromRemote(remote, { listItem: row });
        stats.updated++;
      } else {
        await Order.updateOne(
          { "rafttaar.orderId": row.id },
          {
            $set: {
              "rafttaar.allowedActions": row.allowedActions || [],
              "rafttaar.platformStatus": row.platformStatus,
              "rafttaar.totals.subtotalPaise": row.totals?.subtotalPaise,
              "rafttaar.totals.gstPaise": row.totals?.gstPaise,
              "rafttaar.totals.logisticsFeePaise": row.totals?.logisticsFeePaise,
              "rafttaar.totals.totalPaise": row.totals?.totalPaise,
              "rafttaar.lastSyncedAt": new Date()
            }
          }
        );
        stats.unchanged++;
      }
    } catch (error) {
      stats.errors++;
      await markSyncError(row.id, error.message).catch(() => {});
    }
  }

  await RafttaarSetting.updateOne({ key: "rafttaar" }, { $set: { lastReconcileAt: new Date() } });
  return stats;
}

export { erpStatusFor };
