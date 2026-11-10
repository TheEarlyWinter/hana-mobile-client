/* web/connection-banner.js — E9 断线告知（顶部细条）
 *
 * 为什么单独一个模块：这条细条要解决的其实是「状态抖动」，跟断线检测本身无关。
 * 它只吃一个字符串状态，不碰 S、不发请求、不 import 任何业务模块，
 * 所以可以用假 DOM + 假时钟单独测（tests/connection_banner.test.mjs）。
 *
 * 状态词表（与 websocket-client 的 onStatusChange 一一对应）：
 *   connecting   正在建立连接（首屏 / 手动重连 / 自动重连）。不提示：首屏还没连上不算故障。
 *   connected    已连上。之前提示过断线 → 换成「连接已恢复」并 2 秒后自消；
 *                其余情况（包括首屏第一次连上）什么都不显示。
 *   reconnecting 断开且会自动重连 → 抖动一下再报（默认 600ms），避免瞬断闪屏。
 *   disconnected 断开且不会重连 → 与 reconnecting 同样处理（对用户来说是同一件事）。
 *   closed       主动断开（退出登录 / 回首页）→ 立刻收掉，不提示。
 *
 * 抖动保护（父代理要求的三条）：
 *   1. 断开后延迟 600ms 才显示；这期间又连上，整条不出现；
 *   2. 恢复立即显示，2 秒后自己消失（不用点、不会留）；
 *   3. 「已恢复」还在屏上时又断了：同一条细条原地换文案，不重新出场/退场，
 *      避免「出现—消失—再出现」的闪烁。
 *
 * 定位与视觉：position: fixed 的顶部细条，不参与布局——既不占高度也不推内容，
 * 因此断开时聊天区不会跳；pointer-events: none，永远不吃点击、不挡滚动。
 * 具体选择（为什么是细条而不是弹窗 / 为什么断开用实色、恢复用浅底）见 connection-banner.css。
 */

const DEFAULT_SHOW_DELAY = 600;
const DEFAULT_HIDE_DELAY = 2000;

/** 表示「连接没了」的状态：对用户来说都是同一件事，走同一套延迟显示。 */
const DOWN_STATUSES = new Set(['reconnecting', 'disconnected']);

