import { Router } from "express";

const router = Router();

// In-memory map of active SSE connections: advertiserId -> Set<res>
const connections = new Map();

/**
 * Push a notification to all active SSE connections for an advertiser.
 * Call this from the notification service when a new notification is created.
 */
export function pushToAdvertiser(advertiserId, data) {
  const clients = connections.get(advertiserId);
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

// GET /api/advertiser/sse — Server-Sent Events stream
router.get("/", (req, res) => {
  try {
    const { advertiserId } = req.advertiser;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: "connected", advertiserId })}\n\n`);

    // Register connection
    if (!connections.has(advertiserId)) {
      connections.set(advertiserId, new Set());
    }
    connections.get(advertiserId).add(res);

    // Heartbeat every 30s
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
      const clients = connections.get(advertiserId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) connections.delete(advertiserId);
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
