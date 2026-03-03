import { join, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import shopify from "./shopify.js";
import { db } from "./firebase.js";
import { advertiserAuth } from "./middleware/advertiser-auth.js";
import { publicRateLimiter, trackingRateLimiter } from "./middleware/rate-limiter.js";
import { errorHandler } from "./middleware/error-handler.js";
import { initCronJobs } from "./utils/cron.js";

// Route imports — Merchant
import merchantZoneRoutes from "./routes/merchant/zones.js";
import merchantAnalyticsRoutes from "./routes/merchant/analytics.js";
import merchantAdvertiserRoutes from "./routes/merchant/advertisers.js";
import merchantSettingsRoutes from "./routes/merchant/settings.js";
import merchantNotificationRoutes from "./routes/merchant/notifications.js";
import merchantSseRoutes from "./routes/merchant/sse.js";
import merchantSegmentRoutes from "./routes/merchant/segments.js";
import merchantAudienceInsightsRoutes from "./routes/merchant/audience-insights.js";
import merchantRevenueRoutes from "./routes/merchant/revenue.js";
import merchantDashboardRoutes from "./routes/merchant/dashboard.js";
import merchantCreativeReviewRoutes from "./routes/merchant/creatives-review.js";

// Route imports — Advertiser
import advertiserAuthRoutes from "./routes/advertiser/auth.js";
import advertiserCampaignRoutes from "./routes/advertiser/campaigns.js";
import advertiserCreativeRoutes from "./routes/advertiser/creatives.js";
import advertiserBidRoutes from "./routes/advertiser/bids.js";
import advertiserAnalyticsRoutes from "./routes/advertiser/analytics.js";
import advertiserNotificationRoutes from "./routes/advertiser/notifications.js";
import advertiserWalletRoutes from "./routes/advertiser/wallet.js";
import advertiserTargetingRoutes from "./routes/advertiser/targeting.js";
import auctionInsightsRoutes from "./routes/advertiser/auction-insights.js";
import advertiserAudienceRoutes from "./routes/advertiser/audiences.js";
import advertiserSseRoutes from "./routes/advertiser/sse.js";

// Route imports — Webhooks
import stripeWebhookRoutes from "./routes/webhooks/stripe.js";

// Route imports — Public
import adServeRoutes from "./routes/public/ad-serve.js";
import trackRoutes from "./routes/public/track.js";
import redirectRoutes from "./routes/public/redirect.js";
import eventsRoutes from "./routes/public/events.js";

// Route imports — Proxy
import proxyRoutes from "./routes/proxy/storefront.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);

console.log("[index.js] Creating Express app...");
const app = express();

console.log("[index.js] Mounting middleware: cookieParser");
app.use(cookieParser());

// Stripe webhook must be mounted BEFORE express.json() — it needs the raw body
console.log("[index.js] Mounting route: /api/webhooks/stripe (raw body)");
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookRoutes);

console.log("[index.js] Mounting middleware: express.json");
app.use(express.json());

// CORS for public/storefront ad serving
console.log("[index.js] Mounting middleware: CORS for /api/public");
app.use(
  "/api/public",
  cors({
    origin: /\.myshopify\.com$/,
    methods: ["GET", "POST"],
  })
);

// ─── SHOPIFY AUTH ROUTES ───────────────────────────────────
console.log("[index.js] Mounting Shopify auth routes");
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  async (req, res) => {
    // After successful OAuth, create/update merchant record
    const session = res.locals.shopify.session;
    console.log("[index.js:GET auth/callback] OAuth callback received", { shop: session.shop });
    try {
      const merchantSnap = await db
        .collection("merchants")
        .where("shopifyShopId", "==", session.shop)
        .limit(1)
        .get();

      if (merchantSnap.empty) {
        // First install — create merchant record
        console.log("[index.js:GET auth/callback] New merchant install, creating record", { shop: session.shop });
        await db.collection("merchants").add({
          shopifyShopId: session.shop,
          shopifyAccessToken: session.accessToken,
          shopName: session.shop.replace(".myshopify.com", ""),
          shopDomain: session.shop,
          email: "",
          plan: "free",
          currency: "USD",
          timezone: "UTC",
          settings: {
            defaultMinBid: 100, // $1.00 CPM floor
            autoApproveAds: false,
            adRefreshInterval: 30,
            enabledAdTypes: ["banner", "promoted_product"],
          },
          installedAt: new Date(),
          updatedAt: new Date(),
          status: "active",
        });
      } else {
        // Returning merchant — update access token
        console.log("[index.js:GET auth/callback] Returning merchant, updating token", { shop: session.shop });
        await merchantSnap.docs[0].ref.update({
          shopifyAccessToken: session.accessToken,
          updatedAt: new Date(),
          status: "active",
        });
      }
    } catch (err) {
      console.error("Error saving merchant after OAuth:", err);
    }

    res.redirect("/merchant/dashboard");
  }
);

