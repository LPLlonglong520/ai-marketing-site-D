/* 安恒营销 AI 站点 · Service Worker
 *
 * 背景：GitHub Pages 的响应头固定为 Cache-Control: max-age=600，站点侧无法自定义。
 *       → 用 Cache API 在客户端补齐更长、更聪明的缓存策略，让二次访问与页面跳转近乎零等待。
 *
 * 策略：
 *   - HTML 导航：stale-while-revalidate —— 先给缓存(秒开)，后台拉新版，下次访问即最新
 *   - 图片/JSON/字体：stale-while-revalidate —— 同上，图片换内容也能自动跟上
 *   - 视频(mp4)：不接管 —— 交给浏览器原生 HTTP 缓存，避免 Range(206) 与 SW 缓存冲突
 *   - 跨域请求：不接管（钉钉/金山/内网链接等）
 *
 * 版本：由 build.py 注入 3fb74d01e46f。版本变化 → 新 SW 安装 → 删除同名前缀的旧缓存 → 通知页面刷新一次。
 */
const V = '3fb74d01e46f';
const PREFIX = 'ams-d-';
const CACHE = PREFIX + V;

/* 首访预缓存的核心页面：体积小、跳转必经。
   刻意不预缓存视频与全部图片，避免拖慢首次访问。 */
const PRECACHE = [
  './index.html',
  './digital-employee.html',
  './future.html',
  './scene-1.html',
  './scene-2.html',
  './scene-3.html',
  './scene-4.html',
  './scene-5.html',
  './scene-6.html',
  './scene-7.html',
  './ued-theme-a.css',
  './ued-theme-b.css',
  './ued-theme-c.css',
  './ued-theme-d.css',
  './ued-switch.css',
  './ued-page-de-a.css',
  './ued-page-de-b.css',
  './ued-page-de-c.css',
  './ued-page-de-d.css'
];

/* 首页空闲时预热的高频图片（立牌 + 人物件），延后加载，不抢首屏带宽 */
const WARM = [
  './media/de_board_front_1x.webp',
  './media/de_board_front_1x.avif',
  './media/de_board_back_1x.webp',
  './media/de_board_back_1x.avif',
  './media/eco_board_1x.webp',
  './media/eco_board_1x.avif',
  './media/de_char_body.webp',
  './media/de_char_b_body.webp'
];

let opening = null;
function cache() {
  if (!opening) opening = caches.open(CACHE);
  return opening;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await cache();
    /* 逐个 add：cache.addAll 是原子的，一个 404 会导致整批失败 */
    await Promise.all(PRECACHE.map(async (u) => {
      try { await c.add(new Request(u, { cache: 'reload' })); } catch (err) { /* 单个失败可忽略 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const mine = keys.filter((k) => k.indexOf(PREFIX) === 0);
    const hadOld = mine.some((k) => k !== CACHE);
    await Promise.all(mine.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    /* 换版本后，让已打开的旧页面刷新一次以拿到新内容（页面侧有一次性保护） */
    if (hadOld) {
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach((cl) => cl.postMessage({ type: 'updated', v: V }));
    }
  })());
});

/* 页面侧可要求：warm = 预热图片 */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'warm') {
    e.waitUntil((async () => {
      const c = await cache();
      await Promise.all(WARM.map(async (u) => {
        try { if (!(await c.match(u))) await c.add(new Request(u, { cache: 'reload' })); } catch (err) {}
      }));
    })());
  }
});

function isHtml(req) {
  return req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;
}

/* 立即返回缓存 + 后台静默更新。无缓存时等网络。 */
async function swr(req) {
  const c = await cache();
  const hit = await c.match(req);

  const net = fetch(req).then((r) => {
    if (r && r.ok && r.type === 'basic') {
      const cp = r.clone();
      c.put(req, cp).catch(() => {});
    }
    return r;
  });

  if (hit) {
    net.catch(() => {});      // 后台更新失败无所谓
    return hit;               // 即时响应
  }
  try {
    const r = await net;
    if (r) return r;
  } catch (err) { /* 落到下面 */ }
  return new Response('', { status: 504, statusText: 'offline' });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.slice(-4) === '.mp4') return;   // 视频走浏览器原生缓存

  e.respondWith(swr(req));
});
