import { Router } from "express";
import { db } from "../../firebase.js";
import { exportAnalyticsCsv } from "../../services/analytics-aggregator.js";

const router = Router();

// Helper: resolve merchant ID from Shopify session
async function getMerchantId(res) {
  const shop = res.locals.shopify.session.shop;
  const merchantSnap = await db
    .collection("merchants")
    .where("shopifyShopId", "==", shop)
    .limit(1)
    .get();

  if (merchantSnap.empty) return null;
  return merchantSnap.docs[0].id;
}

// GET /api/merchant/analytics — Get merchant analytics overview
router.get("/", async (req, res) => {
  try {
    const merchantId = await getMerchantId(res);
    if (!merchantId) {
      console.log("[merchant/analytics.js:GET /] Merchant not found");
      return res.status(404).json({ error: "Merchant not found" });
    }

    const { startDate, endDate, groupBy, zoneId } = req.query;
    console.log("[merchant/analytics.js:GET /] Merchant analytics request", { merchantId, startDate, endDate, groupBy, zoneId });

    // Get daily analytics for this merchant
    let query = db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId);

    if (zoneId) {
      query = query.where("zoneId", "==", zoneId);
    }
    if (startDate) {
      query = query.where("date", ">=", startDate);
    }
    if (endDate) {
      query = query.where("date", "<=", endDate);
    }

    const snapshot = await query.orderBy("date", "desc").limit(200).get();
    console.log("[merchant/analytics.js:GET /] DB query returned results", { resultCount: snapshot.size, merchantId });

    const rawDocs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Apply groupBy aggregation
    let analytics;
    if (groupBy && groupBy !== "overall") {
      const grouped = {};
      for (const row of rawDocs) {
        let groupKey;
        if (groupBy === "zone") groupKey = row.zoneId || "unknown";
        else if (groupBy === "campaign") groupKey = row.campaignId || "unknown";
        else if (groupBy === "creative") groupKey = row.creativeId || "unknown";
        else groupKey = row.date;

        const dateKey = `${row.date}_${groupKey}`;
        if (!grouped[dateKey]) {
          grouped[dateKey] = {
            date: row.date,
            groupKey,
            impressions: 0,
            clicks: 0,
            revenue: 0,
            conversions: 0,
            conversionValue: 0,
          };
        }
        grouped[dateKey].impressions += row.impressions || 0;
        grouped[dateKey].clicks += row.clicks || 0;
        grouped[dateKey].revenue += row.revenue || 0;
        grouped[dateKey].conversions += row.conversions || 0;
        grouped[dateKey].conversionValue += row.conversionValue || 0;
      }
      analytics = Object.values(grouped).map((g) => ({
        ...g,
        ctr: g.impressions > 0 ? g.clicks / g.impressions : 0,
      }));
    } else {
      // Overall: aggregate by date
      const byDate = {};
      for (const row of rawDocs) {
        if (!byDate[row.date]) {
          byDate[row.date] = { date: row.date, impressions: 0, clicks: 0, revenue: 0, conversions: 0, conversionValue: 0 };
        }
        byDate[row.date].impressions += row.impressions || 0;
        byDate[row.date].clicks += row.clicks || 0;
        byDate[row.date].revenue += row.revenue || 0;
        byDate[row.date].conversions += row.conversions || 0;
        byDate[row.date].conversionValue += row.conversionValue || 0;
      }
      analytics = Object.values(byDate).map((g) => ({
        ...g,
        ctr: g.impressions > 0 ? g.clicks / g.impressions : 0,
      }));
    }

    // Sort by date descending
    analytics.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // Compute totals
    const totals = analytics.reduce(
      (acc, day) => ({
        impressions: acc.impressions + (day.impressions || 0),
        clicks: acc.clicks + (day.clicks || 0),
        revenue: acc.revenue + (day.revenue || 0),
        conversions: acc.conversions + (day.conversions || 0),
        conversionValue: acc.conversionValue + (day.conversionValue || 0),
      }),
      { impressions: 0, clicks: 0, revenue: 0, conversions: 0, conversionValue: 0 }
    );

    totals.ctr = totals.impressions > 0
      ? ((totals.clicks / totals.impressions) * 100).toFixed(2)
      : 0;

    console.log("[merchant/analytics.js:GET /] Returning analytics (200)", { resultCount: analytics.length, totals });
    res.json({ analytics, totals });
  } catch (err) {
    console.error("Error getting analytics:", err);
    res.status(500).json({ error: "Failed to get analytics" });
  }
});

