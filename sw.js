const CACHE_NAME = 'segumex-v4';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './menu.js',
    './ui.js',
    './ui.css',
    './icon-192.png',
    './icon-512.png',
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
            icon: 'icon-192.png',
            badge: 'icon-192.png',
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
