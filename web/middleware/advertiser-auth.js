import jwt from "jsonwebtoken";

export function advertiserAuth(req, res, next) {
  const _start = Date.now();
  console.log("[advertiser-auth:advertiserAuth] >>> ENTRY — method=%s path=%s", req.method, req.originalUrl);

  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[advertiser-auth:advertiserAuth] Auth header MISSING or malformed — authHeader=%s", authHeader || "(none)");
    console.log("[advertiser-auth:advertiserAuth] <<< EXIT — 401 No token provided (%dms)", Date.now() - _start);
    return res.status(401).json({ error: "No token provided" });
  }

  console.log("[advertiser-auth:advertiserAuth] Auth header received — Bearer token present (length=%d)", authHeader.length - 7);

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.ADVERTISER_JWT_SECRET);
    console.log("[advertiser-auth:advertiserAuth] Token decoded successfully — advertiserId=%s email=%s", decoded.advertiserId, decoded.email);

    // Check if token has an expiry and log it
    if (decoded.exp) {
      const expiresIn = decoded.exp * 1000 - Date.now();
      console.log("[advertiser-auth:advertiserAuth] Token expires in %dms (%s)", expiresIn, expiresIn > 0 ? "VALID" : "EXPIRED");
    }

    req.advertiser = decoded; // { advertiserId, email }
    console.log("[advertiser-auth:advertiserAuth] Auth SUCCESS — advertiser attached to req (%dms)", Date.now() - _start);
    next();
  } catch (err) {
    console.log("[advertiser-auth:advertiserAuth] Token verification FAILED — error=%s message=%s", err.name, err.message);
    if (err.name === "TokenExpiredError") {
      console.log("[advertiser-auth:advertiserAuth] Token EXPIRED at %s", err.expiredAt);
    }
    console.log("[advertiser-auth:advertiserAuth] <<< EXIT — 401 Invalid or expired token (%dms)", Date.now() - _start);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
