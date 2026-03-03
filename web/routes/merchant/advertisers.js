import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET /api/merchant/advertisers — List advertisers with enriched performance data
router.get("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[advertisers.js:GET /] List advertisers request", { shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const advertisersSnap = await db
      .collection("advertisers")
      .where("merchantIds", "array-contains", merchantId)
      .get();

    // Calculate date 30 days ago for analytics queries
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const advertisers = await Promise.all(
      advertisersSnap.docs.map(async (doc) => {
        const data = doc.data();
        const advertiserId = doc.id;

        // Get campaigns for this advertiser
        const campaignsSnap = await db
          .collection("campaigns")
          .where("advertiserId", "==", advertiserId)
          .get();

        const activeCampaigns = campaignsSnap.docs.filter(
          (c) => c.data().status === "active"
        ).length;

        const totalSpend = campaignsSnap.docs.reduce(
          (sum, c) => sum + (c.data().spent || 0),
          0
        );

        // Find last activity from campaigns
        let lastActivity = data.createdAt;
        campaignsSnap.docs.forEach((c) => {
          const cData = c.data();
          const ts = cData.updatedAt || cData.createdAt;
          if (ts && (!lastActivity || ts > lastActivity)) {
            lastActivity = ts;
          }
        });

        // Get analytics for this advertiser's campaigns (last 30 days)
        let totalImpressions = 0;
        let totalClicks = 0;

        const campaignIds = campaignsSnap.docs.map((c) => c.id);
        if (campaignIds.length > 0) {
          // Firestore 'in' queries support up to 30 items, batch if needed
          const batches = [];
          for (let i = 0; i < campaignIds.length; i += 30) {
            batches.push(campaignIds.slice(i, i + 30));
          }

          for (const batch of batches) {
            const analyticsSnap = await db
              .collection("analytics_daily")
              .where("campaignId", "in", batch)
              .where("date", ">=", thirtyDaysAgoStr)
              .get();

            analyticsSnap.docs.forEach((aDoc) => {
              const aData = aDoc.data();
              totalImpressions += aData.impressions || 0;
              totalClicks += aData.clicks || 0;
            });
          }
        }

        const ctr =
          totalImpressions > 0
            ? ((totalClicks / totalImpressions) * 100).toFixed(2)
            : "0.00";

        console.log("[advertisers.js:GET /] Enriched advertiser", {
          advertiserId,
          activeCampaigns,
          totalSpend,
          totalImpressions,
          totalClicks,
          ctr,
        });

        return {
          id: advertiserId,
          email: data.email,
          name: data.name,
          status: data.status,
          createdAt: data.createdAt,
          activeCampaigns,
          totalSpend,
          impressions: totalImpressions,
          clicks: totalClicks,
          ctr: parseFloat(ctr),
          lastActivity,
        };
      })
    );

    console.log("[advertisers.js:GET /] Returning enriched advertisers (200)", {
      count: advertisers.length,
      merchantId,
    });
    res.json({ advertisers });
  } catch (err) {
    console.error("Error listing advertisers:", err);
    res.status(500).json({ error: "Failed to list advertisers" });
  }
});

