// public/sw.js
const CACHE_NAME = 'pesam-voice-offline-v1';

// Ignorujemy zapytania do Firebase, API oraz baz danych
const shouldIgnore = (url) => {
    return (
        url.pathname.startsWith('/api') ||
        url.pathname.includes('firestore') ||
        url.pathname.includes('identitytoolkit') ||
        url.hostname.includes('firebase')
    );
};

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Obsługujemy tylko lokalne zapytania GET (pliki HTML, JS, CSS, obrazy)
    if (request.method !== 'GET' || url.origin !== self.location.origin) {
        return;
    }

    if (shouldIgnore(url)) {
        return;
    }

    event.respondWith(
        fetch(request)
            .then((response) => {
                // Gdy jesteśmy online, zapisujemy/aktualizujemy pobrane pliki w pamięci telefonu
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Gdy jesteśmy offline, serwujemy pliki z lokalnej pamięci telefonu
                return caches.match(request).then((cachedResponse) => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // Fallback: jeśli jesteśmy offline, a otwieramy główną stronę
                    if (request.mode === 'navigate') {
                        return caches.match('/voice-order');
                    }
                });
            })
    );
});