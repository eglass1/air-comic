/*
 * AirComic service worker.
 *
 * Scope is the directory the worker is served from, so the same file works at a
 * domain root and under a GitHub Pages project subpath (/air-comic/).
 *
 * BUILD_ID is substituted at build time, which is what makes the byte content
 * of this file change on every deploy: that is the signal browsers use to pick
 * up a new version. See the `aircomic-pwa` plugin in vite.config.ts.
 */
const BUILD_ID = 'b15e3e42f709';

const SHELL_CACHE = `aircomic-shell-${BUILD_ID}`;
const FONT_CACHE = 'aircomic-fonts-v1';

/** Directory the worker controls, e.g. https://example.github.io/air-comic/ */
const SCOPE_URL = new URL('./', self.location.href);

/** The application shell. Navigations inside the scope are served from here. */
const SHELL_URL = SCOPE_URL.href;

const PRECACHE_URLS = [
  SHELL_URL,
  new URL('./manifest.webmanifest', SCOPE_URL).href,
  new URL('./icons/icon-192.png', SCOPE_URL).href,
  new URL('./icons/icon-512.png', SCOPE_URL).href,
  new URL('./icons/icon-192-maskable.png', SCOPE_URL).href,
  new URL('./icons/icon-512-maskable.png', SCOPE_URL).href,
  new URL('./icons/apple-touch-icon-180.png', SCOPE_URL).href,
];

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `cache: 'reload'` keeps a stale HTTP cache entry from being promoted
      // into a fresh shell cache after a deploy.
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
    })()
  );
  // Deliberately no skipWaiting(): a new build waits until the page asks for
  // it, so a live conversation is never swapped out from underneath the user.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('aircomic-shell-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/**
 * Serve the cached shell immediately and let the service worker update flow
 * handle freshness. A network-first navigation would stall every cold start on
 * a multi-megabyte single-file bundle.
 */
async function handleNavigation(event) {
  const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
  if (cached) return cached;

  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (error) {
    const fallback = await caches.match(SHELL_URL);
    if (fallback) return fallback;
    throw error;
  }
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      // Opaque cross-origin font responses are still worth storing: they
      // replay fine, they just cannot be inspected here.
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(FONT_CACHE, request));
    return;
  }

  if (url.origin === self.location.origin && url.href.startsWith(SCOPE_URL.href)) {
    event.respondWith(
      caches.match(request, { cacheName: SHELL_CACHE }).then((cached) => cached || fetch(request))
    );
    return;
  }

  // Everything else -- relay signalling, WebRTC/ICE, tracker and directory
  // traffic -- is live communication and goes to the network untouched.
});

/*
 * Push scaffolding. Nothing subscribes yet; these handlers exist so that adding
 * a push subscription later is a client-side change only.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || 'AirComic';
  const options = {
    body: payload.body || '',
    icon: new URL('./icons/icon-192.png', SCOPE_URL).href,
    badge: new URL('./icons/icon-192-maskable.png', SCOPE_URL).href,
    tag: payload.tag || 'aircomic-message',
    renotify: Boolean(payload.tag),
    data: { url: payload.url || SHELL_URL, ...(payload.data || {}) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || SHELL_URL;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url.startsWith(SCOPE_URL.href) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
      return undefined;
    })()
  );
});
