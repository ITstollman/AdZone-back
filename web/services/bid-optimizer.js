import { db } from "../firebase.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Get the optimized effective bid for a campaign based on its bid strategy.
 * Called during auction for non-manual strategies.
 *
 * @returns {{ effectiveBid: number, strategy: string, debug: object }}
 */
export async function getOptimizedBid(bid, campaign, zone) {
  const strategy = campaign.bidStrategy?.type || "manual";
  console.log("[bid-optimizer.js:getOptimizedBid] Getting optimized bid", { campaignId: campaign.id, strategy, currentBid: bid.amount, zoneId: zone.id });

  if (strategy === "manual") {
    console.log("[bid-optimizer.js:getOptimizedBid] Manual strategy, returning original bid", { effectiveBid: bid.amount });
    return { effectiveBid: bid.amount, strategy: "manual", debug: {} };
  }

  const dateStr = new Date().toISOString().split("T")[0];
  const currentHour = new Date().getUTCHours();

  // Get today's spend
  const dailyDoc = await db
    .collection("daily_spend")
    .doc(`${campaign.id}_${dateStr}`)
    .get();
  const todaySpend = dailyDoc.exists ? dailyDoc.data().spent || 0 : 0;
  const dailyBudget =
    campaign.budget?.daily || campaign.budget?.total || 10000;
  const remainingBudget = Math.max(0, dailyBudget - todaySpend);
  const remainingHours = Math.max(1, 24 - currentHour);

  console.log("[bid-optimizer.js:getOptimizedBid] Budget context", { campaignId: campaign.id, todaySpend, dailyBudget, remainingBudget, remainingHours, currentHour });

  // Get campaign performance stats
  const stats = await getCampaignStats(campaign.id);
  console.log("[bid-optimizer.js:getOptimizedBid] Campaign stats loaded", { campaignId: campaign.id, impressions: stats.impressions, clicks: stats.clicks, ctr: stats.ctr, spend: stats.spend });

  switch (strategy) {
    case "maximize_clicks": {
      // Target: get most clicks within budget
      const avgCpc =
        stats.clicks > 0 ? stats.spend / stats.clicks : bid.amount;
      const targetCpc =
        remainingBudget /
        Math.max(1, (stats.clicksPerHour || 1) * remainingHours);
      const effectiveCpc = Math.min(
        Math.max(targetCpc, zone.settings?.minBid || 100),
        campaign.bidStrategy?.maxBid || bid.amount * 3
      );

      // Convert to eCPM for auction
      const predictedCtr = stats.ctr || 0.01;
      const effectiveBid = effectiveCpc * predictedCtr * 1000;

      console.log("[bid-optimizer.js:getOptimizedBid] maximize_clicks result", { campaignId: campaign.id, previousBid: bid.amount, newBid: Math.round(effectiveBid), avgCpc: Math.round(avgCpc), targetCpc: Math.round(targetCpc), effectiveCpc, predictedCtr, remainingBudget });

      return {
        effectiveBid: Math.round(effectiveBid),
        strategy: "maximize_clicks",
        debug: {
          targetCpc: Math.round(targetCpc),
          avgCpc: Math.round(avgCpc),
          remainingBudget,
          predictedCtr,
        },
      };
    }

    case "maximize_conversions": {
      // Target: most conversions within budget
      const convStats = await getConversionStats(campaign.id);
      const historicalCpa =
        convStats.conversions > 0
          ? convStats.totalSpend / convStats.conversions
          : bid.amount * 10;
      const targetBid = Math.min(
        historicalCpa,
        remainingBudget / Math.max(1, convStats.conversionsPerDay || 1)
      );

      const predictedCtr = stats.ctr || 0.01;
      const predictedCvr = convStats.cvr || 0.01;
      const effectiveBid = targetBid * predictedCtr * predictedCvr * 1000;

      console.log("[bid-optimizer.js:getOptimizedBid] maximize_conversions result", { campaignId: campaign.id, previousBid: bid.amount, newBid: Math.round(Math.max(zone.settings?.minBid || 100, effectiveBid)), historicalCpa: Math.round(historicalCpa), targetBid: Math.round(targetBid), predictedCvr, conversions: convStats.conversions });

      return {
        effectiveBid: Math.round(
          Math.max(zone.settings?.minBid || 100, effectiveBid)
        ),
        strategy: "maximize_conversions",
        debug: {
          historicalCpa: Math.round(historicalCpa),
          targetBid: Math.round(targetBid),
          predictedCvr,
        },
      };
    }

    case "target_cpa": {
      // Target: hit desired cost-per-acquisition
      const targetCpa = campaign.bidStrategy?.targetCpa || bid.amount * 10;
      const convStats = await getConversionStats(campaign.id);
      const actualCpa =
        convStats.conversions > 0
          ? convStats.totalSpend / convStats.conversions
          : targetCpa;

      // Learning period: first 50 conversions use conservative bidding
      const learningConversions =
        campaign.bidStrategy?.learningConversions || 0;
      const isLearning = learningConversions < 50;

      let bidAdjustment;
      if (isLearning) {
        bidAdjustment = 0.7; // Conservative during learning
      } else {
        const ratio = targetCpa / Math.max(1, actualCpa);
        bidAdjustment = Math.min(1.5, Math.max(0.5, ratio));
      }

      const newBid = Math.round(bid.amount * bidAdjustment);
      const effectiveBid = Math.max(zone.settings?.minBid || 100, newBid);

      console.log("[bid-optimizer.js:getOptimizedBid] target_cpa result", { campaignId: campaign.id, previousBid: bid.amount, newBid: effectiveBid, targetCpa, actualCpa: Math.round(actualCpa), bidAdjustment, isLearning, learningConversions });

      return {
        effectiveBid,
        strategy: "target_cpa",
        debug: {
          targetCpa,
          actualCpa: Math.round(actualCpa),
          bidAdjustment,
          isLearning,
          learningConversions,
        },
      };
    }

    case "target_roas": {
      // Target: hit desired return on ad spend
      const targetRoas = campaign.bidStrategy?.targetRoas || 4.0;
      const convStats = await getConversionStats(campaign.id);
      const actualRoas =
        convStats.totalSpend > 0
          ? convStats.totalRevenue / convStats.totalSpend
          : targetRoas;

      const isLearning =
        (campaign.bidStrategy?.learningConversions || 0) < 50;

      let bidAdjustment;
      if (isLearning) {
        bidAdjustment = 0.7;
      } else {
        const ratio = actualRoas / Math.max(0.01, targetRoas);
        bidAdjustment = Math.min(1.5, Math.max(0.5, 1 / ratio));
      }

      const newBid = Math.round(bid.amount * bidAdjustment);
      const effectiveBid = Math.max(zone.settings?.minBid || 100, newBid);

      console.log("[bid-optimizer.js:getOptimizedBid] target_roas result", { campaignId: campaign.id, previousBid: bid.amount, newBid: effectiveBid, targetRoas, actualRoas: Math.round(actualRoas * 100) / 100, bidAdjustment, isLearning });

      return {
        effectiveBid,
        strategy: "target_roas",
        debug: {
          targetRoas,
          actualRoas: Math.round(actualRoas * 100) / 100,
          bidAdjustment,
          isLearning,
        },
      };
    }

    default:
      console.log("[bid-optimizer.js:getOptimizedBid] Unknown strategy, returning original bid", { strategy, effectiveBid: bid.amount });
      return { effectiveBid: bid.amount, strategy: "manual", debug: {} };
  }
}

