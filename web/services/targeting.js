import NodeCache from "node-cache";
import { UAParser } from "ua-parser-js";
import { computeRelevanceScore } from "./context-analyzer.js";
import { computeBlendedScore } from "./blended-scorer.js";

const geoCache = new NodeCache({ stdTTL: 3600 }); // 1hr cache for IP geo

/**
 * Resolve an IP address to geo data using ip-api.com (free, no key needed).
 * Returns { country, region, city } with sensible defaults on failure.
 */
export async function resolveGeo(ip) {
  console.log("[targeting.js:resolveGeo] Resolving geo for IP", { ip });
  if (!ip || ip === "127.0.0.1" || ip === "::1") {
    console.log("[targeting.js:resolveGeo] Localhost IP, returning default geo", { ip });
    return { country: "US", region: "", city: "" };
  }

  const cached = geoCache.get(ip);
  if (cached) {
    console.log("[targeting.js:resolveGeo] CACHE HIT for IP geo", { ip, geo: cached });
    return cached;
  }
  console.log("[targeting.js:resolveGeo] CACHE MISS for IP geo, fetching from API", { ip });

  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=country,regionName,city,countryCode`
    );
    const data = await res.json();
    const geo = {
      country: data.countryCode || "US",
      region: data.regionName || "",
      city: data.city || "",
    };
    geoCache.set(ip, geo);
    console.log("[targeting.js:resolveGeo] Geo resolved from API", { ip, geo });
    return geo;
  } catch {
    console.log("[targeting.js:resolveGeo] Geo API call failed, returning default", { ip });
    return { country: "US", region: "", city: "" };
  }
}

/**
 * Parse device type from a User-Agent string.
 * Returns "mobile", "tablet", or "desktop".
 */
export function parseDevice(userAgent) {
  if (!userAgent) {
    console.log("[targeting.js:parseDevice] No user agent, defaulting to desktop");
    return "desktop";
  }
  const parser = new UAParser(userAgent);
  const device = parser.getDevice();
  const result = device.type === "mobile" ? "mobile" : device.type === "tablet" ? "tablet" : "desktop";
  console.log("[targeting.js:parseDevice] Device parsed", { deviceType: result, rawType: device.type });
  return result;
}

/**
 * Check if a campaign is active during the current daypart.
 * dayparting config: { enabled, days: [0-6], hours: [0-23] }
 * days: 0=Sun, 6=Sat. hours: UTC hours.
 */
export function isDaypartActive(dayparting, now = new Date()) {
  if (!dayparting || !dayparting.enabled) return true;

  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat

  if (dayparting.days && !dayparting.days.includes(day)) {
    console.log("[targeting.js:isDaypartActive] Daypart BLOCKED by day", { day, allowedDays: dayparting.days });
    return false;
  }
  if (dayparting.hours && !dayparting.hours.includes(hour)) {
    console.log("[targeting.js:isDaypartActive] Daypart BLOCKED by hour", { hour, allowedHours: dayparting.hours });
    return false;
  }

  return true;
}

/**
 * Check if a campaign is under its frequency cap for a given visitor.
 * frequencyData is a map of { campaignId: impressionCount }.
 * campaign.targeting.frequencyCap: { maxImpressions, periodHours }
 */
export function isUnderFrequencyCap(frequencyData, campaign) {
  if (!campaign.targeting?.frequencyCap) return true;
  const cap = campaign.targeting.frequencyCap;
  const campaignFreq = frequencyData?.[campaign.id] || 0;
  const underCap = campaignFreq < (cap.maxImpressions || Infinity);
  console.log("[targeting.js:isUnderFrequencyCap] Frequency cap check", { campaignId: campaign.id, currentFreq: campaignFreq, maxImpressions: cap.maxImpressions, underCap });
  return underCap;
}

/**
 * Check if a visitor matches retargeting criteria for a campaign.
 */
export function matchesRetargeting(retargetingConfig, retargetingLists) {
  console.log("[targeting.js:matchesRetargeting] Checking retargeting match", { enabled: retargetingConfig?.enabled, audienceCount: retargetingConfig?.audiences?.length, listKeys: Object.keys(retargetingLists || {}) });
  if (!retargetingConfig?.enabled) {
    console.log("[targeting.js:matchesRetargeting] Retargeting not enabled, passes filter");
    return true; // No retargeting = passes filter
  }
  if (!retargetingLists || Object.keys(retargetingLists).length === 0) {
    console.log("[targeting.js:matchesRetargeting] No retargeting lists available, BLOCKED");
    return false;
  }

  const audiences = retargetingConfig.audiences || [];
  if (audiences.length === 0) {
    console.log("[targeting.js:matchesRetargeting] No audience restrictions, passes filter");
    return true;
  }

  const lookbackMs = (retargetingConfig.lookbackDays || 30) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const result = audiences.some(audience => {
    const list = retargetingLists[audience] || [];
    return list.some(entry => (now - entry.ts) <= lookbackMs);
  });
  console.log("[targeting.js:matchesRetargeting] Retargeting match result", { result, audiences, lookbackDays: retargetingConfig.lookbackDays || 30 });
  return result;
}

/**
 * Filter ads by hard targeting constraints (geo, device, daypart, frequency, audience).
 * Returns only ads that pass all targeting rules.
 */
export function filterByTargeting(eligibleAds, requestContext) {
  console.log("[targeting.js:filterByTargeting] Filtering ads by targeting", { inputAdCount: eligibleAds.length, hasGeo: !!requestContext.geo, hasDevice: !!requestContext.device, hasFrequencyData: !!requestContext.frequencyData, hasVisitorSegments: !!requestContext.visitorSegments });
  const { geo, device, frequencyData, visitorSegments } = requestContext;

  const result = eligibleAds.filter((ad) => {
    const targeting = ad.campaign?.targeting || {};

    // Geo targeting
    if (targeting.geoTargets?.length > 0) {
      const geoMatch = targeting.geoTargets.some(
        (g) =>
          g.country === geo?.country ||
          g.region === geo?.region ||
          g.city === geo?.city
      );
      if (!geoMatch) {
        console.log("[targeting.js:filterByTargeting] Ad BLOCKED by geo targeting", { campaignId: ad.campaign?.id, geoTargets: targeting.geoTargets, visitorGeo: geo });
        return false;
      }
    }

    // Device targeting
    if (targeting.deviceTargets?.length > 0) {
      if (!targeting.deviceTargets.includes(device)) {
        console.log("[targeting.js:filterByTargeting] Ad BLOCKED by device targeting", { campaignId: ad.campaign?.id, deviceTargets: targeting.deviceTargets, visitorDevice: device });
        return false;
      }
    }

    // Daypart targeting
    if (!isDaypartActive(targeting.dayparting)) {
      console.log("[targeting.js:filterByTargeting] Ad BLOCKED by daypart targeting", { campaignId: ad.campaign?.id });
      return false;
    }

    // Frequency cap
    if (!isUnderFrequencyCap(frequencyData, ad.campaign)) {
      console.log("[targeting.js:filterByTargeting] Ad BLOCKED by frequency cap", { campaignId: ad.campaign?.id });
      return false;
    }

    // Audience segment targeting
    if (targeting.audienceSegments?.length > 0 && visitorSegments) {
      const segmentMatch = targeting.audienceSegments.some((s) =>
        visitorSegments.includes(s)
      );
      if (!segmentMatch) {
        console.log("[targeting.js:filterByTargeting] Ad BLOCKED by audience segment targeting", { campaignId: ad.campaign?.id, requiredSegments: targeting.audienceSegments, visitorSegments });
        return false;
      }
    }

    // Retargeting filter
    if (targeting.retargeting?.enabled) {
      if (!matchesRetargeting(targeting.retargeting, requestContext.retargetingLists)) {
        console.log("[targeting.js:filterByTargeting] Ad BLOCKED by retargeting filter", { campaignId: ad.campaign?.id });
        return false;
      }
    }

    console.log("[targeting.js:filterByTargeting] Ad PASSED all targeting filters", { campaignId: ad.campaign?.id });
    return true;
  });

  console.log("[targeting.js:filterByTargeting] Filtering complete", { inputCount: eligibleAds.length, outputCount: result.length, filteredOut: eligibleAds.length - result.length });
  return result;
}

/**
 * Compute composite ad score for auction ranking.
 * Combines bid amount, quality (multi-signal or CTR), blended relevance (context + behavior +
 * interest + affinity), and recency.
 * Returns { compositeScore, qualityFactor } for GSP pricing.
 *
 * @param {object} ad - The ad object with bid, campaign, creative data
 * @param {object} requestContext - Enriched request context with pageContext, geo, etc.
 * @param {object|null} qualityScoreResult - Optional quality score object from computeQualityScore (1-10 scale)
 * @returns {{ compositeScore: number, qualityFactor: number }}
 */
export function scoreAd(ad, requestContext, qualityScoreResult = null) {
  const bidAmount = ad.effectiveBid || ad.amount || 0;
  console.log("[targeting.js:scoreAd] Computing ad score", { creativeId: ad.creative?.id, campaignId: ad.campaign?.id, bidAmount, hasQualityScoreResult: !!qualityScoreResult });

  const qualityScore = qualityScoreResult
    ? Math.max(0.01, qualityScoreResult.score / 10)
    : Math.max(0.01, ad.creative?.stats?.ctr || 0.01);
  console.log("[targeting.js:scoreAd] Quality score", { qualityScore, source: qualityScoreResult ? "qualityScoreResult" : "ctr_fallback" });

  // Blended relevance: combines context + behavior + interest + affinity
  const { blendedScore } = computeBlendedScore({
    creativeContext: ad.creative?.context || null,
    pageContext: requestContext.pageContext || null,
    interestProfile: requestContext.interestProfile || null,
    visitorProfile: requestContext.visitorProfile || null,
    affinityScore: requestContext.affinityScores?.[ad.creative?.id] || 0,
  });

  const relevanceScore = Math.max(0.01, blendedScore);
  console.log("[targeting.js:scoreAd] Relevance (blended) score", { blendedScore, relevanceScore });

  // Recency bonus: up to 10% for campaigns < 7 days old
  let recencyBonus = 1.0;
  if (ad.campaign?.createdAt) {
    const ageMs = Date.now() - new Date(ad.campaign.createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 7) {
      recencyBonus = 1.0 + 0.1 * (1 - ageDays / 7);
    }
    console.log("[targeting.js:scoreAd] Recency bonus", { ageDays, recencyBonus });
  }

  const qualityFactor = qualityScore * relevanceScore * recencyBonus;
  const compositeScore = bidAmount * qualityFactor;
  console.log("[targeting.js:scoreAd] Final composite score", { bidAmount, qualityScore, relevanceScore, recencyBonus, qualityFactor, compositeScore });

  return { compositeScore, qualityFactor };
}
