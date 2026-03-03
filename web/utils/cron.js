import cron from "node-cron";
import { aggregateDailyAnalytics } from "../services/analytics-aggregator.js";
import { runBidOptimizationCycle } from "../services/bid-optimizer.js";
import { buildCooccurrenceMatrix } from "../services/product-affinity.js";
import { sendWeeklyMerchantReports, sendWeeklyAdvertiserReports } from "../services/weekly-report.js";
import { db } from "../firebase.js";

export function initCronJobs() {
  console.log("[cron.js] Setting up cron jobs...");

  // Run analytics aggregation every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    console.log("[cron.js] Starting analytics aggregation cron job");
    try {
      await aggregateDailyAnalytics();
      console.log("[cron.js] Analytics aggregation cron job completed successfully");
    } catch (err) {
      console.error("Cron: analytics aggregation failed:", err.message);
    }
  });

  // Every 15 minutes: run bid optimization cycle
  cron.schedule("*/15 * * * *", () => {
    console.log("[cron.js] Starting bid optimization cycle cron job");
    runBidOptimizationCycle()
      .then(() => console.log("[cron.js] Bid optimization cycle completed successfully"))
      .catch((err) =>
        console.error("Bid optimization error:", err)
      );
  });

  // Every hour: rebuild product co-occurrence matrix for active merchants
  cron.schedule("0 * * * *", async () => {
    console.log("[cron.js] Starting co-occurrence matrix rebuild cron job");
    try {
      const merchantsSnap = await db.collection("zones")
        .where("status", "==", "active")
        .get();
      const merchantIds = [...new Set(merchantsSnap.docs.map(d => d.data().merchantId).filter(Boolean))];
      console.log("[cron.js] Co-occurrence rebuild: found active merchants", { count: merchantIds.length });

      for (const merchantId of merchantIds) {
        console.log("[cron.js] Building co-occurrence matrix for merchant", { merchantId });
        await buildCooccurrenceMatrix(merchantId).catch(err =>
          console.error(`Co-occurrence build error for ${merchantId}:`, err.message)
        );
      }
      console.log("[cron.js] Co-occurrence matrix rebuild completed");
    } catch (err) {
      console.error("Co-occurrence cron error:", err);
    }
  });

  // Every Monday at 9:00 AM UTC: send weekly performance reports
  cron.schedule("0 9 * * 1", async () => {
    console.log("[cron.js] Starting weekly report emails...");
    try {
      await sendWeeklyMerchantReports();
      await sendWeeklyAdvertiserReports();
      console.log("[cron.js] Weekly report emails completed");
    } catch (err) {
      console.error("Weekly report cron error:", err.message);
    }
  });

  console.log("[cron.js] All cron jobs initialized");
}
