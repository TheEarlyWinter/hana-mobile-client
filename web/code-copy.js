/* web/code-copy.js — 代码块一键复制（E11）
 *
 * 管什么：
 *  - installCodeCopy({ root, doc }) 在消息列表 root 上装一次 click 委托：点中
 *    .md-code 里的 .code-copy-btn 时，复制该块 <pre> 的 textContent；
 *  - 返回 { sync(scope?) }：给 root（或某条消息子树）里还没有按钮的 .md-code 补按钮，
 *    幂等，重复调用不会重复加；
 *  - 复制结果用按钮文案反馈：「已复制」/「复制失败」，1.2 秒后复位成「复制」，不弹 alert。
 *
 * 不管什么：
 *  - 不改 md.js 的 HTML（renderMarkdown 是纯函数、被很多测试引用），按钮由 sync 在渲染后补；
 *  - 不改 style.css（按钮与 .code-lang 的共存样式在 web/code-copy.css）；
 *  - 不读全局 S、不发请求、不区分消息角色：根容器里的代码块一视同仁。
 *
 * 结构约定（与 style.css 的 .md-code 对齐）：
 *   <div class="md-code has-code-copy">
 *     <span class="code-lang">js</span>
 *     <pre><code>…</code></pre>
 *     <button class="code-copy-btn" type="button" aria-label="复制代码">复制</button>
 *   </div>
 *
 * 为什么按钮追加在块末尾、绝不进 <pre>：pre 的 textContent 就是要复制的内容，
 * 按钮一旦放进去，复制出来的文字会混进「复制」，流式重渲染也会把代码文本改脏。
 *
 * 依赖注入：doc / navigator / copy / timers 都可从参数传入（便于假 DOM 测试），
 * 默认取全局；模块顶层不摸 document。
 */



const BLOCK_CLASS = 'md-code';
/** 块上打这个标记，CSS 靠它把按钮的顶部留白带和语言标的位置接过来。 */
const BLOCK_READY_CLASS = 'has-code-copy';
const BUTTON_CLASS = 'code-copy-btn';
const LABEL_READY = '复制';
const LABEL_DONE = '已复制';
const LABEL_FAIL = '复制失败';
/** 反馈文案停留时长：够看清，又不至于一直挂着。 */
const RESET_MS = 1200;

/** 同一个 root 只装一次委托；重复调用返回同一个控制器，避免一次点击复制两遍。 */
const controllers = new WeakMap();

/**
 * 在 root 上装代码块复制。
 *
 * @param {object} options
 * @param {Element} options.root 消息列表容器（事件委托挂点，sync 的默认扫描范围）
 * @param {Document} [options.doc] 创建按钮用的 document
 * @param {Navigator} [options.navigator] 传给剪贴板实现的 navigator
 * @param {(text: string, deps: object) => Promise<{ok: boolean}>} copy 复制实现（必填，由装配层注入）
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] 复位定时器来源
 * @returns {{ sync: (scope?: Element) => number }}
 */