// GET /api/merchant/advertisers/:id — Advertiser detail with campaigns and creatives
router.get("/:id", async (req, res) => {
  try {
    const advertiserId = req.params.id;
    console.log("[advertisers.js:GET /:id] Advertiser detail request", { advertiserId });

    const docRef = db.collection("advertisers").doc(advertiserId);
    const doc = await docRef.get();
    if (!doc.exists) {
      console.log("[advertisers.js:GET /:id] Advertiser not found", { advertiserId });
      return res.status(404).json({ error: "Advertiser not found" });
    }

    const advertiserData = doc.data();

    // Get all campaigns for this advertiser
    const campaignsSnap = await db
      .collection("campaigns")
      .where("advertiserId", "==", advertiserId)
      .get();

    const campaignIds = campaignsSnap.docs.map((c) => c.id);

    // Get analytics for all campaigns (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    const campaignAnalytics = {};
    if (campaignIds.length > 0) {
      const batches = [];
      for (let i = 0; i < campaignIds.length; i += 30) {
        batches.push(campaignIds.slice(i, i + 30));
      }

      for (const batch of batches) {
        const analyticsSnap = await db
          .collection("analytics_daily")
          .where("campaignId", "in", batch)
          .where("date", ">=", thirtyDaysAgoStr)
          .get();

        analyticsSnap.docs.forEach((aDoc) => {
          const aData = aDoc.data();
          const cId = aData.campaignId;
          if (!campaignAnalytics[cId]) {
            campaignAnalytics[cId] = { impressions: 0, clicks: 0, spend: 0 };
          }
          campaignAnalytics[cId].impressions += aData.impressions || 0;
          campaignAnalytics[cId].clicks += aData.clicks || 0;
          campaignAnalytics[cId].spend += aData.spend || 0;
        });
      }
    }

    const campaigns = campaignsSnap.docs.map((c) => {
      const cData = c.data();
      const analytics = campaignAnalytics[c.id] || { impressions: 0, clicks: 0, spend: 0 };
      const ctr =
        analytics.impressions > 0
          ? ((analytics.clicks / analytics.impressions) * 100).toFixed(2)
          : "0.00";
      return {
        id: c.id,
        name: cData.name,
        status: cData.status,
        budget: cData.budget || 0,
        spent: cData.spent || 0,
        impressions: analytics.impressions,
        clicks: analytics.clicks,
        ctr: parseFloat(ctr),
        createdAt: cData.createdAt,
        updatedAt: cData.updatedAt,
      };
    });

    // Get all creatives for this advertiser
    const creativesSnap = await db
      .collection("creatives")
      .where("advertiserId", "==", advertiserId)
      .get();

    const creatives = creativesSnap.docs.map((cr) => {
      const crData = cr.data();
      return {
        id: cr.id,
        name: crData.name,
        imageUrl: crData.imageUrl || crData.image || "",
        status: crData.status,
        type: crData.type,
        createdAt: crData.createdAt,
      };
    });

    console.log("[advertisers.js:GET /:id] Returning advertiser detail (200)", {
      advertiserId,
      campaignsCount: campaigns.length,
      creativesCount: creatives.length,
    });

    res.json({
      advertiser: {
        id: advertiserId,
        email: advertiserData.email,
        name: advertiserData.name,
        status: advertiserData.status,
        createdAt: advertiserData.createdAt,
        campaigns,
        creatives,
      },
    });
  } catch (err) {
    console.error("Error fetching advertiser detail:", err);
    res.status(500).json({ error: "Failed to fetch advertiser details" });
  }
});

// GET /api/merchant/advertisers/:id/performance — 30-day daily series
router.get("/:id/performance", async (req, res) => {
  try {
    const advertiserId = req.params.id;
    console.log("[advertisers.js:GET /:id/performance] Performance request", { advertiserId });

    // Get all campaigns for this advertiser
    const campaignsSnap = await db
      .collection("campaigns")
      .where("advertiserId", "==", advertiserId)
      .get();

    const campaignIds = campaignsSnap.docs.map((c) => c.id);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

    // Group analytics by date
    const dateMap = {};

    if (campaignIds.length > 0) {
      const batches = [];
      for (let i = 0; i < campaignIds.length; i += 30) {
        batches.push(campaignIds.slice(i, i + 30));
      }

      for (const batch of batches) {
        const analyticsSnap = await db
          .collection("analytics_daily")
          .where("campaignId", "in", batch)
          .where("date", ">=", thirtyDaysAgoStr)
          .get();

        analyticsSnap.docs.forEach((aDoc) => {
          const aData = aDoc.data();
          const date = aData.date;
          if (!dateMap[date]) {
            dateMap[date] = { date, impressions: 0, clicks: 0, spend: 0 };
          }
          dateMap[date].impressions += aData.impressions || 0;
          dateMap[date].clicks += aData.clicks || 0;
          dateMap[date].spend += aData.spend || 0;
        });
      }
    }

    // Sort by date ascending
    const performance = Object.values(dateMap).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    console.log("[advertisers.js:GET /:id/performance] Returning performance (200)", {
      advertiserId,
      days: performance.length,
    });

    res.json({ performance });
  } catch (err) {
    console.error("Error fetching advertiser performance:", err);
    res.status(500).json({ error: "Failed to fetch performance data" });
  }
});

// PATCH /api/merchant/advertisers/:id/status — Approve/suspend an advertiser
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    console.log("[advertisers.js:PATCH /:id/status] Update advertiser status", { advertiserId: req.params.id, newStatus: status });
    if (!["active", "suspended"].includes(status)) {
      console.log("[advertisers.js:PATCH /:id/status] Invalid status, returning 400", { status });
      return res.status(400).json({ error: "Invalid status" });
    }

    const docRef = db.collection("advertisers").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Advertiser not found" });
    }

    console.log("[advertisers.js:PATCH /:id/status] Updating status in DB", { advertiserId: req.params.id, status });
    await docRef.update({ status, updatedAt: new Date() });
    console.log("[advertisers.js:PATCH /:id/status] Status updated (200)", { advertiserId: req.params.id, status });
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating advertiser status:", err);
    res.status(500).json({ error: "Failed to update advertiser" });
  }
});

export default router;
