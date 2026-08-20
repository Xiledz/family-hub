/* Family Hub service worker.
   Two jobs: keep the app shell available offline, and receive push. */
const CACHE = 'familyhub-v1';
const SHELL = ['./','./index.html','./styles.css','./app.js','./parse.js','./config.js','./manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Shell: cache-first. Everything else (Supabase): straight to network — a
   family calendar showing stale data is worse than showing a spinner. */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Family Hub', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Family Hub', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './badge.png',
    tag: d.tag || 'family-hub',
    renotify: true,
    data: { url: d.url || './index.html' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(target);
  }));
});
