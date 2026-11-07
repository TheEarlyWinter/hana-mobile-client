/* web/scroll-pin.js — 「贴着底」这一条规则，只此一份
 *
 * 聊天主界面（chat-renderer）和闲聊面板（casual-view）都要同一套行为：
 * 新内容来了跟着走，用户往上翻就松手，用户翻回底部或自己发消息再挂上。
 * 这两处以前各写一遍，规则不一致（阈值 160 / 48、有没有记住意图），
 * 出了问题也得各修一遍。所以抽到这里，纯逻辑，不碰 DOM 之外的东西。
 *
 * 三个都是踩过的坑：
 *
 * 1. 贴底是「意图」，不是一次几何测量。
 *    列表整棵重建（replaceChildren）会把 scrollTop 打回 0，量出来永远在顶部；
 *    只有记住用户上一次的意图，重建之后才知道该不该跟到底。
 *
 * 2. 程序滚底同样会抛 scroll 事件。
 *    用它设过的位置（pinTarget）认出来，别当成「用户自己往上翻了」。
 *
 * 3. 图片、贴纸、字体是异步撑高的。
 *    滚完要补一帧；但如果这一帧里用户已经自己翻了，就不补，绝不把人拽下来。
 */

/**
 * @param {object} [options]
 * @param {object} [options.element]   滚动容器（固定元素）
 * @param {() => object} [options.getElement] 滚动容器（每次现取，容器可能被替换时用这个）
 * @param {number} [options.threshold] 距底部多少像素内算「贴着底」，默认 48
 * @param {(fn: Function) => void} [options.raf] 下一帧回调，默认全局 requestAnimationFrame
 */
export function createScrollPin(options = {}) {
  const fixedElement = options.element || null;
  const getElement = typeof options.getElement === 'function' ? options.getElement : null;
  const threshold = Number.isFinite(options.threshold) ? Math.max(0, options.threshold) : 48;
  const scheduleFrame = resolveRaf(options.raf);

  /** 用户意图：还贴着底吗。只在 onScroll / pin / reset 时变。 */
  let pinned = true;
  /** 用户真滚动次数，用来判断「这一帧里用户动过没有」。 */
  let scrollSeq = 0;
  /** 上一次程序滚底落到的位置，用来看出「这次 scroll 是我自己弄的」。 */
  let pinTarget = -1;
  /** 上一次观测到的 scrollTop，用来判断用户是往上还是往下。 */
  let lastTop = -1;
  /** 已经绑过 scroll 的元素，防止重复绑定。 */
  let attached = null;

  function resolveElement() {
    const node = getElement ? getElement() : fixedElement;
    return node || null;
  }

  function nearBottom() {
    const node = resolveElement();
    if (!node) return true;
    const total = Number(node.scrollHeight) || 0;
    const top = Number(node.scrollTop) || 0;
    const view = Number(node.clientHeight) || 0;
    // 内容比视口还短时按「到底」算，否则空列表会被判成不在底部。
    return total - top - view <= threshold;
  }

  function pinNow() {
    const node = resolveElement();
    if (!node) return false;
    node.scrollTop = node.scrollHeight;
    pinTarget = node.scrollTop;
    lastTop = node.scrollTop;
    return true;
  }

  /** 立即滚到底并重新挂钩，下一帧再补一次（异步内容可能这时才撑高）。 */
  function pin() {
    pinned = true;
    pinNow();
    const seq = scrollSeq;
    scheduleFrame(() => {
      // 这一帧里用户自己翻过，就别再拽回来。
      if (scrollSeq !== seq) return;
      if (!pinned) return;
      pinNow();
    });
  }

  /**
   * 内容变了之后调用。
   * @param {{force?: boolean}} [opts] force=true 无条件贴底（比如用户自己发的消息）
   * @returns {boolean} 有没有真的跟
   */
  function follow(opts = {}) {
    if (opts && opts.force) {
      pin();
      return true;
    }
    if (!pinned) return false;
    pinNow();
    return true;
  }

  /** 用户往上拖就脱钩的容差：小于这个位移当作抖动或亚像素舍入。 */
  const DRIFT = 2;

  /** 绑到 scroll 事件上，把用户意图记下来。 */
  function onScroll() {
    const node = resolveElement();
    if (!node) return pinned;
    const top = Number(node.scrollTop) || 0;

    // 程序滚底也会走到这里：位置和 pinTarget 一样就不是用户干的。
    if (top !== pinTarget) scrollSeq += 1;

    // 往上拖 = 用户要看历史，立刻脱钩，不看他离底部还有多远。
    // 以前只看距离（默认 48px / 聊天 160px），而流式内容涨得比手指快，
    // 用户永远被按在阈值内、怎么翻都被拽回去。方向才是意图。
    const wentUp = lastTop >= 0 && top < lastTop - DRIFT;
    lastTop = top;
    if (wentUp) {
      pinned = false;
      return pinned;
    }

    // 其余情况（往下翻、程序改位置、位置本来就停在历史处）依旧按距离判。
    pinned = nearBottom();
    return pinned;
  }

  /** 绑定容器的 scroll 事件；容器还没上屏时返回 false，下次调用再试。 */
  function attach() {
    const node = resolveElement();
    if (!node || typeof node.addEventListener !== 'function') return false;
    if (attached === node) return true;
    detach();
    node.addEventListener('scroll', onScroll, { passive: true });
    attached = node;
    return true;
  }

  function detach() {
    if (!attached || typeof attached.removeEventListener !== 'function') {
      attached = null;
      return;
    }
    attached.removeEventListener('scroll', onScroll);
    attached = null;
  }

  return {
    pin,
    follow,
    onScroll,
    attach,
    detach,
    nearBottom,
    isPinned: () => pinned,
    setPinned: (value) => { pinned = Boolean(value); },
    reset: () => { pinned = true; },
    threshold,
  };
}

function resolveRaf(injected) {
  if (typeof injected === 'function') return injected;
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof g.requestAnimationFrame === 'function') {
    return (fn) => g.requestAnimationFrame(fn);
  }
  return () => {};
}
