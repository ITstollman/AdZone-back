import { db } from "../firebase.js";

/**
 * Write an audit log entry to the Firestore audit_logs collection.
 *
 * @param {Object} params
 * @param {string} params.actorType - "merchant" | "advertiser" | "system"
 * @param {string} params.actorId - ID of the actor performing the action
 * @param {string} params.action - Action performed (e.g. "create", "update", "delete", "approve")
 * @param {string} params.resourceType - Type of resource affected (e.g. "campaign", "zone", "creative")
 * @param {string} params.resourceId - ID of the affected resource
 * @param {Object} [params.changes] - Object describing what changed (e.g. { field: { from, to } })
 * @param {Object} [params.metadata] - Additional context (IP, user agent, etc.)
 */
export async function auditLog({
  actorType,
  actorId,
  action,
  resourceType,
  resourceId,
  changes = null,
  metadata = null,
}) {
  const _start = Date.now();
  console.log("[audit-log:auditLog] >>> ENTRY — actorType=%s actorId=%s action=%s resourceType=%s resourceId=%s", actorType, actorId, action, resourceType, resourceId);

  if (changes) {
    console.log("[audit-log:auditLog] Changes recorded — fields=%s", JSON.stringify(changes));
  }
  if (metadata) {
    console.log("[audit-log:auditLog] Metadata attached — %s", JSON.stringify(metadata));
  }

  try {
    const entry = {
      actorType,
      actorId,
      action,
      resourceType,
      resourceId,
      changes,
      metadata,
      timestamp: new Date(),
    };

    console.log("[audit-log:auditLog] Writing to Firestore audit_logs collection — timestamp=%s", entry.timestamp.toISOString());

    const docRef = await db.collection("audit_logs").add(entry);

    console.log("[audit-log:auditLog] <<< EXIT SUCCESS — docId=%s actorType=%s action=%s on %s/%s (%dms)", docRef.id, actorType, action, resourceType, resourceId, Date.now() - _start);
    return { id: docRef.id, ...entry };
  } catch (err) {
    // Audit logging should never break the main flow
    console.error("[audit-log:auditLog] <<< EXIT FAILURE — error=%s message=%s stack=%s (%dms)", err.name, err.message, err.stack, Date.now() - _start);
    console.error("Failed to write audit log:", err);
    return null;
  }
}
