/* web/lightbox.js — 图片全屏查看（E12）
 *
 * 管什么：
 *  - createLightbox({ doc, mount, onClose }) 造一个全屏看图器，返回
 *    { open(items, startIndex), close(), isOpen(), next(), prev(), getState() }；
 *  - items 是 [{ src, alt }]，可以多张：左右滑动 / 两侧箭头 / 键盘左右切换，顶部显示「3 / 7」；
 *  - 双指捏合缩放（1x–4x）、双击在 1x / 2x 之间切换；放大时拖动是平移，边界夹住；
 *  - 未放大时横向拖动超过屏宽 15% 才翻页；下滑超过同样阈值关闭；
 *  - 不拖动的一次点按关闭（留 220ms 给双击判定）；Esc 关闭，←/→ 切换；
 *  - 切换图片即复原缩放与平移（不记忆每张的状态），简单可预期。
 *
 * 不管什么：
 *  - 不碰 style.css / app.js / index.html / chat-renderer.js：类名统一 lightbox- 前缀，
 *    样式在 web/lightbox.css，接线由装配层做；
 *  - 不预加载、不发请求、不读写全局 S。
 *
 * 依赖注入：doc / mount / win / timers / now / keyTarget 都能从参数传入（便于假 DOM 测试），
 * 模块顶层不摸 document；缺少 doc 才抛错，mount 缺省落到 doc.body。
 *
 * 手势判定拆成纯函数 resolveDrag()，手势层只负责收集 dx/dy 和接线：
 *   resolveDrag({ dx, dy, scale, width }) → 'next' | 'prev' | 'close' | 'pan' | 'none'
 */

/** 缩放区间与双击目标倍数。 */
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const ZOOM_SCALE = 2;

/** 翻页 / 关闭的阈值：屏宽的 15%，但不小于 24px（小屏也拖得动）。 */
export const SWIPE_RATIO = 0.15;
export const SWIPE_MIN_PX = 24;

/** 拿不到视口尺寸时的兜底（测试里也不会走到：假 DOM 有 innerWidth）。 */
const DEFAULT_VIEW_WIDTH = 360;
const DEFAULT_VIEW_HEIGHT = 640;

/** 小于这个位移算「点按」而不是拖动。 */
const TAP_SLOP_PX = 8;
/** 两次点按在这个时间（且这个距离）内算双击。 */
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SLOP_PX = 40;
/** 单击关闭的延迟：给双击留窗口，避免「想放大结果关了」。 */
const TAP_CLOSE_MS = 220;
/** 拖到首/末张还不能翻页时，跟手的阻尼（0.35 = 拖 100px 只动 35px）。 */
const EDGE_DAMP = 0.35;

const EPS = 1e-6;

/* ------------------------------ 纯函数 ------------------------------ */

/**
 * 算翻页 / 关闭的位移阈值。
 *
 * @param {number} width 视口宽度（px）
 * @param {number} [threshold] 显式阈值（px），给了就以它为准（但不小于 SWIPE_MIN_PX）
 * @returns {number} 像素阈值
 */
export function resolveSwipeLimit(width = 0, threshold = null) {
  if (Number.isFinite(threshold) && threshold > 0) return Math.max(SWIPE_MIN_PX, Number(threshold));
  const w = Number.isFinite(width) && width > 0 ? Number(width) : DEFAULT_VIEW_WIDTH;
  return Math.max(SWIPE_MIN_PX, w * SWIPE_RATIO);
}

/**
 * 一次拖动该怎么解释。纯函数，不碰 DOM，测试直接喂数字。
 *
 * 判定顺序：
 *  1. 放大状态（scale > 1）一律 'pan'：既不能翻页也不能被误判成关闭；
 *  2. 横向位移过阈值且横向占优（|dx| >= |dy|）→ 左拖 'next'、右拖 'prev'；
 *  3. 向下位移过阈值且纵向占优 → 'close'（上滑不关闭）；
 *  4. 其余 'none'（回位，什么都不做）。
 *
 * @param {{dx?: number, dy?: number, scale?: number, width?: number, threshold?: number}} gesture
 * @returns {'next'|'prev'|'close'|'pan'|'none'}
 */
