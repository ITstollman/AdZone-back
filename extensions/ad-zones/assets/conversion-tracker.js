(function() {
  "use strict";

  console.log("[conversion-tracker:INIT] Conversion tracker script starting");

  var PROXY_BASE = "/apps/ads";
  var CLICK_ATTRIBUTION_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days
  var VIEW_ATTRIBUTION_WINDOW = 24 * 60 * 60 * 1000; // 1 day

  function getVisitorId() {
    try {
      var vid = localStorage.getItem("adzone_vid");
      console.log("[conversion-tracker:getVisitorId] Visitor ID:", vid || "(not found)");
      return vid;
    } catch(e) {
      console.log("[conversion-tracker:getVisitorId] localStorage error:", e.message);
      return null;
    }
  }

  function getClickAttributions() {
    try {
      var raw = localStorage.getItem("adzone_clicks");
      if (!raw) {
        console.log("[conversion-tracker:getClickAttributions] No click attributions found in localStorage");
        return [];
      }
      var clicks = JSON.parse(raw);
      var now = Date.now();
      // Filter to valid attribution window
      var valid = clicks.filter(function(c) {
        return (now - c.ts) <= CLICK_ATTRIBUTION_WINDOW;
      });
      var expired = clicks.length - valid.length;
      console.log("[conversion-tracker:getClickAttributions] Total clicks:", clicks.length, "valid (within 7d window):", valid.length, "expired:", expired);
      if (valid.length > 0) {
        var latest = valid[valid.length - 1];
        var ageMinutes = Math.round((now - latest.ts) / 60000);
        console.log("[conversion-tracker:getClickAttributions] Latest click — campaignId:", latest.campaignId, "adId:", latest.adId, "age:", ageMinutes, "min ago");
      }
      return valid;
    } catch(e) {
      console.log("[conversion-tracker:getClickAttributions] ERROR reading clicks:", e.message);
      return [];
    }
  }

  function getViewAttributions() {
    try {
      var raw = localStorage.getItem("adzone_views");
      if (!raw) {
        console.log("[conversion-tracker:getViewAttributions] No view attributions found in localStorage");
        return [];
      }
      var views = JSON.parse(raw);
      var now = Date.now();
      var valid = views.filter(function(v) {
        return (now - v.ts) <= VIEW_ATTRIBUTION_WINDOW;
      });
      var expired = views.length - valid.length;
      console.log("[conversion-tracker:getViewAttributions] Total views:", views.length, "valid (within 24h window):", valid.length, "expired:", expired);
      if (valid.length > 0) {
        var latest = valid[valid.length - 1];
        var ageMinutes = Math.round((now - latest.ts) / 60000);
        console.log("[conversion-tracker:getViewAttributions] Latest view — campaignId:", latest.campaignId, "adId:", latest.adId, "age:", ageMinutes, "min ago");
      }
      return valid;
    } catch(e) {
      console.log("[conversion-tracker:getViewAttributions] ERROR reading views:", e.message);
      return [];
    }
  }

  // GA4 helper — fire event if gtag is available
  function fireGA4Event(eventName, params) {
    if (typeof window.gtag !== "function") {
      console.log("[conversion-tracker:fireGA4Event] gtag not available, skipping GA4 event:", eventName);
      return;
    }
    console.log("[conversion-tracker:fireGA4Event] Firing GA4 event:", eventName, "campaignId:", params.campaign_id, "value:", params.value);
    window.gtag("event", eventName, params);
  }

  function getGA4Id() {
    try {
      var id = localStorage.getItem("adzone_ga4_id");
      console.log("[conversion-tracker:getGA4Id] GA4 measurement ID:", id || "(not found)");
      return id;
    } catch(e) { return null; }
  }

  function ensureGA4() {
    var measurementId = getGA4Id();
    if (!measurementId || typeof window.gtag === "function") return;
    console.log("[conversion-tracker:ensureGA4] Loading GA4 with measurementId:", measurementId);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", measurementId, { send_page_view: false });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
    document.head.appendChild(s);
  }

  function sendConversion(type, value, currency, orderId) {
    console.log("[conversion-tracker:sendConversion] Starting conversion processing — type:", type, "value:", value, "currency:", currency, "orderId:", orderId);

    var visitorId = getVisitorId();
    var clicks = getClickAttributions();
    var views = getViewAttributions();

    // Prefer click attribution over view attribution (last click wins)
    var attribution = null;
    var attributionType = "none";

    if (clicks.length > 0) {
      // Last click wins
      attribution = clicks[clicks.length - 1];
      attributionType = "click";
      console.log("[conversion-tracker:sendConversion] Attribution: CLICK — campaignId:", attribution.campaignId, "adId:", attribution.adId, "advertiserId:", attribution.advertiserId);
    } else if (views.length > 0) {
      // Last view
      attribution = views[views.length - 1];
      attributionType = "view";
      console.log("[conversion-tracker:sendConversion] Attribution: VIEW-THROUGH — campaignId:", attribution.campaignId, "adId:", attribution.adId, "advertiserId:", attribution.advertiserId);
    }

    if (!attribution) {
      console.log("[conversion-tracker:sendConversion] NO ATTRIBUTION found — no click or view data. Conversion will NOT be sent.");
      return; // No ad interaction to attribute
    }

    console.log("[conversion-tracker:sendConversion] Sending conversion — type:", type, "attributionType:", attributionType, "campaignId:", attribution.campaignId, "adId:", attribution.adId, "value:", value, "currency:", currency, "orderId:", orderId, "visitorId:", visitorId);

    var data = JSON.stringify({
      type: type,
      campaignId: attribution.campaignId,
      adId: attribution.adId,
      advertiserId: attribution.advertiserId,
      value: value || 0,
      currency: currency || "USD",
      orderId: orderId || null,
      visitorId: visitorId,
      attributionType: attributionType,
    });

    if (navigator.sendBeacon) {
      var sent = navigator.sendBeacon(
        PROXY_BASE + "/track/conversion",
        new Blob([data], { type: "application/json" })
      );
      console.log("[conversion-tracker:sendConversion] sendBeacon result:", sent, "type:", type, "orderId:", orderId);
    } else {
      console.log("[conversion-tracker:sendConversion] Using fetch fallback for conversion delivery");
      fetch(PROXY_BASE + "/track/conversion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        keepalive: true,
      });
    }

    // Fire GA4 conversion event
    if (getGA4Id()) {
      ensureGA4();
      console.log("[conversion-tracker:sendConversion] Firing GA4 ad_conversion event");
      fireGA4Event("ad_conversion", {
        campaign_id: attribution.campaignId,
        ad_id: attribution.adId,
        attribution_type: attributionType,
        value: (value || 0) / 100, // GA4 expects dollars, not cents
        currency: currency || "USD",
        transaction_id: orderId || undefined,
      });
    } else {
      console.log("[conversion-tracker:sendConversion] No GA4 measurement ID, skipping GA4 event");
    }
  }

  function checkForConversion() {
    var path = window.location.pathname;

    console.log("[conversion-tracker:checkForConversion] Checking path for conversion page:", path);

    // Shopify thank you page = purchase conversion
    if (path.indexOf("/thank_you") !== -1 || path.indexOf("/thank-you") !== -1) {
      console.log("[conversion-tracker:checkForConversion] THANK YOU PAGE DETECTED — this is a conversion page");

      // Try to get order value from Shopify's checkout object
      var value = 0;
      var currency = "USD";
      var orderId = null;

      if (typeof Shopify !== "undefined" && Shopify.checkout) {
        value = Math.round(parseFloat(Shopify.checkout.total_price || 0) * 100); // cents
        currency = Shopify.checkout.currency || "USD";
        orderId = Shopify.checkout.order_id ? String(Shopify.checkout.order_id) : null;
        console.log("[conversion-tracker:checkForConversion] Shopify.checkout data FOUND — totalPrice:", Shopify.checkout.total_price, "value(cents):", value, "currency:", currency, "orderId:", orderId);
      } else {
        console.log("[conversion-tracker:checkForConversion] Shopify.checkout data MISSING — Shopify defined:", typeof Shopify !== "undefined", "checkout exists:", typeof Shopify !== "undefined" && !!Shopify.checkout);
      }

      sendConversion("purchase", value, currency, orderId);
    } else {
      console.log("[conversion-tracker:checkForConversion] NOT a conversion page — path:", path);
    }
  }

  // Run on page load
  console.log("[conversion-tracker:INIT] Document readyState:", document.readyState);
  if (document.readyState === "loading") {
    console.log("[conversion-tracker:INIT] DOM not ready, deferring checkForConversion to DOMContentLoaded");
    document.addEventListener("DOMContentLoaded", checkForConversion);
  } else {
    console.log("[conversion-tracker:INIT] DOM already ready, calling checkForConversion immediately");
    checkForConversion();
  }

  // Expose for manual conversion tracking
  window.__adzoneConversion = sendConversion;
  console.log("[conversion-tracker:INIT] Manual conversion function exposed as window.__adzoneConversion");
})();
