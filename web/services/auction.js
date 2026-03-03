import crypto from "crypto";
import { db } from "../firebase.js";
import { cache } from "./cache.js";
import { resolveGeo, parseDevice, filterByTargeting, scoreAd } from "./targeting.js";
import { hasSufficientBalance } from "./wallet.js";
import { selectVariant } from "./ab-testing.js";
import { selectVariantContextual, recordVariantEventContextual, determineContextBucket } from "./ab-testing.js";
import { getVisitorProfile, evaluateSegments } from "./audience.js";
import { computeQualityScore } from "./quality-score.js";
import { evaluateAutoSegments } from "./behavioral-scoring.js";
import { buildInterestProfile } from "./interest-engine.js";
import { computeProductAffinity } from "./product-affinity.js";
import { predictPurchaseProbability } from "./predictive-audiences.js";
import { computeEngagementScore } from "./behavioral-scoring.js";

const AUCTION_CACHE_TTL = 60; // seconds

// --- Auction Outcome Buffer (fire-and-forget, flush every 30s) ---
const OUTCOME_BATCH_SIZE = 500;
const OUTCOME_FLUSH_INTERVAL = 30000; // 30 seconds
let outcomeBuffer = [];

/**
 * Buffer an auction outcome for batched write to Firestore.
 */
function bufferAuctionOutcome(outcome) {
  console.log("[auction.js:bufferAuctionOutcome] Buffering auction outcome", { zoneId: outcome.zoneId, winnerId: outcome.winnerId, bufferSize: outcomeBuffer.length + 1 });
  outcomeBuffer.push(outcome);
  if (outcomeBuffer.length >= OUTCOME_BATCH_SIZE) {
    console.log("[auction.js:bufferAuctionOutcome] Buffer full, triggering flush", { bufferSize: outcomeBuffer.length });
    flushAuctionOutcomes();
  }
}

/**
 * Flush buffered auction outcomes to Firestore.
 */
async function flushAuctionOutcomes() {
  if (outcomeBuffer.length === 0) {
    console.log("[auction.js:flushAuctionOutcomes] Nothing to flush, buffer empty");
    return;
  }

  const toFlush = outcomeBuffer.splice(0, OUTCOME_BATCH_SIZE);
  console.log("[auction.js:flushAuctionOutcomes] Flushing auction outcomes to Firestore", { count: toFlush.length, remainingInBuffer: outcomeBuffer.length });
  const batch = db.batch();

  for (const outcome of toFlush) {
    const ref = db.collection("auction_outcomes").doc();
    batch.set(ref, outcome);
  }

  try {
    await batch.commit();
    console.log("[auction.js:flushAuctionOutcomes] Successfully flushed outcomes", { count: toFlush.length });
  } catch (err) {
    // Re-add failed outcomes to buffer
    outcomeBuffer.unshift(...toFlush);
    console.error("Failed to flush auction outcomes:", err);
    console.log("[auction.js:flushAuctionOutcomes] Re-added failed outcomes to buffer", { reAddedCount: toFlush.length, newBufferSize: outcomeBuffer.length });
  }
}

// Periodic flush
setInterval(flushAuctionOutcomes, OUTCOME_FLUSH_INTERVAL);

// Flush on process exit
process.on("SIGTERM", async () => {
  console.log("[auction.js:SIGTERM] Process terminating, flushing auction outcomes");
  await flushAuctionOutcomes();
});

/**
 * Get the current daypart slot based on UTC time.
 * Returns one of 8 slots: weekday_morning (6-11), weekday_afternoon (12-17),
 * weekday_evening (18-22), weekday_night (23-5), weekend_morning, etc.
 */
export function getDaypartSlot(now = new Date()) {
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6;
  const prefix = isWeekend ? "weekend" : "weekday";

  let period;
  if (hour >= 6 && hour <= 11) {
    period = "morning";
  } else if (hour >= 12 && hour <= 17) {
    period = "afternoon";
  } else if (hour >= 18 && hour <= 22) {
    period = "evening";
  } else {
    period = "night";
  }

  const slot = `${prefix}_${period}`;
  console.log("[auction.js:getDaypartSlot] Computed daypart slot", { hour, day, isWeekend, slot });
  return slot;
}

/**
 * Get predicted conversion rate for a campaign from conversion_stats.
 * Defaults to 0.01 if no data available.
 */
async function getPredictedCVR(campaignId) {
  console.log("[auction.js:getPredictedCVR] Fetching predicted CVR", { campaignId });
  try {
    const doc = await db.collection("conversion_stats").doc(campaignId).get();
    if (doc.exists) {
      const stats = doc.data();
      if (stats.clicks > 0 && stats.conversions > 0) {
        const cvr = stats.conversions / stats.clicks;
        console.log("[auction.js:getPredictedCVR] Found CVR data", { campaignId, conversions: stats.conversions, clicks: stats.clicks, cvr });
        return cvr;
      }
    }
    console.log("[auction.js:getPredictedCVR] No CVR data found, using default", { campaignId, defaultCVR: 0.01 });
  } catch { /* default */ }
  return 0.01;
}

