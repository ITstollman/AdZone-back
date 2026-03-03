import NodeCache from "node-cache";
import { db } from "../firebase.js";
import { computeRelevanceScore } from "./context-analyzer.js";

const qualityCache = new NodeCache({ stdTTL: 3600 }); // 1hr cache

/**
 * Compute a 1-10 quality score based on 5 signals.
 *
 * 1. Historical CTR (35%) — recency-weighted CTR vs zone average
 * 2. Ad Relevance (25%) — creative-to-page context match
 * 3. Landing Page Signal (15%) — proxy bounce rate from clicks/page_views
 * 4. Creative Freshness (10%) — days since approval, decays over 60d
 * 5. Account Health (15%) — payment + approval rates
 */
export async function computeQualityScore(campaign, creative, zone) {
  console.log("[quality-score.js:computeQualityScore] Computing quality score", { campaignId: campaign.id, creativeId: creative.id, zoneId: zone.id });
  const cacheKey = `qs_${creative.id}`;
  const cached = qualityCache.get(cacheKey);
  if (cached) {
    console.log("[quality-score.js:computeQualityScore] CACHE HIT", { cacheKey, cachedScore: cached.score });
    return cached;
  }
  console.log("[quality-score.js:computeQualityScore] CACHE MISS", { cacheKey });

  // 1. CTR Score (35%)
  const creativeCtr = creative?.stats?.ctr || 0.01;
  const zoneAvgCtr = await getZoneAverageCTR(zone.id);
  const ctrRatio = Math.min(3.0, Math.max(0.2, creativeCtr / Math.max(0.001, zoneAvgCtr)));
  const ctrScore = Math.min(10, Math.max(1, ctrRatio * 3.33)); // maps 0.2-3.0 to 1-10
  console.log("[quality-score.js:computeQualityScore] Signal 1 - CTR Score (35%)", { creativeCtr, zoneAvgCtr, ctrRatio, ctrScore });

  // 2. Relevance Score (25%)
  const relevance = computeRelevanceScore(creative?.context || null, zone?.context || null);
  const relevanceScore = Math.max(1, relevance * 10);
  console.log("[quality-score.js:computeQualityScore] Signal 2 - Relevance Score (25%)", { rawRelevance: relevance, relevanceScore });

  // 3. Landing Page Signal (15%) — proxy: clicks that led to subsequent events
  let landingScore = 5; // neutral default
  try {
    // Check if campaign has conversion data suggesting good landing pages
    const convStatsDoc = await db.collection("conversion_stats").doc(campaign.id).get();
    if (convStatsDoc.exists) {
      const stats = convStatsDoc.data();
      const cvr = stats.clicks > 0 ? stats.conversions / stats.clicks : 0;
      landingScore = Math.min(10, Math.max(1, cvr * 100)); // 10% CVR = score 10
      console.log("[quality-score.js:computeQualityScore] Signal 3 - Landing Page (15%) from conversion stats", { conversions: stats.conversions, clicks: stats.clicks, cvr, landingScore });
    } else {
      console.log("[quality-score.js:computeQualityScore] Signal 3 - Landing Page (15%) no conversion stats, using default", { landingScore });
    }
  } catch {
    console.log("[quality-score.js:computeQualityScore] Signal 3 - Landing Page (15%) fetch failed, using default", { landingScore });
  }

  // 4. Creative Freshness (10%)
  let freshnessScore = 5;
  if (creative?.approvedAt || creative?.createdAt) {
    const approvedDate = creative.approvedAt?.toDate ? creative.approvedAt.toDate() : new Date(creative.approvedAt || creative.createdAt);
    const ageDays = (Date.now() - approvedDate.getTime()) / (1000 * 60 * 60 * 24);
    freshnessScore = Math.max(1, 10 - (ageDays / 30) * 5); // decays over 60 days
    console.log("[quality-score.js:computeQualityScore] Signal 4 - Freshness (10%)", { ageDays, freshnessScore });
  } else {
    console.log("[quality-score.js:computeQualityScore] Signal 4 - Freshness (10%) no date, using default", { freshnessScore });
  }

  // 5. Account Health (15%)
  let healthScore = 7; // decent default
  try {
    const advertiserDoc = await db.collection("advertisers").doc(campaign.advertiserId).get();
    if (advertiserDoc.exists) {
      const adv = advertiserDoc.data();
      // Payment success: has balance > 0 and has made deposits
      const paymentScore = adv.balance > 0 ? 8 : 4;
      // Creative approval rate
      const creativesSnap = await db.collection("creatives")
        .where("campaignId", "==", campaign.id).get();
      const total = creativesSnap.size;
      const approved = creativesSnap.docs.filter(d => d.data().status === "approved").length;
      const approvalRate = total > 0 ? approved / total : 0.5;
      const approvalScore = Math.min(10, Math.max(1, approvalRate * 10));
      healthScore = paymentScore * 0.5 + approvalScore * 0.5;
      console.log("[quality-score.js:computeQualityScore] Signal 5 - Account Health (15%)", { balance: adv.balance, paymentScore, totalCreatives: total, approvedCreatives: approved, approvalRate, approvalScore, healthScore });
    } else {
      console.log("[quality-score.js:computeQualityScore] Signal 5 - Account Health (15%) advertiser not found, using default", { advertiserId: campaign.advertiserId, healthScore });
    }
  } catch {
    console.log("[quality-score.js:computeQualityScore] Signal 5 - Account Health (15%) fetch failed, using default", { healthScore });
  }

  const score = (
    ctrScore * 0.35 +
    relevanceScore * 0.25 +
    landingScore * 0.15 +
    freshnessScore * 0.10 +
    healthScore * 0.15
  );

  const result = {
    score: Math.round(score * 10) / 10, // 1 decimal place
    breakdown: {
      ctr: { score: Math.round(ctrScore * 10) / 10, weight: 0.35, creativeCtr, zoneAvgCtr },
      relevance: { score: Math.round(relevanceScore * 10) / 10, weight: 0.25 },
      landingPage: { score: Math.round(landingScore * 10) / 10, weight: 0.15 },
      freshness: { score: Math.round(freshnessScore * 10) / 10, weight: 0.10 },
      accountHealth: { score: Math.round(healthScore * 10) / 10, weight: 0.15 },
    },
  };

  console.log("[quality-score.js:computeQualityScore] Final quality score computed", { creativeId: creative.id, finalScore: result.score, breakdown: { ctr: ctrScore, relevance: relevanceScore, landing: landingScore, freshness: freshnessScore, health: healthScore } });
  qualityCache.set(cacheKey, result);
  console.log("[quality-score.js:computeQualityScore] Result cached", { cacheKey });
  return result;
}

