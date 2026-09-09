/* Family Hub service worker.
   Two jobs: keep the app shell available offline, and receive push. */
const CACHE = 'familyhub-v3';
const SHELL = ['./','./index.html','./styles.css','./app.js','./parse.js','./recur.js','./config.js','./manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* Shell: NETWORK FIRST, cache only as the offline fallback.
   Cache-first was wrong here. It pinned every installed phone to whatever
   app.js was live the day it was added to the home screen — a new upload
   could never reach it. The shell is a handful of small files on the same
   origin; fetching them costs milliseconds and guarantees the family is
   running the same version. The cache exists for the drive-with-no-signal
   case, not as the primary source.
   Everything else (Supabase): straight to network — a family calendar
   showing stale data is worse than showing a spinner. */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
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
