const CACHE_NAME = "paperclip-v3";

function isHtmlResponse(response) {
  return (response.headers.get("content-type") || "").includes("text/html");
}

function withCacheBypass(url) {
  const next = new URL(url);
  next.searchParams.set("__pc_sw_bust", Date.now().toString(36));
  return next.toString();
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and API calls
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }

  // Network-first for everything — cache is only an offline fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (url.origin === self.location.origin && url.pathname.startsWith("/assets/") && isHtmlResponse(response)) {
          return fetch(withCacheBypass(url), { cache: "reload" });
        }
        if (response.ok && url.origin === self.location.origin && !isHtmlResponse(response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        if (request.mode === "navigate") {
          return caches.match("/") || new Response("Offline", { status: 503 });
        }
        return caches.match(request);
      })
  );
});
