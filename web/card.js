/* card.js — 把后端产出的卡片 HTML 安全地渲染出来
 *
 * 核心安全机制：
 * 1. 强隔离沙箱：iframe sandbox 仅设为 "allow-scripts"，绝不开启 allow-same-origin 或 nativebridge；
 * 2. 最小权限 CSP：受控前置生成标准 DOCTYPE/head，强制注入严格 meta CSP（严禁外部 script、禁用网络/表单/iframe/object，仅限内联与 data/blob）；
 * 3. 运行态注入：在任何不可信内容之前前置执行 window.card SDK，防止假 head/提前脚本绕过；
 * 4. 宿主桥生命周期：支持通过 hostBridge.register 绑定 parent 冻结上下文，并提供 dispose 及时解绑。
 */

import { CARD_RUNTIME_SCRIPT } from '../shared/card-runtime.mjs';

const RESIZE_SCRIPT = `
<script>
(function () {
  var last = -1, tick = 0;
  function post() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    if (h === last) return;   // 高度没变就不刷屏
    last = h;
    parent.postMessage({ __hanaCardHeight: h }, '*');
  }
  window.addEventListener('load', post);
  if (window.ResizeObserver) {
    new ResizeObserver(post).observe(document.documentElement);
  }
  // 兜底复查只跑前 10 秒（图表、字体加载完会变高），之后停掉。
  // 常驻定时器在长会话里会堆成几十个，白耗电。
  var timer = setInterval(function () { post(); if (++tick >= 12) clearInterval(timer); }, 800);
  post();
})();
<\/script>
`;

const META_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'; frame-src \'none\';">';

function buildSandboxedDoc(untrustedHtml, nonce = null) {
  const content = typeof untrustedHtml === 'string' ? untrustedHtml : '';
  const bridgeMeta = (typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce))
    ? `  <meta name="hana-mobile-bridge" content="${nonce}">\n`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
${bridgeMeta}  ${META_CSP}
  <script>
  ${CARD_RUNTIME_SCRIPT}
  <\/script>
</head>
<body>
  ${content}
  ${RESIZE_SCRIPT}
