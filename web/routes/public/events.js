import { Router } from "express";
import { trackVisitorEvent } from "../../services/audience.js";

const router = Router();

// POST /batch — receive batch of visitor events
router.post("/batch", async (req, res) => {
  const { visitorId, merchantId, events } = req.body;
  console.log("[events.js:POST /batch] Batch events received", { visitorId, merchantId, eventCount: Array.isArray(events) ? events.length : 0 });

  if (!visitorId || !merchantId || !Array.isArray(events)) {
    console.log("[events.js:POST /batch] Missing required fields, returning 400");
    return res.status(400).json({ error: "visitorId, merchantId, and events[] are required" });
  }

  try {
    // Process events in parallel (but don't wait for all)
    const promises = events.slice(0, 50).map(event => // max 50 events per batch
      trackVisitorEvent(visitorId, merchantId, event).catch(err =>
        console.error("Event tracking error:", err.message)
      )
    );
    await Promise.all(promises);

    console.log("[events.js:POST /batch] Events processed successfully", { processed: Math.min(events.length, 50), visitorId, merchantId });
    res.json({ success: true, processed: Math.min(events.length, 50) });
  } catch (err) {
    console.error("[events.js:POST /batch] Error processing events:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
