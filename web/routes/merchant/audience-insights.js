import { Router } from "express";
import { db } from "../../firebase.js";
import { computeRFMScore, computeEngagementScore, evaluateAutoSegments } from "../../services/behavioral-scoring.js";
import { predictPurchaseProbability } from "../../services/predictive-audiences.js";

const router = Router();

// GET /api/merchant/audience-insights/distribution
router.get("/distribution", async (req, res) => {
  try {
    const merchantId = res.locals.shopify?.session?.shop || req.query.shop;
    console.log("[audience-insights.js:GET /distribution] Distribution request", { merchantId });
    if (!merchantId) return res.status(400).json({ error: "Missing merchant" });

    console.log("[audience-insights.js:GET /distribution] Querying visitor profiles from DB", { merchantId });
    const snap = await db.collection("visitor_profiles")
      .where("merchantId", "==", merchantId)
      .limit(500)
      .get();
    console.log("[audience-insights.js:GET /distribution] Profiles found", { profileCount: snap.size, merchantId });

    const rfmDistribution = {};
    const engagementBuckets = { high: 0, medium: 0, low: 0 };
    const predictionBuckets = { very_likely: 0, likely: 0, possible: 0, unlikely: 0 };
    const autoSegmentCounts = {};

    snap.docs.forEach(doc => {
      const profile = doc.data();

      const rfm = computeRFMScore(profile);
      rfmDistribution[rfm.rfmSegment] = (rfmDistribution[rfm.rfmSegment] || 0) + 1;

      const eng = computeEngagementScore(profile);
      if (eng.engagementScore >= 60) engagementBuckets.high++;
      else if (eng.engagementScore >= 30) engagementBuckets.medium++;
      else engagementBuckets.low++;

      const pred = predictPurchaseProbability(profile);
      predictionBuckets[pred.conversionSegment] = (predictionBuckets[pred.conversionSegment] || 0) + 1;

      const autoSegs = evaluateAutoSegments(profile);
      autoSegs.forEach(s => { autoSegmentCounts[s] = (autoSegmentCounts[s] || 0) + 1; });
    });

    console.log("[audience-insights.js:GET /distribution] Returning distribution data (200)", { totalProfiles: snap.size, merchantId });
    res.json({
      totalProfiles: snap.size,
      rfmDistribution,
      engagementBuckets,
      predictionBuckets,
      autoSegmentCounts,
    });
  } catch (err) {
    console.error("Audience insights error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
