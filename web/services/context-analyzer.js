import Anthropic from "@anthropic-ai/sdk";
import { db } from "../firebase.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Analyze a storefront page URL to extract context for ad targeting.
 * Uses Claude AI to infer category, tags, keywords, sentiment, and demographic.
 * Results are cached in the page_contexts Firestore collection for 24h.
 */
export async function analyzePageContext(pageUrl, zoneId, merchantId) {
  console.log("[context-analyzer.js:analyzePageContext] Analyzing page context", { pageUrl, zoneId, merchantId });

  // 1. Check cache in page_contexts collection
  try {
    const cacheSnap = await db
      .collection("page_contexts")
      .where("pageUrl", "==", pageUrl)
      .where("zoneId", "==", zoneId)
      .limit(1)
      .get();

    if (!cacheSnap.empty) {
      const cached = cacheSnap.docs[0].data();
      const analyzedAt = cached.analyzedAt?.toDate
        ? cached.analyzedAt.toDate()
        : new Date(cached.analyzedAt);

      if (Date.now() - analyzedAt.getTime() < CACHE_TTL_MS) {
        console.log("[context-analyzer.js:analyzePageContext] CACHE HIT - returning cached page context", { pageUrl, category: cached.category, ageMs: Date.now() - analyzedAt.getTime() });
        return {
          category: cached.category,
          tags: cached.tags,
          keywords: cached.keywords,
          sentiment: cached.sentiment,
          demographic: cached.demographic,
        };
      }
      console.log("[context-analyzer.js:analyzePageContext] CACHE STALE - cached result expired", { pageUrl, ageMs: Date.now() - analyzedAt.getTime(), ttlMs: CACHE_TTL_MS });
    } else {
      console.log("[context-analyzer.js:analyzePageContext] CACHE MISS - no cached result found", { pageUrl, zoneId });
    }
  } catch (err) {
    console.error("Error checking page context cache:", err);
    console.log("[context-analyzer.js:analyzePageContext] Cache check error", { pageUrl, error: err.message });
  }

  // 2. Call Claude API
  console.log("[context-analyzer.js:analyzePageContext] Calling Claude API for page analysis", { pageUrl });
  let context = {
    category: "general",
    tags: [],
    keywords: [],
    sentiment: "neutral",
    demographic: "general",
  };

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Analyze this storefront page URL and extract contextual information for ad targeting.

URL: ${pageUrl}

Return ONLY valid JSON with this exact structure (no other text):
{
  "category": "single category string e.g. fashion, electronics, home, beauty, food, sports, toys, health",
  "tags": ["up to 10 relevant tags"],
  "keywords": ["up to 20 relevant keywords for ad matching"],
  "sentiment": "positive, neutral, or negative",
  "demographic": "target demographic e.g. young adults, parents, professionals, seniors"
}`,
        },
      ],
    });

    const responseText = message.content[0]?.text || "";
    const parsed = extractJSON(responseText);
    if (parsed) {
      context = {
        category: parsed.category || "general",
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 20) : [],
        sentiment: parsed.sentiment || "neutral",
        demographic: parsed.demographic || "general",
      };
      console.log("[context-analyzer.js:analyzePageContext] Claude API analysis successful", { pageUrl, category: context.category, tagCount: context.tags.length, keywordCount: context.keywords.length, sentiment: context.sentiment, demographic: context.demographic });
    } else {
      console.log("[context-analyzer.js:analyzePageContext] Claude API response could not be parsed", { pageUrl, responseText: responseText.substring(0, 200) });
    }
  } catch (err) {
    console.error("Error calling Claude API for page context:", err);
    console.log("[context-analyzer.js:analyzePageContext] Claude API call failed, returning default context", { pageUrl, error: err.message });
    // Return default context on API failure
    return context;
  }

  // 3. Cache result in page_contexts collection
  try {
    console.log("[context-analyzer.js:analyzePageContext] Caching page context", { pageUrl, zoneId });
    const cacheData = {
      zoneId,
      merchantId,
      pageUrl,
      ...context,
      analyzedAt: new Date(),
    };

    // Upsert: check if doc exists to update, otherwise add
    const existingSnap = await db
      .collection("page_contexts")
      .where("pageUrl", "==", pageUrl)
      .where("zoneId", "==", zoneId)
      .limit(1)
      .get();

    if (existingSnap.empty) {
      await db.collection("page_contexts").add(cacheData);
      console.log("[context-analyzer.js:analyzePageContext] New page context cached (created)", { pageUrl });
    } else {
      await existingSnap.docs[0].ref.update(cacheData);
      console.log("[context-analyzer.js:analyzePageContext] Existing page context updated", { pageUrl });
    }

    // Also update zone doc with context field
    if (zoneId) {
      await db.collection("zones").doc(zoneId).update({
        context,
        contextAnalyzedAt: new Date(),
      });
      console.log("[context-analyzer.js:analyzePageContext] Zone context field updated", { zoneId });
    }
  } catch (err) {
    console.error("Error caching page context:", err);
    console.log("[context-analyzer.js:analyzePageContext] Failed to cache page context", { pageUrl, error: err.message });
  }

  return context;
}

/**
 * Analyze a creative to extract its context for relevance matching.
 * Uses Claude AI to infer category, tags, keywords, and target audience.
 */
export async function analyzeCreativeContext(creative) {
  console.log("[context-analyzer.js:analyzeCreativeContext] Analyzing creative context", { creativeId: creative.id, creativeName: creative.name, creativeType: creative.type });
  let context = {
    category: "general",
    tags: [],
    keywords: [],
    targetAudience: "general",
  };

  try {
    const creativeInfo = [
      creative.name ? `Name: ${creative.name}` : "",
      creative.destinationUrl ? `Destination: ${creative.destinationUrl}` : "",
      creative.type ? `Type: ${creative.type}` : "",
      creative.altText ? `Alt text: ${creative.altText}` : "",
      creative.productData?.title ? `Product: ${creative.productData.title}` : "",
      creative.productData?.description
        ? `Description: ${creative.productData.description.slice(0, 200)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    console.log("[context-analyzer.js:analyzeCreativeContext] Calling Claude API for creative analysis", { creativeId: creative.id });
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Given this ad creative, extract contextual information for ad targeting.

${creativeInfo}

Return ONLY valid JSON with this exact structure (no other text):
{
  "category": "single category string",
  "tags": ["up to 10 relevant tags"],
  "keywords": ["up to 20 relevant keywords"],
  "targetAudience": "target audience description"
}`,
        },
      ],
    });

    const responseText = message.content[0]?.text || "";
    const parsed = extractJSON(responseText);
    if (parsed) {
      context = {
        category: parsed.category || "general",
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : [],
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 20) : [],
        targetAudience: parsed.targetAudience || "general",
      };
      console.log("[context-analyzer.js:analyzeCreativeContext] Claude API analysis successful", { creativeId: creative.id, category: context.category, tagCount: context.tags.length, keywordCount: context.keywords.length, targetAudience: context.targetAudience });
    } else {
      console.log("[context-analyzer.js:analyzeCreativeContext] Claude API response could not be parsed", { creativeId: creative.id });
    }
  } catch (err) {
    console.error("Error calling Claude API for creative context:", err);
    console.log("[context-analyzer.js:analyzeCreativeContext] Claude API call failed, returning default context", { creativeId: creative.id, error: err.message });
    return context;
  }

  // Save context to the creative doc
  try {
    if (creative.id) {
      console.log("[context-analyzer.js:analyzeCreativeContext] Saving context to creative doc", { creativeId: creative.id });
      await db.collection("creatives").doc(creative.id).update({
        context,
        contextAnalyzedAt: new Date(),
      });
      console.log("[context-analyzer.js:analyzeCreativeContext] Creative context saved", { creativeId: creative.id });
    }
  } catch (err) {
    console.error("Error saving creative context:", err);
    console.log("[context-analyzer.js:analyzeCreativeContext] Failed to save creative context", { creativeId: creative.id, error: err.message });
  }

  return context;
}

/**
 * Category hierarchy map for cross-category matching (Phase 8A-B).
 * Maps a parent category to its related subcategories/synonyms.
 */
const CATEGORY_RELATIONS = {
  fashion: ["clothing", "shoes", "accessories", "apparel", "jewelry"],
  electronics: ["phones", "computers", "gadgets", "tech", "audio"],
  home: ["furniture", "decor", "kitchen", "garden", "bedding"],
  beauty: ["skincare", "makeup", "cosmetics", "haircare", "fragrance"],
  sports: ["fitness", "outdoor", "athletic", "gym", "exercise"],
  food: ["grocery", "snacks", "beverages", "organic", "gourmet"],
  health: ["wellness", "supplements", "vitamins", "medical", "fitness"],
};

/**
 * Check if two categories are related via the CATEGORY_RELATIONS hierarchy.
 * Returns true if they share a parent category or one is a subcategory of the other.
 */
function areCategoriesRelated(catA, catB) {
  if (!catA || !catB) return false;
  const a = catA.toLowerCase();
  const b = catB.toLowerCase();
  if (a === b) return true;

  for (const parent in CATEGORY_RELATIONS) {
    const children = CATEGORY_RELATIONS[parent];
    const aIsParent = a === parent;
    const bIsParent = b === parent;
    const aIsChild = children.indexOf(a) >= 0;
    const bIsChild = children.indexOf(b) >= 0;

    // One is parent, the other is child
    if ((aIsParent && bIsChild) || (bIsParent && aIsChild)) return true;
    // Both are children of the same parent
    if (aIsChild && bIsChild) return true;
  }

  return false;
}

/**
 * Check if one string is a substring of the other (bidirectional).
 * E.g. "running shoe" contains "shoe", and "shoe" is contained in "running shoe".
 */
function isSubstringMatch(a, b) {
  if (!a || !b) return false;
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

/**
 * Compute relevance score between a creative's context and a page's context.
 * Uses a 2-tier approach: exact matching (Tier 1), then fuzzy matching (Tier 2).
 * Returns a value between 0.0 and 1.0.
 */
export function computeRelevanceScore(creativeContext, pageContext) {
  console.log("[context-analyzer.js:computeRelevanceScore] Computing relevance score", { hasCreativeContext: !!creativeContext, hasPageContext: !!pageContext, creativeCategory: creativeContext?.category, pageCategory: pageContext?.category });
  if (!creativeContext || !pageContext) {
    console.log("[context-analyzer.js:computeRelevanceScore] Missing context, returning neutral 0.5");
    return 0.5; // neutral if no context
  }

  const creativeTagsArr = (creativeContext.tags || []).map((t) => t.toLowerCase());
  const pageTagsArr = (pageContext.tags || []).map((t) => t.toLowerCase());
  const creativeKeywordsArr = (creativeContext.keywords || []).map((k) => k.toLowerCase());
  const pageKeywordsArr = (pageContext.keywords || []).map((k) => k.toLowerCase());

  const creativeTags = new Set(creativeTagsArr);
  const pageTags = new Set(pageTagsArr);
  const creativeKeywords = new Set(creativeKeywordsArr);
  const pageKeywords = new Set(pageKeywordsArr);

  // ============================================================
  // TIER 1: Exact matching (existing logic)
  // ============================================================

  let exactScore = 0.3; // base score

  // Tag overlap (up to 0.3)
  const tagOverlap = [...creativeTags].filter((t) => pageTags.has(t)).length;
  exactScore += Math.min(0.3, tagOverlap * 0.1);

  // Keyword overlap (up to 0.2)
  const keywordOverlap = [...creativeKeywords].filter((k) =>
    pageKeywords.has(k)
  ).length;
  exactScore += Math.min(0.2, keywordOverlap * 0.05);

  // Category match (0.2)
  if (
    creativeContext.category &&
    pageContext.category &&
    creativeContext.category.toLowerCase() === pageContext.category.toLowerCase()
  ) {
    exactScore += 0.2;
  }

  exactScore = Math.min(1.0, exactScore);

  console.log("[context-analyzer.js:computeRelevanceScore] Tier 1 (Exact) score", { exactScore, tagOverlap, keywordOverlap, categoryMatch: creativeContext.category?.toLowerCase() === pageContext.category?.toLowerCase() });

  // ============================================================
  // TIER 2: Fuzzy matching (Phase 8A-B)
  // ============================================================

  let fuzzyScore = 0.3; // base score

  // Tag substring overlap (up to 0.25, 0.08 per match)
  let tagSubstringMatches = 0;
  for (let i = 0; i < creativeTagsArr.length; i++) {
    for (let j = 0; j < pageTagsArr.length; j++) {
      if (creativeTagsArr[i] !== pageTagsArr[j] && isSubstringMatch(creativeTagsArr[i], pageTagsArr[j])) {
        tagSubstringMatches++;
        break; // count each creative tag at most once
      }
    }
  }
  fuzzyScore += Math.min(0.25, tagSubstringMatches * 0.08);

  // Keyword substring overlap (up to 0.2, 0.04 per match)
  let keywordSubstringMatches = 0;
  for (let i = 0; i < creativeKeywordsArr.length; i++) {
    for (let j = 0; j < pageKeywordsArr.length; j++) {
      if (creativeKeywordsArr[i] !== pageKeywordsArr[j] && isSubstringMatch(creativeKeywordsArr[i], pageKeywordsArr[j])) {
        keywordSubstringMatches++;
        break; // count each creative keyword at most once
      }
    }
  }
  fuzzyScore += Math.min(0.2, keywordSubstringMatches * 0.04);

  // Cross-category match via hierarchy (0.15)
  const crossCategoryMatch = creativeContext.category &&
    pageContext.category &&
    creativeContext.category.toLowerCase() !== pageContext.category.toLowerCase() &&
    areCategoriesRelated(creativeContext.category, pageContext.category);
  if (crossCategoryMatch) {
    fuzzyScore += 0.15;
  }

  // Exact category match still counts for fuzzy tier too (0.2)
  if (
    creativeContext.category &&
    pageContext.category &&
    creativeContext.category.toLowerCase() === pageContext.category.toLowerCase()
  ) {
    fuzzyScore += 0.2;
  }

  fuzzyScore = Math.min(1.0, fuzzyScore);

  console.log("[context-analyzer.js:computeRelevanceScore] Tier 2 (Fuzzy) score", { fuzzyScore, tagSubstringMatches, keywordSubstringMatches, crossCategoryMatch });

  // Take the better of exact or fuzzy score
  const finalScore = Math.max(exactScore, fuzzyScore);
  console.log("[context-analyzer.js:computeRelevanceScore] Final relevance score", { exactScore, fuzzyScore, finalScore, source: exactScore >= fuzzyScore ? "exact" : "fuzzy" });
  return finalScore;
}

/**
 * Extract JSON from a text response that may contain markdown code blocks or extra text.
 */
function extractJSON(text) {
  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from markdown code block
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // fall through
      }
    }

    // Try to find JSON object in the text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }

    return null;
  }
}