</body>
</html>`;
}

function withBridgeNonce(url, nonce) {
  if (typeof url !== 'string' || !url) return url;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return url;
  return `${url}${url.includes('#') ? '&' : '#'}hana-mobile-bridge=${nonce}`;
}

function resolveCardSource(dirPath, sourceUrl) {
  if (typeof sourceUrl === 'string' && sourceUrl) {
    try {
      const base = (typeof location !== 'undefined' && location.href) ? location.href : 'http://localhost/';
      const resolved = new URL(sourceUrl, base);
      const baseOrigin = new URL(base).origin;
      if (resolved.origin === baseOrigin) return resolved.href;
    } catch { /* fall back to virtual card route */ }
  }
  return cardUrlFor(dirPath);
}

let cardSeq = 0;

/* ---------------- 首帧高度：未就绪先隐身，首个上报后淡入 ----------------
 *
 * 背景：.card-frame 的 220px 是 CSS 兜底高度，卡片真实高度要靠 iframe 内的
 * RESIZE_SCRIPT 上报。上报到之前先显示 220px 灰块、然后「啪」一下变高，视觉上像闪了一下。
 * 这里只改「什么时候可见」和「怎么变高」，CSS 默认值和 clamp 一律不动。
 * 样式在 web/card-height.css，不在 style.css 里。
 */

const CARD_READY_TIMEOUT_MS = 2000;
const CARD_FALLBACK_HEIGHT = 220;

/** 默认定时器：返回取消函数，测试里换成假定时器推进时间。 */
const defaultSchedule = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** iframe -> { ready, cancelFallback }：就绪状态与兜底定时器都挂在这里，不污染元素。 */
const cardFrameState = new WeakMap();

function stateFor(iframe) {
  let state = cardFrameState.get(iframe);
  if (!state) {
    state = { ready: false, cancelFallback: null };
    cardFrameState.set(iframe, state);
  }
  return state;
}

/** 兜底高度：220px，但不超过 80vh，免得矮视口上一张空卡片把整屏顶下去。 */
function fallbackCardHeight() {
  let vh = 0;
  try {
    vh = typeof window !== 'undefined' && window ? Number(window.innerHeight) : 0;
  } catch { vh = 0; }
  if (!Number.isFinite(vh) || vh <= 0) return CARD_FALLBACK_HEIGHT;
  return Math.min(CARD_FALLBACK_HEIGHT, Math.round(vh * 0.8));
}

/** 写高度；第一次写的同时置就绪、准备淡入。height 必须是已 clamp 的有限正数。 */
function applyCardHeight(iframe, height) {
  const state = stateFor(iframe);
  if (state.cancelFallback) {
    state.cancelFallback();
    state.cancelFallback = null;
  }
  iframe.style.height = `${height}px`;
  if (state.ready) return;
  state.ready = true;
  // 先把新高度结算掉，再让 CSS 打开 transition：
  // 否则 220px → 真实高度这一下也会被动画，首帧照样「跳」，只是慢一点。
  void iframe.offsetHeight;
  iframe.setAttribute('data-card-ready', '1');
}

/** 新建卡片 iframe 时调用：标未就绪，并挂上 2 秒兜底。返回取消兜底的回调。 */
function markCardPending(iframe, schedule = defaultSchedule) {
  const state = stateFor(iframe);
  if (state.cancelFallback) {
    state.cancelFallback();
    state.cancelFallback = null;
  }
  if (!state.ready) iframe.setAttribute('data-card-ready', '0');
  // 硬要求：卡片脚本报错、跨源被拦时也必须显示出来，不能永远隐身。
  state.cancelFallback = schedule(() => {
    state.cancelFallback = null;
    if (state.ready) return;
    applyCardHeight(iframe, fallbackCardHeight());
  }, CARD_READY_TIMEOUT_MS);
  return () => {
    if (state.cancelFallback) {
      state.cancelFallback();
      state.cancelFallback = null;
    }
  };
}

/** 从一条事件里尽力找出卡片 HTML。字段名各版本可能不同，这里全兜一遍。 */
export function extractCardHtml(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const candidates = [
    ev.html,
    ev.srcdoc,
    ev.markup,
    ev.details?.code,
    ev.details?.html,
    ev.content,
    ev.card?.html,
    ev.card?.srcdoc,
    ev.card?.markup,
    ev.payload?.html,
    ev.data?.html,
    ev.data?.card?.html,
    ev.state?.html,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return null;
}

export function extractCardTitle(ev) {
  return (
    ev?.title ||
    ev?.card?.title ||
    ev?.payload?.title ||
    ev?.data?.title ||
    ev?.name ||
    '卡片'
  );
}

/**
 * 渲染一张卡片。
 * @param {string} html 卡片 HTML
 * @param {object} [options]
 * @param {string} [options.title] 卡片标题
 * @param {number} [options.maxHeight] 最大高度限制
 * @param {object} [options.hostBridge] 宿主桥控制器实例
 * @param {object} [options.context] 冻结卡片上下文
 * @returns {{ node: HTMLElement, iframe: HTMLIFrameElement, dispose: () => void }}
 */
export function renderCard(html, { title = '卡片', maxHeight = 0, hostBridge = null, context = null, schedule = defaultSchedule } = {}) {
  cardSeq += 1;
  const id = `card-${Date.now()}-${cardSeq}`;

  const wrap = document.createElement('div');
  wrap.className = 'card-block';

  const iframe = document.createElement('iframe');
  iframe.className = 'card-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', title);
  iframe.dataset.cardId = id;

  // 先标未就绪并挂兜底，再写文档：上报永远晚于这行，不会漏掉第一帧。
  const cancelPending = markCardPending(iframe, schedule);

  let registration = null;
  if (hostBridge && typeof hostBridge.register === 'function') {
    registration = hostBridge.register(iframe, context || {});
  }

  // 先注册并拿到 nonce，再写文档内容；不可信 HTML 无法窥探或替换 nonce
  if (maxHeight > 0) {
    iframe.style.maxHeight = `${maxHeight}px`;
  }
  iframe.srcdoc = buildSandboxedDoc(html, registration && registration.nonce);
  wrap.appendChild(iframe);

  const dispose = () => {
    cancelPending();
    if (hostBridge && typeof hostBridge.unregister === 'function') {
      hostBridge.unregister(iframe);
    }
  };

  return { node: wrap, iframe, dispose };
}

/** 挂一个全局监听，把卡片报上来的高度写回 iframe。 */
export function installCardHeightBridge({ window: win = globalThis.window, document: doc = globalThis.document } = {}) {
  if (!win || typeof win.addEventListener !== 'function') return;
  if (!doc || typeof doc.querySelectorAll !== 'function') return;
  win.addEventListener('message', (e) => {
    const h = e.data && e.data.__hanaCardHeight;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return;
    // 只处理来自我们自己的卡片 iframe
    const frames = doc.querySelectorAll('iframe.card-frame');
    for (const f of frames) {
      if (f.contentWindow === e.source) {
        const capped = Math.min(Math.max(h, 80), 4000);
        // 首次写高度顺便置就绪、淡入；之后就只是平滑变高。
        applyCardHeight(f, capped);
        break;
      }
    }
  });
}

function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 把卡片目录映射成网关上的虚拟地址。 */
export function cardUrlFor(dirPath) {
  if (!dirPath) return null;
  return `/gw/card/${b64url(dirPath)}/`;
}

/** 从事件里找出卡片目录（show_card 的 tool_end 会带 sessionFile）。 */
export function extractCardDir(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const candidates = [
    ev.details?.sessionFile?.realPath,
    ev.details?.sessionFile?.filePath,
    ev.details?.sessionFile?.path,
    ev.sessionFile?.realPath,
    ev.sessionFile?.filePath,
    ev.realPath,
    ev.filePath,
    ev.cardDir,
    ev.details?.cardDir,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/** 按目录渲染卡片（走网关的 /gw/card 虚拟路由，相对资源自然解析）。
 * @param {string} [options.sourceUrl] 父控制器 HEAD 校验后的同源最终 token URL；用于追加 nonce fragment。
 */
export function renderCardByPath(dirPath, { title = '卡片', maxHeight = 0, hostBridge = null, context = null, sourceUrl = null, schedule = defaultSchedule } = {}) {
  cardSeq += 1;
  const wrap = document.createElement('div');
  wrap.className = 'card-block';

  const iframe = document.createElement('iframe');
  iframe.className = 'card-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', title);
  iframe.dataset.cardId = `card-${Date.now()}-${cardSeq}`;
  if (maxHeight > 0) iframe.style.maxHeight = `${maxHeight}px`;

  const cancelPending = markCardPending(iframe, schedule);

  let registration = null;
  if (hostBridge && typeof hostBridge.register === 'function') {
    registration = hostBridge.register(iframe, context || {});
  }

  // sourceUrl 必须由父控制器 HEAD 校验为同源最终 token URL；这里只做同源兜底
  iframe.src = withBridgeNonce(resolveCardSource(dirPath, sourceUrl), registration && registration.nonce);
  wrap.appendChild(iframe);

  const dispose = () => {
    cancelPending();
    if (hostBridge && typeof hostBridge.unregister === 'function') {
      hostBridge.unregister(iframe);
    }
  };

  return { node: wrap, iframe, dispose };
}

/** 卡片找不到 HTML 时的占位条。 */
export function placeholderCard(title, raw) {
  const node = document.createElement('div');
  node.className = 'card-placeholder';

  const head = document.createElement('div');
  head.className = 'card-placeholder-title';
  head.textContent = title || '卡片';

  const sub = document.createElement('div');
  sub.className = 'card-placeholder-sub';
  sub.textContent = '这个版本还解析不出内容，点开看原始数据';

  node.appendChild(head);
  node.appendChild(sub);

  if (raw) {
    const pre = document.createElement('pre');
    pre.className = 'card-placeholder-raw';
    pre.hidden = true;
    pre.textContent = JSON.stringify(raw, null, 2).slice(0, 4000);
    node.appendChild(pre);
    node.addEventListener('click', () => {
      pre.hidden = !pre.hidden;
    });
  }

  return node;
}
