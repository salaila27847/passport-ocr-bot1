const CACHE_NAME = 'checkin-shell-v1';
const SHELL_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'js/api.js',
  'js/auth.js',
  'js/views.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// เฉพาะ static shell เท่านั้นที่ cache — คำขอไป backend (API) ปล่อยผ่านไปเน็ตเวิร์กตรงๆ เสมอ ไม่ cache
// ข้อมูลที่เปลี่ยนได้ (SEQ/รูป/ผล OCR) เพราะจะทำให้เจ้าหน้าที่เห็นข้อมูลเก่าค้างได้
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
