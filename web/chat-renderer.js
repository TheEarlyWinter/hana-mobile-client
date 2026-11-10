/* web/chat-renderer.js — 消息区的 DOM
 *
 * 从 app.js 抽出来的「画消息」那一半：一轮消息的骨架、思考与工具的折叠条、
 * mood、文件卡与卡片、历史回放（renderEntry）、尾注里的性能数字。
 *
 * 这里只做 DOM，不碰网络也不决定「要不要画」——事件过滤在 event-router，
 * 会话切换在 conversation-controller，发送与停止在 composer-controller。
 * 所有外部依赖都从工厂参数进：状态对象、几个 DOM 取节点函数、历史容器、
 * 卡片控制器、文件地址实例、头像与 flash。模块不 import 回 app.js。
 *
 * 不碰 DOM 的那一半不在这个闭包里：尾注数字与时长文案在 renderer-stats.js，
 * 工具行的显示名与收尾三态在 tool-line.js。都是纯函数，改它们不必穿过整份渲染器。
 *
 * 顺带说明两个容易踩的点：
 *  - historyView 用 getter 传（历史容器在模块之后才建），因为「插入历史页时别滚动」
 *    这个判断必须问当时的 historyView，而不是建渲染器那一刻的。
 *  - 一轮消息在存档里是好几条 assistant 消息，连续出现时用 .cont 隐掉重复头像。
 */

/* 下面几个 typedef 是这个模块的参数契约，不是文档装饰：
 * 装配层注入 state / appState / getHistoryView / cardController / fileUrls 几个「袋子」，
 * 以前一律写成 @param {object}，于是往里读 state.turn、view.append 时 tsc 只能说
 * 「object 上没有这个属性」——查不出真正的属性名笔误。按实际读写的字段列出来之后，
 * 写错字段名才会报错。
 * 只列本模块真正读到的字段：别的模块往袋子里多塞东西不受影响（结构化类型），
 * 本模块没读过的东西也不在这里替别人立约。
 */

/**
 * 渲染器私有的「一轮画到哪儿了」状态袋（web/renderer-state.js 的实例）。
 *
 * 应用级字段（session / principal / agentName / userName / currentAgent）写成可选：装配层用
 * appState 单独注入，不注入时就从 state 上读（老单测「一个对象装两类状态」的写法）。
 * 同时也解释了下文 `const app = appState || state` 为什么两边都得有这几个字段：
 * 类型上取联合之后，只有两个成员都声明过的属性才读得到。
 *
 * @typedef {object} ChatRendererState
 * @property {HTMLElement|null} turn 本轮 .turn 根节点
 * @property {HTMLElement|null} turnBody 本轮正文容器
 * @property {HTMLElement|null} turnFootEl 本轮尾注（时间 + 耗能数字）
 * @property {any} turnMeta 本轮 .turn-meta（<details>）。行上还按轮挂着 _tools / _think /
 *   _thinkCount / _thinkOpen / _thinkTotal / _failed 这些记账字段，它们是 querySelector 拿到
 *   的节点上现挂的，不重写代码就没法在 JSDoc 里表达——只有这一个字段用 any，换来的是
 *   其余 14 个字段照样能抓错属性名。读它的函数（paintMeta 等）参数本来就是 untyped。
 * @property {Element|null} textEl 正文节点（querySelector 的产物，只用到 innerHTML / classList）
 * @property {string} streamingRaw 本轮已经上屏的原始正文
 * @property {number} thinkAt 当前这段思考的起点（performance.now）
 * @property {boolean} replaying 是否在历史回放中
 * @property {Element|null} moodEl 嘀咕条容器
 * @property {string} moodRaw 嘀咕条已上屏原文
 * @property {number} turnStart 本轮计时起点
 * @property {number} firstTokenMs 首响毫秒
 * @property {number} charCount 本轮正文字数
 * @property {number} speed 每秒字数
 * @property {ChatRendererSession|null} [session] 应用级：当前会话（appState 不注入时从 state 读）
 * @property {object} [principal] 应用级：登录身份。只做逐字引用比较（晚到的异步结果据此丢弃），
 *   不读它的字段，所以收成 object 而不是 any。
 * @property {string} [agentName] 应用级：全局 agent 名（会话没回填名字时的兜底）
 * @property {string} [userName] 应用级：用户署名
 * @property {{id?: string}|null} [currentAgent] 应用级：当前 agent（没有会话时头像取它的 id）
 */

/**
 * 应用级状态（会话 / 登录身份 / 署名）。装配层用 appState 注入的就是 S，
 * 它同时还有 sessions / ws 那些字段——结构化类型只看本模块读的这五个，多出来的不看。
 *
 * session 与 agentName 为什么也是可选的：S 的字面量里没有 currentAgent（登录后才补），
 * 而单测里那一个「什么都装」的状态对象也不一定有。
 *
 * @typedef {object} ChatRendererAppState
 * @property {ChatRendererSession|null} [session] 当前会话
 * @property {any} [principal] 登录身份（只做引用比较，不替登录层立形状）
 * @property {string} [agentName] 全局 agent 名
 * @property {string} [userName] 用户署名
 * @property {{id?: string}|null} [currentAgent] 当前 agent
 */

/**
 * 当前会话（state.session / app.session）里渲染器读到的字段。
 * @typedef {object} ChatRendererSession
 * @property {string} agentName 会话自己的 agent 名（历史消息的署名）
 * @property {string} [agentId] 会话的 agent id（头像用它）
 * @property {string} [sessionId] 卡片归属快照用
 * @property {string} [path] 卡片归属快照用（会话文件路径）
 */

/**
 * 历史容器的窄口（web/history-pagination-view.js 的实例）。渲染器只用这三件事。
 * @typedef {object} ChatRendererHistoryView
 * @property {(node: Element) => void} append 挂一帧；prepend 期间插到锚点之前
 * @property {() => boolean} isPrepending 正在往更早翻页（这时不该贴底）
 * @property {(top?: number) => void} noteProgrammaticScroll 刚才是程序化写入的滚动位置
 */

/**
 * 卡片渲染器（web/card-controller.js 的实例）。渲染器只负责把事件原样交过去。
 * @typedef {object} ChatRendererCardController
 * @property {(ev: object, sessionSnapshot: object, options?: {sessionFiles?: Array}) => Element} render
 */

/**
 * 会话文件地址（web/file-urls.js 的实例）。
 * @typedef {object} ChatRendererFileUrls
 * @property {(file: object) => Promise<{readUrl: string|null, downloadUrl: string|null}>} forFile
 */

import { el } from './dom.js';
import { createScrollPin } from './scroll-pin.js';
import { renderMarkdown } from './md.js';
import { splitUserContent, imagesFromAttachments } from './attach.js';
import { contentBlocks, blockText, splitMoodBlock, cleanMoodText } from './protocol.js';
import { renderFileCard, fileCardsOf, setFileCardHref } from './file-card.js';
import { renderReferenceCard } from './reference-block.js';import { openFilePreview } from './file-preview.js';
import { startDownload } from './download.js';
import { fileUrlFor, resourceContentUrl } from './file-urls.js';
// 工具调用的「人话」翻译独立成模块：词表集中在一处，渲染器只负责摆 DOM。
import { describeToolOp } from './tool-ops.js';
// 纯文案与纯计算同样搬出闭包：流式热路径上每次重画尾注/摘要都会走到它们。
import { prettyToolName, toolMark, toolStateText } from './tool-line.js';
import { clockText, countOf, footStatsText, speedOf, thinkLabel } from './renderer-stats.js';

/** 消息里引用的会话文件（sf_…）→ 资源内容地址。 */
const resourceUrl = resourceContentUrl;

/* ------------------------------------------------------------------ */
/* 按文本找「那一轮」（搜索结果跳转用）                                  */
/* ------------------------------------------------------------------ */

/**
 * 一轮消息的稳定标记。
 *
 * 宿主的搜索结果只带会话 id 和一段 snippet，没有 messageId，打开会话之后只能按文本找回。
 * 这个 key 不参与定位（定位靠文本），它的作用是让调用方在节点被翻动、重排之后
 * 还能认出「就是这一轮」：有宿主给的消息 id 就用 id，没有就发一个序号。
 */
let turnKeySeq = 0;

/**
 * 给 turn 根节点打标。优先用消息自带 id（历史里的 entry.id 就是消息的全局索引），
 * 没有就用递增序号——序号只在本次页面生命周期里唯一，够用且不依赖宿主。
 *
 * @param {HTMLElement|null} turn 走的是 el() 建出来的节点，要有 dataset
 * @param {string|number|null} [messageId]
 */