export function resolveDrag({ dx = 0, dy = 0, scale = MIN_SCALE, width = 0, threshold = null } = {}) {
  const x = Number.isFinite(dx) ? dx : 0;
  const y = Number.isFinite(dy) ? dy : 0;
  const currentScale = Number.isFinite(scale) ? scale : MIN_SCALE;
  if (currentScale > MIN_SCALE + EPS) return 'pan';

  const limit = resolveSwipeLimit(width, threshold);
  const absX = Math.abs(x);
  const absY = Math.abs(y);

  if (absX >= limit && absX >= absY) return x < 0 ? 'next' : 'prev';
  if (y >= limit && y > absX) return 'close';
  return 'none';
}

/* ------------------------------ 工具 ------------------------------ */

function normalizeItems(items) {
  const source = Array.isArray(items) ? items : (items ? [items] : []);
  const list = [];
  for (const item of source) {
    if (!item) continue;
    const src = typeof item === 'string' ? item : item.src;
    if (!src) continue;
    const alt = typeof item === 'string' ? '' : item.alt;
    list.push({ src: String(src), alt: alt == null ? '' : String(alt) });
  }
  return list;
}

function distance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

function readPoint(event) {
  if (!event) return null;
  const x = Number(event.clientX);
  const y = Number(event.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { id: Number.isFinite(event.pointerId) ? event.pointerId : 1, x, y };
}

function setAttrs(node, attrs) {
  if (!node || typeof node.setAttribute !== 'function') return;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
}

/* ------------------------------ 工厂 ------------------------------ */

/**
 * 造一个全屏看图器。
 *
 * @param {object} [options]
 * @param {Document} [options.doc] 默认 globalThis.document
 * @param {Element} [options.mount] 灯箱挂载点，默认 doc.body
 * @param {() => void} [options.onClose] 关闭回调（每次关闭恰好一次；重开时另一组图不回调）
 * @param {EventTarget} [options.keyTarget] 键盘监听挂点，默认 doc
 * @param {Window} [options.win] 量视口 / 挂 resize 用，默认 globalThis
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] 单击关闭的延迟定时器
 * @param {() => number} [options.now] 时间源（双击判定）
 * @param {number} [options.threshold] 覆盖默认的拖动阈值（px）
 * @returns {{open: Function, close: Function, isOpen: Function, next: Function, prev: Function, getState: Function}}
 */
export function createLightbox({
  doc = globalThis.document,
  mount = null,
  onClose = null,
  keyTarget = null,
  win = globalThis,
  timers = globalThis,
  now = () => Date.now(),
  threshold = null,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createLightbox 需要一个能 createElement 的 document');
  }
  const host = mount || doc.body;
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createLightbox 需要一个能 appendChild 的 mount 容器');
  }
  const keyHost = keyTarget && typeof keyTarget.addEventListener === 'function' ? keyTarget : doc;

  const state = {
    open: false,
    items: [],
    index: 0,
    scale: MIN_SCALE,
    panX: 0,
    panY: 0,
  };

  let root = null;
  let stage = null;
  let track = null;
  let counter = null;
  let prevBtn = null;
  let nextBtn = null;
  let closeBtn = null;
  let images = [];

  /** 当前按在屏上的手指：pointerId → { id, x, y }。 */
  let pointers = new Map();
  /** 本次手势的起点快照；null 表示没有进行中的手势。 */
  let gesture = null;
  let lastTap = { at: 0, x: 0, y: 0 };
  let tapTimer = null;

  const timerApi = timers && typeof timers === 'object' ? timers : globalThis;
  const clock = typeof now === 'function' ? now : () => Date.now();

  /* --------------------------- 量尺寸 --------------------------- */

  function viewSize() {
    let rect = null;
    if (root && typeof root.getBoundingClientRect === 'function') rect = root.getBoundingClientRect();
    const rawW = rect && rect.width > 0 ? rect.width : Number(win && win.innerWidth);
    const rawH = rect && rect.height > 0 ? rect.height : Number(win && win.innerHeight);
    return {
      width: Number.isFinite(rawW) && rawW > 0 ? rawW : DEFAULT_VIEW_WIDTH,
      height: Number.isFinite(rawH) && rawH > 0 ? rawH : DEFAULT_VIEW_HEIGHT,
    };
  }

  /**
   * 当前图「显示出来」的布局尺寸；量不到就退回视口，保证夹边不会失效成「无限平铺」。
   * 注意 getBoundingClientRect 含 transform，必须先除回当前 scale，否则放大后边界会跟着变大。
   */
  function imageSize() {
    const img = images[state.index];
    if (img) {
      const w = Number(img.offsetWidth);
      const h = Number(img.offsetHeight);
      if (w > 0 && h > 0) return { width: w, height: h };
      if (typeof img.getBoundingClientRect === 'function') {
        const rect = img.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          const s = state.scale > EPS ? state.scale : 1;
          return { width: rect.width / s, height: rect.height / s };
        }
      }
    }
    return viewSize();
  }

  /* --------------------------- 变换 --------------------------- */

  function applyTrack(offsetPx = 0, animate = false) {
    if (!track) return;
    const { width } = viewSize();
    const base = -state.index * width;
    track.style.transition = animate ? 'transform 220ms cubic-bezier(.22, .61, .36, 1)' : 'none';
    track.style.transform = `translate3d(${base + offsetPx}px, 0, 0)`;
  }

  /** 下拉跟手：舞台整体下移并淡出（背景暗层留在原位，不露出页面）。 */
  function applyDragOffset(dy) {
    if (!stage || !stage.style) return;
    const offset = Math.max(0, dy) * 0.6;
    stage.style.transition = 'none';
    stage.style.transform = `translate3d(0, ${offset}px, 0)`;
    stage.style.opacity = String(Math.max(0.35, 1 - offset / 700));
  }

  function resetDragOffset(animate) {
    if (!stage || !stage.style) return;
    stage.style.transition = animate ? 'transform 200ms ease-out, opacity 200ms ease-out' : 'none';
    stage.style.transform = '';
    stage.style.opacity = '';
  }

  function clampPan() {
    const { width, height } = imageSize();
    // 放大后多出来的部分每边各一半，中心对齐时最多能平移到那里。
    const maxX = Math.max(0, (state.scale - 1) * width / 2);
    const maxY = Math.max(0, (state.scale - 1) * height / 2);
    state.panX = Math.min(maxX, Math.max(-maxX, state.panX));
    state.panY = Math.min(maxY, Math.max(-maxY, state.panY));
  }

  function renderImage() {
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      if (!img || !img.style) continue;
      if (i !== state.index) {
        img.style.transform = '';
        continue;
      }
      const flat = state.scale <= MIN_SCALE + EPS && state.panX === 0 && state.panY === 0;
      img.style.transform = flat
        ? ''
        : `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.scale})`;
    }
  }

  function setScale(next, anchor = null) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(next) ? next : MIN_SCALE));
    const ratio = state.scale > EPS ? scale / state.scale : 1;
    if (anchor) {
      // 让锚点下的像素留在原地：contentX = (p - pan) / scale，解 pan' = p - contentX * scale'
      state.panX = anchor.x - (anchor.x - state.panX) * ratio;
      state.panY = anchor.y - (anchor.y - state.panY) * ratio;
    }
    state.scale = scale;
    if (scale <= MIN_SCALE + EPS) {
      state.panX = 0;
      state.panY = 0;
    }
    clampPan();
    renderImage();
  }

  function setPan(x, y) {
    state.panX = x;
    state.panY = y;
    clampPan();
    renderImage();
  }

  function resetZoom() {
    state.scale = MIN_SCALE;
    state.panX = 0;
    state.panY = 0;
    renderImage();
  }

  /* --------------------------- 索引 / 计数 --------------------------- */

  function clampIndex(value) {
    const count = state.items.length;
    if (!count) return 0;
    const n = Number.isFinite(value) ? Math.trunc(value) : 0;
    if (n < 0) return 0;
    if (n > count - 1) return count - 1;
    return n;
  }

  function renderCounter() {
    if (!counter) return;
    counter.textContent = `${state.index + 1} / ${state.items.length}`;
  }

  function renderNav() {
    const count = state.items.length;
    const single = count <= 1;
    if (root && root.classList) root.classList.toggle('is-single', single);
    if (prevBtn) {
      prevBtn.disabled = state.index <= 0;
      prevBtn.hidden = single;
    }
    if (nextBtn) {
      nextBtn.disabled = state.index >= count - 1;
      nextBtn.hidden = single;
    }
  }

  /** 切到第 target 张（夹住，不循环）。返回是否真的换了图。 */
  function goTo(target) {
    const next = clampIndex(target);
    if (next === state.index) return false;
    state.index = next;
    resetZoom();
    renderCounter();
    renderNav();
    applyTrack(0, true);
    return true;
  }

  function next() {
    if (!state.open) return false;
    return goTo(state.index + 1);
  }

  function prev() {
    if (!state.open) return false;
    return goTo(state.index - 1);
  }

  /* --------------------------- 单击 / 双击 --------------------------- */

  function cancelTapClose() {
    if (tapTimer == null) return;
    if (typeof timerApi.clearTimeout === 'function') timerApi.clearTimeout(tapTimer);
    tapTimer = null;
  }

  function scheduleTapClose() {
    cancelTapClose();
    if (typeof timerApi.setTimeout !== 'function') return;
    tapTimer = timerApi.setTimeout(() => {
      tapTimer = null;
      close();
    }, TAP_CLOSE_MS);
  }

  function toggleZoom(x, y) {
    if (state.scale > MIN_SCALE + EPS) {
      setScale(MIN_SCALE);
      return;
    }
    // 以点按位置为中心放大：把屏幕点换算成「相对图片中心」的偏移。
    // 量不到尺寸（隐藏中 / 合成事件）就退回居中放大，否则锚点会把图甩出边界。
    let rect = null;
    if (root && typeof root.getBoundingClientRect === 'function') rect = root.getBoundingClientRect();
    const measurable = rect && rect.width > 0 && rect.height > 0;
    const anchor = measurable
      ? { x: x - (rect.left + rect.width / 2), y: y - (rect.top + rect.height / 2) }
      : { x: 0, y: 0 };
    setScale(ZOOM_SCALE, anchor);
  }

  function handleTap(x, y) {
    const at = clock();
    const isDouble = (at - lastTap.at) <= DOUBLE_TAP_MS
      && Math.abs(x - lastTap.x) <= DOUBLE_TAP_SLOP_PX
      && Math.abs(y - lastTap.y) <= DOUBLE_TAP_SLOP_PX;
    if (isDouble) {
      lastTap = { at: 0, x: 0, y: 0 };
      cancelTapClose();
      toggleZoom(x, y);
      return;
    }
    lastTap = { at, x, y };
    scheduleTapClose();
  }

  /* --------------------------- 手势 --------------------------- */

  function isControl(node) {
    let cur = node;
    while (cur && cur !== root) {
      const cls = cur.className;
      if (typeof cls === 'string' && cls.split(/\s+/).indexOf('lightbox-btn') !== -1) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function capturePointer(id) {
    if (root && typeof root.setPointerCapture === 'function') {
      try {
        root.setPointerCapture(id);
      } catch {
        // 合成事件 / 老浏览器没有指针捕获：不影响后续逻辑
      }
    }
  }

  function releasePointer(id) {
    if (root && typeof root.releasePointerCapture === 'function') {
      try {
        root.releasePointerCapture(id);
      } catch {
        // 同上
      }
    }
  }

  /** 首/末张继续往外交界拖时给阻尼，手感上「拖不动了」。 */
  function edgeDamped(dx) {
    const atEdge = (state.index === 0 && dx > 0)
      || (state.index === state.items.length - 1 && dx < 0);
    return atEdge ? dx * EDGE_DAMP : dx;
  }

  function onPointerDown(event) {
    if (!state.open || !event) return;
    // 点在箭头 / 关闭按钮上：交给按钮的 click，不当手势起点
    if (isControl(event.target)) return;
    const point = readPoint(event);
    if (!point) return;
    pointers.set(point.id, point);

    if (pointers.size === 1) {
      gesture = {
        mode: 'drag',
        startX: point.x,
        startY: point.y,
        startScale: state.scale,
        startPanX: state.panX,
        startPanY: state.panY,
        pinchStart: 0,
        moved: false,
      };
      if (root.classList) root.classList.add('is-dragging');
      capturePointer(point.id);
      return;
    }

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      // 第一根手指可能已经拖偏了轨道/舞台：捏合前先归位，否则缩放会「歪着」发生
      applyTrack(0, false);
      resetDragOffset(false);
      gesture = {
        mode: 'pinch',
        startX: a.x,
        startY: a.y,
        startScale: state.scale,
        startPanX: state.panX,
        startPanY: state.panY,
        pinchStart: distance(a, b),
        moved: true,
      };
    }
    // 第三根及以上手指：忽略，只按前两根算
  }

  function onPointerMove(event) {
    if (!state.open || !gesture || !event) return;
    const id = Number.isFinite(event.pointerId) ? event.pointerId : 1;
    if (!pointers.has(id)) return;
    const point = readPoint(event);
    if (!point) return;
    pointers.set(id, point);

    if (gesture.mode === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const span = distance(a, b);
      if (gesture.pinchStart > EPS) setScale(gesture.startScale * (span / gesture.pinchStart));
      return;
    }
    if (gesture.mode !== 'drag') return;

    const dx = point.x - gesture.startX;
    const dy = point.y - gesture.startY;
    if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) gesture.moved = true;

    // 放大状态下只平移，绝不翻页（与 resolveDrag 的 'pan' 判定一致）
    if (gesture.startScale > MIN_SCALE + EPS) {
      setPan(gesture.startPanX + dx, gesture.startPanY + dy);
      return;
    }
    if (Math.abs(dx) >= Math.abs(dy)) applyTrack(edgeDamped(dx), false);
    else if (dy > 0) applyDragOffset(dy);
  }

  function onPointerEnd(event) {
    if (!state.open || !gesture || !event) return;
    const id = Number.isFinite(event.pointerId) ? event.pointerId : 1;
    const known = pointers.get(id);
    if (!known) return;
    const point = readPoint(event) || known;
    pointers.delete(id);
    releasePointer(id);

    if (pointers.size >= 1) {
      // 还按着手指（多半是捏合松了一根）：结束捏合，保留缩放，别把剩下的手指当拖动
      if (gesture.mode === 'pinch') gesture.mode = 'wait';
      return;
    }

    const done = gesture;
    gesture = null;
    if (root.classList) root.classList.remove('is-dragging');

    // 浏览器把手势抢走了（来电、切换应用…）：只回位，既不算点按也不算翻页
    if (event.type === 'pointercancel') {
      snapBack();
      return;
    }

    if (done.mode === 'pinch' || done.mode === 'wait') {
      snapBack();
      return;
    }

    if (!done.moved) {
      handleTap(point.x, point.y);
      return;
    }

    const { width } = viewSize();
    const action = resolveDrag({
      dx: point.x - done.startX,
      dy: point.y - done.startY,
      scale: done.startScale,
      width,
      threshold,
    });

    if (action === 'next' && goTo(state.index + 1)) return;
    if (action === 'prev' && goTo(state.index - 1)) return;
    if (action === 'close') {
      close();
      return;
    }
    // 'pan' / 'none' / 已到首末张：只回位
    snapBack();
  }

  function snapBack() {
    applyTrack(0, true);
    resetDragOffset(true);
  }

  /* --------------------------- 键盘 / 尺寸 --------------------------- */

  function onKeyDown(event) {
    if (!state.open || !event || !event.key) return;
    if (event.key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowRight') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      next();
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      prev();
    }
  }

  function onResize() {
    if (!state.open) return;
    clampPan();
    renderImage();
    applyTrack(0, false);
    resetDragOffset(false);
  }

  /* --------------------------- DOM --------------------------- */

  function makeButton(className, label, text) {
    const btn = doc.createElement('button');
    btn.className = className;
    setAttrs(btn, { type: 'button', 'aria-label': label, title: label });
    btn.textContent = text;
    return btn;
  }

  function build() {
    root = doc.createElement('div');
    root.className = 'lightbox-root';
    setAttrs(root, { role: 'dialog', 'aria-modal': 'true', 'aria-label': '查看图片' });

    stage = doc.createElement('div');
    stage.className = 'lightbox-stage';

    track = doc.createElement('div');
    track.className = 'lightbox-track';

    images = [];
    for (const item of state.items) {
      const page = doc.createElement('div');
      page.className = 'lightbox-page';
      const img = doc.createElement('img');
      img.className = 'lightbox-img';
      img.src = item.src;
      img.alt = item.alt || '图片';
      setAttrs(img, { draggable: 'false', decoding: 'async' });
      page.appendChild(img);
      track.appendChild(page);
      images.push(img);
    }

    stage.appendChild(track);
    root.appendChild(stage);

    prevBtn = makeButton('lightbox-btn lightbox-nav lightbox-prev', '上一张', '‹');
    nextBtn = makeButton('lightbox-btn lightbox-nav lightbox-next', '下一张', '›');
    root.appendChild(prevBtn);
    root.appendChild(nextBtn);

    const bar = doc.createElement('div');
    bar.className = 'lightbox-bar';
    counter = doc.createElement('span');
    counter.className = 'lightbox-counter';
    setAttrs(counter, { 'aria-live': 'polite' });
    closeBtn = makeButton('lightbox-btn lightbox-close', '关闭', '×');
    bar.appendChild(counter);
    bar.appendChild(closeBtn);
    root.appendChild(bar);
  }

  function bind() {
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerEnd);
    root.addEventListener('pointercancel', onPointerEnd);
    if (prevBtn) prevBtn.addEventListener('click', onPrevClick);
    if (nextBtn) nextBtn.addEventListener('click', onNextClick);
    if (closeBtn) closeBtn.addEventListener('click', onCloseClick);
    if (keyHost && typeof keyHost.addEventListener === 'function') {
      keyHost.addEventListener('keydown', onKeyDown);
    }
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);
  }

  function unbind() {
    if (root) {
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerEnd);
      root.removeEventListener('pointercancel', onPointerEnd);
    }
    if (prevBtn) prevBtn.removeEventListener('click', onPrevClick);
    if (nextBtn) nextBtn.removeEventListener('click', onNextClick);
    if (closeBtn) closeBtn.removeEventListener('click', onCloseClick);
    if (keyHost && typeof keyHost.removeEventListener === 'function') {
      keyHost.removeEventListener('keydown', onKeyDown);
    }
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
  }

  function onPrevClick(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    prev();
  }

  function onNextClick(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    next();
  }

  function onCloseClick(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    close();
  }

  /* --------------------------- 生命周期 --------------------------- */

  function teardown(notify) {
    cancelTapClose();
    unbind();
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    stage = null;
    track = null;
    counter = null;
    prevBtn = null;
    nextBtn = null;
    closeBtn = null;
    images = [];
    pointers = new Map();
    gesture = null;
    lastTap = { at: 0, x: 0, y: 0 };

    const wasOpen = state.open;
    state.open = false;
    state.items = [];
    state.index = 0;
    state.scale = MIN_SCALE;
    state.panX = 0;
    state.panY = 0;

    if (wasOpen && notify && typeof onClose === 'function') onClose();
  }

  /**
   * 打开一组图。
   *
   * @param {Array<{src: string, alt?: string}>} items
   * @param {number} [startIndex] 从第几张开始（越界夹住）
   * @returns {boolean} 是否真的打开了（空列表返回 false）
   */
  function open(items, startIndex = 0) {
    const list = normalizeItems(items);
    if (!list.length) return false;
    // 已经开着就直接换一组：这是「重开」，不是关闭，不回调 onClose
    if (state.open) teardown(false);

    state.items = list;
    state.index = clampIndex(startIndex);
    state.scale = MIN_SCALE;
    state.panX = 0;
    state.panY = 0;
    state.open = true;
    pointers = new Map();
    gesture = null;
    lastTap = { at: 0, x: 0, y: 0 };

    build();
    host.appendChild(root);
    renderCounter();
    renderNav();
    renderImage();
    applyTrack(0, false);
    bind();
    return true;
  }

  /** 关闭并清理 DOM；重复调用安全，onClose 每次关闭只回调一次。 */
  function close() {
    if (!state.open) return false;
    teardown(true);
    return true;
  }

  function isOpen() {
    return state.open;
  }

  /** 只读快照，给测试和装配层观察状态用。 */
  function getState() {
    return {
      open: state.open,
      index: state.index,
      count: state.items.length,
      scale: state.scale,
      panX: state.panX,
      panY: state.panY,
    };
  }

  return { open, close, isOpen, next, prev, getState };
}
