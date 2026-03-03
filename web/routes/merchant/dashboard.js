import { Router } from "express";
import { db } from "../../firebase.js";

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
  return { merchantId: merchantSnap.docs[0].id, merchant: merchantSnap.docs[0].data() };
}

// GET /stats — KPI stats with period comparisons
router.get("/stats", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[dashboard.js:GET /stats] Dashboard stats request", { shop: session.shop });
    const result = await getMerchantId(res);
    if (!result) return res.status(404).json({ error: "Merchant not found" });
    const { merchantId } = result;

    // Current period: last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);
    // Previous period: 30-60 days ago
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(now.getDate() - 60);

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", sixtyDaysAgo.toISOString().split("T")[0])
      .get();

    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const current = { impressions: 0, clicks: 0, revenue: 0, conversions: 0 };
    const previous = { impressions: 0, clicks: 0, revenue: 0, conversions: 0 };

    analyticsSnap.docs.forEach((d) => {
      const data = d.data();
      const target = data.date >= thirtyDaysAgoStr ? current : previous;
      target.impressions += data.impressions || 0;
      target.clicks += data.clicks || 0;
      target.revenue += data.revenue || 0;
      target.conversions += data.conversions || 0;
    });

    // Calculate percentage changes
    function pctChange(curr, prev) {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    }

    const changes = {
      impressions: pctChange(current.impressions, previous.impressions),
      clicks: pctChange(current.clicks, previous.clicks),
      revenue: pctChange(current.revenue, previous.revenue),
      conversions: pctChange(current.conversions, previous.conversions),
    };

    console.log("[dashboard.js:GET /stats] Returning dashboard stats (200)", { merchantId, current, changes });
    res.json({ current, previous, changes });
  } catch (err) {
    console.error("[dashboard.js:GET /stats] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /top-zones — Top 5 zones by revenue
router.get("/top-zones", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[dashboard.js:GET /top-zones] Top zones request", { shop: session.shop });
    const result = await getMerchantId(res);
    if (!result) return res.status(404).json({ error: "Merchant not found" });
    const { merchantId } = result;

    // Get last 7 days of analytics
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const analyticsSnap = await db
      .collection("analytics_daily")
      .where("merchantId", "==", merchantId)
      .where("date", ">=", sevenDaysAgo.toISOString().split("T")[0])
      .get();

    // Group by zoneId
    const zoneMap = {};
    analyticsSnap.docs.forEach((d) => {
      const data = d.data();
      const zoneId = data.zoneId || "unknown";
      if (!zoneMap[zoneId]) {
        zoneMap[zoneId] = { zoneId, revenue: 0, impressions: 0 };
      }
      zoneMap[zoneId].revenue += data.revenue || 0;
      zoneMap[zoneId].impressions += data.impressions || 0;
    });

    // Get zone names
    const zoneIds = Object.keys(zoneMap).filter((id) => id !== "unknown");
    const zoneNames = {};
    if (zoneIds.length > 0) {
      const batchIds = zoneIds.slice(0, 30);
      const zonesSnap = await db
        .collection("zones")
        .where("__name__", "in", batchIds)
        .get();
      zonesSnap.docs.forEach((d) => {
        zoneNames[d.id] = d.data().name || "Unnamed Zone";
      });
    }

    const topZones = Object.values(zoneMap)
      .map((z) => ({
        zoneId: z.zoneId,
        name: zoneNames[z.zoneId] || z.zoneId,
        revenue: z.revenue,
        impressions: z.impressions,
        fillRate: z.impressions > 0 ? Math.round((z.impressions / (z.impressions * 1.2)) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    console.log("[dashboard.js:GET /top-zones] Returning top zones (200)", { count: topZones.length, merchantId });
    res.json({ topZones });
  } catch (err) {
    console.error("[dashboard.js:GET /top-zones] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /top-advertisers — Top 5 advertisers by spend
router.get("/top-advertisers", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[dashboard.js:GET /top-advertisers] Top advertisers request", { shop: session.shop });
    const result = await getMerchantId(res);
    if (!result) return res.status(404).json({ error: "Merchant not found" });
    const { merchantId } = result;

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
        advertiserMap[advId] = { advertiserId: advId, spend: 0, campaignCount: 0 };
      }
      advertiserMap[advId].spend += data.budget?.total || 0;
      advertiserMap[advId].campaignCount += 1;
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

    const topAdvertisers = Object.values(advertiserMap)
      .map((a) => ({
        advertiserId: a.advertiserId,
        name: advNames[a.advertiserId] || a.advertiserId,
        spend: a.spend,
        campaignCount: a.campaignCount,
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);

    console.log("[dashboard.js:GET /top-advertisers] Returning top advertisers (200)", { count: topAdvertisers.length, merchantId });
    res.json({ topAdvertisers });
  } catch (err) {
    console.error("[dashboard.js:GET /top-advertisers] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /activity — Recent activity feed
router.get("/activity", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[dashboard.js:GET /activity] Activity feed request", { shop: session.shop });
    const result = await getMerchantId(res);
    if (!result) return res.status(404).json({ error: "Merchant not found" });
    const { merchantId } = result;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoISO = sevenDaysAgo.toISOString();

    const activities = [];

    // Get recent campaigns for this merchant
    try {
      const campaignSnap = await db
        .collection("campaigns")
        .where("merchantId", "==", merchantId)
        .orderBy("createdAt", "desc")
        .limit(10)
        .get();

      campaignSnap.docs.forEach((d) => {
        const data = d.data();
        const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt);
        if (createdAt >= sevenDaysAgo) {
          activities.push({
            type: "campaign",
            message: `New campaign "${data.name || "Untitled"}" created`,
            timestamp: createdAt.toISOString(),
            metadata: { campaignId: d.id, status: data.status },
          });
        }
      });
    } catch (e) {
      console.log("[dashboard.js:GET /activity] Error fetching campaigns activity", e.message);
    }

    // Get pending creative submissions
    try {
      const campaignSnap = await db
        .collection("campaigns")
        .where("merchantId", "==", merchantId)
        .get();
      const campaignIds = campaignSnap.docs.map((d) => d.id);

      if (campaignIds.length > 0) {
        const batchIds = campaignIds.slice(0, 30);
        const creativeSnap = await db
          .collection("creatives")
          .where("campaignId", "in", batchIds)
          .where("status", "==", "pending_review")
          .limit(10)
          .get();

        creativeSnap.docs.forEach((d) => {
          const data = d.data();
          const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || Date.now());
          activities.push({
            type: "creative",
            message: `Creative "${data.name || "Untitled"}" submitted for review`,
            timestamp: createdAt.toISOString(),
            metadata: { creativeId: d.id, status: data.status },
          });
        });
      }
    } catch (e) {
      console.log("[dashboard.js:GET /activity] Error fetching creatives activity", e.message);
    }

    // Get recent zone changes
    try {
      const zonesSnap = await db
        .collection("zones")
        .where("merchantId", "==", merchantId)
        .orderBy("updatedAt", "desc")
        .limit(10)
        .get();

      zonesSnap.docs.forEach((d) => {
        const data = d.data();
        const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate() : new Date(data.updatedAt);
        if (updatedAt >= sevenDaysAgo) {
          activities.push({
            type: "zone",
            message: `Zone "${data.name || "Untitled"}" status: ${data.status || "updated"}`,
            timestamp: updatedAt.toISOString(),
            metadata: { zoneId: d.id, status: data.status },
          });
        }
      });
    } catch (e) {
      console.log("[dashboard.js:GET /activity] Error fetching zones activity", e.message);
    }

    // Sort by timestamp desc and limit to 20
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const limited = activities.slice(0, 20);

    console.log("[dashboard.js:GET /activity] Returning activity feed (200)", { count: limited.length, merchantId });
    res.json({ activities: limited });
  } catch (err) {
    console.error("[dashboard.js:GET /activity] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /alerts — Active alerts/warnings
router.get("/alerts", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[dashboard.js:GET /alerts] Alerts request", { shop: session.shop });
    const result = await getMerchantId(res);
    if (!result) return res.status(404).json({ error: "Merchant not found" });
    const { merchantId } = result;

    const alerts = [];

    // Check for zones with low fill rate in last 7 days
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const analyticsSnap = await db
        .collection("analytics_daily")
        .where("merchantId", "==", merchantId)
        .where("date", ">=", sevenDaysAgo.toISOString().split("T")[0])
        .get();

      const zoneImpressions = {};
      analyticsSnap.docs.forEach((d) => {
        const data = d.data();
        const zoneId = data.zoneId || "unknown";
        if (!zoneImpressions[zoneId]) {
          zoneImpressions[zoneId] = { impressions: 0 };
        }
        zoneImpressions[zoneId].impressions += data.impressions || 0;
      });

      // Get zone names for low-performing zones
      const lowFillZoneIds = Object.entries(zoneImpressions)
        .filter(([_, v]) => v.impressions < 100)
        .map(([id]) => id)
        .filter((id) => id !== "unknown");

      if (lowFillZoneIds.length > 0) {
        const batchIds = lowFillZoneIds.slice(0, 30);
        const zonesSnap = await db
          .collection("zones")
          .where("__name__", "in", batchIds)
          .get();

        zonesSnap.docs.forEach((d) => {
          const zone = d.data();
          alerts.push({
            type: "warning",
            title: "Low Fill Rate",
            message: `Zone "${zone.name || d.id}" has very low impressions in the last 7 days`,
            actionUrl: `/merchant/zones/${d.id}`,
          });
        });
      }
    } catch (e) {
      console.log("[dashboard.js:GET /alerts] Error checking fill rates", e.message);
    }

    // Check for pending creative reviews
    try {
      const campaignSnap = await db
        .collection("campaigns")
        .where("merchantId", "==", merchantId)
        .get();
      const campaignIds = campaignSnap.docs.map((d) => d.id);

      if (campaignIds.length > 0) {
        const batchIds = campaignIds.slice(0, 30);
        const creativeSnap = await db
          .collection("creatives")
          .where("campaignId", "in", batchIds)
          .where("status", "==", "pending_review")
          .get();

        const pendingCount = creativeSnap.size;
        if (pendingCount > 0) {
          alerts.push({
            type: "info",
            title: "Pending Reviews",
            message: `You have ${pendingCount} creative${pendingCount > 1 ? "s" : ""} awaiting review`,
            actionUrl: "/merchant/creative-review",
          });
        }
      }
    } catch (e) {
      console.log("[dashboard.js:GET /alerts] Error checking pending reviews", e.message);
    }

    // Check for campaigns with high budget utilization
    try {
      const campaignSnap = await db
        .collection("campaigns")
        .where("merchantId", "==", merchantId)
        .where("status", "==", "active")
        .get();

      campaignSnap.docs.forEach((d) => {
        const data = d.data();
        const budget = data.budget?.total || 0;
        const spent = data.spent || 0;
        if (budget > 0 && spent / budget > 0.8) {
          alerts.push({
            type: "warning",
            title: "Budget Nearly Exhausted",
            message: `Campaign "${data.name || "Untitled"}" has used ${Math.round((spent / budget) * 100)}% of its budget`,
            actionUrl: `/merchant/analytics`,
          });
        }
      });
    } catch (e) {
      console.log("[dashboard.js:GET /alerts] Error checking campaign budgets", e.message);
    }

    console.log("[dashboard.js:GET /alerts] Returning alerts (200)", { count: alerts.length, merchantId });
    res.json({ alerts });
  } catch (err) {
    console.error("[dashboard.js:GET /alerts] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
