import { computeRFMScore } from "./behavioral-scoring.js";

/**
 * Predict purchase probability using heuristic signal scoring.
 * 6 weighted signals correlating with ecommerce conversion.
 */
export function predictPurchaseProbability(profile) {
  console.log("[predictive-audiences.js:predictPurchaseProbability] Predicting purchase probability", { profileId: profile?.id, visitCount: profile?.visitCount });
  if (!profile) {
    console.log("[predictive-audiences.js:predictPurchaseProbability] No profile, returning unlikely defaults");
    return { purchaseProbability: 0.01, conversionSegment: "unlikely", signals: {} };
  }

  const agg = profile.aggregates || {};
  const events = profile.events || [];

  const cartScore = Math.min(1, (agg.cartAdditions || 0) / 3);
  const visitScore = Math.min(1, (profile.visitCount || 0) / 8);

  // Product view depth in single category
  const categoryViews = {};
  events.filter(e => e.type === "product_view").forEach(e => {
    const url = e.data?.url || "";
    const match = url.match(/\/collections\/([^\/]+)/);
    if (match) categoryViews[match[1]] = (categoryViews[match[1]] || 0) + 1;
  });
  const maxCategoryDepth = Math.max(0, ...Object.values(categoryViews), 0);
  const depthScore = Math.min(1, maxCategoryDepth / 3);

  const searchScore = Math.min(1, (agg.searchQueries?.length || 0) / 2);

  const pageViewsPerVisit = (profile.visitCount || 1) > 0
    ? (agg.pageViews || 0) / (profile.visitCount || 1)
    : 0;
  const intensityScore = Math.min(1, pageViewsPerVisit / 5);

  const daysSinceVisit = profile.lastVisitAt
    ? (Date.now() - new Date(profile.lastVisitAt).getTime()) / (1000 * 60 * 60 * 24)
    : 999;
  const recencyScore = daysSinceVisit <= 1 ? 1.0 : daysSinceVisit <= 3 ? 0.7 : daysSinceVisit <= 7 ? 0.4 : 0.1;

  console.log("[predictive-audiences.js:predictPurchaseProbability] Signal values", { cartScore, visitScore, depthScore, searchScore, intensityScore, recencyScore, cartAdditions: agg.cartAdditions, visitCount: profile.visitCount, maxCategoryDepth, searchQueries: agg.searchQueries?.length, pageViewsPerVisit, daysSinceVisit: Math.round(daysSinceVisit) });

  const purchaseProbability = Math.round((
    cartScore * 0.30 + visitScore * 0.15 + depthScore * 0.15 +
    searchScore * 0.15 + intensityScore * 0.10 + recencyScore * 0.15
  ) * 100) / 100;

  let conversionSegment;
  if (purchaseProbability >= 0.7) conversionSegment = "very_likely";
  else if (purchaseProbability >= 0.45) conversionSegment = "likely";
  else if (purchaseProbability >= 0.2) conversionSegment = "possible";
  else conversionSegment = "unlikely";

  console.log("[predictive-audiences.js:predictPurchaseProbability] Prediction result", { purchaseProbability, conversionSegment, signals: { cartScore, visitScore, depthScore, searchScore, intensityScore, recencyScore } });

  return {
    purchaseProbability,
    conversionSegment,
    signals: { cartScore, visitScore, depthScore, searchScore, intensityScore, recencyScore },
  };
}

/**
 * Predict churn risk based on RFM signals.
 */
export function predictChurnRisk(profile) {
  console.log("[predictive-audiences.js:predictChurnRisk] Predicting churn risk", { profileId: profile?.id, visitCount: profile?.visitCount });
  if (!profile) {
    console.log("[predictive-audiences.js:predictChurnRisk] No profile, returning unknown defaults");
    return { churnRisk: 0, churnSegment: "unknown" };
  }

  const rfm = computeRFMScore(profile);
  const wasActive = (profile.visitCount || 0) >= 5;
  const isInactive = rfm.recency <= 2;

  let churnRisk = 0;
  if (wasActive && isInactive) churnRisk = 0.8;
  else if (wasActive && rfm.recency === 3) churnRisk = 0.5;
  else if (!wasActive && isInactive) churnRisk = 0.3;
  else churnRisk = 0.1;

  const churnSegment = churnRisk >= 0.6 ? "high_risk" : churnRisk >= 0.3 ? "medium_risk" : "low_risk";

  console.log("[predictive-audiences.js:predictChurnRisk] Churn risk result", { churnRisk, churnSegment, wasActive, isInactive, rfmRecency: rfm.recency, rfmSegment: rfm.rfmSegment, visitCount: profile.visitCount });

  return { churnRisk, churnSegment };
}
