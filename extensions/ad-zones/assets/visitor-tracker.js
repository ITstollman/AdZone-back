(function() {
  console.log("[visitor-tracker:INIT] Visitor tracker script starting");

  var FLUSH_INTERVAL = 5000; // 5 seconds
  var MAX_BATCH = 50;
  var queue = [];
  var merchantId = ""; // Will be set from meta tag or config

  // Generate or retrieve visitor ID
  function getVisitorId() {
    var vid = localStorage.getItem("adzone_vid");
    if (!vid) {
      vid = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
      localStorage.setItem("adzone_vid", vid);
      console.log("[visitor-tracker:getVisitorId] Generated NEW visitor ID:", vid);
    } else {
      console.log("[visitor-tracker:getVisitorId] Found EXISTING visitor ID:", vid);
    }
    return vid;
  }

  // Get merchant ID from meta tag or Shopify shop domain
  function getMerchantId() {
    // Try meta tag first
    var meta = document.querySelector('meta[name="adzone-merchant-id"]');
    if (meta) {
      console.log("[visitor-tracker:getMerchantId] Found merchant ID from meta tag:", meta.content);
      return meta.content;
    }
    // Fallback to shop domain
    var fallback = (window.Shopify && window.Shopify.shop) || document.location.hostname;
    console.log("[visitor-tracker:getMerchantId] Using fallback merchant ID:", fallback);
    return fallback;
  }

  // Queue an event
  function trackEvent(type, data) {
    queue.push({ type: type, data: data || {}, timestamp: new Date().toISOString() });
    console.log("[visitor-tracker:trackEvent] Queued event type:", type, "queueSize:", queue.length, "data:", JSON.stringify(data || {}));
    if (queue.length >= MAX_BATCH) {
      console.log("[visitor-tracker:trackEvent] Queue reached MAX_BATCH (" + MAX_BATCH + "), triggering flush");
      flush();
    }
  }

  // Flush events to server
  function flush() {
    if (queue.length === 0) {
      console.log("[visitor-tracker:flush] Queue empty, nothing to flush");
      return;
    }
    var events = queue.splice(0, MAX_BATCH);
    console.log("[visitor-tracker:flush] Flushing", events.length, "events, remaining in queue:", queue.length);
    var payload = JSON.stringify({
      visitorId: getVisitorId(),
      merchantId: merchantId,
      events: events
    });

    // Use sendBeacon for reliable delivery
    if (navigator.sendBeacon) {
      var sent = navigator.sendBeacon("/apps/ads/events/batch", new Blob([payload], { type: "application/json" }));
      console.log("[visitor-tracker:flush] sendBeacon result:", sent, "eventCount:", events.length);
      if (!sent) {
        console.log("[visitor-tracker:flush] sendBeacon FAILED, events may be lost. eventCount:", events.length);
      }
    } else {
      // Fallback to fetch
      console.log("[visitor-tracker:flush] Using fetch fallback, eventCount:", events.length);
      fetch("/apps/ads/events/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).then(function(resp) {
        console.log("[visitor-tracker:flush] Fetch response status:", resp.status, "eventCount:", events.length);
      })["catch"](function(err) {
        console.log("[visitor-tracker:flush] Fetch FAILED:", err.message || err, "eventCount:", events.length);
      });
    }
  }

  // Auto-track page views
  function trackPageView() {
    var data = {
      url: window.location.pathname,
      title: document.title,
      referrer: document.referrer
    };
    console.log("[visitor-tracker:trackPageView] Tracking page_view — url:", data.url, "referrer:", data.referrer || "(none)");
    trackEvent("page_view", data);
  }

  // Auto-track product views (Shopify product pages)
  function trackProductView() {
    if (window.location.pathname.indexOf("/products/") !== 0) {
      console.log("[visitor-tracker:trackProductView] Not a product page, skipping. path:", window.location.pathname);
      return;
    }
    // Try to get product data from Shopify's meta
    var productMeta = document.querySelector("[data-product-id]");
    var parts = window.location.pathname.split("/products/");
    var handle = parts[1] ? parts[1].split("?")[0] : "";
    var data = {
      url: window.location.pathname,
      handle: handle
    };
    if (productMeta) data.productId = productMeta.getAttribute("data-product-id");
    console.log("[visitor-tracker:trackProductView] Tracking product_view — handle:", handle, "productId:", data.productId || "(not found in DOM)");
    trackEvent("product_view", data);
    // Phase 1A: update retargeting list for product viewers
    console.log("[visitor-tracker:trackProductView] Updating retargeting list: product_viewers, handle:", handle);
    updateRetargetingList("product_viewers", { id: handle, data: { url: window.location.pathname } });
  }

  // Auto-track collection views
  function trackCollectionView() {
    if (window.location.pathname.indexOf("/collections/") !== 0) {
      console.log("[visitor-tracker:trackCollectionView] Not a collection page, skipping. path:", window.location.pathname);
      return;
    }
    var parts = window.location.pathname.split("/collections/");
    var handle = parts[1] ? parts[1].split("?")[0] : "";
    console.log("[visitor-tracker:trackCollectionView] Tracking collection_view — handle:", handle);
    trackEvent("collection_view", {
      url: window.location.pathname,
      handle: handle
    });
  }

  // Track cart additions (listen for Shopify AJAX cart API)
  function hookCartAjax() {
    var origFetch = window.fetch;
    if (!origFetch) {
      console.log("[visitor-tracker:hookCartAjax] window.fetch not available, cannot hook cart API");
      return;
    }
    console.log("[visitor-tracker:hookCartAjax] Hooking window.fetch to intercept /cart/add requests");
    window.fetch = function(url, opts) {
      var result = origFetch.apply(this, arguments);
      if (typeof url === "string" && url.indexOf("/cart/add") !== -1 && opts && opts.method && opts.method.toUpperCase() === "POST") {
        console.log("[visitor-tracker:hookCartAjax] Intercepted /cart/add POST request");
        result.then(function(resp) {
          return resp.clone().json();
        }).then(function(data) {
          var productId = data.product_id;
          var value = Math.round(parseFloat(data.price) * 100); // cents
          console.log("[visitor-tracker:hookCartAjax] Cart add detected — productId:", productId, "variantId:", data.variant_id, "quantity:", data.quantity, "value:", value, "cents");
          trackEvent("cart_add", {
            productId: productId,
            variantId: data.variant_id,
            quantity: data.quantity,
            value: value
          });
          // Phase 1A: update retargeting list for cart adders
          console.log("[visitor-tracker:hookCartAjax] Updating retargeting list: cart_adders, productId:", productId);
          updateRetargetingList("cart_adders", { id: String(productId), data: { value: value } });
        })["catch"](function(err) {
          console.log("[visitor-tracker:hookCartAjax] Error processing cart_add response:", err.message || err);
        });
      }
      return result;
    };
  }

  // Track search queries
  function trackSearch() {
    var params = new URLSearchParams(window.location.search);
    var query = params.get("q") || params.get("query");
    if (query && window.location.pathname.indexOf("/search") !== -1) {
      console.log("[visitor-tracker:trackSearch] Tracking search — query:", query);
      trackEvent("search", { query: query });
    } else {
      console.log("[visitor-tracker:trackSearch] Not a search page or no query param. path:", window.location.pathname);
    }
  }

  // ============================================================
  // RETARGETING LIST STORAGE (Phase 1A)
  // ============================================================

  function updateRetargetingList(listType, entry) {
    var RETARGET_KEY = "adzone_rt_" + listType;
    var MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
    var MAX_ITEMS = 50;
    try {
      var raw = localStorage.getItem(RETARGET_KEY);
      var items = raw ? JSON.parse(raw) : [];
      var now = Date.now();
      var beforeFilter = items.length;
      items = items.filter(function(i) { return (now - i.ts) <= MAX_AGE; });
      if (items.length !== beforeFilter) {
        console.log("[visitor-tracker:updateRetargetingList] Pruned", beforeFilter - items.length, "expired items from", listType);
      }
      var exists = -1;
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === entry.id) { exists = j; break; }
      }
      if (exists >= 0) {
        items[exists].ts = now;
        items[exists].count = (items[exists].count || 1) + 1;
        console.log("[visitor-tracker:updateRetargetingList] Updated existing entry in", listType, "— id:", entry.id, "newCount:", items[exists].count);
      } else {
        items.push({ id: entry.id, ts: now, count: 1, data: entry.data || {} });
        console.log("[visitor-tracker:updateRetargetingList] Added new entry to", listType, "— id:", entry.id);
      }
      items = items.slice(-MAX_ITEMS);
      localStorage.setItem(RETARGET_KEY, JSON.stringify(items));
      console.log("[visitor-tracker:updateRetargetingList] List", listType, "now has", items.length, "items");
    } catch(e) {
      console.log("[visitor-tracker:updateRetargetingList] ERROR updating", listType, ":", e.message);
    }
  }

  function getRetargetingLists() {
    var lists = {};
    var types = ["product_viewers", "cart_adders", "cart_abandoners", "purchasers"];
    for (var i = 0; i < types.length; i++) {
      try {
        var raw = localStorage.getItem("adzone_rt_" + types[i]);
        lists[types[i]] = raw ? JSON.parse(raw) : [];
      } catch(e) {
        lists[types[i]] = [];
      }
    }
    var summary = [];
    for (var k in lists) {
      if (lists.hasOwnProperty(k)) {
        summary.push(k + ":" + lists[k].length);
      }
    }
    console.log("[visitor-tracker:getRetargetingLists] Retargeting lists retrieved:", summary.join(", "));
    return lists;
  }

  function detectCartAbandonment() {
    var cartItems = getRetargetingLists().cart_adders;
    if (cartItems.length === 0) {
      console.log("[visitor-tracker:detectCartAbandonment] No cart items, skipping abandonment check");
      return;
    }
    var now = Date.now();
    var ABANDON_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    var abandonedCount = 0;
    for (var i = 0; i < cartItems.length; i++) {
      if ((now - cartItems[i].ts) > ABANDON_THRESHOLD) {
        console.log("[visitor-tracker:detectCartAbandonment] Cart item abandoned — id:", cartItems[i].id, "minutesSinceAdd:", Math.round((now - cartItems[i].ts) / 60000));
        updateRetargetingList("cart_abandoners", { id: cartItems[i].id, data: cartItems[i].data });
        abandonedCount++;
      }
    }
    console.log("[visitor-tracker:detectCartAbandonment] Checked", cartItems.length, "cart items,", abandonedCount, "marked as abandoned (threshold:", ABANDON_THRESHOLD / 60000, "min)");
  }

  // Expose retargeting lists globally for ad-loader.js
  window.__adzoneGetRetargetingLists = getRetargetingLists;

  // Initialize
  function init() {
    console.log("[visitor-tracker:init] Initializing visitor tracker");
    merchantId = getMerchantId();
    console.log("[visitor-tracker:init] merchantId:", merchantId, "visitorId:", getVisitorId());
    trackPageView();
    trackProductView();
    trackCollectionView();
    trackSearch();
    hookCartAjax();
    detectCartAbandonment();

    // Periodic flush
    console.log("[visitor-tracker:init] Setting up periodic flush every", FLUSH_INTERVAL, "ms");
    setInterval(flush, FLUSH_INTERVAL);

    // Flush on unload
    window.addEventListener("beforeunload", function() {
      console.log("[visitor-tracker:beforeunload] Page unloading, flushing remaining events. queueSize:", queue.length);
      flush();
    });

    // For SPA-like navigation (Shopify sections)
    document.addEventListener("shopify:section:load", function() {
      console.log("[visitor-tracker:shopify:section:load] Shopify section loaded, tracking new page_view");
      trackPageView();
    });

    console.log("[visitor-tracker:init] Initialization complete");
  }

  // Start when DOM is ready
  console.log("[visitor-tracker:INIT] Document readyState:", document.readyState);
  if (document.readyState === "loading") {
    console.log("[visitor-tracker:INIT] DOM not ready, deferring init to DOMContentLoaded");
    document.addEventListener("DOMContentLoaded", init);
  } else {
    console.log("[visitor-tracker:INIT] DOM already ready, calling init immediately");
    init();
  }
})();
