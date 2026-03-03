import crypto from "crypto";
import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { recordImpression } from "../../services/impression-tracker.js";
import { detectFraud } from "../../services/fraud-detection.js";
import { deductBalance } from "../../services/wallet.js";
import { recordVariantEvent } from "../../services/ab-testing.js";
import { db } from "../../firebase.js";

const router = Router();

/**
 * Verify a billing token signed by the auction service.
 * Returns the parsed billing data or null if invalid/expired.
 */
function verifyBillingToken(token) {
  if (!token) return null;
  try {
    const [payloadB64, hmac] = token.split(".");
    const payload = Buffer.from(payloadB64, "base64").toString();
    const secret =
      process.env.IMPRESSION_SECRET ||
      process.env.ADVERTISER_JWT_SECRET ||
      "adzone-billing-secret";
    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    if (hmac !== expected) return null;
    const data = JSON.parse(payload);
    if (Date.now() - data.ts > 5 * 60 * 1000) return null; // 5 min max
    return data;
  } catch {
    return null;
  }
}

// POST /api/public/track/impression
router.post("/impression", async (req, res) => {
  try {
    const { adId, campaignId, zoneId, bidId, page, visitorId, billingToken } =
      req.body;
    console.log("[track.js:POST /impression] Impression tracking request", { adId, campaignId, zoneId, bidId, visitorId });

    if (!adId || !zoneId) {
      console.log("[track.js:POST /impression] Missing required fields, returning 400", { adId, zoneId });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify billing token for trusted billing data
    console.log("[track.js:POST /impression] Verifying billing token", { hasBillingToken: !!billingToken });
    const billingData = verifyBillingToken(billingToken);
    if (!billingData && billingToken) {
      console.warn(
        "Invalid or expired billingToken for impression:",
        { adId, campaignId, zoneId },
      );
    }

    console.log("[track.js:POST /impression] Recording impression", { adId, zoneId, hasBillingData: !!billingData, chargedAmount: billingData?.chargedCpm });
    recordImpression({
      creativeId: adId,
      campaignId: campaignId || null,
      zoneId,
      bidId: bidId || null,
      page: page || "",
      visitorId: visitorId || null,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      viewportVisible: true,
      advertiserId: billingData ? billingData.advertiserId : null,
      merchantId: billingData ? billingData.merchantId : null,
      chargedAmount: billingData ? billingData.chargedCpm : null,
    });

    console.log("[track.js:POST /impression] Impression recorded successfully (202)", { adId, campaignId, zoneId });
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("Error recording impression:", err);
    res.status(500).json({ error: "Failed to record impression" });
  }
});

// POST /api/public/track/click
router.post("/click", async (req, res) => {
  try {
    const { adId, campaignId, zoneId, bidId, destinationUrl, page, visitorId, advertiserId, billingToken } = req.body;
    console.log("[track.js:POST /click] Click tracking request", { adId, campaignId, zoneId, destinationUrl, visitorId, advertiserId });

    if (!adId || !destinationUrl) {
      console.log("[track.js:POST /click] Missing required fields, returning 400", { adId, destinationUrl });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Run fraud detection on the click
    console.log("[track.js:POST /click] Running fraud detection", { adId, visitorId, ip: req.ip });
    const fraudResult = detectFraud({
      type: "click",
      visitorId: visitorId || null,
      adId,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      timestamp: Date.now(),
    });

    console.log("[track.js:POST /click] Fraud detection result", { fraudulent: fraudResult.fraudulent, score: fraudResult.score, reasons: fraudResult.reasons });

    // Record click (mark as fraudulent if detected)
    console.log("[track.js:POST /click] Recording click to DB", { adId, campaignId, fraudulent: fraudResult.fraudulent });
    await db.collection("clicks").add({
      creativeId: adId,
      campaignId: campaignId || null,
      zoneId: zoneId || null,
      bidId: bidId || null,
      advertiserId: advertiserId || null,
      destinationUrl,
      referrerPage: page || "",
      visitorId: visitorId || null,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      fraudulent: fraudResult.fraudulent,
      fraudScore: fraudResult.score,
      fraudReason: fraudResult.reasons.join(",") || null,
      timestamp: new Date(),
    });

    // Record A/B variant event for non-fraudulent clicks
    if (!fraudResult.fraudulent) {
      recordVariantEvent(adId, "click").catch((err) =>
        console.error("Error recording variant click event:", err),
      );
    }

    // CPC Click Billing: charge on non-fraudulent clicks with a billing token
    if (billingToken && !fraudResult.fraudulent) {
      const billingData = verifyBillingToken(billingToken);
      console.log("[track.js:POST /click] CPC billing check", { hasBillingData: !!billingData, bidType: billingData?.bidType, chargedCpc: billingData?.chargedCpc });
      if (billingData && billingData.bidType === "cpc" && billingData.chargedCpc) {
        const cpcAmount = billingData.chargedCpc;
        console.log("[track.js:POST /click] CPC billing: deducting", { cpcAmount, advertiserId: advertiserId || billingData.advertiserId, campaignId: campaignId || billingData.campaignId });
        const cpcCampaignId = campaignId || billingData.campaignId;
        const cpcAdvertiserId = advertiserId || billingData.advertiserId;

        // Deduct CPC charge from advertiser wallet
        deductBalance(cpcAdvertiserId, cpcAmount, {
          campaignId: cpcCampaignId,
          type: "cpc_click",
        }).catch((err) => console.error("CPC deduction error:", err.message));

        // Update campaign budget spent
        if (cpcCampaignId) {
          db.collection("campaigns").doc(cpcCampaignId)
            .update({ "budget.spent": FieldValue.increment(cpcAmount) })
            .catch((err) => console.error("Budget update error:", err.message));

          // Increment daily spend
          const dateStr = new Date().toISOString().split("T")[0];
          db.collection("daily_spend")
            .doc(`${cpcCampaignId}_${dateStr}`)
            .set({
              campaignId: cpcCampaignId,
              date: dateStr,
              spent: FieldValue.increment(cpcAmount),
            }, { merge: true })
            .catch((err) => console.error("Daily spend update error:", err.message));

          // Increment hourly spend
          const hour = new Date().getUTCHours();
          db.collection("hourly_spend")
            .doc(`${cpcCampaignId}_${dateStr}_${hour}`)
            .set({
              campaignId: cpcCampaignId,
              date: dateStr,
              hour,
              spent: FieldValue.increment(cpcAmount),
            }, { merge: true })
            .catch((err) => console.error("Hourly spend update error:", err.message));
        }
      }
    }

    console.log("[track.js:POST /click] Click recorded successfully (202)", { adId, campaignId });
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("Error recording click:", err);
    res.status(500).json({ error: "Failed to record click" });
  }
});

// POST /api/public/track/conversion
router.post("/conversion", async (req, res) => {
  try {
    const { type, campaignId, adId, advertiserId, value, currency, orderId, visitorId, attributionType } = req.body;
    console.log("[track.js:POST /conversion] Conversion tracking request", { type, campaignId, adId, advertiserId, value, orderId, visitorId });

    // Deduplicate by orderId
    if (orderId) {
      console.log("[track.js:POST /conversion] Checking for duplicate orderId", { orderId, campaignId });
      const existing = await db.collection("conversions")
        .where("orderId", "==", orderId)
        .where("campaignId", "==", campaignId)
        .limit(1).get();
      if (!existing.empty) {
        console.log("[track.js:POST /conversion] Duplicate conversion found, skipping", { orderId, campaignId });
        return res.status(200).json({ ok: true, duplicate: true });
      }
    }

    // Check for conversion fraud (< 2s after click is suspicious)
    if (visitorId && campaignId) {
      console.log("[track.js:POST /conversion] Checking conversion fraud timing", { visitorId, campaignId });
      const recentClicks = await db.collection("clicks")
        .where("visitorId", "==", visitorId)
        .where("campaignId", "==", campaignId)
        .orderBy("timestamp", "desc")
        .limit(1).get();

      if (!recentClicks.empty) {
        const lastClick = recentClicks.docs[0].data();
        const clickTime = lastClick.timestamp?.toDate ? lastClick.timestamp.toDate().getTime() : 0;
        if (clickTime && (Date.now() - clickTime) < 2000) {
          console.warn("Suspicious conversion: < 2s after click", { visitorId, campaignId });
        }
      }
    }

    // Record conversion
    console.log("[track.js:POST /conversion] Recording conversion to DB", { type, campaignId, value });
    await db.collection("conversions").add({
      type, campaignId, adId, advertiserId, value: value || 0, currency: currency || "USD",
      orderId: orderId || null, visitorId: visitorId || null,
      attributionType: attributionType || "click", ip: req.ip,
      userAgent: req.headers["user-agent"] || "", timestamp: new Date(),
    });

    // Update conversion stats atomically
    console.log("[track.js:POST /conversion] Updating conversion stats", { campaignId });
    await db.collection("conversion_stats").doc(campaignId).set({
      campaignId,
      conversions: FieldValue.increment(1),
      totalRevenue: FieldValue.increment(value || 0),
    }, { merge: true });

    // CPA billing: if campaign uses CPA bidding, charge on conversion
    console.log("[track.js:POST /conversion] Checking CPA billing for campaign", { campaignId });
    try {
      const campaignDoc = await db.collection("campaigns").doc(campaignId).get();
      if (campaignDoc.exists) {
        const campaign = campaignDoc.data();
        // Find active CPA bid for this campaign
        const bidSnap = await db.collection("bids")
          .where("campaignId", "==", campaignId)
          .where("bidType", "==", "cpa")
          .where("status", "==", "active")
          .limit(1).get();

        if (!bidSnap.empty) {
          const bid = bidSnap.docs[0].data();
          const chargeAmount = bid.amount; // CPA bid amount
          console.log("[track.js:POST /conversion] CPA billing: deducting", { chargeAmount, advertiserId: campaign.advertiserId, campaignId });

          deductBalance(campaign.advertiserId, chargeAmount, {
            campaignId, type: "cpa_conversion", orderId,
          }).catch(err => console.error("CPA deduction error:", err.message));

          // Update budget spent
          db.collection("campaigns").doc(campaignId)
            .update({ "budget.spent": FieldValue.increment(chargeAmount) })
            .catch(err => console.error("Budget update error:", err.message));
        }
      }
    } catch (err) {
      console.error("CPA billing error:", err.message);
    }

    console.log("[track.js:POST /conversion] Conversion recorded successfully (202)", { type, campaignId, value });
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("Error recording conversion:", err);
    res.status(500).json({ error: "Failed to record conversion" });
  }
});

export default router;
