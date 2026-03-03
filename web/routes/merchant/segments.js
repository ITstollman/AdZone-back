import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// Helper to get merchantId from session
async function getMerchantId(session) {
  const snap = await db.collection("merchants")
    .where("shopifyShopId", "==", session.shop).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

// GET / — list segments
router.get("/", async (req, res) => {
  try {
    console.log("[segments.js:GET /] List segments request", { shop: res.locals.shopify.session.shop });
    const merchantId = await getMerchantId(res.locals.shopify.session);
    if (!merchantId) return res.status(404).json({ error: "Merchant not found" });

    const snap = await db.collection("audience_segments")
      .where("merchantId", "==", merchantId)
      .orderBy("createdAt", "desc")
      .get();

    const segments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log("[segments.js:GET /] Returning segments (200)", { count: segments.length, merchantId });
    res.json({ segments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — create segment
router.post("/", async (req, res) => {
  try {
    console.log("[segments.js:POST /] Create segment request", { shop: res.locals.shopify.session.shop });
    const merchantId = await getMerchantId(res.locals.shopify.session);
    if (!merchantId) return res.status(404).json({ error: "Merchant not found" });

    const { name, rules, description } = req.body;
    console.log("[segments.js:POST /] Segment details", { name, rulesCount: rules?.length, merchantId });
    if (!name || !rules?.length) {
      console.log("[segments.js:POST /] Missing name or rules, returning 400");
      return res.status(400).json({ error: "Name and at least one rule are required" });
    }

    console.log("[segments.js:POST /] Creating segment in DB", { name, merchantId });
    const ref = await db.collection("audience_segments").add({
      merchantId,
      name,
      description: description || "",
      rules, // [{ field, operator, value }]
      isDefault: false,
      estimatedSize: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const doc = await ref.get();
    console.log("[segments.js:POST /] Segment created (201)", { segmentId: doc.id, name });
    res.status(201).json({ segment: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("[segments.js:POST /] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id — update segment
router.put("/:id", async (req, res) => {
  try {
    console.log("[segments.js:PUT /:id] Update segment request", { segmentId: req.params.id });
    const merchantId = await getMerchantId(res.locals.shopify.session);
    const docRef = db.collection("audience_segments").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().merchantId !== merchantId) {
      return res.status(404).json({ error: "Segment not found" });
    }

    const { name, rules, description } = req.body;
    await docRef.update({
      ...(name && { name }),
      ...(rules && { rules }),
      ...(description !== undefined && { description }),
      updatedAt: new Date(),
    });

    const updated = await docRef.get();
    console.log("[segments.js:PUT /:id] Segment updated (200)", { segmentId: req.params.id });
    res.json({ segment: { id: updated.id, ...updated.data() } });
  } catch (err) {
    console.error("[segments.js:PUT /:id] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id — delete segment
router.delete("/:id", async (req, res) => {
  try {
    console.log("[segments.js:DELETE /:id] Delete segment request", { segmentId: req.params.id });
    const merchantId = await getMerchantId(res.locals.shopify.session);
    const docRef = db.collection("audience_segments").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists || doc.data().merchantId !== merchantId) {
      return res.status(404).json({ error: "Segment not found" });
    }
    console.log("[segments.js:DELETE /:id] Deleting segment from DB", { segmentId: req.params.id });
    await docRef.delete();
    console.log("[segments.js:DELETE /:id] Segment deleted (200)", { segmentId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("[segments.js:DELETE /:id] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