// GET /api/merchant/analytics/export — Export analytics as CSV
router.get("/export", async (req, res) => {
  try {
    const merchantId = await getMerchantId(res);
    if (!merchantId) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const { startDate, endDate } = req.query;
    console.log("[merchant/analytics.js:GET /export] CSV export request", { merchantId, startDate, endDate });

    let query = db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId);

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
      { key: "revenue", header: "Revenue (cents)" },
      { key: "conversions", header: "Conversions" },
      { key: "conversionValue", header: "Conversion Value (cents)" },
    ]);

    console.log("[merchant/analytics.js:GET /export] CSV export generated (200)", { rows: analytics.length, merchantId });
    res.json({ csv });
  } catch (err) {
    console.error("Error exporting analytics CSV:", err);
    res.status(500).json({ error: "Failed to export analytics" });
  }
});

// GET /api/merchant/analytics/breakdown — Dimension breakdown
router.get("/breakdown", async (req, res) => {
  try {
    const merchantId = await getMerchantId(res);
    if (!merchantId) {
      console.log("[merchant/analytics.js:GET /breakdown] Merchant not found");
      return res.status(404).json({ error: "Merchant not found" });
    }

    const { dimension, startDate, endDate } = req.query;
    console.log("[merchant/analytics.js:GET /breakdown] Breakdown request", { merchantId, dimension, startDate, endDate });

    if (!["geo", "device", "zone", "hour"].includes(dimension)) {
      return res.status(400).json({ error: "dimension must be one of: geo, device, zone, hour" });
    }

    let query = db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId);

    if (startDate) {
      query = query.where("date", ">=", startDate);
    }
    if (endDate) {
      query = query.where("date", "<=", endDate);
    }

    const snapshot = await query.orderBy("date", "desc").limit(500).get();
    const rawDocs = snapshot.docs.map((doc) => doc.data());

    // Group by the requested dimension
    const grouped = {};
    for (const row of rawDocs) {
      let key;
      if (dimension === "geo") key = row.country || "Unknown";
      else if (dimension === "device") key = row.device || "Unknown";
      else if (dimension === "zone") key = row.zoneId || "Unknown";
      else if (dimension === "hour") key = row.hour != null ? String(row.hour) : "Unknown";

      if (!grouped[key]) {
        grouped[key] = { key, impressions: 0, clicks: 0, revenue: 0 };
      }
      grouped[key].impressions += row.impressions || 0;
      grouped[key].clicks += row.clicks || 0;
      grouped[key].revenue += row.revenue || 0;
    }

    // If dimension is zone, try to resolve zone names
    if (dimension === "zone") {
      const zoneIds = Object.keys(grouped).filter((k) => k !== "Unknown");
      if (zoneIds.length > 0) {
        const zoneChunks = zoneIds.slice(0, 30);
        const zoneSnap = await db
          .collection("ad_zones")
          .where("__name__", "in", zoneChunks)
          .get();
        const zoneNames = {};
        zoneSnap.docs.forEach((d) => {
          zoneNames[d.id] = d.data().name || d.id;
        });
        for (const entry of Object.values(grouped)) {
          if (zoneNames[entry.key]) {
            entry.zoneName = zoneNames[entry.key];
          }
        }
      }
    }

    const breakdown = Object.values(grouped).map((g) => ({
      ...g,
      ctr: g.impressions > 0 ? ((g.clicks / g.impressions) * 100).toFixed(2) : "0.00",
    }));

    // Sort by impressions descending
    breakdown.sort((a, b) => b.impressions - a.impressions);

    console.log("[merchant/analytics.js:GET /breakdown] Returning breakdown (200)", { dimension, resultCount: breakdown.length });
    res.json({ breakdown });
  } catch (err) {
    console.error("[merchant/analytics.js:GET /breakdown] Error:", err);
    res.status(500).json({ error: "Failed to get breakdown" });
  }
});

