import { ActionError } from "../integrations/rafttaar/actions.js";
import { RafttaarApiError, RafttaarConfigError } from "../integrations/rafttaar/errors.js";

export function notFound(req, res) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// Rafttaar business refusals keep their own 4xx so the UI can show the stable
// `code` (ORDER_NOT_ACKNOWLEDGED, EWAY_BILL_REQUIRED...). Network/5xx trouble on
// their side is a 502 from ours: the ERP itself is fine, its upstream is not.
function statusForRafttaar(error) {
  if (error.status === null) return 502;
  if (error.status === 429) return 429;
  if (error.status >= 500) return 502;
  if ([400, 401, 403, 404, 409].includes(error.status)) return error.status;
  return 502;
}

export function errorHandler(error, _req, res, _next) {
  if (error instanceof ActionError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message, details: error.details });
  }
  if (error instanceof RafttaarApiError) {
    return res.status(statusForRafttaar(error)).json({
      success: false,
      source: "rafttaar",
      code: error.code,
      message: error.message,
      details: error.details,
      requestId: error.requestId
    });
  }
  if (error instanceof RafttaarConfigError) {
    return res.status(503).json({ success: false, code: "RAFTTAAR_NOT_CONFIGURED", message: error.message });
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: error.message });
  }

  console.error(error);
  res.status(500).json({
    success: false,
    message: error instanceof Error ? error.message : "Internal server error"
  });
}
