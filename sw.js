const CACHE_NAME = 'hopescore-v2';
const CACHED_URLS = ['./', './index.html', './hopescore.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHED_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first: always serve the latest version when online (and refresh
// the cache with it), falling back to whatever was last cached only when
// the network is unavailable. Cross-origin requests (e.g. YouTube embeds)
// are left untouched -- this only caches the app's own page.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // 'reload' forces the browser's own HTTP cache to be bypassed too -- since
  // GitHub Pages serves this with caching headers, a plain fetch() could be
  // satisfied straight from the HTTP cache without this actually reaching
  // the network, defeating "network-first" in a way this SW's own cache
  // logic below can't detect or fix.
  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // A shared setlist link carries a "?date=..." query string, which
        // doesn't change what page is served -- if this exact URL was never
        // cached (first-ever open of a shared link, offline), fall back to
        // the cached bare page instead of failing outright. The address bar
        // keeps the real URL, so the page's own JS still reads "?date=..."
        // from it correctly once this fallback response loads.
        const bare = new URL(event.request.url);
        bare.search = '';
        return caches.match(bare.toString()).then((c) => c || Response.error());
      }))
  );
});
