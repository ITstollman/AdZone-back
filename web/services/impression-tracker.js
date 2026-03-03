import { db } from "../firebase.js";
import { FieldValue } from "firebase-admin/firestore";
import { detectFraud } from "./fraud-detection.js";
import { deductBalance } from "./wallet.js";
import { recordVariantEvent } from "./ab-testing.js";

const BATCH_SIZE = 500;
const FLUSH_INTERVAL = 10000; // 10 seconds
let impressionBuffer = [];

export function recordImpression(data) {
  console.log("[impression-tracker.js:recordImpression] Recording impression", { creativeId: data.creativeId, campaignId: data.campaignId, advertiserId: data.advertiserId, visitorId: data.visitorId, bidType: data.bidType, chargedAmount: data.chargedAmount });

  // Run fraud detection before buffering
  const fraudResult = detectFraud({
    type: "impression",
    visitorId: data.visitorId || null,
    adId: data.creativeId,
    userAgent: data.userAgent || "",
    ip: data.ip || "",
    timestamp: Date.now(),
  });

  console.log("[impression-tracker.js:recordImpression] Fraud check result", { creativeId: data.creativeId, fraudulent: fraudResult.fraudulent, fraudScore: fraudResult.score, reasons: fraudResult.reasons });

  // If fraudulent, skip the impression entirely
  if (fraudResult.fraudulent) {
    console.warn(
      `Blocked fraudulent impression: ad=${data.creativeId}, reasons=${fraudResult.reasons.join(",")}`,
    );
    console.log("[impression-tracker.js:recordImpression] BLOCKED - fraudulent impression", { creativeId: data.creativeId, reasons: fraudResult.reasons });
    return { blocked: true, reasons: fraudResult.reasons };
  }

  impressionBuffer.push({
    ...data,
    visitorId: data.visitorId || null,
    geo: data.geo || null,
    device: data.device || null,
    fraudScore: fraudResult.score,
    timestamp: new Date(),
  });

  console.log("[impression-tracker.js:recordImpression] Impression buffered", { creativeId: data.creativeId, bufferSize: impressionBuffer.length });

  if (impressionBuffer.length >= BATCH_SIZE) {
    console.log("[impression-tracker.js:recordImpression] Buffer full, triggering flush", { bufferSize: impressionBuffer.length });
    flushImpressions();
  }

  // Record A/B variant event for the creative
  recordVariantEvent(data.creativeId, "impression").catch((err) =>
    console.error("Error recording variant impression event:", err),
  );

  console.log("[impression-tracker.js:recordImpression] Impression accepted", { creativeId: data.creativeId, fraudScore: fraudResult.score });
  return { blocked: false, fraudScore: fraudResult.score };
}

export async function flushImpressions() {
  if (impressionBuffer.length === 0) {
    console.log("[impression-tracker.js:flushImpressions] Nothing to flush, buffer empty");
    return;
  }

  const toFlush = impressionBuffer.splice(0, BATCH_SIZE);
  console.log("[impression-tracker.js:flushImpressions] Flushing impressions", { flushCount: toFlush.length, remainingInBuffer: impressionBuffer.length });
  const batch = db.batch();

  for (const impression of toFlush) {
    const ref = db.collection("impressions").doc();
    batch.set(ref, impression);
  }

  try {
    await batch.commit();
    console.log("[impression-tracker.js:flushImpressions] Batch commit successful", { count: toFlush.length });

    // After successful write, deduct balances and track budget spend for each impression
    // Skip deduction for CPC/CPA bids — they are charged on click/conversion respectively
    for (const impression of toFlush) {
      if (
        impression.advertiserId &&
        impression.chargedAmount > 0 &&
        impression.bidType !== "cpc" &&
        impression.bidType !== "cpa"
      ) {
        console.log("[impression-tracker.js:flushImpressions] Deducting balance for impression", { advertiserId: impression.advertiserId, chargedAmount: impression.chargedAmount, bidType: impression.bidType, campaignId: impression.campaignId });
        deductBalance(impression.advertiserId, impression.chargedAmount, {
          campaignId: impression.campaignId,
          zoneId: impression.zoneId,
        }).catch((err) =>
          console.error("Error deducting balance for impression:", err.message),
        );

        // Increment campaign total spend atomically
        if (impression.campaignId) {
          console.log("[impression-tracker.js:flushImpressions] Incrementing campaign spend", { campaignId: impression.campaignId, amount: impression.chargedAmount });
          db.collection("campaigns")
            .doc(impression.campaignId)
            .update({ "budget.spent": FieldValue.increment(impression.chargedAmount) })
            .catch((err) =>
              console.error("Error updating campaign budget spent:", err.message),
            );

          // Increment daily spend tracking
          const dateStr = new Date().toISOString().split("T")[0];
          db.collection("daily_spend")
            .doc(impression.campaignId + "_" + dateStr)
            .set(
              {
                campaignId: impression.campaignId,
                date: dateStr,
                spent: FieldValue.increment(impression.chargedAmount),
              },
              { merge: true },
            )
            .catch((err) =>
              console.error("Error updating daily spend:", err.message),
            );

          // Increment hourly spend tracking
          const hour = new Date().getUTCHours();
          db.collection("hourly_spend")
            .doc(`${impression.campaignId}_${dateStr}_${hour}`)
            .set(
              {
                campaignId: impression.campaignId,
                date: dateStr,
                hour,
                spent: FieldValue.increment(impression.chargedAmount),
              },
              { merge: true },
            )
            .catch((err) =>
              console.error("Error updating hourly spend:", err.message),
            );
        }
      } else {
        console.log("[impression-tracker.js:flushImpressions] Skipping deduction for impression", { advertiserId: impression.advertiserId, chargedAmount: impression.chargedAmount, bidType: impression.bidType, reason: impression.bidType === "cpc" ? "CPC (charged on click)" : impression.bidType === "cpa" ? "CPA (charged on conversion)" : "no advertiser/amount" });
      }
    }
  } catch (err) {
    // Re-add failed impressions to buffer
    impressionBuffer.unshift(...toFlush);
    console.error("Failed to flush impressions:", err);
    console.log("[impression-tracker.js:flushImpressions] Re-added failed impressions to buffer", { reAddedCount: toFlush.length, newBufferSize: impressionBuffer.length });
  }
}

// Periodic flush
setInterval(flushImpressions, FLUSH_INTERVAL);

// Flush on process exit
process.on("SIGTERM", async () => {
  console.log("[impression-tracker.js:SIGTERM] Process terminating, flushing impressions");
  await flushImpressions();
  process.exit(0);
});
