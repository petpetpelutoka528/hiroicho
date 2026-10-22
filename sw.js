'use strict';
/* 電波がなくても使えるように、アプリの部品をこの端末にしまっておく */
const VER = 'hiroicho-v26';   // 更新したら番号を上げる(app.js の APP_VER も同じ番号に)
const CORE = ["./", "index.html", "app.css", "calc.js", "store.js", "viewer.js", "excel.js", "app.js", "cmaps.js", "manifest.webmanifest", "pdf.min.js", "pdf.worker.min.js", "exceljs.min.js", "pdf-lib.min.js", "printpdf.js", "presets.js", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const cl = res.clone(); caches.open(VER).then(c => c.put(e.request, cl)); }
    return res;
  })));
});
