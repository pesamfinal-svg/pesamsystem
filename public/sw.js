const CACHE_NAME = 'pesam-voice-v6';

// Cachujemy TYLKO pliki które na pewno istnieją i są statyczne
const PRECACHE = [
  '/voice-order.html',
  '/manifest.json',
  '/favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('pesam-voice') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
        });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignoruj Firebase/API requesty
  if (
    request.method !== 'GET' ||
    url.href.includes('firestore') ||
    url.href.includes('googleapis') ||
    url.href.includes('firebasestorage') ||
    url.href.includes('identitytoolkit') ||
    url.href.includes('gstatic.com')
  ) {
    return;
  }

  // Cache-first dla voice-order.html — to jest nasz główny plik offline
  if (url.pathname === '/voice-order.html' || url.pathname === '/') {
    event.respondWith(
      caches.match('/voice-order.html').then(cached => {
        // W tle odśwież cache
        const fetchPromise = fetch(request).then(response => {
          if (response.status === 200) {
            caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
          }
          return response;
        }).catch(() => cached);

        // Zwróć od razu z cache, nie czekaj na sieć
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Dla pozostałych: network first, fallback do cache
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(request, response.clone()));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});