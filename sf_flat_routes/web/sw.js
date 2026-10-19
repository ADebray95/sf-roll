/* Roll SF service worker (spec 8). sf_flat_routes/webapp.py fills in the
 * cache version and the file list for each build.
 *
 * Every file but the page carries a content hash in its name, so it is
 * served cache-first; the page itself is network-first, so a new build is
 * picked up when online. The cache is named after the build, and older
 * caches are deleted when a new worker activates: that is how a new graph
 * replaces the old one. Map tiles are not involved: the app has none. */
"use strict";
const CACHE = "rollsf-__VERSION__";
const SHELL = /*__SHELL__*/ [];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const stale = (k) => k.startsWith("rollsf-") && k !== CACHE;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter(stale).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
