import { Router } from "express";
import { db } from "../../firebase.js";
import { auditLog } from "../../middleware/audit-log.js";
import { analyzeCreativeContext } from "../../services/context-analyzer.js";
import { createNotification } from "../../services/notification.js";

const router = Router();

// GET /pending — list creatives pending review for this merchant's campaigns
router.get("/pending", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[creatives-review.js:GET /pending] Review queue request", { shop: session.shop });
    // Find merchant by shop domain
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    // Find campaigns targeting this merchant
    const campaignSnap = await db
      .collection("campaigns")
      .where("merchantId", "==", merchantId)
      .get();
    const campaignIds = campaignSnap.docs.map((d) => d.id);

    if (campaignIds.length === 0) return res.json({ creatives: [] });

    // Get pending creatives for these campaigns (Firestore 'in' limited to 30)
    const batchIds = campaignIds.slice(0, 30);
    const creativeSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "pending_review")
      .get();

    const creatives = creativeSnap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));
    console.log("[creatives-review.js:GET /pending] Returning pending creatives (200)", { count: creatives.length, merchantId });
    res.json({ creatives });
  } catch (err) {
    console.error("[creatives-review.js:GET /pending] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /:id/review — approve or reject a creative
router.patch("/:id/review", async (req, res) => {
  const { status, feedback } = req.body; // status: 'approved' or 'rejected'
  console.log("[creatives-review.js:PATCH /:id/review] Review creative request", { creativeId: req.params.id, status, feedback });
  if (!["approved", "rejected"].includes(status)) {
    return res
      .status(400)
      .json({ error: "Status must be 'approved' or 'rejected'" });
  }

  try {
    const docRef = db.collection("creatives").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      console.log("[creatives-review.js:PATCH /:id/review] Creative not found", { creativeId: req.params.id });
      return res.status(404).json({ error: "Creative not found" });
    }

    console.log("[creatives-review.js:PATCH /:id/review] Updating creative status in DB", { creativeId: req.params.id, status });
    await docRef.update({
      status,
      reviewFeedback: feedback || "",
      reviewedAt: new Date(),
      updatedAt: new Date(),
    });

    // Audit log for creative review
    const session = res.locals.shopify.session;
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    const merchantId = merchantSnap.empty ? session.shop : merchantSnap.docs[0].id;

    await auditLog({
      actorType: "merchant",
      actorId: merchantId,
      action: status === "approved" ? "creative.approve" : "creative.reject",
      resourceType: "creative",
      resourceId: req.params.id,
      changes: { status, feedback: feedback || "" },
    });

    // Notify advertiser of creative review result
    const creativeData = doc.data();
    if (creativeData.advertiserId) {
      createNotification({
        recipientType: "advertiser",
        recipientId: creativeData.advertiserId,
        type: status === "approved" ? "creative_approved" : "creative_rejected",
        title: status === "approved" ? "Creative Approved" : "Creative Rejected",
        message: status === "approved"
          ? `Your creative "${creativeData.name}" has been approved.`
          : `Your creative "${creativeData.name}" was rejected.`,
        metadata: {
          creativeId: req.params.id,
          creativeName: creativeData.name,
          feedback: feedback || "",
        },
      }).catch((err) => console.error("Creative review notification error:", err.message));
    }

    // Trigger context analysis for approved creatives (fire-and-forget)
    if (status === "approved") {
      const creativeData = doc.data();
      analyzeCreativeContext({ id: req.params.id, ...creativeData }).catch(err =>
        console.error("Creative context analysis error:", err.message)
      );
    }

    console.log("[creatives-review.js:PATCH /:id/review] Creative review complete (200)", { creativeId: req.params.id, status });
    res.json({ success: true, status });
  } catch (err) {
    console.error("[creatives-review.js:PATCH /:id/review] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /batch-review — Batch approve/reject multiple creatives
router.post("/batch-review", async (req, res) => {
  const { creativeIds, status, feedback } = req.body;
  console.log("[creatives-review.js:POST /batch-review] Batch review request", { count: creativeIds?.length, status, feedback });

  if (!Array.isArray(creativeIds) || creativeIds.length === 0) {
    return res.status(400).json({ error: "creativeIds must be a non-empty array" });
  }
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Status must be 'approved' or 'rejected'" });
  }

  try {
    const session = res.locals.shopify.session;
    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    const merchantId = merchantSnap.empty ? session.shop : merchantSnap.docs[0].id;

    let processed = 0;
    let failed = 0;
    const errors = [];

    for (const creativeId of creativeIds) {
      try {
        const docRef = db.collection("creatives").doc(creativeId);
        const doc = await docRef.get();
        if (!doc.exists) {
          failed++;
          errors.push({ creativeId, error: "Not found" });
          continue;
        }

        await docRef.update({
          status,
          reviewFeedback: feedback || "",
          reviewedAt: new Date(),
          updatedAt: new Date(),
        });

        // Audit log for each creative
        await auditLog({
          actorType: "merchant",
          actorId: merchantId,
          action: status === "approved" ? "creative.approve" : "creative.reject",
          resourceType: "creative",
          resourceId: creativeId,
          changes: { status, feedback: feedback || "", batchReview: true },
        });

        // Notify advertiser
        const creativeData = doc.data();
        if (creativeData.advertiserId) {
          createNotification({
            recipientType: "advertiser",
            recipientId: creativeData.advertiserId,
            type: status === "approved" ? "creative_approved" : "creative_rejected",
            title: status === "approved" ? "Creative Approved" : "Creative Rejected",
            message: status === "approved"
              ? `Your creative "${creativeData.name}" has been approved.`
              : `Your creative "${creativeData.name}" was rejected.`,
            metadata: {
              creativeId,
              creativeName: creativeData.name,
              feedback: feedback || "",
            },
          }).catch((err) => console.error("Batch review notification error:", err.message));
        }

        // Trigger context analysis for approved creatives
        if (status === "approved") {
          analyzeCreativeContext({ id: creativeId, ...creativeData }).catch(err =>
            console.error("Batch creative context analysis error:", err.message)
          );
        }

        processed++;
      } catch (err) {
        failed++;
        errors.push({ creativeId, error: err.message });
        console.error("[creatives-review.js:POST /batch-review] Error processing creative", { creativeId, error: err.message });
      }
    }

    console.log("[creatives-review.js:POST /batch-review] Batch review complete (200)", { processed, failed });
    res.json({ processed, failed, errors });
  } catch (err) {
    console.error("[creatives-review.js:POST /batch-review] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /history — Review history for this merchant
router.get("/history", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[creatives-review.js:GET /history] Review history request", { shop: session.shop });

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    // Find campaigns targeting this merchant
    const campaignSnap = await db
      .collection("campaigns")
      .where("merchantId", "==", merchantId)
      .get();
    const campaignIds = campaignSnap.docs.map((d) => d.id);

    if (campaignIds.length === 0) return res.json({ history: [] });

    const batchIds = campaignIds.slice(0, 30);

    // Get approved creatives
    const approvedSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "approved")
      .orderBy("reviewedAt", "desc")
      .limit(50)
      .get();

    // Get rejected creatives
    const rejectedSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "rejected")
      .orderBy("reviewedAt", "desc")
      .limit(50)
      .get();

    const history = [
      ...approvedSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name,
          type: data.type,
          status: data.status,
          reviewedAt: data.reviewedAt,
          feedback: data.reviewFeedback || "",
          advertiserId: data.advertiserId,
          imageUrl: data.imageUrl || data.thumbnailUrl || null,
        };
      }),
      ...rejectedSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: data.name,
          type: data.type,
          status: data.status,
          reviewedAt: data.reviewedAt,
          feedback: data.reviewFeedback || "",
          advertiserId: data.advertiserId,
          imageUrl: data.imageUrl || data.thumbnailUrl || null,
        };
      }),
    ];

    // Sort by reviewedAt descending
    history.sort((a, b) => {
      const aTime = a.reviewedAt?.toDate ? a.reviewedAt.toDate() : new Date(a.reviewedAt || 0);
      const bTime = b.reviewedAt?.toDate ? b.reviewedAt.toDate() : new Date(b.reviewedAt || 0);
      return bTime - aTime;
    });

    console.log("[creatives-review.js:GET /history] Returning review history (200)", { count: history.length, merchantId });
    res.json({ history: history.slice(0, 50) });
  } catch (err) {
    console.error("[creatives-review.js:GET /history] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /stats — Review statistics for this merchant
router.get("/stats", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    console.log("[creatives-review.js:GET /stats] Review stats request", { shop: session.shop });

    const merchantSnap = await db
      .collection("merchants")
      .where("shopifyShopId", "==", session.shop)
      .limit(1)
      .get();
    if (merchantSnap.empty)
      return res.status(404).json({ error: "Merchant not found" });
    const merchantId = merchantSnap.docs[0].id;

    // Find campaigns targeting this merchant
    const campaignSnap = await db
      .collection("campaigns")
      .where("merchantId", "==", merchantId)
      .get();
    const campaignIds = campaignSnap.docs.map((d) => d.id);

    if (campaignIds.length === 0) {
      return res.json({ pending: 0, approvedToday: 0, rejectedToday: 0, avgReviewTimeMinutes: 0 });
    }

    const batchIds = campaignIds.slice(0, 30);

    // Count pending
    const pendingSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "pending_review")
      .get();
    const pending = pendingSnap.size;

    // Get today's date boundaries
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Get recently reviewed creatives (approved + rejected) for today counts and avg time
    const approvedSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "approved")
      .where("reviewedAt", ">=", todayStart)
      .where("reviewedAt", "<=", todayEnd)
      .get();

    const rejectedSnap = await db
      .collection("creatives")
      .where("campaignId", "in", batchIds)
      .where("status", "==", "rejected")
      .where("reviewedAt", ">=", todayStart)
      .where("reviewedAt", "<=", todayEnd)
      .get();

    const approvedToday = approvedSnap.size;
    const rejectedToday = rejectedSnap.size;

    // Calculate average review time from all reviewed today
    const allReviewedDocs = [...approvedSnap.docs, ...rejectedSnap.docs];
    let totalReviewTimeMs = 0;
    let reviewedCount = 0;

    for (const doc of allReviewedDocs) {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || 0);
      const reviewedAt = data.reviewedAt?.toDate ? data.reviewedAt.toDate() : new Date(data.reviewedAt || 0);
      const diffMs = reviewedAt - createdAt;
      if (diffMs > 0) {
        totalReviewTimeMs += diffMs;
        reviewedCount++;
      }
    }

    const avgReviewTimeMinutes = reviewedCount > 0
      ? Math.round(totalReviewTimeMs / reviewedCount / 60000)
      : 0;

    console.log("[creatives-review.js:GET /stats] Returning review stats (200)", { pending, approvedToday, rejectedToday, avgReviewTimeMinutes });
    res.json({ pending, approvedToday, rejectedToday, avgReviewTimeMinutes });
  } catch (err) {
    console.error("[creatives-review.js:GET /stats] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
