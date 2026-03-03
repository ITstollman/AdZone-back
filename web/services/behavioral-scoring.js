import { db } from "../firebase.js";

/**
 * RFM Scoring for visitor profiles.
 * R = days since last visit, F = visit count, M = cart value
 */
export function computeRFMScore(profile) {
  console.log("[behavioral-scoring.js:computeRFMScore] Computing RFM score", { profileId: profile?.id, visitCount: profile?.visitCount, lastVisitAt: profile?.lastVisitAt });
  if (!profile) {
    console.log("[behavioral-scoring.js:computeRFMScore] No profile, returning cold defaults");
    return { recency: 1, frequency: 1, monetary: 1, rfmScore: 0, rfmSegment: "cold" };
  }

  const daysSinceVisit = profile.lastVisitAt
    ? (Date.now() - new Date(profile.lastVisitAt).getTime()) / (1000 * 60 * 60 * 24)
    : 999;
  const recency = daysSinceVisit <= 1 ? 5 : daysSinceVisit <= 3 ? 4 : daysSinceVisit <= 7 ? 3 : daysSinceVisit <= 30 ? 2 : 1;

  const visits = profile.visitCount || 0;
  const frequency = visits >= 20 ? 5 : visits >= 10 ? 4 : visits >= 5 ? 3 : visits >= 2 ? 2 : 1;

  const cartValue = profile.aggregates?.cartValue || 0;
  const monetary = cartValue >= 50000 ? 5 : cartValue >= 20000 ? 4 : cartValue >= 5000 ? 3 : cartValue >= 1000 ? 2 : 1;

  const rfmScore = Math.round(((recency + frequency + monetary) / 15) * 100);

  let rfmSegment;
  if (recency >= 4 && frequency >= 4 && monetary >= 4) rfmSegment = "champion";
  else if (recency >= 4 && frequency >= 3) rfmSegment = "loyal";
  else if (recency >= 3 && monetary >= 3) rfmSegment = "potential_loyalist";
  else if (recency >= 4 && frequency <= 2) rfmSegment = "new_customer";
  else if (recency <= 2 && frequency >= 3) rfmSegment = "at_risk";
  else if (recency <= 1 && frequency >= 4) rfmSegment = "cant_lose";
  else if (recency <= 2 && frequency <= 2) rfmSegment = "hibernating";
  else rfmSegment = "about_to_sleep";

  console.log("[behavioral-scoring.js:computeRFMScore] RFM score computed", { R: recency, F: frequency, M: monetary, rfmScore, rfmSegment, daysSinceVisit: Math.round(daysSinceVisit), visits, cartValue });
  return { recency, frequency, monetary, rfmScore, rfmSegment };
}

/**
 * Engagement scoring from behavioral signals.
 * 6 weighted dimensions → 0-100 composite.
 */
export function computeEngagementScore(profile) {
  console.log("[behavioral-scoring.js:computeEngagementScore] Computing engagement score", { profileId: profile?.id });
  if (!profile) {
    console.log("[behavioral-scoring.js:computeEngagementScore] No profile, returning 0");
    return { engagementScore: 0, dimensions: {} };
  }
  const agg = profile.aggregates || {};

  const browsingDepth = Math.min(1, (agg.pageViews || 0) / 50);
  const productInterest = Math.min(1, (agg.productsViewed || 0) / 20);
  const cartIntent = Math.min(1, (agg.cartAdditions || 0) / 10);
  const searchEngagement = Math.min(1, (agg.searchQueries?.length || 0) / 5);
  const collectionExploration = Math.min(1, (agg.collectionsViewed || 0) / 10);
  const sessionFrequency = Math.min(1, (profile.visitCount || 0) / 15);

  const engagementScore = Math.round(
    (browsingDepth * 0.15 + productInterest * 0.25 + cartIntent * 0.25 +
     searchEngagement * 0.10 + collectionExploration * 0.10 + sessionFrequency * 0.15) * 100
  );

  const dimensions = { browsingDepth, productInterest, cartIntent, searchEngagement, collectionExploration, sessionFrequency };
  console.log("[behavioral-scoring.js:computeEngagementScore] Engagement score computed", { engagementScore, dimensions, pageViews: agg.pageViews, productsViewed: agg.productsViewed, cartAdditions: agg.cartAdditions, visitCount: profile.visitCount });

  return {
    engagementScore,
    dimensions,
  };
}

/**
 * Auto-generated segments based on behavioral scoring.
 * Returns array of auto-segment identifiers.
 */
export function evaluateAutoSegments(profile) {
  console.log("[behavioral-scoring.js:evaluateAutoSegments] Evaluating auto-segments", { profileId: profile?.id });
  const segments = [];
  if (!profile) {
    console.log("[behavioral-scoring.js:evaluateAutoSegments] No profile, returning empty segments");
    return segments;
  }

  const rfm = computeRFMScore(profile);
  const engagement = computeEngagementScore(profile);
  const agg = profile.aggregates || {};

  if (rfm.rfmSegment === "champion" || rfm.rfmSegment === "loyal") segments.push("auto:high_value");
  if (rfm.rfmSegment === "at_risk" || rfm.rfmSegment === "cant_lose") segments.push("auto:at_risk");
  if ((profile.visitCount || 0) <= 2) segments.push("auto:new_visitor");
  if ((profile.visitCount || 0) >= 10 && (agg.cartAdditions || 0) < 2) segments.push("auto:frequent_browser");
  if ((agg.cartAdditions || 0) > 0) {
    const hasPurchase = (profile.events || []).some(e => e.type === "purchase");
    if (!hasPurchase) segments.push("auto:cart_abandoner");
  }
  if (engagement.engagementScore >= 70) segments.push("auto:high_intent");
  if ((agg.productsViewed || 0) >= 5 && (agg.cartAdditions || 0) === 0) segments.push("auto:window_shopper");
  if ((agg.searchQueries?.length || 0) >= 3) segments.push("auto:active_searcher");

  // Predictive segments (imported from predictive-audiences.js)
  // These will be added by the predictive-audiences module calling back into evaluateAutoSegments
  // or by Phase 6 integration in auction.js

  console.log("[behavioral-scoring.js:evaluateAutoSegments] Auto-segments evaluated", { matchedSegments: segments, rfmSegment: rfm.rfmSegment, engagementScore: engagement.engagementScore, visitCount: profile.visitCount, cartAdditions: agg.cartAdditions });
  return segments;
}