function markTurn(turn, messageId = null) {
  if (!turn || !turn.dataset) return turn;
  const id = messageId == null ? '' : String(messageId).trim();
  if (id) {
    turn.dataset.turnKey = `m:${id}`;
    return turn;
  }
  turnKeySeq += 1;
  turn.dataset.turnKey = `t${turnKeySeq}`;
  return turn;
}

/** 忽略大小写与空白差异：搜索词里的空格位置和渲染出来的文本几乎不会一模一样。 */
function normalizeTurnText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

/** 节点是否带某个 class；不依赖 querySelector。 */
function turnHasClass(node, name) {
  const list = node && node.classList;
  if (list && typeof list.contains === 'function') return list.contains(name);
  const cls = typeof node?.className === 'string' ? node.className : '';
  return cls.split(/\s+/).includes(name);
}

/** 遍历步数上限：DOM 正常是树，但假节点之间可能成环，封顶保证最坏情况也能收场。 */
const MAX_TURN_SCAN_STEPS = 50000;

/**
 * 在消息区里按文本找「第一个命中的一轮」。
 *
 * 为什么不用 querySelectorAll：仓库的测试用假 DOM（tests/support/app_harness.mjs）
 * 只实现了极简查询，别处甚至可能根本没有；这里要的又只是「深度优先、命中就停」。
 * 环保护（Set + 步数上限）是给互相引用的假节点兜底的。
 *
 * @param {Element|null} container 消息区（#transcript）
 * @param {string} query 搜索词；忽略大小写与空白差异
 * @returns {Element|null} 命中的 .turn 根节点
 */
export function findTurnByText(container, query) {
  const needle = normalizeTurnText(query);
  if (!container || !needle) return null;

  const seen = new Set();
  const stack = [container];
  let steps = 0;

  while (stack.length) {
    steps += 1;
    if (steps > MAX_TURN_SCAN_STEPS) return null;
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);

    if (turnHasClass(node, 'turn')) {
      // 占位块（正在思考）不是消息，命中了也不能当落点。
      if (!turnHasClass(node, 'pending-tip') && normalizeTurnText(node.textContent).includes(needle)) {
        return node;
      }
      // 一轮的根节点就是落点，不必再往它的子孙里找。
      continue;
    }

    const kids = node.children;
    if (!kids || typeof kids.length !== 'number') continue;
    // 逆序压栈，出栈顺序才是文档顺序。
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return null;
}

/**
 * @param {object} [options]
 * @param {ChatRendererState} [options.state] 流式渲染状态（turn / textEl / streamingRaw / mood…），装配层注入
 *   web/renderer-state.js 的实例；只放「一轮画到哪儿了」，不含应用级字段。
 * @param {ChatRendererAppState|null} [options.appState] 应用级状态（session / principal / agentName / userName /
 *   currentAgent）：署名、头像、卡片归属快照要从这里读。不传就退回 state——单测里
 *   「一个对象装两类状态」的老写法继续有效。
 * @param {(id: string) => HTMLElement|null} [options.getElement] 按 id 取节点（装配层传 document.getElementById）
 * @param {(() => ChatRendererHistoryView)|null} [options.getHistoryView] 历史容器（append / isPrepending /
 *   noteProgrammaticScroll）
 * @param {ChatRendererCardController|null} [options.cardController] 卡片渲染
 * @param {ChatRendererFileUrls|null} [options.fileUrls] 会话文件的两个地址（file-urls.js 的实例）
 * @param {Function} [options.paintAvatar]
 * @param {Function} [options.agentAvatarUrlById]
 * @param {Function} [options.userAvatarUrl]
 * @param {(msg: string) => void} [options.flash]
 * @param {(busy: boolean) => void} [options.onBusyChange] 一轮结束/重置时通知输入区
 * @param {(fn: Function, ms: number) => any} [options.setTimer] 防呆计时器（占位块的 30 秒），
 *   默认 globalThis.setTimeout。留成可注入的只是为了让假时钟测试能断言时长。
 * @param {(handle: any) => void} [options.clearTimer] 与 setTimer 配套，默认 globalThis.clearTimeout。
 * @param {((stats: {thinkingCount: number, opCount: number, failedCount: number, streaming: boolean}) => string)|null} [options.formatSereneSummary]
 *   沉静视图的摘要文案，装配时由 app.js 注入（turn-summary.js 的 sereneSummary）。
 *   功能模块之间互不 import，所以这里只接函数，不认识 turn-summary。
 * @param {((entry: object) => boolean)|null} [options.renderSubagent]
 *   子代理（分身）卡片的历史回放，装配时注入 subagent-view.js 的 render。
 *   同样是「只接函数、不 import」：没注入就照旧跳过这种 entry。
 * @param {((node: Element) => void)|null} [options.onBlocksRendered] 每次有新节点上屏后补交互
 *   （代码块复制按钮）。渲染器不认识复制模块，只把节点交出去；没注入就不补。
 * @param {((items: Array<{src: string, alt: string}>, index: number) => void)|null} [options.openImageViewer]
 *   全屏看图。装配层注入 (items, index) => void；没注入就退回旧的单张灯箱。
 */
