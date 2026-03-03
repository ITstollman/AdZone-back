import NodeCache from "node-cache";
import { db } from "../firebase.js";

// In-memory caches for fraud detection
const clickRateCache = new NodeCache({ stdTTL: 3600 }); // 1hr
const impressionDedup = new NodeCache({ stdTTL: 10 }); // 10s for dedup window

// New detection signal caches
const ipReputationCache = new NodeCache({ stdTTL: 3600 });
const sessionCache = new NodeCache({ stdTTL: 3600 });
const geoHistory = new NodeCache({ stdTTL: 3600 });

// Known bot user agents (partial matches)
const BOT_PATTERNS = [
  "bot", "crawl", "spider", "slurp", "facebook", "twitter",
  "whatsapp", "telegram", "preview", "headless", "phantom",
  "selenium", "puppeteer", "playwright", "wget", "curl",
  "python-requests", "go-http-client", "java/", "libwww",
  "googlebot", "bingbot", "yandex", "baidu", "duckduck",
  "applebot", "ia_archiver", "pingdom", "uptimerobot",
];

// Known datacenter/proxy IP patterns (simplified)
const DATACENTER_PATTERNS = [
  /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./,
  // Common cloud provider ranges (simplified)
];

// Detect fraud for an impression or click event
export function detectFraud(event) {
  // event = { type: "impression"|"click", visitorId, adId, userAgent, ip, timestamp, country }
  console.log("[fraud-detection.js:detectFraud] === FRAUD CHECK START ===", { type: event.type, visitorId: event.visitorId, adId: event.adId, ip: event.ip });
  const result = { fraudulent: false, score: 0, reasons: [] };

  // 1. Bot detection
  const botDetected = isBot(event.userAgent);
  console.log("[fraud-detection.js:detectFraud] Signal 1 - Bot detection", { isBot: botDetected, userAgent: event.userAgent?.substring(0, 80) });
  if (botDetected) {
    result.fraudulent = true;
    result.score += 1.0;
    result.reasons.push("bot_detected");
    console.log("[fraud-detection.js:detectFraud] BLOCKED - Bot detected, returning immediately", { score: result.score });
    return result;
  }

  // 2. Missing visitor ID (suspicious)
  if (!event.visitorId) {
    result.score += 0.3;
    result.reasons.push("missing_visitor_id");
    console.log("[fraud-detection.js:detectFraud] Signal 2 - Missing visitor ID", { scoreAdded: 0.3, totalScore: result.score });
  }

  // 3. Click rate limiting (too many clicks from same visitor)
  if (event.type === "click" && event.visitorId) {
    const rateLimited = isClickRateLimited(event.visitorId, event.adId);
    console.log("[fraud-detection.js:detectFraud] Signal 3 - Click rate limit check", { rateLimited, visitorId: event.visitorId, adId: event.adId });
    if (rateLimited) {
      result.fraudulent = true;
      result.score += 0.8;
      result.reasons.push("click_rate_exceeded");
    }
  }

  // 4. Impression deduplication
  if (event.type === "impression" && event.visitorId) {
    const isDuplicate = isDuplicateImpression(event.visitorId, event.adId);
    console.log("[fraud-detection.js:detectFraud] Signal 4 - Impression dedup check", { isDuplicate, visitorId: event.visitorId, adId: event.adId });
    if (isDuplicate) {
      result.fraudulent = true;
      result.score += 0.7;
      result.reasons.push("duplicate_impression");
    }
  }

  // 5. Missing user agent (suspicious)
  if (!event.userAgent) {
    result.score += 0.2;
    result.reasons.push("missing_user_agent");
    console.log("[fraud-detection.js:detectFraud] Signal 5 - Missing user agent", { scoreAdded: 0.2, totalScore: result.score });
  }

  // 6. IP Reputation — flag high-activity IPs
  const ipRepResult = checkIpReputation(event.ip, event.type);
  console.log("[fraud-detection.js:detectFraud] Signal 6 - IP reputation check", { ip: event.ip, suspicious: ipRepResult.suspicious, score: ipRepResult.score, reason: ipRepResult.reason });
  if (ipRepResult.suspicious) {
    result.score += ipRepResult.score;
    result.reasons.push(ipRepResult.reason);
  }

  // 7. Session CTR Anomaly — flag abnormal click-through rates per visitor
  const sessionResult = checkSessionBehavior(event.visitorId, event.type);
  console.log("[fraud-detection.js:detectFraud] Signal 7 - Session behavior check", { visitorId: event.visitorId, suspicious: sessionResult.suspicious, score: sessionResult.score, reason: sessionResult.reason });
  if (sessionResult.suspicious) {
    result.score += sessionResult.score;
    result.reasons.push(sessionResult.reason);
  }

  // 8. Geographic Consistency — flag impossible travel
  const geoResult = checkGeoConsistency(event.visitorId, event.country);
  console.log("[fraud-detection.js:detectFraud] Signal 8 - Geo consistency check", { visitorId: event.visitorId, country: event.country, suspicious: geoResult.suspicious, score: geoResult.score, reason: geoResult.reason });
  if (geoResult.suspicious) {
    result.score += geoResult.score;
    result.reasons.push(geoResult.reason);
  }

  // 9. Datacenter IP Detection
  const isDatacenter = isDatacenterIP(event.ip);
  console.log("[fraud-detection.js:detectFraud] Signal 9 - Datacenter IP check", { ip: event.ip, isDatacenter });
  if (isDatacenter) {
    result.score += 0.3;
    result.reasons.push("datacenter_ip");
  }

  // Threshold: score >= 0.7 is considered fraudulent
  if (result.score >= 0.7) {
    result.fraudulent = true;
  }

  console.log("[fraud-detection.js:detectFraud] === FRAUD CHECK END ===", { fraudulent: result.fraudulent, finalScore: result.score, reasons: result.reasons, type: event.type, visitorId: event.visitorId });
  return result;
}

