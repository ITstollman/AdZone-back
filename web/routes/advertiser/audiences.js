import { Router } from "express";
import { db } from "../../firebase.js";
import { computeRFMScore, computeEngagementScore, evaluateAutoSegments } from "../../services/behavioral-scoring.js";
import { predictPurchaseProbability } from "../../services/predictive-audiences.js";

const router = Router();

// GET /api/advertiser/audiences/segments/:merchantId
// List all available segments for a merchant (custom + auto + predictive)
router.get("/segments/:merchantId", async (req, res) => {
  try {
    const { merchantId } = req.params;
    console.log("[audiences.js:GET /segments/:merchantId] Segments list request", { merchantId });

    // Load merchant-defined custom segments
    console.log("[audiences.js:GET /segments/:merchantId] Querying custom segments from DB", { merchantId });
    const customSnap = await db.collection("audience_segments")
      .where("merchantId", "==", merchantId)
      .get();
    const customSegments = customSnap.docs.map(d => ({
      id: d.id, ...d.data(), type: "custom",
    }));
    console.log("[audiences.js:GET /segments/:merchantId] Custom segments found", { count: customSegments.length, merchantId });

    // Auto-generated behavioral segments (always available)
    const autoSegments = [
      { id: "auto:high_value", name: "High Value Shoppers", type: "auto", description: "Champions and loyal customers based on RFM scoring" },
      { id: "auto:at_risk", name: "At Risk", type: "auto", description: "Previously active visitors showing signs of disengagement" },
      { id: "auto:new_visitor", name: "New Visitors", type: "auto", description: "Visitors with 1-2 visits only" },
      { id: "auto:frequent_browser", name: "Frequent Browsers", type: "auto", description: "10+ visits but low cart intent" },
      { id: "auto:cart_abandoner", name: "Cart Abandoners", type: "auto", description: "Added items to cart but never purchased" },
      { id: "auto:high_intent", name: "High Intent", type: "auto", description: "Engagement score 70+ across all dimensions" },
      { id: "auto:window_shopper", name: "Window Shoppers", type: "auto", description: "5+ product views but 0 cart additions" },
      { id: "auto:active_searcher", name: "Active Searchers", type: "auto", description: "3+ search queries performed" },
    ];

    // Predictive segments
    const predictiveSegments = [
      { id: "auto:likely_to_purchase", name: "Likely to Purchase", type: "predictive", description: "High purchase probability based on behavioral signals" },
      { id: "auto:warm_lead", name: "Warm Leads", type: "predictive", description: "Medium-high purchase probability" },
      { id: "auto:churn_risk", name: "Churn Risk", type: "predictive", description: "Previously active visitors now disengaging" },
    ];

    // Estimate sizes via sampling
    let segmentSizes = {};
    try {
      const profileSnap = await db.collection("visitor_profiles")
        .where("merchantId", "==", merchantId)
        .limit(200)
        .get();

      const totalProfiles = profileSnap.size;
      if (totalProfiles > 0) {
        profileSnap.docs.forEach(doc => {
          const profile = doc.data();
          const autoSegs = evaluateAutoSegments(profile);
          autoSegs.forEach(s => { segmentSizes[s] = (segmentSizes[s] || 0) + 1; });

          const pred = predictPurchaseProbability(profile);
          if (pred.conversionSegment === "very_likely") segmentSizes["auto:likely_to_purchase"] = (segmentSizes["auto:likely_to_purchase"] || 0) + 1;
          if (pred.conversionSegment === "likely") segmentSizes["auto:warm_lead"] = (segmentSizes["auto:warm_lead"] || 0) + 1;
          if (pred.churnRisk >= 0.6) segmentSizes["auto:churn_risk"] = (segmentSizes["auto:churn_risk"] || 0) + 1;
        });
      }
    } catch (err) {
      console.error("Segment size estimation error:", err.message);
    }

    // Attach sizes
    const allSegments = [...autoSegments, ...predictiveSegments, ...customSegments].map(s => ({
      ...s,
      estimatedSize: segmentSizes[s.id] || s.estimatedSize || 0,
    }));

    console.log("[audiences.js:GET /segments/:merchantId] Returning all segments (200)", { totalSegments: allSegments.length, merchantId });
    res.json({ segments: allSegments });
  } catch (err) {
    console.error("Audience segments error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/advertiser/audiences/insights/:merchantId
// Audience insights dashboard data
router.get("/insights/:merchantId", async (req, res) => {
  try {
    const { merchantId } = req.params;
    console.log("[audiences.js:GET /insights/:merchantId] Audience insights request", { merchantId });

    console.log("[audiences.js:GET /insights/:merchantId] Querying visitor profiles from DB", { merchantId });
    const snap = await db.collection("visitor_profiles")
      .where("merchantId", "==", merchantId)
      .limit(500)
      .get();
    console.log("[audiences.js:GET /insights/:merchantId] Visitor profiles found", { profileCount: snap.size, merchantId });

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

    console.log("[audiences.js:GET /insights/:merchantId] Returning audience insights (200)", { totalProfiles: snap.size, merchantId });
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
