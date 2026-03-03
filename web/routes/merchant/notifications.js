import { Router } from "express";
import { db } from "../../firebase.js";
import {
  getUnreadNotifications,
  markAsRead,
  getNotificationCount,
} from "../../services/notification.js";

const router = Router();

// GET /api/merchant/notifications — List notifications for the authenticated merchant
router.get("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    console.log("[merchant/notifications.js:GET /] List notifications request", { shop });
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;
    console.log("[merchant/notifications.js:GET /] Fetching notifications from DB", { merchantId });
    const notifications = await getUnreadNotifications("merchant", merchantId);
    const count = await getNotificationCount("merchant", merchantId);

    console.log("[merchant/notifications.js:GET /] Returning notifications (200)", { merchantId, notificationCount: notifications.length, unreadCount: count });
    res.json({ notifications, unreadCount: count });
  } catch (err) {
    console.error("Error fetching merchant notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PATCH /api/merchant/notifications/read — Mark notifications as read
router.patch("/read", async (req, res) => {
  try {
    const { ids } = req.body;
    console.log("[merchant/notifications.js:PATCH /read] Mark as read request", { idsCount: Array.isArray(ids) ? ids.length : 0 });

    if (!Array.isArray(ids) || ids.length === 0) {
      console.log("[merchant/notifications.js:PATCH /read] Invalid ids, returning 400");
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }

    await markAsRead(ids);
    console.log("[merchant/notifications.js:PATCH /read] Notifications marked as read (200)", { count: ids.length });
    res.json({ success: true });
  } catch (err) {
    console.error("Error marking merchant notifications as read:", err);
    res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

export default router;
