
// --- ⚡️ Existing PWA caching logic ---
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open("zoomlite-v1").then((cache) => {
      return cache.addAll([
        "/",
        "/index.html",
        "/main.js",
        "/manifest.json",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
      ]);
    })
  );
  console.log("✅ Service Worker installed and cache initialized");
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});
