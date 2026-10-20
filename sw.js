/* Anime Partner — offline service worker.
   Developed by Shin.

   The app registered './sw.js' but the file was never shipped, so every
   launch logged a 404 and Settings' "Offline ready" line was not true. This
   is that file.

   Caches
     ap-b-shell-<ver>  the app shell (index.html) — replaced on update
     ap-b-images       remote artwork — deliberately NOT version-scoped, so an
                       app update never throws away covers already downloaded

   Strategy
     shell   → cache-first, refreshed in the background (instant launch offline)
     images  → cache-first, then network, then an inline SVG placeholder
     API     → network-only, with a soft JSON fallback so nothing hangs
*/
const VERSION = 'ap-b-v1.2.0';
const SHELL   = VERSION + '-shell';
const IMAGES  = 'ap-b-images';        // shared across versions — do not rename
const MAX_IMAGES = 3000;

const SHELL_FILES = ['./', './index.html'];

/* Shown when an image is missing and we are offline, so a card never collapses
   into a broken-image icon. Mid-grey reads acceptably in both themes. */
const PLACEHOLDER = new Response(
  '<svg xmlns="http://www.w3.org/2000/svg" width="230" height="345" viewBox="0 0 230 345">' +
  '<rect width="230" height="345" fill="#8d90a6" fill-opacity=".18"/>' +
  '<circle cx="115" cy="166" r="26" fill="none" stroke="#8d90a6" stroke-opacity=".55" stroke-width="3"/>' +
  '</svg>',
  { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } }
);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // Added one by one: a single 404 must not fail the whole install.
    await Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    /* Only retire our own older shells. Everything the reader saved
       ("ap-books") and the artwork cache must survive an update — a new
       version of the app is not a reason to take someone's library away. */
    const KEEP = [SHELL, IMAGES, 'ap-books'];
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => KEEP.indexOf(k) === -1 && /^ap-b-v/.test(k)).map((k) => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

/* Is there still room? Pictures are the lowest priority thing this app
   stores — never let them crowd out a saved book or a backup. */
async function hasRoom() {
  try {
    if (!self.navigator.storage || !self.navigator.storage.estimate) return true;
    const e = await self.navigator.storage.estimate();
    if (!e || !e.quota) return true;
    return (e.usage / e.quota) < 0.8 && (e.quota - e.usage) > 25 * 1024 * 1024;
  } catch (_) { return true; }
}

async function keep(c, req, res) {
  try {
    if (!(await hasRoom())) return;
    await c.put(req, res);
    await trim(IMAGES, MAX_IMAGES);
  } catch (_) { /* out of room: the picture still showed, that is enough */ }
}

async function trim(name, max) {
  try {
    const c = await caches.open(name);
    const keys = await c.keys();
    if (keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map((k) => c.delete(k)));
  } catch (_) {}
}

const IMAGE_HOSTS = ['s4.anilist.co', 'img.gamemonetize.com', 'i.ytimg.com'];
const isImage = (url) =>
  /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(url.pathname) ||
  IMAGE_HOSTS.some((h) => url.hostname.indexOf(h) !== -1);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* ---- live data API: network only, never served stale ---- */
  if (url.hostname.indexOf('graphql.anilist.co') !== -1 || url.hostname.indexOf('api.jikan.moe') !== -1) {
    e.respondWith(fetch(req).catch(() => new Response(
      JSON.stringify({ data: null, offline: true }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  /* ---- artwork: cache-first, then network, then placeholder ---- */
  if (isImage(url) && url.origin !== location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(IMAGES);
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      /* Fetch the request exactly as the browser made it, so the picture
         appears even on a CDN with no CORS headers.

         What we must NOT do is store that answer. An <img> is fetched
         no-cors, so the response comes back opaque, and the browser charges
         an opaque cache entry roughly seven megabytes of quota whatever its
         real size. A few hundred covers that way and the origin is over its
         limit — at which point saved novels and backups silently stop being
         written. So: show the opaque one, and separately ask for a readable
         CORS copy to keep. AniList (where almost every poster lives) answers
         CORS happily; a host that refuses simply is not cached, and offline
         falls back to the placeholder. */
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          if (res.type !== 'opaque') {
            keep(c, req, res.clone());
          } else {
            fetch(url.href, { mode: 'cors', credentials: 'omit' })
              .then((cr) => { if (cr && cr.ok && cr.type !== 'opaque') keep(c, req, cr); })
              .catch(() => {});
          }
          return res;
        }
        /* A real 404 from the CDN: let the page's own onerror handler deal with
           it rather than hiding it behind ours. */
        if (res) return res;
        return PLACEHOLDER.clone();
      } catch (_) {
        return PLACEHOLDER.clone();      // genuinely offline — honest answer
      }
    })());
    return;
  }

  /* ---- navigations: cache-first on the shell so launch is instant ---- */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cached = await caches.match('./index.html');
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(SHELL).then((c) => c.put('./index.html', res.clone()));
        return res;
      }).catch(() => cached);
      return cached || net;
    })());
    return;
  }

  /* ---- everything else same-origin: cache-first + background refresh ---- */
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
  }
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
