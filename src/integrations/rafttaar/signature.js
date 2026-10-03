import crypto from "node:crypto";

export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignatureError";
  }
}

const hexToBuf = (hex) => (/^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0 ? Buffer.from(hex, "hex") : null);

/**
 * Verify a Rafttaar webhook delivery.
 *
 * Header: `Rafttaar-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * v1 = HMAC-SHA256 of `"{t}.{raw body}"` keyed with the webhook secret.
 * During the 24h after a secret rotation the header carries TWO v1 values
 * (old + new secret): a match on any one of them is a valid delivery, and we
 * try every candidate secret we hold.
 *
 * `rawBody` MUST be the exact bytes received (Buffer or string) — never a
 * re-serialised JSON.parse() result.
 */
export function verifyWebhookSignature(rawBody, header, secrets, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header) throw new SignatureError("Missing Rafttaar-Signature header");

  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((s) => typeof s === "string" && s.length > 0);
  if (list.length === 0) throw new SignatureError("No webhook secret configured");

  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) throw new SignatureError("Malformed Rafttaar-Signature header");

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) throw new SignatureError("Signature timestamp outside tolerance");

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]);

  for (const secret of list) {
    const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest();
    for (const sig of signatures) {
      const got = hexToBuf(sig);
      if (got && got.length === expected.length && crypto.timingSafeEqual(got, expected)) return true;
    }
  }
  throw new SignatureError("Signature mismatch");
}

// Test helper / local simulator: produce a header the same way Rafttaar does.
export function signWebhookBody(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]))
    .digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
