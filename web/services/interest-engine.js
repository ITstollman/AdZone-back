import NodeCache from "node-cache";

const interestCache = new NodeCache({ stdTTL: 1800 }); // 30 min

/**
 * Build interest profile from visitor behavioral data.
 * Recency-weighted scoring: recent events count more.
 */
export function buildInterestProfile(visitorProfile) {
  console.log("[interest-engine.js:buildInterestProfile] Building interest profile", { visitorId: visitorProfile?.visitorId, merchantId: visitorProfile?.merchantId, eventCount: visitorProfile?.events?.length });
  if (!visitorProfile) {
    console.log("[interest-engine.js:buildInterestProfile] No visitor profile, returning empty interest profile");
    return { categories: {}, keywords: [], searchIntents: [], topInterests: [] };
  }

  const cacheKey = `interest_${visitorProfile.visitorId}_${visitorProfile.merchantId}`;
  const cached = interestCache.get(cacheKey);
  if (cached) {
    console.log("[interest-engine.js:buildInterestProfile] CACHE HIT", { cacheKey, topInterests: cached.topInterests });
    return cached;
  }
  console.log("[interest-engine.js:buildInterestProfile] CACHE MISS, computing interest profile", { cacheKey });

  const events = visitorProfile.events || [];
  const categoryScores = {};
  const keywordBag = {};
  const searchIntents = [];
  const now = Date.now();

  events.forEach(event => {
    const eventTime = event.timestamp ? new Date(event.timestamp).getTime() : now;
    const ageHours = Math.max(1, (now - eventTime) / (1000 * 60 * 60));
    const recencyWeight = 1 / Math.log2(ageHours + 1);

    if (event.type === "product_view" && event.data) {
      const url = event.data.url || "";
      const collectionMatch = url.match(/\/collections\/([^\/]+)/);
      if (collectionMatch) {
        const cat = collectionMatch[1].replace(/-/g, " ");
        categoryScores[cat] = (categoryScores[cat] || 0) + 2 * recencyWeight;
      }
      if (event.data.handle) {
        event.data.handle.split("-").forEach(w => {
          if (w.length > 2) keywordBag[w] = (keywordBag[w] || 0) + recencyWeight;
        });
      }
    }

    if (event.type === "collection_view" && event.data?.handle) {
      const cat = event.data.handle.replace(/-/g, " ");
      categoryScores[cat] = (categoryScores[cat] || 0) + 1.5 * recencyWeight;
    }

    if (event.type === "search" && event.data?.query) {
      searchIntents.push(event.data.query);
      event.data.query.toLowerCase().split(/\s+/).forEach(w => {
        if (w.length > 2) keywordBag[w] = (keywordBag[w] || 0) + 3 * recencyWeight;
      });
    }

    if (event.type === "cart_add" && event.data?.handle) {
      (event.data.handle.split?.("-") || []).forEach(w => {
        if (w.length > 2) keywordBag[w] = (keywordBag[w] || 0) + 5 * recencyWeight;
      });
    }
  });

  const topInterests = Object.entries(categoryScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cat]) => cat);

  const keywords = Object.entries(keywordBag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([kw]) => kw);

  const result = { categories: categoryScores, keywords, searchIntents, topInterests };
  console.log("[interest-engine.js:buildInterestProfile] Interest profile built", { eventCount: events.length, topInterests, keywordCount: keywords.length, searchIntentCount: searchIntents.length, categoryCount: Object.keys(categoryScores).length });
  interestCache.set(cacheKey, result);
  return result;
}

/**
 * Compute interest match between visitor interests and creative context.
 * Returns 0.0-1.0.
 */
export function computeInterestMatch(interestProfile, creativeContext) {
  console.log("[interest-engine.js:computeInterestMatch] Computing interest match", { hasInterestProfile: !!interestProfile, hasCreativeContext: !!creativeContext, creativeCategory: creativeContext?.category });
  if (!interestProfile || !creativeContext) {
    console.log("[interest-engine.js:computeInterestMatch] Missing data, returning neutral 0.5");
    return 0.5;
  }

  let score = 0;

  // Category match (weight: 0.4)
  const creativeCategory = (creativeContext.category || "").toLowerCase();
  const categoryMatched = creativeCategory && interestProfile.topInterests.some(cat =>
    cat.includes(creativeCategory) || creativeCategory.includes(cat)
  );
  if (categoryMatched) {
    score += 0.4;
  }
  console.log("[interest-engine.js:computeInterestMatch] Category match", { creativeCategory, topInterests: interestProfile.topInterests, categoryMatched, categoryScore: categoryMatched ? 0.4 : 0 });

  // Keyword overlap (weight: 0.35)
  const visitorKeywords = new Set(interestProfile.keywords);
  const creativeKeywords = (creativeContext.keywords || []).map(k => k.toLowerCase());
  const keywordOverlap = creativeKeywords.filter(k => visitorKeywords.has(k)).length;
  const keywordScore = Math.min(0.35, (keywordOverlap / Math.max(1, creativeKeywords.length)) * 0.35);
  score += keywordScore;
  console.log("[interest-engine.js:computeInterestMatch] Keyword overlap", { visitorKeywordCount: visitorKeywords.size, creativeKeywordCount: creativeKeywords.length, overlap: keywordOverlap, keywordScore });

  // Search intent match (weight: 0.25)
  const creativeTags = new Set((creativeContext.tags || []).map(t => t.toLowerCase()));
  const searchMatch = interestProfile.searchIntents.some(query => {
    const words = query.toLowerCase().split(/\s+/);
    return words.some(w => creativeTags.has(w) || creativeKeywords.includes(w));
  });
  if (searchMatch) score += 0.25;
  console.log("[interest-engine.js:computeInterestMatch] Search intent match", { searchIntentCount: interestProfile.searchIntents.length, searchMatch, searchScore: searchMatch ? 0.25 : 0 });

  const finalScore = Math.min(1.0, score);
  console.log("[interest-engine.js:computeInterestMatch] Final interest match score", { categoryScore: categoryMatched ? 0.4 : 0, keywordScore, searchScore: searchMatch ? 0.25 : 0, finalScore });
  return finalScore;
}
