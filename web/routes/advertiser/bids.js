import { Router } from "express";
import { db } from "../../firebase.js";
import { cache } from "../../services/cache.js";
import { z } from "zod";
import { auditLog } from "../../middleware/audit-log.js";
import { computeQualityScore } from "../../services/quality-score.js";

const router = Router();

const bidSchema = z.object({
  campaignId: z.string().min(1),
  zoneId: z.string().min(1),
  bidType: z.enum(["cpm", "cpc", "cpa"]).default("cpm"),
  amount: z.number().min(1), // Amount in cents
  maxBid: z.number().min(1).optional(),
  modifiers: z.object({
    device: z.record(z.number().min(0.1).max(5.0)).optional(),
    geo: z.record(z.number().min(0.1).max(5.0)).optional(),
    daypart: z.record(z.number().min(0.1).max(5.0)).optional(),
    audience: z.record(z.number().min(0.1).max(5.0)).optional(),
  }).optional(),
});

const modifiersSchema = z.object({
  device: z.record(z.number().min(0.1).max(5.0)).optional(),
  geo: z.record(z.number().min(0.1).max(5.0)).optional(),
  daypart: z.record(z.number().min(0.1).max(5.0)).optional(),
  audience: z.record(z.number().min(0.1).max(5.0)).optional(),
});

// GET /api/advertiser/bids — List bids
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId } = req.query;
    console.log("[bids.js:GET /] List bids request", { advertiserId, campaignId });

    let query = db.collection("bids").where("advertiserId", "==", advertiserId);

    if (campaignId) {
      query = query.where("campaignId", "==", campaignId);
    }

    const snapshot = await query.get();
    const bids = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    console.log("[bids.js:GET /] Returning bids", { count: bids.length, advertiserId });
    res.json({ bids });
  } catch (err) {
    console.error("Error listing bids:", err);
    res.status(500).json({ error: "Failed to list bids" });
  }
});

// GET /api/advertiser/bids/zones/:merchantId — List available zones for a merchant
router.get("/zones/:merchantId", async (req, res) => {
  try {
    console.log("[bids.js:GET /zones/:merchantId] List zones request", { merchantId: req.params.merchantId });
    const snapshot = await db
      .collection("zones")
      .where("merchantId", "==", req.params.merchantId)
      .where("status", "==", "active")
      .get();

    // Fetch estimated CTR for each zone from analytics_daily
    const zones = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const data = doc.data();
        let estimatedCtr = 0.01; // default

        try {
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
          const dateStr = thirtyDaysAgo.toISOString().split("T")[0];

          const analyticsSnap = await db.collection("analytics_daily")
            .where("zoneId", "==", doc.id)
            .where("date", ">=", dateStr)
            .get();

          let totalImpressions = 0;
          let totalClicks = 0;
          analyticsSnap.docs.forEach(d => {
            const stats = d.data();
            totalImpressions += stats.impressions || 0;
            totalClicks += stats.clicks || 0;
          });

          if (totalImpressions > 0) {
            estimatedCtr = totalClicks / totalImpressions;
          }
        } catch {
          // Use default CTR on error
        }

        return {
          id: doc.id,
          name: data.name,
          slug: data.slug,
          type: data.type,
          placement: data.placement,
          dimensions: data.dimensions,
          minBid: data.settings?.minBid || 100,
          estimatedCtr,
        };
      })
    );

    console.log("[bids.js:GET /zones/:merchantId] Returning zones", { count: zones.length });
    res.json({ zones });
  } catch (err) {
    console.error("Error listing zones:", err);
    res.status(500).json({ error: "Failed to list zones" });
  }
});

