const CACHE_NAME = 'segumex-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './menu.js',
    './segumex sin fondo.png',
    './manifest.json'
    // Add other critical assets here if needed, but mostly we want to cache the shell
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', (event) => {
    // Network First for HTML and API calls (Supabase), Cache First for static assets
    if (event.request.mode === 'navigate' || event.request.url.includes('supabase')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match(event.request);
            })
        );
    } else {
        event.respondWith(
            caches.match(event.request).then((response) => {
                return response || fetch(event.request);
            })
        );
    }
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