/**
 * Apply context-specific bid modifiers to a base bid amount.
 * Modifiers are multiplied together and clamped to [0.1, 5.0].
 *
 * @param {object} bid - The bid object with optional modifiers
 * @param {object} enrichedContext - Enriched request context with device, geo, visitorSegments
 * @returns {number} The effective bid after applying modifiers
 */
function applyBidModifiers(bid, enrichedContext) {
  console.log("[auction.js:applyBidModifiers] Applying bid modifiers", { bidId: bid.id, baseBidAmount: bid.amount, hasModifiers: !!bid.modifiers });
  if (!bid.modifiers) return bid.amount;

  let multiplier = 1.0;

  // Device modifier
  if (bid.modifiers.device && enrichedContext.device) {
    const deviceMod = bid.modifiers.device[enrichedContext.device] || 1.0;
    multiplier *= deviceMod;
    console.log("[auction.js:applyBidModifiers] Device modifier applied", { device: enrichedContext.device, modifier: deviceMod, multiplier });
  }

  // Geo modifier
  if (bid.modifiers.geo && enrichedContext.geo?.country) {
    const geoMod = bid.modifiers.geo[enrichedContext.geo.country] || 1.0;
    multiplier *= geoMod;
    console.log("[auction.js:applyBidModifiers] Geo modifier applied", { country: enrichedContext.geo.country, modifier: geoMod, multiplier });
  }

  // Daypart modifier
  if (bid.modifiers.daypart) {
    const slot = getDaypartSlot();
    const daypartMod = bid.modifiers.daypart[slot] || 1.0;
    multiplier *= daypartMod;
    console.log("[auction.js:applyBidModifiers] Daypart modifier applied", { slot, modifier: daypartMod, multiplier });
  }

  // Audience modifier — pick best matching segment
  if (bid.modifiers.audience && enrichedContext.visitorSegments?.length > 0) {
    let bestAudienceModifier = 1.0;
    for (const segment of enrichedContext.visitorSegments) {
      if (bid.modifiers.audience[segment] !== undefined) {
        bestAudienceModifier = Math.max(bestAudienceModifier, bid.modifiers.audience[segment]);
      }
    }
    multiplier *= bestAudienceModifier;
    console.log("[auction.js:applyBidModifiers] Audience modifier applied", { bestAudienceModifier, visitorSegmentCount: enrichedContext.visitorSegments.length, multiplier });
  }

  // Retargeting modifier — boost bids for retargeted visitors
  if (bid.modifiers.retargeting && enrichedContext.retargetingLists) {
    let retargetingModifier = 1.0;
    for (const [audience, modifier] of Object.entries(bid.modifiers.retargeting)) {
      const list = enrichedContext.retargetingLists[audience] || [];
      if (list.length > 0) {
        retargetingModifier = Math.max(retargetingModifier, modifier);
      }
    }
    multiplier *= retargetingModifier;
    console.log("[auction.js:applyBidModifiers] Retargeting modifier applied", { retargetingModifier, multiplier });
  }

  // Predictive modifier — boost bids for likely buyers
  if (bid.modifiers.predictive && enrichedContext.visitorProfile) {
    const prediction = predictPurchaseProbability(enrichedContext.visitorProfile);
    const predModifier = bid.modifiers.predictive[prediction.conversionSegment] || 1.0;
    multiplier *= predModifier;
    console.log("[auction.js:applyBidModifiers] Predictive modifier applied", { conversionSegment: prediction.conversionSegment, predModifier, multiplier });
  }

  // Clamp combined multiplier to [0.1, 5.0]
  const unclampedMultiplier = multiplier;
  multiplier = Math.min(5.0, Math.max(0.1, multiplier));
  const effectiveBid = bid.amount * multiplier;
  console.log("[auction.js:applyBidModifiers] Final bid after modifiers", { baseBid: bid.amount, unclampedMultiplier, clampedMultiplier: multiplier, effectiveBid });

  return effectiveBid;
}

/**
 * Compute eCPM for a bid based on its bid type.
 * - CPM: eCPM = bid.amount
 * - CPC: eCPM = bid.amount x predictedCTR x 1000
 * - CPA: eCPM = bid.amount x predictedCTR x predictedCVR x 1000
 *
 * @param {number} bidAmount - The effective bid amount (after modifiers)
 * @param {string} bidType - "cpm", "cpc", or "cpa"
 * @param {number} predictedCTR - Predicted click-through rate
 * @param {number} predictedCVR - Predicted conversion rate
 * @returns {number} The eCPM value
 */