/**
 * Periodic optimization cycle — runs every 15 minutes via cron.
 * Recalculates strategy performance and updates learning status.
 */
export async function runBidOptimizationCycle() {
  console.log("[bid-optimizer.js:runBidOptimizationCycle] === BID OPTIMIZATION CYCLE START ===");
  try {
    // Find all campaigns with non-manual strategies
    const snapshot = await db
      .collection("campaigns")
      .where("status", "==", "active")
      .get();

    console.log("[bid-optimizer.js:runBidOptimizationCycle] Active campaigns found", { totalActive: snapshot.docs.length });

    let processedCount = 0;
    let skippedCount = 0;

    for (const doc of snapshot.docs) {
      const campaign = { id: doc.id, ...doc.data() };
      const strategy = campaign.bidStrategy?.type;
      if (!strategy || strategy === "manual") {
        skippedCount++;
        continue;
      }

      console.log("[bid-optimizer.js:runBidOptimizationCycle] Processing campaign", { campaignId: campaign.id, strategy });

      const convStats = await getConversionStats(campaign.id);
      const performanceStats = await getCampaignStats(campaign.id);

      // Update learning status
      let learningStatus = "learning";
      const totalConversions = convStats.conversions || 0;

      if (totalConversions >= 50) {
        learningStatus = "optimized";
      } else if (totalConversions >= 30) {
        learningStatus = "limited"; // Getting close
      }

      console.log("[bid-optimizer.js:runBidOptimizationCycle] Campaign optimization status", { campaignId: campaign.id, strategy, learningStatus, totalConversions, ctr: performanceStats.ctr, spend: performanceStats.spend });

      // Update campaign
      await doc.ref.update({
        "bidStrategy.learningStatus": learningStatus,
        "bidStrategy.learningConversions": totalConversions,
      });

      // Log optimization decision
      db.collection("bid_optimization_log")
        .add({
          campaignId: campaign.id,
          timestamp: new Date(),
          strategy,
          learningStatus,
          metrics: {
            conversions: totalConversions,
            ctr: performanceStats.ctr,
            spend: performanceStats.spend,
            roas:
              convStats.totalSpend > 0
                ? convStats.totalRevenue / convStats.totalSpend
                : 0,
            cpa:
              convStats.conversions > 0
                ? convStats.totalSpend / convStats.conversions
                : 0,
          },
        })
        .catch((err) =>
          console.error("Failed to log bid optimization:", err)
        );

      processedCount++;
    }

    console.log("[bid-optimizer.js:runBidOptimizationCycle] === BID OPTIMIZATION CYCLE END ===", { processedCampaigns: processedCount, skippedManual: skippedCount, totalActive: snapshot.docs.length });
    console.log("Bid optimization cycle completed");
  } catch (err) {
    console.error("Bid optimization cycle error:", err);
    console.log("[bid-optimizer.js:runBidOptimizationCycle] Cycle failed with error", { error: err.message });
  }
}

