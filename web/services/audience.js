import { db } from "../firebase.js";
import { FieldValue } from "firebase-admin/firestore";

// Get or create an anonymous visitor profile
export async function getVisitorProfile(visitorId, merchantId) {
  console.log("[audience.js:getVisitorProfile] Getting visitor profile", { visitorId, merchantId });
  if (!visitorId) {
    console.log("[audience.js:getVisitorProfile] No visitorId provided, returning null");
    return null;
  }

  const docId = `${merchantId}_${visitorId}`;
  const ref = db.collection("visitor_profiles").doc(docId);
  const doc = await ref.get();

  if (doc.exists) {
    console.log("[audience.js:getVisitorProfile] Existing profile FOUND", { docId, visitCount: doc.data().visitCount, lastVisitAt: doc.data().lastVisitAt });
    // Update visit count atomically to avoid race conditions
    await ref.update({ visitCount: FieldValue.increment(1), lastVisitAt: new Date() });
    return { id: doc.id, ...doc.data() };
  }

  // Create new profile
  console.log("[audience.js:getVisitorProfile] Profile NOT FOUND, creating new profile", { docId });
  const profile = {
    visitorId,
    merchantId,
    visitCount: 1,
    events: [],
    segments: [],
    aggregates: {
      pageViews: 0,
      productsViewed: 0,
      collectionsViewed: 0,
      cartAdditions: 0,
      cartValue: 0,
      searchQueries: [],
    },
    firstVisitAt: new Date(),
    lastVisitAt: new Date(),
  };
  await ref.set(profile);
  console.log("[audience.js:getVisitorProfile] New profile created", { docId });
  return { id: docId, ...profile };
}

// Track a visitor behavior event
// Uses atomic Firestore operations to avoid race conditions under concurrent load
export async function trackVisitorEvent(visitorId, merchantId, event) {
  // event = { type: "page_view"|"product_view"|"collection_view"|"cart_add"|"search", data: {...}, timestamp }
  console.log("[audience.js:trackVisitorEvent] Tracking visitor event", { visitorId, merchantId, eventType: event.type, eventData: event.data });
  if (!visitorId || !merchantId) {
    console.log("[audience.js:trackVisitorEvent] Missing visitorId or merchantId, skipping", { visitorId, merchantId });
    return;
  }

  const docId = `${merchantId}_${visitorId}`;
  const ref = db.collection("visitor_profiles").doc(docId);
  const doc = await ref.get();

  if (!doc.exists) {
    console.log("[audience.js:trackVisitorEvent] Profile not found, creating via getVisitorProfile", { docId });
    await getVisitorProfile(visitorId, merchantId); // create it
  }

  // Update aggregates atomically based on event type
  const updates = { lastVisitAt: new Date() };

  switch (event.type) {
    case "page_view":
      updates["aggregates.pageViews"] = FieldValue.increment(1);
      console.log("[audience.js:trackVisitorEvent] Incrementing pageViews", { visitorId });
      break;
    case "product_view":
      updates["aggregates.productsViewed"] = FieldValue.increment(1);
      console.log("[audience.js:trackVisitorEvent] Incrementing productsViewed", { visitorId });
      break;
    case "collection_view":
      updates["aggregates.collectionsViewed"] = FieldValue.increment(1);
      console.log("[audience.js:trackVisitorEvent] Incrementing collectionsViewed", { visitorId });
      break;
    case "cart_add":
      updates["aggregates.cartAdditions"] = FieldValue.increment(1);
      console.log("[audience.js:trackVisitorEvent] Incrementing cartAdditions", { visitorId });
      if (event.data?.value) {
        updates["aggregates.cartValue"] = FieldValue.increment(event.data.value);
        console.log("[audience.js:trackVisitorEvent] Incrementing cartValue", { visitorId, value: event.data.value });
      }
      break;
    case "search":
      // Use arrayUnion for search queries (deduplicates automatically)
      if (event.data?.query) {
        updates["aggregates.searchQueries"] = FieldValue.arrayUnion(event.data.query);
        console.log("[audience.js:trackVisitorEvent] Adding search query", { visitorId, query: event.data.query });
      }
      break;
  }

  console.log("[audience.js:trackVisitorEvent] Applying atomic updates", { docId, updateKeys: Object.keys(updates) });
  await ref.update(updates);

  // Use a Firestore transaction to append to events array and truncate to last 100
  console.log("[audience.js:trackVisitorEvent] Appending event to events array (transaction)", { docId, eventType: event.type });
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const currentEvents = snapshot.exists ? (snapshot.data().events || []) : [];
    currentEvents.push({ ...event, timestamp: new Date() });
    const truncatedEvents = currentEvents.slice(-100);
    transaction.update(ref, { events: truncatedEvents });
    console.log("[audience.js:trackVisitorEvent] Events array updated", { docId, previousEventCount: currentEvents.length - 1, newEventCount: truncatedEvents.length });
  });
}

// Evaluate which segments a visitor belongs to
export function evaluateSegments(visitorProfile, segmentRules) {
  console.log("[audience.js:evaluateSegments] Evaluating segments", { profileId: visitorProfile?.id, visitCount: visitorProfile?.visitCount, segmentRuleCount: segmentRules?.length });
  if (!visitorProfile || !segmentRules?.length) {
    console.log("[audience.js:evaluateSegments] No profile or segment rules, returning empty", { hasProfile: !!visitorProfile, ruleCount: segmentRules?.length });
    return [];
  }

  const matchedSegments = segmentRules.filter(segment => {
    // All rules in a segment must match (AND logic)
    const allRulesMatch = (segment.rules || []).every(rule => {
      const value = getNestedValue(visitorProfile, rule.field);
      const ruleResult = evaluateRule(value, rule.operator, rule.value);
      console.log("[audience.js:evaluateSegments] Rule evaluation", { segmentId: segment.id, field: rule.field, operator: rule.operator, expected: rule.value, actual: value, result: ruleResult });
      return ruleResult;
    });
    return allRulesMatch;
  }).map(s => s.id);

  console.log("[audience.js:evaluateSegments] Segment evaluation complete", { matchedSegments, totalRules: segmentRules.length, matchedCount: matchedSegments.length });
  return matchedSegments;
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

function evaluateRule(actual, operator, expected) {
  switch (operator) {
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "eq": return String(actual) === String(expected);
    case "neq": return String(actual) !== String(expected);
    case "contains": return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case "in": return Array.isArray(expected) ? expected.includes(actual) : false;
    default: return false;
  }
}