function computeECPM(bidAmount, bidType, predictedCTR, predictedCVR) {
  let ecpm;
  switch (bidType) {
    case "cpc":
      ecpm = bidAmount * predictedCTR * 1000;
      break;
    case "cpa":
      ecpm = bidAmount * predictedCTR * predictedCVR * 1000;
      break;
    case "cpm":
    default:
      ecpm = bidAmount;
      break;
  }
  console.log("[auction.js:computeECPM] Computed eCPM", { bidAmount, bidType, predictedCTR, predictedCVR, ecpm });
  return ecpm;
}

/**
 * Convert a charged eCPM back to the winner's bid type unit.
 * - CPM: chargedAmount = chargedEcpm
 * - CPC: chargedAmount = chargedEcpm / (predictedCTR x 1000)
 * - CPA: chargedAmount = chargedEcpm / (predictedCTR x predictedCVR x 1000)
 */
function ecpmToBidTypeAmount(chargedEcpm, bidType, predictedCTR, predictedCVR) {
  let amount;
  switch (bidType) {
    case "cpc":
      amount = chargedEcpm / (predictedCTR * 1000);
      break;
    case "cpa":
      amount = chargedEcpm / (predictedCTR * predictedCVR * 1000);
      break;
    case "cpm":
    default:
      amount = chargedEcpm;
      break;
  }
  console.log("[auction.js:ecpmToBidTypeAmount] Converted eCPM to bid type amount", { chargedEcpm, bidType, amount });
  return amount;
}

/**
 * Run a second-price (GSP) auction for a given zone with smart targeting.
 * Returns the winning ad or null if no eligible ads.
 *
 * @param {string} shopDomain - The Shopify shop domain
 * @param {string} zoneSlug - The zone slug identifier
 * @param {object} requestContext - Optional targeting context
 * @param {string} requestContext.ip - Visitor IP address
 * @param {string} requestContext.userAgent - Visitor User-Agent string
 * @param {string} requestContext.visitorId - Unique visitor identifier
 * @param {string} requestContext.pageUrl - Current page URL
 * @param {object} requestContext.frequencyData - Map of { campaignId: impressionCount }
 * @param {number} requestContext.timestamp - Request timestamp
 */