// GET /api/advertiser/bids/quality-score/:campaignId — Quality score breakdown per creative
router.get("/quality-score/:campaignId", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId } = req.params;
    console.log("[bids.js:GET /quality-score/:campaignId] Quality score request", { advertiserId, campaignId });

    // Verify the campaign belongs to this advertiser
    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignDoc.data().advertiserId !== advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const campaign = { id: campaignDoc.id, ...campaignDoc.data() };

    // Load all creatives for this campaign
    const creativesSnap = await db.collection("creatives")
      .where("campaignId", "==", campaignId)
      .get();

    if (creativesSnap.empty) {
      return res.json({ qualityScores: [] });
    }

    const creatives = creativesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Find zones this campaign is bidding on for context
    const bidsSnap = await db.collection("bids")
      .where("campaignId", "==", campaignId)
      .where("status", "==", "active")
      .get();

    // Use the first active bid's zone for quality score context, or a minimal zone object
    let zone = { id: "default", context: null };
    if (!bidsSnap.empty) {
      const zoneId = bidsSnap.docs[0].data().zoneId;
      const zoneDoc = await db.collection("zones").doc(zoneId).get();
      if (zoneDoc.exists) {
        zone = { id: zoneDoc.id, ...zoneDoc.data() };
      }
    }

    // Compute quality scores in parallel
    const qualityScores = await Promise.all(
      creatives.map(async (creative) => {
        const qualityScore = await computeQualityScore(campaign, creative, zone);
        return {
          creativeId: creative.id,
          name: creative.name || creative.altText || creative.id,
          qualityScore,
        };
      })
    );

    console.log("[bids.js:GET /quality-score/:campaignId] Returning quality scores", { count: qualityScores.length, campaignId });
    res.json({ qualityScores });
  } catch (err) {
    console.error("Error computing quality scores:", err);
    res.status(500).json({ error: "Failed to compute quality scores" });
  }
});

