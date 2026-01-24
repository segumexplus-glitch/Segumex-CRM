const CACHE_NAME = 'segumex-v2';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './menu.js',
    './ui.js',
    './ui.css',
    './segumex sin fondo.png',
    './manifest.json',
    './screenshot-desktop.png',
    './screenshot-mobile.png'
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

// --- PUSH NOTIFICATIONS HANDLER ---
self.addEventListener('push', function (event) {
    if (event.data) {
        const payload = event.data.json();
        const options = {
            body: payload.body,
            icon: 'segumex sin fondo.png',
            badge: 'segumex sin fondo.png',
            data: payload.data || {},
            actions: payload.actions || []
        };

        event.waitUntil(
            self.registration.showNotification(payload.title, options)
        );
    }
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url || '/')
    );
});
