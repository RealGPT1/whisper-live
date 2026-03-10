/**
 * Whisper Live — Service Worker
 *
 * Caching strategy:
 *   App shell (local HTML/CSS/JS)  → Cache-first, precached on install
 *   CDN assets (Bootstrap, etc.)   → Stale-while-revalidate, cached on first use
 *   HuggingFace model files        → Cache-first, stored in 'transformers-cache'
 *                                    (shared with Transformers.js so no double storage)
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE   = `whisper-live-shell-${CACHE_VERSION}`;
const CDN_CACHE     = `whisper-live-cdn-${CACHE_VERSION}`;

// Transformers.js uses this exact name — we share it so models only download once
const MODEL_CACHE = 'transformers-cache';

// ─── App shell: precache on install ──────────────────────────────────────────
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/maskable-icon.svg',
  '/dictate/',
  '/dictate/index.html',
  '/dictate/app.js',
  '/dictate/worker.js',
  '/dictate/audio-processor.js',
  '/dictate/audio-file-transcriber.js',
  '/dictate/styles.css',
  '/intent/',
  '/intent/index.html',
  '/intent/app.js',
  '/intent/worker.js',
  '/intent/audio-processor.js',
  '/intent/intents.js',
  '/intent/styles.css',
];

// ─── CDN hostnames (stale-while-revalidate) ───────────────────────────────────
const CDN_HOSTNAMES = new Set([
  'cdn.jsdelivr.net',
]);

// ─── HuggingFace model CDN hostnames (cache-first, shared with transformers.js) ─
const MODEL_HOSTNAMES = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-us-2.huggingface.co',
]);

// =============================================================================
// INSTALL — precache app shell
// =============================================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())   // activate immediately, don't wait for old tabs to close
  );
});

// =============================================================================
// ACTIVATE — clean up old shell/CDN caches, take control of all clients
// =============================================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) =>
            (key.startsWith('whisper-live-shell-') || key.startsWith('whisper-live-cdn-')) &&
            key !== SHELL_CACHE &&
            key !== CDN_CACHE
          )
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())  // take control of already-open pages
  );
});

// =============================================================================
// FETCH — intercept and respond from cache where possible
// =============================================================================
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;  // only cache GET requests

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Skip chrome-extension / non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // 1. HuggingFace model files — cache-first (shared cache with Transformers.js)
  if (MODEL_HOSTNAMES.has(url.hostname)) {
    event.respondWith(modelCacheFirst(req));
    return;
  }

  // 2. CDN assets (Bootstrap CSS/JS, Transformers.js library) — stale-while-revalidate
  if (CDN_HOSTNAMES.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
    return;
  }

  // 3. Same-origin app shell — cache-first, fall back to network, then offline page
  if (url.origin === self.location.origin) {
    event.respondWith(shellCacheFirst(req));
    return;
  }
});

// =============================================================================
// STRATEGY: Model cache-first
//   Checks transformers-cache first (already populated by Transformers.js),
//   falls back to network and stores result so it survives cache eviction.
// =============================================================================
async function modelCacheFirst(request) {
  const cache = await caches.open(MODEL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok || response.status === 206) {
      // Clone before consuming — cache stores a copy, caller gets the original
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Model file unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// =============================================================================
// STRATEGY: Stale-while-revalidate
//   Respond instantly from cache, then refresh the cache entry in the background.
//   Ideal for versioned CDN URLs — they won't change, so the refresh is cheap.
// =============================================================================
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Fire network request regardless — update cache in background
  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);  // if offline, fall back to cached

  // Return cached immediately if available, otherwise wait for network
  return cached ?? networkFetch;
}

// =============================================================================
// STRATEGY: Shell cache-first with network fallback
//   For navigation requests (HTML pages) always try the network-updated shell first.
//   For other same-origin assets (CSS/JS) use cache-first.
// =============================================================================
async function shellCacheFirst(request) {
  // For navigation requests, try network first so users get fresh HTML,
  // but fall back to cache so the app works offline.
  if (request.mode === 'navigate') {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request) ?? await caches.match('/index.html');
      return cached ?? offlineFallback();
    }
  }

  // Non-navigation same-origin assets: cache-first
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

function offlineFallback() {
  return new Response(
    `<!doctype html><html lang="en"><head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Whisper Live — Offline</title>
      <style>
        body{background:#000;color:#e9ecef;font-family:system-ui,sans-serif;
             display:flex;align-items:center;justify-content:center;
             min-height:100vh;margin:0;text-align:center;padding:2rem}
        h1{font-size:1.5rem;margin-bottom:.75rem}
        p{color:#6c757d;font-size:.9rem}
        button{margin-top:1.5rem;padding:.6rem 1.5rem;background:#4d9fff;
               color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:.9rem}
      </style>
    </head><body>
      <div>
        <div style="font-size:3rem;margin-bottom:1rem">🎙️</div>
        <h1>You're offline</h1>
        <p>Whisper Live needs a connection on first load.<br>
           Once the app and models are cached it works fully offline.</p>
        <button onclick="location.reload()">Try again</button>
      </div>
    </body></html>`,
    { status: 503, headers: { 'Content-Type': 'text/html;charset=utf-8' } }
  );
}

// =============================================================================
// BACKGROUND SYNC — retry any queued operations when connectivity resumes
// (placeholder — the app is read/mic only so no writes to sync, but the
//  registration is here for future use such as syncing saved transcripts)
// =============================================================================
self.addEventListener('sync', (_event) => {
  // Future: sync saved transcripts to cloud storage
});

// =============================================================================
// MESSAGE — allow pages to communicate with the service worker
// =============================================================================
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    // Page asked us to activate immediately (used by update prompt)
    self.skipWaiting();
  }

  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