export async function runAuction(shopDomain, zoneSlug, requestContext = {}, count = 1) {
  console.log("[auction.js:runAuction] === AUCTION START ===", { shopDomain, zoneSlug, count, visitorId: requestContext.visitorId, ip: requestContext.ip, pageUrl: requestContext.pageUrl });

  // 1. Check cache for recent auction result (skip cache for visitor-specific requests)
  const cacheKey = `auction:${shopDomain}:${zoneSlug}:${count}`;
  const hasVisitorContext =
    (requestContext.visitorId) ||
    (requestContext.frequencyData && Object.keys(requestContext.frequencyData).length > 0);

  if (!hasVisitorContext) {
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("[auction.js:runAuction] CACHE HIT - returning cached auction result", { cacheKey });
      return cached;
    }
    console.log("[auction.js:runAuction] CACHE MISS - no cached result", { cacheKey });
  } else {
    console.log("[auction.js:runAuction] Skipping cache due to visitor context", { visitorId: requestContext.visitorId, hasFrequencyData: !!(requestContext.frequencyData && Object.keys(requestContext.frequencyData).length > 0) });
  }

  // 2. Find the zone by slug
  console.log("[auction.js:runAuction] Step 2: Loading zone", { zoneSlug });
  const zonesSnapshot = await db
    .collection("zones")
    .where("slug", "==", zoneSlug)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (zonesSnapshot.empty) {
    console.log("[auction.js:runAuction] Zone not found or inactive, returning null", { zoneSlug });
    return null;
  }
  const zoneDoc = zonesSnapshot.docs[0];
  const zone = { id: zoneDoc.id, ...zoneDoc.data() };
  console.log("[auction.js:runAuction] Zone loaded", { zoneId: zone.id, zoneType: zone.type, merchantId: zone.merchantId });

  // 3. Get all active bids for this zone, ordered by amount descending
  console.log("[auction.js:runAuction] Step 3: Loading bids for zone", { zoneId: zone.id });
  const bidsSnapshot = await db
    .collection("bids")
    .where("zoneId", "==", zone.id)
    .where("status", "==", "active")
    .orderBy("amount", "desc")
    .get();

  if (bidsSnapshot.empty) {
    console.log("[auction.js:runAuction] No active bids found for zone, returning null", { zoneId: zone.id });
    return null;
  }
  console.log("[auction.js:runAuction] Found bids", { totalBids: bidsSnapshot.docs.length });

  // 4. For each bid, load campaign + creative data
  console.log("[auction.js:runAuction] Step 4: Loading campaigns and creatives for each bid");
  const eligibleBids = [];
  for (const bidDoc of bidsSnapshot.docs) {
    const bid = { id: bidDoc.id, ...bidDoc.data() };
    const campaign = await getCampaignIfEligible(bid.campaignId);
    if (!campaign) {
      console.log("[auction.js:runAuction] Bid skipped - campaign not eligible", { bidId: bid.id, campaignId: bid.campaignId });
      continue;
    }

    const creative = await getApprovedCreative(campaign, zone.type);
    if (!creative) {
      console.log("[auction.js:runAuction] Bid skipped - no approved creative", { bidId: bid.id, campaignId: campaign.id });
      continue;
    }

    eligibleBids.push({
      bid,
      campaign,
      creative,
      amount: bid.amount,
    });
  }

  console.log("[auction.js:runAuction] Eligible bids after campaign/creative filtering", { eligibleCount: eligibleBids.length, totalBids: bidsSnapshot.docs.length });

  if (eligibleBids.length === 0) {
    console.log("[auction.js:runAuction] No eligible bids remain, returning null");
    return null;
  }

  // 5. Build enriched request context
  console.log("[auction.js:runAuction] Step 5: Enriching request context");
  const enrichedContext = { ...requestContext };

  // Resolve geo from IP (if IP provided)
  if (requestContext.ip) {
    try {
      enrichedContext.geo = await resolveGeo(requestContext.ip);
      console.log("[auction.js:runAuction] Geo resolved from IP", { ip: requestContext.ip, geo: enrichedContext.geo });
    } catch {
      enrichedContext.geo = { country: "US", region: "", city: "" };
      console.log("[auction.js:runAuction] Geo resolution failed, using default", { geo: enrichedContext.geo });
    }
  }

  // Parse device from User-Agent
  if (requestContext.userAgent) {
    enrichedContext.device = parseDevice(requestContext.userAgent);
    console.log("[auction.js:runAuction] Device parsed from UA", { device: enrichedContext.device });
  }

  // Load zone page context from page_contexts collection (if available)
  try {
    const pageContextSnap = await db
      .collection("page_contexts")
      .where("zoneId", "==", zone.id)
      .limit(1)
      .get();

    if (!pageContextSnap.empty) {
      enrichedContext.pageContext = pageContextSnap.docs[0].data();
      console.log("[auction.js:runAuction] Page context loaded from DB", { category: enrichedContext.pageContext.category });
    } else if (zone.context) {
      enrichedContext.pageContext = zone.context;
      console.log("[auction.js:runAuction] Page context loaded from zone", { category: zone.context.category });
    } else {
      console.log("[auction.js:runAuction] No page context available");
    }
  } catch {
    // Page context is optional; continue without it
    console.log("[auction.js:runAuction] Page context fetch failed, continuing without it");
  }

  // Load visitor profile and evaluate audience segments (if visitor context available)
  let visitorProfile = null;
  if (requestContext.visitorId && zone.merchantId) {
    console.log("[auction.js:runAuction] Loading visitor profile and segments", { visitorId: requestContext.visitorId, merchantId: zone.merchantId });
    try {
      visitorProfile = await getVisitorProfile(requestContext.visitorId, zone.merchantId);
      const segmentRulesSnap = await db
        .collection("audience_segments")
        .where("merchantId", "==", zone.merchantId)
        .get();
      if (!segmentRulesSnap.empty && visitorProfile) {
        const segmentRules = segmentRulesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        enrichedContext.visitorSegments = evaluateSegments(visitorProfile, segmentRules);
        console.log("[auction.js:runAuction] Visitor segments evaluated", { segmentCount: enrichedContext.visitorSegments?.length, segments: enrichedContext.visitorSegments });
      }
    } catch (err) {
      // Audience targeting is optional; continue without segments on error
      console.error("Audience segment evaluation error:", err.message);
    }
  }

  // Auto-segments from behavioral scoring
  if (visitorProfile) {
    console.log("[auction.js:runAuction] Computing auto-segments and enrichments from visitor profile");
    const autoSegments = evaluateAutoSegments(visitorProfile);
    enrichedContext.visitorSegments = [
      ...(enrichedContext.visitorSegments || []),
      ...autoSegments,
    ];
    enrichedContext.visitorProfile = visitorProfile;
    console.log("[auction.js:runAuction] Auto-segments added", { autoSegments, totalSegments: enrichedContext.visitorSegments.length });

    // Build interest profile
    enrichedContext.interestProfile = buildInterestProfile(visitorProfile);
    console.log("[auction.js:runAuction] Interest profile built", { topInterests: enrichedContext.interestProfile?.topInterests });

    // Predictive segments
    const prediction = predictPurchaseProbability(visitorProfile);
    if (prediction.conversionSegment === "very_likely") enrichedContext.visitorSegments.push("auto:likely_to_purchase");
    if (prediction.conversionSegment === "likely") enrichedContext.visitorSegments.push("auto:warm_lead");
    if (prediction.churnRisk >= 0.6) enrichedContext.visitorSegments.push("auto:churn_risk");
    console.log("[auction.js:runAuction] Predictive segments computed", { purchaseProbability: prediction.purchaseProbability, conversionSegment: prediction.conversionSegment });

    // Engagement score for contextual creative selection
    const { engagementScore } = computeEngagementScore(visitorProfile);
    enrichedContext.engagementScore = engagementScore;
    console.log("[auction.js:runAuction] Engagement score computed", { engagementScore });
  }

  // Retargeting lists
  enrichedContext.retargetingLists = requestContext.retargetingLists || {};
  console.log("[auction.js:runAuction] Retargeting lists set", { listCount: Object.keys(enrichedContext.retargetingLists).length });

  // Re-select creatives using contextual Thompson Sampling when visitor context is available
  if (visitorProfile) {
    console.log("[auction.js:runAuction] Re-selecting creatives with contextual Thompson Sampling");
    for (const ad of eligibleBids) {
      const contextualCreative = await getApprovedCreative(ad.campaign, zone.type, enrichedContext);
      if (contextualCreative) {
        ad.creative = contextualCreative;
      }
    }
  }

  // 6. Filter by hard targeting constraints
  console.log("[auction.js:runAuction] Step 6: Filtering by targeting constraints", { inputCount: eligibleBids.length });
  let filteredAds = filterByTargeting(eligibleBids, enrichedContext);
  console.log("[auction.js:runAuction] Targeting filter result", { inputCount: eligibleBids.length, outputCount: filteredAds.length });

  // If all ads filtered out, fall back to unfiltered (backward compatibility)
  if (filteredAds.length === 0) {
    console.log("[auction.js:runAuction] All ads filtered out, falling back to unfiltered set", { unfilteredCount: eligibleBids.length });
    filteredAds = eligibleBids;
  }

  // 7. Apply bid modifiers and compute eCPM for each ad
  console.log("[auction.js:runAuction] Step 7: Applying bid modifiers and computing eCPM");
  for (const ad of filteredAds) {
    const bidType = ad.bid.bidType || "cpm";
    const predictedCTR = ad.creative?.stats?.ctr || 0.01;
    const predictedCVR = bidType === "cpa" ? await getPredictedCVR(ad.campaign.id) : 0.01;

    // Apply context-specific bid modifiers
    ad.effectiveBid = applyBidModifiers(ad.bid, enrichedContext);

    // Clamp to maxBid if set
    if (ad.bid.maxBid && ad.effectiveBid > ad.bid.maxBid) {
      console.log("[auction.js:runAuction] Bid clamped to maxBid", { bidId: ad.bid.id, effectiveBid: ad.effectiveBid, maxBid: ad.bid.maxBid });
      ad.effectiveBid = ad.bid.maxBid;
    }

    // Store predicted rates for later use
    ad.predictedCTR = predictedCTR;
    ad.predictedCVR = predictedCVR;
    ad.bidType = bidType;

    // Compute eCPM for unified ranking
    ad.eCPM = computeECPM(ad.effectiveBid, bidType, predictedCTR, predictedCVR);
    console.log("[auction.js:runAuction] Ad eCPM computed", { bidId: ad.bid.id, campaignId: ad.campaign.id, bidType, effectiveBid: ad.effectiveBid, eCPM: ad.eCPM, predictedCTR, predictedCVR });
  }

  // 8. Compute quality scores in parallel for all filtered ads
  console.log("[auction.js:runAuction] Step 8: Computing quality scores", { adCount: filteredAds.length });
  const qualityScoreResults = await Promise.all(
    filteredAds.map(ad => computeQualityScore(ad.campaign, ad.creative, zone))
  );

  // Store quality scores on each ad
  const qualityScoresMap = {};
  filteredAds.forEach((ad, i) => {
    ad.qualityScoreResult = qualityScoreResults[i];
    qualityScoresMap[ad.creative.id] = qualityScoreResults[i];
    console.log("[auction.js:runAuction] Quality score for ad", { creativeId: ad.creative.id, qualityScore: qualityScoreResults[i]?.score });
  });

  // Product affinity scores
  let affinityScores = {};
  if (visitorProfile) {
    const viewedProducts = (visitorProfile.events || [])
      .filter(e => e.type === "product_view" && e.data?.handle)
      .map(e => e.data.handle);

    if (viewedProducts.length > 0) {
      console.log("[auction.js:runAuction] Computing product affinity scores", { viewedProductCount: viewedProducts.length });
      affinityScores = await computeProductAffinity(viewedProducts, filteredAds, zone.merchantId)
        .catch(() => ({}));
      console.log("[auction.js:runAuction] Product affinity scores computed", { matchedAds: Object.keys(affinityScores).length });
    }
  }
  enrichedContext.affinityScores = affinityScores;

  // 9. Score remaining ads with composite scoring (using eCPM as bid amount + quality score)
  console.log("[auction.js:runAuction] Step 9: Computing composite scores");
  const scoredAds = filteredAds.map((ad) => {
    const { compositeScore, qualityFactor } = scoreAd(ad, enrichedContext, ad.qualityScoreResult);
    console.log("[auction.js:runAuction] Composite score for ad", { creativeId: ad.creative.id, campaignId: ad.campaign.id, compositeScore, qualityFactor, eCPM: ad.eCPM });
    return {
      ...ad,
      compositeScore,
      qualityFactor,
    };
  });

  // 10. Sort by composite score (not just bid amount)
  scoredAds.sort((a, b) => b.compositeScore - a.compositeScore);
  console.log("[auction.js:runAuction] Step 10: Ads sorted by composite score", { topScore: scoredAds[0]?.compositeScore, bottomScore: scoredAds[scoredAds.length - 1]?.compositeScore });

  // Semantic tiebreaker: if top-2 ads within 10% score, use semantic relevance
  if (scoredAds.length >= 2 && enrichedContext.pageContext) {
    const gap = (scoredAds[0].compositeScore - scoredAds[1].compositeScore) /
                Math.max(0.01, scoredAds[0].compositeScore);
    if (gap < 0.10) {
      console.log("[auction.js:runAuction] Semantic tiebreaker triggered (top-2 within 10%)", { gap, score1: scoredAds[0].compositeScore, score2: scoredAds[1].compositeScore });
      try {
        const { computeSemanticRelevance } = await import("./context-analyzer.js");
        for (let i = 0; i < Math.min(2, scoredAds.length); i++) {
          const semanticScore = await computeSemanticRelevance(
            scoredAds[i].creative?.context, enrichedContext.pageContext
          );
          const oldScore = scoredAds[i].compositeScore;
          scoredAds[i].compositeScore *= (0.9 + semanticScore * 0.2);
          console.log("[auction.js:runAuction] Semantic relevance applied", { creativeId: scoredAds[i].creative.id, semanticScore, oldComposite: oldScore, newComposite: scoredAds[i].compositeScore });
        }
        scoredAds.sort((a, b) => b.compositeScore - a.compositeScore);
      } catch (err) {
        console.log("[auction.js:runAuction] Semantic scoring failed, continuing with existing order", { error: err.message });
      }
    }
  }

  // 11. Deduplicate by campaignId (same campaign shouldn't appear twice in multi-ad)
  const seenCampaigns = {};
  const dedupedAds = [];
  for (const ad of scoredAds) {
    if (!seenCampaigns[ad.campaign.id]) {
      seenCampaigns[ad.campaign.id] = true;
      dedupedAds.push(ad);
    }
  }
  console.log("[auction.js:runAuction] Step 11: Deduplication", { beforeDedup: scoredAds.length, afterDedup: dedupedAds.length });

  const floorBid = zone.settings?.minBid || 100;
  const winnersCount = Math.min(count, dedupedAds.length);
  console.log("[auction.js:runAuction] Step 12: GSP pricing for winners", { winnersCount, floorBid });

  // 12. Build results for top N winners with GSP pricing
  const results = [];
  for (let i = 0; i < winnersCount; i++) {
    const winner = dedupedAds[i];

    // GSP Pricing: each winner pays based on next bidder's composite score / winner's quality factor
    let chargedEcpm;
    if (i + 1 < dedupedAds.length) {
      const nextBidder = dedupedAds[i + 1];
      chargedEcpm = (nextBidder.compositeScore / winner.qualityFactor) + 0.01;
      console.log("[auction.js:runAuction] GSP pricing (next bidder)", { winnerIdx: i, winnerComposite: winner.compositeScore, nextBidderComposite: nextBidder.compositeScore, winnerQualityFactor: winner.qualityFactor, chargedEcpm });
    } else {
      chargedEcpm = floorBid;
      console.log("[auction.js:runAuction] GSP pricing (floor bid, no next bidder)", { winnerIdx: i, chargedEcpm: floorBid });
    }

    // Clamp: don't exceed winner's own eCPM, and respect floor
    chargedEcpm = Math.min(chargedEcpm, winner.eCPM);
    chargedEcpm = Math.max(chargedEcpm, floorBid);
    console.log("[auction.js:runAuction] Charged eCPM after clamping", { winnerIdx: i, chargedEcpm, winnerEcpm: winner.eCPM, floorBid });

    // Convert charged eCPM back to winner's bid type for billing
    const chargedAmount = ecpmToBidTypeAmount(
      chargedEcpm,
      winner.bidType,
      winner.predictedCTR,
      winner.predictedCVR
    );

    // 13. Check sufficient balance before confirming winner
    let hasBalance = true;
    try {
      const advertiserId = winner.campaign.advertiserId;
      if (advertiserId) {
        hasBalance = await hasSufficientBalance(advertiserId, chargedAmount);
        console.log("[auction.js:runAuction] Balance check", { advertiserId, chargedAmount, hasBalance });
      }
    } catch {
      // If balance check fails, proceed anyway (don't block ad serving)
      console.log("[auction.js:runAuction] Balance check failed, proceeding anyway");
    }

    if (!hasBalance) {
      console.log("[auction.js:runAuction] Skipping winner - insufficient balance", { campaignId: winner.campaign.id, advertiserId: winner.campaign.advertiserId, chargedAmount });
      continue; // Skip this winner, try next
    }

    const result = buildResult(winner, zone, chargedAmount, winner.bidType, winner.predictedCTR, winner.predictedCVR);
    results.push(result);
    console.log("[auction.js:runAuction] Winner confirmed", { position: i, creativeId: winner.creative.id, campaignId: winner.campaign.id, bidType: winner.bidType, chargedAmount, compositeScore: winner.compositeScore });
  }

  if (results.length === 0) {
    console.log("[auction.js:runAuction] === AUCTION END - No winners (all failed balance check) ===");
    return null;
  }

  // 14. Cache the result (only for anonymous requests without visitor context)
  const finalResult = count === 1 ? results[0] : results;
  if (!hasVisitorContext) {
    cache.set(cacheKey, finalResult, AUCTION_CACHE_TTL);
    console.log("[auction.js:runAuction] Result cached", { cacheKey, ttl: AUCTION_CACHE_TTL });
  }

  // 15. Record auction outcome (fire-and-forget)
  console.log("[auction.js:runAuction] Step 15: Buffering auction outcome", { numBidders: scoredAds.length, numWinners: results.length });
  bufferAuctionOutcome({
    zoneId: zone.id,
    merchantId: zone.merchantId,
    timestamp: new Date(),
    winnerId: dedupedAds[0]?.creative.id,
    winnerCampaignId: dedupedAds[0]?.campaign.id,
    winnerBidType: dedupedAds[0]?.bidType,
    winnerBid: dedupedAds[0]?.effectiveBid,
    chargedAmount: results[0]?.chargedAmount,
    numBidders: scoredAds.length,
    numWinners: results.length,
    participants: scoredAds.map(ad => ({
      creativeId: ad.creative.id,
      campaignId: ad.campaign.id,
      bidType: ad.bidType,
      effectiveBid: ad.effectiveBid,
      eCPM: ad.eCPM,
      compositeScore: ad.compositeScore,
      qualityFactor: ad.qualityFactor,
    })),
    qualityScores: qualityScoresMap,
  });

  console.log("[auction.js:runAuction] === AUCTION END - Success ===", { winnerId: results[0]?.adId, winnerCampaignId: results[0]?.campaignId, chargedAmount: results[0]?.chargedAmount, totalParticipants: scoredAds.length });
  return finalResult;
}

