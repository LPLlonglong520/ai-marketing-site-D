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
 * ⚠️ 首访带宽纪律（2026-10-08 重写，重要）：
 *   国际链路下大文件实测只有 ~2 KB/s。旧版把「10 个页面 + 9 个 CSS」全塞进 install
 *   预缓存 → 首访时用户只看 1 页，却要和首屏抢着下 286 KB 的后台内容，
 *   再叠加 ~234 KB 图片预热，首屏要多等好几分钟。
 *   现在改成三级：
 *     ① install 只下 CRITICAL（1.2 KB，切换器样式）
 *     ② 首屏全部加载完（load + 空闲）后，页面发消息触发 DEFER_CSS（4 套皮肤，串行、每项一次）
 *     ③ 再往后才是其余页面与图片预热，且慢网 / 省流量模式整体跳过
 *   内容一项没少 —— 只是不再和首屏抢带宽。
 *
 * 版本：由 _cd_site_build.py 注入 33469d46228d（页面+CSS 内容 md5）。版本变化 → 新 SW 安装
 *       → 删除同名前缀的旧缓存 → 通知页面刷新一次。
 */
const V = '33469d46228d';
const PREFIX = 'ams-d-';
const CACHE = PREFIX + V;

/* ① install 阶段就要有的：只有切换器样式。
      当前皮肤的 CSS 会被页面自身的 <link> 请求，下面的 fetch 处理器顺手写进缓存。 */
const CRITICAL = [
  './ued-switch.css'
];

/* ② 首屏之后的「先补这批」：4 套皮肤 CSS（由 _th_build.py 注入）。
      切换风格时要立刻生效，所以任何网络条件下都补 —— 但必须等首屏让路。 */
const DEFER_CSS = [
  './ued-theme-a.css',
  './ued-theme-b.css',
  './ued-theme-c.css',
  './ued-theme-d.css',
  './ued-page-de-a.css',
  './ued-page-de-b.css',
  './ued-page-de-c.css',
  './ued-page-de-d.css',
];

/* ③ 首屏之后、网络不慢时才补的：其余页面（导航会跳到）+ 图片预热。 */
const DEFER_PAGES = [
  './index.html',
  './digital-employee.html',
  './future.html',
  './scene-1.html',
  './scene-2.html',
  './scene-3.html',
  './scene-4.html',
  './scene-5.html',
  './scene-6.html',
  './scene-7.html'
];

/* ④ 首页空闲时预热的高频图片（滚动到下方才会用到的那些）。
   只留 webp（兜底格式）；avif 是同一张图的替代格式，页面 <picture> 自己会挑一个，
   预热时两种都下等于白下一半 —— 旧版就是这么浪费的。 */
const WARM = [
  './media/eco_board_1x.webp',
  './media/de_board_back_1x.webp'
];

let opening = null;
function cache() {
  if (!opening) opening = caches.open(CACHE);
  return opening;
}

/* 慢网 / 省流量：跳过「可选项」。判定失败时按「不慢」处理（宁可多补，别误跳）。 */
function slowNet() {
  try {
    const c = navigator.connection || navigator.mozConnection || {};
    if (c.saveData) return true;
    const t = (c.effectiveType || '').toLowerCase();
    return t === 'slow-2g' || t === '2g' || t === '3g';
  } catch (e) { return false; }
}

/* 串行补齐：一次只发一个请求。
   并行 18 个在慢链路上会互相抢，串行对首屏和用户后续操作的干扰最小。
   用 cache:'default' 走浏览器 HTTP 缓存（旧版 cache:'reload' 会强制重下已经有的文件）。 */
async function fill(list) {
  if (!list || !list.length) return;
  const c = await cache();
  for (const u of list) {
    try {
      if (await c.match(u)) continue;
      const r = await fetch(u, { cache: 'default' });
      if (r && r.ok && r.type === 'basic') await c.put(u, r.clone());
    } catch (err) { /* 单个失败可忽略 */ }
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await cache();
    /* 逐个 add：cache.addAll 是原子的，一个 404 会导致整批失败 */
    await Promise.all(CRITICAL.map(async (u) => {
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

/* 页面侧在首屏加载完之后按节奏发消息：
     warm-css   → 4 套皮肤 CSS（任何网络都做）
     warm-pages → 其余页面（慢网跳过）
     warm-img   → 图片预热（慢网跳过）
     裸 warm    → 兼容旧版页面：只当 warm-css 处理，不再顺带下图片 */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  const t = d.type;
  if (t === 'warm-css' || t === 'warm') {
    /* 页面把自己的 <link data-ued-th> 清单换算成 4 套皮肤的文件名发过来。
       首页只用 ued-theme-*.css，用不到数字员工页专用的 ued-page-de-*.css ——
       按站点级 DEFER_CSS 一刀切会替首页白下 116 KB。没带 urls 才退回默认清单。 */
    const list = (d.urls && d.urls.length) ? d.urls : DEFER_CSS;
    e.waitUntil(fill(list));
  } else if (t === 'warm-pages') {
    if (slowNet()) return;
    e.waitUntil(fill(DEFER_PAGES));
  } else if (t === 'warm-img') {
    if (slowNet()) return;
    e.waitUntil((async () => {
      const c = await cache();
      await Promise.all(WARM.map(async (u) => {
        try {
          if (await c.match(u)) return;
          const r = await fetch(u, { cache: 'default' });
          if (r && r.ok && r.type === 'basic') await c.put(u, r.clone());
        } catch (err) {}
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
