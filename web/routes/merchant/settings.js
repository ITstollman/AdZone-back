import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET /api/merchant/settings
router.get("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[settings.js:GET /] Get settings request", { shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchant = { id: merchantSnap.docs[0].id, ...merchantSnap.docs[0].data() };
    // Don't expose the access token
    delete merchant.shopifyAccessToken;

    console.log("[settings.js:GET /] Returning settings (200)", { merchantId: merchant.id, shop });
    res.json({ merchant });
  } catch (err) {
    console.error("Error getting settings:", err);
    res.status(500).json({ error: "Failed to get settings" });
  }
});

// PUT /api/merchant/settings
router.put("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[settings.js:PUT /] Update settings request", { shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const { settings } = req.body;
    console.log("[settings.js:PUT /] Settings to update", { shop, settingKeys: Object.keys(settings || {}) });
    const docRef = merchantSnap.docs[0].ref;
    await docRef.update({
      settings: {
        ...merchantSnap.docs[0].data().settings,
        ...settings,
      },
      updatedAt: new Date(),
    });

    console.log("[settings.js:PUT /] Settings updated successfully (200)", { shop });
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating settings:", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// POST /api/merchant/settings/export — Export merchant data as CSV
router.post("/export", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[settings.js:POST /export] Export data request", { shop });

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const merchantData = merchantSnap.docs[0].data();

    // Fetch zones
    console.log("[settings.js:POST /export] Fetching zones", { merchantId });
    const zonesSnap = await db
      .collection("zones")
      .where("merchantId", "==", merchantId)
      .get();
    const zones = zonesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Fetch analytics (last 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const startStr = ninetyDaysAgo.toISOString().split("T")[0];

    console.log("[settings.js:POST /export] Fetching analytics", { merchantId, since: startStr });
    const zoneIds = zones.map((z) => z.id);
    let analyticsRows = [];

    if (zoneIds.length > 0) {
      const batches = [];
      for (let i = 0; i < zoneIds.length; i += 30) {
        batches.push(zoneIds.slice(i, i + 30));
      }
      for (const batch of batches) {
        const snap = await db
          .collection("analytics_daily")
          .where("zoneId", "in", batch)
          .where("date", ">=", startStr)
          .get();
        snap.docs.forEach((doc) => {
          analyticsRows.push({ id: doc.id, ...doc.data() });
        });
      }
    }

    // Fetch advertisers
    console.log("[settings.js:POST /export] Fetching advertisers", { merchantId });
    const advertisersSnap = await db
      .collection("advertisers")
      .where("merchantId", "==", merchantId)
      .get();
    const advertisers = advertisersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Fetch campaigns
    console.log("[settings.js:POST /export] Fetching campaigns", { merchantId });
    const campaignsSnap = await db
      .collection("campaigns")
      .where("merchantId", "==", merchantId)
      .get();
    const campaigns = campaignsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // Build CSV
    let csv = "";

    // Merchant section
    csv += "=== MERCHANT INFO ===\n";
    csv += "Shop,Merchant ID,Created\n";
    csv += `"${shop}","${merchantId}","${merchantData.createdAt || ""}"\n\n`;

    // Zones section
    csv += "=== ZONES ===\n";
    csv += "Zone ID,Name,Type,Placement,Status,Min Bid (cents),Created\n";
    zones.forEach((z) => {
      csv += `"${z.id}","${z.name || ""}","${z.type || ""}","${z.placement || ""}","${z.status || ""}",${z.settings?.minBid || 0},"${z.createdAt || ""}"\n`;
    });
    csv += "\n";

    // Analytics section
    csv += "=== ANALYTICS (Last 90 Days) ===\n";
    csv += "Date,Zone ID,Impressions,Clicks,Revenue (cents),Conversions,Conversion Value (cents)\n";
    analyticsRows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    analyticsRows.forEach((a) => {
      csv += `"${a.date || ""}","${a.zoneId || ""}",${a.impressions || 0},${a.clicks || 0},${a.revenue || 0},${a.conversions || 0},${a.conversionValue || 0}\n`;
    });
    csv += "\n";

    // Advertisers section
    csv += "=== ADVERTISERS ===\n";
    csv += "Advertiser ID,Company Name,Email,Status,Created\n";
    advertisers.forEach((a) => {
      csv += `"${a.id}","${a.companyName || ""}","${a.email || ""}","${a.status || ""}","${a.createdAt || ""}"\n`;
    });
    csv += "\n";

    // Campaigns section
    csv += "=== CAMPAIGNS ===\n";
    csv += "Campaign ID,Name,Advertiser ID,Status,Budget (cents),Spent (cents),Created\n";
    campaigns.forEach((c) => {
      csv += `"${c.id}","${c.name || ""}","${c.advertiserId || ""}","${c.status || ""}",${c.budget || 0},${c.spent || 0},"${c.createdAt || ""}"\n`;
    });

    // Update last export timestamp on merchant
    await merchantSnap.docs[0].ref.update({
      "settings.lastExportAt": new Date().toISOString(),
      updatedAt: new Date(),
    });

    console.log("[settings.js:POST /export] Export complete (200)", {
      merchantId,
      zones: zones.length,
      analyticsRows: analyticsRows.length,
      advertisers: advertisers.length,
      campaigns: campaigns.length,
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="adzone-export-${shop}-${new Date().toISOString().split("T")[0]}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("Error exporting data:", err);
    res.status(500).json({ error: "Failed to export data" });
  }
});

// DELETE /api/merchant/settings — Delete merchant account
router.delete("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    const { confirmShopName } = req.body;
    console.log("[settings.js:DELETE /] Delete account request", { shop, confirmShopName });

    if (!confirmShopName || confirmShopName !== shop) {
      console.log("[settings.js:DELETE /] Shop name mismatch", { expected: shop, received: confirmShopName });
      return res.status(400).json({ error: "Shop name does not match. Please type your exact shop name to confirm deletion." });
    }

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    console.log("[settings.js:DELETE /] Deleting merchant data", { merchantId, shop });

    // Delete all zones
    const zonesSnap = await db.collection("zones").where("merchantId", "==", merchantId).get();
    const zoneIds = zonesSnap.docs.map((doc) => doc.id);
    console.log("[settings.js:DELETE /] Deleting zones", { count: zoneIds.length });

    for (const doc of zonesSnap.docs) {
      await doc.ref.delete();
    }

    // Delete all analytics for those zones
    if (zoneIds.length > 0) {
      const batches = [];
      for (let i = 0; i < zoneIds.length; i += 30) {
        batches.push(zoneIds.slice(i, i + 30));
      }
      for (const batch of batches) {
        const analyticsSnap = await db
          .collection("analytics_daily")
          .where("zoneId", "in", batch)
          .get();
        console.log("[settings.js:DELETE /] Deleting analytics batch", { count: analyticsSnap.size });
        for (const doc of analyticsSnap.docs) {
          await doc.ref.delete();
        }
      }
    }

    // Delete all campaigns
    const campaignsSnap = await db.collection("campaigns").where("merchantId", "==", merchantId).get();
    console.log("[settings.js:DELETE /] Deleting campaigns", { count: campaignsSnap.size });
    for (const doc of campaignsSnap.docs) {
      await doc.ref.delete();
    }

    // Delete merchant document
    console.log("[settings.js:DELETE /] Deleting merchant document", { merchantId });
    await merchantSnap.docs[0].ref.delete();

    console.log("[settings.js:DELETE /] Account deleted successfully (200)", { shop, merchantId });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting account:", err);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

export default router;
