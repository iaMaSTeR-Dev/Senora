// SENORA PWA Service Worker & Web Push Handler
// Only bundled static resources belong in CacheStorage. Media stays in the
// browser's streaming pipeline; cloning a gigabyte response can buffer its body.
const CACHE_NAME = 'senora-static-v2';
const ASSETS_TO_CACHE = ['/', '/index.html', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)).catch(error => console.warn('SW pre-cache error:', error)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key !== CACHE_NAME && key.startsWith('senora-')
  ).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

function cacheStaticResponse(event, response) {
  const length = Number(response.headers.get('Content-Length'));
  const type = response.headers.get('Content-Type') || '';
  const policy = response.headers.get('Cache-Control') || '';
  if (response.status !== 200 || !length || length > 5 * 1024 * 1024 ||
      /^(video|audio)\//i.test(type) || /private|no-store/i.test(policy)) return;
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
    .catch(error => console.warn('SW cache write skipped:', error)));
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      request.headers.has('Range') || request.destination === 'video' || request.destination === 'audio') return;
  const navigation = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');
  const asset = !url.search && (['/manifest.json', '/favicon.svg'].includes(url.pathname) ||
    /^\/assets\/.+\.(js|css|woff2?|ttf|png|svg|ico|json)$/.test(url.pathname));
  if (!navigation && !asset) return;
  if (navigation) {
    // New HTML must win after deployment; old cached HTML references old clients.
    event.respondWith(fetch(request).then(response => {
      if (/text\/html/i.test(response.headers.get('Content-Type') || '')) cacheStaticResponse(event, response);
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match('/')) || Response.error()));
  } else {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      cacheStaticResponse(event, response);
      return response;
    })));
  }
});

// Push notification handling
self.addEventListener('push', (event) => {
  let data = { title: 'SENORA', body: 'New encrypted message', icon: '/favicon.svg' };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/favicon.svg',
      badge: '/favicon.svg',
      data: data.data || {},
      tag: data.tag || 'senora-msg',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
