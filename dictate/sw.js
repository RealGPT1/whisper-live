/**
 * Service Worker — Whisper Live Dictate PWA
 *
 * Cache strategy:
 *   • App shell (HTML/JS/CSS + CDN assets) → stale-while-revalidate
 *   • jsDelivr CDN (Bootstrap, Transformers.js bundle) → cache-first
 *   • Hugging Face model files (ONNX weights, tokenizers, configs) → cache-first,
 *     stored in a separate persistent cache that survives app-shell updates.
 */

const APP_VERSION = 'v1';
const APP_CACHE   = `dictate-app-${APP_VERSION}`;
// Model cache intentionally has no version suffix so large model files
// survive app updates and are never re-downloaded unnecessarily.
const MODEL_CACHE = 'dictate-models';

// Files to precache during install (app shell + pinned CDN bundles).
// These are the resources needed to render the UI before any network access.
const PRECACHE_URLS = [
  './',
  './app.js',
  './worker.js',
  './audio-processor.js',
  './audio-file-transcriber.js',
  './styles.css',
  './manifest.json',
  './icons/icon-any.svg',
  './icons/icon-maskable.svg',
  // Bootstrap 5.3.2 (exact versions → safe to cache-first forever)
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js',
  // Bootstrap Icons 1.11.1 — CSS + the woff2 font it references
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/fonts/bootstrap-icons.woff2',
];

// ── Install ───────────────────────────────────────────────────────────────────
// Precache the app shell so the UI loads instantly on repeat visits.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] precache failed (some CDN assets may be unavailable offline):', err))
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
// Delete outdated app-shell caches (but never the model cache).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('dictate-app-') && key !== APP_CACHE)
            .map((key) => {
              console.log('[SW] deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle GET — POST/PUT/DELETE bypass the SW completely.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // ① Hugging Face model files — cache-first, persistent.
  //    Covers huggingface.co, *.huggingface.co (CDN shards like
  //    cdn-lfs.huggingface.co), and hf.co short-links.
  if (isModelRequest(url)) {
    event.respondWith(cacheFirst(event.request, MODEL_CACHE));
    return;
  }

  // ② jsDelivr CDN — cache-first (URLs include exact versions so content
  //    is immutable; safe to serve stale indefinitely).
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(event.request, APP_CACHE));
    return;
  }

  // ③ Same-origin app files — stale-while-revalidate so the UI is always
  //    fast while the latest version is fetched in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request, APP_CACHE));
    return;
  }

  // Everything else (e.g. analytics, future APIs) — network only.
});

// ── Message handling ──────────────────────────────────────────────────────────
// Allow the page to query cache stats or request a cache clear.
self.addEventListener('message', async (event) => {
  if (!event.data || !event.data.type) return;

  if (event.data.type === 'GET_CACHE_STATS') {
    const [modelCache, appCache] = await Promise.all([
      cacheSize(MODEL_CACHE),
      cacheSize(APP_CACHE),
    ]);
    event.source?.postMessage({ type: 'CACHE_STATS', modelCache, appCache });
  }

  if (event.data.type === 'CLEAR_MODEL_CACHE') {
    await caches.delete(MODEL_CACHE);
    event.source?.postMessage({ type: 'MODEL_CACHE_CLEARED' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isModelRequest(url) {
  return (
    url.hostname === 'huggingface.co'       ||
    url.hostname.endsWith('.huggingface.co') ||
    url.hostname === 'hf.co'               ||
    url.hostname.endsWith('.hf.co')
  );
}

/**
 * Cache-first: return the cached response immediately if present;
 * otherwise fetch, cache the response, and return it.
 */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Only cache successful, non-opaque responses to avoid storing errors.
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.warn('[SW] cache-first fetch failed:', request.url, err.message);
    return offlineResponse();
  }
}

/**
 * Stale-while-revalidate: return the cached version immediately
 * (if any), then fetch a fresh copy in the background and update
 * the cache for the next visit.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // Serve cached immediately; wait for network only if nothing is cached.
  if (cached) {
    // Kick off the revalidation but don't await it.
    fetchPromise.catch(() => {});
    return cached;
  }

  const fresh = await fetchPromise;
  return fresh ?? offlineResponse();
}

function offlineResponse() {
  return new Response('Offline — content not cached yet', {
    status:     503,
    statusText: 'Service Unavailable',
    headers:    { 'Content-Type': 'text/plain' },
  });
}

/** Returns the estimated byte count of all entries in a named cache. */
async function cacheSize(cacheName) {
  try {
    const cache   = await caches.open(cacheName);
    const keys    = await cache.keys();
    const entries = await Promise.all(
      keys.map(async (req) => {
        const resp = await cache.match(req);
        const blob = await resp?.blob();
        return blob?.size ?? 0;
      })
    );
    return { count: keys.length, bytes: entries.reduce((a, b) => a + b, 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
