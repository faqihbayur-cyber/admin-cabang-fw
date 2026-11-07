/* sw.js — web adminCabang FW Admin
   - Tanpa cache: semua request langsung ke jaringan.
   - Menerima push chat dari Cloud Functions, menampilkan notifikasi, dan mengatur badge di ikon aplikasi. */
var IKON = 'logofw.png';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (e) { e.respondWith(fetch(e.request)); });

self.addEventListener('push', function (e) {
  var d = {};
  try { var p = e.data ? e.data.json() : {}; d = p.data || p; } catch (err) { d = {}; }
  var n = parseInt(d.jumlah, 10);
  var opsi = {
    body: d.isi || '',
    icon: IKON,
    tag: d.tag || 'fw-chat',
    renotify: true,
    data: { url: d.url || './index.html#/chat' }
  };
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      // Badge di ikon aplikasi = jumlah chat belum dibaca
      try {
        if (self.navigator && self.navigator.setAppBadge) {
          if (n > 0) self.navigator.setAppBadge(n); else self.navigator.clearAppBadge();
        }
      } catch (err) {}
      // Admin sedang melihat menu Chat: pesan sudah tampil langsung, tidak perlu notifikasi
      var dilihat = cs.some(function (c) { return c.visibilityState === 'visible' && c.focused && c.url.indexOf('#/chat') > -1; });
      if (dilihat) return;
      return self.registration.showNotification(d.judul || 'Chat baru', opsi);
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './index.html#/chat';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].url.indexOf(self.registration.scope) === 0 && 'focus' in cs[i]) {
          cs[i].postMessage({ aksi: 'buka-chat' });
          return cs[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
