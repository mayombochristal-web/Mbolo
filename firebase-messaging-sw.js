importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBJOlSavLqAMLhRSTwk0pUh0oJiw5QBiko",
  authDomain: "mbolo-81868.firebaseapp.com",
  projectId: "mbolo-81868",
  storageBucket: "mbolo-81868.firebasestorage.app",
  messagingSenderId: "265201834213",
  appId: "1:265201834213:web:10d2593770cf1d02799c0c"
});

const messaging = firebase.messaging();

// Affiche la notification système quand l'app est en arrière-plan
messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title || "Mbolo";
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/Mbolo/icon-192.png',
    badge: '/Mbolo/icon-192.png',
    vibrate: [200, 100, 200]
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});