/**
 * Build the auction result object from the winning ad.
 */
function buildResult(winner, zone, chargeAmount, bidType = "cpm", predictedCtr = 0.01, predictedCvr = 0.01) {
  console.log("[auction.js:buildResult] Building result", { creativeId: winner.creative.id, campaignId: winner.campaign.id, chargeAmount, bidType });
  // Compute CPC/CPA equivalents for the billing payload
  const chargedCpm = bidType === "cpm" ? chargeAmount : computeECPM(chargeAmount, bidType, predictedCtr, predictedCvr);
  const chargedCpc = predictedCtr > 0 ? chargedCpm / (predictedCtr * 1000) : chargeAmount;
  const chargedCpa = (predictedCtr > 0 && predictedCvr > 0)
    ? chargedCpm / (predictedCtr * predictedCvr * 1000)
    : chargeAmount;

  const billingPayload = JSON.stringify({
    advertiserId: winner.campaign.advertiserId,
    campaignId: winner.campaign.id,
    chargedCpm,
    bidType,
    chargedCpc,
    chargedCpa,
    predictedCtr,
    predictedCvr,
    zoneId: zone.id,
    merchantId: zone.merchantId,
    ts: Date.now(),
  });
  const hmac = crypto
    .createHmac(
      "sha256",
      process.env.IMPRESSION_SECRET ||
        process.env.ADVERTISER_JWT_SECRET ||
        "adzone-billing-secret",
    )
    .update(billingPayload)
    .digest("hex");
  const billingToken =
    Buffer.from(billingPayload).toString("base64") + "." + hmac;

  console.log("[auction.js:buildResult] Result built", { chargedCpm, chargedCpc, chargedCpa, advertiserId: winner.campaign.advertiserId });
  return {
    adId: winner.creative.id,
    campaignId: winner.campaign.id,
    creativeType: winner.creative.type,
    imageUrl: winner.creative.imageUrl || null,
    altText: winner.creative.altText || "",
    destinationUrl: winner.creative.destinationUrl,
    zoneId: zone.id,
    bidId: winner.bid.id,
    bidType,
    chargedCpm,
    chargedAmount: chargeAmount,
    productData: winner.creative.productData || null,
    advertiserId: winner.campaign.advertiserId,
    merchantId: zone.merchantId,
    billingToken,
  };
}