export async function getZoneAverageCTR(zoneId) {
  console.log("[quality-score.js:getZoneAverageCTR] Getting zone average CTR", { zoneId });
  const cacheKey = `zone_avg_ctr_${zoneId}`;
  const cached = qualityCache.get(cacheKey);
  if (cached !== undefined) {
    console.log("[quality-score.js:getZoneAverageCTR] CACHE HIT", { zoneId, avgCtr: cached });
    return cached;
  }
  console.log("[quality-score.js:getZoneAverageCTR] CACHE MISS", { zoneId });

  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split("T")[0];

    const snap = await db.collection("analytics_daily")
      .where("zoneId", "==", zoneId)
      .where("date", ">=", dateStr)
      .get();

    let totalImpressions = 0;
    let totalClicks = 0;
    snap.docs.forEach(doc => {
      const d = doc.data();
      totalImpressions += d.impressions || 0;
      totalClicks += d.clicks || 0;
    });

    const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0.01;
    console.log("[quality-score.js:getZoneAverageCTR] Zone average CTR computed", { zoneId, totalImpressions, totalClicks, avgCtr, daysQueried: 30 });
    qualityCache.set(cacheKey, avgCtr, 1800); // 30 min cache
    return avgCtr;
  } catch {
    console.log("[quality-score.js:getZoneAverageCTR] Query failed, returning default CTR", { zoneId, defaultCtr: 0.01 });
    return 0.01;
  }
}
