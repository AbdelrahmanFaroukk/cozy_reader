// Cozy Reader service worker — app shell cache + runtime cache for fonts/pdfjs
const VERSION = "cozy-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Navigation requests → shell
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(() => caches.match("./index.html"))
    );
    return;
  }
  // CDN fonts / pdfjs / tailwind → stale-while-revalidate
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(VERSION + "-runtime").then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // Same-origin → cache-first
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