/**
 * Check if a campaign is eligible (active, within schedule, within budget).
 */
async function getCampaignIfEligible(campaignId) {
  console.log("[auction.js:getCampaignIfEligible] Checking campaign eligibility", { campaignId });
  const doc = await db.collection("campaigns").doc(campaignId).get();
  if (!doc.exists) {
    console.log("[auction.js:getCampaignIfEligible] Campaign not found", { campaignId });
    return null;
  }
  const campaign = doc.data();

  const now = new Date();
  if (campaign.status !== "active") {
    console.log("[auction.js:getCampaignIfEligible] Campaign not active", { campaignId, status: campaign.status });
    return null;
  }

  if (campaign.schedule?.startDate) {
    const start = campaign.schedule.startDate.toDate
      ? campaign.schedule.startDate.toDate()
      : new Date(campaign.schedule.startDate);
    if (start > now) {
      console.log("[auction.js:getCampaignIfEligible] Campaign not yet started", { campaignId, startDate: start });
      return null;
    }
  }

  if (campaign.schedule?.endDate) {
    const end = campaign.schedule.endDate.toDate
      ? campaign.schedule.endDate.toDate()
      : new Date(campaign.schedule.endDate);
    if (end < now) {
      console.log("[auction.js:getCampaignIfEligible] Campaign ended", { campaignId, endDate: end });
      return null;
    }
  }

  if (campaign.budget?.total && campaign.budget.spent >= campaign.budget.total) {
    console.log("[auction.js:getCampaignIfEligible] Campaign total budget exhausted", { campaignId, spent: campaign.budget.spent, total: campaign.budget.total });
    return null;
  }

  // Daily budget check
  if (campaign.budget?.daily) {
    const dateStr = new Date().toISOString().split("T")[0];
    const dailyDoc = await db
      .collection("daily_spend")
      .doc(`${doc.id}_${dateStr}`)
      .get();
    const dailySpent = dailyDoc.exists ? dailyDoc.data().spent || 0 : 0;
    if (dailySpent >= campaign.budget.daily) {
      console.log("[auction.js:getCampaignIfEligible] Campaign daily budget exhausted", { campaignId, dailySpent, dailyBudget: campaign.budget.daily });
      return null;
    }
  }

  console.log("[auction.js:getCampaignIfEligible] Campaign eligible", { campaignId, advertiserId: campaign.advertiserId });
  return { id: doc.id, ...campaign };
}

