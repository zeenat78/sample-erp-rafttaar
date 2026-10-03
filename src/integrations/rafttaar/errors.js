// Every non-2xx answer from the Partner API uses one envelope (ErrorEnvelope in
// the spec). Branch on `code`, never on `message` (message is for logs).
export class RafttaarApiError extends Error {
  constructor({ status, code, message, details, requestId, retryAfterMs, cause } = {}) {
    super(message || code || `Rafttaar API error (HTTP ${status ?? "?"})`);
    this.name = "RafttaarApiError";
    this.status = status ?? null; // null => never got an HTTP answer (network/timeout)
    this.code = code || "UNKNOWN_ERROR";
    this.details = details ?? [];
    this.requestId = requestId ?? null;
    this.retryAfterMs = retryAfterMs ?? null;
    if (cause) this.cause = cause;
  }

  // Worth retrying later with the SAME idempotency key: we may or may not have
  // reached Rafttaar, or it was overloaded. 4xx (except 408/429) are final.
  get retryable() {
    if (this.status === null) return true;
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
      requestId: this.requestId
    };
  }
}

export class RafttaarConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RafttaarConfigError";
  }
}
