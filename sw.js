/* Family Hub service worker.
   Two jobs: keep the app shell available offline, and receive push. */
const CACHE = 'familyhub-v16';
const SHELL = ['./','./index.html','./kitchen.html','./kid.html','./styles.css','./app.js','./parse.js','./recur.js','./streak.js','./config.js','./manifest.webmanifest'];

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
  /* cache:'no-cache' is what makes "network first" actually mean network.
     Without it the fetch goes through the browser's own HTTP cache, and
     GitHub Pages sends max-age=600 — so for ten minutes after any load, a
     "network" fetch quietly returned the old file, and a phone that opened
     the app right after a push stayed on the previous build. With it the
     browser revalidates against the server (ETag), which is one tiny
     conditional request per file and returns 304 when nothing changed. */
  /* The shell is keyed WITHOUT its query string. ?kid=bryce and
     ?display=kitchen are the same index.html — the mode is read from the
     URL by app.js at run time, never baked into a cached page — so one
     cached copy serves every mode, and an offline kitchen iPad still gets
     the shell instead of a miss. */
  const key = url.search ? url.origin + url.pathname : e.request;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
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
