import { Router } from "express";
import { db } from "../../firebase.js";
import { z } from "zod";
import { analyzePageContext } from "../../services/context-analyzer.js";

const router = Router();

const zoneSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(["banner", "promoted_product", "carousel", "product_grid", "sticky", "native_feed"]),
  placement: z.enum(["homepage", "collection", "product", "cart", "global"]),
  dimensions: z.object({
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    aspectRatio: z.string().optional(),
  }).optional(),
  settings: z.object({
    minBid: z.number().min(1).default(100), // cents
    maxAdsPerRotation: z.number().min(1).max(10).default(1),
    rotationInterval: z.number().min(5).default(30),
  }).optional(),
});

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Fetch 7-day analytics for a list of zone IDs.
 * Returns a map: { zoneId: { impressions, revenue, clicks } }
 */
async function getZoneAnalytics7d(zoneIds, daysBack = 7) {
  if (!zoneIds.length) return {};

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);
  const startStr = startDate.toISOString().split("T")[0];

  const result = {};
  zoneIds.forEach((id) => {
    result[id] = { impressions: 0, revenue: 0, clicks: 0 };
  });

  // Firestore 'in' queries limited to 30 at a time
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
      const d = doc.data();
      if (result[d.zoneId]) {
        result[d.zoneId].impressions += d.impressions || 0;
        result[d.zoneId].revenue += d.revenue || 0;
        result[d.zoneId].clicks += d.clicks || 0;
      }
    });
  }

  return result;
}

/**
 * Fetch analytics for two separate week windows for trend comparison.
 * Returns a map: { zoneId: { thisWeek: { revenue }, lastWeek: { revenue } } }
 */
async function getZoneTrendData(zoneIds) {
  if (!zoneIds.length) return {};

  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStart = new Date(now);
  lastWeekStart.setDate(lastWeekStart.getDate() - 14);

  const thisWeekStr = thisWeekStart.toISOString().split("T")[0];
  const lastWeekStr = lastWeekStart.toISOString().split("T")[0];

  const result = {};
  zoneIds.forEach((id) => {
    result[id] = { thisWeek: { revenue: 0 }, lastWeek: { revenue: 0 } };
  });

  const batches = [];
  for (let i = 0; i < zoneIds.length; i += 30) {
    batches.push(zoneIds.slice(i, i + 30));
  }

  for (const batch of batches) {
    const snap = await db
      .collection("analytics_daily")
      .where("zoneId", "in", batch)
      .where("date", ">=", lastWeekStr)
      .get();

    snap.docs.forEach((doc) => {
      const d = doc.data();
      if (!result[d.zoneId]) return;
      if (d.date >= thisWeekStr) {
        result[d.zoneId].thisWeek.revenue += d.revenue || 0;
      } else {
        result[d.zoneId].lastWeek.revenue += d.revenue || 0;
      }
    });
  }

  return result;
}

/**
 * Compute health score for a zone (0-100).
 * - fillRate weight: 40%
 * - eCPM relative to floor price weight: 30%
 * - recent trend weight: 30%
 */
function computeHealthScore(fillRate, eCPM, floorPrice, trendDirection) {
  // Fill rate component (0-100, scaled by 40%)
  const fillScore = Math.min(fillRate * 100, 100) * 0.4;

  // eCPM component: how well eCPM compares to floor price (0-100, scaled by 30%)
  const floorCPM = floorPrice ? (floorPrice / 100) : 1; // convert cents to dollars
  const eCPMRatio = floorCPM > 0 ? Math.min(eCPM / floorCPM, 2) / 2 : 0.5;
  const eCPMScore = eCPMRatio * 100 * 0.3;

  // Trend component (0-100, scaled by 30%)
  let trendScore = 50; // flat
  if (trendDirection === "up") trendScore = 90;
  else if (trendDirection === "down") trendScore = 20;
  const trendComponent = trendScore * 0.3;

  return Math.round(fillScore + eCPMScore + trendComponent);
}

