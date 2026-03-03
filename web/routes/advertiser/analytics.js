import { Router } from "express";
import { db } from "../../firebase.js";
import { exportAnalyticsCsv } from "../../services/analytics-aggregator.js";
import { getTestResults } from "../../services/ab-testing.js";

const router = Router();

// GET /api/advertiser/analytics — Get advertiser analytics
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId, startDate, endDate } = req.query;
    console.log("[analytics.js:GET /] Advertiser analytics request", { advertiserId, campaignId, startDate, endDate });

    let query = db
      .collection("analytics_daily")
      .where("advertiserId", "==", advertiserId);

    if (campaignId) {
      query = query.where("campaignId", "==", campaignId);
    }
    if (startDate) {
      query = query.where("date", ">=", startDate);
    }
    if (endDate) {
      query = query.where("date", "<=", endDate);
    }

    const snapshot = await query.orderBy("date", "desc").limit(200).get();
    const analytics = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    console.log("[analytics.js:GET /] DB query returned results", { resultCount: analytics.length, advertiserId });

    const totals = analytics.reduce(
      (acc, day) => ({
        impressions: acc.impressions + (day.impressions || 0),
        clicks: acc.clicks + (day.clicks || 0),
        spend: acc.spend + (day.spend || 0),
        conversions: acc.conversions + (day.conversions || 0),
        conversionValue: acc.conversionValue + (day.conversionValue || 0),
      }),
      { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 }
    );

    totals.ctr = totals.impressions > 0
      ? ((totals.clicks / totals.impressions) * 100).toFixed(2)
      : 0;

    totals.roas = totals.spend > 0
      ? (totals.conversionValue / totals.spend).toFixed(2)
      : 0;

    console.log("[analytics.js:GET /] Returning analytics (200)", { resultCount: analytics.length, totals });
    res.json({ analytics, totals });
  } catch (err) {
    console.error("Error getting analytics:", err);
    res.status(500).json({ error: "Failed to get analytics" });
  }
});

// GET /api/advertiser/analytics/export — Export analytics as CSV
router.get("/export", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId, startDate, endDate } = req.query;
    console.log("[analytics.js:GET /export] CSV export request", { advertiserId, campaignId, startDate, endDate });

    let query = db
      .collection("analytics_daily")
      .where("advertiserId", "==", advertiserId);

    if (campaignId) {
      query = query.where("campaignId", "==", campaignId);
    }
    if (startDate) {
      query = query.where("date", ">=", startDate);
    }
    if (endDate) {
      query = query.where("date", "<=", endDate);
    }

    const snapshot = await query.orderBy("date", "desc").get();
    const analytics = snapshot.docs.map((doc) => doc.data());

    const csv = exportAnalyticsCsv(analytics, [
      { key: "date", header: "Date" },
      { key: "impressions", header: "Impressions" },
      { key: "clicks", header: "Clicks" },
      { key: "ctr", header: "CTR" },
      { key: "spend", header: "Spend (cents)" },
      { key: "conversions", header: "Conversions" },
      { key: "conversionValue", header: "Conversion Value (cents)" },
    ]);

    console.log("[analytics.js:GET /export] CSV export generated (200)", { rows: analytics.length });
    res.json({ csv });
  } catch (err) {
    console.error("Error exporting analytics CSV:", err);
    res.status(500).json({ error: "Failed to export analytics" });
  }
});

// GET /api/advertiser/analytics/ab-test/:campaignId — Get A/B test results
router.get("/ab-test/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    console.log("[analytics.js:GET /ab-test/:campaignId] A/B test results request", { campaignId, advertiserId: req.advertiser.advertiserId });

    // Verify the campaign belongs to this advertiser
    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignDoc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const results = await getTestResults(campaignId);
    console.log("[analytics.js:GET /ab-test/:campaignId] Returning A/B test results (200)", { campaignId });
    res.json({ results });
  } catch (err) {
    console.error("Error getting A/B test results:", err);
    res.status(500).json({ error: "Failed to get A/B test results" });
  }
});

export default router;