// GET /api/merchant/analytics/fill-rate — Fill rate analysis
router.get("/fill-rate", async (req, res) => {
  try {
    const merchantId = await getMerchantId(res);
    if (!merchantId) {
      console.log("[merchant/analytics.js:GET /fill-rate] Merchant not found");
      return res.status(404).json({ error: "Merchant not found" });
    }

    console.log("[merchant/analytics.js:GET /fill-rate] Fill rate request", { merchantId });

    // Get active zones for this merchant
    const zonesSnap = await db
      .collection("ad_zones")
      .where("merchantId", "==", merchantId)
      .where("status", "==", "active")
      .get();

    if (zonesSnap.empty) {
      console.log("[merchant/analytics.js:GET /fill-rate] No active zones found", { merchantId });
      return res.json({ zones: [] });
    }

    // Get analytics_daily for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split("T")[0];

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", startDate)
      .orderBy("date", "desc")
      .limit(500)
      .get();

    const analyticsByZone = {};
    for (const doc of analyticsSnap.docs) {
      const data = doc.data();
      const zoneId = data.zoneId || "unknown";
      if (!analyticsByZone[zoneId]) {
        analyticsByZone[zoneId] = { impressions: 0, requests: 0, revenue: 0 };
      }
      analyticsByZone[zoneId].impressions += data.impressions || 0;
      analyticsByZone[zoneId].requests += (data.impressions || 0) + (data.unfilled || 0);
      analyticsByZone[zoneId].revenue += data.revenue || 0;
    }

    const zones = zonesSnap.docs.map((zoneDoc) => {
      const zoneData = zoneDoc.data();
      const zoneId = zoneDoc.id;
      const zoneAnalytics = analyticsByZone[zoneId] || { impressions: 0, requests: 0, revenue: 0 };

      const fills = zoneAnalytics.impressions;
      const requests = zoneAnalytics.requests || fills; // fallback if no unfilled data
      const fillRate = requests > 0 ? ((fills / requests) * 100).toFixed(1) : "100.0";
      const eCPM = fills > 0 ? (zoneAnalytics.revenue / fills) * 1000 : 0;
      const unfilled = requests - fills;
      const missedRevenue = Math.round(unfilled * (eCPM / 1000));

      return {
        zoneId,
        zoneName: zoneData.name || zoneId,
        requests,
        fills,
        fillRate: parseFloat(fillRate),
        missedRevenue,
        eCPM: Math.round(eCPM),
      };
    });

    // Sort by fill rate ascending (worst first)
    zones.sort((a, b) => a.fillRate - b.fillRate);

    console.log("[merchant/analytics.js:GET /fill-rate] Returning fill rate data (200)", { zoneCount: zones.length });
    res.json({ zones });
  } catch (err) {
    console.error("[merchant/analytics.js:GET /fill-rate] Error:", err);
    res.status(500).json({ error: "Failed to get fill rate" });
  }
});

// GET /api/merchant/analytics/comparison — Period comparison
router.get("/comparison", async (req, res) => {
  try {
    const merchantId = await getMerchantId(res);
    if (!merchantId) {
      console.log("[merchant/analytics.js:GET /comparison] Merchant not found");
      return res.status(404).json({ error: "Merchant not found" });
    }

    const period = req.query.period || "30d";
    console.log("[merchant/analytics.js:GET /comparison] Comparison request", { merchantId, period });

    const periodDays = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    const now = new Date();
    const currentEnd = now.toISOString().split("T")[0];

    const currentStartDate = new Date();
    currentStartDate.setDate(currentStartDate.getDate() - periodDays);
    const currentStart = currentStartDate.toISOString().split("T")[0];

    const previousEndDate = new Date(currentStartDate);
    previousEndDate.setDate(previousEndDate.getDate() - 1);
    const previousEnd = previousEndDate.toISOString().split("T")[0];

    const previousStartDate = new Date(previousEndDate);
    previousStartDate.setDate(previousStartDate.getDate() - periodDays + 1);
    const previousStart = previousStartDate.toISOString().split("T")[0];

    // Fetch current period
    const currentSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", currentStart)
      .where("date", "<=", currentEnd)
      .orderBy("date", "desc")
      .limit(500)
      .get();

    // Fetch previous period
    const previousSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", previousStart)
      .where("date", "<=", previousEnd)
      .orderBy("date", "desc")
      .limit(500)
      .get();

    function aggregateMetrics(snapshot) {
      const metrics = { impressions: 0, clicks: 0, revenue: 0, ctr: 0, conversions: 0 };
      for (const doc of snapshot.docs) {
        const data = doc.data();
        metrics.impressions += data.impressions || 0;
        metrics.clicks += data.clicks || 0;
        metrics.revenue += data.revenue || 0;
        metrics.conversions += data.conversions || 0;
      }
      metrics.ctr = metrics.impressions > 0
        ? parseFloat(((metrics.clicks / metrics.impressions) * 100).toFixed(2))
        : 0;
      return metrics;
    }

    const current = aggregateMetrics(currentSnap);
    const previous = aggregateMetrics(previousSnap);

    function calcChange(curr, prev) {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
    }

    const changes = {
      impressions: calcChange(current.impressions, previous.impressions),
      clicks: calcChange(current.clicks, previous.clicks),
      revenue: calcChange(current.revenue, previous.revenue),
      ctr: calcChange(current.ctr, previous.ctr),
      conversions: calcChange(current.conversions, previous.conversions),
    };

    console.log("[merchant/analytics.js:GET /comparison] Returning comparison (200)", { period, currentStart, currentEnd, previousStart, previousEnd });
    res.json({ current, previous, changes, period: { currentStart, currentEnd, previousStart, previousEnd } });
  } catch (err) {
    console.error("[merchant/analytics.js:GET /comparison] Error:", err);
    res.status(500).json({ error: "Failed to get comparison" });
  }
});

export default router;
