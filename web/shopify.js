import { shopifyApp } from "@shopify/shopify-app-express";
import { LATEST_API_VERSION } from "@shopify/shopify-api";
import { FirestoreSessionStorage } from "./session-storage/firestore.js";

console.log("[shopify:init] >>> Configuring Shopify app...");
console.log("[shopify:init] API version: %s", LATEST_API_VERSION);
console.log("[shopify:init] Scopes: %s", process.env.SCOPES || "(not set)");
console.log("[shopify:init] Host: %s", process.env.HOST || "(not set)");
console.log("[shopify:init] Host scheme: %s", process.env.NODE_ENV === "production" ? "https" : "http");
console.log("[shopify:init] Is embedded app: false");
console.log("[shopify:init] Auth path: /api/auth");
console.log("[shopify:init] Auth callback path: /api/auth/callback");
console.log("[shopify:init] Webhooks path: /api/webhooks");
console.log("[shopify:init] Session storage: FirestoreSessionStorage");
console.log("[shopify:init] NODE_ENV: %s", process.env.NODE_ENV || "(not set)");

const shopify = shopifyApp({
  api: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SCOPES?.split(","),
    hostScheme: process.env.NODE_ENV === "production" ? "https" : "http",
    hostName: process.env.HOST?.replace(/https?:\/\//, ""),
    isEmbeddedApp: false,
    apiVersion: LATEST_API_VERSION,
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage: new FirestoreSessionStorage(),
});

console.log("[shopify:init] <<< Shopify app configured successfully");

export default shopify;
