import { Router } from "express";
import { db } from "../../firebase.js";
import { z } from "zod";
import { auditLog } from "../../middleware/audit-log.js";

const router = Router();

const campaignSchema = z.object({
  merchantId: z.string().min(1),
  name: z.string().min(1).max(200),
  type: z.enum(["banner", "promoted_product"]),
  budget: z.object({
    total: z.number().min(100), // minimum $1.00 in cents
    daily: z.number().min(100).nullable().optional(),
  }),
  schedule: z.object({
    startDate: z.string(), // ISO date string
    endDate: z.string().nullable().optional(),
  }),
  targetZoneIds: z.array(z.string()).min(1),
  bidStrategy: z.object({
    type: z.enum(["manual", "maximize_clicks", "maximize_conversions", "target_cpa", "target_roas"]).default("manual"),
    targetCpa: z.number().min(1).optional(),
    targetRoas: z.number().min(0.1).optional(),
    maxBid: z.number().min(1).optional(),
  }).optional(),
  pacing: z.enum(["even", "accelerated"]).default("accelerated").optional(),
});

// GET /api/advertiser/campaigns — List campaigns
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { merchantId, status } = req.query;
    console.log("[campaigns.js:GET /] List campaigns request", { advertiserId, merchantId, status });

    let query = db
      .collection("campaigns")
      .where("advertiserId", "==", advertiserId);

    if (merchantId) {
      query = query.where("merchantId", "==", merchantId);
    }
    if (status) {
      query = query.where("status", "==", status);
    }

    const snapshot = await query.get();
    const campaigns = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    console.log("[campaigns.js:GET /] Returning campaigns", { count: campaigns.length, advertiserId });
    res.json({ campaigns });
  } catch (err) {
    console.error("Error listing campaigns:", err);
    res.status(500).json({ error: "Failed to list campaigns" });
  }
});

