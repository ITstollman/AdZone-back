import { AppError } from "../utils/errors.js";

/**
 * Express error-handling middleware.
 * Must be registered after all routes (app.use(errorHandler)).
 */
export function errorHandler(err, req, res, next) {
  const _start = Date.now();
  console.log("[error-handler:errorHandler] >>> ENTRY — error caught for %s %s", req.method, req.originalUrl);
  console.log("[error-handler:errorHandler] Error details — name=%s message=%s", err.name || "Unknown", err.message || "(no message)");
  console.log("[error-handler:errorHandler] Error stack:\n%s", err.stack || "(no stack)");

  // If headers already sent, delegate to Express default handler
  if (res.headersSent) {
    console.log("[error-handler:errorHandler] Headers already sent — delegating to Express default handler (%dms)", Date.now() - _start);
    return next(err);
  }

  if (err instanceof AppError) {
    console.log("[error-handler:errorHandler] AppError detected — code=%s statusCode=%d message=%s", err.code, err.statusCode, err.message);

    const response = {
      error: {
        message: err.message,
        code: err.code,
        statusCode: err.statusCode,
      },
    };

    // Include validation details if present
    if (err.details) {
      response.error.details = err.details;
      console.log("[error-handler:errorHandler] Validation details present — detailCount=%d details=%s", err.details.length, JSON.stringify(err.details));
    }

    console.log("[error-handler:errorHandler] <<< EXIT — Sending AppError response statusCode=%d code=%s (%dms)", err.statusCode, err.code, Date.now() - _start);
    return res.status(err.statusCode).json(response);
  }

  // Non-operational / unexpected errors
  console.error("[error-handler:errorHandler] UNEXPECTED ERROR (non-AppError) — name=%s message=%s", err.name, err.message);
  console.error("Unhandled error:", err);

  console.log("[error-handler:errorHandler] <<< EXIT — Sending 500 INTERNAL_ERROR response (%dms)", Date.now() - _start);

  res.status(500).json({
    error: {
      message: "An unexpected error occurred",
      code: "INTERNAL_ERROR",
      statusCode: 500,
    },
  });
}
