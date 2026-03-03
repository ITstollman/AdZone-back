import { Router } from "express";
import {
  getUnreadNotifications,
  markAsRead,
  getNotificationCount,
} from "../../services/notification.js";

const router = Router();

// GET /api/advertiser/notifications — List notifications for the authenticated advertiser
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    console.log("[notifications.js:GET /] List advertiser notifications request", { advertiserId });
    const notifications = await getUnreadNotifications("advertiser", advertiserId);
    const count = await getNotificationCount("advertiser", advertiserId);

    console.log("[notifications.js:GET /] Returning notifications (200)", { advertiserId, notificationCount: notifications.length, unreadCount: count });
    res.json({ notifications, unreadCount: count });
  } catch (err) {
    console.error("Error fetching advertiser notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// PATCH /api/advertiser/notifications/read — Mark notifications as read
router.patch("/read", async (req, res) => {
  try {
    const { ids } = req.body;
    console.log("[notifications.js:PATCH /read] Mark as read request", { idsCount: Array.isArray(ids) ? ids.length : 0 });

    if (!Array.isArray(ids) || ids.length === 0) {
      console.log("[notifications.js:PATCH /read] Invalid ids, returning 400");
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }

    await markAsRead(ids);
    console.log("[notifications.js:PATCH /read] Notifications marked as read (200)", { count: ids.length });
    res.json({ success: true });
  } catch (err) {
    console.error("Error marking advertiser notifications as read:", err);
    res.status(500).json({ error: "Failed to mark notifications as read" });
  }
});

export default router;
