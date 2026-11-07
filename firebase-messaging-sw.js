/* Mbolo V30 — Service Worker (FCM background + cache PWA)
   ────────────────────────────────────────────────────────
   ⚠️  À CHAQUE déploiement, change UNIQUEMENT la ligne VERSION ci-dessous.
       Cela purge l'ancien cache et force la mise à jour sur tous les appareils.
*/
const VERSION = "35.0.0";
const CACHE = "mbolo-" + VERSION;

importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBJOlSavLqAMLhRSTwk0pUh0oJiw5QBiko",
  authDomain: "mbolo-81868.firebaseapp.com",
  databaseURL: "https://mbolo-81868-default-rtdb.firebaseio.com",
  projectId: "mbolo-81868",
  storageBucket: "mbolo-81868.firebasestorage.app",
  messagingSenderId: "265201834213",
  appId: "1:265201834213:web:10d2593770cf1d02799c0c"
});

const messaging = firebase.messaging();

/* ---------- FCM : notification en arrière-plan ---------- */
messaging.onBackgroundMessage(payload => {
  if (payload.notification && !payload.data) return;

  const d = payload.data || payload.notification || {};
  return self.registration.showNotification(d.title || "Mbolo 🥁", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [200, 100, 200],
    tag: d.tag || "mbolo",
    data: { url: d.url || self.registration.scope }
  });
});

/* ---------- Clic sur notification : focus + navigation ---------- */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) {
        await c.focus();
        if ("navigate" in c) { try { await c.navigate(targetUrl); } catch (_) {} }
        return;
      }
    }
    return clients.openWindow(targetUrl);
  })());
});

/* ---------- Cycle de vie : activation immédiate ---------- */
self.addEventListener("install", e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- Cache PWA ---------- */
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

const EXCLUDED_HOSTS = [
  "firebaseio.com",
  "googleapis.com",
  "gstatic.com",
  "cloudinary.com",
  "wa.me",
  "whatsapp.com"
];

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (EXCLUDED_HOSTS.some(h => url.hostname.endsWith(h))) return;

  // HTML / navigation → network-first (jamais de version figée)
  const isDoc = req.mode === "navigate"
    || req.destination === "document"
    || url.pathname === "/"
    || url.pathname.endsWith(".html");

  if (isDoc) {
    e.respondWith(
      fetch(req).catch(() =>
        caches.match(req).then(m => m || caches.match("./index.html"))
      )
    );
    return;
  }

  // Assets statiques → cache-first + update silencieuse en arrière-plan
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});