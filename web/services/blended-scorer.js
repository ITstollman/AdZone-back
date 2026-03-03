import { computeRelevanceScore } from "./context-analyzer.js";
import { computeInterestMatch } from "./interest-engine.js";
import { computeRFMScore, computeEngagementScore } from "./behavioral-scoring.js";

/**
 * Blended targeting score combining contextual + behavioral signals.
 * Weights adapt based on how much visitor data is available.
 */
export function computeBlendedScore({
  creativeContext,
  pageContext,
  interestProfile,
  visitorProfile,
  affinityScore = 0,
}) {
  console.log("[blended-scorer.js:computeBlendedScore] Computing blended score", { hasCreativeContext: !!creativeContext, hasPageContext: !!pageContext, hasInterestProfile: !!interestProfile, hasVisitorProfile: !!visitorProfile, affinityScore });
  const hasVisitorData = visitorProfile && (visitorProfile.visitCount || 0) > 1;

  const contextualScore = computeRelevanceScore(creativeContext, pageContext);
  console.log("[blended-scorer.js:computeBlendedScore] Contextual score", { contextualScore });

  if (!hasVisitorData) {
    console.log("[blended-scorer.js:computeBlendedScore] No visitor data, returning contextual-only score", { blendedScore: contextualScore, source: "contextual_only" });
    return {
      blendedScore: contextualScore,
      breakdown: { contextual: contextualScore, source: "contextual_only" },
    };
  }

  const interestScore = interestProfile
    ? computeInterestMatch(interestProfile, creativeContext)
    : 0.5;
  console.log("[blended-scorer.js:computeBlendedScore] Interest score", { interestScore });

  const { engagementScore } = computeEngagementScore(visitorProfile);
  const engagementNormalized = engagementScore / 100;
  console.log("[blended-scorer.js:computeBlendedScore] Engagement score", { engagementScore, engagementNormalized });

  const { rfmScore } = computeRFMScore(visitorProfile);
  const rfmNormalized = rfmScore / 100;
  console.log("[blended-scorer.js:computeBlendedScore] RFM score", { rfmScore, rfmNormalized });

  const affinityNormalized = affinityScore;

  // Data richness factor: shifts weights from contextual to behavioral
  const eventsCount = (visitorProfile.events || []).length;
  const dataRichness = Math.min(1, eventsCount / 30);

  const contextWeight = 0.45 - (dataRichness * 0.15);   // 0.45 → 0.30
  const interestWeight = 0.15 + (dataRichness * 0.15);   // 0.15 → 0.30
  const affinityWeight = 0.15 + (dataRichness * 0.05);   // 0.15 → 0.20
  const engagementWeight = 0.15;
  const rfmWeight = 0.10;

  console.log("[blended-scorer.js:computeBlendedScore] Weights (data richness adjusted)", { dataRichness, eventsCount, contextWeight, interestWeight, affinityWeight, engagementWeight, rfmWeight });

  const blendedScore =
    contextualScore * contextWeight +
    interestScore * interestWeight +
    affinityNormalized * affinityWeight +
    engagementNormalized * engagementWeight +
    rfmNormalized * rfmWeight;

  const finalBlended = Math.min(1.0, Math.max(0.0, blendedScore));
  console.log("[blended-scorer.js:computeBlendedScore] Final blended score", { allScores: { contextual: contextualScore, interest: interestScore, affinity: affinityNormalized, engagement: engagementNormalized, rfm: rfmNormalized }, allWeights: { contextWeight, interestWeight, affinityWeight, engagementWeight, rfmWeight }, rawBlended: blendedScore, finalBlended, dataRichness, source: "blended" });

  return {
    blendedScore: finalBlended,
    breakdown: {
      contextual: contextualScore,
      interest: interestScore,
      affinity: affinityNormalized,
      engagement: engagementNormalized,
      rfm: rfmNormalized,
      dataRichness,
      weights: { contextWeight, interestWeight, affinityWeight, engagementWeight, rfmWeight },
      source: "blended",
    },
  };
}
