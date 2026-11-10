/* web/search-jump.js — 搜索结果点进去之后，跳到那条消息并高亮
 *
 * 宿主的搜索结果只给会话（sessionId / title / snippet / path / matchKind / messageCount），
 * 没有 messageId。想落到「那一条消息」，只能在会话打开之后按文本找：先扫已加载的 DOM，没有就
 * 往前翻历史，翻到有、翻不动、翻够预算或等超时为止。找到之后滚到眼前并闪一下。
 *
 * 四个关键决定：
 *   1. **多锚点**：原词往往被用户输得比正文短、甚至只截了一段，所以先试原词，再试 snippet
 *      （宿主给的命中位置附近的正文原文）里最长的无标点片段，长的先试、超长的切成窗口。
 *      命中即停，每个锚点就是一次整棵 DOM 扫描，所以锚点数量有上限。
 *   2. **翻页预算按会话体量估**：宿主不给「命中在第几条」，能当位置用的只有 messageCount。
 *      正文命中就按「盖住整个会话要几页」给预算，而不是一律撞 5 页上限。
 *   3. **title 命中且正文无锚点**：滚回会话顶部并给一句可见提示，不再静默停在底部。
 *   4. **超时不冒充「到头了」**：没翻完就只说没翻完，不滚顶部也不说「已到会话开头」。
 *
 * 为什么单独一个模块：
 *   - 它是一台带状态的异步机（翻页 + 截止时间 + 取消 + 高亮定时器），跟搜索面板的输入框
 *     毫无关系；面板只负责把 snippet 交出来。
 *   - 依赖全部注入（document / 容器 / loadOlder / 三个时间函数），假 DOM + 假时钟就能把
 *     翻页次数、超时、取消、dispose 全部测掉，不用等真网络、不用 sleep。
 *
 * 三条硬约束（父代理点名）：
 *   1. 同一时刻只跑一次定位。新调用把旧的判成 cancelled，并用 token 保证旧循环在下一个
 *      检查点立刻停手，绝不再翻页（不是「让旧的跑完再说」）。
 *   2. 整体有 timeoutMs 的截止时间。到点返回 timeout 并不再翻页，哪怕 loadOlder 还挂着。
 *   3. dispose 之后不再往 DOM 写任何东西；高亮定时器一并清掉，不会残留一个永久闪着的 turn。
 *
 * 为什么这里自带一份「按文本找 turn」而不是 import chat-renderer：
 * 渲染器会把 md / 卡片 / 附件一整条依赖链拖进来，而这里只需要「遍历 children 找 .turn」。
 * 装配时主代理如果把 chat-renderer 的 findTurnByText 传进来，就用注入的那份。
 */

/** 命中后加的 class；视觉（颜色、动画时长）由 CSS 决定，这里只负责加和删。 */
const HIGHLIGHT_CLASS = 'search-hit-flash';
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_TIMEOUT_MS = 12000;

/**
 * 宿主拉一页历史的实测成本（2026-11-09 真机，大会话）：
 * `/api/sessions/messages` 单次 7.5–8.4 秒，耗时全在宿主组装，下发只有几十毫秒。
 * 默认 12 秒的截止在这个量级上只够翻一页半——大会话搜早段内容必然超时。
 * 所以「正文命中 + 大会话」时按页数放宽，见 autoTimeoutMs()。
 */
const PAGE_COST_MS = 8000;

/** 自动放宽后的硬上限：再慢就不如让用户先用搜索面板缩小范围。 */
const MAX_TIMEOUT_MS = 45000;

/** 超过这个条数才当作「大会话」，放宽截止；小会话保持 12 秒，不为慢网络背锅。 */
const SLOW_SESSION_MIN_MESSAGES = 150;
const DEFAULT_HIGHLIGHT_MS = 1600;

/** 翻页硬上限：再长的会话也不在这里赌运气，超时与「退到顶部」兜底。 */
const DEFAULT_PAGE_CAP = 12;
/** 宿主历史分页每页条数（history-pager 装配时就是 50）；估算翻页预算要用。 */
const DEFAULT_PAGE_SIZE = 50;

