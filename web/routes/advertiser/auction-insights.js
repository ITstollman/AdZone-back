import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// GET /api/advertiser/auction-insights — aggregated auction performance
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { campaignId, startDate, endDate, zoneId } = req.query;
    console.log("[auction-insights.js:GET /] Auction insights request", { advertiserId, campaignId, startDate, endDate, zoneId });

    // Query auction_outcomes where this advertiser participated
    let query = db
      .collection("auction_outcomes")
      .orderBy("timestamp", "desc")
      .limit(1000);

    // Note: Firestore doesn't support array-contains on nested objects easily,
    // so we query recent outcomes and filter in memory
    const snap = await query.get();

    let totalAuctions = 0;
    let wins = 0;
    let totalPosition = 0;
    let totalCharged = 0;
    let lostToBid = 0;
    let lostToBudget = 0;
    let lostToQuality = 0;
    const competitorMap = {};
    const clearingPrices = {};

    snap.docs.forEach((doc) => {
      const outcome = doc.data();

      // Check if this advertiser participated
      const participant = (outcome.participants || []).find(
        (p) => p.advertiserId === advertiserId
      );
      if (!participant) return;

      // Apply filters
      if (campaignId && participant.campaignId !== campaignId) return;
      if (zoneId && outcome.zoneId !== zoneId) return;

      totalAuctions++;
      totalPosition +=
        participant.position || outcome.participants.length;

      if (outcome.winnerId === advertiserId) {
        wins++;
        totalCharged += outcome.chargedAmount || 0;
      } else {
        // Analyze why we lost
        if (participant.position > 1) lostToBid++;
      }

      // Track competitor overlap
      (outcome.participants || []).forEach((p) => {
        if (p.advertiserId !== advertiserId) {
          competitorMap[p.advertiserId] =
            (competitorMap[p.advertiserId] || 0) + 1;
        }
      });

      // Track clearing prices by date
      const dateKey = outcome.timestamp?.toDate
        ? outcome.timestamp.toDate().toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
      if (!clearingPrices[dateKey]) {
        clearingPrices[dateKey] = {
          total: 0,
          count: 0,
          min: Infinity,
          max: 0,
        };
      }
      if (outcome.chargedAmount) {
        clearingPrices[dateKey].total += outcome.chargedAmount;
        clearingPrices[dateKey].count++;
        clearingPrices[dateKey].min = Math.min(
          clearingPrices[dateKey].min,
          outcome.chargedAmount
        );
        clearingPrices[dateKey].max = Math.max(
          clearingPrices[dateKey].max,
          outcome.chargedAmount
        );
      }
    });

    // Build competitor overlap
    const competitorOverlap = Object.entries(competitorMap)
      .map(([advId, count]) => ({
        advertiserId: advId,
        overlapRate:
          totalAuctions > 0
            ? Math.round((count / totalAuctions) * 10000) / 100
            : 0,
        overlapCount: count,
      }))
      .sort((a, b) => b.overlapCount - a.overlapCount)
      .slice(0, 10);

    // Build clearing prices timeline
    const recentClearingPrices = Object.entries(clearingPrices)
      .map(([date, data]) => ({
        date,
        avgCpm: data.count > 0 ? Math.round(data.total / data.count) : 0,
        minCpm: data.min === Infinity ? 0 : data.min,
        maxCpm: data.max,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30);

    console.log("[auction-insights.js:GET /] Returning insights (200)", { totalAuctions, wins, lostToBid, competitorCount: Object.keys(competitorMap).length });
    res.json({
      winRate:
        totalAuctions > 0
          ? Math.round((wins / totalAuctions) * 10000) / 100
          : 0,
      avgPosition:
        totalAuctions > 0
          ? Math.round((totalPosition / totalAuctions) * 10) / 10
          : 0,
      impressionShare:
        totalAuctions > 0
          ? Math.round((wins / totalAuctions) * 10000) / 100
          : 0,
      avgCpm: wins > 0 ? Math.round(totalCharged / wins) : 0,
      totalAuctions,
      wins,
      lostToBid,
      lostToBudget,
      lostToQuality,
      competitorOverlap,
      recentClearingPrices,
    });
  } catch (err) {
    console.error("Error fetching auction insights:", err);
    res.status(500).json({ error: "Failed to fetch auction insights" });
  }
});

