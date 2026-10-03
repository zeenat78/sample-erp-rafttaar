import test from "node:test";
import assert from "node:assert/strict";
import { signWebhookBody, verifyWebhookSignature, SignatureError } from "../src/integrations/rafttaar/signature.js";

const body = JSON.stringify({ id: "e1", type: "order.pushed", data: { orderId: "o1" } });
const secret = "whsec_test";

test("valid signature verifies", () => {
  assert.equal(verifyWebhookSignature(body, signWebhookBody(body, secret), secret), true);
});

test("any candidate secret may match (rotation: old + new)", () => {
  const header = signWebhookBody(body, "whsec_old");
  assert.equal(verifyWebhookSignature(body, header, ["whsec_new", "whsec_old"]), true);
});

test("header with two v1 values (rotation window) verifies against either secret", () => {
  const t = Math.floor(Date.now() / 1000);
  const a = signWebhookBody(body, "whsec_new", t).split(",")[1];
  const b = signWebhookBody(body, "whsec_old", t).split(",")[1];
  assert.equal(verifyWebhookSignature(body, `t=${t},${a},${b}`, "whsec_old"), true);
  assert.equal(verifyWebhookSignature(body, `t=${t},${a},${b}`, "whsec_new"), true);
});

test("tampered body is rejected", () => {
  assert.throws(() => verifyWebhookSignature(body.replace("o1", "o2"), signWebhookBody(body, secret), secret), SignatureError);
});

test("re-serialised JSON is NOT the same bytes (must verify the raw body)", () => {
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  assert.throws(() => verifyWebhookSignature(pretty, signWebhookBody(body, secret), secret), /mismatch/);
});

test("wrong secret, missing header, malformed header, empty secret", () => {
  assert.throws(() => verifyWebhookSignature(body, signWebhookBody(body, "nope"), secret), /mismatch/);
  assert.throws(() => verifyWebhookSignature(body, undefined, secret), /Missing/);
  assert.throws(() => verifyWebhookSignature(body, "garbage", secret), /Malformed/);
  assert.throws(() => verifyWebhookSignature(body, signWebhookBody(body, secret), ""), /No webhook secret/);
  assert.throws(() => verifyWebhookSignature(body, signWebhookBody(body, secret), []), /No webhook secret/);
});

test("old timestamps are rejected (replay protection); non-hex signatures do not crash", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => verifyWebhookSignature(body, signWebhookBody(body, secret, old), secret), /tolerance/);
  const t = Math.floor(Date.now() / 1000);
  assert.throws(() => verifyWebhookSignature(body, `t=${t},v1=zzzz`, secret), /mismatch/);
});

test("accepts a Buffer body", () => {
  const buf = Buffer.from(body);
  assert.equal(verifyWebhookSignature(buf, signWebhookBody(buf, secret), secret), true);
});
