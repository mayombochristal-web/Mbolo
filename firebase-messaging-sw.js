/**
 * Mbolo V20.1 — Service Worker FCM + cache PWA
 *
 * Correctifs V20.1 :
 *  - Cache excluant firebaseio/googleapis/gstatic/cloudinary/wa.me
 *  - notificationclick : focus + navigation
 *  - onBackgroundMessage : skip si notification auto-affichée par FCM
 *  - Cache version bumpé v26
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

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

// ---------- FCM background ----------
messaging.onBackgroundMessage((payload) => {
  // Si un payload `notification` est présent, FCM affiche déjà automatiquement
  // la notification → ne pas doubler.
  if (payload.notification && !payload.data) return;

  const d = payload.data || payload.notification || {};
  return self.registration.showNotification(d.title || 'Mbolo 🥁', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [200, 100, 200],
    tag: d.tag || 'mbolo',
    data: { url: './' }
  });
});

// ---------- Clic sur notification ----------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || self.registration.scope;

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(targetUrl); } catch (_) {} }
        return;
      }
    }
    return clients.openWindow(targetUrl);
  })());
});

// ---------- Cache PWA ----------
// ⚠️ IMPORTANT: Change ce numéro de version (v25 -> v26 -> v27...) à CHAQUE FOIS 
// que tu déploies une mise à jour pour forcer les téléphones à télécharger le nouveau code.
const CACHE = 'mbolo-v25'; 

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

// Ne JAMAIS mettre en cache ces domaines (API, images distantes, redirections)
const EXCLUDED_HOSTS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'cloudinary.com',
  'wa.me',
  'whatsapp.com'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Ignorer : méthodes non-GET, requêtes cross-origin, domaines exclus
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (EXCLUDED_HOSTS.some(h => url.hostname.endsWith(h))) return;

  // Network-first avec fallback cache
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
  );
});
