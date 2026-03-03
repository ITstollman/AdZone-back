import { Router } from "express";
import crypto from "crypto";
import { FieldValue } from "firebase-admin/firestore";
import { runAuction } from "../../services/auction.js";
import { recordImpression } from "../../services/impression-tracker.js";
import { detectFraud } from "../../services/fraud-detection.js";
import { deductBalance } from "../../services/wallet.js";
import { recordVariantEvent } from "../../services/ab-testing.js";
import { trackVisitorEvent } from "../../services/audience.js";
import { db } from "../../firebase.js";

const router = Router();

/**
 * Verify that the request came through Shopify's app proxy
 * by validating the HMAC signature.
 */
function verifyProxySignature(req, res, next) {
  console.log("[storefront.js:verifyProxySignature] Verifying proxy signature", { path: req.path, query: req.query });
  // Skip verification in development
  if (process.env.NODE_ENV === "development") {
    console.log("[storefront.js:verifyProxySignature] Skipping verification in development mode");
    return next();
  }

  const { signature, ...params } = req.query;
  if (!signature) {
    console.log("[storefront.js:verifyProxySignature] Missing signature, returning 403");
    return res.status(403).json({ error: "Missing signature" });
  }

  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");

  const calculatedSig = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(sortedParams)
    .digest("hex");

  if (calculatedSig !== signature) {
    console.log("[storefront.js:verifyProxySignature] Invalid signature, returning 403");
    return res.status(403).json({ error: "Invalid signature" });
  }

  console.log("[storefront.js:verifyProxySignature] Signature verified successfully");
  next();
}

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

router.use(verifyProxySignature);

// GET /api/proxy/serve?zone=homepage-banner-top&shop=store.myshopify.com
router.get("/serve", async (req, res) => {
  try {
    const { zone, shop, page, vid, pageUrl, freq, count, rt } = req.query;
    console.log("[storefront.js:GET /serve] Ad serve request", { zone, shop, page, vid, count });

    if (!zone) {
      console.log("[storefront.js:GET /serve] Missing zone parameter, returning 400");
      return res.status(400).json({ error: "Missing zone parameter" });
    }

    const shopDomain = shop || req.query.shop;
    const adCount = Math.min(Math.max(parseInt(count) || 1, 1), 10);
    console.log("[storefront.js:GET /serve] Resolved params", { shopDomain, adCount });

    // Build request context for smart targeting
    const requestContext = {
      ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip,
      userAgent: req.headers["user-agent"] || "",
      visitorId: vid || null,
      pageUrl: pageUrl || page || null,
      frequencyData: parseFrequencyData(freq),
      retargetingLists: parseRetargetingData(rt),
      timestamp: Date.now(),
    };

    console.log("[storefront.js:GET /serve] Running auction", { shopDomain, zone, adCount });
    const ad = await runAuction(shopDomain, zone, requestContext, adCount);

    if (!ad || (Array.isArray(ad) && ad.length === 0)) {
      console.log("[storefront.js:GET /serve] No ad available, returning 204");
      return res.status(204).end();
    }
    console.log("[storefront.js:GET /serve] Auction returned ad(s)", { adCount: Array.isArray(ad) ? ad.length : 1 });

    // Look up merchant GA4 Measurement ID
    console.log("[storefront.js:GET /serve] Looking up merchant GA4 ID", { shopDomain });
    let ga4MeasurementId = null;
    if (shopDomain) {
      const merchantSnap = await db
        .collection("merchants")
        .where("shopifyShopId", "==", shopDomain)
        .limit(1)
        .get();
      if (!merchantSnap.empty) {
        ga4MeasurementId = merchantSnap.docs[0].data().settings?.ga4MeasurementId || null;
      }
    }

    // Attach GA4 ID to response if configured
    if (ga4MeasurementId) {
      if (Array.isArray(ad)) {
        ad.forEach((a) => { a.ga4MeasurementId = ga4MeasurementId; });
      } else {
        ad.ga4MeasurementId = ga4MeasurementId;
      }
    }

    // Return ad data as JSON (consumed by ad-loader.js)
    console.log("[storefront.js:GET /serve] Returning ad response (200)", { ga4MeasurementId });
    res.json(ad);
  } catch (err) {
    console.error("Error serving ad via proxy:", err);
    res.status(500).json({ error: "Failed to serve ad" });
  }
});