// GET /api/merchant/zones — List all zones for the merchant (enriched with 7d analytics)
router.get("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[zones.js:GET /] List zones request", { shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const zonesSnap = await db
      .collection("zones")
      .where("merchantId", "==", merchantId)
      .where("status", "in", ["active", "paused"])
      .get();

    const zones = zonesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const zoneIds = zones.map((z) => z.id);

    // Fetch 7-day analytics and trend data in parallel
    console.log("[zones.js:GET /] Fetching 7d analytics for zones", { count: zoneIds.length });
    const [analytics7d, trendData] = await Promise.all([
      getZoneAnalytics7d(zoneIds),
      getZoneTrendData(zoneIds),
    ]);

    // Enrich each zone with analytics metrics
    const enrichedZones = zones.map((zone) => {
      const a = analytics7d[zone.id] || { impressions: 0, revenue: 0, clicks: 0 };
      const trend = trendData[zone.id] || { thisWeek: { revenue: 0 }, lastWeek: { revenue: 0 } };

      const impressions7d = a.impressions;
      const revenue7d = a.revenue;
      const clicks7d = a.clicks;

      // Estimate requests as impressions * 1.5 (approximation since we don't track requests directly)
      const estimatedRequests = Math.max(impressions7d * 1.5, impressions7d + 100);
      const fillRate = estimatedRequests > 0 ? impressions7d / estimatedRequests : 0;

      const eCPM = impressions7d > 0 ? (revenue7d / impressions7d) * 1000 / 100 : 0;

      // Trend direction
      let trendDirection = "flat";
      if (trend.thisWeek.revenue > trend.lastWeek.revenue * 1.1) trendDirection = "up";
      else if (trend.thisWeek.revenue < trend.lastWeek.revenue * 0.9) trendDirection = "down";

      const floorPrice = zone.settings?.minBid || 100;
      const healthScore = computeHealthScore(fillRate, eCPM, floorPrice, trendDirection);

      return {
        ...zone,
        impressions7d,
        revenue7d,
        clicks7d,
        fillRate: Math.round(fillRate * 100) / 100, // 0-1 decimal
        eCPM: Math.round(eCPM * 100) / 100,
        healthScore,
        trend: trendDirection,
      };
    });

    console.log("[zones.js:GET /] Returning enriched zones (200)", { count: enrichedZones.length, merchantId });
    res.json({ zones: enrichedZones });
  } catch (err) {
    console.error("Error listing zones:", err);
    res.status(500).json({ error: "Failed to list zones" });
  }
});

// GET /api/merchant/zones/rankings — Zone rankings sorted by revenue
router.get("/rankings", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[zones.js:GET /rankings] Zone rankings request", { shop });

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const zonesSnap = await db
      .collection("zones")
      .where("merchantId", "==", merchantId)
      .where("status", "in", ["active", "paused"])
      .get();

    const zones = zonesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const zoneIds = zones.map((z) => z.id);

    console.log("[zones.js:GET /rankings] Fetching analytics for rankings", { zoneCount: zoneIds.length });
    const [analytics7d, trendData] = await Promise.all([
      getZoneAnalytics7d(zoneIds),
      getZoneTrendData(zoneIds),
    ]);

    const rankings = zones.map((zone) => {
      const a = analytics7d[zone.id] || { impressions: 0, revenue: 0, clicks: 0 };
      const trend = trendData[zone.id] || { thisWeek: { revenue: 0 }, lastWeek: { revenue: 0 } };

      const estimatedRequests = Math.max(a.impressions * 1.5, a.impressions + 100);
      const fillRate = estimatedRequests > 0 ? a.impressions / estimatedRequests : 0;
      const eCPM = a.impressions > 0 ? (a.revenue / a.impressions) * 1000 / 100 : 0;

      let trendDirection = "flat";
      if (trend.thisWeek.revenue > trend.lastWeek.revenue * 1.1) trendDirection = "up";
      else if (trend.thisWeek.revenue < trend.lastWeek.revenue * 0.9) trendDirection = "down";

      return {
        id: zone.id,
        name: zone.name,
        revenue: a.revenue,
        impressions: a.impressions,
        fillRate: Math.round(fillRate * 100) / 100,
        eCPM: Math.round(eCPM * 100) / 100,
        trend: trendDirection,
      };
    });

    // Sort by revenue descending and assign ranks
    rankings.sort((a, b) => b.revenue - a.revenue);
    rankings.forEach((r, i) => {
      r.rank = i + 1;
    });

    console.log("[zones.js:GET /rankings] Returning rankings (200)", { count: rankings.length });
    res.json({ rankings });
  } catch (err) {
    console.error("Error fetching zone rankings:", err);
    res.status(500).json({ error: "Failed to fetch zone rankings" });
  }
});

