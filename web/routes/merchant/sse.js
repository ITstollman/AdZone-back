import { Router } from "express";
import { db } from "../../firebase.js";

const router = Router();

// In-memory map of active SSE connections: merchantId -> Set<res>
const connections = new Map();

/**
 * Push a notification to all active SSE connections for a merchant.
 * Call this from the notification service when a new notification is created.
 */
export function pushToMerchant(merchantId, data) {
  const clients = connections.get(merchantId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// GET /api/merchant/sse — Server-Sent Events stream
router.get("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", shop)
      .limit(1)
      .get();

    if (merchantSnap.empty) {
      return res.status(404).json({ error: "Merchant not found" });
    }

    const merchantId = merchantSnap.docs[0].id;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected", merchantId })}\n\n`);

    // Register connection
    if (!connections.has(merchantId)) {
      connections.set(merchantId, new Set());
    }
    connections.get(merchantId).add(res);

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Cleanup on close
    req.on("close", () => {
      clearInterval(heartbeat);
      const clients = connections.get(merchantId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) connections.delete(merchantId);
      }
    });
  } catch (err) {
    console.error("SSE connection error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "SSE connection failed" });
    }
  }
});

export default router;
