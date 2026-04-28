// Chuck service worker: minimal offline shell cache.
//
// Keeps the phone UI's static bundle available when the network flaps
// (Kampala routing, tunnel re-establish, Tailscale relay hiccup). Not a
// full offline-first PWA: `chat.send` still needs the gateway. But the
// shell loads, the new-chat button works, and cached history renders.
//
// Cache policy: stale-while-revalidate for same-origin static assets;
// network-first for everything else.

const CACHE_VERSION = "chuck-v1";
const SHELL_URLS = ["/m/", "/m/index.html"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_URLS).catch(() => {})),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") {
    return;
  }

  const url = new URL(req.url);
  // Never cache the gateway WebSocket upgrade or RPC paths: they're live.
  if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/gateway")) {
    return;
  }
  // Only intercept same-origin + /m/ prefix.
  if (url.origin !== location.origin) {
    return;
  }
  if (!url.pathname.startsWith("/m/")) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => cached ?? new Response("offline", { status: 503 }));
      return cached ?? networkFetch;
    }),
  );
});
