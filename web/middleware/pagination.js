/**
 * Parse pagination parameters from query string.
 * Defaults: page=1, limit=20. Max limit: 100.
 */
export function parsePagination(req) {
  const _start = Date.now();
  const rawPage = req.query.page;
  const rawLimit = req.query.limit;
  console.log("[pagination:parsePagination] >>> ENTRY — rawPage=%s rawLimit=%s path=%s", rawPage ?? "(not set)", rawLimit ?? "(not set)", req.originalUrl);

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const defaultsApplied = [];
  if (rawPage === undefined || rawPage === null) defaultsApplied.push("page=1");
  if (rawLimit === undefined || rawLimit === null) defaultsApplied.push("limit=20");
  if (parseInt(rawLimit) > 100) defaultsApplied.push("limit clamped to 100");

  console.log("[pagination:parsePagination] Computed — page=%d limit=%d offset=%d defaults=[%s] (%dms)", page, limit, offset, defaultsApplied.join(", ") || "none", Date.now() - _start);

  return { page, limit, offset };
}

/**
 * Apply pagination to a Firestore query and return results with pagination metadata.
 * @param {import("firebase-admin/firestore").Query} query - Firestore query (before limit/offset)
 * @param {{ page: number, limit: number }} pagination - Pagination params from parsePagination
 * @returns {{ items: Array, pagination: { page, limit, total, totalPages } }}
 */
export async function paginateFirestoreQuery(query, { page, limit }) {
  const _start = Date.now();
  console.log("[pagination:paginateFirestoreQuery] >>> ENTRY — page=%d limit=%d", page, limit);

  // Get total count by fetching all document IDs (select no fields for efficiency)
  const countSnap = await query.select().get();
  const total = countSnap.size;
  const totalPages = Math.ceil(total / limit) || 1;
  console.log("[pagination:paginateFirestoreQuery] Count query complete — total=%d totalPages=%d (%dms)", total, totalPages, Date.now() - _start);

  // Apply offset and limit
  const offset = (page - 1) * limit;
  const dataSnap = await query.offset(offset).limit(limit).get();

  const items = dataSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  console.log("[pagination:paginateFirestoreQuery] <<< EXIT — itemsReturned=%d offset=%d page=%d/%d (%dms)", items.length, offset, page, totalPages, Date.now() - _start);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}
