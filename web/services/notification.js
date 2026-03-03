import { db } from "../firebase.js";
import { sendTemplatedEmail } from "./email.js";
import { pushToMerchant } from "../routes/merchant/sse.js";
import { pushToAdvertiser } from "../routes/advertiser/sse.js";

/**
 * Create a notification for a recipient.
 *
 * @param {Object} params
 * @param {string} params.recipientType - "merchant" | "advertiser"
 * @param {string} params.recipientId - ID of the recipient
 * @param {string} params.type - Notification type (e.g. "campaign_approved", "creative_rejected", "payment_received")
 * @param {string} params.title - Short notification title
 * @param {string} params.message - Notification body text
 * @param {Object} [params.metadata] - Additional data (e.g. { campaignId, zoneId })
 * @returns {{ id: string, ...data }}
 */
export async function createNotification({
  recipientType,
  recipientId,
  type,
  title,
  message,
  metadata = null,
}) {
  const _start = Date.now();
  console.log("[notification:createNotification] >>> ENTRY — type=%s recipientType=%s recipientId=%s title=%s", type, recipientType, recipientId, title);
  console.log("[notification:createNotification] Message: %s", message);
  if (metadata) {
    console.log("[notification:createNotification] Metadata: %s", JSON.stringify(metadata));
  }

  const data = {
    recipientType,
    recipientId,
    type,
    title,
    message,
    metadata,
    read: false,
    createdAt: new Date(),
  };

  const docRef = await db.collection("notifications").add(data);
  console.log("[notification:createNotification] Notification stored in Firestore — docId=%s (%dms)", docRef.id, Date.now() - _start);

  // Push real-time SSE event
  const ssePayload = { type: "notification", id: docRef.id, title, message, notificationType: type, createdAt: new Date().toISOString() };
  if (recipientType === "merchant") {
    pushToMerchant(recipientId, ssePayload);
  } else {
    pushToAdvertiser(recipientId, ssePayload);
  }

  // Send email notification (fire-and-forget)
  (async () => {
    const _emailStart = Date.now();
    try {
      const collection = recipientType === "merchant" ? "merchants" : "advertisers";
      console.log("[notification:createNotification:email] Looking up recipient email — collection=%s recipientId=%s", collection, recipientId);
      const recipientDoc = await db.collection(collection).doc(recipientId).get();
      const email = recipientDoc.exists ? recipientDoc.data().email : null;

      if (email) {
        console.log("[notification:createNotification:email] Recipient email found — email=%s, sending templated email type=%s", email, type);
        const sent = await sendTemplatedEmail(email, type, { title, message, ...metadata });
        if (sent) {
          await docRef.update({ emailSent: true });
          console.log("[notification:createNotification:email] Email sent and notification updated — emailSent=true (%dms)", Date.now() - _emailStart);
        } else {
          console.log("[notification:createNotification:email] Email NOT sent (skipped by sendTemplatedEmail) (%dms)", Date.now() - _emailStart);
        }
      } else {
        console.log("[notification:createNotification:email] Recipient email NOT FOUND — recipientType=%s recipientId=%s docExists=%s", recipientType, recipientId, recipientDoc.exists);
      }
    } catch (err) {
      console.error("[notification:createNotification:email] Email notification FAILED — error=%s message=%s (%dms)", err.name, err.message, Date.now() - _emailStart);
      console.error("Email notification error:", err.message);
    }
  })();

  console.log("[notification:createNotification] <<< EXIT — notificationId=%s type=%s recipient=%s/%s (%dms)", docRef.id, type, recipientType, recipientId, Date.now() - _start);
  return { id: docRef.id, ...data };
}

/**
 * Get unread notifications for a recipient, ordered by newest first.
 *
 * @param {string} recipientType - "merchant" | "advertiser"
 * @param {string} recipientId - ID of the recipient
 * @returns {Array<{ id: string, ...data }>}
 */
export async function getUnreadNotifications(recipientType, recipientId) {
  const _start = Date.now();
  console.log("[notification:getUnreadNotifications] >>> ENTRY — recipientType=%s recipientId=%s", recipientType, recipientId);

  const snapshot = await db
    .collection("notifications")
    .where("recipientType", "==", recipientType)
    .where("recipientId", "==", recipientId)
    .where("read", "==", false)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  const notifications = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  console.log("[notification:getUnreadNotifications] <<< EXIT — recipientType=%s recipientId=%s unreadCount=%d (%dms)", recipientType, recipientId, notifications.length, Date.now() - _start);
  return notifications;
}

/**
 * Mark one or more notifications as read.
 *
 * @param {string[]} notificationIds - Array of notification document IDs
 */
export async function markAsRead(notificationIds) {
  const _start = Date.now();
  console.log("[notification:markAsRead] >>> ENTRY — count=%d ids=%s", notificationIds?.length || 0, JSON.stringify(notificationIds));

  if (!notificationIds || notificationIds.length === 0) {
    console.log("[notification:markAsRead] <<< EXIT — no IDs provided, nothing to mark (%dms)", Date.now() - _start);
    return;
  }

  const batch = db.batch();

  for (const id of notificationIds) {
    const ref = db.collection("notifications").doc(id);
    batch.update(ref, { read: true });
  }

  await batch.commit();
  console.log("[notification:markAsRead] <<< EXIT — %d notifications marked as read (%dms)", notificationIds.length, Date.now() - _start);
}

/**
 * Get the count of unread notifications for a recipient.
 *
 * @param {string} recipientType - "merchant" | "advertiser"
 * @param {string} recipientId - ID of the recipient
 * @returns {number}
 */
export async function getNotificationCount(recipientType, recipientId) {
  const _start = Date.now();
  console.log("[notification:getNotificationCount] >>> ENTRY — recipientType=%s recipientId=%s", recipientType, recipientId);

  const snapshot = await db
    .collection("notifications")
    .where("recipientType", "==", recipientType)
    .where("recipientId", "==", recipientId)
    .where("read", "==", false)
    .select()
    .get();

  console.log("[notification:getNotificationCount] <<< EXIT — recipientType=%s recipientId=%s count=%d (%dms)", recipientType, recipientId, snapshot.size, Date.now() - _start);
  return snapshot.size;
}
