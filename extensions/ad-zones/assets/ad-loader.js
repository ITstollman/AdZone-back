(function () {
  "use strict";

  console.log("[ad-loader:INIT] Ad loader script starting");

  var PROXY_BASE = "/apps/ads";
  var IMPRESSION_THRESHOLD = 1000; // 1 second in viewport = viewable impression
  var trackedImpressions = {};

  // ============================================================
  // VISITOR ID MANAGEMENT
  // ============================================================

  function getVisitorId() {
    var vid = null;
    try {
      vid = localStorage.getItem("adzone_vid");
    } catch (e) {
      console.log("[ad-loader:getVisitorId] localStorage error", e.message);
    }
    if (!vid) {
      var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      var random = "";
      for (var i = 0; i < 9; i++) {
        random += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      vid = "v_" + Date.now() + "_" + random;
      console.log("[ad-loader:getVisitorId] Generated NEW visitor ID:", vid);
      try {
        localStorage.setItem("adzone_vid", vid);
      } catch (e) {}
    } else {
      console.log("[ad-loader:getVisitorId] Found EXISTING visitor ID:", vid);
    }
    return vid;
  }

  // ============================================================
  // FREQUENCY TRACKING
  // ============================================================

  var FREQUENCY_TTL = 24 * 60 * 60 * 1000;

  function getFrequencyData() {
    var raw = null;
    var stored = {};
    try {
      raw = localStorage.getItem("adzone_freq");
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      stored = {};
    }

    var now = Date.now();
    var counts = {};
    var cleaned = {};
    var hasExpired = false;

    for (var key in stored) {
      if (stored.hasOwnProperty(key)) {
        var entry = stored[key];
        if (typeof entry === "number") {
          hasExpired = true;
          continue;
        }
        if (entry && typeof entry.t === "number" && now - entry.t <= FREQUENCY_TTL) {
          counts[key] = entry.c || 0;
          cleaned[key] = entry;
        } else {
          hasExpired = true;
        }
      }
    }

    if (hasExpired) {
      console.log("[ad-loader:getFrequencyData] Cleaned expired frequency entries");
      try {
        localStorage.setItem("adzone_freq", JSON.stringify(cleaned));
      } catch (e) {}
    }

    console.log("[ad-loader:getFrequencyData] Frequency counts:", JSON.stringify(counts));
    return counts;
  }

  function incrementFrequency(campaignId) {
    if (!campaignId) return;
    var raw = null;
    var stored = {};
    try {
      raw = localStorage.getItem("adzone_freq");
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      stored = {};
    }

    var now = Date.now();
    var entry = stored[campaignId];

    if (entry && typeof entry === "object" && typeof entry.t === "number" && now - entry.t <= FREQUENCY_TTL) {
      entry.c = (entry.c || 0) + 1;
      entry.t = now;
    } else {
      entry = { c: 1, t: now };
    }

    console.log("[ad-loader:incrementFrequency] Campaign:", campaignId, "newCount:", entry.c);

    stored[campaignId] = entry;
    try {
      localStorage.setItem("adzone_freq", JSON.stringify(stored));
    } catch (e) {}
  }

  var visitorId = getVisitorId();

  // ============================================================
  // SHARED HELPERS
  // ============================================================

  function buildClickUrl(ad) {
    var url = PROXY_BASE +
      "/click?id=" + encodeURIComponent(ad.adId) +
      "&bid=" + encodeURIComponent(ad.bidId) +
      "&dest=" + encodeURIComponent(ad.destinationUrl) +
      "&campaign=" + encodeURIComponent(ad.campaignId || "") +
      "&advertiser=" + encodeURIComponent(ad.advertiserId || "");
    // Append billing token for CPC click billing verification
    if (ad.billingToken) {
      url += "&bt=" + encodeURIComponent(ad.billingToken);
    }
    console.log("[ad-loader:buildClickUrl] adId:", ad.adId, "dest:", ad.destinationUrl, "billingToken:", ad.billingToken ? "present" : "missing");
    return url;
  }

  // ============================================================
  // CLICK & VIEW ATTRIBUTION STORAGE
  // ============================================================

  function storeClickAttribution(ad) {
    console.log("[ad-loader:storeClickAttribution] Storing click for adId:", ad.adId, "campaignId:", ad.campaignId, "advertiserId:", ad.advertiserId);
    try {
      var raw = localStorage.getItem("adzone_clicks");
      var clicks = raw ? JSON.parse(raw) : [];
      var now = Date.now();
      // Prune old entries (> 7 days)
      var beforePrune = clicks.length;
      clicks = clicks.filter(function(c) { return (now - c.ts) <= 7 * 24 * 60 * 60 * 1000; });
      if (clicks.length !== beforePrune) {
        console.log("[ad-loader:storeClickAttribution] Pruned expired clicks:", beforePrune - clicks.length);
      }
      clicks.push({
        campaignId: ad.campaignId,
        adId: ad.adId,
        advertiserId: ad.advertiserId,
        ts: now,
      });
      localStorage.setItem("adzone_clicks", JSON.stringify(clicks));
      console.log("[ad-loader:storeClickAttribution] Total stored clicks:", clicks.length);
    } catch(e) {
      console.log("[ad-loader:storeClickAttribution] ERROR:", e.message);
    }
  }

  function storeViewAttribution(ad) {
    console.log("[ad-loader:storeViewAttribution] Storing view for adId:", ad.adId, "campaignId:", ad.campaignId);
    try {
      var raw = localStorage.getItem("adzone_views");
      var views = raw ? JSON.parse(raw) : [];
      var now = Date.now();
      var beforePrune = views.length;
      views = views.filter(function(v) { return (now - v.ts) <= 24 * 60 * 60 * 1000; });
      if (views.length !== beforePrune) {
        console.log("[ad-loader:storeViewAttribution] Pruned expired views:", beforePrune - views.length);
      }
      views.push({
        campaignId: ad.campaignId,
        adId: ad.adId,
        advertiserId: ad.advertiserId,
        ts: now,
      });
      localStorage.setItem("adzone_views", JSON.stringify(views));
      console.log("[ad-loader:storeViewAttribution] Total stored views:", views.length);
    } catch(e) {
      console.log("[ad-loader:storeViewAttribution] ERROR:", e.message);
    }
  }

  // ============================================================
  // GOOGLE ANALYTICS 4 INTEGRATION
  // ============================================================

  var ga4Initialized = false;

  function initGA4(measurementId) {
    if (!measurementId || ga4Initialized) return;
    ga4Initialized = true;
    console.log("[ad-loader:initGA4] Initializing GA4 with measurementId:", measurementId);

    // Store for conversion-tracker.js to use
    try { localStorage.setItem("adzone_ga4_id", measurementId); } catch(e) {}

    // If gtag already exists (merchant has GA4), just configure our measurement ID
    if (typeof window.gtag === "function") {
      console.log("[ad-loader:initGA4] gtag already exists, configuring measurement ID");
      window.gtag("config", measurementId, { send_page_view: false });
      return;
    }

    console.log("[ad-loader:initGA4] Loading gtag.js script");
    // Load gtag.js
    window.dataLayer = window.dataLayer || [];
    window.gtag = function() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", measurementId, { send_page_view: false });

    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
    document.head.appendChild(s);
  }

  function fireGA4Event(eventName, params) {
    if (typeof window.gtag !== "function") return;
    console.log("[ad-loader:fireGA4Event] Firing GA4 event:", eventName, "adId:", params.ad_id);
    window.gtag("event", eventName, params);
  }

  // ============================================================
  // RETARGETING DATA HELPER (Phase 1B)
  // ============================================================

  function getRetargetingParam() {
    var rtLists = null;
    try {
      if (typeof window.__adzoneGetRetargetingLists === "function") {
        rtLists = window.__adzoneGetRetargetingLists();
      }
    } catch (e) {
      console.log("[ad-loader:getRetargetingParam] Error getting retargeting lists:", e.message);
    }
    if (!rtLists) {
      console.log("[ad-loader:getRetargetingParam] No retargeting data available");
      return "";
    }
    // Only include list types that have items to keep URL reasonable
    var filtered = {};
    var hasData = false;
    for (var key in rtLists) {
      if (rtLists.hasOwnProperty(key) && Array.isArray(rtLists[key]) && rtLists[key].length > 0) {
        filtered[key] = rtLists[key];
        hasData = true;
      }
    }
    if (!hasData) {
      console.log("[ad-loader:getRetargetingParam] Retargeting lists are all empty");
      return "";
    }
    try {
      var result = JSON.stringify(filtered);
      var listSummary = [];
      for (var k in filtered) {
        if (filtered.hasOwnProperty(k)) {
          listSummary.push(k + ":" + filtered[k].length);
        }
      }
      console.log("[ad-loader:getRetargetingParam] Retargeting data included:", listSummary.join(", "));
      return result;
    } catch (e) {
      console.log("[ad-loader:getRetargetingParam] JSON stringify error:", e.message);
      return "";
    }
  }

  function buildServeUrl(slug, page, extraParams) {
    var url = PROXY_BASE + "/serve?" +
      "zone=" + encodeURIComponent(slug) +
      "&page=" + encodeURIComponent(page || window.location.pathname) +
      "&vid=" + encodeURIComponent(visitorId) +
      "&freq=" + encodeURIComponent(JSON.stringify(getFrequencyData())) +
      "&pageUrl=" + encodeURIComponent(window.location.pathname);

    // Phase 1B: append retargeting data
    var rtData = getRetargetingParam();
    if (rtData) {
      url += "&rt=" + encodeURIComponent(rtData);
    }

    if (extraParams) {
      for (var k in extraParams) {
        if (extraParams.hasOwnProperty(k)) {
          url += "&" + k + "=" + encodeURIComponent(extraParams[k]);
        }
      }
    }
    console.log("[ad-loader:buildServeUrl] slug:", slug, "page:", page || window.location.pathname, "hasRetargeting:", !!rtData, "extraParams:", extraParams ? JSON.stringify(extraParams) : "none");
    return url;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ============================================================
  // INIT — DISPATCH BY TYPE
  // ============================================================

  function initAdZones() {
    trackedImpressions = {};
    var zones = document.querySelectorAll("[data-adzone-slug]");
    console.log("[ad-loader:initAdZones] Found", zones.length, "ad zone(s) on page");
    for (var i = 0; i < zones.length; i++) {
      var type = zones[i].getAttribute("data-adzone-type");
      var slug = zones[i].getAttribute("data-adzone-slug");
      console.log("[ad-loader:initAdZones] Zone #" + i + " slug:", slug, "type:", type);
      if (type === "carousel" || type === "product_grid") {
        loadMultipleAds(zones[i]);
      } else if (type === "sticky") {
        initStickyBanner(zones[i]);
      } else {
        loadAd(zones[i]);
      }
    }
  }

  window.__adzoneInit = initAdZones;

  // ============================================================
  // SINGLE-AD LOADING (banner, promoted_product, native_feed)
  // ============================================================

  function loadAd(container) {
    var slug = container.getAttribute("data-adzone-slug");
    if (!slug) {
      console.log("[ad-loader:loadAd] No slug found on container, skipping");
      return;
    }

    var page = container.getAttribute("data-adzone-page");
    var url = buildServeUrl(slug, page);

    console.log("[ad-loader:loadAd] Fetching single ad for slug:", slug);

    fetch(url)
      .then(function (response) {
        console.log("[ad-loader:loadAd] Response status:", response.status, "slug:", slug);
        if (!response.ok || response.status === 204) {
          console.log("[ad-loader:loadAd] No ad available (status " + response.status + ") for slug:", slug);
          container.style.display = "none";
          return null;
        }
        return response.json();
      })
      .then(function (ad) {
        if (!ad || !ad.adId) {
          console.log("[ad-loader:loadAd] Empty or invalid ad data for slug:", slug);
          container.style.display = "none";
          return;
        }
        console.log("[ad-loader:loadAd] Ad received — adId:", ad.adId, "creativeType:", ad.creativeType, "campaignId:", ad.campaignId, "billingToken:", ad.billingToken ? "present" : "missing");
        renderAd(container, ad);
        observeImpression(container, ad);
      })
      .catch(function (err) {
        console.log("[ad-loader:loadAd] FETCH ERROR for slug:", slug, "error:", err.message || err);
        container.style.display = "none";
      });
  }

  // ============================================================
  // MULTI-AD LOADING (carousel, product_grid)
  // ============================================================

  function loadMultipleAds(container) {
    var slug = container.getAttribute("data-adzone-slug");
    if (!slug) {
      console.log("[ad-loader:loadMultipleAds] No slug found on container, skipping");
      return;
    }

    var page = container.getAttribute("data-adzone-page");
    var count = parseInt(container.getAttribute("data-adzone-count")) || 3;
    var url = buildServeUrl(slug, page, { count: count });

    console.log("[ad-loader:loadMultipleAds] Fetching", count, "ads for slug:", slug);

    fetch(url)
      .then(function (response) {
        console.log("[ad-loader:loadMultipleAds] Response status:", response.status, "slug:", slug);
        if (!response.ok || response.status === 204) {
          console.log("[ad-loader:loadMultipleAds] No ads available (status " + response.status + ") for slug:", slug);
          container.style.display = "none";
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data) { container.style.display = "none"; return; }

        var ads = Array.isArray(data) ? data : [data];
        ads = ads.filter(function (ad) { return ad && ad.adId; });

        console.log("[ad-loader:loadMultipleAds] Received", ads.length, "valid ads for slug:", slug);

        if (ads.length === 0) {
          console.log("[ad-loader:loadMultipleAds] No valid ads after filtering for slug:", slug);
          container.style.display = "none";
          return;
        }

        var type = container.getAttribute("data-adzone-type");
        if (type === "carousel") {
          console.log("[ad-loader:loadMultipleAds] Rendering carousel with", ads.length, "slides");
          renderCarousel(container, ads);
        } else if (type === "product_grid") {
          console.log("[ad-loader:loadMultipleAds] Rendering product grid with", ads.length, "items");
          renderProductGrid(container, ads);
        }
      })
      .catch(function (err) {
        console.log("[ad-loader:loadMultipleAds] FETCH ERROR for slug:", slug, "error:", err.message || err);
        container.style.display = "none";
      });
  }

  // ============================================================
  // RENDER DISPATCH
  // ============================================================

  function renderAd(container, ad) {
    container.innerHTML = "";
    var type = container.getAttribute("data-adzone-type");

    if (type === "native_feed") {
      console.log("[ad-loader:renderAd] Dispatching to native_feed renderer, adId:", ad.adId);
      renderNativeFeedAd(container, ad);
    } else if (ad.creativeType === "banner_image") {
      console.log("[ad-loader:renderAd] Dispatching to banner renderer, adId:", ad.adId, "imageUrl:", ad.imageUrl);
      renderBannerAd(container, ad);
    } else if (ad.creativeType === "promoted_product" && ad.productData) {
      console.log("[ad-loader:renderAd] Dispatching to promoted_product renderer, adId:", ad.adId, "productTitle:", ad.productData.title);
      renderPromotedProduct(container, ad);
    } else {
      console.log("[ad-loader:renderAd] No matching renderer for type:", type, "creativeType:", ad.creativeType, "hasProductData:", !!ad.productData);
    }
  }

  // ============================================================
  // BANNER AD RENDERER (enhanced)
  // ============================================================

  function renderBannerAd(container, ad) {
    console.log("[ad-loader:renderBannerAd] Rendering banner — adId:", ad.adId, "imageUrl:", ad.imageUrl, "altText:", ad.altText);
    var link = document.createElement("a");
    link.href = buildClickUrl(ad);
    link.className = "adzone-banner__link";
    // Store click attribution before navigation
    link.addEventListener("click", function () {
      console.log("[ad-loader:renderBannerAd] CLICK on banner adId:", ad.adId, "campaignId:", ad.campaignId, "dest:", ad.destinationUrl);
      storeClickAttribution(ad);
      fireGA4Event("ad_click", {
        ad_id: ad.adId,
        campaign_id: ad.campaignId,
        destination_url: ad.destinationUrl,
        ad_creative_name: ad.creativeName || ad.adId,
      });
    });

    var img = document.createElement("img");
    img.src = ad.imageUrl;
    img.alt = ad.altText || "Advertisement";
    img.loading = "lazy";
    img.className = "adzone-banner__image";
    img.style.width = "100%";
    img.style.height = "auto";
    img.style.display = "block";
    img.style.opacity = "0";

    // Fade in on load
    img.onload = function () {
      console.log("[ad-loader:renderBannerAd] Image loaded successfully for adId:", ad.adId);
      img.style.opacity = "1";
      container.classList.add("adzone-banner--loaded");
    };
    img.onerror = function () {
      console.log("[ad-loader:renderBannerAd] IMAGE LOAD ERROR for adId:", ad.adId, "imageUrl:", ad.imageUrl);
      container.style.display = "none";
    };

    link.appendChild(img);
    container.appendChild(link);

    // Sponsored label
    var label = document.createElement("span");
    label.textContent = "Sponsored";
    label.className = "adzone-label";
    container.appendChild(label);
  }

  // ============================================================
  // PROMOTED PRODUCT RENDERER (enhanced)
  // ============================================================

  function renderPromotedProduct(container, ad) {
    var product = ad.productData;
    var layout = container.getAttribute("data-adzone-layout") || "card";
    var showPrice = container.getAttribute("data-adzone-show-price") !== "false";
    var showCta = container.getAttribute("data-adzone-show-cta") !== "false";
    var ctaText = container.getAttribute("data-adzone-cta-text") || "Shop Now";

    console.log("[ad-loader:renderPromotedProduct] Rendering product — adId:", ad.adId, "title:", product.title, "price:", product.price, "layout:", layout, "hasCompareAt:", !!product.compareAtPrice);

    var clickUrl = buildClickUrl(ad);

    var card = document.createElement("a");
    card.href = clickUrl;
    card.className = "adzone-product-card adzone-product-card--" + layout;
    card.style.textDecoration = "none";
    card.style.color = "inherit";
    // Store click attribution before navigation
    card.addEventListener("click", function () {
      console.log("[ad-loader:renderPromotedProduct] CLICK on product adId:", ad.adId, "campaignId:", ad.campaignId, "product:", product.title);
      storeClickAttribution(ad);
      fireGA4Event("ad_click", {
        ad_id: ad.adId,
        campaign_id: ad.campaignId,
        destination_url: ad.destinationUrl,
        ad_creative_name: ad.creativeName || ad.adId,
      });
    });

    var html = "";
    html += '<div class="adzone-product-card__image-wrap">';
    if (product.compareAtPrice) {
      html += '<span class="adzone-product-card__sale-badge">Sale</span>';
    }
    html += '<img src="' + escapeHtml(product.imageUrl) + '" alt="' + escapeHtml(product.title) + '" loading="lazy" />';
    html += "</div>";
    html += '<div class="adzone-product-card__info">';
    html += '<span class="adzone-label">Sponsored</span>';
    html += '<h4 class="adzone-product-card__title">' + escapeHtml(product.title) + "</h4>";
    if (showPrice) {
      html += '<div class="adzone-product-card__price">';
      if (product.compareAtPrice) {
        html += "<s>" + escapeHtml(product.compareAtPrice) + "</s> ";
      }
      html += escapeHtml(product.price);
      html += "</div>";
    }
    if (showCta) {
      html += '<span class="adzone-product-card__cta">' + escapeHtml(ctaText) + "</span>";
    }
    html += "</div>";

    card.innerHTML = html;
    container.appendChild(card);
  }

  // ============================================================
  // CAROUSEL RENDERER
  // ============================================================

  function renderCarousel(container, ads) {
    container.innerHTML = "";

    var transition = container.getAttribute("data-adzone-transition") || "slide";
    var showDots = container.getAttribute("data-adzone-show-dots") !== "false";
    var showArrows = container.getAttribute("data-adzone-show-arrows") !== "false";
    var autoPlay = container.getAttribute("data-adzone-autoplay") !== "false";
    var interval = parseInt(container.getAttribute("data-adzone-interval")) || 5;

    console.log("[ad-loader:renderCarousel] Rendering carousel — slideCount:", ads.length, "transition:", transition, "autoPlay:", autoPlay, "interval:", interval + "s");

    var currentIndex = 0;
    var slideCount = ads.length;
    var timer = null;
    var carouselInView = false;
    var slideTimers = {};

    // Track
    var track = document.createElement("div");
    track.className = "adzone-carousel__track adzone-carousel__track--" + transition;
    if (transition === "slide") {
      track.style.display = "flex";
      track.style.transition = "transform 0.4s ease-in-out";
      track.style.width = "100%";
    }

    // Create slides
    for (var i = 0; i < ads.length; i++) {
      var slide = document.createElement("div");
      slide.className = "adzone-carousel__slide" + (i === 0 ? " adzone-carousel__slide--active" : "");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", "Slide " + (i + 1) + " of " + slideCount);
      if (i !== 0) slide.setAttribute("aria-hidden", "true");

      var slideLink = document.createElement("a");
      slideLink.href = buildClickUrl(ads[i]);
      slideLink.className = "adzone-carousel__slide-link";

      var slideImg = document.createElement("img");
      slideImg.src = ads[i].imageUrl;
      slideImg.alt = ads[i].altText || "Advertisement";
      slideImg.loading = i === 0 ? "eager" : "lazy";
      slideImg.className = "adzone-carousel__slide-image";

      slideLink.appendChild(slideImg);
      slide.appendChild(slideLink);

      // Sponsored label on each slide
      var slideLabel = document.createElement("span");
      slideLabel.textContent = "Sponsored";
      slideLabel.className = "adzone-label";
      slide.appendChild(slideLabel);

      track.appendChild(slide);
    }

    container.appendChild(track);

    // Dots
    var dotsContainer = null;
    if (showDots && slideCount > 1) {
      dotsContainer = document.createElement("div");
      dotsContainer.className = "adzone-carousel__dots";
      dotsContainer.setAttribute("role", "tablist");
      for (var d = 0; d < slideCount; d++) {
        var dot = document.createElement("button");
        dot.className = "adzone-carousel__dot" + (d === 0 ? " adzone-carousel__dot--active" : "");
        dot.setAttribute("role", "tab");
        dot.setAttribute("aria-label", "Go to slide " + (d + 1));
        dot.setAttribute("data-index", d);
        dot.addEventListener("click", (function (idx) {
          return function () { goToSlide(idx); };
        })(d));
        dotsContainer.appendChild(dot);
      }
      container.appendChild(dotsContainer);
    }

    // Arrows
    if (showArrows && slideCount > 1) {
      var prevBtn = document.createElement("button");
      prevBtn.className = "adzone-carousel__arrow adzone-carousel__arrow--prev";
      prevBtn.setAttribute("aria-label", "Previous slide");
      prevBtn.innerHTML = "&#8249;";
      prevBtn.addEventListener("click", function () {
        goToSlide((currentIndex - 1 + slideCount) % slideCount);
      });
      container.appendChild(prevBtn);

      var nextBtn = document.createElement("button");
      nextBtn.className = "adzone-carousel__arrow adzone-carousel__arrow--next";
      nextBtn.setAttribute("aria-label", "Next slide");
      nextBtn.innerHTML = "&#8250;";
      nextBtn.addEventListener("click", function () {
        goToSlide((currentIndex + 1) % slideCount);
      });
      container.appendChild(nextBtn);
    }

    // goToSlide
    function goToSlide(index) {
      console.log("[ad-loader:renderCarousel:goToSlide] Navigating to slide", index, "adId:", ads[index].adId);
      currentIndex = index;
      var slides = track.children;

      if (transition === "slide") {
        track.style.transform = "translateX(-" + (index * 100) + "%)";
      }

      for (var s = 0; s < slides.length; s++) {
        if (transition === "fade") {
          slides[s].classList.toggle("adzone-carousel__slide--active", s === index);
        }
        slides[s].setAttribute("aria-hidden", s !== index ? "true" : "false");
      }

      // Update dots
      if (dotsContainer) {
        var dots = dotsContainer.children;
        for (var dd = 0; dd < dots.length; dd++) {
          dots[dd].classList.toggle("adzone-carousel__dot--active", dd === index);
        }
      }

      // Carousel impression tracking per-slide
      clearSlideImpressionTimer();
      if (carouselInView) {
        startSlideImpressionTimer(index);
      }
    }

    // Carousel impression tracking
    function startSlideImpressionTimer(index) {
      var ad = ads[index];
      var key = ad.adId + "|carousel|" + window.location.pathname;
      if (trackedImpressions[key]) {
        console.log("[ad-loader:renderCarousel:startSlideImpressionTimer] Already tracked impression for slide", index, "adId:", ad.adId);
        return;
      }

      console.log("[ad-loader:renderCarousel:startSlideImpressionTimer] Starting impression timer for slide", index, "adId:", ad.adId);
      slideTimers[index] = setTimeout(function () {
        trackedImpressions[key] = true;
        console.log("[ad-loader:renderCarousel:startSlideImpressionTimer] Impression threshold met for slide", index, "adId:", ad.adId);
        sendImpression(ad);
      }, IMPRESSION_THRESHOLD);
    }

    function clearSlideImpressionTimer() {
      for (var k in slideTimers) {
        clearTimeout(slideTimers[k]);
        delete slideTimers[k];
      }
    }

    // Outer IntersectionObserver to know if carousel is in viewport
    if ("IntersectionObserver" in window) {
      var carouselObserver = new IntersectionObserver(function (entries) {
        carouselInView = entries[0].isIntersecting;
        console.log("[ad-loader:renderCarousel] Carousel viewport visibility:", carouselInView);
        if (carouselInView) {
          startSlideImpressionTimer(currentIndex);
        } else {
          clearSlideImpressionTimer();
        }
      }, { threshold: 0.5 });
      carouselObserver.observe(container);
    } else {
      console.log("[ad-loader:renderCarousel] IntersectionObserver not available, sending immediate impression");
      carouselInView = true;
      sendImpression(ads[0]);
    }

    // Auto-play timer
    function startTimer() {
      if (!autoPlay || slideCount <= 1) return;
      timer = setInterval(function () {
        goToSlide((currentIndex + 1) % slideCount);
      }, interval * 1000);
    }

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    // Pause on hover
    container.addEventListener("mouseenter", stopTimer);
    container.addEventListener("mouseleave", startTimer);

    // Touch/swipe
    var touchStartX = 0;
    container.addEventListener("touchstart", function (e) {
      touchStartX = e.changedTouches[0].screenX;
      stopTimer();
    }, { passive: true });
    container.addEventListener("touchend", function (e) {
      var touchEndX = e.changedTouches[0].screenX;
      var diff = touchStartX - touchEndX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) { goToSlide(Math.min(currentIndex + 1, slideCount - 1)); }
        else { goToSlide(Math.max(currentIndex - 1, 0)); }
      }
      startTimer();
    }, { passive: true });

    // Keyboard navigation
    container.setAttribute("tabindex", "0");
    container.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { goToSlide(Math.max(currentIndex - 1, 0)); e.preventDefault(); }
      if (e.key === "ArrowRight") { goToSlide(Math.min(currentIndex + 1, slideCount - 1)); e.preventDefault(); }
    });

    // Start
    goToSlide(0);
    startTimer();
  }

  // ============================================================
  // STICKY BANNER
  // ============================================================

  function initStickyBanner(container) {
    var slug = container.getAttribute("data-adzone-slug");
    var position = container.getAttribute("data-adzone-position") || "bottom";
    var showClose = container.getAttribute("data-adzone-show-close") !== "false";
    var autoDismiss = parseInt(container.getAttribute("data-adzone-auto-dismiss")) || 0;
    var scrollTrigger = parseInt(container.getAttribute("data-adzone-scroll-trigger")) || 300;

    if (!slug) return;

    console.log("[ad-loader:initStickyBanner] Initializing sticky banner — slug:", slug, "position:", position, "scrollTrigger:", scrollTrigger, "autoDismiss:", autoDismiss);

    // Check localStorage dismiss persistence (24hr)
    var dismissKey = "adzone_sticky_dismissed_" + slug;
    try {
      var dismissed = localStorage.getItem(dismissKey);
      if (dismissed) {
        var dismissedAt = parseInt(dismissed);
        var hoursElapsed = (Date.now() - dismissedAt) / (1000 * 60 * 60);
        if (hoursElapsed < 24) {
          console.log("[ad-loader:initStickyBanner] Sticky banner dismissed", Math.round(hoursElapsed) + "h ago, skipping (slug:", slug + ")");
          return;
        }
        console.log("[ad-loader:initStickyBanner] Previous dismissal expired (", Math.round(hoursElapsed) + "h ago), re-showing");
      }
    } catch (e) {}

    // Fetch ad
    var page = container.getAttribute("data-adzone-page");
    var url = buildServeUrl(slug, page);

    console.log("[ad-loader:initStickyBanner] Fetching sticky ad for slug:", slug);

    fetch(url)
      .then(function (response) {
        console.log("[ad-loader:initStickyBanner] Response status:", response.status, "slug:", slug);
        if (!response.ok || response.status === 204) {
          console.log("[ad-loader:initStickyBanner] No sticky ad available (status " + response.status + ") for slug:", slug);
          return null;
        }
        return response.json();
      })
      .then(function (ad) {
        if (!ad || !ad.adId) {
          console.log("[ad-loader:initStickyBanner] Empty or invalid sticky ad data for slug:", slug);
          return;
        }

        console.log("[ad-loader:initStickyBanner] Sticky ad received — adId:", ad.adId, "campaignId:", ad.campaignId, "imageUrl:", ad.imageUrl);

        // Build sticky DOM
        container.innerHTML = "";
        container.className = "adzone-sticky adzone-sticky--" + position;

        // Inner content wrapper
        var inner = document.createElement("div");
        inner.className = "adzone-sticky__inner";

        var link = document.createElement("a");
        link.href = buildClickUrl(ad);
        link.className = "adzone-sticky__link";

        var img = document.createElement("img");
        img.src = ad.imageUrl;
        img.alt = ad.altText || "Advertisement";
        img.className = "adzone-sticky__image";

        link.appendChild(img);
        inner.appendChild(link);

        // Sponsored label
        var label = document.createElement("span");
        label.textContent = "Sponsored";
        label.className = "adzone-label";
        inner.appendChild(label);

        container.appendChild(inner);

        // Close button
        if (showClose) {
          var closeBtn = document.createElement("button");
          closeBtn.className = "adzone-sticky__close";
          closeBtn.setAttribute("aria-label", "Close advertisement");
          closeBtn.innerHTML = "\u00D7";
          closeBtn.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            console.log("[ad-loader:initStickyBanner] Close button clicked — dismissing sticky adId:", ad.adId, "slug:", slug);
            container.classList.add("adzone-sticky--dismissed");
            try { localStorage.setItem(dismissKey, String(Date.now())); } catch (ex) {}
            setTimeout(function () { container.style.display = "none"; }, 300);
          });
          container.appendChild(closeBtn);
        }

        // Scroll trigger: show after scroll threshold
        var shown = false;
        function checkScroll() {
          if (shown) return;
          if (window.scrollY >= scrollTrigger) {
            shown = true;
            console.log("[ad-loader:initStickyBanner] Scroll trigger reached (" + scrollTrigger + "px), showing sticky adId:", ad.adId);
            container.style.display = "";
            // Trigger reflow then add visible class for animation
            container.offsetHeight; // force reflow
            container.classList.add("adzone-sticky--visible");
            observeImpression(container, ad);
            window.removeEventListener("scroll", checkScroll);
          }
        }
        window.addEventListener("scroll", checkScroll, { passive: true });
        checkScroll();

        // Auto-dismiss
        if (autoDismiss > 0) {
          console.log("[ad-loader:initStickyBanner] Auto-dismiss set for", autoDismiss, "seconds");
          setTimeout(function () {
            console.log("[ad-loader:initStickyBanner] Auto-dismissing sticky adId:", ad.adId);
            container.classList.add("adzone-sticky--dismissed");
            setTimeout(function () { container.style.display = "none"; }, 300);
          }, autoDismiss * 1000);
        }
      })
      .catch(function (err) {
        console.log("[ad-loader:initStickyBanner] FETCH ERROR for slug:", slug, "error:", err.message || err);
      });
  }

  // ============================================================
  // NATIVE FEED AD RENDERER
  // ============================================================

  function renderNativeFeedAd(container, ad) {
    if (!ad.productData) {
      console.log("[ad-loader:renderNativeFeedAd] No productData, hiding container for adId:", ad.adId);
      container.style.display = "none";
      return;
    }
    var product = ad.productData;
    var showAddToCart = container.getAttribute("data-adzone-show-add-to-cart") === "true";
    var showSponsored = container.getAttribute("data-adzone-show-sponsored") !== "false";

    console.log("[ad-loader:renderNativeFeedAd] Rendering native feed ad — adId:", ad.adId, "product:", product.title, "price:", product.price, "showAddToCart:", showAddToCart);

    container.style.display = "";
    container.innerHTML = "";

    var clickUrl = buildClickUrl(ad);

    var card = document.createElement("a");
    card.href = clickUrl;
    card.className = "adzone-native-card";

    var html = "";
    html += '<div class="adzone-native-card__media">';
    html += '<img src="' + escapeHtml(product.imageUrl) + '" alt="' + escapeHtml(product.title) + '" loading="lazy" />';
    if (showSponsored) {
      html += '<span class="adzone-native-card__badge">Sponsored</span>';
    }
    html += "</div>";
    html += '<div class="adzone-native-card__content">';
    html += '<h3 class="adzone-native-card__title">' + escapeHtml(product.title) + "</h3>";
    html += '<div class="adzone-native-card__price">';
    if (product.compareAtPrice) {
      html += '<span class="adzone-native-card__compare-price">' + escapeHtml(product.compareAtPrice) + "</span>";
    }
    html += '<span class="adzone-native-card__current-price">' + escapeHtml(product.price) + "</span>";
    html += "</div>";
    if (showAddToCart) {
      html += '<span class="adzone-native-card__cta">Add to Cart</span>';
    }
    html += "</div>";

    card.innerHTML = html;
    container.appendChild(card);
  }

  // ============================================================
  // PRODUCT GRID RENDERER
  // ============================================================

  function renderProductGrid(container, ads) {
    container.innerHTML = "";

    var columns = parseInt(container.getAttribute("data-adzone-columns")) || 4;
    var showPrice = container.getAttribute("data-adzone-show-price") !== "false";
    var showSponsored = container.getAttribute("data-adzone-show-sponsored") !== "false";
    var title = container.getAttribute("data-adzone-section-title") || "Sponsored Products";

    console.log("[ad-loader:renderProductGrid] Rendering grid — adCount:", ads.length, "columns:", columns, "title:", title);

    // Section title
    var heading = document.createElement("h2");
    heading.className = "adzone-product-grid__title";
    heading.textContent = title;
    container.appendChild(heading);

    // Grid
    var grid = document.createElement("div");
    grid.className = "adzone-product-grid__grid";
    grid.style.setProperty("--adzone-grid-columns", columns);

    for (var i = 0; i < ads.length; i++) {
      var ad = ads[i];
      if (!ad.productData) {
        console.log("[ad-loader:renderProductGrid] Skipping ad at index", i, "— no productData, adId:", ad.adId);
        continue;
      }

      var product = ad.productData;
      var clickUrl = buildClickUrl(ad);

      console.log("[ad-loader:renderProductGrid] Grid item", i, "— adId:", ad.adId, "product:", product.title, "price:", product.price);

      var card = document.createElement("a");
      card.href = clickUrl;
      card.className = "adzone-product-card adzone-product-card--card";
      card.style.textDecoration = "none";
      card.style.color = "inherit";

      var html = "";
      html += '<div class="adzone-product-card__image-wrap">';
      if (product.compareAtPrice) {
        html += '<span class="adzone-product-card__sale-badge">Sale</span>';
      }
      html += '<img src="' + escapeHtml(product.imageUrl) + '" alt="' + escapeHtml(product.title) + '" loading="lazy" />';
      html += "</div>";
      html += '<div class="adzone-product-card__info">';
      if (showSponsored) {
        html += '<span class="adzone-label">Sponsored</span>';
      }
      html += '<h4 class="adzone-product-card__title">' + escapeHtml(product.title) + "</h4>";
      if (showPrice) {
        html += '<div class="adzone-product-card__price">';
        if (product.compareAtPrice) {
          html += "<s>" + escapeHtml(product.compareAtPrice) + "</s> ";
        }
        html += escapeHtml(product.price);
        html += "</div>";
      }
      html += "</div>";

      card.innerHTML = html;
      grid.appendChild(card);

      // Each card gets its own impression observer
      observeImpression(card, ad);
    }

    container.appendChild(grid);
  }

  // ============================================================
  // IMPRESSION TRACKING
  // ============================================================

  function observeImpression(container, ad) {
    var impressionKey = ad.adId + "|" + window.location.pathname;

    if (!("IntersectionObserver" in window)) {
      if (!trackedImpressions[impressionKey]) {
        console.log("[ad-loader:observeImpression] No IntersectionObserver — sending immediate impression for adId:", ad.adId);
        trackedImpressions[impressionKey] = true;
        sendImpression(ad);
      }
      return;
    }

    console.log("[ad-loader:observeImpression] Setting up IntersectionObserver for adId:", ad.adId, "impressionKey:", impressionKey);

    var observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          if (entry.isIntersecting && !trackedImpressions[impressionKey]) {
            console.log("[ad-loader:observeImpression] Ad in viewport, starting impression timer for adId:", ad.adId);
            var observeTimer = setTimeout(function () {
              trackedImpressions[impressionKey] = true;
              console.log("[ad-loader:observeImpression] Impression threshold met (" + IMPRESSION_THRESHOLD + "ms) for adId:", ad.adId);
              sendImpression(ad);
              observer.unobserve(container);
            }, IMPRESSION_THRESHOLD);
            container._adzoneTimer = observeTimer;
          } else if (!entry.isIntersecting && container._adzoneTimer) {
            console.log("[ad-loader:observeImpression] Ad left viewport before threshold, cancelling timer for adId:", ad.adId);
            clearTimeout(container._adzoneTimer);
          }
        }
      },
      { threshold: 0.5 }
    );

    observer.observe(container);
  }

  function sendImpression(ad) {
    console.log("[ad-loader:sendImpression] Sending impression — adId:", ad.adId, "campaignId:", ad.campaignId, "zoneId:", ad.zoneId, "bidId:", ad.bidId, "billingToken:", ad.billingToken ? "present" : "missing", "advertiserId:", ad.advertiserId);

    // Store view attribution for view-through conversion tracking
    storeViewAttribution(ad);

    // Initialize GA4 if merchant has it configured
    if (ad.ga4MeasurementId) {
      initGA4(ad.ga4MeasurementId);
    }

    // Fire GA4 ad_impression event
    fireGA4Event("ad_impression", {
      ad_id: ad.adId,
      campaign_id: ad.campaignId,
      zone_id: ad.zoneId,
      ad_creative_name: ad.creativeName || ad.adId,
    });

    var data = JSON.stringify({
      adId: ad.adId,
      campaignId: ad.campaignId,
      zoneId: ad.zoneId,
      bidId: ad.bidId,
      page: window.location.pathname,
      visitorId: visitorId,
      billingToken: ad.billingToken,
      advertiserId: ad.advertiserId,
      merchantId: ad.merchantId,
    });

    incrementFrequency(ad.campaignId);

    if (navigator.sendBeacon) {
      console.log("[ad-loader:sendImpression] Using sendBeacon for impression delivery, adId:", ad.adId);
      navigator.sendBeacon(
        PROXY_BASE + "/track/impression",
        new Blob([data], { type: "application/json" })
      );
    } else {
      console.log("[ad-loader:sendImpression] Using fetch fallback for impression delivery, adId:", ad.adId);
      fetch(PROXY_BASE + "/track/impression", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: data,
        keepalive: true,
      });
    }
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  console.log("[ad-loader:INIT] Document readyState:", document.readyState, "visitorId:", visitorId);

  if (document.readyState === "loading") {
    console.log("[ad-loader:INIT] DOM not ready, deferring initAdZones to DOMContentLoaded");
    document.addEventListener("DOMContentLoaded", initAdZones);
  } else {
    console.log("[ad-loader:INIT] DOM already ready, calling initAdZones immediately");
    initAdZones();
  }
})();
