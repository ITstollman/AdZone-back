import { db } from "../firebase.js";

/**
 * Determine if a campaign should serve based on budget pacing.
 * Returns { serve: boolean, bidMultiplier: number }
 *
 * Even pacing: distribute daily budget across 24 hours
 * Accelerated pacing: spend as fast as possible (default, no throttling)
 */
export async function shouldServe(campaign) {
  console.log("[pacing.js:shouldServe] Checking pacing for campaign", { campaignId: campaign.id, pacing: campaign.pacing, dailyBudget: campaign.budget?.daily });

  // Accelerated = no pacing, always serve
  if (!campaign.pacing || campaign.pacing === "accelerated") {
    console.log("[pacing.js:shouldServe] Accelerated pacing (or no pacing), always serve", { campaignId: campaign.id, pacing: campaign.pacing });
    return { serve: true, bidMultiplier: 1.0 };
  }

  if (!campaign.budget?.daily) {
    console.log("[pacing.js:shouldServe] No daily budget set, always serve", { campaignId: campaign.id });
    return { serve: true, bidMultiplier: 1.0 };
  }

  const dailyBudget = campaign.budget.daily;
  const currentHour = new Date().getUTCHours();
  const elapsedHours = currentHour + 1;
  const hourlyBudget = dailyBudget / 24;
  const expectedSpend = hourlyBudget * elapsedHours;

  // Get today's actual spend
  const dateStr = new Date().toISOString().split("T")[0];
  const dailyDoc = await db.collection("daily_spend")
    .doc(`${campaign.id}_${dateStr}`).get();
  const actualSpend = dailyDoc.exists ? dailyDoc.data().spent || 0 : 0;

  const paceRatio = expectedSpend > 0 ? actualSpend / expectedSpend : 0;

  console.log("[pacing.js:shouldServe] Pacing calculation", { campaignId: campaign.id, dailyBudget, currentHour, elapsedHours, hourlyBudget, expectedSpend, actualSpend, paceRatio });

  if (paceRatio > 1.5) {
    // Way ahead of pace — hard pause until next hour
    console.log("[pacing.js:shouldServe] WAY AHEAD of pace - HARD PAUSE", { campaignId: campaign.id, paceRatio, decision: "do_not_serve", bidMultiplier: 1.0 });
    return { serve: false, bidMultiplier: 1.0 };
  }
  if (paceRatio > 1.2) {
    // Slightly ahead — throttle 50% via random
    const serve = Math.random() > 0.5;
    console.log("[pacing.js:shouldServe] Slightly ahead of pace - 50% throttle", { campaignId: campaign.id, paceRatio, decision: serve ? "serve" : "throttled", bidMultiplier: 0.9 });
    return { serve, bidMultiplier: 0.9 };
  }
  if (paceRatio < 0.5) {
    // Way behind — aggressive boost
    console.log("[pacing.js:shouldServe] WAY BEHIND pace - aggressive boost", { campaignId: campaign.id, paceRatio, decision: "serve", bidMultiplier: 1.2 });
    return { serve: true, bidMultiplier: 1.2 };
  }
  if (paceRatio < 0.8) {
    // Slightly behind — mild boost
    console.log("[pacing.js:shouldServe] Slightly behind pace - mild boost", { campaignId: campaign.id, paceRatio, decision: "serve", bidMultiplier: 1.1 });
    return { serve: true, bidMultiplier: 1.1 };
  }

  // On pace
  console.log("[pacing.js:shouldServe] On pace - serve normally", { campaignId: campaign.id, paceRatio, decision: "serve", bidMultiplier: 1.0 });
  return { serve: true, bidMultiplier: 1.0 };
}