// GET /api/merchant/zones/:id/suggestions — Optimization suggestions for a zone
router.get("/:id/suggestions", async (req, res) => {
  try {
    const zoneId = req.params.id;
    const shop = res.locals.shopify.session.shop;
    console.log("[zones.js:GET /:id/suggestions] Suggestions request", { shop, zoneId });

    const zoneDoc = await db.collection("zones").doc(zoneId).get();
    if (!zoneDoc.exists) {
      console.log("[zones.js:GET /:id/suggestions] Zone not found", { zoneId });
      return res.status(404).json({ error: "Zone not found" });
    }

    const zone = zoneDoc.data();
    const analytics7d = await getZoneAnalytics7d([zoneId]);
    const trendData = await getZoneTrendData([zoneId]);

    const a = analytics7d[zoneId] || { impressions: 0, revenue: 0, clicks: 0 };
    const trend = trendData[zoneId] || { thisWeek: { revenue: 0 }, lastWeek: { revenue: 0 } };

    const estimatedRequests = Math.max(a.impressions * 1.5, a.impressions + 100);
    const fillRate = estimatedRequests > 0 ? a.impressions / estimatedRequests : 0;
    const eCPM = a.impressions > 0 ? (a.revenue / a.impressions) * 1000 / 100 : 0;
    const floorCPM = (zone.settings?.minBid || 100) / 100;

    const suggestions = [];

    // Check fill rate
    if (fillRate < 0.3) {
      suggestions.push({
        type: "warning",
        title: "Low Fill Rate",
        description: `Your fill rate is ${(fillRate * 100).toFixed(1)}%, which means many ad requests go unfilled. Consider lowering your floor price from $${floorCPM.toFixed(2)} CPM to attract more advertisers.`,
        action: "Lower floor price",
      });
    }

    // High eCPM but low fill rate
    if (eCPM > floorCPM * 1.5 && fillRate < 0.5) {
      suggestions.push({
        type: "tip",
        title: "Broaden Targeting",
        description: `Your eCPM ($${eCPM.toFixed(2)}) is strong, but fill rate is low. Consider broadening your zone's allowed creative formats or placements to attract more campaigns.`,
        action: "Edit zone settings",
      });
    }

    // Impressions declining
    if (trend.thisWeek.revenue < trend.lastWeek.revenue * 0.7 && trend.lastWeek.revenue > 0) {
      suggestions.push({
        type: "warning",
        title: "Declining Performance",
        description: "This zone's revenue has dropped significantly compared to last week. Check that the zone is properly placed in your theme and is visible to visitors.",
        action: "Check zone placement",
      });
    }

    // No recent activity
    if (a.impressions === 0 && a.revenue === 0) {
      suggestions.push({
        type: "warning",
        title: "No Recent Activity",
        description: "This zone has had no impressions or revenue in the last 7 days. Verify that the zone is active and properly embedded in your store's theme.",
        action: "Verify zone installation",
      });
    }

    // Good performance
    if (fillRate >= 0.7 && eCPM >= floorCPM) {
      suggestions.push({
        type: "success",
        title: "Strong Performance",
        description: `This zone is performing well with a ${(fillRate * 100).toFixed(1)}% fill rate and $${eCPM.toFixed(2)} eCPM. Consider increasing your floor price to maximize revenue.`,
        action: "Increase floor price",
      });
    }

    // Good fill rate, could optimize eCPM
    if (fillRate >= 0.5 && eCPM < floorCPM * 0.8 && eCPM > 0) {
      suggestions.push({
        type: "tip",
        title: "Optimize eCPM",
        description: `Your fill rate is healthy at ${(fillRate * 100).toFixed(1)}%, but eCPM ($${eCPM.toFixed(2)}) is below your floor price. Consider premium ad formats or better-positioned placements.`,
      });
    }

    console.log("[zones.js:GET /:id/suggestions] Returning suggestions (200)", { zoneId, count: suggestions.length });
    res.json({ suggestions });
  } catch (err) {
    console.error("Error getting zone suggestions:", err);
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

// POST /api/merchant/zones/bulk-action — Bulk zone actions
router.post("/bulk-action", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    const { zoneIds, action } = req.body;
    console.log("[zones.js:POST /bulk-action] Bulk action request", { shop, action, zoneCount: zoneIds?.length });

    if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
      return res.status(400).json({ error: "zoneIds must be a non-empty array" });
    }

    const validActions = ["activate", "pause", "archive"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
    }

    // Map action to status
    const statusMap = {
      activate: "active",
      pause: "paused",
      archive: "archived",
    };
    const newStatus = statusMap[action];

    // Verify merchant ownership
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const batch = db.batch();
    let updatedCount = 0;

    for (const zoneId of zoneIds) {
      const zoneRef = db.collection("zones").doc(zoneId);
      const zoneDoc = await zoneRef.get();
      if (zoneDoc.exists && zoneDoc.data().merchantId === merchantId) {
        batch.update(zoneRef, { status: newStatus, updatedAt: new Date() });
        updatedCount++;
      }
    }

    await batch.commit();
    console.log("[zones.js:POST /bulk-action] Bulk action completed (200)", { action, updatedCount });
    res.json({ updated: updatedCount });
  } catch (err) {
    console.error("Error performing bulk action:", err);
    res.status(500).json({ error: "Failed to perform bulk action" });
  }
});

