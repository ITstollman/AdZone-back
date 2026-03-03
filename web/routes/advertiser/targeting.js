import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET /campaigns/:id/targeting — get targeting config for a campaign
router.get("/campaigns/:id/targeting", async (req, res) => {
  try {
    console.log("[targeting.js:GET /campaigns/:id/targeting] Get targeting config", { campaignId: req.params.id, advertiserId: req.advertiser.advertiserId });
    const doc = await db.collection("campaigns").doc(req.params.id).get();
    if (!doc.exists) {
      console.log("[targeting.js:GET /campaigns/:id/targeting] Campaign not found", { campaignId: req.params.id });
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      console.log("[targeting.js:GET /campaigns/:id/targeting] Access denied", { campaignId: req.params.id });
      return res.status(403).json({ error: "Forbidden" });
    }
    console.log("[targeting.js:GET /campaigns/:id/targeting] Returning targeting config (200)", { campaignId: req.params.id, hasTargeting: !!doc.data().targeting });
    res.json({ targeting: doc.data().targeting || {} });
  } catch (err) {
    console.error("Error getting targeting config:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /campaigns/:id/targeting — update targeting config
router.put("/campaigns/:id/targeting", async (req, res) => {
  try {
    console.log("[targeting.js:PUT /campaigns/:id/targeting] Update targeting config", { campaignId: req.params.id, advertiserId: req.advertiser.advertiserId });
    const doc = await db.collection("campaigns").doc(req.params.id).get();
    if (!doc.exists) {
      console.log("[targeting.js:PUT /campaigns/:id/targeting] Campaign not found", { campaignId: req.params.id });
      return res.status(404).json({ error: "Campaign not found" });
    }
    if (doc.data().advertiserId !== req.advertiser.advertiserId) {
      console.log("[targeting.js:PUT /campaigns/:id/targeting] Access denied", { campaignId: req.params.id });
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      geoTargets,
      deviceTargets,
      audienceSegments,
      dayparting,
      frequencyCap,
      retargeting,
    } = req.body;
    console.log("[targeting.js:PUT /campaigns/:id/targeting] Targeting changes", { campaignId: req.params.id, geoTargets: geoTargets?.length, deviceTargets: deviceTargets?.length, audienceSegments: audienceSegments?.length, daypartingEnabled: dayparting?.enabled, frequencyCap, retargetingEnabled: retargeting?.enabled });

    const targeting = {
      geoTargets: geoTargets || [], // [{ country, region, city }]
      deviceTargets: deviceTargets || [], // ["mobile", "desktop", "tablet"]
      audienceSegments: audienceSegments || [], // segment IDs
      dayparting: dayparting || { enabled: false }, // { enabled, days: [0-6], hours: [0-23] }
      frequencyCap: frequencyCap || null, // { maxImpressions, periodHours }
      retargeting: retargeting || { enabled: false }, // { enabled, events: [...] }
    };

    console.log("[targeting.js:PUT /campaigns/:id/targeting] Updating targeting in DB", { campaignId: req.params.id });
    await doc.ref.update({ targeting, updatedAt: new Date() });
    console.log("[targeting.js:PUT /campaigns/:id/targeting] Targeting updated successfully (200)", { campaignId: req.params.id });
    res.json({ targeting });
  } catch (err) {
    console.error("Error updating targeting config:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
