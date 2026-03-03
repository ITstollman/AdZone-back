import rateLimit from "express-rate-limit";

export const publicRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  handler: (req, res, next, options) => {
    console.log("[rate-limiter:publicRateLimiter] RATE LIMIT REACHED — ip=%s path=%s method=%s max=%d windowMs=%d", req.ip, req.originalUrl, req.method, 120, 60000);
    res.status(options.statusCode).json(options.message);
  },
  requestWasSuccessful: (req, res) => {
    console.log("[rate-limiter:publicRateLimiter] Request ALLOWED — ip=%s path=%s method=%s remaining=%s", req.ip, req.originalUrl, req.method, res.getHeader("RateLimit-Remaining") || "unknown");
    return res.statusCode < 400;
  },
});

export const trackingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // Higher limit for tracking beacons
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
  handler: (req, res, next, options) => {
    console.log("[rate-limiter:trackingRateLimiter] RATE LIMIT REACHED — ip=%s path=%s method=%s max=%d windowMs=%d", req.ip, req.originalUrl, req.method, 300, 60000);
    res.status(options.statusCode).json(options.message);
  },
  requestWasSuccessful: (req, res) => {
    console.log("[rate-limiter:trackingRateLimiter] Request ALLOWED — ip=%s path=%s method=%s remaining=%s", req.ip, req.originalUrl, req.method, res.getHeader("RateLimit-Remaining") || "unknown");
    return res.statusCode < 400;
  },
});
