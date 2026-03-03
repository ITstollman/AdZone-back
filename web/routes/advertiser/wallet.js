import { Router } from "express";
import { createDepositSession, getWalletInfo } from "../../services/wallet.js";
import { auditLog } from "../../middleware/audit-log.js";

const router = Router();

// GET / — get wallet balance + recent transactions
router.get("/", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    console.log("[wallet.js:GET /] Get wallet balance request", { advertiserId });
    const info = await getWalletInfo(advertiserId);
    console.log("[wallet.js:GET /] Returning wallet info (200)", { advertiserId, balance: info.balance });
    res.json(info);
  } catch (err) {
    console.error("Error fetching wallet info:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /deposit — create Stripe Checkout session
router.post("/deposit", async (req, res) => {
  const { amount } = req.body; // amount in cents
  console.log("[wallet.js:POST /deposit] Create deposit request", { amount, advertiserId: req.advertiser?.advertiserId });
  if (!amount || amount < 500) {
    console.log("[wallet.js:POST /deposit] Amount below minimum, returning 400", { amount });
    return res.status(400).json({ error: "Minimum deposit is $5.00 (500 cents)" });
  }

  try {
    const { advertiserId } = req.advertiser;
    const host = process.env.HOST || "http://localhost:3000";
    const result = await createDepositSession(
      advertiserId,
      amount,
      `${host}/advertiser/wallet?success=true`,
      `${host}/advertiser/wallet?canceled=true`
    );

    await auditLog({
      actorType: "advertiser",
      actorId: advertiserId,
      action: "wallet.deposit_initiated",
      resourceType: "wallet",
      resourceId: advertiserId,
      changes: { amountCents: amount, stripeSessionId: result.sessionId },
    });

    console.log("[wallet.js:POST /deposit] Deposit session created successfully", { advertiserId, amount, sessionId: result.sessionId });
    res.json(result);
  } catch (err) {
    console.error("Error creating deposit session:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /transactions — paginated transaction history
router.get("/transactions", async (req, res) => {
  try {
    const { advertiserId } = req.advertiser;
    console.log("[wallet.js:GET /transactions] Get transactions request", { advertiserId });
    const info = await getWalletInfo(advertiserId);
    console.log("[wallet.js:GET /transactions] Returning transactions (200)", { advertiserId, count: info.transactions?.length });
    res.json({ transactions: info.transactions });
  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