// GET /api/advertiser/campaigns/:id — Get campaign details
router.get("/:id", async (req, res) => {
  try {
    console.log("[campaigns.js:GET /:id] Get campaign details", { campaignId: req.params.id, advertiserId: req.advertiser.advertiserId });
    const doc = await db.collection("campaigns").doc(req.params.id).get();
    if (!doc.exists) {
      console.log("[campaigns.js:GET /:id] Campaign not found", { campaignId: req.params.id });
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = doc.data();
    if (campaign.advertiserId !== req.advertiser.advertiserId) {
      console.log("[campaigns.js:GET /:id] Access denied", { campaignId: req.params.id });
      return res.status(403).json({ error: "Access denied" });
    }

    console.log("[campaigns.js:GET /:id] Returning campaign details (200)", { campaignId: doc.id, name: campaign.name });
    res.json({ campaign: { id: doc.id, ...campaign } });
  } catch (err) {
    console.error("Error getting campaign:", err);
    res.status(500).json({ error: "Failed to get campaign" });
  }
});

// POST /api/advertiser/campaigns — Create a campaign
router.post("/", async (req, res) => {
  try {
    const parsed = campaignSchema.parse(req.body);
    const { advertiserId } = req.advertiser;
    console.log("[campaigns.js:POST /] Create campaign request", { advertiserId, name: parsed.name, type: parsed.type, merchantId: parsed.merchantId });

    // Verify the advertiser has access to this merchant
    const advertiserDoc = await db.collection("advertisers").doc(advertiserId).get();
    if (!advertiserDoc.exists) {
      return res.status(404).json({ error: "Advertiser not found" });
    }

    const advertiserData = advertiserDoc.data();
    if (!advertiserData.merchantIds.includes(parsed.merchantId)) {
      return res.status(403).json({ error: "Not authorized for this merchant" });
    }

    const campaign = {
      advertiserId,
      merchantId: parsed.merchantId,
      name: parsed.name,
      type: parsed.type,
      status: "draft",
      budget: {
        total: parsed.budget.total,
        daily: parsed.budget.daily || null,
        spent: 0,
      },
      schedule: {
        startDate: parsed.schedule.startDate,
        endDate: parsed.schedule.endDate || null,
      },
      targetZoneIds: parsed.targetZoneIds,
      creativeIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Initialize bid strategy with learning fields if non-manual
    if (parsed.bidStrategy && parsed.bidStrategy.type !== "manual") {
      campaign.bidStrategy = {
        ...parsed.bidStrategy,
        learningStatus: "learning",
        learningConversions: 0,
      };
    } else if (parsed.bidStrategy) {
      campaign.bidStrategy = parsed.bidStrategy;
    }

    if (parsed.pacing) {
      campaign.pacing = parsed.pacing;
    }

    console.log("[campaigns.js:POST /] Creating campaign in DB", { advertiserId, name: parsed.name });
    const docRef = await db.collection("campaigns").add(campaign);
    console.log("[campaigns.js:POST /] Campaign created successfully", { campaignId: docRef.id, name: parsed.name });

    await auditLog({
      actorType: "advertiser",
      actorId: advertiserId,
      action: "campaign.create",
      resourceType: "campaign",
      resourceId: docRef.id,
      changes: { name: parsed.name, type: parsed.type, status: "draft" },
    });

    console.log("[campaigns.js:POST /] Returning created campaign (201)", { campaignId: docRef.id });
    res.status(201).json({ campaign: { id: docRef.id, ...campaign } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[campaigns.js:POST /] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error creating campaign:", err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

// PUT /api/advertiser/campaigns/:id — Update a campaign
router.put("/:id", async (req, res) => {
  try {
    const parsed = campaignSchema.partial().parse(req.body);
    console.log("[campaigns.js:PUT /:id] Update campaign request", { campaignId: req.params.id, updates: Object.keys(parsed) });
    const docRef = db.collection("campaigns").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Initialize learning fields if bid strategy is being set to non-manual
    if (parsed.bidStrategy && parsed.bidStrategy.type !== "manual") {
      parsed.bidStrategy = {
        ...parsed.bidStrategy,
        learningStatus: "learning",
        learningConversions: 0,
      };
    }

    console.log("[campaigns.js:PUT /:id] Updating campaign in DB", { campaignId: req.params.id });
    await docRef.update({ ...parsed, updatedAt: new Date() });

    await auditLog({
      actorType: "advertiser",
      actorId: req.advertiser.advertiserId,
      action: "campaign.update",
      resourceType: "campaign",
      resourceId: req.params.id,
      changes: parsed,
    });

    const updated = await docRef.get();
    console.log("[campaigns.js:PUT /:id] Campaign updated successfully (200)", { campaignId: req.params.id });
    res.json({ campaign: { id: updated.id, ...updated.data() } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[campaigns.js:PUT /:id] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error updating campaign:", err);
    res.status(500).json({ error: "Failed to update campaign" });
  }
});

// PATCH /api/advertiser/campaigns/:id/status — Change campaign status
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    console.log("[campaigns.js:PATCH /:id/status] Status change request", { campaignId: req.params.id, newStatus: status });
    const validTransitions = {
      draft: ["active", "paused"],
      active: ["paused", "completed"],
      paused: ["active", "completed"],
    };

    const docRef = db.collection("campaigns").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const campaign = doc.data();
    if (campaign.advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const allowed = validTransitions[campaign.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from "${campaign.status}" to "${status}"`,
      });
    }

    const previousStatus = campaign.status;
    console.log("[campaigns.js:PATCH /:id/status] Transitioning status", { campaignId: req.params.id, from: previousStatus, to: status });
    await docRef.update({ status, updatedAt: new Date() });

    await auditLog({
      actorType: "advertiser",
      actorId: req.advertiser.advertiserId,
      action: "campaign.status_change",
      resourceType: "campaign",
      resourceId: req.params.id,
      changes: { status: { from: previousStatus, to: status } },
    });

    console.log("[campaigns.js:PATCH /:id/status] Status changed successfully (200)", { campaignId: req.params.id, status });
    res.json({ success: true, status });
  } catch (err) {
    console.error("Error updating campaign status:", err);
    res.status(500).json({ error: "Failed to update campaign status" });
  }
});

// GET /api/advertiser/campaigns/:id/strategy — Get strategy performance
router.get("/:id/strategy", async (req, res) => {
  try {
    console.log("[campaigns.js:GET /:id/strategy] Strategy performance request", { campaignId: req.params.id });
    const { getStrategyPerformance } = await import("../../services/bid-optimizer.js");
    const result = await getStrategyPerformance(req.params.id);
    if (!result) {
      console.log("[campaigns.js:GET /:id/strategy] Campaign not found", { campaignId: req.params.id });
      return res.status(404).json({ error: "Campaign not found" });
    }
    console.log("[campaigns.js:GET /:id/strategy] Returning strategy performance (200)", { campaignId: req.params.id });
    res.json(result);
  } catch (err) {
    console.error("Error getting strategy performance:", err);
    res.status(500).json({ error: "Failed to get strategy performance" });
  }
});

export default router;