/**
 * Get campaign performance stats from the last 7 days.
 */
async function getCampaignStats(campaignId) {
  console.log("[bid-optimizer.js:getCampaignStats] Fetching campaign stats", { campaignId });
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const dateStr = sevenDaysAgo.toISOString().split("T")[0];

  try {
    const snap = await db
      .collection("analytics_daily")
      .where("campaignId", "==", campaignId)
      .where("date", ">=", dateStr)
      .get();

    let impressions = 0,
      clicks = 0,
      spend = 0;
    snap.docs.forEach((doc) => {
      const d = doc.data();
      impressions += d.impressions || 0;
      clicks += d.clicks || 0;
      spend += d.spend || 0;
    });

    const result = {
      impressions,
      clicks,
      spend,
      ctr: impressions > 0 ? clicks / impressions : 0.01,
      clicksPerHour: clicks / (7 * 24),
    };
    console.log("[bid-optimizer.js:getCampaignStats] Campaign stats result", { campaignId, ...result, daysQueried: 7, docsFound: snap.docs.length });
    return result;
  } catch {
    console.log("[bid-optimizer.js:getCampaignStats] Failed to fetch campaign stats, returning defaults", { campaignId });
    return {
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0.01,
      clicksPerHour: 0,
    };
  }
}

/**
 * Get conversion stats for a campaign.
 */
async function getConversionStats(campaignId) {
  console.log("[bid-optimizer.js:getConversionStats] Fetching conversion stats", { campaignId });
  try {
    const doc = await db.collection("conversion_stats").doc(campaignId).get();
    if (!doc.exists) {
      console.log("[bid-optimizer.js:getConversionStats] No conversion stats found, returning defaults", { campaignId });
      return {
        conversions: 0,
        totalRevenue: 0,
        totalSpend: 0,
        cvr: 0.01,
        conversionsPerDay: 0,
      };
    }
    const data = doc.data();
    const conversions = data.conversions || 0;
    const totalRevenue = data.totalRevenue || 0;

    // Get spend from campaign
    const campaignDoc = await db
      .collection("campaigns")
      .doc(campaignId)
      .get();
    const totalSpend = campaignDoc.exists
      ? campaignDoc.data().budget?.spent || 0
      : 0;

    const result = {
      conversions,
      totalRevenue,
      totalSpend,
      cvr: data.clicks > 0 ? conversions / data.clicks : 0.01,
      conversionsPerDay: conversions / 7, // rough estimate
    };
    console.log("[bid-optimizer.js:getConversionStats] Conversion stats result", { campaignId, ...result });
    return result;
  } catch {
    console.log("[bid-optimizer.js:getConversionStats] Failed to fetch conversion stats, returning defaults", { campaignId });
    return {
      conversions: 0,
      totalRevenue: 0,
      totalSpend: 0,
      cvr: 0.01,
      conversionsPerDay: 0,
    };
  }
}

/**
 * Get strategy performance for a campaign (for API response).
 */
export async function getStrategyPerformance(campaignId) {
  console.log("[bid-optimizer.js:getStrategyPerformance] Getting strategy performance", { campaignId });
  const campaign = await db.collection("campaigns").doc(campaignId).get();
  if (!campaign.exists) {
    console.log("[bid-optimizer.js:getStrategyPerformance] Campaign not found", { campaignId });
    return null;
  }

  const data = campaign.data();
  const strategy = data.bidStrategy || { type: "manual" };
  const convStats = await getConversionStats(campaignId);
  const perfStats = await getCampaignStats(campaignId);

  // Get recent optimization log
  const logSnap = await db
    .collection("bid_optimization_log")
    .where("campaignId", "==", campaignId)
    .orderBy("timestamp", "desc")
    .limit(20)
    .get();
  const log = logSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  console.log("[bid-optimizer.js:getStrategyPerformance] Strategy performance loaded", { campaignId, strategy: strategy.type, learningStatus: strategy.learningStatus, logEntries: log.length });

  return {
    strategy,
    performance: {
      ...perfStats,
      conversions: convStats.conversions,
      roas:
        convStats.totalSpend > 0
          ? Math.round((convStats.totalRevenue / convStats.totalSpend) * 100) /
            100
          : 0,
      cpa:
        convStats.conversions > 0
          ? Math.round(convStats.totalSpend / convStats.conversions)
          : 0,
    },
    optimizationLog: log,
  };
}
