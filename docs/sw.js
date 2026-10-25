// オフラインでも開けるよう、アプリの画面と計算のファイルだけを保存する（記録は含まない）
const CACHE = 'cycle-app-v30';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'predict.js', 'backup.js', 'db.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// つながるときは最新を取りに行き、つながらないときは保存しておいたものを使う
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // ブラウザの一時保存（HTTP キャッシュ）の古いファイルを使わないよう、毎回サーバーに確かめる
  const url = new URL(e.request.url);
  const req = url.origin === location.origin ? fetch(url, { cache: 'no-cache' }) : fetch(e.request);
  e.respondWith(
    req
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