/**
 * Get an approved creative for a campaign matching the zone type.
 * Fetches all approved creatives and uses Thompson Sampling (A/B testing)
 * to select the best variant when multiple creatives exist.
 * When enrichedContext is provided, uses Contextual Thompson Sampling for
 * segment-aware creative selection.
 */
async function getApprovedCreative(campaign, zoneType, enrichedContext = null) {
  console.log("[auction.js:getApprovedCreative] Fetching approved creative", { campaignId: campaign.id, zoneType, hasEnrichedContext: !!enrichedContext });
  const creativeType = zoneType === "banner" ? "banner_image" : "promoted_product";
  const snapshot = await db
    .collection("creatives")
    .where("campaignId", "==", campaign.id)
    .where("status", "==", "approved")
    .where("type", "==", creativeType)
    .get();

  if (snapshot.empty) {
    console.log("[auction.js:getApprovedCreative] No approved creatives found", { campaignId: campaign.id, creativeType });
    return null;
  }

  const creatives = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  console.log("[auction.js:getApprovedCreative] Found creatives", { count: creatives.length, campaignId: campaign.id });

  // Use Contextual Thompson Sampling when visitor context is available
  if (enrichedContext) {
    const visitorContext = {
      segments: enrichedContext.visitorSegments || [],
      engagementScore: enrichedContext.engagementScore || 0,
    };
    const selectedCreative = selectVariantContextual(creatives, visitorContext);
    console.log("[auction.js:getApprovedCreative] Contextual Thompson Sampling selected", { selectedCreativeId: selectedCreative?.id, totalCreatives: creatives.length });

    // Record contextual impression
    if (selectedCreative) {
      const contextBucket = determineContextBucket(visitorContext);
      recordVariantEventContextual(selectedCreative.id, "impression", contextBucket);
    }

    return selectedCreative;
  }

  // Fall back to global Thompson Sampling when no visitor context
  const selected = selectVariant(creatives);
  console.log("[auction.js:getApprovedCreative] Global Thompson Sampling selected", { selectedCreativeId: selected?.id, totalCreatives: creatives.length });
  return selected;
}