/** snippet 片段做锚点的长度区间：太短容易撞上别处的同一句客套话，太长在渲染文本里几乎不可能逐字命中。 */
const MIN_ANCHOR_CHARS = 12;
const MAX_ANCHOR_CHARS = 40;
/** snippet 碎到连一段 12 字都没有时的兜底：最长那段至少这么长才当锚点，再短就纯碰运气。 */
const MIN_WEAK_ANCHOR_CHARS = 6;
/** 一次定位最多试几个锚点（含原词）：每多一个就是一次整棵 DOM 扫描。 */
const MAX_ANCHORS = 6;
/** 有正文 snippet、但宿主没给 messageCount 时，比基础预算多翻几页。 */
const SNIPPET_EXTRA_PAGES = 2;

/** 标题命中、正文里确实找不到锚点时的可见提示（第 3 条）。 */
const TITLE_TOP_HINT = '标题命中，已到会话开头';

/** 正文命中、翻完了也没锚到时的提示。静默失败看起来就是「搜索没生效」。 */
const CONTENT_MISS_HINT = '没找到包含这段内容的轮次';

/**
 * 超时的提示。
 *
 * 长会话一页要好几秒，预算用尽时我们根本没翻到头，不能说「没找到」（那是说谎），
 * 也不能不说——真机上就是这么沉默四十几秒，点完像什么都没发生。
 */
const TIMEOUT_HINT = '搜索太慢，没能在时限内翻完；换个更短的关键词试试';

/**
 * 页数预算用完时的提示。
 *
 * 和上面两条分开说：预算用完不等于翻到头，说「没找到」是谎（3111 条的会话
 * 只扫了前 5 页时就这么说过）。告诉用户「还在更早的历史里」才是实话。
 */
const BUDGET_HINT = '翻了设定的页数还没找到，可能还在更早的历史里';

/**
 * snippet 的切分点：标点与空白。
 *
 * 不用 `\p{P}`：那是 ES2018 的 Unicode 属性转义，壳里 WebView 的版本不保证一致。
 * 这份字符集覆盖中英文正文里实际会出现的标点（全角、半角、各种引号与破折号）。
 */
const ANCHOR_SEPARATORS = new Set(
  (
    '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' +
    '，。、；：？！…—–―～·「」『』《》〈〉（）【】〔〕“”‘’｛｝［］' +
    '＋－×÷＝＜＞＆＠＃＄％＾＊｜＼／￥' +
    ' \t\n\r\f\v\u00a0\u3000\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029'
  ),
);

/**
 * 遍历步数上限。DOM 正常是树，但假节点之间可能互相引用成环；
 * 有了这个上限，最坏情况也只是「没找到」，不会把页面卡死。
 */
const MAX_SCAN_STEPS = 50000;

/**
 * 把 snippet 切成「无标点」的连续片段（保持原顺序）。
 *
 * snippet 是宿主给的命中位置附近的正文原文，但它带着 `...` 截断标记与标点——直接整段拿去比
 * 几乎不可能逐字命中。按标点切开以后，剩下的每一段都应该是正文里原样存在的连续文字。
 *
 * @param {string|null|undefined} snippet
 * @returns {string[]}
 */
