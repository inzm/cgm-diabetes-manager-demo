/**
 * Service Worker: CGM Diabetes Manager Web
 * Local-First オフラインキャッシュ & アセット保護
 */

const CACHE_NAME = 'cgm-manager-v2';

const STATIC_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/icons/icon-maskable.svg',
];

// 1. インストール時: 基本静的アセットをプリキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// 2. アクティベート時: 旧バージョンのキャッシュおよび大容量データJSON (/data/*) のキャッシュをクリア
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(async () => {
        const cache = await caches.open(CACHE_NAME);
        const requests = await cache.keys();
        await Promise.all(
          requests.map((req) => {
            const reqUrl = new URL(req.url);
            if (reqUrl.pathname.startsWith('/data/')) {
              return cache.delete(req);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// 3. フェッチ時: Stale-While-Revalidate & オフラインSPAナビゲーション保護
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // 大容量デモデータ JSON (/data/*) は端末の Cache Storage 圧迫防止のためキャッシュ対象から除外し、既存エントリがあれば削除する
  if (url.pathname.startsWith('/data/')) {
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.delete(request))
      .catch(() => {});
    return;
  }

  // 外部API (Google Gemini 等) または Vite 開発サーバーのモジュール/HMRリクエストはキャッシュしない
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/node_modules/')
  ) {
    return;
  }

  // ナビゲーションリクエスト (ページ読み込み/リロード)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const fallback = (await caches.match('/index.html')) || (await caches.match('/'));
        return (
          fallback ||
          new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        );
      })
    );
    return;
  }

  // 静的アセット (JS, CSS, 画像, フォント): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // オフライン時のネットワークエラー時はキャッシュまたは503 Responseを返却（undefinedによるTypeError防止）
          return (
            cachedResponse ||
            new Response('Offline asset unavailable', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          );
        });

      return cachedResponse || fetchPromise;
    })
  );
});
