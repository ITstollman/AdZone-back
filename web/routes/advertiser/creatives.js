import { Router } from "express";
import multer from "multer";
import { db } from "../../firebase.js";
import { z } from "zod";
import {
  validateImage,
  uploadCreativeImage,
} from "../../services/creative-storage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = Router();

const creativeSchema = z.object({
  campaignId: z.string().min(1),
  type: z.enum(["banner_image", "promoted_product"]),
  name: z.string().min(1).max(200),
  imageUrl: z.string().url().optional(),
  altText: z.string().max(200).optional(),
  dimensions: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }).optional(),
  productData: z.object({
    shopifyProductId: z.string(),
    title: z.string(),
    imageUrl: z.string().url(),
    price: z.string(),
    compareAtPrice: z.string().nullable().optional(),
    handle: z.string(),
  }).optional(),
  destinationUrl: z.string().min(1), // Internal store URL
});

// GET /api/advertiser/creatives — List creatives
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId } = req.query;
    console.log("[creatives.js:GET /] List creatives request", { advertiserId, campaignId });

    let query = db
      .collection("creatives")
      .where("advertiserId", "==", advertiserId);

    if (campaignId) {
      query = query.where("campaignId", "==", campaignId);
    }

    const snapshot = await query.get();
    const creatives = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    console.log("[creatives.js:GET /] Returning creatives", { count: creatives.length, advertiserId });
    res.json({ creatives });
  } catch (err) {
    console.error("Error listing creatives:", err);
    res.status(500).json({ error: "Failed to list creatives" });
  }
});

// POST /api/advertiser/creatives — Create a creative
router.post("/", async (req, res) => {
  try {
    const parsed = creativeSchema.parse(req.body);
    const { advertiserId } = req.advertiser;
    console.log("[creatives.js:POST /] Create creative request", { advertiserId, name: parsed.name, type: parsed.type, campaignId: parsed.campaignId });

    // Verify the campaign belongs to this advertiser
    const campaignDoc = await db.collection("campaigns").doc(parsed.campaignId).get();
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (campaignDoc.data().advertiserId !== advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Validate destination URL is internal (relative path)
    if (!parsed.destinationUrl.startsWith("/")) {
      return res.status(400).json({
        error: "Destination URL must be a relative path (e.g., /products/my-product)",
      });
    }

    const creative = {
      advertiserId,
      campaignId: parsed.campaignId,
      type: parsed.type,
      name: parsed.name,
      imageUrl: parsed.imageUrl || null,
      altText: parsed.altText || "",
      dimensions: parsed.dimensions || null,
      productData: parsed.productData || null,
      destinationUrl: parsed.destinationUrl,
      status: "pending_review",
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
    };

    console.log("[creatives.js:POST /] Creating creative in DB", { name: parsed.name, campaignId: parsed.campaignId });
    const docRef = await db.collection("creatives").add(creative);
    console.log("[creatives.js:POST /] Creative created, adding to campaign", { creativeId: docRef.id, campaignId: parsed.campaignId });

    // Add creative ID to the campaign
    await db.collection("campaigns").doc(parsed.campaignId).update({
      creativeIds: [...(campaignDoc.data().creativeIds || []), docRef.id],
      updatedAt: new Date(),
    });

    console.log("[creatives.js:POST /] Returning created creative (201)", { creativeId: docRef.id });
    res.status(201).json({ creative: { id: docRef.id, ...creative } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[creatives.js:POST /] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error creating creative:", err);
    res.status(500).json({ error: "Failed to create creative" });
  }
});

// PUT /api/advertiser/creatives/:id — Update a creative
router.put("/:id", async (req, res) => {
  try {
    const parsed = creativeSchema.partial().parse(req.body);
    console.log("[creatives.js:PUT /:id] Update creative request", { creativeId: req.params.id, updates: Object.keys(parsed) });
    const docRef = db.collection("creatives").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Creative not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Editing resets approval status
    const updates = {
      ...parsed,
      status: "pending_review",
      updatedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
    };

    console.log("[creatives.js:PUT /:id] Updating creative in DB (resets to pending_review)", { creativeId: req.params.id });
    await docRef.update(updates);
    const updated = await docRef.get();
    console.log("[creatives.js:PUT /:id] Creative updated successfully (200)", { creativeId: req.params.id, status: "pending_review" });
    res.json({ creative: { id: updated.id, ...updated.data() } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error updating creative:", err);
    res.status(500).json({ error: "Failed to update creative" });
  }
});

// DELETE /api/advertiser/creatives/:id — Delete a creative
router.delete("/:id", async (req, res) => {
  try {
    console.log("[creatives.js:DELETE /:id] Delete creative request", { creativeId: req.params.id });
    const docRef = db.collection("creatives").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Creative not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      return res.status(403).json({ error: "Access denied" });
    }

    console.log("[creatives.js:DELETE /:id] Deleting creative from DB", { creativeId: req.params.id });
    await docRef.delete();
    console.log("[creatives.js:DELETE /:id] Creative deleted successfully (200)", { creativeId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting creative:", err);
    res.status(500).json({ error: "Failed to delete creative" });
  }
});

// POST /api/advertiser/creatives/upload — Upload creative image
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    console.log("[creatives.js:POST /upload] Image upload request", { advertiserId: req.advertiser.advertiserId, filename: req.file?.originalname, mimetype: req.file?.mimetype, size: req.file?.size });
    validateImage(req.file);
    const { advertiserId } = req.advertiser;
    const result = await uploadCreativeImage(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      advertiserId
    );
    console.log("[creatives.js:POST /upload] Image uploaded successfully", { advertiserId });
    res.json(result);
  } catch (err) {
    console.log("[creatives.js:POST /upload] Upload failed", { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

export default router;