export function installCodeCopy({
  root,
  doc = globalThis.document,
  navigator: nav = globalThis.navigator,
  copy = null,
  timers = globalThis,
} = {}) {
  if (
    !root
    || typeof root.addEventListener !== 'function'
    || typeof root.querySelectorAll !== 'function'
  ) {
    throw new TypeError('installCodeCopy 需要一个支持 addEventListener / querySelectorAll 的 root 容器');
  }
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('installCodeCopy 需要一个能 createElement 的 document');
  }

  const existing = controllers.get(root);
  if (existing) return existing;

  const copyFn = typeof copy === 'function' ? copy : null;
  const timersApi = timers && typeof timers === 'object' ? timers : globalThis;
  const later = (fn, ms) => (
    typeof timersApi.setTimeout === 'function' ? timersApi.setTimeout(fn, ms) : null
  );
  const cancelLater = (id) => {
    if (id != null && typeof timersApi.clearTimeout === 'function') timersApi.clearTimeout(id);
  };

  /** 每个按钮自己的复位定时器，连点两次时先清掉上一次，避免提前复位。 */
  const resetTimers = new WeakMap();

  function setButtonState(btn, label, state) {
    if (state) btn.setAttribute('data-state', state);
    else if (typeof btn.removeAttribute === 'function') btn.removeAttribute('data-state');
    btn.textContent = label;
  }

  function flash(btn, label, state) {
    cancelLater(resetTimers.get(btn));
    resetTimers.delete(btn);
    setButtonState(btn, label, state);
    const id = later(() => {
      resetTimers.delete(btn);
      setButtonState(btn, LABEL_READY, '');
    }, RESET_MS);
    if (id != null) resetTimers.set(btn, id);
  }

  async function runCopy(btn, text) {
    let result = null;
    try {
      result = await copyFn(text, { navigator: nav, document: doc });
    } catch {
      // 复制实现自己抛错：同样按失败反馈，不把异常漏给页面。
      result = null;
    }
    // 流式重渲染可能已经把按钮换掉：孤儿节点不再写状态。
    if (btn && btn.isConnected === false) return;
    if (result && result.ok) flash(btn, LABEL_DONE, 'done');
    else flash(btn, LABEL_FAIL, 'fail');
  }

  /** 从 node 往上找到第一个带 className 的祖先（含自身），到 root 为止。 */
  function findUp(node, className) {
    let cur = node;
    while (cur) {
      const list = cur.classList;
      if (list && typeof list.contains === 'function' && list.contains(className)) return cur;
      if (cur === root) break;
      cur = cur.parentNode;
    }
    return null;
  }

  function findButton(event) {
    const target = event && event.target;
    if (!target) return null;
    return findUp(target, BUTTON_CLASS);
  }

  function handleClick(event) {
    const btn = findButton(event);
    if (!btn) return;
    try {
      const block = findUp(btn, BLOCK_CLASS);
      if (!block) return;
      const pre = typeof block.querySelector === 'function' ? block.querySelector('pre') : null;
      if (!pre) return;
      const text = String(pre.textContent ?? '');
      if (!text.trim()) {
        // 正常不会出现（sync 不给空块按钮）；真点到就按失败反馈，不抛错。
        flash(btn, LABEL_FAIL, 'fail');
        return;
      }
      void runCopy(btn, text);
    } catch {
      flash(btn, LABEL_FAIL, 'fail');
    }
  }

  function createButton() {
    const btn = doc.createElement('button');
    btn.className = BUTTON_CLASS;
    if (typeof btn.setAttribute === 'function') {
      btn.setAttribute('type', 'button');
      btn.setAttribute('aria-label', '复制代码');
      btn.setAttribute('title', '复制代码');
    }
    btn.textContent = LABEL_READY;
    return btn;
  }

  /**
   * 给还没有按钮的 .md-code 补一个按钮。
   *
   * @param {Element} [scope] 只扫这棵子树（流式渲染时传当前消息节点可省掉全表遍历）
   * @returns {number} 本次新增的按钮数量；0 表示已经同步过
   */
  function sync(scope = root) {
    const host = scope && typeof scope.querySelectorAll === 'function' ? scope : root;
    const found = host.querySelectorAll(`.${BLOCK_CLASS}`);
    const blocks = Array.isArray(found) ? found : Array.from(found || []);
    let added = 0;

    for (const block of blocks) {
      if (!block || typeof block.querySelector !== 'function') continue;
      if (block.querySelector(`.${BUTTON_CLASS}`)) {
        // 幂等：已有按钮就保持原样（包括正在显示「已复制」的临时状态）。
        if (block.classList) block.classList.add(BLOCK_READY_CLASS);
        continue;
      }
      const pre = block.querySelector('pre');
      if (!pre) continue;
      // 空代码块没东西可复制，不给按钮，也就不给「复制失败」的假反馈。
      if (!String(pre.textContent ?? '').trim()) continue;
      block.appendChild(createButton());
      if (block.classList) block.classList.add(BLOCK_READY_CLASS);
      added += 1;
    }

    return added;
  }

  root.addEventListener('click', handleClick);

  const controller = { sync };
  controllers.set(root, controller);
  return controller;
}
