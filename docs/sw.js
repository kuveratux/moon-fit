// Service Worker（端末内の受付係）。EARN VIEWER と同じ作り
// - 画面のファイル：保管庫を優先して返し、裏で新しい版を取りに行く（記録は扱わない。記録は端末内の IndexedDB）
// - 画面のファイルを変えたら version.js の APP_VERSION を上げる（古い保管庫が削除され、新しい版に入れ替わる）
// - 同じドメインに他のアプリがあるので、削除するのは自分の接頭辞の保管庫だけ（以前の名前 cycle-app- も含む）
importScripts('version.js');
const PREFIX = 'moon-fit-';
const OLD_PREFIX = 'cycle-app-';
const SHELL = PREFIX + self.APP_VERSION;
const FILES = ['./', 'index.html', 'version.js', 'style.css', 'app.js', 'predict.js', 'backup.js', 'db.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];

// 新しい版のファイルは、公開サイトの一時保管（最大 10 分）を通さずに取る（URL に版の印を付ける。保管庫からは印を無視して探す）
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => Promise.all(FILES.map(u => fetch(new Request(`${u}?v=${self.APP_VERSION}`, { cache: 'reload' }))
      .then(res => { if (!res.ok) throw new Error(`${u}: ${res.status}`); return c.put(new Request(u), res); }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => (k.startsWith(PREFIX) || k.startsWith(OLD_PREFIX)) && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.cache === 'no-store' || e.request.cache === 'reload') return; // 更新確認などは保管庫を通さない

  // 保管庫優先（裏で更新）
  e.respondWith(
    caches.open(SHELL).then(c =>
      c.match(e.request, { ignoreSearch: true }).then(hit => {
        const update = fetch(e.request, { cache: 'no-cache' }) // 裏での取り直しは、一時保管を確かめ直してから
          .then(res => { if (res.ok) c.put(e.request, res.clone()); return res; })
          .catch(() => hit);
        return hit || update;
      }),
    ),
  );
});
