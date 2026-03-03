import NodeCache from "node-cache";

console.log("[cache:init] Creating NodeCache instance — stdTTL=60s checkperiod=120s useClones=false");

// Default TTL: 60s. Check period: 120s.
export const cache = new NodeCache({
  stdTTL: 60,
  checkperiod: 120,
  useClones: false,
});

// Wrap the cache methods with logging
const _originalGet = cache.get.bind(cache);
const _originalSet = cache.set.bind(cache);
const _originalDel = cache.del.bind(cache);
const _originalFlushAll = cache.flushAll.bind(cache);
const _originalGetStats = cache.getStats.bind(cache);

cache.get = function(key) {
  const value = _originalGet(key);
  if (value !== undefined) {
    console.log("[cache:get] CACHE HIT — key=%s", key);
  } else {
    console.log("[cache:get] CACHE MISS — key=%s", key);
  }
  return value;
};

cache.set = function(key, value, ttl) {
  console.log("[cache:set] Setting cache — key=%s ttl=%s valueType=%s", key, ttl !== undefined ? ttl + "s" : "default(60s)", typeof value);
  return _originalSet(key, value, ttl);
};

cache.del = function(keys) {
  console.log("[cache:del] Deleting from cache — keys=%s", JSON.stringify(keys));
  const result = _originalDel(keys);
  console.log("[cache:del] Deleted count=%d", result);
  return result;
};

cache.flushAll = function() {
  const stats = _originalGetStats();
  console.log("[cache:flushAll] CLEARING ALL CACHE — keysBeforeFlush=%d", stats.keys);
  return _originalFlushAll();
};

cache.getStats = function() {
  const stats = _originalGetStats();
  console.log("[cache:getStats] Cache stats — keys=%d hits=%d misses=%d hitRate=%s%%", stats.keys, stats.hits, stats.misses, stats.hits + stats.misses > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) : "0.0");
  return stats;
};

// Log cache events
cache.on("expired", (key, value) => {
  console.log("[cache:event] Key EXPIRED — key=%s", key);
});

cache.on("del", (key, value) => {
  console.log("[cache:event] Key DELETED — key=%s", key);
});

cache.on("flush", () => {
  console.log("[cache:event] Cache FLUSHED — all keys removed");
});

console.log("[cache:init] NodeCache instance created and instrumented with logging");