function snippetSegments(snippet) {
  const text = typeof snippet === 'string' ? snippet : '';
  const out = [];
  let cur = '';
  for (const ch of text) {
    if (ANCHOR_SEPARATORS.has(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 长片段的窗口：整段拿去比，渲染文本里差一两个字就永远不中。
 * 头、中、尾各切一个 MAX_ANCHOR_CHARS 的窗口轮流试，命中即停。
 *
 * @param {string} segment
 * @returns {string[]}
 */
function anchorWindows(segment) {
  const text = String(segment || '');
  if (!text) return [];
  if (text.length <= MAX_ANCHOR_CHARS) return [text];
  const mid = Math.floor((text.length - MAX_ANCHOR_CHARS) / 2);
  const starts = [0, mid, text.length - MAX_ANCHOR_CHARS];
  const out = [];
  for (const start of starts) {
    const win = text.slice(start, start + MAX_ANCHOR_CHARS);
    if (!out.includes(win)) out.push(win);
  }
  return out;
}

/**
 * 依次要试的锚点：原词优先（用户自己输的，最可信），再按 snippet 片段从长到短。
 *
 * 为什么长的先试：长的片段更少见，一次就落在正确那一轮的概率更高；短于 MIN_ANCHOR_CHARS 的
 * 碎片（「好的」「收到」这类）撞上别的轮次比命中目标还常见，干脆不当锚点。
 *
 * @param {string} query
 * @param {string|null|undefined} [snippet]
 * @returns {string[]}
 */
function anchorCandidates(query, snippet) {
  /** @type {string[]} */
  const anchors = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /** @param {string|null|undefined} text */
  const add = (text) => {
    const value = String(text == null ? '' : text).trim();
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    anchors.push(value);
    return true;
  };

  add(query);
  if (anchors.length >= MAX_ANCHORS) return anchors;

  // 先按长度降序排一次（等长的保持出现先后），后面两道都用这份顺序。
  const segments = snippetSegments(snippet)
    .map((text, index) => ({ text, index }))
    .sort((a, b) => (b.text.length - a.text.length) || (a.index - b.index));

  for (const seg of segments) {
    if (seg.text.length < MIN_ANCHOR_CHARS) continue;
    for (const win of anchorWindows(seg.text)) {
      if (anchors.length >= MAX_ANCHORS) return anchors;
      add(win);
    }
  }

  // snippet 碎到连一段 12 字都凑不出来（句子短、标点密）：退而取最长的那段。
  // 落到「同一种说法」的轮次比完全定位不到强；但只在这一条路上才用，
  // 而且不能短到「好的」「收到」这种随便哪儿都有的碎片。
  if (anchors.length <= 1 && segments.length) {
    const longest = segments[0];
    if (longest.text.length >= MIN_WEAK_ANCHOR_CHARS) add(longest.text);
  }

  return anchors;
}

/** 只认非负数；undefined / null / '' / NaN / 负数一律退回默认值。 */
function nonNegative(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function classListOf(node) {
  const list = node && node.classList;
  if (!list) return null;
  return typeof list.add === 'function' && typeof list.remove === 'function' ? list : null;
}

function hasClass(node, name) {
  const list = classListOf(node);
  if (list && typeof list.contains === 'function') return list.contains(name);
  const cls = typeof node.className === 'string' ? node.className : '';
  return cls.split(/\s+/).includes(name);
}

/** 不依赖 classList.toggle：假 DOM 里不一定有它。 */
function addClass(node, name) {
  if (!node) return;
  const list = classListOf(node);
  if (list) {
    list.add(name);
    return;
  }
  const cls = typeof node.className === 'string' ? node.className : '';
  if (cls.split(/\s+/).includes(name)) return;
  node.className = `${cls} ${name}`.trim();
}

function removeClass(node, name) {
  if (!node) return;
  const list = classListOf(node);
  if (list) {
    list.remove(name);
    return;
  }
  const cls = typeof node.className === 'string' ? node.className : '';
  if (!cls) return;
  node.className = cls.split(/\s+/).filter((part) => part && part !== name).join(' ');
}

function childrenOf(node) {
  const kids = node && node.children;
  return kids && typeof kids.length === 'number' ? kids : null;
}

/** 忽略大小写与空白差异：搜索词里的空格位置和渲染出来的文本几乎不会一模一样。 */
function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

/** 节点的文本；极简假节点没有 textContent 时退回自己拼（同样有步数上限）。 */
function textOf(node) {
  if (!node) return '';
  const direct = node.textContent;
  if (typeof direct === 'string') return direct;
  let out = '';
  const stack = [node];
  let steps = 0;
  while (stack.length && steps < MAX_SCAN_STEPS) {
    steps += 1;
    const cur = stack.pop();
    if (!cur) continue;
    const kids = childrenOf(cur);
    if (kids && kids.length) {
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
      continue;
    }
    const curText = cur.textContent;
    if (typeof curText === 'string') out += curText;
  }
  return out;
}

/**
 * 在消息区里按文本找「第一个命中的一轮」。
 *
 * 不用 querySelectorAll：仓库测试的假 DOM 只实现了极简查询，有的夹具干脆没有；
 * 这里要的又只是「深度优先、命中就停」，自己走 children 更省也更好控。
 * 环保护（Set + 步数上限）见 MAX_SCAN_STEPS。
 *
 * @param {Element|null} container 消息区（#transcript）
 * @param {string} query 搜索词（原样传入，内部自己归一化）
 * @returns {Element|null} 命中的 .turn 根节点
 */
function findTurnIn(container, query) {
  const needle = normalizeText(query);
  if (!container || !needle) return null;
  const seen = new Set();
  const stack = [container];
  let steps = 0;

  while (stack.length) {
    steps += 1;
    if (steps > MAX_SCAN_STEPS) return null;
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);

    if (hasClass(node, 'turn')) {
      // 占位块（正在思考）不是消息，命中了也不能当落点。
      if (!hasClass(node, 'pending-tip') && normalizeText(textOf(node)).includes(needle)) return node;
      // 一轮的根节点就是滚动与高亮的落点，不用再往它的子孙里找。
      continue;
    }

    const kids = childrenOf(node);
    if (!kids) continue;
    // 逆序压栈，出栈顺序才是文档顺序（先出现的先被检查）。
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂／宿主文档；与其它前端模块一致，缺失即报错
 * @param {() => (Element|null)} [options.getContainer] 返回聊天滚动容器（#transcript），
 *        会话没打开 / 已切走时可能为 null
 * @param {(query: string) => (Element|null)} [options.findTurnByText]
 *        在「当前已加载的内容」里按文本找落点；不传就用本文件自带的遍历实现
 * @param {() => Promise<boolean>} [options.loadOlder] 往前翻一页；还有更早的返回 true
 * @param {(el: Element) => void} [options.scrollIntoView] 滚动落点；不传就试 el.scrollIntoView
 * @param {number} [options.maxPages=5] 基础翻页预算（一页都翻不动时的底线）
 * @param {number} [options.maxPageCap=12] 翻页预算的硬上限（按会话体量估出来的预算不超过它）
 * @param {number} [options.pageSize=50] 宿主历史每页条数（估算翻页预算用）
 * @param {(text: string) => void} [options.showHint] 定位结束时的用户可见提示（title 命中退到顶部时用）
 * @param {number} [options.timeoutMs] 整次定位的截止时间；0 / 负数表示不设截止；
 *   不传则按会话规模自动算（小会话 12 秒，大会话正文命中按 PAGE_COST_MS × 页数放宽，上限 45 秒）
 * @param {number} [options.highlightMs=1600] 高亮停留多久
 * @param {() => number} [options.now] 时钟（测试注入假时钟）
 * @param {(fn: Function, ms: number) => any} [options.setTimeout] 定时器（测试注入假时钟）
 * @param {(id: any) => void} [options.clearTimeout] 取消定时器
 * @returns {{
 *   locate: (input?: {
 *     query?: string,
 *     snippet?: string|null,
 *     matchKind?: string|null,
 *     messageCount?: number|string|null,
 *     signal?: object,
 *   }) => Promise<{
 *     found: boolean,
 *     reason: string,
 *     pagesLoaded: number,
 *     anchorIndex?: number,
 *     anchor?: string,
 *     hint?: string,
 *   }>,
 *   cancel: () => void,
 *   isLocating: () => boolean,
 *   dispose: () => void,
 * }}
 */
export function createSearchJump({
  document: doc,
  getContainer,
  findTurnByText = null,
  loadOlder = null,
  scrollIntoView = null,
  maxPages = DEFAULT_MAX_PAGES,
  maxPageCap = DEFAULT_PAGE_CAP,
  pageSize: pageSizeOption = DEFAULT_PAGE_SIZE,
  showHint = null,
  timeoutMs,
  highlightMs = DEFAULT_HIGHLIGHT_MS,
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (id) => globalThis.clearTimeout(id),
} = {}) {
  if (!doc) throw new TypeError('createSearchJump requires { document }');
  if (typeof getContainer !== 'function') throw new TypeError('createSearchJump requires { getContainer }');

  const pageLimit = Math.floor(nonNegative(maxPages, DEFAULT_MAX_PAGES));
  // 硬上限不能比基础预算还小：否则传一个 maxPages: 15 会被默默压回 12。
  const pageCap = Math.max(pageLimit, Math.floor(nonNegative(maxPageCap, DEFAULT_PAGE_CAP)));
  const pageSize = Math.max(1, Math.floor(nonNegative(pageSizeOption, DEFAULT_PAGE_SIZE)));
  const rawBudget = nonNegative(timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs, DEFAULT_TIMEOUT_MS);
  // 显式传了就完全听调用方的（测试靠这个锁超时行为）；不传才按会话规模自动放宽。
  const timeoutExplicit = timeoutMs !== undefined;
  // 0 / 负数当成「不设截止」：如果按字面理解，timeoutMs: 0 会变成「一开始就超时」，
  // 那是个只会误伤的陷阱，而不是有用的配置。
  const budgetMs = rawBudget > 0 ? rawBudget : Infinity;
  const flashMs = nonNegative(highlightMs, DEFAULT_HIGHLIGHT_MS);

  /**
   * 当前有效的定位序号。每次 locate / cancel / dispose 都 +1。
   * 在途那次拿的是旧号，于是在下一个检查点就能发现「自己已作废」——
   * 这是「旧循环不许继续翻页」的唯一判据，别用时间戳或布尔标志代替。
   */
  let seq = 0;

  /** 在途定位；null 表示现在没有在跑（isLocating 就看它）。 */
  let run = null;
  /** 当前带高亮的节点；同一时刻最多一个。 */
  let highlighted = null;
  let highlightTimer = null;
  let disposed = false;

  const result = (reason, pagesLoaded) => ({
    found: reason === 'found',
    reason,
    pagesLoaded,
  });

  /**
   * 这次定位最多翻几页。
   *
   * 宿主不给「命中在第几条」，能当「位置」用的量只有搜索结果里的 messageCount（整个会话有
   * 多少条消息）：会话越长，snippet 所指的那条越可能落在很早的位置，预算就按「盖住整个会话
   * 要几页」给，而不是一律撞 5 页上限。首屏已经拿掉一页，再留一页抵消宿主分页之间的重叠去重。
   *
   * 标题命中不给这份预算：宿主标题可能是摘要生成的，正文里未必有那个词，为一个可能不存在的
   * 落点翻穿整个会话不划算（没找到就退到会话开头并提示，见 settleMiss）。
   *
   * @param {{matchKind?: string|null, messageCount?: number|string|null, snippet?: string|null}} input
   * @returns {number}
   */
  function pageBudget({ matchKind, messageCount, snippet }) {
    if (pageLimit <= 0) return 0;
    if (matchKind === 'title') return pageLimit;

    const total = Number(messageCount);
    if (Number.isFinite(total) && total > 0) {
      const coverAll = Math.ceil(total / pageSize) + 1;
      return Math.min(pageCap, Math.max(pageLimit, coverAll));
    }
    // 没有总数：有正文 snippet 至少说明命中确实在正文里，比默认预算多给两页。
    const hasSnippet = typeof snippet === 'string' && snippet.trim() !== '';
    return Math.min(pageCap, pageLimit + (hasSnippet ? SNIPPET_EXTRA_PAGES : 0));
  }

  /* ------------------------------ 高亮 ------------------------------ */

  function removeHighlight() {
    const node = highlighted;
    highlighted = null;
    if (!node) return;
    removeClass(node, HIGHLIGHT_CLASS);
  }

  function clearHighlight() {
    if (highlightTimer !== null) {
      try {
        clearT(highlightTimer);
      } catch (err) {
        // 清不掉也只是那个定时器空转一次，结果照样返回
      }
      highlightTimer = null;
    }
    removeHighlight();
  }

  /**
   * 把落点滚到眼前并闪一下。
   * 滚动是增强：调用方没给 scrollIntoView、节点没有这个方法、或者实现里抛错，
   * 都不影响「已经找到了」这个结论。
   */
  function reveal(node, my) {
    if (!node || disposed || my.token !== seq) return;
    clearHighlight();
    addClass(node, HIGHLIGHT_CLASS);
    highlighted = node;
    // 高亮到点自己撤：用注入的定时器，测试里由假时钟推进，从不等真时间。
    highlightTimer = setT(() => {
      highlightTimer = null;
      if (disposed) return;
      removeHighlight();
    }, flashMs);
    try {
      if (typeof scrollIntoView === 'function') scrollIntoView(node);
      else if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) {
      // 假 DOM 没有布局、容器可能刚被换掉：滚不动就算了
    }
  }

  /* ---------------------------- 定位状态机 ---------------------------- */

  /**
   * 截止时间：默认按会话规模算，别让大会话因为「一页 8 秒」而注定超时。
   *
   * 只有正文命中 + 大会话才放宽：标题命中本来就不保证正文里有落点（不浪费用户时间），
   * 小会话一页很快、也不需要等。
   *
   * @param {{budget: number, titleOnly: boolean}} plan
   * @param {number|string|null|undefined} messageCount
   * @returns {number} 毫秒；Infinity 表示不设截止
   */
  function timeoutForPlan(plan, messageCount) {
    if (timeoutExplicit) return budgetMs;
    const total = Number(messageCount);
    if (plan.titleOnly || !Number.isFinite(total) || total < SLOW_SESSION_MIN_MESSAGES) return budgetMs;
    const needed = plan.budget * PAGE_COST_MS + 4000;
    return Math.min(MAX_TIMEOUT_MS, Math.max(budgetMs, needed));
  }

  /** 造一次定位的运行记录；截止时间的定时器在这里就排上。 */
  function createRun(token, signal, budget) {
    let wake = null;
    const gate = new Promise((resolve) => {
      wake = resolve;
    });
    const my = {
      token,
      signal: null,
      gate,
      wake,
      stopped: false,
      timedOut: false,
      deadline: budget === Infinity ? Infinity : now() + budget,
      timer: null,
      onAbort: null,
    };

    if (budget !== Infinity) {
      my.timer = setT(() => {
        my.timer = null;
        my.timedOut = true;
        my.stopped = true;
        my.wake();
      }, budget);
    }

    if (signal && typeof signal.addEventListener === 'function') {
      my.signal = signal;
      my.onAbort = () => stopRun(my);
      signal.addEventListener('abort', my.onAbort);
      // 已经 abort 的 signal 不会补发事件，这里自己补一次。
      if (signal.aborted === true) my.onAbort();
    }

    return my;
  }

  /** 让一次定位立刻停手：循环在下一个检查点看到 stopped 就走人。 */
  function stopRun(my) {
    if (!my || my.stopped) return;
    my.stopped = true;
    try {
      my.wake();
    } catch (err) {
      // 唤醒失败最多是晚一拍收场，结果不受影响
    }
  }

  /** 彻底收掉一次定位：停循环 + 清截止时间定时器 + 摘 abort 监听。 */
  function killRun(my) {
    if (!my) return;
    stopRun(my);
    if (my.timer !== null) {
      try {
        clearT(my.timer);
      } catch (err) {
        // 同上：清不掉只是空转
      }
      my.timer = null;
    }
  }

  /** 把一次定位收尾，返回给调用方的结果。 */
  function settle(my, res) {
    if (my.timer !== null) {
      try {
        clearT(my.timer);
      } catch (err) {
        // 同上
      }
      my.timer = null;
    }
    if (my.onAbort && my.signal && typeof my.signal.removeEventListener === 'function') {
      try {
        my.signal.removeEventListener('abort', my.onAbort);
      } catch (err) {
        // 摘不掉监听也只是一次多余的回调，stopRun 是幂等的
      }
    }
    my.onAbort = null;
    if (run === my) run = null;
    return res;
  }

  function isStale(my) {
    return disposed || my.stopped || my.token !== seq;
  }

  function staleReason(my) {
    return my.timedOut ? 'timeout' : 'cancelled';
  }

  /**
   * 等一个异步动作，但随时可以被取消 / 超时打断。
   * 返回值：拿到了就是 { value }；动作抛错就是 { error }；被打断就是 null。
   */
  function waitFor(work, my) {
    // 同步抛错也要变成「这一次没成功」，不能把定位的 Promise 直接打崩。
    const settled = Promise.resolve()
      .then(work)
      .then((value) => ({ value }), (error) => ({ error }));
    const stopped = my.gate.then(() => null);
    return Promise.race([settled, stopped]);
  }

  /** 在已加载的内容里找落点：注入的优先，否则用本文件自带的遍历。 */
  function lookup(box, keyword) {
    if (typeof findTurnByText === 'function') {
      try {
        const found = findTurnByText(keyword);
        return found && typeof found === 'object' ? found : null;
      } catch (err) {
        // 注入的 finder 抛错不该让整次定位报废：这一轮按「没找到」处理，继续翻页。
        return null;
      }
    }
    return findTurnIn(box, keyword);
  }

  /**
   * 按顺序试所有锚点，命中即停。
   *
   * @param {Element} box
   * @param {string[]} anchors
   * @returns {{node: Element, index: number, anchor: string}|null}
   */
  function lookupAny(box, anchors) {
    for (let i = 0; i < anchors.length; i += 1) {
      const hit = lookup(box, anchors[i]);
      if (hit) return { node: hit, index: i, anchor: anchors[i] };
    }
    return null;
  }

  /**
   * 找不到落点时的收场。
   *
   * 只有「标题命中、而且确实翻到头了」才滚回会话开头并提示：超时说明我们还没翻完，
   * 这时候说「已到会话开头」就是撒谎。正文命中的失败仍是静默的（按旧行为）。
   *
   * @param {any} my
   * @param {{titleOnly: boolean}} plan
   * @param {Element|null} box
   * @param {string} reason
   * @param {number} pagesLoaded
   */
  function settleMiss(my, plan, box, reason, pagesLoaded, hint = CONTENT_MISS_HINT) {
    // 超时本身就是「已停」状态，但这一条恰恰要出声：不能因为 run 停了就把提示吐掉。
    if (isStale(my) && reason !== 'timeout') return settle(my, result(staleReason(my), pagesLoaded));

    if (plan.titleOnly) {
      if (reason !== 'no-more-history') return settle(my, result(reason, pagesLoaded));

      // 先滚到顶部：会话打开时默认停在底部，停在底部又没有高亮，用户只会以为搜索没生效。
      if (box) {
        try {
          box.scrollTop = 0;
        } catch (err) {
          // 极简嵌入的容器可能没有可写的 scrollTop：滚不动也要把话说清楚
        }
      }
      say(TITLE_TOP_HINT);
      return settle(my, { found: false, reason: 'title-top', pagesLoaded, hint: TITLE_TOP_HINT });
    }

    // 正文命中：翻完了 / 预算用尽都没找到，也得说一句。以前这里完全静默，真机上的观感就是
    // 「点了搜索什么都没发生」，用户会以为搜索没生效——和标题那条同一个道理。
    //
    // reason 保持 'no-more-history'：调用方已经按它判断「这条会话翻到头了」，改名字只会让
    // 下游多一个分支；这次只多一个 hint。
    if (reason === 'no-more-history') {
      say(hint);
      return settle(my, { found: false, reason: 'no-more-history', pagesLoaded, hint });
    }
    // 超时：时间或预算用完了，但没翻到头。提示说的是「慢」，不是「没有」。
    if (reason === 'timeout') {
      say(TIMEOUT_HINT);
      return settle(my, { found: false, reason: 'timeout', pagesLoaded, hint: TIMEOUT_HINT });
    }
    return settle(my, result(reason, pagesLoaded));
  }

  /** 提示只是增强：showHint 抛错不能把定位的结论带崩。 */
  function say(text) {
    if (typeof showHint !== 'function') return;
    try {
      showHint(text);
    } catch (err) {
      // 同上
    }
  }

  async function runLoop(my, plan) {
    let pagesLoaded = 0;
    try {
      for (;;) {
        if (isStale(my)) return settle(my, result(staleReason(my), pagesLoaded));
        // 定时器可能还没跑到，也可能被浏览器压后：进展之前先用时钟复核一次。
        if (now() >= my.deadline) {
          my.timedOut = true;
          return settleMiss(my, plan, getContainer(), 'timeout', pagesLoaded);
        }

        const box = getContainer();
        if (!box) return settle(my, result('no-container', pagesLoaded));

        // 先试原词，再试 snippet 里的长片段：命中即停。
        const hit = lookupAny(box, plan.anchors);
        if (hit) {
          reveal(hit.node, my);
          return settle(my, {
            found: true,
            reason: 'found',
            pagesLoaded,
            anchorIndex: hit.index,
            anchor: hit.anchor,
          });
        }

        // 翻够预算就停手：对调用方来说这等价于「没更多了」——能翻的预算已经用完。
        if (pagesLoaded >= plan.budget) return settleMiss(my, plan, box, 'no-more-history', pagesLoaded, BUDGET_HINT);
        if (typeof loadOlder !== 'function') return settleMiss(my, plan, box, 'no-more-history', pagesLoaded);

        const outcome = await waitFor(loadOlder, my);
        // 被打断（含定时器起的作用）：超时要出声，取消不用。
        if (!outcome || isStale(my)) {
          const reason = staleReason(my);
          return reason === 'timeout'
            ? settleMiss(my, plan, box, reason, pagesLoaded)
            : settle(my, result(reason, pagesLoaded));
        }
        if (outcome.error || !outcome.value) {
          // loadOlder 回 false：真的没有更早的了。它自己抛错也归到这一类——
          // 能做的只有停手，具体错误归 pager 的日志，这里不吞也不冒充成功。
          return settleMiss(my, plan, box, 'no-more-history', pagesLoaded);
        }
        pagesLoaded += 1;
      }
    } catch (err) {
      // 走到这里是意料之外的异常。定位失败不能把界面带崩，按「没找到」收场。
      return settle(my, result('no-more-history', pagesLoaded));
    }
  }

  /* ------------------------------ 对外 API ------------------------------ */

  /**
   * 定位一条消息：先扫已加载的内容，没命中就往前翻。
   * 永远 resolve，不 reject；结果里的 reason 说明为什么停。
   *
   * @param {{
   *   query?: string,
   *   snippet?: string|null,
   *   matchKind?: string|null,
   *   messageCount?: number|string|null,
   *   signal?: {aborted?: boolean, addEventListener?: Function},
   * }} [input]
   */
  function locate({ query, snippet, matchKind, messageCount, signal } = {}) {
    if (disposed) return Promise.resolve(result('cancelled', 0));
    const keyword = typeof query === 'string' ? query.trim() : '';
    if (!keyword) return Promise.resolve(result('empty-query', 0));
    if (signal && signal.aborted === true) return Promise.resolve(result('cancelled', 0));

    const plan = {
      anchors: anchorCandidates(keyword, snippet),
      budget: pageBudget({ matchKind, messageCount, snippet }),
      titleOnly: matchKind === 'title',
    };

    // 同一时刻只跑一次：旧的判成 cancelled，新的接着干。
    if (run) killRun(run);
    seq += 1;
    clearHighlight();   // 上一次的落点不属于这次定位

    const my = createRun(seq, signal, timeoutForPlan(plan, messageCount));
    run = my;
    return runLoop(my, plan);
  }

  /** 主动停手（例如用户把搜索面板关了）。在途那次以 cancelled 收场。 */
  function cancel() {
    if (disposed) return;
    const my = run;
    if (my) killRun(my);
    seq += 1;
    run = null;      // isLocating() 立刻变 false，不等在途的 promise 收尾
    clearHighlight();
  }

  function isLocating() {
    return run !== null;
  }

  function dispose() {
    if (disposed) return;
    const my = run;
    if (my) killRun(my);
    seq += 1;
    run = null;
    // 先把我们加的 class 摘掉（此刻 disposed 还是 false，允许这最后一次清理），
    // 之后再有任何回调都不写 DOM。
    clearHighlight();
    disposed = true;
  }

  return { locate, cancel, isLocating, dispose };
}