// GET /api/advertiser/auction-insights/bid-landscape/:zoneId
router.get("/bid-landscape/:zoneId", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    const { zoneId } = req.params;
    console.log("[auction-insights.js:GET /bid-landscape/:zoneId] Bid landscape request", { advertiserId, zoneId });

    // Get recent auction outcomes for this zone
    const snap = await db
      .collection("auction_outcomes")
      .where("zoneId", "==", zoneId)
      .orderBy("timestamp", "desc")
      .limit(500)
      .get();

    if (snap.empty) {
      return res.json({
        estimatedImpressions: {
          atCurrentBid: 0,
          at110Percent: 0,
          at125Percent: 0,
          at150Percent: 0,
        },
        suggestedBid: 100,
        recentClearingPrices: [],
      });
    }

    // Collect all winning bids to understand the landscape
    const winningBids = [];
    let currentBid = 0;

    snap.docs.forEach((doc) => {
      const outcome = doc.data();
      if (outcome.chargedAmount) {
        winningBids.push(outcome.chargedAmount);
      }
      // Find advertiser's current bid if participating
      const participant = (outcome.participants || []).find(
        (p) => p.advertiserId === advertiserId
      );
      if (participant) {
        currentBid = Math.max(currentBid, participant.eCPM || 0);
      }
    });

    winningBids.sort((a, b) => a - b);
    const totalAuctions = snap.size;

    // Estimate impressions at different bid levels
    function estimateWinsAtBid(bid) {
      return winningBids.filter((w) => bid >= w).length;
    }

    const effectiveBid = currentBid || 500; // default $5 CPM

    // Suggested bid: 80th percentile of winning bids
    const p80Index = Math.floor(winningBids.length * 0.8);
    const suggestedBid = winningBids[p80Index] || 500;

    // Recent clearing prices by date
    const pricesByDate = {};
    snap.docs.forEach((doc) => {
      const outcome = doc.data();
      const dateKey = outcome.timestamp?.toDate
        ? outcome.timestamp.toDate().toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
      if (!pricesByDate[dateKey]) {
        pricesByDate[dateKey] = {
          total: 0,
          count: 0,
          min: Infinity,
          max: 0,
        };
      }
      if (outcome.chargedAmount) {
        pricesByDate[dateKey].total += outcome.chargedAmount;
        pricesByDate[dateKey].count++;
        pricesByDate[dateKey].min = Math.min(
          pricesByDate[dateKey].min,
          outcome.chargedAmount
        );
        pricesByDate[dateKey].max = Math.max(
          pricesByDate[dateKey].max,
          outcome.chargedAmount
        );
      }
    });

    const recentClearingPrices = Object.entries(pricesByDate)
      .map(([date, data]) => ({
        date,
        avgCpm: data.count > 0 ? Math.round(data.total / data.count) : 0,
        minCpm: data.min === Infinity ? 0 : data.min,
        maxCpm: data.max,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-14);

    console.log("[auction-insights.js:GET /bid-landscape/:zoneId] Returning bid landscape (200)", { zoneId, totalAuctionsAnalyzed: totalAuctions, suggestedBid, currentBid: effectiveBid });
    res.json({
      estimatedImpressions: {
        atCurrentBid: estimateWinsAtBid(effectiveBid),
        at110Percent: estimateWinsAtBid(Math.round(effectiveBid * 1.1)),
        at125Percent: estimateWinsAtBid(Math.round(effectiveBid * 1.25)),
        at150Percent: estimateWinsAtBid(Math.round(effectiveBid * 1.5)),
      },
      suggestedBid,
      currentBid: effectiveBid,
      totalAuctionsAnalyzed: totalAuctions,
      recentClearingPrices,
    });
  } catch (err) {
    console.error("Error fetching bid landscape:", err);
    res.status(500).json({ error: "Failed to fetch bid landscape" });
  }
});

export default router;