// ─── WEBHOOKS ──────────────────────────────────────────────
app.post(shopify.config.webhooks.path, shopify.processWebhooks({
  webhookHandlers: {
    CUSTOMERS_DATA_REQUEST: {
      callback: async (_topic, shop) => {
        console.log(`Data request from ${shop}`);
      },
    },
    CUSTOMERS_REDACT: {
      callback: async (_topic, shop) => {
        console.log(`Customer redact from ${shop}`);
      },
    },
    SHOP_REDACT: {
      callback: async (_topic, shop) => {
        console.log(`Shop redact from ${shop}`);
      },
    },
  },
}));

// ─── MERCHANT API ROUTES (Shopify session auth) ────────────
console.log("[index.js] Mounting merchant API routes: zones, analytics, advertisers, settings, notifications, segments, audience-insights");
app.use(
  "/api/merchant/zones",
  shopify.validateAuthenticatedSession(),
  merchantZoneRoutes
);
app.use(
  "/api/merchant/analytics",
  shopify.validateAuthenticatedSession(),
  merchantAnalyticsRoutes
);
app.use(
  "/api/merchant/advertisers",
  shopify.validateAuthenticatedSession(),
  merchantAdvertiserRoutes
);
app.use(
  "/api/merchant/settings",
  shopify.validateAuthenticatedSession(),
  merchantSettingsRoutes
);
app.use(
  "/api/merchant/notifications",
  shopify.validateAuthenticatedSession(),
  merchantNotificationRoutes
);
app.use(
  "/api/merchant/segments",
  shopify.validateAuthenticatedSession(),
  merchantSegmentRoutes
);
app.use(
  "/api/merchant/audience-insights",
  shopify.validateAuthenticatedSession(),
  merchantAudienceInsightsRoutes
);
app.use(
  "/api/merchant/sse",
  shopify.validateAuthenticatedSession(),
  merchantSseRoutes
);
app.use(
  "/api/merchant/revenue",
  shopify.validateAuthenticatedSession(),
  merchantRevenueRoutes
);
app.use(
  "/api/merchant/dashboard",
  shopify.validateAuthenticatedSession(),
  merchantDashboardRoutes
);
app.use(
  "/api/merchant/creatives-review",
  shopify.validateAuthenticatedSession(),
  merchantCreativeReviewRoutes
);

// ─── ADVERTISER API ROUTES (JWT auth) ──────────────────────
console.log("[index.js] Mounting advertiser API routes: auth, campaigns, creatives, bids, analytics, notifications, wallet, targeting, audiences, auction-insights");
app.use("/api/advertiser/auth", advertiserAuthRoutes);
app.use("/api/advertiser/campaigns", advertiserAuth, advertiserCampaignRoutes);
app.use("/api/advertiser/creatives", advertiserAuth, advertiserCreativeRoutes);
app.use("/api/advertiser/bids", advertiserAuth, advertiserBidRoutes);
app.use("/api/advertiser/analytics", advertiserAuth, advertiserAnalyticsRoutes);
app.use("/api/advertiser/notifications", advertiserAuth, advertiserNotificationRoutes);
app.use("/api/advertiser/wallet", advertiserAuth, advertiserWalletRoutes);
app.use("/api/advertiser/targeting", advertiserAuth, advertiserTargetingRoutes);
app.use("/api/advertiser/audiences", advertiserAuth, advertiserAudienceRoutes);
app.use("/api/advertiser/auction-insights", advertiserAuth, auctionInsightsRoutes);
app.use("/api/advertiser/sse", advertiserAuth, advertiserSseRoutes);

// ─── PUBLIC API ROUTES (rate-limited, no auth) ─────────────
console.log("[index.js] Mounting public API routes: ads, track, redirect, events");
app.use("/api/public/ads", publicRateLimiter, adServeRoutes);
app.use("/api/public/track", trackingRateLimiter, trackRoutes);
app.use("/api/public/redirect", redirectRoutes);
app.use("/api/public/events", publicRateLimiter, eventsRoutes);

// ─── APP PROXY ROUTES (Shopify storefront proxy) ──────────
console.log("[index.js] Mounting proxy routes: /api/proxy");
app.use("/api/proxy", proxyRoutes);

// ─── ERROR HANDLER (must be after all routes) ───────────────
console.log("[index.js] Mounting error handler middleware");
app.use(errorHandler);

// ─── SERVE REACT FRONTEND ─────────────────────────────────
const frontendDist = join(__dirname, "frontend", "dist");
app.use(express.static(frontendDist));
app.get("*", (req, res) => {
  res.sendFile(join(frontendDist, "index.html"));
});

// ─── CRON JOBS ───────────────────────────────────────────
console.log("[index.js] Initializing cron jobs...");
initCronJobs();

app.listen(PORT, () => {
  console.log(`[index.js] AdZone server running on port ${PORT}`);
  console.log("[index.js] Server startup complete. All routes and middleware mounted.");
});
