import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET / — list library creatives for this advertiser
router.get("/", async (req, res) => {
  try {
    console.log("[creative-library.js:GET /] List library creatives request", { advertiserId: req.advertiser.advertiserId });
    const snap = await db
      .collection("creative_library")
      .where("advertiserId", "==", req.advertiser.advertiserId)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const creatives = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    console.log("[creative-library.js:GET /] Returning library creatives (200)", { count: creatives.length });
    res.json({ creatives });
  } catch (err) {
    console.error("[creative-library.js:GET /] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST / — save a creative to library
router.post("/", async (req, res) => {
  const { name, type, imageUrl, thumbnailUrl, resizedUrls, tags, destinationUrl } =
    req.body;
  console.log("[creative-library.js:POST /] Save to library request", { advertiserId: req.advertiser.advertiserId, name, type });
  if (!name) {
    console.log("[creative-library.js:POST /] Missing name, returning 400");
    return res.status(400).json({ error: "Name is required" });
  }

  try {
    console.log("[creative-library.js:POST /] Creating library creative in DB", { name, type });
    const ref = await db.collection("creative_library").add({
      advertiserId: req.advertiser.advertiserId,
      name,
      type: type || "banner_image",
      imageUrl: imageUrl || "",
      thumbnailUrl: thumbnailUrl || "",
      resizedUrls: resizedUrls || {},
      tags: tags || [],
      destinationUrl: destinationUrl || "",
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const doc = await ref.get();
    console.log("[creative-library.js:POST /] Library creative saved (201)", { creativeId: doc.id });
    res.status(201).json({ creative: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("[creative-library.js:POST /] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/use — clone a library creative into a campaign
router.post("/:id/use", async (req, res) => {
  const { campaignId } = req.body;
  console.log("[creative-library.js:POST /:id/use] Use library creative request", { libraryId: req.params.id, campaignId });
  if (!campaignId)
    return res.status(400).json({ error: "campaignId is required" });

  try {
    const libDoc = await db
      .collection("creative_library")
      .doc(req.params.id)
      .get();
    if (!libDoc.exists)
      return res.status(404).json({ error: "Creative not found" });

    const lib = libDoc.data();
    if (lib.advertiserId !== req.advertiser.advertiserId)
      return res.status(403).json({ error: "Forbidden" });

    // Create a new creative in the creatives collection
    const ref = await db.collection("creatives").add({
      advertiserId: req.advertiser.advertiserId,
      campaignId,
      type: lib.type,
      name: lib.name,
      imageUrl: lib.imageUrl,
      thumbnailUrl: lib.thumbnailUrl,
      resizedUrls: lib.resizedUrls,
      altText: lib.name,
      destinationUrl: lib.destinationUrl,
      status: "pending_review",
      librarySourceId: libDoc.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Increment usage count
    await libDoc.ref.update({ usageCount: (lib.usageCount || 0) + 1 });

    // Add creative to campaign
    const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
    if (campaignDoc.exists) {
      const existing = campaignDoc.data().creativeIds || [];
      await campaignDoc.ref.update({ creativeIds: [...existing, ref.id] });
    }

    const doc = await ref.get();
    console.log("[creative-library.js:POST /:id/use] Library creative cloned to campaign (201)", { newCreativeId: doc.id, campaignId });
    res.status(201).json({ creative: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error("[creative-library.js:POST /:id/use] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id — delete from library
router.delete("/:id", async (req, res) => {
  try {
    console.log("[creative-library.js:DELETE /:id] Delete library creative request", { libraryId: req.params.id });
    const doc = await db
      .collection("creative_library")
      .doc(req.params.id)
      .get();
    if (!doc.exists) return res.status(404).json({ error: "Not found" });
    if (doc.data().advertiserId !== req.advertiser.advertiserId)
      return res.status(403).json({ error: "Forbidden" });
    console.log("[creative-library.js:DELETE /:id] Deleting library creative from DB", { libraryId: req.params.id });
    await doc.ref.delete();
    console.log("[creative-library.js:DELETE /:id] Library creative deleted (200)", { libraryId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error("[creative-library.js:DELETE /:id] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
