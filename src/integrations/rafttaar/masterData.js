import { InventoryItem } from "../../models/InventoryItem.js";
import { Location } from "../../models/Location.js";
import { getClient } from "./config.js";
import { MAX_INVENTORY_ITEMS_PER_CALL } from "./constants.js";
import { RafttaarApiError } from "./errors.js";

// ===================================================================== locations

const toApiLocation = (loc) => ({
  name: loc.name,
  address: {
    line1: loc.address.line1,
    ...(loc.address.line2 ? { line2: loc.address.line2 } : {}),
    city: loc.address.city,
    state: loc.address.state,
    pincode: loc.address.pincode,
    country: loc.address.country || "India"
  },
  contact: {
    ...(loc.contact?.name ? { name: loc.contact.name } : {}),
    ...(loc.contact?.phone ? { phone: loc.contact.phone } : {}),
    ...(loc.contact?.email ? { email: loc.contact.email } : {})
  },
  ...(loc.gstin ? { gstin: loc.gstin } : {}),
  isDefault: Boolean(loc.isDefault)
});

const applyRemoteLocation = (remote) => ({
  "rafttaar.id": remote.id,
  "rafttaar.carrierStatus": remote.carrierStatus,
  "rafttaar.carrierError": remote.carrierError ?? null,
  "rafttaar.isDefault": remote.isDefault,
  "rafttaar.isActive": remote.isActive,
  "rafttaar.syncedAt": new Date(),
  "rafttaar.syncError": null
});

/**
 * PUT /locations/{externalId}: safe to repeat — the same ERP warehouse code always
 * updates the same Rafttaar location. The save always succeeds, but carrierStatus
 * starts "pending" and only "ready" locations can be used to dispatch.
 */
export async function syncLocation(location, { client = getClient() } = {}) {
  if (!location.contact?.email) {
    // Not an error (the API accepts it) — but dispatch will fail later. Say so loudly.
    location.$locals = { warning: "No contact email: the carrier needs one to register this pickup, so dispatch from here will fail with LOCATION_NOT_READY." };
  }
  try {
    const remote = await client.upsertLocation(location.externalId, toApiLocation(location));
    await Location.updateOne({ _id: location._id }, { $set: applyRemoteLocation(remote) });
  } catch (error) {
    await Location.updateOne({ _id: location._id }, { $set: { "rafttaar.syncError": String(error.message).slice(0, 300) } });
    throw error;
  }
  return Location.findById(location._id);
}

/** Pull carrierStatus for every location (it flips pending -> ready/failed in the background). */
export async function refreshLocations({ client = getClient() } = {}) {
  const remote = await client.listLocations();
  let updated = 0;
  for (const r of remote) {
    const res = await Location.updateOne({ externalId: r.externalId }, { $set: applyRemoteLocation(r) });
    updated += res.modifiedCount;
  }
  const known = new Set((await Location.find().select("externalId").lean()).map((l) => l.externalId));
  return { remoteCount: remote.length, updated, notInErp: remote.filter((r) => !known.has(r.externalId)).map((r) => ({ externalId: r.externalId, name: r.name })) };
}

export async function deactivateLocation(location, { client = getClient() } = {}) {
  if (location.rafttaar?.id) {
    const remote = await client.deactivateLocation(location.rafttaar.id);
    await Location.updateOne({ _id: location._id }, { $set: { isActive: false, ...applyRemoteLocation(remote) } });
  } else {
    await Location.updateOne({ _id: location._id }, { $set: { isActive: false } });
  }
  return Location.findById(location._id);
}

// ===================================================================== inventory

/**
 * PUT /inventory in batches of 500. One bad item never fails the batch — each
 * item gets its own status (updated | not_found | warehouse_managed | invalid),
 * which is stored per row so the ERP can show exactly what Rafttaar rejected.
 */
export async function syncInventory({ skus, client = getClient() } = {}) {
  const filter = skus?.length ? { sku: { $in: skus } } : {};
  const items = await InventoryItem.find(filter).lean();
  if (!items.length) return { sent: 0, updated: 0, rejected: 0, results: [] };

  const locations = await Location.find().select("externalId rafttaar.id").lean();
  const locId = Object.fromEntries(locations.map((l) => [l.externalId, l.rafttaar?.id]));

  const sendable = [];
  const summary = { sent: 0, updated: 0, rejected: 0, results: [] };

  for (const item of items) {
    if (item.locationExternalId && !locId[item.locationExternalId]) {
      await InventoryItem.updateOne(
        { _id: item._id },
        { $set: { "sync.status": "error", "sync.syncedAt": new Date(), "sync.message": `Location ${item.locationExternalId} is not synced to Rafttaar yet` } }
      );
      summary.rejected++;
      summary.results.push({ sku: item.sku, status: "error", message: "location not synced" });
      continue;
    }
    sendable.push(item);
  }

  for (let i = 0; i < sendable.length; i += MAX_INVENTORY_ITEMS_PER_CALL) {
    const chunk = sendable.slice(i, i + MAX_INVENTORY_ITEMS_PER_CALL);
    const body = chunk.map((it) => ({
      sku: it.sku,
      ...(it.locationExternalId ? { locationId: locId[it.locationExternalId] } : {}),
      stockQty: it.stockQty,
      ...(it.minStockQty != null ? { minStockQty: it.minStockQty } : {})
    }));

    let data;
    try {
      data = await client.upsertInventory(body);
    } catch (error) {
      if (error instanceof RafttaarApiError) {
        for (const it of chunk) {
          await InventoryItem.updateOne({ _id: it._id }, { $set: { "sync.status": "error", "sync.syncedAt": new Date(), "sync.message": `${error.code}: ${error.message}`.slice(0, 300) } });
        }
      }
      throw error;
    }

    const results = data.results || [];
    const ops = [];
    for (let k = 0; k < chunk.length; k++) {
      const r = results[k] || { status: "invalid" }; // results are in the same order as the items sent
      const ok = r.status === "updated";
      ops.push({
        updateOne: {
          filter: { _id: chunk[k]._id },
          update: { $set: { "sync.status": r.status, "sync.syncedAt": new Date(), "sync.message": ok ? "" : `Rafttaar: ${r.status}` } }
        }
      });
      summary.sent++;
      ok ? summary.updated++ : summary.rejected++;
      summary.results.push({ sku: chunk[k].sku, status: r.status });
    }
    if (ops.length) await InventoryItem.bulkWrite(ops, { ordered: false }); // one round trip per batch, not one per row
  }
  return summary;
}