// Check if user agent is a known bot
export function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  const result = BOT_PATTERNS.some(pattern => ua.includes(pattern));
  if (result) {
    console.log("[fraud-detection.js:isBot] Bot pattern matched", { matchedIn: ua.substring(0, 80) });
  }
  return result;
}

// Sliding window rate limit for clicks: max 5 clicks per visitor per ad per hour
export function isClickRateLimited(visitorId, adId) {
  const key = `click_${visitorId}_${adId}`;
  const count = clickRateCache.get(key) || 0;
  clickRateCache.set(key, count + 1);
  const limited = count >= 5;
  console.log("[fraud-detection.js:isClickRateLimited] Click rate check", { visitorId, adId, currentCount: count, newCount: count + 1, maxAllowed: 5, limited });
  return limited;
}

// Dedup impressions: same visitor + same ad within 5 seconds
export function isDuplicateImpression(visitorId, adId, windowMs = 5000) {
  const key = `imp_${visitorId}_${adId}`;
  const lastSeen = impressionDedup.get(key);
  const now = Date.now();

  if (lastSeen && (now - lastSeen) < windowMs) {
    console.log("[fraud-detection.js:isDuplicateImpression] Duplicate detected", { visitorId, adId, timeSinceLastMs: now - lastSeen, windowMs });
    return true; // Duplicate
  }

  impressionDedup.set(key, now);
  return false;
}

// --- New Detection Signals ---

// IP Reputation: track impressions/clicks per IP per hour
function checkIpReputation(ip, type) {
  if (!ip) return { suspicious: false, score: 0 };
  const key = `ip_${type}_${ip}`;
  const count = ipReputationCache.get(key) || 0;
  ipReputationCache.set(key, count + 1);

  const threshold = type === "click" ? 10 : 50;
  if (count >= threshold) {
    console.log("[fraud-detection.js:checkIpReputation] High IP activity detected", { ip, type, count, threshold });
    return { suspicious: true, score: 0.6, reason: "high_ip_activity" };
  }
  return { suspicious: false, score: 0 };
}

