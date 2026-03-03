import { ValidationError } from "../utils/errors.js";

/**
 * Zod-based request body validation middleware.
 * @param {import("zod").ZodSchema} schema - Zod schema to validate req.body against
 */
export function validate(schema) {
  const schemaName = schema?.description || schema?.constructor?.name || "UnknownSchema";
  console.log("[validate:validate] Middleware factory called — creating validator for schema=%s", schemaName);

  return (req, res, next) => {
    const _start = Date.now();
    console.log("[validate:middleware] >>> ENTRY — method=%s path=%s schema=%s bodyKeys=%s", req.method, req.originalUrl, schemaName, Object.keys(req.body || {}).join(",") || "(empty)");

    const result = schema.safeParse(req.body);

    if (!result.success) {
      const details = result.error.errors.map((err) => ({
        path: err.path.join("."),
        message: err.message,
      }));
      console.log("[validate:middleware] Validation FAILED — schema=%s errorCount=%d details=%s (%dms)", schemaName, details.length, JSON.stringify(details), Date.now() - _start);
      throw new ValidationError("Validation failed", details);
    }

    console.log("[validate:middleware] Validation PASSED — schema=%s sanitizedBodyKeys=%s (%dms)", schemaName, Object.keys(result.data || {}).join(","), Date.now() - _start);
    req.body = result.data;
    next();
  };
}
