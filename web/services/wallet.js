import Stripe from "stripe";
import { db } from "../firebase.js";
import { InsufficientFundsError } from "../utils/errors.js";
import { FieldValue } from "firebase-admin/firestore";
import { createNotification } from "./notification.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Get or create a Stripe customer ID for the given advertiser.
 */
async function getOrCreateStripeCustomer(advertiserId) {
  console.log("[wallet.js:getOrCreateStripeCustomer] Getting/creating Stripe customer", { advertiserId });
  const advertiserRef = db.collection("advertisers").doc(advertiserId);
  const advertiserDoc = await advertiserRef.get();

  if (!advertiserDoc.exists) {
    console.log("[wallet.js:getOrCreateStripeCustomer] Advertiser not found", { advertiserId });
    throw new Error("Advertiser not found");
  }

  const data = advertiserDoc.data();

  if (data.stripeCustomerId) {
    console.log("[wallet.js:getOrCreateStripeCustomer] Existing Stripe customer found", { advertiserId, stripeCustomerId: data.stripeCustomerId });
    return data.stripeCustomerId;
  }

  // Create a new Stripe customer
  console.log("[wallet.js:getOrCreateStripeCustomer] Creating new Stripe customer", { advertiserId, email: data.email });
  const customer = await stripe.customers.create({
    metadata: { advertiserId },
    email: data.email || undefined,
    name: data.name || data.companyName || undefined,
  });

  await advertiserRef.update({ stripeCustomerId: customer.id });
  console.log("[wallet.js:getOrCreateStripeCustomer] Stripe customer created", { advertiserId, stripeCustomerId: customer.id });

  return customer.id;
}

/**
 * Create a Stripe Checkout session for depositing funds into the wallet.
 */
export async function createDepositSession(advertiserId, amountCents, successUrl, cancelUrl) {
  console.log("[wallet.js:createDepositSession] Creating deposit session", { advertiserId, amountCents });
  const customerId = await getOrCreateStripeCustomer(advertiserId);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "AdZone Wallet Deposit",
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      },
    ],
    metadata: {
      advertiserId,
      type: "wallet_deposit",
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  console.log("[wallet.js:createDepositSession] Deposit session created", { advertiserId, sessionId: session.id, amountCents });
  return { sessionId: session.id, url: session.url };
}

/**
 * Handle a successful payment from a Stripe webhook event.
 * Uses the Stripe session ID for idempotency.
 */
export async function handlePaymentSuccess(stripeEvent) {
  const session = stripeEvent.data.object;
  const { advertiserId } = session.metadata;
  const amountCents = session.amount_total;
  console.log("[wallet.js:handlePaymentSuccess] Processing payment success", { advertiserId, amountCents, sessionId: session.id });

  if (!advertiserId) {
    console.warn("Stripe session missing advertiserId in metadata, skipping.");
    console.log("[wallet.js:handlePaymentSuccess] Missing advertiserId in metadata, skipping");
    return null;
  }

  // Idempotency check — see if we already processed this session
  const existingTx = await db
    .collection("wallet_transactions")
    .where("stripeSessionId", "==", session.id)
    .limit(1)
    .get();

  if (!existingTx.empty) {
    console.log(`Transaction for session ${session.id} already exists, skipping.`);
    console.log("[wallet.js:handlePaymentSuccess] Idempotency check: already processed", { sessionId: session.id });
    return { id: existingTx.docs[0].id, ...existingTx.docs[0].data() };
  }

  // Run a Firestore transaction to atomically update the balance
  console.log("[wallet.js:handlePaymentSuccess] Running Firestore transaction to add balance", { advertiserId, amountCents });
  const advertiserRef = db.collection("advertisers").doc(advertiserId);

  const txDoc = await db.runTransaction(async (t) => {
    const advertiserDoc = await t.get(advertiserRef);
    const currentBalance = advertiserDoc.exists
      ? advertiserDoc.data().balance || 0
      : 0;
    const newBalance = currentBalance + amountCents;

    console.log("[wallet.js:handlePaymentSuccess] Balance update in transaction", { advertiserId, currentBalance, amountCents, newBalance });

    // Update advertiser balance
    if (advertiserDoc.exists) {
      t.update(advertiserRef, { balance: newBalance });
    } else {
      t.set(advertiserRef, { balance: newBalance });
    }

    // Create wallet transaction record
    const txRef = db.collection("wallet_transactions").doc();
    const txData = {
      advertiserId,
      type: "deposit",
      amount: amountCents,
      balance: newBalance,
      stripeSessionId: session.id,
      createdAt: FieldValue.serverTimestamp(),
    };
    t.set(txRef, txData);

    return { id: txRef.id, ...txData, newBalance };
  });

  console.log("[wallet.js:handlePaymentSuccess] Payment processed successfully", { advertiserId, newBalance: txDoc.newBalance, amountCents });

  // Notify advertiser of successful payment
  createNotification({
    recipientType: "advertiser",
    recipientId: advertiserId,
    type: "payment_received",
    title: "Payment Received",
    message: `Your deposit of $${(amountCents / 100).toFixed(2)} has been processed.`,
    metadata: { amount: amountCents, balance: txDoc.newBalance },
  }).catch((err) => console.error("Payment notification error:", err.message));

  return txDoc;
}

