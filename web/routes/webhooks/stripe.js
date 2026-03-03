import { Router } from "express";
import Stripe from "stripe";
import { handlePaymentSuccess } from "../../services/wallet.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// This route must use express.raw() for body parsing — handled at mount time in index.js
router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  console.log("[stripe.js:POST /] Stripe webhook received", { hasSignature: !!sig });
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    console.log("[stripe.js:POST /] Webhook event verified", { eventType: event.type, eventId: event.id });
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    console.log("[stripe.js:POST /] Processing checkout.session.completed", { sessionId: event.data?.object?.id });
    try {
      await handlePaymentSuccess(event);
      console.log("[stripe.js:POST /] Payment success handled successfully");
    } catch (err) {
      console.error("Error handling payment success:", err);
    }
  } else {
    console.log("[stripe.js:POST /] Unhandled event type, acknowledging", { eventType: event.type });
  }

  console.log("[stripe.js:POST /] Returning webhook acknowledgement (200)");
  res.json({ received: true });
});

export default router;
