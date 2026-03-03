import { db } from "../firebase.js";
import { FieldValue } from "firebase-admin/firestore";

// Thompson Sampling: select the best creative variant
export function selectVariant(creatives) {
  console.log("[ab-testing.js:selectVariant] Selecting variant via Thompson Sampling", { creativeCount: creatives?.length });
  if (!creatives?.length) {
    console.log("[ab-testing.js:selectVariant] No creatives provided, returning null");
    return null;
  }
  if (creatives.length === 1) {
    console.log("[ab-testing.js:selectVariant] Only one creative, returning it directly", { creativeId: creatives[0].id });
    return creatives[0];
  }

  // For each creative, sample from Beta distribution
  // Beta(successes + 1, failures + 1) where successes = clicks, failures = impressions - clicks
  const scored = creatives.map(creative => {
    const stats = creative.stats || { impressions: 0, clicks: 0 };
    const alpha = (stats.clicks || 0) + 1;
    const beta = Math.max(1, (stats.impressions || 0) - (stats.clicks || 0) + 1);

    // Sample from Beta distribution using Joekel's method (simple approximation)
    const sample = betaSample(alpha, beta);
    return { creative, sample };
  });

  // Pick the creative with highest sample
  scored.sort((a, b) => b.sample - a.sample);
  const winner = scored[0];
  console.log("[ab-testing.js:selectVariant] Thompson Sampling result", { winnerId: winner.creative.id, winnerSample: winner.sample, allSamples: scored.map(s => ({ id: s.creative.id, sample: s.sample, impressions: s.creative.stats?.impressions || 0, clicks: s.creative.stats?.clicks || 0 })) });
  return scored[0].creative;
}

