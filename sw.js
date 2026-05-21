const CACHE_NAME = 'foodlens-assets-v2';
const TILE_HOSTS = ['basemaps.cartocdn.com', 'tile.openstreetmap.fr', 'tile.openstreetmap.de', 'tile.openstreetmap.org'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 缓存地图瓦片
  const isTile = TILE_HOSTS.some(h => url.hostname.includes(h));
  // 缓存图片代理
  const isImageProxy = url.pathname === '/api/image-proxy';

  if (!isTile && !isImageProxy) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(() => cached || new Response('', { status: 408 }));
      })
    )
  );
});
