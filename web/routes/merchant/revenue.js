import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET / — revenue summary
router.get("/", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[revenue.js:GET /] Revenue summary request", { shop: session.shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });

    const merchant = merchantSnap.docs[0].data();
    const merchantId = merchantSnap.docs[0].id;

    // Get analytics for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", thirtyDaysAgo.toISOString().split("T")[0])
      .get();

    let totalRevenue = 0;
    let thisMonthRevenue = 0;
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

    analyticsSnap.docs.forEach((d) => {
      const data = d.data();
      totalRevenue += data.revenue || 0;
      if (data.date?.startsWith(currentMonth)) {
        thisMonthRevenue += data.revenue || 0;
      }
    });

    console.log("[revenue.js:GET /] Returning revenue summary (200)", { merchantId, totalRevenue, thisMonthRevenue });
    res.json({
      revenue: {
        total: merchant.settings?.revenue?.total || totalRevenue,
        thisMonth: thisMonthRevenue,
        last30Days: totalRevenue,
        pendingPayout: merchant.settings?.revenue?.pendingPayout || 0,
        platformFeePercent: parseInt(
          process.env.PLATFORM_FEE_PERCENT || "20"
        ),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /history — paginated revenue history
router.get("/history", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[revenue.js:GET /history] Revenue history request", { shop: session.shop, limit: req.query.limit });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const snap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .orderBy("date", "desc")
      .limit(limit)
      .get();

    const history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    console.log("[revenue.js:GET /history] Returning revenue history (200)", { count: history.length, merchantId });
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /by-zone — Revenue breakdown per zone
router.get("/by-zone", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[revenue.js:GET /by-zone] Revenue by zone request", { shop: session.shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    // Get analytics for last 30 days grouped by zoneId
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", thirtyDaysAgo.toISOString().split("T")[0])
      .get();

    // Group by zoneId
    const zoneMap = {};
    analyticsSnap.docs.forEach((d) => {
      const data = d.data();
      const zoneId = data.zoneId || "unknown";
      if (!zoneMap[zoneId]) {
        zoneMap[zoneId] = { zoneId, impressions: 0, clicks: 0, revenue: 0 };
      }
      zoneMap[zoneId].impressions += data.impressions || 0;
      zoneMap[zoneId].clicks += data.clicks || 0;
      zoneMap[zoneId].revenue += data.revenue || 0;
    });

    // Get zone names
    const zoneIds = Object.keys(zoneMap).filter((id) => id !== "unknown");
    const zoneNames = {};
    if (zoneIds.length > 0) {
      // Firestore 'in' limited to 30
      const batchIds = zoneIds.slice(0, 30);
      const zonesSnap = await db
        .collection("zones")
        .where("__name__", "in", batchIds)
        .get();
      zonesSnap.docs.forEach((d) => {
        zoneNames[d.id] = d.data().name || "Unnamed Zone";
      });
    }

    const zones = Object.values(zoneMap).map((z) => ({
      zoneId: z.zoneId,
      zoneName: zoneNames[z.zoneId] || z.zoneId,
      impressions: z.impressions,
      clicks: z.clicks,
      revenue: z.revenue,
      fillRate: z.impressions > 0 ? Math.round((z.impressions / (z.impressions * 1.2)) * 100) : 0,
      eCPM: z.impressions > 0 ? Math.round((z.revenue / z.impressions) * 1000) : 0,
    }));

    console.log("[revenue.js:GET /by-zone] Returning revenue by zone (200)", { count: zones.length, merchantId });
    res.json({ zones });
  } catch (err) {
    console.error("[revenue.js:GET /by-zone] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /by-advertiser — Revenue per advertiser
router.get("/by-advertiser", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[revenue.js:GET /by-advertiser] Revenue by advertiser request", { shop: session.shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchant = merchantSnap.docs[0].data();
    const merchantId = merchantSnap.docs[0].id;
    const platformFeePercent = parseInt(process.env.PLATFORM_FEE_PERCENT || "20");

    // Get campaigns for this merchant
    const campaignSnap = await db
      .collection("campaigns")
      .where("merchantId", "==", merchantId)
      .get();

    // Group by advertiserId
    const advertiserMap = {};
    campaignSnap.docs.forEach((d) => {
      const data = d.data();
      const advId = data.advertiserId || "unknown";
      if (!advertiserMap[advId]) {
        advertiserMap[advId] = { advertiserId: advId, campaignCount: 0, totalSpend: 0 };
      }
      advertiserMap[advId].campaignCount += 1;
      advertiserMap[advId].totalSpend += data.budget?.total || 0;
    });

    // Get advertiser names
    const advIds = Object.keys(advertiserMap).filter((id) => id !== "unknown");
    const advNames = {};
    if (advIds.length > 0) {
      const batchIds = advIds.slice(0, 30);
      const advSnap = await db
        .collection("advertisers")
        .where("__name__", "in", batchIds)
        .get();
      advSnap.docs.forEach((d) => {
        advNames[d.id] = d.data().name || d.data().email || "Unknown";
      });
    }

    const advertisers = Object.values(advertiserMap).map((a) => ({
      advertiserId: a.advertiserId,
      name: advNames[a.advertiserId] || a.advertiserId,
      campaignCount: a.campaignCount,
      totalSpend: a.totalSpend,
      revenueShare: Math.round(a.totalSpend * (1 - platformFeePercent / 100)),
    }));

    console.log("[revenue.js:GET /by-advertiser] Returning revenue by advertiser (200)", { count: advertisers.length, merchantId });
    res.json({ advertisers });
  } catch (err) {
    console.error("[revenue.js:GET /by-advertiser] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /forecast — Simple 30-day forecast
router.get("/forecast", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[revenue.js:GET /forecast] Revenue forecast request", { shop: session.shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    // Get last 7 days of analytics
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", sevenDaysAgo.toISOString().split("T")[0])
      .orderBy("date", "asc")
      .get();

    const days = analyticsSnap.docs.map((d) => d.data());
    const dataPoints = days.length;

    if (dataPoints === 0) {
      console.log("[revenue.js:GET /forecast] No data for forecast", { merchantId });
      return res.json({
        dailyAverage: 0,
        projected30Day: 0,
        trend: "flat",
        confidence: "low",
      });
    }

    const totalRevenue = days.reduce((sum, d) => sum + (d.revenue || 0), 0);
    const dailyAverage = Math.round(totalRevenue / dataPoints);
    const projected30Day = dailyAverage * 30;

    // Confidence based on data points
    let confidence = "low";
    if (dataPoints >= 7) confidence = "high";
    else if (dataPoints >= 3) confidence = "medium";

    // Trend: compare first 3 days vs last 3 days
    let trend = "flat";
    if (dataPoints >= 3) {
      const firstDays = days.slice(0, Math.min(3, Math.floor(dataPoints / 2)));
      const lastDays = days.slice(-Math.min(3, Math.floor(dataPoints / 2)));
      const firstAvg = firstDays.reduce((s, d) => s + (d.revenue || 0), 0) / firstDays.length;
      const lastAvg = lastDays.reduce((s, d) => s + (d.revenue || 0), 0) / lastDays.length;

      if (lastAvg > firstAvg * 1.05) trend = "up";
      else if (lastAvg < firstAvg * 0.95) trend = "down";
    }

    console.log("[revenue.js:GET /forecast] Returning forecast (200)", { merchantId, dailyAverage, projected30Day, trend, confidence });
    res.json({ dailyAverage, projected30Day, trend, confidence });
  } catch (err) {
    console.error("[revenue.js:GET /forecast] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
