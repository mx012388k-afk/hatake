// 畑ノート Service Worker
// アプリ本体（同一オリジンのファイル）と Firebase SDK をキャッシュし、オフラインでも起動できるようにする。
// データの同期は Firestore のオフライン永続化が担当する。天気APIはキャッシュしない（アプリ側で保持）。

const CACHE = "hatake-v0.3.0";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./engine.js",
  "./crops.json",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icon.svg"
];
const SDK_PREFIX = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase SDK：バージョン固定のURLなのでキャッシュ優先
  if (req.url.startsWith(SDK_PREFIX)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // 同一オリジン：ネットワーク優先、失敗したらキャッシュ（更新をすぐ反映しつつオフラインでも動く）
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
    );
  }
  // それ以外（Firestore 通信・天気APIなど）は Service Worker では扱わない
});
