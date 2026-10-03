import test from "node:test";
import assert from "node:assert/strict";
import { mapRemoteOrder, paiseToRupees, toSetOperator, erpStatusFor } from "../src/integrations/rafttaar/mapper.js";

const remote = (over = {}) => ({
  id: "o-1",
  displayCode: "ORD1",
  platformStatus: "paid",
  fulfilmentState: "pushed",
  items: [{ lineId: "l1", productId: "KAPO-ABCE-0018", name: "Fan Belt", quantity: 1, unitPricePaise: 100000 }],
  deliveryAddress: { name: "Buyer", line1: "C-95", city: "Erode", state: "Tamil Nadu", pincode: "638001", phone: "9000000000" },
  buyer: { name: "Buyer", phone: "9000000000" },
  totals: { currency: "INR", totalPaise: 1201594 },
  ...over
});

test("catalogue product code in productId becomes the SKU; uuid and sandbox ids do not", () => {
  assert.equal(mapRemoteOrder(remote()).items[0].sku, "KAPO-ABCE-0018");
  assert.equal(mapRemoteOrder(remote({ items: [{ lineId: "l", productId: "2f9a8b2c-6d1e-4a5f-8c3d-000000000010", name: "x", quantity: 1, unitPricePaise: 1 }] })).items[0].sku, "");
  assert.equal(mapRemoteOrder(remote({ items: [{ lineId: "l", productId: "sandbox-product-1", name: "x", quantity: 1, unitPricePaise: 1 }] })).items[0].sku, "");
});

test("money is converted exactly; list-row totals fill what the detail lacks", () => {
  assert.equal(paiseToRupees(1201594), 12015.94);
  const m = mapRemoteOrder(remote(), { placedAt: "2026-10-03T07:00:00Z", totals: { currency: "INR", subtotalPaise: 100000, gstPaise: 183294, logisticsFeePaise: 918300, totalPaise: 1201594 } });
  assert.equal(m.totalAmount, 12015.94);
  assert.equal(m.rafttaar.totals.gstPaise, 183294);
  assert.equal(m.items[0].price, 1000);
});

test("missing address fields never leave a required ERP field empty", () => {
  const m = mapRemoteOrder(remote({ deliveryAddress: {}, buyer: {} }));
  assert.equal(m.shippingAddress.addressLine1, "-");
  assert.equal(m.customer.name, "Rafttaar buyer");
  assert.equal(m.customer.phone, "-");
});

test("status mapping and $set never clobbers ERP-held invoice/shipment with nulls", () => {
  assert.equal(erpStatusFor("packaging"), "processing");
  assert.equal(erpStatusFor("dispatched"), "shipped");
  assert.equal(erpStatusFor("recalled"), "recalled");
  const set = toSetOperator(mapRemoteOrder(remote()));
  assert.equal(Object.keys(set).some((k) => k.startsWith("rafttaar.invoice")), false);
  assert.equal(Object.keys(set).some((k) => k.startsWith("rafttaar.shipment")), false);
  const withShip = toSetOperator(mapRemoteOrder(remote({ shipment: { id: "s1", awbNumber: "A1", courierName: "C", bookingStatus: "booked" } })));
  assert.equal(withShip["rafttaar.shipment.awbNumber"], "A1");
});
