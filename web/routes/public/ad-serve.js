import { Router } from "express";
import { runAuction } from "../../services/auction.js";

const router = Router();

// GET /api/public/ads/serve?zone=homepage-banner-top&shop=store.myshopify.com
router.get("/serve", async (req, res) => {
  try {
    const { zone, shop, vid, pageUrl, freq, count } = req.query;
    console.log("[ad-serve.js:GET /serve] Ad serve request", { zone, shop, vid, pageUrl, count });

    if (!zone || !shop) {
      console.log("[ad-serve.js:GET /serve] Missing zone or shop parameter, returning 400");
      return res.status(400).json({ error: "Missing zone or shop parameter" });
    }

    const adCount = Math.min(Math.max(parseInt(count) || 1, 1), 10);
    console.log("[ad-serve.js:GET /serve] Resolved adCount", { adCount });

    // Build request context for smart targeting
    const requestContext = {
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      userAgent: req.headers["user-agent"] || "",
      visitorId: vid || null,
      pageUrl: pageUrl || null,
      frequencyData: parseFrequencyData(freq),
      timestamp: Date.now(),
    };

    console.log("[ad-serve.js:GET /serve] Running auction", { shop, zone, adCount });
    const ad = await runAuction(shop, zone, requestContext, adCount);

    if (!ad || (Array.isArray(ad) && ad.length === 0)) {
      console.log("[ad-serve.js:GET /serve] No ad available, returning 204");
      return res.status(204).end(); // No ad available
    }

    console.log("[ad-serve.js:GET /serve] Returning ad response (200)", { adCount: Array.isArray(ad) ? ad.length : 1 });
    res.json(ad);
  } catch (err) {
    console.error("Error serving ad:", err);
    res.status(500).json({ error: "Failed to serve ad" });
  }
});

/**
 * Parse frequency data from query parameter.
 * Expected format: JSON string like {"campaignId1": 3, "campaignId2": 1}
 */
function parseFrequencyData(freq) {
  if (!freq) return {};
  try {
    return JSON.parse(freq);
  } catch {
    return {};
  }
}

export default router;