// Simple Beta distribution sampling using the inverse CDF approximation
function betaSample(alpha, beta) {
  // Use gamma sampling to get Beta sample
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

// Marsaglia and Tsang's method for gamma sampling
function gammaSample(shape) {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
  }

  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);

  while (true) {
    let x, v;
    do {
      x = normalSample();
      v = 1.0 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1.0 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

// Box-Muller transform for normal sampling
function normalSample() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Record an event for a creative variant (impression or click)
// Uses atomic FieldValue.increment to avoid race conditions under concurrent load
export async function recordVariantEvent(creativeId, eventType) {
  console.log("[ab-testing.js:recordVariantEvent] Recording variant event", { creativeId, eventType });
  if (!creativeId) {
    console.log("[ab-testing.js:recordVariantEvent] No creativeId, skipping");
    return;
  }
  const ref = db.collection("creatives").doc(creativeId);

  if (eventType === "impression") {
    await ref.update({ "stats.impressions": FieldValue.increment(1) });
    console.log("[ab-testing.js:recordVariantEvent] Impression recorded", { creativeId });
  } else if (eventType === "click") {
    await ref.update({ "stats.clicks": FieldValue.increment(1) });
    console.log("[ab-testing.js:recordVariantEvent] Click recorded", { creativeId });
  }
  // CTR is computed on read (in getTestResults), not on write
}

/**
 * Context-aware creative selection using Contextual Thompson Sampling.
 * Maintains separate Beta distributions per creative PER CONTEXT SEGMENT.
 * Falls back to global Thompson Sampling when no segment data exists.
 */
export function selectVariantContextual(creatives, visitorContext = {}) {
  console.log("[ab-testing.js:selectVariantContextual] Selecting variant via Contextual Thompson Sampling", { creativeCount: creatives?.length, segments: visitorContext.segments, engagementScore: visitorContext.engagementScore });
  if (!creatives?.length) {
    console.log("[ab-testing.js:selectVariantContextual] No creatives provided, returning null");
    return null;
  }
  if (creatives.length === 1) {
    console.log("[ab-testing.js:selectVariantContextual] Only one creative, returning it directly", { creativeId: creatives[0].id });
    return creatives[0];
  }

  const contextBucket = determineContextBucket(visitorContext);
  console.log("[ab-testing.js:selectVariantContextual] Context bucket determined", { contextBucket });

  const scored = creatives.map(creative => {
    const segStats = creative.segmentStats?.[contextBucket];
    const stats = segStats || creative.stats || { impressions: 0, clicks: 0 };
    const usingSegmentStats = !!segStats;

    const alpha = (stats.clicks || 0) + 1;
    const beta = Math.max(1, (stats.impressions || 0) - (stats.clicks || 0) + 1);

    // Use the existing betaSample function from this file
    const sample = betaSample(alpha, beta);
    return { creative, sample, usingSegmentStats, alpha, beta, impressions: stats.impressions || 0, clicks: stats.clicks || 0 };
  });

  scored.sort((a, b) => b.sample - a.sample);
  const winner = scored[0];
  console.log("[ab-testing.js:selectVariantContextual] Contextual Thompson Sampling result", { winnerId: winner.creative.id, winnerSample: winner.sample, contextBucket, usingSegmentStats: winner.usingSegmentStats, allSamples: scored.map(s => ({ id: s.creative.id, sample: s.sample, usingSegmentStats: s.usingSegmentStats, impressions: s.impressions, clicks: s.clicks })) });
  return scored[0].creative;
}

/**
 * Determine context bucket from visitor signals.
 * Coarse buckets to ensure statistical significance.
 */
export function determineContextBucket(visitorContext) {
  if (!visitorContext || !visitorContext.segments?.length) {
    console.log("[ab-testing.js:determineContextBucket] No segments, returning default bucket");
    return "default";
  }

  const engagement = visitorContext.engagementScore || 0;
  const tier = engagement >= 60 ? "high" : engagement >= 30 ? "mid" : "low";

  const interests = (visitorContext.segments || [])
    .filter(s => s.startsWith("auto:"))
    .map(s => s.replace("auto:", ""));
  const interest = interests[0] || "general";

  const bucket = `${tier}_${interest}`;
  console.log("[ab-testing.js:determineContextBucket] Context bucket determined", { engagement, tier, interest, bucket, totalSegments: visitorContext.segments.length });
  return bucket;
}

/**
 * Record variant event with context bucket for segmented A/B testing.
 * Updates both global stats AND segment-specific stats.
 */
export async function recordVariantEventContextual(creativeId, eventType, contextBucket = "default") {
  console.log("[ab-testing.js:recordVariantEventContextual] Recording contextual variant event", { creativeId, eventType, contextBucket });
  if (!creativeId) {
    console.log("[ab-testing.js:recordVariantEventContextual] No creativeId, skipping");
    return;
  }

  // Call the existing recordVariantEvent for global stats
  await recordVariantEvent(creativeId, eventType);

  // Also update segment-specific stats if not default
  if (contextBucket && contextBucket !== "default") {
    try {
      const ref = db.collection("creatives").doc(creativeId);
      const segField = `segmentStats.${contextBucket}`;
      if (eventType === "impression") {
        await ref.update({ [`${segField}.impressions`]: FieldValue.increment(1) });
        console.log("[ab-testing.js:recordVariantEventContextual] Segment impression recorded", { creativeId, contextBucket });
      } else if (eventType === "click") {
        await ref.update({ [`${segField}.clicks`]: FieldValue.increment(1) });
        console.log("[ab-testing.js:recordVariantEventContextual] Segment click recorded", { creativeId, contextBucket });
      }
    } catch (err) {
      // Segment stats update failed, non-critical
      console.log("[ab-testing.js:recordVariantEventContextual] Segment stats update failed (non-critical)", { creativeId, contextBucket, error: err.message });
    }
  }
}

// Get A/B test results for a campaign
export async function getTestResults(campaignId) {
  console.log("[ab-testing.js:getTestResults] Getting test results", { campaignId });
  const snap = await db.collection("creatives")
    .where("campaignId", "==", campaignId)
    .get();

  const results = snap.docs.map(d => {
    const data = d.data();
    const stats = data.stats || { impressions: 0, clicks: 0 };
    const impressions = stats.impressions || 0;
    const clicks = stats.clicks || 0;

    // Compute CTR on read since we no longer store it (atomic increments only)
    const ctr = impressions > 0 ? clicks / impressions : 0;

    // Calculate confidence interval using Wilson score interval
    const n = impressions;
    const p = ctr;
    const z = 1.96; // 95% confidence

    let lower = 0, upper = 0;
    if (n > 0) {
      const denominator = 1 + z * z / n;
      const center = p + z * z / (2 * n);
      const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
      lower = Math.max(0, (center - spread) / denominator);
      upper = Math.min(1, (center + spread) / denominator);
    }

    return {
      creativeId: d.id,
      name: data.name,
      impressions,
      clicks,
      ctr,
      ctrPercent: (ctr * 100).toFixed(2),
      confidence: { lower: (lower * 100).toFixed(2), upper: (upper * 100).toFixed(2) },
    };
  });

  console.log("[ab-testing.js:getTestResults] Test results computed", { campaignId, creativeCount: results.length, results: results.map(r => ({ creativeId: r.creativeId, impressions: r.impressions, clicks: r.clicks, ctrPercent: r.ctrPercent })) });

  return results;
}