// GET /api/merchant/zones/:id — Get zone details
router.get("/:id", async (req, res) => {
  try {
    console.log("[zones.js:GET /:id] Get zone details", { zoneId: req.params.id });
    const doc = await db.collection("zones").doc(req.params.id).get();
    if (!doc.exists) {
      console.log("[zones.js:GET /:id] Zone not found", { zoneId: req.params.id });
      return res.status(404).json({ error: "Zone not found" });
    }
    console.log("[zones.js:GET /:id] Returning zone details (200)", { zoneId: doc.id, name: doc.data().name });
    res.json({ zone: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("Error getting zone:", err);
    res.status(500).json({ error: "Failed to get zone" });
  }
});

// POST /api/merchant/zones — Create a new zone
router.post("/", async (req, res) => {
  try {
    const parsed = zoneSchema.parse(req.body);
    const shop = res.locals.shopify.session.shop;
    console.log("[zones.js:POST /] Create zone request", { shop, name: parsed.name, type: parsed.type, placement: parsed.placement });

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    const slug = slugify(parsed.name);

    const zone = {
      merchantId,
      name: parsed.name,
      slug,
      type: parsed.type,
      placement: parsed.placement,
      dimensions: parsed.dimensions || { width: null, height: 250, aspectRatio: "auto" },
      settings: {
        minBid: parsed.settings?.minBid || 100,
        maxAdsPerRotation: parsed.settings?.maxAdsPerRotation || 1,
        rotationInterval: parsed.settings?.rotationInterval || 30,
        allowedCreativeFormats: ["image/jpeg", "image/png", "image/gif", "image/webp"],
        maxFileSize: 2 * 1024 * 1024, // 2MB
      },
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("[zones.js:POST /] Creating zone in DB", { merchantId, name: parsed.name, slug });
    const docRef = await db.collection("zones").add(zone);
    console.log("[zones.js:POST /] Zone created successfully (201)", { zoneId: docRef.id, name: parsed.name });
    res.status(201).json({ zone: { id: docRef.id, ...zone } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error creating zone:", err);
    res.status(500).json({ error: "Failed to create zone" });
  }
});

// PUT /api/merchant/zones/:id — Update a zone
router.put("/:id", async (req, res) => {
  try {
    const parsed = zoneSchema.partial().parse(req.body);
    console.log("[zones.js:PUT /:id] Update zone request", { zoneId: req.params.id, updates: Object.keys(parsed) });
    const docRef = db.collection("zones").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Zone not found" });
    }

    const updates = { ...parsed, updatedAt: new Date() };
    if (parsed.name) {
      updates.slug = slugify(parsed.name);
    }

    console.log("[zones.js:PUT /:id] Updating zone in DB", { zoneId: req.params.id });
    await docRef.update(updates);
    const updated = await docRef.get();
    console.log("[zones.js:PUT /:id] Zone updated successfully (200)", { zoneId: req.params.id });
    res.json({ zone: { id: updated.id, ...updated.data() } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error updating zone:", err);
    res.status(500).json({ error: "Failed to update zone" });
  }
});

// DELETE /api/merchant/zones/:id — Soft-delete (archive) a zone
router.delete("/:id", async (req, res) => {
  try {
    console.log("[zones.js:DELETE /:id] Delete zone request (soft-delete)", { zoneId: req.params.id });
    const docRef = db.collection("zones").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Zone not found" });
    }

    console.log("[zones.js:DELETE /:id] Archiving zone in DB", { zoneId: req.params.id });
    await docRef.update({ status: "archived", updatedAt: new Date() });
    console.log("[zones.js:DELETE /:id] Zone archived successfully (200)", { zoneId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting zone:", err);
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

// POST /api/merchant/zones/:id/analyze-context — trigger Claude AI analysis of zone's page
router.post("/:id/analyze-context", async (req, res) => {
  try {
    console.log("[zones.js:POST /:id/analyze-context] Zone context analysis request", { zoneId: req.params.id });
    const zoneDoc = await db.collection("zones").doc(req.params.id).get();
    if (!zoneDoc.exists) {
      return res.status(404).json({ error: "Zone not found" });
    }

    const zone = zoneDoc.data();
    const shop = res.locals.shopify.session.shop;

    // Get merchant ID to verify ownership
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    if (zone.merchantId !== merchantId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Determine page URL: from request body, or construct from zone settings
    const pageUrl =
      req.body.pageUrl ||
      `https://${shop}/${zone.placement === "homepage" ? "" : zone.placement}`;

    console.log("[zones.js:POST /:id/analyze-context] Analyzing page context", { zoneId: req.params.id, pageUrl, merchantId });
    const context = await analyzePageContext(pageUrl, req.params.id, merchantId);
    console.log("[zones.js:POST /:id/analyze-context] Context analysis complete (200)", { zoneId: req.params.id });
    res.json({ context });
  } catch (err) {
    console.error("Error analyzing zone context:", err);
    res.status(500).json({ error: "Failed to analyze context" });
  }
});

export default router;
