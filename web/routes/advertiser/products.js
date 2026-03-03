import { Router } from "express";
import {
  fetchMerchantProducts,
  fetchMerchantCollections,
} from "../../services/product-sync.js";
import { db } from "../../firebase.js";

const router = Router();

// GET /:merchantId — browse merchant products
router.get("/:merchantId", async (req, res) => {
  try {
    const { page, limit, collection, search } = req.query;
    console.log("[products.js:GET /:merchantId] List merchant products request", { merchantId: req.params.merchantId, page, limit, collection, search });
    const result = await fetchMerchantProducts(req.params.merchantId, {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      collection,
      search,
    });
    console.log("[products.js:GET /:merchantId] Returning products (200)", { merchantId: req.params.merchantId });
    res.json(result);
  } catch (err) {
    console.error("[products.js:GET /:merchantId] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:merchantId/collections — list merchant collections
router.get("/:merchantId/collections", async (req, res) => {
  try {
    console.log("[products.js:GET /:merchantId/collections] List collections request", { merchantId: req.params.merchantId });
    const result = await fetchMerchantCollections(req.params.merchantId);
    console.log("[products.js:GET /:merchantId/collections] Returning collections (200)", { merchantId: req.params.merchantId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /create-creative — create a promoted product creative from a product
router.post("/create-creative", async (req, res) => {
  const { campaignId, productId, merchantId, title, imageUrl, price, handle } =
    req.body;
  console.log("[products.js:POST /create-creative] Create promoted product creative request", { campaignId, productId, merchantId, title });
  if (!campaignId || !productId || !title) {
    console.log("[products.js:POST /create-creative] Missing required fields, returning 400");
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    console.log("[products.js:POST /create-creative] Creating creative in DB", { campaignId, productId, title });
    const ref = await db.collection("creatives").add({
      advertiserId: req.advertiser.advertiserId,
      campaignId,
      type: "promoted_product",
      name: `Promoted: ${title}`,
      productId,
      merchantId,
      imageUrl: imageUrl || "",
      destinationUrl: `/products/${handle}`,
      productData: { title, price, imageUrl, handle },
      status: "pending_review",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add to campaign
    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (campaignDoc.exists) {
      const existing = campaignDoc.data().creativeIds || [];
      await campaignDoc.ref.update({ creativeIds: [...existing, ref.id] });
    }

    const doc = await ref.get();
    console.log("[products.js:POST /create-creative] Promoted product creative created (201)", { creativeId: doc.id, campaignId });
    res.status(201).json({ creative: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("[products.js:POST /create-creative] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