// POST /api/advertiser/bids — Place a new bid
router.post("/", async (req, res) => {
  try {
    const parsed = bidSchema.parse(req.body);
    const { advertiserId } = req.advertiser;
    console.log("[bids.js:POST /] Place bid request", { advertiserId, campaignId: parsed.campaignId, zoneId: parsed.zoneId, bidType: parsed.bidType, amount: parsed.amount });

    // Verify the campaign belongs to this advertiser
    const campaignDoc = await db.collection("campaigns").doc(parsed.campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignDoc.data().advertiserId !== advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Verify the zone exists and is active
    const zoneDoc = await db.collection("zones").doc(parsed.zoneId).get();
    if (!zoneDoc.exists || zoneDoc.data().status !== "active") {
      return res.status(404).json({ error: "Zone not found or inactive" });
    }

    // Check bid meets minimum
    const minBid = zoneDoc.data().settings?.minBid || 100;
    if (parsed.amount < minBid) {
      return res.status(400).json({
        error: `Bid must be at least ${minBid} cents ($${(minBid / 100).toFixed(2)} CPM)`,
      });
    }

    // Check for existing bid on this zone from this campaign
    const existingBid = await db
      .collection("bids")
      .where("campaignId", "==", parsed.campaignId)
      .where("zoneId", "==", parsed.zoneId)
      .where("status", "==", "active")
      .limit(1)
      .get();

    if (!existingBid.empty) {
      return res.status(409).json({
        error: "Active bid already exists for this zone. Update it instead.",
        existingBidId: existingBid.docs[0].id,
      });
    }

    const bid = {
      advertiserId,
      campaignId: parsed.campaignId,
      zoneId: parsed.zoneId,
      merchantId: zoneDoc.data().merchantId,
      bidType: parsed.bidType,
      amount: parsed.amount,
      ...(parsed.maxBid !== undefined && { maxBid: parsed.maxBid }),
      ...(parsed.modifiers !== undefined && { modifiers: parsed.modifiers }),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("[bids.js:POST /] Creating bid in DB", { campaignId: parsed.campaignId, zoneId: parsed.zoneId, amount: parsed.amount });
    const docRef = await db.collection("bids").add(bid);
    console.log("[bids.js:POST /] Bid placed successfully", { bidId: docRef.id });

    // Invalidate auction cache for this zone
    const zone = zoneDoc.data();
    const merchantDoc = await db.collection("merchants").doc(zone.merchantId).get();
    if (merchantDoc.exists) {
      cache.del(`auction:${merchantDoc.data().shopifyShopId}:${zone.slug}`);
    }

    await auditLog({
      actorType: "advertiser",
      actorId: advertiserId,
      action: "bid.place",
      resourceType: "bid",
      resourceId: docRef.id,
      changes: { campaignId: parsed.campaignId, zoneId: parsed.zoneId, amount: parsed.amount, bidType: parsed.bidType },
    });

    console.log("[bids.js:POST /] Returning created bid (201)", { bidId: docRef.id });
    res.status(201).json({ bid: { id: docRef.id, ...bid } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[bids.js:POST /] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error placing bid:", err);
    res.status(500).json({ error: "Failed to place bid" });
  }
});

// PUT /api/advertiser/bids/:id — Update bid amount
router.put("/:id", async (req, res) => {
  try {
    const { amount } = z.object({ amount: z.number().min(1) }).parse(req.body);
    console.log("[bids.js:PUT /:id] Update bid request", { bidId: req.params.id, newAmount: amount });
    const docRef = db.collection("bids").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bid not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Check against zone minimum
    const zoneDoc = await db.collection("zones").doc(doc.data().zoneId).get();
    const minBid = zoneDoc.data()?.settings?.minBid || 100;
    if (amount < minBid) {
      return res.status(400).json({
        error: `Bid must be at least ${minBid} cents ($${(minBid / 100).toFixed(2)} CPM)`,
      });
    }

    console.log("[bids.js:PUT /:id] Updating bid amount in DB", { bidId: req.params.id, amount });
    await docRef.update({ amount, updatedAt: new Date() });

    // Invalidate auction cache
    const zone = zoneDoc.data();
    const merchantDoc = await db.collection("merchants").doc(zone.merchantId).get();
    if (merchantDoc.exists) {
      cache.del(`auction:${merchantDoc.data().shopifyShopId}:${zone.slug}`);
    }

    console.log("[bids.js:PUT /:id] Bid updated successfully (200)", { bidId: req.params.id, amount });
    res.json({ success: true, amount });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error updating bid:", err);
    res.status(500).json({ error: "Failed to update bid" });
  }
});

// PUT /api/advertiser/bids/:id/modifiers — Update bid modifiers only
router.put("/:id/modifiers", async (req, res) => {
  try {
    const modifiers = modifiersSchema.parse(req.body);
    console.log("[bids.js:PUT /:id/modifiers] Update bid modifiers request", { bidId: req.params.id, modifiers });
    const docRef = db.collection("bids").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bid not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    await docRef.update({ modifiers, updatedAt: new Date() });

    // Invalidate auction cache
    const zoneDoc = await db.collection("zones").doc(doc.data().zoneId).get();
    if (zoneDoc.exists) {
      const zone = zoneDoc.data();
      const merchantDoc = await db.collection("merchants").doc(zone.merchantId).get();
      if (merchantDoc.exists) {
        cache.del(`auction:${merchantDoc.data().shopifyShopId}:${zone.slug}`);
      }
    }

    await auditLog({
      actorType: "advertiser",
      actorId: req.advertiser.advertiserId,
      action: "bid.update_modifiers",
      resourceType: "bid",
      resourceId: req.params.id,
      changes: { modifiers },
    });

    console.log("[bids.js:PUT /:id/modifiers] Modifiers updated successfully (200)", { bidId: req.params.id });
    res.json({ success: true, modifiers });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[bids.js:PUT /:id/modifiers] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error updating bid modifiers:", err);
    res.status(500).json({ error: "Failed to update bid modifiers" });
  }
});

// DELETE /api/advertiser/bids/:id — Withdraw a bid
router.delete("/:id", async (req, res) => {
  try {
    console.log("[bids.js:DELETE /:id] Withdraw bid request", { bidId: req.params.id });
    const docRef = db.collection("bids").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Bid not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    console.log("[bids.js:DELETE /:id] Withdrawing bid", { bidId: req.params.id });
    await docRef.update({ status: "withdrawn", updatedAt: new Date() });

    // Invalidate auction cache
    const zoneDoc = await db.collection("zones").doc(doc.data().zoneId).get();
    if (zoneDoc.exists) {
      const zone = zoneDoc.data();
      const merchantDoc = await db.collection("merchants").doc(zone.merchantId).get();
      if (merchantDoc.exists) {
        cache.del(`auction:${merchantDoc.data().shopifyShopId}:${zone.slug}`);
      }
    }

    await auditLog({
      actorType: "advertiser",
      actorId: req.advertiser.advertiserId,
      action: "bid.withdraw",
      resourceType: "bid",
      resourceId: req.params.id,
      changes: { status: { from: "active", to: "withdrawn" } },
    });

    console.log("[bids.js:DELETE /:id] Bid withdrawn successfully (200)", { bidId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("Error withdrawing bid:", err);
    res.status(500).json({ error: "Failed to withdraw bid" });
  }
});

export default router;
