import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET /api/public/redirect?id=adId&bid=bidId&dest=/products/cool-thing&shop=store.myshopify.com
router.get("/", async (req, res) => {
  try {
    const { id, bid, dest, shop } = req.query;
    console.log("[redirect.js:GET /] Redirect request", { id, bid, dest, shop });

    if (!dest) {
      console.log("[redirect.js:GET /] Missing destination, returning 400");
      return res.status(400).json({ error: "Missing destination" });
    }

    // Validate destination is internal
    if (!dest.startsWith("/")) {
      console.log("[redirect.js:GET /] Non-internal destination, returning 400", { dest });
      return res.status(400).json({ error: "Destination must be an internal path" });
    }

    // Record click asynchronously (don't block redirect)
    console.log("[redirect.js:GET /] Recording click to DB", { id, bid, dest });
    db.collection("clicks").add({
      creativeId: id || null,
      bidId: bid || null,
      destinationUrl: dest,
      referrerPage: req.headers.referer || "",
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      timestamp: new Date(),
    }).catch((err) => console.error("Error recording click:", err));

    // Build full redirect URL
    const shopDomain = shop || req.headers.host;
    const redirectUrl = shopDomain
      ? `https://${shopDomain}${dest}`
      : dest;

    console.log("[redirect.js:GET /] Redirecting (302)", { redirectUrl });
    res.redirect(302, redirectUrl);
  } catch (err) {
    console.error("Error in redirect:", err);
    // Fallback: redirect to destination anyway
    res.redirect(302, req.query.dest || "/");
  }
});

export default router;