export function createChatRenderer({
  state,
  // 应用级状态：渲染器自己那份 state 里只剩渲染进度，会话与身份得单独接进来。
  // 不传就退回 state（老调用方/单测直接传一个 state 的写法行为不变）。
  appState = null,
  getElement,
  getHistoryView,
  cardController,
  fileUrls,
  paintAvatar,
  agentAvatarUrlById,
  userAvatarUrl,
  flash,
  onBusyChange = () => {},
  formatSereneSummary = null,
  renderSubagent = null,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  // 每次有节点上屏或流式重绘后回调一次，用来补交互（代码块复制按钮）。
  // 渲染器不认识复制模块，只把节点交出去。
  onBlocksRendered = null,
  // 全屏看图：装配层注入 (items, index) => void；没注入就退回旧的单张灯箱。
  openImageViewer = null,
} = {}) {
  if (!state) throw new TypeError('createChatRenderer requires { state }');
  // 应用级字段（会话、身份、署名）从哪读：装配层注入 S；没注入就是 state 自己。
  const app = appState || state;

  // 历史回放专用：当前正在合并的那一轮（连续的 assistant 条目合成一个气泡）。
  // 实时路径不用它——实时本来就是一条流。
  let replayTurn = null;

  /**
   * 历史页内的「最近一条消息落点」（user 或 assistant 的正文节点）。
   * 宿主的 file 块带的是页内 afterIndex 锚点，可能挂在 user 后面；
   * 只在本页内有效，页边界清空，绝不回退到实时 state 或整份 transcript 的最后一个 assistant。
   */
  let pageBody = null;

  /**
   * 「实时轮指针」的完整清单，连同清空时该写回的取值。
   *
   * clearLiveTurn 与 preserveLiveTurn 的暂存/还原都只认这一张表：以后往实时轮里加字段，
   * 只要加到这里，就不会出现「清了但没暂存」的半截还原。
   *
   * 注解是必要的：不加时 TS 会把元组放宽成 `(string | boolean)[][]`，
   * 于是 `state[key]` 里的 key 变成 `string | boolean`（布尔的字面量也是元素）。
   * @type {ReadonlyArray<[string, any]>}
   */
  const LIVE_TURN_FIELDS = [
    ['turn', null],
    ['turnBody', null],
    ['turnFootEl', null],
    ['turnMeta', null],
    ['thinkAt', 0],
    ['textEl', null],
    ['streamingRaw', ''],
    ['moodEl', null],
    ['moodRaw', ''],
    ['replaying', false],
  ];

  /**
   * 清掉「实时轮」的全部指针，但不动占位块、也不通知输入区。
   * 历史页开始/结束时用：历史轮已经上屏，但它不是 live turn，不能让 event-router
   * 的 delta / status:true / turn_end 把历史轮当成本轮接着写（改正文、改尾注、发通知）。
   */
  function clearLiveTurn() {
    for (const [key, empty] of LIVE_TURN_FIELDS) state[key] = empty;
  }

  /**
   * preserveLiveTurn 的暂存位。null 表示当前没有正在保护中的实时轮。
   * 只在 beginHistoryPage({preserveLiveTurn:true}) 写入，由 endHistoryPage 消费、
   * 或被下一次普通 beginHistoryPage() 丢掉。
   */
  let stashedLiveTurn = null;

  /** 把实时轮指针整组抄一份。 */
  function stashLiveTurn() {
    // 已经有暂存就不覆盖：此刻 state 已经被上一次 begin 清空了，再抄一遍只会把真正的
    // 实时轮指针换成一片 null。
    if (stashedLiveTurn) return;
    const snap = {};
    for (const [key] of LIVE_TURN_FIELDS) snap[key] = state[key];
    stashedLiveTurn = snap;
  }

  /**
   * 当前是否处在「历史页回放」区间（beginHistoryPage → endHistoryPage）。
   * 回放里的 user 条目也会走 resetTurnState；那时既不能收占位块、也不能把 busy 通知给输入区，
   * 否则「生成中 prepend 一页」会顺带把「生成中不许整页重载」的保护一起放开。
   */
  let historyPageActive = false;

  /** 原样还原暂存的实时轮指针：delta / 思考 / 工具继续写回原来那一轮。 */
  function restoreLiveTurn(snap) {
    if (!snap) return;
    for (const [key] of LIVE_TURN_FIELDS) state[key] = snap[key];
    // replaying 是页级标志，不是实时轮字段：还原时一律归 False，不能把回放态钉在实时轮上
    state.replaying = false;
  }

  /**
   * 历史页边界：开始渲染一页，或消息区被整页替换时调用。
   *
   * 除了 replayTurn（指向 DOM 的合并引用，只在「同一页」里有意义），还必须把实时轮指针
   * 一起清掉：startAssistantTurn 在回放时也会写 state.turn/turnBody，留着就等于把一个
   * 历史轮交给了实时路由。同页内连续的 assistant 仍然合成一轮。
   *
   * @param {{preserveLiveTurn?: boolean}} [options]
   *   preserveLiveTurn：生成期间 prepend 更早页时用。这时实时轮不能丢，但它也不能留着——
   *   回放会经过 startAssistantTurn，把这一页的历史轮写进 state.turn 等指针里。所以先整组
   *   暂存、再照常清空（不清就会被历史轮顶掉，正文还会写进历史气泡），由 endHistoryPage
   *   原样还原。不带参时行为与以前完全一致。
   */
  function beginHistoryPage({ preserveLiveTurn = false } = {}) {
    if (preserveLiveTurn) stashLiveTurn();
    // 普通 begin 一律丢掉暂存：只 begin 不 end 的 preserve（中途抛错、调用方忘了配对）
    // 不能留下永久脏状态，下一次普通页边界就回到默认语义。
    else stashedLiveTurn = null;
    historyPageActive = true;
    replayTurn = null;
    pageBody = null;
    clearLiveTurn();
  }

  /**
   * 历史页结束边界：本页的轮已经上屏，但一个都不能留在实时 state 里。
   * 只要有暂存就原样还原：preserveLiveTurn 只决定 begin 时要不要暂存，不决定这里要不要还。
   */
  function endHistoryPage() {
    // 没配对上的 end（重复调用、根本没 begin 过）不碰实时轮：否则第二次 end 会把刚还原的轮清掉。
    if (!historyPageActive) return false;
    historyPageActive = false;
    // 只要有暂存就还原——参数只决定「要不要暂存」，不决定「要不要还」。少传一次参数
    // 不应该让正在跑的那一轮静默丢掉指针。
    const stash = stashedLiveTurn;
    stashedLiveTurn = null;
    replayTurn = null;
    pageBody = null;
    clearLiveTurn();
    restoreLiveTurn(stash);
    return true;
  }

  /**
   * @param {any} entry 宿主历史里的一条：形状由宿主定，这里只按 type/role 分派，不替它立约
   * @param {{sessionFiles?: Array}} [options] 当前页的会话文件，透传给卡片与控制层
   * @returns {boolean} 是否画出了东西
   */
  function renderEntry(entry, { sessionFiles } = {}) {
    if (!entry || typeof entry !== 'object') return false;
    // 子代理（分身）：宿主把 subagent 工具的 details 投影成 {type:'subagent'} 的块，
    // 历史里作为独立 entry 锚在 afterIndex 上。渲染器不认识它的形状，也不 import
    // 那个模块——装配时注入 renderSubagent，没注入就跳过（保持原来的行为）。
    if (entry.type === 'subagent') {
      return typeof renderSubagent === 'function' && Boolean(renderSubagent(entry));
    }
    // 宿主历史把 show_card 投影成独立 block（canonical 形状），不是 toolResult 消息。
    // 原样交给 cardController：receipt/cardId/sessionId 都是宿主给的值，不从 toolCall.id 补；
    // 当前页的 sessionFiles 只做薄传递，不在 app 里合并/校验/缓存。
    if (entry.type === 'interactive_card') {
      appendCard(entry, { sessionFiles });
      return true;
    }
    // 历史里的文件：宿主的 file 块带页内 afterIndex 锚点，可能挂在 user 后面。
    // 这是文件卡在历史回放里的唯一来源（stage_files 的 toolResult 不在 messages 里）。
    if (entry.type === 'file') {
      return appendHistoryFileCards([entry]);
    }
    const msg = entry.message || entry;
    const role = msg.role || entry.role;
    if (!role) return false;
    // 历史里的消息 id（全局索引）——turn 的稳定标记优先用它。
    const msgId = entry.id ?? msg.id ?? null;

    const blocks = contentBlocks(msg);
    if (!blocks.length) return false;

    if (role === 'toolResult' || role === 'tool_result') {
      const name = msg.toolName || entry.toolName;
      if (name === 'show_card') {
        appendCard(msg);
        return true;
      }
      // stage_files 这类工具把文件放在 details.files 里：实时有 content_block 事件，
      // 历史里只有这一条 toolResult，两路都得接，否则手机端只剩一行折叠的工具名。
      const files = fileCardsOf(msg);
      if (files.length) return appendHistoryFileCards(files);
      return false;
    }

    if (role === 'user') {
      // 用户消息是轮次边界：上一条 assistant 长轮到此为止。
      replayTurn = null;
      const raw = msg.content ?? msg.text ?? blocks;
      const { text, images, files } = splitUserContent(raw, { fileUrl: fileUrlFor, resourceUrl });
      const extra = imagesFromAttachments(msg.attachments, { fileUrl: fileUrlFor });
      const merged = images.length ? images : extra;
      if (!text && !merged.length && !files.length) return false;
      // 历史回放：用消息自己的时间。以前这里没传，每条用户消息都显示成「当前时间」
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      const userTurn = appendUser(text, merged, files, Number.isFinite(ts) ? ts : Date.now());
      if (userTurn && msgId != null) markTurn(userTurn, msgId);
      // 本页之后的 file 块可以挂在这条 user 气泡上（宿主的 file 锚点常常就在 user 后面）。
      pageBody = userTurn ? userTurn.querySelector('.turn-body') : null;
      return true;
    }

    if (role === 'assistant') {
      let drew = false;
      // 回放时**连续的 assistant 消息要合成一轮**：宿主把一次模型步存成一条消息，
      // 一轮回答常常有十几条。如果每条都 startAssistantTurn，重新进会话后会变成
      // 十几个独立气泡、十几个「1 次思考 · 1 项操作」，跟实时看到的完全不是一回事。
      const resumed = Boolean(replayTurn);
      const turn = replayTurn || startAssistantTurn();
      replayTurn = turn;
      // 合并进来的后续消息不重新打标：一轮只认开头那一条的身份。
      if (!resumed && msgId != null) markTurn(turn, msgId);
      // 历史回放：思考时长是假的，只写「思考」不写秒数
      state.replaying = true;
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'thinking' || b.type === 'reasoning') {
          const t = b.thinking || b.text || '';
          if (t.trim()) { addThinking(t, turn); drew = true; }
          continue;
        }
        if (b.type === 'toolCall' || b.type === 'tool_use' || b.type === 'tool_call') {
          // 历史里有时带 input/args（旧会话），有时只有名字：没有就把名字当参数文本，
          // 否则流水行只剩「翻完了 ✓」，看不出翻的是什么。
          const name = b.name || b.toolName || 'tool';
          addTool(name, turn, '完成', null, b.input || b.args || { label: prettyToolName(name) });
          drew = true;
          continue;
        }
        if (b.type === 'toolResult' || b.type === 'tool_result') {
          const name = b.name || b.toolName;
          if (name === 'show_card') { appendCard(b); drew = true; }
          continue;
        }
        const t = blockText(b);
        if (t.trim()) { addAssistantText(t, turn, { append: false }); drew = true; }
      }
      if (!drew) { state.replaying = false; if (!resumed) { turn.remove(); resetTurnState(); } return false; }
      state.replaying = false;
      // 本页后续的 file 块挂到这一轮：只认本页的落点，不靠整份 transcript 反查。
      pageBody = turn.querySelector('.turn-body');
      turn.classList.remove('streaming');
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      const timeEl = turn.querySelector('.foot-time');
      if (timeEl) timeEl.textContent = clockText(Number.isFinite(ts) ? ts : Date.now());
      // 不在这里 resetTurnState：下一段 assistant 还要接着往同一轮里写。
      return true;
    }

    return false;
  }


  const container = () => getElement('transcript');

  /**
   * 「贴着底」的规则跟闲聊面板共用一份（web/scroll-pin.js）。
   * 以前这里自己量几何：内容一长，量的时候已经不在底部了，就跟丢。
   * 阈值 160 是原来就用的值，没动。
   */
  const scrollPin = createScrollPin({ getElement: container, threshold: 160 });
  // 尽量早绑：绑不上（容器还没上屏）就在后面每次用时再试。
  scrollPin.attach();

  /**
   * 这一行的呈现方式。默认沉静（与 chat-view-mode.js 的 DEFAULT_VIEW_MODE 一致），
   * 不认识的模式一律按沉静处理——宁可少列细节，也不要让一行摘要显示成四不像。
   * @type {'serene' | 'classic'}
   */
  let viewMode = 'serene';

  /**
   * 摘要文案的唯一出口：注入了就用注入的，没注入（单独建渲染器、极简嵌入）
   * 就退成一句最省事的话，保证不崩也不空白。
   */
  function summaryOf(stats) {
    if (typeof formatSereneSummary !== 'function') return '忙了一阵';
    const text = formatSereneSummary(stats);
    return typeof text === 'string' ? text : String(text ?? '');
  }

  /**
   * 切换视图模式，并把已经画过的摘要行立刻按新模式重画。
   * @param {'serene' | 'classic'} mode
   * @returns {'serene' | 'classic'} 归一化之后真正生效的模式
   */
  function setViewMode(mode) {
    viewMode = mode === 'classic' ? 'classic' : 'serene';
    applyViewModeMarker();
    const box = container();
    if (box) {
      for (const d of Array.from(box.querySelectorAll('.turn-meta'))) {
        // 沉静用自己管的 .collapsed，经典交回原生 details：切模式时两边的状态都要摆正，
        // 否则会留下「经典模式下所有过程都收着、点 summary 却没反应」这种四不像。
        applyMetaMode(d);
        bindMetaToggle(d);
        paintMeta(d);
      }
    }
    return viewMode;
  }

  /** summary 挂在哪个 .turn 里（details 在 .turn-body 内；脱离文档时为 null）。 */
  function turnOfMeta(d) {
    let node = d.parentNode;
    while (node) {
      if (node.classList && node.classList.contains('turn')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** 本轮工具操作总数：按调用次数算，同一个工具出现两次就是两项。 */
  function toolCount(d) {
    if (!d || !d._tools) return 0;
    let total = 0;
    for (const c of d._tools.values()) total += countOf(c);
    return total;
  }

  /** 消息区里最后一行摘要（tool_end 迟到、本轮已重置时用它兜底）。 */
  function lastMeta() {
    const box = container();
    if (!box) return null;
    const all = Array.from(box.querySelectorAll('.turn-meta'));
    return all[all.length - 1] || null;
  }

  // 历史消息的署名用会话自己的 agent；只有新会话还没回填时才退回全局
  const agentLabel = () => app.session?.agentName || app.agentName || 'Hana';

  /**
   * 把一帧消息挂进消息区。正常走 historyView.append（「加载更早」时它负责插到锚点前），
   * 没有 historyView 的装配（单独建渲染器、极简嵌入）退回容器末尾，不让渲染器一开就崩。
   */
  /** 给新渲染出来的内容补交互（代码块复制按钮）。失败就算了，不影响消息本身。 */
  function decorateBlocks(node) {
    if (typeof onBlocksRendered !== 'function' || !node) return;
    try {
      onBlocksRendered(node);
    } catch (err) {
      // 装饰是增强，不是渲染的一部分
    }
  }

  function mountTurn(node) {    const view = typeof getHistoryView === 'function' ? getHistoryView() : null;
    if (view && typeof view.append === 'function') {
      view.append(node);
    } else {
      const box = container();
      if (box) box.appendChild(node);
    }
    // 上屏之后再补「装饰」。装饰失败不能让消息渲染失败，所以这里吃掉异常，
    // 也不改变原有的挂载语义。
    decorateBlocks(node);
  }

  function nearBottom() {
    scrollPin.attach();
    return scrollPin.nearBottom();
  }

  function scrollToBottom(force = false) {
    scrollPin.attach();
    scrollPin.follow({ force: Boolean(force) });
    // 贴底是程序化写入：报给视图，别在补偿窗口里被当成用户滚动
    const view = typeof getHistoryView === 'function' ? getHistoryView() : null;
    view?.noteProgrammaticScroll?.();
  }

  function turnHead(role, name) {
    const head = el('div', 'turn-head');
    const av = el('div', `avatar ${role === 'user' ? 'avatar-user' : 'avatar-agent'}`);
    // 助手头像跟会话的 agent 走；用户头像就是本人那张
    paintAvatar(av, {
      url: role === 'user' ? userAvatarUrl() : agentAvatarUrlById(app.session?.agentId || app.currentAgent?.id),
      name,
      fallback: role === 'user' ? app.userName || name : name,
    });
    head.appendChild(av);
    // 自己的消息不报名字，头像就够
    if (role !== 'user') head.appendChild(el('span', 'turn-name', name));
    return head;
  }

  /** 尾注：时间 + 本轮的耗能数字（首响 / 速度）。 */
  function turnFoot(ts, parts = []) {
    const foot = el('div', 'turn-foot');
    foot.appendChild(el('span', 'foot-time', clockText(ts)));
    foot.appendChild(el('span', 'foot-stats', parts.length ? ` · ${parts.join(' · ')}` : ''));
    return foot;
  }

  /**
   * 新建一轮消息。结构：
   *   .turn > .turn-head（头像 + 名字）+ .turn-main（正文 + 尾注）
   * 助手纵向排列（头像在上），用户横向反向（头像贴在气泡右侧）。
   */
  function newTurn(role, name) {
    const turn = el('div', `turn ${role}`);
    // 先给个序号标记；历史回放拿到消息 id 之后会覆盖成 m:<id>（见 renderEntry）。
    markTurn(turn);
    turn.appendChild(turnHead(role, name));
    const main = el('div', 'turn-main');
    const body = el('div', 'turn-body');
    main.appendChild(body);
    turn.appendChild(main);
    mountTurn(turn);

    // 一次回复在存档里是好几条 assistant 消息（思考、工具、正文各一条）。
    // 连续出现时不再重复头像/名字/时间，否则一次回答会被拆成十来个块。
    const prev = turn.previousElementSibling;
    if (role === 'assistant' && prev && prev.classList.contains('turn') && prev.classList.contains('assistant')) {
      turn.classList.add('cont');
    }
    return { turn, main, body };
  }

  function mediaGrid(images) {
    const box = el('div', 'user-media');
    if (images.length === 1) box.classList.add('one');
    else if (images.length > 4) box.classList.add('many');

    // 可滑动的图集：先按渲染顺序攒一份清单，每张图记住自己的下标。
    const items = [];
    for (const img of images) {
      if (!img || !img.src) {
        box.appendChild(el('div', 'media-broken', img?.name || '图片'));
        continue;
      }
      const im = document.createElement('img');
      im.src = img.src;
      im.alt = img.name || '图片';
      // 不能用 lazy：容器在图片加载前是 0×0，浏览器判定「不在视口」就永远不开始加载，
      // 于是一直 0×0——死锁。聊天里的图片本来就该直接加载。
      im.loading = 'eager';
      im.decoding = 'async';
      im.addEventListener('error', () => {
        const broken = el('div', 'media-broken', img.name || '图片打不开');
        im.replaceWith(broken);
      });
      const index = items.length;
      items.push({ src: img.src, alt: img.name || '图片' });
      im.addEventListener('click', () => openImage(items, index));
      box.appendChild(im);
    }
    return box;
  }

  /** 全屏看图：优先交给装配层注入的查看器；没注入就退回旧的单张灯箱。 */
  function openImage(items, index) {
    if (typeof openImageViewer === 'function' && items && items.length) {
      openImageViewer(items, index);
      return;
    }
    if (items && items[index]) openLightbox(items[index].src);
  }

  function openLightbox(src) {
    const box = getElement('lightbox');
    const img = getElement('lightboxImg');
    if (!box || !img) return;
    img.src = src;
    box.hidden = false;
  }

  /* 助手正文里的 markdown 图片（.md-img）以前点了没反应（E12）。
   * 在消息区做一次委托，把同一条消息里的图当作一个图集翻页。
   * 容器节点是持久的（清屏只改 innerHTML），所以只挂一次。 */
  const transcriptRoot = typeof container === 'function' ? container() : null;
  if (transcriptRoot && typeof transcriptRoot.addEventListener === 'function') {
    transcriptRoot.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const img = target.closest('img.md-img');
      if (!img || !img.src) return;
      const scope = (typeof img.closest === 'function' && img.closest('.turn-body')) || transcriptRoot;
      const nodes = typeof scope.querySelectorAll === 'function'
        ? Array.from(scope.querySelectorAll('img.md-img'))
        : [img];
      const list = nodes
        .filter((node) => node && node.src)
        .map((node) => ({ src: node.src, alt: node.alt || '图片' }));
      const at = list.findIndex((item) => item.src === img.src);
      openImage(list, at < 0 ? 0 : at);
    });
  }

  function systemLine(text, isError = false) {
    return el('div', `msg-system${isError ? ' error' : ''}`, text);
  }

  function appendSystem(text, isError = false) {
    container().appendChild(systemLine(text, isError));
    scrollToBottom(true);
  }


  /* ---- 用户消息 ---- */

  /** 附件条：桌面端粘过来的文件引用，用一条细卡片表示 */
  function fileChips(files) {
    const box = el('div', 'file-chips');
    for (const f of files) {
      const chip = el('div', 'file-chip');
      chip.title = f.label;
      chip.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
      chip.appendChild(el('span', 'file-chip-name', f.label));
      box.appendChild(chip);
    }
    return box;
  }

  function appendUser(text, images = [], files = [], ts = Date.now(), references = []) {
    resetTurnState();
    const { turn, main, body } = newTurn('user', app.userName);

    // 宿主注入的引用块（[hana_reference] 等）以前被整段剔掉，桌面看得到的引用手机上完全看不到。
    // 现在画成可折叠卡片，放在正文上方。
    if (Array.isArray(references) && references.length) {
      for (const reference of references) {
        const card = renderReferenceCard(document, reference);
        if (card) body.appendChild(card);
      }
    }
    if (images.length) body.appendChild(mediaGrid(images));
    if (files.length) body.appendChild(fileChips(files));
    if (text) {
      const bubble = el('div', 'bubble-user');
      bubble.innerHTML = renderMarkdown(text);
      decorateBlocks(bubble);
      body.appendChild(bubble);
    }
    main.appendChild(turnFoot(ts));

    // 历史回放（更早页）不能把用户拽到底部；实时消息照旧。
    if (!getHistoryView().isPrepending()) scrollToBottom(true);
    return turn;
  }

  /* ---- 占位块：助手还没吐字时的「正在思考」 ---- */

  /*
   * 从点发送到模型吐第一个字之间常见好几秒，这段时间原来界面上什么都没有，
   * 看起来就像消息没发出去。这里在消息列表末尾挂一个占位块：头像 + 名字 + 三个跳动的点。
   *
   * 它复用 .turn.assistant 的骨架，所以缩进、和下一轮的间距、头像尺寸都与真实助手消息
   * 一致；第一个 delta 到达时占位块撤掉，同一位置换成真正文，观感上就是「占位变成了内容」。
   *
   * 状态只活在 DOM 里（pendingNode 只是缓存）：replaceTranscriptHistory() 的
   * innerHTML='' 把节点摘掉之后，livePending() 会发现引用失效并重建；
   * 绝不能出现「DOM 已经清了、模块还攥着一个清不掉的引用」那种孤儿。
   *
   * 样式在 web/pending-state.css（由装配层在 index.html 里登记）。
   */

  /** 占位块的文案与防呆时长。 */
  const PENDING_TEXT = '正在思考';
  const PENDING_TIMEOUT_MS = 30000;

  /** 当前占位块（只是缓存，权威来源永远是 DOM）。 */
  let pendingNode = null;
  /** 防呆计时器的句柄；null 表示没有在跑。 */
  let pendingTimer = null;

  /** 缓存里的占位块还在树上吗？离树（清屏、切会话）就当没有。 */
  function livePending() {
    if (!pendingNode) return null;
    if (!pendingNode.parentNode) {
      pendingNode = null;
      return null;
    }
    return pendingNode;
  }

  function disarmPendingTimer() {
    if (pendingTimer === null) return;
    clearTimer(pendingTimer);
    pendingTimer = null;
  }

  /**
   * 防呆：没网的时候占位块不能一直挂着。到点只让它消失，
   * 不冒充成功、不弹提示（错误提示归 E5 的错误条）。
   */
  function armPendingTimer(node) {
    disarmPendingTimer();
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      // 只摘当初那一个：期间可能已经清了又挂了一块新的
      if (pendingNode === node && node.parentNode) node.parentNode.removeChild(node);
      if (pendingNode === node) pendingNode = null;
    }, PENDING_TIMEOUT_MS);
  }

  /**
   * 收掉占位块。幂等，没有也能调。
   * 调用点：本轮第一个 assistant 正文/思考/工具事件、turn 结束、出错、
   * 切会话与一轮重置（见 resetTurnState）、以及 30 秒防呆。
   */
  function clearPending() {
    disarmPendingTimer();
    const node = pendingNode;
    pendingNode = null;
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /**
   * 挂上占位块（幂等：已经有一块就复用，只把防呆计时器重新计时）。
   *
   * 贴底判定必须落在插入之前：插入本身会改 scrollHeight，插完再问 nearBottom()
   * 永远是「不在底部」，占位块就会埋在屏幕上方看不见。反过来，用户正在往上翻旧消息时
   * 一下都不碰 scrollTop——绝不把人拽下来。
   *
   * @returns {Element|null} 占位块节点；拿不到消息容器时返回 null
   */
  function showPending() {
    const box = container();
    if (!box) return null;

    scrollPin.attach();
    // 插之前量几何：插完 scrollHeight 就变了，再问永远是「不在底部」。
    // 这里要的是「此刻看不看得见底」，不是「用户想不想跟」——后者才用 isPinned()。
    const follow = scrollPin.nearBottom();
    const existing = livePending();
    if (existing) {
      armPendingTimer(existing);
      if (follow) scrollToBottom(true);
      return existing;
    }

    const node = el('div', 'turn assistant pending-tip');
    markTurn(node);
    // 读屏软件也该知道「对方正在输入」，但不要抢焦点
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.appendChild(turnHead('assistant', agentLabel()));

    const main = el('div', 'turn-main');
    const body = el('div', 'turn-body');
    const bubble = el('div', 'pending-bubble');
    const dots = el('span', 'pending-dots');
    for (let i = 0; i < 3; i += 1) dots.appendChild(el('i', 'pending-dot'));
    bubble.appendChild(dots);
    bubble.appendChild(el('span', 'pending-text', PENDING_TEXT));
    body.appendChild(bubble);
    main.appendChild(body);
    node.appendChild(main);

    // 走与真实消息同一条挂载路径：加载更早页时也不会插到锚点后面
    mountTurn(node);
    pendingNode = node;
    armPendingTimer(node);
    if (follow) scrollToBottom(true);
    return node;
  }

  /* ---- 助手消息 ---- */

  function startAssistantTurn() {
    const { turn, main, body } = newTurn('assistant', agentLabel());
    turn.classList.add('streaming');
    // 尾注先挂上，性能数字边跑边补
    const foot = turnFoot();
    main.appendChild(foot);

    state.turn = turn;
    state.turnBody = body;
    state.turnFootEl = foot;
    state.turnMeta = null;
    state.thinkAt = 0;
    state.textEl = null;
    state.streamingRaw = '';
    return turn;
  }

  function addAssistantText(text, turn = state.turn, { append = true } = {}) {
    const body = turn === state.turn && state.turnBody ? state.turnBody : turn.querySelector('.turn-body');
    if (!body) return;
    if (append && turn === state.turn && state.textEl) {
      state.streamingRaw += text;
      scheduleStreamRender();
      return;
    }
    freezeThinkLabel();
    const { mood, body: bodyText } = splitMoodBlock(text);
    if (mood !== null) setMood(mood, turn);
    const node = el('div', 'turn-assistant-text md');
    node.innerHTML = renderMarkdown(bodyText);
    decorateBlocks(node);
    body.appendChild(node);
    if (append && turn === state.turn) {
      state.textEl = node;
      state.streamingRaw = text;
    }
    scrollToBottom();
  }

  let renderPending = false;
  function scheduleStreamRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!state.textEl) return;
      const { mood, body } = splitMoodBlock(state.streamingRaw);
      if (mood !== null) setMood(mood, state.turn);
      state.textEl.innerHTML = renderMarkdown(body);
      decorateBlocks(state.textEl);
      scrollToBottom();
    });
  }

  /* ---- 折叠条：思考与工具调用并成一行，点开才看详情 ---- */

  /**
   * 沉静模式下 .turn-meta 靠自己记「收着」，classic 模式一律摘掉（原生 details 有自己的开合）。
   * 单独成函数是因为三个地方都要用它：新建、切模式、历史行重画。
   */
  function applyMetaCollapsed(d, collapsed) {
    if (!d || !d.classList) return;
    if (collapsed) d.classList.add('collapsed');
    else d.classList.remove('collapsed');
  }

  /**
   * 把当前视图模式落到 DOM 上。
   *
   * 两处都要打：body 是给整页样式用的（比如别的模块也要按模式换皮），
   * .turn-meta 自己那一份是给逐行流水用的——历史行重画时不会经过 setViewMode，
   * 只靠 body 会让「刚载进来的历史」带着上一个模式的类。
   */
  /**
   * 给节点加/去一个 class。
   *
   * 不用 classList.toggle：仓里几个集成测试的假 DOM 只实现了 add/remove/contains，
   * toggle 一调就 TypeError（全量回归已经抓到过一次）。add/remove 是所有夹具都有的交集。
   */
  function setClass(node, name, on) {
    const cl = node && node.classList;
    if (!cl) return;
    if (on) { if (typeof cl.add === 'function') cl.add(name); }
    else if (typeof cl.remove === 'function') cl.remove(name);
  }

  function applyMetaMode(d) {
    if (!d || !d.classList) return;
    setClass(d, 'serene', viewMode === 'serene');
    applyMetaCollapsed(d, viewMode === 'serene');
    // 沉静模式必须让 <details> 保持 open：原生闭合会用 UA 规则把内容整块藏起来，
    // 那是 CSS 盖不住的——「折叠时只露最后一条」得靠 .collapsed 自己管。
    if (viewMode === 'serene') d.open = true;
  }

  function applyViewModeMarker() {
    if (typeof document === 'undefined' || !document.body) return;
    setClass(document.body, 'serene', viewMode === 'serene');
  }

  /**
   * summary 的点击：沉静视图自己管开合，经典视图保持原生 <details> 行为。
   *
   * 用 dataset 标记保证幂等——ensureMeta 会被历史重画复用同一个 .turn-meta，
   * 每复用一次就 addEventListener 一次的话，点一下会连开连关。
   */
  function bindMetaToggle(d) {
    if (!d) return;
    const summaryEl = d.querySelector('summary');
    if (!summaryEl || summaryEl.dataset.sereneToggle === '1') return;
    summaryEl.dataset.sereneToggle = '1';
    summaryEl.addEventListener('click', (event) => {
      if (viewMode !== 'serene') return;   // 经典：让浏览器自己开合 details
      event.preventDefault();              // 沉静：不要原生开合，改成切 class
      const cl = d.classList;
      const collapsed = typeof cl.contains === 'function' ? cl.contains('collapsed') : false;
      setClass(d, 'collapsed', !collapsed);
    });
  }

  function ensureMeta(turn) {
    const live = turn === state.turn;
    if (live && state.turnMeta) return state.turnMeta;
    const body = live && state.turnBody ? state.turnBody : turn.querySelector('.turn-body');
    if (!body) return null;
    let d = body.querySelector('.turn-meta');
    if (!d) {
      d = document.createElement('details');
      d.className = 'turn-meta';
      d.hidden = true;
      d.appendChild(document.createElement('summary'));
      d.appendChild(el('div', 'meta-body'));
      body.insertBefore(d, body.firstChild);
    }
    bindMetaToggle(d);
    // 沉静默认收着（CSS 只露最后一条操作）；经典一进来就是展开的逐条样式。
    applyMetaMode(d);
    if (live) state.turnMeta = d;
    return d;
  }

  /**
   * 把这一轮的摘要画到那一行上。
   *
   * classic：思考时长 + 工具名×次数，与加沉静视图之前逐字一致；
   * serene：只报数（交给注入的 formatSereneSummary），不出现工具名。
   * 两种模式都遵守同一条：本轮没有任何过程内容时整行隐藏。
   */
  function paintMeta(d) {
    if (!d) return;
    const summaryEl = d.querySelector('summary');

    if (viewMode === 'classic') {
      const parts = [];
      if (d._think) parts.push(d._think);
      if (d._tools && d._tools.size) {
        for (const [n, c] of d._tools) {
          const label = prettyToolName(n);
          parts.push(c > 1 ? `${label} ×${c}` : label);
        }
      }
      if (summaryEl) summaryEl.textContent = parts.join(' · ');
      d.hidden = parts.length === 0;
      return;
    }

    const thinkingCount = countOf(d._thinkCount);
    const opCount = toolCount(d);
    const failedCount = countOf(d._failed);
    const turn = turnOfMeta(d);
    const text = summaryOf({
      thinkingCount,
      opCount,
      failedCount,
      // 是否还在流式：以这一轮自己的 .streaming 为准，不看全局游标
      streaming: Boolean(turn && turn.classList.contains('streaming')),
    });
    if (summaryEl) summaryEl.textContent = text;
    d.hidden = thinkingCount === 0 && opCount === 0;
    markLastTool(d);
  }

  /**
   * 沉静视图折叠时只露最后一条操作，靠 .meta-tool.last 认。
   *
   * 每次重画都先摘旧的再打新的：重画的时机不止一处（收尾、切模式、段结束、失败计数），
   * 让这里当唯一负责人，比在每个调用点维护稳。
   */
  function markLastTool(d) {
    const rows = Array.from(d.querySelectorAll('.meta-tool'));
    if (!rows.length) return;
    for (const row of rows) row.classList.remove('last');
    rows[rows.length - 1].classList.add('last');
  }

  /**
   * 一段流结束：只把思考时长定住、刷新摘要，**不收尾**。
   *
   * 宿主一次回复可能拆成好几段流（每个工具回合一段，每段都以 stream_turn_end 结尾），
   * 真正的整轮结束信号是 session_status{isStreaming:false}。
   * 如果拿 stream_turn_end 收尾，就会变成「一个工具一条气泡」、计数永远停在 1。
   */
  function endSegment() {
    if (!state.turn) return;
    freezeThinkLabel();
    paintMeta(state.turnMeta);
  }

  /**
   * 插话：用户中途插进来的那句，当场画在正文里。
   *
   * 不能直接用 appendUser：它开头就 resetTurnState，会把正在跑的这一轮拆成两段。
   * 做法是把当前这一段收尾（摘掉 streaming、定住思考时长），再把用户气泡接在它下面；
   * 后面若还有内容，路由层看到 state.turn 为空会另起一段（.cont），仍属于同一轮。
   */
  function appendInterjection(text, ts = Date.now()) {
    const content = String(text ?? '').trim();
    if (!content) return null;
    if (state.turn) finishTurn(Date.now());
    const built = newTurn('user', app.userName);
    const bubble = el('div', 'bubble-user');
    bubble.innerHTML = renderMarkdown(content);
    decorateBlocks(bubble);
    built.body.appendChild(bubble);
    built.main.appendChild(turnFoot(ts));
    scrollToBottom(true);
    return built.turn;
  }

  function addThinking(text, turn = state.turn) {
    if (!turn) return;
    const d = ensureMeta(turn);
    if (!d) return;
    if (turn === state.turn && !state.replaying && !state.thinkAt) state.thinkAt = performance.now();

    let pre = d.querySelector('.meta-think');
    if (!pre) {
      pre = el('div', 'meta-think');
      d.querySelector('.meta-body').appendChild(pre);
    }
    pre.textContent += text;

    // 思考按「段」计数：thinking_delta 是逐块推的，同一个持续段里每个 delta 都调一次
    // 这里，按调用次数累加会数成几十上百次。只有上一件事不是思考时才算新的一段。
    if (!d._thinkOpen) {
      d._thinkCount = countOf(d._thinkCount) + 1;
      d._thinkOpen = true;
    }

    if (turn === state.turn && state.thinkAt) {
      // 经典视图的时长要累加：一段思考接一段思考时，不能只报最后一段
      d._think = thinkLabel((d._thinkTotal || 0) + (performance.now() - state.thinkAt) / 1000);
    } else if (!d._think) {
      d._think = '思考';
    }
    paintMeta(d);
    scrollToBottom();
  }

  /** 正文开始吐字时把思考时长定住，不再往上涨。 */
  function freezeThinkLabel() {
    const d = state.turnMeta;
    if (!d) return;
    // 正文来了就是这一段思考的终点，后面再有思考算新的一段。
    d._thinkOpen = false;
    if (!state.thinkAt) return;
    // 累加而不是覆盖：经典视图报的是这一轮的总思考时长
    d._thinkTotal = (d._thinkTotal || 0) + (performance.now() - state.thinkAt) / 1000;
    d._think = thinkLabel(d._thinkTotal);
    state.thinkAt = 0;
    paintMeta(d);
  }

  /** 图标与勾叉只是装饰：读屏软件念出来只会打乱「谁做了什么」的节奏。 */
  function decoration(node) {
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  /**
   * 加一行工具操作。
   *
   * 行里同时住两套东西：
   *  - `.name` / `.state`：改动之前就在的，经典视图的逐条列表与回归断言靠它们；
   *  - `.op-icon` / `.op-text`（`.op-verb` + `.op-arg`）/ `.op-mark`：沉静视图的「流水」样子，
   *    由 tool-ops.js 翻译成人话，参数只写在 .op-arg 里，不污染 summary 文案。
   *
   * @param {string} name 宿主原始工具名（可能带 app__ 前缀与尾部调用 hash）
   * @param {Element} [turn] 属于哪一轮
   * @param {string} [toolState] 行尾状态；传「运行中」以外的值表示这一行天生就是收尾态（历史回放）
   * @param {string|number|null} [toolCallId] tool_end 回填时的匹配键
   * @param {object|string|null} [args] tool_start 的入参（宿主白名单键），只用来写一句人话
   * @returns {Element|null}
   */
  function addTool(name, turn = state.turn, toolState = '运行中', toolCallId = null, args = null) {
    if (!turn) return null;
    const d = ensureMeta(turn);
    if (!d) return null;
    if (!d._tools) d._tools = new Map();
    d._tools.set(name, (d._tools.get(name) || 0) + 1);
    // 工具调用把上一段思考收尾：之后再有思考就算新的一段。
    d._thinkOpen = false;

    const op = describeToolOp(name, args);
    // 历史回放直接传「完成」：这一行天生就是收尾态，动词也得用完成式。
    const finished = Boolean(toolState) && toolState !== '运行中';

    const row = el('div', 'meta-tool');
    if (toolCallId) row.dataset.toolCallId = String(toolCallId);
    row.dataset.kind = op.kind;
    // 三态：'' 还在跑、'true' 成功、'false' 失败。CSS 只用后两个。
    row.dataset.ok = finished ? 'true' : '';
    // 收尾事件不带 args，而只有那时才知道成没成：先把两种说法存在行上。
    row.dataset.verbDone = op.verbDone;
    row.dataset.verbFailed = op.verbFailed;

    row.appendChild(decoration(el('span', 'op-icon', op.icon)));
    row.appendChild(el('span', 'name', prettyToolName(name)));

    const text = el('span', 'op-text');
    text.appendChild(el('span', 'op-verb', finished ? op.verbDone : op.verbRunning));
    // 没参数就不画 .op-arg：空 span 在 flex 里也会占一个 gap，白撑一道缝。
    if (op.argText) text.appendChild(el('span', 'op-arg', op.argText));
    row.appendChild(text);

    row.appendChild(el('span', 'state', toolState));
    row.appendChild(decoration(el('span', 'op-mark', finished ? '✓' : '')));

    d.querySelector('.meta-body').appendChild(row);
    paintMeta(d);
    scrollToBottom();
    return row;
  }

  /**
   * 标记一个工具调用收尾。
   *
   * 匹配规则与改沉静视图之前一致（bugs_regression「缺陷3补充」盯着这一条）：
   *   - 带 callId：只按 dataset.toolCallId 精确匹配，找不到就什么都不做，
   *     绝不把别的运行中工具误标成完成；
   *   - 缺 callId：才回退到最后一个未完成的工具行。
   * 失败要单独计入 d._failed（沉静视图的「n 项未成功」），操作总数不因此减少。
   *
   * @param {string|number|null} callId
   * @param {boolean} ok false 表示这次调用失败
   * @param {{success?: boolean, status?: string|null}|null} [meta] 宿主 tool_end 的原始判据。
   *   路由那边已经把 error/status 化简成 ok，这里只用它补一种情况：宿主只说
   *   `success:false`、既没 error 也没 status 的失败（以前这种会被当成完成）。
   * @returns {boolean} 是否找到了要标记的行
   */
  function finishTool(callId, ok = true, meta = null) {
    const d = state.turnMeta || lastMeta();
    if (!d) return false;
    const rows = Array.from(d.querySelectorAll('.meta-tool:not(.done)'));
    let target = null;
    if (callId) {
      target = rows.find((row) => row.dataset && row.dataset.toolCallId
        && String(row.dataset.toolCallId) === String(callId)) || null;
    } else {
      target = rows[rows.length - 1] || null;
    }
    if (!target) return false;

    const failed = ok === false
      || (Boolean(meta) && (meta.success === false || meta.status === 'failed' || meta.status === 'error'));

    target.classList.add('done');
    target.dataset.ok = failed ? 'false' : 'true';
    if (failed) target.classList.add('failed');
    else target.classList.remove('failed');

    const verbEl = target.querySelector('.op-verb');
    if (verbEl) {
      const words = (failed ? target.dataset.verbFailed : target.dataset.verbDone) || '';
      if (words) verbEl.textContent = words;
    }
    const markEl = target.querySelector('.op-mark');
    if (markEl) markEl.textContent = toolMark(failed);

    const stateEl = target.querySelector('.state');
    if (stateEl) stateEl.textContent = toolStateText(failed);
    if (failed) d._failed = countOf(d._failed) + 1;
    paintMeta(d);
    return true;
  }

  function finishTurn(ts = Date.now()) {
    if (state.turn) {
      freezeThinkLabel();
      state.turn.classList.remove('streaming');
      // 流式标记已摘掉：重画一次摘要，沉静视图的「正在进行」要跟着消失。
      paintMeta(state.turnMeta);
      if (state.textEl) {
        const { mood, body } = splitMoodBlock(state.streamingRaw);
        if (mood !== null) setMood(mood, state.turn);
        state.textEl.innerHTML = renderMarkdown(body);
        decorateBlocks(state.textEl);
      }
      const foot = state.turnFootEl;
      if (foot) {
        const t = foot.querySelector('.foot-time');
        if (t) t.textContent = clockText(ts);
      } else {
        const main = state.turn.querySelector('.turn-main');
        if (main) main.appendChild(turnFoot(ts));
      }
    }
    resetTurnState();
    onBusyChange(false);
  }

  /**
   * 把屏幕上所有还挂着「streaming」的轮收尾。
   *
   * 用在「收到了整轮结束信号、但本地已经没有活轮」的时候：典型场景是 App 在生成中途
   * 重启，历史补回来的那一轮带着 streaming 标记，而它的结束信号早在重载前就发过了。
   * 不清就会永久停在「正在进行」。
   */
  function endStaleStreamingTurns() {
    const box = container();
    if (!box) return;
    for (const turn of Array.from(box.querySelectorAll('.streaming'))) {
      turn.classList.remove('streaming');
      const d = turn.querySelector('.turn-meta');
      if (d) paintMeta(d);
    }
  }

  function resetTurnState() {
    // 轮次重置：回放里的「连续 assistant 合并」也到此为止。
    replayTurn = null;
    clearLiveTurn();
    // 历史页回放里的 user 条目也会走到这里：这时只能结束合并、不能收占位块、不能报 busy。
    // 否则生成中 prepend 一页就会把「正在生成」误报成「空闲」，发送键变回来、
    // open/重载的 busy 保护也一起失效。
    if (historyPageActive) return;
    // 真正的一轮重置（切会话 / 退出登录 / 回列表）：暂存里如果还握着上一份实时轮，一并丢掉
    stashedLiveTurn = null;
    // 一轮结束/重置也意味着「不用再等了」。这一步还顺带盖住了所有无事件可接的
    // 切会话路径（conversation-controller 的 openSession / backToList 都会调这里），
    // 不会把上一个会话的占位块带到下一个会话。
    clearPending();
    onBusyChange(false);
  }

  /* ---- MOOD ---- */

  function ensureMoodEl(turn = state.turn) {
    const live = turn === state.turn;
    if (live && state.moodEl) return state.moodEl;
    const host = (live && state.turnBody ? state.turnBody : turn?.querySelector('.turn-body')) || container();
    let d = host.querySelector('.mood-strip');
    if (d) {
      if (live) state.moodEl = d;
      return d;
    }
    d = document.createElement('details');
    d.className = 'mood-strip';
    const s = document.createElement('summary');
    s.textContent = '心里的嘀咕';
    d.appendChild(s);
    d.appendChild(el('div', 'mood-body'));
    host.appendChild(d);
    if (live) { state.moodEl = d; state.moodRaw = ''; }
    return d;
  }

  /** 写入 mood 内容。两条来源（服务端 mood 事件 / 正文里的块）取更完整的那个。 */
  function setMood(text, turn = state.turn) {
    const inner = cleanMoodText(text);
    if (!inner) return;
    const d = ensureMoodEl(turn);
    const box = d.querySelector('.mood-body');
    if (!box) return;
    const prev = turn === state.turn ? state.moodRaw : box.textContent;
    if (prev && inner.length < prev.length) return;
    box.textContent = inner;
    if (turn === state.turn) state.moodRaw = inner;
  }

  function appendMood(text) {
    setMood(`${state.moodRaw}${text}`);
    scrollToBottom();
  }

  /* ---- 卡片 ---- */

  /* ---- 会话文件卡片 ---- */

  /**
   * 实时路径的落点：最近一条助手消息的正文末尾。
   * 只给「轮次之外的实时文件事件」兜底；历史回放不走这里——整份 transcript 的
   * 「最后一个 assistant」可能属于更新的一页，prepend 时会错挂，页里没有 assistant 时会丢文件。
   */
  function lastAssistantBody() {
    // 占位块也带 .turn.assistant（共享骨架），但它没有正文，不能被当成落点：
    // 文件卡寄进去之后，占位块一收就会把它一起端走。
    const turns = Array.from(container().querySelectorAll('.turn.assistant'))
      .filter((node) => !node.classList.contains('pending-tip'));
    const last = turns[turns.length - 1];
    return last ? last.querySelector('.turn-body') : null;
  }

  /** 把文件描述一张张画成卡片，挂到 target（调用方保证 target 属于当前上下文）。 */
  function drawFileCards(files, target) {
    if (!target) return false;
    let drew = false;
    for (const f of files) {
      const card = renderFileCard(f, {
        onOpen: () => {
          // 解析是异步的：先钉住这次点击属于哪个会话、哪个登录身份。
          // 晚到的成功/失败都属于旧页面（切会话、返回列表、退出登录），一律丢弃。
          const owner = app.principal;
          const session = app.session;
          const stillHere = () => app.principal === owner && app.session === session;
          // 正文照常可点开：读地址（资源地址也行）和下载地址是两回事。
          fileUrls.forFile(f).then(({ readUrl, downloadUrl }) => {
            if (!stillHere()) return;
            if (!readUrl) { flash('这个文件暂时拿不到可读地址，打不开'); return; }
            openFilePreview({ file: f, readUrl, downloadUrl, renderMarkdown });
          }).catch((err) => {
            if (!stillHere()) return;
            flash('预览失败: ' + (err.message || String(err)));
          });
        },
        // 下载统一走 download.js：WebView 不认 <a download>，只能靠导航 + 网关的
        // Content-Disposition，而且地址必须在壳的下载白名单里。
        onDownload: (url) => {
          startDownload(url, { onReject: () => flash('这个文件没有壳认的下载地址，暂时下不了') });
        },
      });
      target.appendChild(card);
      // 下载入口要查工作区根，可能晚到；先渲染卡片，到了再补。
      // 没有下载地址就不补：宁可没有下载按钮，也不要给一个点了必错的入口。
      fileUrls.forFile(f).then(({ downloadUrl }) => {
        if (downloadUrl) setFileCardHref(card, downloadUrl);
      }).catch(() => {});
      drew = true;
    }
    return drew;
  }

  /**
   * 实时文件卡（stage_files 的 content_block）：挂当前实时轮，
   * 轮已收尾时退回最近一条助手正文。
   * @param {Array} files  宿主的 file 对象（filePath/fileId/label/ext/size）
   * @param {Element|null} host  指定落点；不传就按实时上下文取
   */
  function appendFileCards(files, host = null) {
    const drew = drawFileCards(files, host || state.turnBody || lastAssistantBody());
    if (drew && !getHistoryView().isPrepending()) scrollToBottom(true);
    return drew;
  }

  /**
   * 历史回放的 file 块：只认本页的最近落点（user / assistant 都算）。
   *
   * 宿主给的 afterIndex 是页内锚点，可能落在 user 后面；state.turnBody 是实时/上一页的指针，
   * lastAssistantBody() 找到的是整份 transcript 的最后一个 assistant（prepend 时是更新的一页）。
   * 两者都不能用：本页还没有落点（首条消息没画出来）就按本页顺序独立呈现，不丢文件。
   */
  function appendHistoryFileCards(files) {
    if (pageBody) {
      const drew = drawFileCards(files, pageBody);
      if (drew && !getHistoryView().isPrepending()) scrollToBottom(true);
      return drew;
    }
    const box = el('div', 'turn-body history-file-cards');
    if (!drawFileCards(files, box)) return false;
    // 走 historyView.append：prepend 时插在锚点前，位置就是本页该在的位置。
    getHistoryView().append(box);
    if (!getHistoryView().isPrepending()) scrollToBottom(true);
    return true;
  }

  function appendCard(ev, { sessionFiles = [] } = {}) {
    const sessionSnapshot = {
      sessionId: app.session?.sessionId || null,
      sessionPath: app.session?.path || null,
      agentId: app.session?.agentId || null,
    };
    const cardNode = cardController.render(ev, sessionSnapshot, { sessionFiles });
    getHistoryView().append(cardNode);
    if (!getHistoryView().isPrepending()) scrollToBottom(true);
  }


  function clearStats() {
    state.turnStart = 0;
    state.firstTokenMs = 0;
    state.charCount = 0;
    state.speed = 0;
  }

  /** 尾注里的数字：边跑边补，不占正文空间。文案与四舍五入在 renderer-stats.js。 */
  function paintFootStats() {
    const foot = state.turnFootEl;
    if (!foot) return;
    const box = foot.querySelector('.foot-stats');
    if (!box) return;
    box.textContent = footStatsText({ firstTokenMs: state.firstTokenMs, speed: state.speed });
  }

  function markStreamStart() {
    if (!state.turnStart) state.turnStart = performance.now();
  }

  function markFirstToken() {
    if (state.firstTokenMs || !state.turnStart) return;
    state.firstTokenMs = performance.now() - state.turnStart;
    paintFootStats();
  }

  function markTurnEnd() {
    // 门槛（不足 40 字、或扣掉首响不足 0.2 秒）在 speedOf 里；返回 0 表示样本不够，
    // 这时保留上一次的速度，不当成「速度为零」。
    const speed = speedOf({
      firstTokenMs: state.firstTokenMs,
      charCount: state.charCount,
      elapsedMs: performance.now() - state.turnStart,
    });
    if (speed) state.speed = speed;
    paintFootStats();
  }

  return {
    // 结构件
    container,
    nearBottom,
    scrollToBottom,
    clockText,
    // 用户 / 系统
    appendUser,
    appendInterjection,
    appendSystem,
    // 占位块（E4：点发送到模型出字之间的「正在思考」）
    showPending,
    clearPending,
    // 助手
    startAssistantTurn,
    addAssistantText,
    addThinking,
    addTool,
    finishTool,
    paintMeta,
    setViewMode,
    endSegment,
    // mood_start 由 event-router 先建容器（那样嘀咕条在第一段 delta 之前就出现），
    // 所以它必须是导出成员。setMood 内部也会调它，幂等，重复调用复用同一条。
    ensureMoodEl,
    setMood,
    appendMood,
    finishTurn,
    resetTurnState,
    // 卡片与文件
    appendCard,
    appendFileCards,
    lastAssistantBody,
    // 历史回放
    renderEntry,
    // 一页历史的回放边界（见 beginHistoryPage / endHistoryPage）
    beginHistoryPage,
    endHistoryPage,
    // 尾注数字
    clearStats,
    paintFootStats,
    markStreamStart,
    markFirstToken,
    markTurnEnd,
    endStaleStreamingTurns,
    // 外部访问器：流式渲染状态现在归渲染器私有（web/renderer-state.js），
    // 事件路由 / 会话控制 / 输入区从这里读和写，不再直接碰 state 的内部字段。
    // 只加不改——上面那些方法的签名与语义都没动。
    hasTurn: () => Boolean(state.turn),
    paintCurrentMeta: () => (state.turnMeta ? paintMeta(state.turnMeta) : undefined),
    noteChars: (n) => {
      state.charCount += Number(n) || 0;
    },
    currentStreamingRaw: () => state.streamingRaw,
    noteSendStart: () => {
      state.turnStart = performance.now();
    },
    clearMood: () => {
      state.moodEl = null;
      state.moodRaw = '';
    },
    // 调试/测试常用的两个
    mediaGrid,
    openLightbox,
  };
}
