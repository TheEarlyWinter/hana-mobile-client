/* web/quote-bar.js — 输入框上方的引用条
 *
 * 管什么：
 *  - 记住「当前正在引用的一条消息」（同一时刻只有一条，重复 set 覆盖旧的）；
 *  - 把引用拼进消息正文：`> 作者：正文` + 空行 + 原文，供发送前调用 applyTo；
 *  - 画一条贴住输入框上沿的细横条：`引用` 标记 + 说话人名 + 单行省略的正文 + × 。
 *
 * 不管什么：
 *  - 不 import 任何模块、不监听全局事件（Escape、点击外部、页面切换都由调用方决定）；
 *  - 不碰输入框本身：applyTo(text) 只返回拼好的字符串，什么时候写、写不写由调用方决定；
 *  - 不替发送层判断「该不该清」：调用方在发送发起时取 getVersion()，成功后
 *    consume(version) 只收掉那一版；等待期间改选的新引用不会被旧发送误清。
 *
 * 降级：没有 mount 或没有 document 时所有方法都能调用、不抛错，get() 恒为 null，
 * applyTo(text) 原样返回，element 为 null。首页/未打开的输入区不需要引用条也能跑。
 *
 * 用法（由 app 层接线）：
 *   const quoteBar = createQuoteBar({ document, mount: $('composerCard'), onChange: syncSendButton });
 *   quoteBar.set({ text, author, at });          // 引用动作
 *   quoteBar.applyTo(input.value)                // 发送前拼正文
 *   const version = quoteBar.getVersion();       // 发送发起时取版本（与正文快照同一 tick）
 *   quoteBar.consume(version);                   // 发送成功后只清这一版
 *   quoteBar.clear();                            // 用户点 × / 换会话 / 登出
 */

const QUOTE_MARK = '引用';
const CANCEL_LABEL = '取消引用';
/** 引用正文最多带多少字（超出加省略号）。全文本来就在聊天记录里，不必搬进输入框。 */
const QUOTE_MAX_CHARS = 200;

/** 压成单行：统一换行、把换行折成空格、合并连续空白、去首尾空白。 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

/**
 * 规整外部传进来的引用：允许直接传字符串。
 * 正文为空视为「没有引用」（返回 null，等价于 clear）；作者/时间拿不到就不放进对象。
 */
function normalizeQuote(input) {
  if (!input) return null;
  const source = typeof input === 'string' ? { text: input } : input;
  const text = oneLine(source.text);
  if (!text) return null;

  // 只截一段：引用是「我说的是哪句」，不是把整段搬过来。全文已在下面一条消息里，
  // 不截的话一条千字消息会把输入框和发送体全顶爆。
  const clamped = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text;

  const quote = { text: clamped };
  const author = oneLine(source.author);
  if (author) quote.author = author;
  if (typeof source.at === 'number' && Number.isFinite(source.at)) {
    quote.at = source.at;
  } else if (typeof source.at === 'string' && source.at.trim() !== '') {
    quote.at = source.at.trim();
  }
  return quote;
}

/** 引用的那行 Markdown：有作者用 `> 作者：正文`，没有就 `> 正文`。 */
function quoteHead(quote) {
  return quote.author ? `> ${quote.author}：${quote.text}` : `> ${quote.text}`;
}

/**
 * 把引用拼到正文前面。
 *
 * 边界：
 *  - 没有引用时原样返回 text（一个字符都不动，包括首尾空白）；
 *  - 正文首尾空白丢掉，避免 `> 引用\n\n\n\n你好` 这种空行堆叠；
 *  - 正文已经以同一条引用开头就不再拼一遍（重复点「引用」、重复调用都安全）。
 */
function applyQuote(quote, text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (!quote) return raw;

  const head = quoteHead(quote);
  const body = raw.replace(/\r\n?/g, '\n').trim();
  if (body === head || body.startsWith(`${head}\n`)) return body;
  if (!body) return `${head}\n\n`;
  return `${head}\n\n${body}`;
}

/**
 * @param {object} [options]
 * @param {Document} [options.document] 建节点用；没有就整体降级
 * @param {Element} [options.mount] 容器（要支持 appendChild），引用条会 append 进去
 * @param {(quote: object|null) => void} [options.onChange] 引用变化回调（set / clear / × 都会调）
 * @returns {{ set: Function, clear: Function, get: Function, applyTo: Function, getVersion: Function, consume: Function, element: Element|null }}
 */
export function createQuoteBar({ document: doc, mount, onChange } = {}) {
  const usable = Boolean(
    doc
    && typeof doc.createElement === 'function'
    && mount
    && typeof mount.appendChild === 'function',
  );

  let current = null;
  // 版本号只回答一个问题：「发送发起时看到的那条引用，现在还是同一条吗」。
  // set / clear 都会推进它，所以旧发送手里的版本永远不会误伤后来改选的引用。
  let version = 0;
  let root = null;
  let authorEl = null;
  let textEl = null;

  function notify() {
    if (typeof onChange !== 'function') return;
    try {
      onChange(current ? { ...current } : null);
    } catch {
      // 宿主回调抛错不能拖垮引用条本身
    }
  }

  function build() {
    root = doc.createElement('div');
    root.className = 'quote-bar';
    root.hidden = true;
    root.setAttribute('role', 'note');
    root.setAttribute('aria-label', QUOTE_MARK);

    const mark = doc.createElement('span');
    mark.className = 'quote-bar-mark';
    mark.textContent = QUOTE_MARK;

    authorEl = doc.createElement('span');
    authorEl.className = 'quote-bar-author';
    authorEl.hidden = true;

    textEl = doc.createElement('span');
    textEl.className = 'quote-bar-text';

    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'quote-bar-cancel';
    cancel.setAttribute('aria-label', CANCEL_LABEL);
    cancel.textContent = '×';
    cancel.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      clear();
    });

    root.appendChild(mark);
    root.appendChild(authorEl);
    root.appendChild(textEl);
    root.appendChild(cancel);
    // 插到容器最前面：引用条要贴住输入框上沿，不是吊在工具栏下面。
  if (typeof mount.insertBefore === 'function' && mount.firstChild) mount.insertBefore(root, mount.firstChild);
  else mount.appendChild(root);
  }

  function render() {
    if (!root) return;
    root.hidden = !current;
    if (!current) {
      authorEl.hidden = true;
      authorEl.textContent = '';
      textEl.textContent = '';
      return;
    }
    const author = current.author || '';
    authorEl.hidden = author === '';
    authorEl.textContent = author;
    textEl.textContent = current.text;
  }

  /** 设一条引用（覆盖旧的）。传空正文 / null 等价于 clear；降级时不记状态。 */
  function set(input) {
    if (!usable) return null;
    const next = normalizeQuote(input);
    if (!next) {
      clear();
      return null;
    }
    current = next;
    version += 1;
    render();
    notify();
    return { ...current };
  }

  function clear() {
    const had = current !== null;
    current = null;
    version += 1;
    render();
    if (had) notify();
  }

  function get() {
    return current ? { ...current } : null;
  }

  function getVersion() {
    return version;
  }

  /**
   * 按版本消费：只有当前引用于还是发起时那一版才清掉。
   * 版本对不上（用户等待期间改选 / 清空 / 换了会话）就保持现状，返回 false。
   */
  function consume(token) {
    if (!current) return false;
    if (token !== version) return false;
    clear();
    return true;
  }

  function applyTo(text) {
    return applyQuote(current, text);
  }

  if (usable) build();

  return { set, clear, get, applyTo, getVersion, consume, element: root };
}