/**
 * Deduct balance when an impression is served or other charge occurs.
 * Throws InsufficientFundsError if the advertiser doesn't have enough balance.
 */
export async function deductBalance(advertiserId, amountCents, metadata = {}) {
  console.log("[wallet.js:deductBalance] Deducting balance", { advertiserId, amountCents, metadata });
  const advertiserRef = db.collection("advertisers").doc(advertiserId);

  const result = await db.runTransaction(async (t) => {
    const advertiserDoc = await t.get(advertiserRef);

    if (!advertiserDoc.exists) {
      console.log("[wallet.js:deductBalance] Advertiser not found - insufficient funds", { advertiserId });
      throw new InsufficientFundsError("Advertiser not found");
    }

    const currentBalance = advertiserDoc.data().balance || 0;

    if (currentBalance < amountCents) {
      console.log("[wallet.js:deductBalance] INSUFFICIENT FUNDS", { advertiserId, currentBalance, requestedAmount: amountCents, shortfall: amountCents - currentBalance });
      throw new InsufficientFundsError("Insufficient balance");
    }

    const newBalance = currentBalance - amountCents;
    console.log("[wallet.js:deductBalance] Balance deduction in transaction", { advertiserId, currentBalance, amountCents, newBalance });

    t.update(advertiserRef, { balance: newBalance });

    const txRef = db.collection("wallet_transactions").doc();
    const txData = {
      advertiserId,
      type: "deduction",
      amount: -amountCents,
      balance: newBalance,
      metadata,
      createdAt: FieldValue.serverTimestamp(),
    };
    t.set(txRef, txData);

    return { balance: newBalance };
  });

  console.log("[wallet.js:deductBalance] Deduction successful", { advertiserId, newBalance: result.balance, amountDeducted: amountCents });

  // Low balance warning (< $5.00) — deduped by checking for existing unread alert
  if (result.balance < 500 && result.balance > 0) {
    console.log("[wallet.js:deductBalance] Low balance warning triggered", { advertiserId, balance: result.balance });
    (async () => {
      try {
        const existing = await db.collection("notifications")
          .where("recipientType", "==", "advertiser")
          .where("recipientId", "==", advertiserId)
          .where("type", "==", "low_balance")
          .where("read", "==", false)
          .limit(1).get();
        if (existing.empty) {
          console.log("[wallet.js:deductBalance] Sending low balance notification", { advertiserId, balance: result.balance });
          await createNotification({
            recipientType: "advertiser",
            recipientId: advertiserId,
            type: "low_balance",
            title: "Low Balance Warning",
            message: `Your balance is $${(result.balance / 100).toFixed(2)}. Deposit funds to keep campaigns running.`,
            metadata: { balance: result.balance },
          });
        } else {
          console.log("[wallet.js:deductBalance] Low balance notification already exists, skipping", { advertiserId });
        }
      } catch (err) {
        console.error("Low balance notification error:", err.message);
      }
    })();
  }

  return result;
}

/**
 * Check if an advertiser has sufficient balance for an estimated CPM.
 */
export async function hasSufficientBalance(advertiserId, estimatedCpm) {
  console.log("[wallet.js:hasSufficientBalance] Checking balance sufficiency", { advertiserId, estimatedCpm });
  const advertiserDoc = await db.collection("advertisers").doc(advertiserId).get();
  if (!advertiserDoc.exists) {
    console.log("[wallet.js:hasSufficientBalance] Advertiser not found, returning false", { advertiserId });
    return false;
  }
  const balance = advertiserDoc.data().balance || 0;
  const sufficient = balance >= estimatedCpm;
  console.log("[wallet.js:hasSufficientBalance] Balance check result", { advertiserId, balance, estimatedCpm, sufficient });
  return sufficient;
}

/**
 * Get wallet info: current balance + recent transactions.
 */
export async function getWalletInfo(advertiserId) {
  console.log("[wallet.js:getWalletInfo] Getting wallet info", { advertiserId });
  const advertiserDoc = await db.collection("advertisers").doc(advertiserId).get();
  const balance = advertiserDoc.exists ? (advertiserDoc.data().balance || 0) : 0;

  const txSnap = await db
    .collection("wallet_transactions")
    .where("advertiserId", "==", advertiserId)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  const transactions = txSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log("[wallet.js:getWalletInfo] Wallet info retrieved", { advertiserId, balance, transactionCount: transactions.length });

  return { balance, transactions };
}