// POST /api/proxy/track/impression
router.post("/track/impression", async (req, res) => {
  try {
    const { adId, campaignId, zoneId, bidId, page, visitorId, billingToken } =
      req.body;
    console.log("[storefront.js:POST /track/impression] Impression tracking request", { adId, campaignId, zoneId, bidId, visitorId });

    // Verify billing token for trusted billing data
    const billingData = verifyBillingToken(billingToken);
    if (!billingData && billingToken) {
      console.warn(
        "Invalid or expired billingToken for impression:",
        { adId, campaignId, zoneId },
      );
    }

    // recordImpression now handles fraud detection internally
    const result = recordImpression({
      creativeId: adId,
      campaignId: campaignId || null,
      zoneId: zoneId || null,
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

    if (result?.blocked) {
      console.log("[storefront.js:POST /track/impression] Impression blocked by fraud filter", { adId, campaignId });
      return res.status(202).json({ ok: true, filtered: true });
    }

    console.log("[storefront.js:POST /track/impression] Impression recorded successfully (202)", { adId, campaignId });
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("Error recording impression via proxy:", err);
    res.status(500).json({ error: "Failed to record impression" });
  }
});

// GET /api/proxy/click?id=X&bid=Y&dest=/products/Z&vid=VISITOR_ID&campaign=C&advertiser=A&bt=BILLING_TOKEN
router.get("/click", async (req, res) => {
  try {
    const { id, bid, dest, shop, vid, campaign, advertiser, bt } = req.query;
    console.log("[storefront.js:GET /click] Click tracking request", { id, bid, dest, vid, campaign, advertiser });

    if (!dest || !dest.startsWith("/")) {
      console.log("[storefront.js:GET /click] Invalid destination, redirecting to /", { dest });
      return res.redirect(302, "/");
    }

    // Run fraud detection on the click
    console.log("[storefront.js:GET /click] Running fraud detection", { id, vid, ip: req.ip });
    const fraudResult = detectFraud({
      type: "click",
      visitorId: vid || null,
      adId: id || null,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      timestamp: Date.now(),
    });
    console.log("[storefront.js:GET /click] Fraud detection result", { fraudulent: fraudResult.fraudulent, score: fraudResult.score, reasons: fraudResult.reasons });

    // Record click asynchronously (mark as fraudulent if detected)
    console.log("[storefront.js:GET /click] Recording click to DB", { id, campaign, fraudulent: fraudResult.fraudulent });
    db.collection("clicks").add({
      creativeId: id || null,
      bidId: bid || null,
      campaignId: campaign || null,
      advertiserId: advertiser || null,
      destinationUrl: dest,
      referrerPage: req.headers.referer || "",
      visitorId: vid || null,
      userAgent: req.headers["user-agent"] || "",
      ip: req.ip,
      fraudulent: fraudResult.fraudulent,
      fraudScore: fraudResult.score,
      fraudReason: fraudResult.reasons.join(",") || null,
      timestamp: new Date(),
    }).catch((err) => console.error("Error recording click:", err));

    // Record A/B variant event for non-fraudulent clicks
    if (!fraudResult.fraudulent && id) {
      recordVariantEvent(id, "click").catch((err) =>
        console.error("Error recording variant click event:", err),
      );
    }

    // CPC Click Billing: charge on non-fraudulent clicks with a billing token
    if (bt && !fraudResult.fraudulent) {
      const billingData = verifyBillingToken(bt);
      console.log("[storefront.js:GET /click] CPC billing check", { hasBillingData: !!billingData, bidType: billingData?.bidType, chargedCpc: billingData?.chargedCpc });
      if (billingData && billingData.bidType === "cpc" && billingData.chargedCpc) {
        const cpcAmount = billingData.chargedCpc;
        console.log("[storefront.js:GET /click] CPC billing: deducting", { cpcAmount, advertiserId: advertiser || billingData.advertiserId, campaignId: campaign || billingData.campaignId });
        const cpcCampaignId = campaign || billingData.campaignId;
        const cpcAdvertiserId = advertiser || billingData.advertiserId;

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

    // Redirect to internal destination (relative path works within the storefront)
    console.log("[storefront.js:GET /click] Redirecting to destination (302)", { dest });
    res.redirect(302, dest);
  } catch (err) {
    console.error("Error in proxy click:", err);
    res.redirect(302, req.query.dest || "/");
  }
});

// POST /api/proxy/events/batch — forward visitor behavior events to audience tracking
router.post("/events/batch", async (req, res) => {
  try {
    const { visitorId, merchantId, events } = req.body;
    console.log("[storefront.js:POST /events/batch] Batch events request", { visitorId, merchantId, eventCount: Array.isArray(events) ? events.length : 0 });

    if (!visitorId || !merchantId || !Array.isArray(events)) {
      console.log("[storefront.js:POST /events/batch] Missing required fields, returning 400");
      return res.status(400).json({ error: "visitorId, merchantId, and events[] are required" });
    }

    // Process events in parallel (max 50 per batch)
    const promises = events.slice(0, 50).map(event =>
      trackVisitorEvent(visitorId, merchantId, event).catch(err =>
        console.error("Event tracking error:", err.message)
      )
    );
    await Promise.all(promises);

    console.log("[storefront.js:POST /events/batch] Events processed successfully", { processed: Math.min(events.length, 50) });
    res.json({ success: true, processed: Math.min(events.length, 50) });
  } catch (err) {
    console.error("Error processing visitor events via proxy:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proxy/track/conversion
router.post("/track/conversion", async (req, res) => {
  try {
    const { type, campaignId, adId, advertiserId, value, currency, orderId, visitorId, attributionType } = req.body;
    console.log("[storefront.js:POST /track/conversion] Conversion tracking request", { type, campaignId, adId, advertiserId, value, orderId, visitorId });

    // Deduplicate by orderId
    if (orderId) {
      console.log("[storefront.js:POST /track/conversion] Checking for duplicate orderId", { orderId, campaignId });
      const existing = await db.collection("conversions")
        .where("orderId", "==", orderId)
        .where("campaignId", "==", campaignId)
        .limit(1).get();
      if (!existing.empty) {
        console.log("[storefront.js:POST /track/conversion] Duplicate conversion found, skipping", { orderId, campaignId });
        return res.status(200).json({ ok: true, duplicate: true });
      }
    }

    // Check for conversion fraud (< 2s after click is suspicious)
    if (visitorId && campaignId) {
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
    console.log("[storefront.js:POST /track/conversion] Recording conversion to DB", { type, campaignId, value });
    await db.collection("conversions").add({
      type, campaignId, adId, advertiserId, value: value || 0, currency: currency || "USD",
      orderId: orderId || null, visitorId: visitorId || null,
      attributionType: attributionType || "click", ip: req.ip,
      userAgent: req.headers["user-agent"] || "", timestamp: new Date(),
    });

    // Update conversion stats atomically
    console.log("[storefront.js:POST /track/conversion] Updating conversion stats", { campaignId });
    await db.collection("conversion_stats").doc(campaignId).set({
      campaignId,
      conversions: FieldValue.increment(1),
      totalRevenue: FieldValue.increment(value || 0),
    }, { merge: true });

    // CPA billing: if campaign uses CPA bidding, charge on conversion
    console.log("[storefront.js:POST /track/conversion] Checking CPA billing for campaign", { campaignId });
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
          console.log("[storefront.js:POST /track/conversion] CPA billing: deducting", { chargeAmount, advertiserId: campaign.advertiserId, campaignId });

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

    console.log("[storefront.js:POST /track/conversion] Conversion recorded successfully (202)", { type, campaignId, value });
    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("Error recording conversion via proxy:", err);
    res.status(500).json({ error: "Failed to record conversion" });
  }
});

/**
 * Parse frequency data from query parameter.
 * Expected format: JSON string like {"campaignId1": 3, "campaignId2": 1}
 */
function parseFrequencyData(freq) {
  if (!freq) return {};
  try {
    return JSON.parse(freq);
  } catch {
    return {};
  }
}

/**
 * Parse retargeting data from query parameter (Phase 1C).
 * Expected format: JSON string with lists keyed by type
 * e.g. {"product_viewers": [...], "cart_adders": [...]}
 */
function parseRetargetingData(rt) {
  if (!rt) return {};
  try {
    return JSON.parse(rt);
  } catch {
    return {};
  }
}

export default router;