// Session CTR Anomaly: track impressions and clicks per visitorId
function checkSessionBehavior(visitorId, type) {
  if (!visitorId) return { suspicious: false, score: 0 };
  const key = `session_${visitorId}`;
  const session = sessionCache.get(key) || { impressions: 0, clicks: 0 };
  if (type === "impression") session.impressions++;
  if (type === "click") session.clicks++;
  sessionCache.set(key, session);

  if (session.impressions >= 5) {
    const ctr = session.clicks / session.impressions;
    if (ctr > 0.2) {
      console.log("[fraud-detection.js:checkSessionBehavior] Abnormal session CTR", { visitorId, sessionImpressions: session.impressions, sessionClicks: session.clicks, ctr });
      return { suspicious: true, score: 0.5, reason: "abnormal_session_ctr" };
    }
  }
  return { suspicious: false, score: 0 };
}

// Geographic Consistency: flag impossible travel (different country within 1 hour)
function checkGeoConsistency(visitorId, country) {
  if (!visitorId || !country) return { suspicious: false, score: 0 };
  const key = `geo_${visitorId}`;
  const lastCountry = geoHistory.get(key);
  geoHistory.set(key, country);

  if (lastCountry && lastCountry !== country) {
    console.log("[fraud-detection.js:checkGeoConsistency] Impossible travel detected", { visitorId, previousCountry: lastCountry, currentCountry: country });
    return { suspicious: true, score: 0.4, reason: "impossible_travel" };
  }
  return { suspicious: false, score: 0 };
}

// Datacenter IP Detection: check against known datacenter/proxy IP patterns
function isDatacenterIP(ip) {
  if (!ip) return false;
  return DATACENTER_PATTERNS.some(p => p.test(ip));
}

// Refund a fraudulent charge by crediting back the advertiser's wallet
export async function refundFraudulentCharge(impressionId) {
  console.log("[fraud-detection.js:refundFraudulentCharge] Processing refund", { impressionId });
  try {
    const impressionDoc = await db.collection("impressions").doc(impressionId).get();
    if (!impressionDoc.exists) {
      console.error("Refund failed: impression not found:", impressionId);
      console.log("[fraud-detection.js:refundFraudulentCharge] Impression not found", { impressionId });
      return { success: false, reason: "not_found" };
    }

    const impression = impressionDoc.data();
    if (impression.refunded) {
      console.log("[fraud-detection.js:refundFraudulentCharge] Already refunded", { impressionId });
      return { success: false, reason: "already_refunded" };
    }

    if (!impression.advertiserId || !impression.chargedAmount) {
      console.log("[fraud-detection.js:refundFraudulentCharge] No charge data to refund", { impressionId, advertiserId: impression.advertiserId, chargedAmount: impression.chargedAmount });
      return { success: false, reason: "no_charge_data" };
    }

    console.log("[fraud-detection.js:refundFraudulentCharge] Crediting wallet", { advertiserId: impression.advertiserId, amount: impression.chargedAmount });

    // Credit back the wallet
    const { FieldValue } = await import("firebase-admin/firestore");
    const walletRef = db.collection("wallets").doc(impression.advertiserId);
    await walletRef.update({
      balance: FieldValue.increment(impression.chargedAmount),
    });

    // Mark impression as refunded
    await db.collection("impressions").doc(impressionId).update({
      refunded: true,
      refundedAt: new Date(),
    });

    // Record refund transaction
    await db.collection("transactions").add({
      advertiserId: impression.advertiserId,
      type: "refund",
      amount: impression.chargedAmount,
      impressionId,
      reason: "fraud_detected",
      timestamp: new Date(),
    });

    console.log("[fraud-detection.js:refundFraudulentCharge] Refund successful", { impressionId, amount: impression.chargedAmount, advertiserId: impression.advertiserId });
    return { success: true, amount: impression.chargedAmount };
  } catch (err) {
    console.error("Refund error:", err.message);
    console.log("[fraud-detection.js:refundFraudulentCharge] Refund failed with error", { impressionId, error: err.message });
    return { success: false, reason: err.message };
  }
}

// Get fraud stats summary (for admin dashboards)
export function getFraudStats() {
  console.log("[fraud-detection.js:getFraudStats] Getting fraud stats summary");
  return {
    clickRateCacheSize: clickRateCache.getStats(),
    impressionDedupCacheSize: impressionDedup.getStats(),
    ipReputationCacheSize: ipReputationCache.getStats(),
    sessionCacheSize: sessionCache.getStats(),
    geoHistoryCacheSize: geoHistory.getStats(),
  };
}
