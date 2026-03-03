import { db } from "../firebase.js";
import NodeCache from "node-cache";

const affinityCache = new NodeCache({ stdTTL: 3600 }); // 1hr

/**
 * Build co-occurrence matrix for products viewed together.
 * Runs hourly via cron. Writes to product_cooccurrence collection.
 */
export async function buildCooccurrenceMatrix(merchantId) {
  console.log("[product-affinity.js:buildCooccurrenceMatrix] Building co-occurrence matrix", { merchantId });
  const snap = await db.collection("visitor_profiles")
    .where("merchantId", "==", merchantId)
    .limit(1000)
    .get();

  console.log("[product-affinity.js:buildCooccurrenceMatrix] Loaded visitor profiles", { merchantId, profileCount: snap.docs.length });

  const pairCounts = {};

  snap.docs.forEach(doc => {
    const events = doc.data().events || [];
    const productHandles = [...new Set(
      events.filter(e => e.type === "product_view" && e.data?.handle)
        .map(e => e.data.handle)
    )];

    for (let i = 0; i < productHandles.length; i++) {
      for (let j = i + 1; j < productHandles.length; j++) {
        const key = [productHandles[i], productHandles[j]].sort().join("|");
        pairCounts[key] = (pairCounts[key] || 0) + 1;
      }
    }
  });

  const pairsFound = Object.keys(pairCounts).length;
  console.log("[product-affinity.js:buildCooccurrenceMatrix] Co-occurrence pairs computed", { merchantId, totalPairsFound: pairsFound });

  const entries = Object.entries(pairCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500);

  console.log("[product-affinity.js:buildCooccurrenceMatrix] Writing top pairs to Firestore", { merchantId, pairsToWrite: entries.length });

  // Batch write in groups of 500 (Firestore limit)
  const batchSize = 500;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = db.batch();
    const chunk = entries.slice(i, i + batchSize);
    for (const [pair, count] of chunk) {
      const [productA, productB] = pair.split("|");
      const docId = `${merchantId}_${productA}_${productB}`;
      batch.set(db.collection("product_cooccurrence").doc(docId), {
        merchantId, productA, productB, score: count, updatedAt: new Date(),
      }, { merge: true });
    }
    await batch.commit();
    console.log("[product-affinity.js:buildCooccurrenceMatrix] Batch committed", { merchantId, batchStart: i, batchSize: chunk.length });
  }

  console.log("[product-affinity.js:buildCooccurrenceMatrix] Co-occurrence matrix build complete", { merchantId, pairsWritten: entries.length });
}

/**
 * Compute product affinity scores for ads based on visitor's viewed products.
 * Returns map of creativeId -> affinity score (0-1).
 */
export async function computeProductAffinity(viewedProducts, candidateAds, merchantId) {
  console.log("[product-affinity.js:computeProductAffinity] Computing product affinity", { viewedProductCount: viewedProducts?.length, candidateAdCount: candidateAds?.length, merchantId });
  if (!viewedProducts?.length || !candidateAds?.length) {
    console.log("[product-affinity.js:computeProductAffinity] No viewed products or candidate ads, returning empty");
    return {};
  }

  const cacheKey = `affinity_${merchantId}_${viewedProducts.slice(0, 5).join(",")}`;
  const cached = affinityCache.get(cacheKey);
  if (cached) {
    console.log("[product-affinity.js:computeProductAffinity] CACHE HIT", { cacheKey, matchedAds: Object.keys(cached).length });
    return cached;
  }
  console.log("[product-affinity.js:computeProductAffinity] CACHE MISS, computing affinity scores", { cacheKey });

  const cooccurrences = {};

  for (const handle of viewedProducts.slice(0, 10)) {
    // Check both directions of the pair
    const [snap1, snap2] = await Promise.all([
      db.collection("product_cooccurrence")
        .where("merchantId", "==", merchantId)
        .where("productA", "==", handle)
        .orderBy("score", "desc")
        .limit(20)
        .get(),
      db.collection("product_cooccurrence")
        .where("merchantId", "==", merchantId)
        .where("productB", "==", handle)
        .orderBy("score", "desc")
        .limit(20)
        .get(),
    ]);

    snap1.docs.forEach(doc => {
      const d = doc.data();
      cooccurrences[d.productB] = Math.max(cooccurrences[d.productB] || 0, d.score);
    });
    snap2.docs.forEach(doc => {
      const d = doc.data();
      cooccurrences[d.productA] = Math.max(cooccurrences[d.productA] || 0, d.score);
    });
    console.log("[product-affinity.js:computeProductAffinity] Co-occurrences loaded for product", { handle, forwardResults: snap1.docs.length, reverseResults: snap2.docs.length });
  }

  const maxCooccurrence = Math.max(1, ...Object.values(cooccurrences));
  const scores = {};

  let directMatches = 0;
  let cooccurrenceMatches = 0;

  for (const ad of candidateAds) {
    const adHandle = ad.creative?.productData?.handle || ad.creative?.destinationUrl?.match(/\/products\/([^?/]+)/)?.[1];
    if (!adHandle) continue;

    if (viewedProducts.includes(adHandle)) {
      scores[ad.creative.id] = 0.9;
      directMatches++;
      continue;
    }

    if (cooccurrences[adHandle]) {
      scores[ad.creative.id] = Math.min(0.8, cooccurrences[adHandle] / maxCooccurrence);
      cooccurrenceMatches++;
    }
  }

  console.log("[product-affinity.js:computeProductAffinity] Affinity scores computed", { viewedProducts: viewedProducts.slice(0, 5), totalCooccurrences: Object.keys(cooccurrences).length, maxCooccurrence, directMatches, cooccurrenceMatches, totalMatchedAds: Object.keys(scores).length });

  affinityCache.set(cacheKey, scores);
  return scores;
}