/** 只认非负数；其余（undefined / null / NaN / 负数）一律退回默认值。 */
function delayOf(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * @param {object} [options]
 * @param {Document} [options.doc] DOM 工厂，杜绝全局隐式读取
 * @param {HTMLElement} [options.mount] 挂载点，默认 doc.body（细条是 fixed 定位，挂哪都不影响布局）
 * @param {() => number} [options.now] 取当前时间（毫秒）；用来复核定时器是否真的等够了
 * @param {number|{show?: number, hide?: number}} [options.delayMs]
 *        默认 600：数字只改「断开后多久显示」；对象可同时改显示延迟与恢复态停留时间
 * @param {(fn: Function, ms: number) => any} [options.setTimeout] 定时器（测试注入假时钟）
 * @param {(id: any) => void} [options.clearTimeout] 取消定时器（测试注入假时钟）
 * @param {{down?: string, up?: string}} [options.labels] 覆盖两句文案
 * @returns {{update: (status: string) => void, dispose: () => void}}
 */
export function createConnectionBanner({
  doc,
  mount = null,
  now = () => Date.now(),
  delayMs = DEFAULT_SHOW_DELAY,
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: cancel = (id) => globalThis.clearTimeout(id),
  labels = {},
} = {}) {
  if (!doc) throw new Error('createConnectionBanner requires { document }');
  const host = mount || doc.body;
  if (!host) throw new Error('createConnectionBanner requires { mount }');

  const copy = {
    down: '连接已断开，正在重连…',
    up: '连接已恢复',
    ...labels,
  };

  const isDelayObject = delayMs && typeof delayMs === 'object';
  const showDelay = delayOf(isDelayObject ? delayMs.show : delayMs, DEFAULT_SHOW_DELAY);
  const hideDelay = delayOf(isDelayObject ? delayMs.hide : null, DEFAULT_HIDE_DELAY);

  const bar = doc.createElement('div');
  bar.className = 'connection-banner';
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.dataset.state = 'idle';

  const dot = doc.createElement('span');
  dot.className = 'connection-banner-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = doc.createElement('span');
  text.className = 'connection-banner-text';

  bar.appendChild(dot);
  bar.appendChild(text);
  host.appendChild(bar);

  // idle（什么都没显示）| pending-down（断线倒计时中）| down（正在报断线）| up（正在报已恢复）
  let phase = 'idle';
  let showTimer = null;
  let hideTimer = null;
  let downSince = 0;
  let disposed = false;

  function clearShowTimer() {
    if (showTimer === null) return;
    cancel(showTimer);
    showTimer = null;
  }

  function clearHideTimer() {
    if (hideTimer === null) return;
    cancel(hideTimer);
    hideTimer = null;
  }

  function paint(kind) {
    bar.classList.remove('is-down', 'is-up');
    bar.classList.add(kind === 'down' ? 'is-down' : 'is-up');
    bar.dataset.state = kind;
    text.textContent = kind === 'down' ? copy.down : copy.up;
    bar.hidden = false;
  }

  /** 收掉细条并复位（主动断开、恢复态到点、dispose 共用）。 */
  function reset() {
    clearShowTimer();
    clearHideTimer();
    phase = 'idle';
    bar.classList.remove('is-down', 'is-up');
    bar.hidden = true;
    bar.dataset.state = 'idle';
  }

  function showDown() {
    phase = 'down';
    clearHideTimer();
    paint('down');
  }

  function showUp() {
    phase = 'up';
    clearHideTimer();
    paint('up');
    hideTimer = schedule(() => {
      hideTimer = null;
      if (phase !== 'up') return;
      reset();
    }, hideDelay);
  }

  /**
   * 排「断开 600ms 后再显示」的定时器。
   *
   * 到点还要用 now() 复核一次真实经过的时间：浏览器会压后定时器（后台标签、省电模式），
   * 测试里也可能提前唤醒。没等够就按剩余时间重排，绝不提前冒出来。
   */
  function armShow(waitMs) {
    showTimer = schedule(() => {
      showTimer = null;
      if (phase !== 'pending-down') return;
      const waited = now() - downSince;
      if (waited < showDelay) {
        armShow(showDelay - waited);
        return;
      }
      showDown();
    }, waitMs);
  }

  function startPendingDown() {
    clearShowTimer();
    phase = 'pending-down';
    downSince = now();
    armShow(showDelay);
  }

  /**
   * 喂一个新状态。未知状态词一律忽略：宁可不显示，也不要因为调用方试了个新词就抛异常。
   * @param {string} status
   */
  function update(status) {
    if (disposed) return;
    const key = typeof status === 'string' ? status : '';

    if (key === 'closed') {
      // 退出登录 / 回首页：不是故障，别留着误导人。
      reset();
      return;
    }

    if (key === 'connected') {
      clearShowTimer();
      if (phase === 'down') { showUp(); return; }
      // pending-down（600ms 内的瞬断）：整条不出现；idle / up：保持现状。
      if (phase === 'pending-down') phase = 'idle';
      return;
    }

    if (key === 'connecting') {
      // 正在尝试连接：撤掉「即将显示」的倒计时；已经在屏上的提示保持不变——它说的就是这件事。
      clearShowTimer();
      if (phase === 'pending-down') phase = 'idle';
      return;
    }

    if (DOWN_STATUSES.has(key)) {
      clearHideTimer();                    // 恢复态的 2 秒窗口内又断了：别再按旧计划自消
      if (phase === 'down') return;         // 已经在报断线，重复状态不重排定时器
      if (phase === 'up') { showDown(); return; }  // 同一条细条原地换文案，不重新出场
      startPendingDown();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    else if (typeof bar.remove === 'function') bar.remove();
  }

  return { update, dispose };
}
