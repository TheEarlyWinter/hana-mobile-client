/* web/subagent-sheet.js — 子代理详情页（底部弹出，占屏幕 3/4）
 *
 * 管什么：
 *  - createSubagentSheet({...}) 造一个只读详情 sheet，返回
 *    { open(target), close(reason), isOpen(), update(patch), destroy() }；
 *  - open 时画身份区（头像 / 名字 / `label · model` / 状态 / 三格统计 /「它被要求」），
 *    正文交给注入的 loadTranscript 取一次，然后四态互斥地画出来；
 *  - 点遮罩、点 ✕、抓头部下拖、按 Escape 四种关闭，reason 交回 onDismiss；
 *  - 打开期间：焦点收进面板、Tab 在面板里循环、背后页面锁住不滚（关闭时按原值还回去）。
 *
 * 不管什么：
 *  - 不发任何请求、不读全局 document、不碰 style.css / app.js / index.html；
 *    正文数据一律走 loadTranscript（契约 0 节：不做追问、不做实时追加）；
 *  - 样式在 web/subagent-sheet.css，类名是本文件与 CSS 之间唯一的契约（契约 2.3）。
 *
 * 为什么用闭包变量而不是 class 写状态机：这里的状态只有「开 / 关 / 正在关」加一份 target，
 * 拆成 class 只会让 destroy 与在途 load 的竞态更难读。在途正文用 loadToken 作废：
 * 关闭、重开、destroy 都会 +1，晚到的结果一律丢弃——重开时串上一份正文是这里最容易犯的错。
 *
 * 注入：document / mount / timers 都能从参数传（假 DOM 测试不需要真等待）；
 * timers 只用于「骨架至少一帧」与关闭动画的兜底收尾，模块不碰 setInterval。
 */

/** 契约 2.6 的五种状态。 */
const STATUS_TEXT = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
  idle: '未开始',
};

/**
 * 宿主/历史里的状态别名 → 本模块认的五个。与 web/subagent-view.js 保持同一套口径
 * （那边不能 import，这里也不能）：aborted / interrupted 在详情页统一记作「已取消」，
 * 因为对用户来说都是「没跑完就不跑了」。认不出来的脏值按 running（与卡片一致），
 * 空值才是 idle——没给状态说明还没开始，给了一个陌生的非空状态说明它在动。
 */
const STATUS_ALIAS = {
  running: 'running',
  pending: 'running',
  queued: 'running',
  dispatched: 'running',
  preparing: 'running',
  thinking: 'running',
  callingtool: 'running',
  executing: 'running',
  done: 'done',
  success: 'done',
  succeeded: 'done',
  complete: 'done',
  completed: 'done',
  resolved: 'done',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  aborted: 'canceled',
  abort: 'canceled',
  cancelled: 'canceled',
  canceled: 'canceled',
  interrupted: 'canceled',
  idle: 'idle',
  pendingstart: 'idle',
};

/** 步骤种类与状态：契约 2.3 的 data-kind / data-status 取值，其余一律收拢。 */
const STEP_KINDS = new Set(['think', 'tool', 'say', 'ask', 'note']);
const STEP_STATUS = new Set(['ok', 'running', 'failed']);

/** title 缺省时按种类兜一句话，宁可少画也不要一行空白标题。 */
const KIND_TITLE = {
  think: '思考',
  tool: '工具',
  say: '结论',
  ask: '交给它的事',
  note: '说明',
};

/** 契约 2.5：松手时位移超过这个值就关闭。 */
const DRAG_CLOSE_PX = 80;

/** 骨架换内容前的下限：一帧（约 60Hz）。契约要求「至少显示一帧」。 */
const FRAME_MS = 16;

/** 关闭动画 280ms + 余量。transitionend 没来（省电模式 / 没加载样式 / 测试）时靠它收尾。 */
const CLOSE_FALLBACK_MS = 360;

/** 空态文案（契约 2.2：没有子会话身份时的正文）。 */
const EMPTY_TEXT = '没有可读的过程';

const DASH = '—';

/**
 * 祖先链遍历的步数上限。
 *
 * 上一版焦点陷阱就是在这里挂死的：`while (cur) cur = cur.parentNode` 在假 DOM / 被
 * remove() 过的节点上可能撞到自指（parentNode 指回自己）或环，循环永不退出——测试进程
 * 只能被杀，真实浏览器里按一下 Tab 就把界面卡死。所有向上走的地方统一走 walkUp()。
 */
const MAX_ANCESTOR_STEPS = 64;

/**
 * .ss-flow 的 id 序号。折叠按钮用 aria-controls 指向它，而同一份文档里
 * 可能同时存在多个 sheet 实例（测试就有好几份），id 必须逐个给。
 */
let flowSeq = 0;

/* ------------------------------ 纯工具 ------------------------------ */

/** 只认非空字符串：数字 taskId、布尔 name 这类脏数据一律当没有。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numOrNull(value) {
  // null / 空串是「没有这个数」，不是 0：以前 Number(null) === 0，
  // 宿主显式下发的 durationMs: null 会被画成「0ms」。
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeStatus(raw) {
  const key = text(raw).toLowerCase();
  if (!key) return 'idle';
  return STATUS_ALIAS[key] || 'running';
}

/** 首字：英文首字母大写，中文取第一个字；空值给一个居中点（与 subagent-view 一致）。 */
function initialOf(name) {
  const s = text(name);
  if (!s) return '·';
  return /[a-zA-Z]/.test(s[0]) ? s[0].toUpperCase() : s[0];
}

/**
 * 用时文案。小于 1s 给毫秒，1 分钟内给一位小数秒，再长给「分秒」——
 * 子代理多半跑几秒到几分钟，这三种量级的分辨率都够用，也都不超过统计格宽度。
 */
/* 思考与工具行不跑 markdown，但模型常带 **强调** 和 `代码`；原样上屏就是一堆
 * 星号，在只读时间轴里很脏，所以这里轻轻剥掉标记。 */
function plainText(value) {
  return String(value == null ? '' : value)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1');
}

/**
 * 用时取值：宿主给了 durationMs 就用它；没给但有起点就按现在现算。
 * live 起来的胶囊把 startedAt 一起带进来，宿主只在跑完那一帧才补 durationMs，
 * 所以运行中完全依赖这一条，否则统计格永远是「—」。
 */
function resolveDuration(item) {
  if (item.durationMs != null) return item.durationMs;
  if (item.startedAt == null) return null;
  return Math.max(0, Date.now() - item.startedAt);
}

function formatDuration(ms) {
  // 没给时长就是「不知道」，不是 0：Number(null) === 0，不挡这一下会把空值画成 0ms
  if (ms == null || ms === '') return DASH;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) {
    const seconds = n / 1000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const total = Math.round(n / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function readPoint(event) {
  if (!event) return null;
  const y = Number(event.clientY);
  if (!Number.isFinite(y)) return null;
  return { y };
}

/**
 * 从 node 往上走祖先链，走过的节点记进 Set：撞到环、走过上限、遇到非对象脏值
 * 一律立刻收工并返回 false。onStep 返回 true 表示「找到了」并提前结束；
 * stopAt 给了的话，走到那个节点就不再往上（不算命中）。
 *
 * 这是本模块唯一允许出现的向上遍历形态：任何 while (cur = cur.parentNode) 都算缺陷。
 */
function walkUp(node, onStep, { limit = MAX_ANCESTOR_STEPS, stopAt = null } = {}) {
  const seen = new Set();
  let cur = node;
  let steps = 0;
  while (cur && steps < limit) {
    if (typeof cur !== 'object') return false;   // 脏 parentNode（字符串 / 数字）：当没找到
    if (seen.has(cur)) return false;             // 自指或环：安全值是「不属于 / 不在了」
    seen.add(cur);
    steps += 1;
    if (onStep(cur) === true) return true;
    if (stopAt && cur === stopAt) return false;  // 到界了：不再往上走
    cur = cur.parentNode;
  }
  return false;
}

/** node 是否在 root 子树里（含 root 自己）。环上一律判 false。 */
function isInsideNode(root, node) {
  if (!root || !node) return false;
  return walkUp(node, (cur) => cur === root);
}

/** node 是否仍挂在文档上（假 DOM 里 body 的 parentNode 是 null，所以按三种顶节点认）。 */
function isConnectedNode(doc, node) {
  if (!doc || !node) return false;
  let top = null;
  walkUp(node, (cur) => { top = cur; return false; });
  if (!top) return false;
  return top === doc || top === doc.documentElement || top === doc.body;
}

function setAttrs(node, attrs) {
  if (!node || typeof node.setAttribute !== 'function') return;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
}

/** 宿主抛错不该把 sheet 带崩：头像地址来源是装配方的，出错就当「没有头像」。 */
function readAvatarUrl(avatarUrlById, agentId) {
  if (typeof avatarUrlById !== 'function' || !agentId) return null;
  try {
    return text(avatarUrlById(agentId)) || null;
  } catch (err) {
    console.error('[subagent-sheet] avatarUrlById error:', err);
    return null;
  }
}

/** target 归一化：字段缺失不许抛异常，缺名字给「分身」，缺状态给 idle。 */
function normalizeTarget(raw) {
  return {
    taskId: text(raw.taskId),
    name: text(raw.name) || '分身',
    label: text(raw.label) || null,
    model: text(raw.model) || null,
    status: normalizeStatus(raw.status),
    sessionId: text(raw.sessionId) || null,
    sessionPath: text(raw.sessionPath) || null,
    agentId: text(raw.agentId) || null,
    durationMs: numOrNull(raw.durationMs),
    // 开始时间：live 起来的胶囊会带，宿主跑完才补 durationMs。缺了就显示「—」，不编数。
    startedAt: numOrNull(raw.startedAt),
    stepCount: numOrNull(raw.stepCount),
    toolCount: numOrNull(raw.toolCount),
    task: text(raw.task) || null,
  };
}

/** Step[] → 能直接画的最小形状；脏条目跳过，认不出的 kind 归 note（契约 3.2 的兜底）。 */
function normalizeSteps(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = text(raw.kind).toLowerCase();
    const status = text(raw.status).toLowerCase();
    const title = text(raw.title);
    const body = typeof raw.text === 'string' ? raw.text : '';
    if (!title && !body.trim()) continue;      // 空步骤不占一行，与 transcript 的规则对齐
    const normalizedKind = STEP_KINDS.has(kind) ? kind : 'note';
    out.push({
      kind: normalizedKind,
      status: STEP_STATUS.has(status) ? status : 'ok',
      title: title || KIND_TITLE[normalizedKind] || '',
      meta: text(raw.meta),
      text: body,
    });
  }
  return out;
}

/* ------------------------------ 工厂 ------------------------------ */

/**
 * 造一个子代理详情 sheet。
 *
 * @param {object} [options]
 * @param {Document} options.document 注入的 document（必填，不读全局）
 * @param {Element} [options.mount] 挂载点，默认 doc.body
 * @param {(target: object) => Promise<Array>} [options.loadTranscript]
 *   取正文的注入点：sheet 自己不发请求；没接就当「没有可读的过程」
 * @param {(agentId: string) => (string|null)} [options.avatarUrlById] 头像地址来源
 * @param {(reason: 'backdrop'|'close'|'drag'|'escape'|'api') => void} [options.onDismiss] 关闭回调
 * @param {() => void} [options.focusReturn] 关闭后把焦点交回触发元素的钩子（契约 2.5）；
 *   不接时 sheet 自己把焦点递回打开前的落点
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 *   骨架帧与关闭兜底用的定时器（测试注入假定时器）
 * @returns {{open: Function, close: Function, isOpen: Function, update: Function, destroy: Function}}
 */
export function createSubagentSheet({
  document: doc = null,
  mount = null,
  loadTranscript = null,
  avatarUrlById = null,
  // 可选：markdown → HTML。只用于 say / ask 两类正文，思考与工具行保持纯文本
  renderText = null,
  onDismiss = null,
  focusReturn = null,
  timers = globalThis,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createSubagentSheet 需要 { document }');
  }
  const host = mount || doc.body;
  if (!host || typeof host.appendChild !== 'function') {
    throw new TypeError('createSubagentSheet 需要一个能 appendChild 的 mount 容器');
  }

  const timerApi = timers && typeof timers === 'object' ? timers : globalThis;

  /** open 的那一份身份 + 顶部数字；update() 只改这里。 */
  let target = null;
  let open = false;
  let destroyed = false;
  /** 在途正文的代号：关闭 / 重开 / destroy 都 +1，晚到的结果直接丢。 */
  let loadToken = 0;
  /** 已渲染的步骤快照：视图模式在位切换时用它重画，null 表示当前正文不是步骤态。 */
  let lastSteps = null;

  let root = null;
  let backdrop = null;
  let panel = null;
  let grab = null;
  let head = null;
  let avatarBox = null;
  let avatarChild = null;
  let avatarKey = null;
  let deadAvatarUrl = null;
  let nameEl = null;
  let roleEl = null;
  let statusEl = null;
  let closeBtn = null;
  let statsEl = null;
  let statsKey = null;
  let taskEl = null;
  let taskTextEl = null;
  let flowEl = null;

  /** 进行中的下拉手势；null 表示没有。 */
  let drag = null;
  /** 打开前页面的焦落点：没接 focusReturn 时由 sheet 自己把火递回去。 */
  let prevFocus = null;
  /** 背景滚动锁的原始值；null 表示当前没锁。 */
  let scrollLock = null;
  /** 挂在 document 上的 escape 兜底监听（只在打开期间存在）。 */
  let docKeyBound = false;
  /** 关闭动画的兜底定时器。 */
  let closeTimer = null;
  /** 所有自己排上的定时器，destroy / 重开时统一清掉。 */
  const pendingTimers = new Set();

  /* --------------------------- 定时器 --------------------------- */

  function later(fn, ms) {
    if (typeof timerApi.setTimeout !== 'function') return null;
    const id = timerApi.setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    if (id != null) pendingTimers.add(id);
    return id;
  }

  function clearLater(id) {
    if (id == null) return;
    pendingTimers.delete(id);
    if (typeof timerApi.clearTimeout === 'function') timerApi.clearTimeout(id);
  }

  function clearTimers() {
    for (const id of [...pendingTimers]) clearLater(id);
    closeTimer = null;
  }

  /** 一帧：骨架换内容之前至少过一帧，避免「还没画就被替换」的闪跳。 */
  function waitFrame() {
    return new Promise((resolve) => {
      const id = later(resolve, FRAME_MS);
      if (id == null) resolve();
    });
  }

  /* --------------------------- DOM 小工具 --------------------------- */

  function create(tag, className, content) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = String(content);
    return node;
  }

  function createButton(className, label, content) {
    const btn = create('button', className, content);
    setAttrs(btn, { type: 'button', 'aria-label': label });
    return btn;
  }

  /* --------------------------- 头部身份区 --------------------------- */

  function avatarInitialNode(initial) {
    // 装饰性：名字已经由 .ss-name 念出来，读屏器不必再读一次首字
    return create('span', 'ss-avatar-initial', initial);
  }

  function avatarImgNode(url, initial) {
    const img = create('img', 'ss-avatar-img');
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      // 撞过 404 的地址记下来，后面别再撞：详情页上宁可是首字，也不要一张破图
      deadAvatarUrl = url;
      if (avatarChild !== img || !avatarBox) return;   // 已经换成别的身份了，别抢
      const fallback = avatarInitialNode(initial);
      avatarBox.replaceChild(fallback, img);
      avatarChild = fallback;
      avatarKey = `initial:${initial}`;
    });
    img.src = url;
    return img;
  }

  function paintAvatar() {
    if (!avatarBox) return;
    const raw = readAvatarUrl(avatarUrlById, target.agentId);
    const url = raw && raw !== deadAvatarUrl ? raw : null;
    const initial = initialOf(target.name);
    const key = url ? `url:${url}` : `initial:${initial}`;
    if (avatarKey === key && avatarChild && avatarChild.parentNode === avatarBox) return;
    avatarKey = key;
    const next = url ? avatarImgNode(url, initial) : avatarInitialNode(initial);
    if (avatarChild && avatarChild.parentNode === avatarBox) avatarBox.replaceChild(next, avatarChild);
    else avatarBox.appendChild(next);
    avatarChild = next;
  }

  function paintStats() {
    const cells = [
      ['用时', formatDuration(resolveDuration(target))],
      ['步骤', target.stepCount == null ? DASH : String(target.stepCount)],
      ['工具', target.toolCount == null ? DASH : String(target.toolCount)],
    ];
    const key = cells.map(([, value]) => value).join('|');
    if (statsKey === key) return;     // 补丁只改状态时不必重铸三格
    statsKey = key;
    statsEl.replaceChildren();
    for (const [label, value] of cells) {
      const cell = create('div', 'ss-stat');
      cell.appendChild(create('b', null, value));
      cell.appendChild(create('small', null, label));
      statsEl.appendChild(cell);
    }
  }

  /**
   * 身份区第二行：`label · model`。
   *
   * 契约里 label 是「这次派活的短标签」（如「审3：theme 模块」），跟 name（分身名）
   * 是两回事：两者相同时再摆一遍就是同一句话写两次，所以只留 model。
   */
  function roleText(t) {
    const label = t.label && t.label !== t.name ? t.label : null;
    return [label, t.model].filter(Boolean).join(' · ');
  }

  /** 顶部身份区整体刷新；update(patch) 走的就是这里，正文一律不动。 */
  function paintIdentity() {
    if (!target || !root) return;
    nameEl.textContent = target.name;
    const role = roleText(target);
    roleEl.textContent = role;
    roleEl.hidden = !role;

    statusEl.textContent = STATUS_TEXT[target.status] || STATUS_TEXT.idle;
    statusEl.dataset.status = target.status;

    paintAvatar();
    paintStats();

    taskTextEl.textContent = target.task || '';
    taskEl.hidden = !target.task;
    root.dataset.taskId = target.taskId;
  }

  /* --------------------------- 正文四态 --------------------------- */

  function buildStep(step) {
    const row = create('div', 'ss-step');
    row.dataset.kind = step.kind;
    row.dataset.status = step.status;
    const body = create('div', 'ss-step-body');
    const titleRow = create('div', 'ss-step-title');
    titleRow.appendChild(create('b', null, step.title));
    if (step.meta) titleRow.appendChild(create('span', null, step.meta));
    body.appendChild(titleRow);

    const textEl = create('div', 'ss-step-text');
    textEl.hidden = !step.text;      // 没有正文的空行会把时间轴撑得很空
    if (step.text) {
      // 正文走注入的 markdown 渲染器（与聊天同一套，会把 ** 与反引号消化掉）；
      // 没注入就退纯文本，模块仍不认识 md。
      const wantsMarkdown = step.kind === 'say' || step.kind === 'ask';
      if (wantsMarkdown && typeof renderText === 'function') {
        try {
          textEl.innerHTML = renderText(step.text);
        } catch {
          textEl.textContent = step.text;
        }
      } else {
        textEl.textContent = plainText(step.text);
      }
    }
    body.appendChild(textEl);

    // 沉静视图下思考只显一行；点整行展开 / 收起（经典视图给全文，不提供展开入口）
    if (step.kind === 'think' && step.text) {
      // 沉静下这行本质是个「展开正文」的按钮：补上键盘与读屏语义。
      // 经典视图里正文本来就全铺开，加了 role/tabindex 反而会多出一个按了没反应的控件。
      if (viewMode === 'serene') {
        setAttrs(row, { role: 'button', tabindex: '0', 'aria-expanded': 'false' });
      }
      const toggleRow = () => {
        if (viewMode !== 'serene' || !row.classList) return;
        const expanded = !row.classList.contains('is-expanded');
        row.classList.toggle('is-expanded', expanded);
        setAttrs(row, { 'aria-expanded': expanded ? 'true' : 'false' });
      };
      row.addEventListener('click', toggleRow);
      row.addEventListener('keydown', (event) => {
        const key = event && event.key;
        // 空格键在老浏览器上报 'Spacebar'；两种都认
        if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
        // 空白键默认会滚一屏，既然当按钮用就别让它顺带滚
        if (typeof event.preventDefault === 'function') event.preventDefault();
        toggleRow();
      });
    }

    row.appendChild(create('span', 'ss-dot'));
    row.appendChild(body);
    return row;
  }

  function buildSkeleton() {
    const box = create('div', 'ss-skeleton');
    for (let i = 0; i < 3; i += 1) box.appendChild(create('div', 'ss-skeleton-row'));
    return box;
  }

  function buildEmpty() {
    return create('div', 'ss-empty', EMPTY_TEXT);
  }

  function buildError(error) {
    const box = create('div', 'ss-error');
    const message = typeof error?.message === 'string' && error.message ? error.message : '过程读取失败';
    box.appendChild(create('p', null, message));
    const retry = createButton('ss-retry', '重试读取过程', '重试');
    retry.addEventListener('click', () => {
      if (!open || destroyed) return;
      loadBody();
    });
    box.appendChild(retry);
    return box;
  }

  /** 逐行展开态批量归零：折叠过程时那几行都看不见，留着状态只会在下次展开时冒出怪样子。 */
  function collapseThinkRows() {
    if (!flowEl) return;
    for (const row of flowEl.querySelectorAll('.ss-step')) {
      if (row.dataset.kind !== 'think' || !row.classList) continue;
      row.classList.remove('is-expanded');
      setAttrs(row, { 'aria-expanded': 'false' });
    }
  }

  /**
   * 四态互斥：步骤 / 骨架 / 空态 / 错误态，同一时刻只挂一种。
   * 切换时清空子节点重建，绝不在旧内容上叠。
   */
  function setBody(mode, payload) {
    if (!flowEl) return;
    flowEl.replaceChildren();
    flowEl.classList.remove('is-folded');
    if (mode === 'steps') {
      // 视图模式在位切换时要靠这份快照重画（正文只在 open 时取一次，见 setViewMode）
      lastSteps = payload;
      // 沉静视图：过程收成一行，只留结论；点一下再铺开。
      // 经典视图不用管，本来就要逐步看。
      if (viewMode === 'serene') {
        const thinkCount = payload.filter((s) => s.kind === 'think').length;
        // 除结论以外的都算「操作」：CSS 里的折叠规则是 :not(say):not(ask)，
        // 它们会被一起藏起来，计数里就不许瞒下（tool 之外的 note 也算）。
        const actionCount = payload.filter((s) => s.kind !== 'say' && s.kind !== 'ask' && s.kind !== 'think').length;
        // 一步都藏不住时（全是 say / ask）不画折叠行：那行点下去什么也不会变
        if (thinkCount || actionCount) {
          const parts = [];
          if (thinkCount) parts.push(`思考 ${thinkCount} 段`);
          if (actionCount) parts.push(`操作 ${actionCount}`);
          const summaryText = parts.join(' · ');

          flowEl.classList.add('is-folded');
          // 跟聊天里的过程行一致的形状（三角 + 一行计数），不是另一个「按钮」样式
          const toggle = create('button', 'ss-fold-toggle');
          toggle.dataset.expanded = '0';
          // 读屏要能听见「现在是收着的」以及它管的是哪一块（三角纯视觉，不参与朗读）
          setAttrs(toggle, { type: 'button', 'aria-expanded': 'false', 'aria-controls': flowEl.id });
          toggle.appendChild(create('span', 'ss-fold-caret'));
          toggle.appendChild(create('span', 'ss-fold-text', summaryText));
          toggle.addEventListener('click', () => {
            const folded = !flowEl.classList.contains('is-folded');
            // 收起时把逐行展开态一并清掉：藏起来的那几行不该留下看不见的展开状态
            if (folded) collapseThinkRows();
            flowEl.classList.toggle('is-folded', folded);
            toggle.dataset.expanded = folded ? '0' : '1';
            setAttrs(toggle, { 'aria-expanded': folded ? 'false' : 'true' });
          });
          flowEl.appendChild(toggle);
        }
      }
      for (const step of payload) flowEl.appendChild(buildStep(step));
      return;
    }
    // 骨架 / 空态 / 错误态没有可重画的步骤：别拿上一份去“重画”一个加载页
    lastSteps = null;
    if (mode === 'skeleton') {
      flowEl.appendChild(buildSkeleton());
      return;
    }
    if (mode === 'error') {
      flowEl.appendChild(buildError(payload));
      return;
    }
    flowEl.appendChild(buildEmpty());
  }

  /** 取正文。没有子会话身份、没有注入 loader 都是空态——用户点了总要有反馈。 */
  function loadBody() {
    if (!open || destroyed || !flowEl) return;
    loadToken += 1;
    const token = loadToken;

    const hasSession = Boolean(target.sessionId || target.sessionPath);
    if (!hasSession || typeof loadTranscript !== 'function') {
      setBody('empty');
      return;
    }

    setBody('skeleton');
    const frame = waitFrame();
    const job = (async () => {
      try {
        const raw = await loadTranscript(target);
        // 兼容两种返回：Step[] 或 { steps, stats, task }（契约 2.1/2.7）。
        return { steps: Array.isArray(raw) ? raw : raw?.steps };
      } catch (err) {
        return { error: err };
      }
    })();

    job.then((result) => frame.then(() => {
      // 这一份请求可能已经被关闭 / 重开 / destroy 作废
      if (destroyed || !open || token !== loadToken) return;
      if (result.error) {
        setBody('error', result.error);
        return;
      }
      const steps = normalizeSteps(result.steps);
      if (steps.length) setBody('steps', steps);
      else setBody('empty');
    }));
  }

  /* --------------------------- 背景滚动锁 --------------------------- */

  /**
   * 读原值：内联样式没设过时浏览器给空串，假 DOM 给 undefined，两种都归成空串。
   * 还原要写回“原来是啥”，不能一律写 auto——那会盖掉宿主（或别的层）事先设的值。
   */
  function readStyle(el, prop) {
    if (!el || !el.style) return '';
    const value = el.style[prop];
    return typeof value === 'string' ? value : '';
  }

  function writeStyle(el, prop, value) {
    if (!el || !el.style) return;
    el.style[prop] = value;
  }

  /** 锁 html 与 body：两层都要，只看一层在部分浏览器上还能滑（内层滚、外层弹）。 */
  function lockScroll() {
    if (scrollLock) return false;                 // 已经锁过：不叠锁
    const html = doc.documentElement;
    const body = doc.body;
    scrollLock = {
      html: { overflow: readStyle(html, 'overflow'), overscroll: readStyle(html, 'overscrollBehavior') },
      body: { overflow: readStyle(body, 'overflow'), overscroll: readStyle(body, 'overscrollBehavior') },
    };
    for (const el of [html, body]) {
      writeStyle(el, 'overflow', 'hidden');
      writeStyle(el, 'overscrollBehavior', 'none');
    }
    return true;
  }

  /** 解锁：按锁前的值逐字还回去；没锁过就什么都不写（不往别人设的值上抹一笔）。 */
  function unlockScroll() {
    if (!scrollLock) return false;
    const saved = scrollLock;
    scrollLock = null;
    const pairs = [[doc.documentElement, saved.html], [doc.body, saved.body]];
    for (const [el, values] of pairs) {
      if (!el || !el.style) continue;
      writeStyle(el, 'overflow', values.overflow);
      writeStyle(el, 'overscrollBehavior', values.overscroll);
    }
    return true;
  }

  /* --------------------------- 焦点 --------------------------- */

  /**
   * 把火落在一个节点上。preventScroll 是必要的：面板贴底、页面可能滚在中间，
   * 不加这个参数浏览器会把 focus 当成「翻到它面前」，弹层一开页面就跟着跳。
   */
  function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return false;
    try {
      node.focus({ preventScroll: true });
      return true;
    } catch {
      // 老宿主不认参数对象：退一步用无参调用
      try {
        node.focus();
        return true;
      } catch {
        return false;
      }
    }
  }

  /** 面板是 tabindex="-1" 的落点：里面没有可聚焦元素时也靠它收住焦点。 */
  function focusPanel() {
    return focusNode(panel) || focusNode(closeBtn);
  }

  /** 没接 focusReturn 时的递回：只交给还挂在文档上、真能 focus 的那个节点。 */
  function restoreFocus() {
    const el = prevFocus;
    prevFocus = null;
    if (!el || !isConnectedNode(doc, el)) return false;    // 触发元素可能已随重绘消失
    return focusNode(el);
  }

  /* --------------------------- 焦点陷阱 --------------------------- */

  /**
   * 深度优先收集后代元素（含文档顺序）。appendChild 挡了自指，但被外部摆弄过的树
   * 仍可能重复引用 / 成环：收过的节点不再进去，深度也设上限。
   */
  function descendants(node, out = [], depth = 0) {
    if (!node || !node.children || depth > 32) return out;
    for (const child of node.children) {
      if (!child || child.tagName === '#TEXT') continue;
      if (out.includes(child)) continue;
      out.push(child);
      descendants(child, out, depth + 1);
    }
    return out;
  }

  /** 自己或祖先链上有 hidden：整支都不在可聚焦范围内。 */
  function isShown(node) {
    return !walkUp(node, (cur) => Boolean(cur && cur.hidden));
  }

  /** 沉静视图里被折叠掉的步骤行（非 say / ask）以及它们里面的东西。 */
  function isFoldedAway(node) {
    if (!flowEl || !flowEl.classList || !flowEl.classList.contains('is-folded')) return false;
    return walkUp(node, (cur) => {
      if (!cur.classList || !cur.classList.contains('ss-step')) return false;
      const kind = cur.dataset ? cur.dataset.kind : '';
      return kind !== 'say' && kind !== 'ask';
    });
  }

  /**
   * 能不能用 Tab 走到：自然可聚焦标签，或手给了 tabindex >= 0。
   * tabindex="-1" 是程序化落点（面板自己就是），不算「一站」。
   */
  function isTabbable(node) {
    if (!node || node === panel) return false;
    const tag = String(node.tagName || '').toUpperCase();
    const hasHref = typeof node.hasAttribute === 'function' && node.hasAttribute('href');
    const natural = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT'
      || tag === 'TEXTAREA' || (tag === 'A' && hasHref);
    const raw = typeof node.getAttribute === 'function' ? node.getAttribute('tabindex') : null;
    if (raw != null) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return false;      // tabindex="-1" 不进 Tab 序列
    } else if (!natural) {
      return false;
    }
    if (node.disabled) return false;
    return true;
  }

  /** 面板里当前的 Tab 序列（文档顺序，已排掉不可见与被折叠掉的）。 */
  function focusableItems() {
    if (!panel) return [];
    const items = [];
    for (const node of descendants(panel)) {
      if (!isTabbable(node)) continue;
      if (!isShown(node) || isFoldedAway(node)) continue;
      items.push(node);
    }
    return items;
  }

  /**
   * Tab / Shift+Tab：中间的站只管放行（浏览器怎么走就怎么走，不能把正常的前进变成
   * 一次改道），到了两头才改道回另一头并 preventDefault。
   */
  function onTabKey(event) {
    const items = focusableItems();
    const forward = !event.shiftKey;

    if (!items.length) {
      // 一个站都没有：退化成「焦点在面板自己身上」，否则 Tab 会把焦点漏给背后的页面
      if (typeof event.preventDefault === 'function') event.preventDefault();
      focusPanel();
      return;
    }

    const active = doc.activeElement || null;
    let index = items.indexOf(active);
    if (index === -1) {
      // 焦点真的在 sheet 外：不抢（这是别的层 / 浏览器的 Tab 序列）
      if (active && active !== panel && !isInsideNode(root, active)) return;
      // 落在面板本身（tabindex="-1"）或没有落点：当作贴在行的两头
      index = forward ? -1 : items.length;
    }

    const next = forward ? index + 1 : index - 1;
    if (next >= 0 && next < items.length) return;          // 中间站：交回浏览器
    if (typeof event.preventDefault === 'function') event.preventDefault();
    focusNode(forward ? items[0] : items[items.length - 1]);
  }

  /* --------------------------- 键盘：Escape --------------------------- */

  /**
   * 页面此刻的「明确落点」。null 表示没有落点（假 DOM / 老宿主没有 activeElement、
   * 或者焦点就落在 body / html 上），这时 escape 也归 sheet。
   */
  function focusLanding() {
    const active = doc.activeElement;
    if (!active) return null;
    if (active === doc || active === doc.body || active === doc.documentElement) return null;
    return active;
  }

  /** Escape 归不归 sheet：焦点在面板里，或页面根本没落点。 */
  function escapeBelongsHere(event) {
    if (!open || destroyed || !root) return false;
    if (isInsideNode(root, event && event.target)) return true;
    const landing = focusLanding();
    if (!landing) return true;
    return isInsideNode(root, landing);
  }

  /**
   * 收下一记 Escape：stopPropagation 是为了不让下层（聊天 / 历史抽屉）再关一层——
   * 用户按一下只应该关掉最上面这层。
   */
  function handleEscape(event) {
    if (!escapeBelongsHere(event)) return;
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    closeSheet('escape');
  }

  /** 面板里的 keydown：焦点在 sheet 内时事件从面板冒泡上来，Escape 与 Tab 都收在这里。 */
  function onPanelKeydown(event) {
    if (!open || destroyed || !event) return;
    const key = event.key;
    if (key === 'Escape' || key === 'Esc') {
      handleEscape(event);
      return;
    }
    if (key === 'Tab') onTabKey(event);
  }

  /**
   * document 上的兜底：只在「焦点没落在面板里」时接（面板里那一下已被 onPanelKeydown
   * 收掉并阻止冒泡，到不了这里）。没这层，焦点一旦落到 body，Escape 就没人管了。
   */
  function onDocKeydown(event) {
    if (!open || destroyed || !event) return;
    const key = event.key;
    if (key !== 'Escape' && key !== 'Esc') return;
    if (isInsideNode(root, event.target)) return;     // 面板里那一下已经处理过
    handleEscape(event);
  }

  function bindDocKeys() {
    if (docKeyBound) return;
    if (typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('keydown', onDocKeydown);
    docKeyBound = true;
  }

  /** 关掉 / 销毁都要解绑：不在页面上留任何本模块的监听。 */
  function unbindDocKeys() {
    if (!docKeyBound) return;
    docKeyBound = false;
    if (typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onDocKeydown);
  }

  /* --------------------------- 手势 --------------------------- */

  function atScrollTop() {
    const flow = flowEl;
    return !flow || !(Number(flow.scrollTop) > 0);
  }

  /** 点在 ✕ 上时不接管拖动：那一下是"关"，不是"拖"。 */
  function isCloseHit(node) {
    if (!node) return false;
    return walkUp(node, (cur) => {
      const cls = cur.className;
      return typeof cls === 'string' && cls.split(/\s+/).includes('ss-close');
    }, { stopAt: head });      // 到头部就收：再往上不归这次拖动管
  }

  /**
   * 手指从头部按下后，移动事件由根节点接着收：根节点铺满全屏（fixed inset 0），
   * 指针滑到正文、遮罩上依然会冒泡过来，比挂 document 更容易随 destroy 一起解绑。
   */
  function onDragStart(event) {
    if (!open || destroyed || drag || !event) return;
    if (isCloseHit(event.target)) return;
    // 契约 2.5：只有正文滚到顶，下拉才归 sheet；否则这一下是滚正文
    if (!atScrollTop()) return;
    const point = readPoint(event);
    if (!point) return;
    drag = { startY: point.y, dy: 0 };
    if (panel && panel.classList) panel.classList.add('is-dragging');
  }

  function onDragMove(event) {
    if (!drag || !panel) return;
    const point = readPoint(event);
    if (!point) return;
    const dy = Math.max(0, point.y - drag.startY);   // 只跟向下的位移，上推不把面板往上拽
    drag.dy = dy;
    panel.style.transform = `translateY(${dy}px)`;   // 唯一的内联样式：位移必须是数值
  }

  function onDragEnd() {
    if (!drag) return;
    const dy = drag.dy;
    drag = null;

    const el = panel;
    if (el && el.classList) el.classList.remove('is-dragging');
    // 撤跟手位移放到下一帧：同一帧里既恢复过渡又改 transform，浏览器不会补间，
    // 表现是"松手直接跳回顶部"。先让它按当前位移收一帧，再交给 CSS 过渡。
    waitFrame().then(() => {
      if (!el || el.parentNode == null) return;      // 面板已经收走（destroy / 关闭完成）
      el.style.transform = '';
    });

    if (dy > DRAG_CLOSE_PX) closeSheet('drag');
  }

  /* --------------------------- 装配 --------------------------- */

  function build() {
    root = create('div', 'subagent-sheet');
    root.dataset.state = 'closed';
    root.dataset.view = viewMode;
    setAttrs(root, {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': target.name ? `${target.name} 的详情` : '子代理详情',
    });

    backdrop = create('div', 'ss-backdrop');
    backdrop.addEventListener('click', () => closeSheet('backdrop'));

    panel = create('section', 'ss-panel');
    // 打开时火要落到面板上（下面 focusPanel）：tabindex="-1" 才能用 .focus() 收下焦点，
    // 又不把面板塞进 Tab 序列。
    setAttrs(panel, { tabindex: '-1' });
    panel.addEventListener('keydown', onPanelKeydown);

    grab = create('div', 'ss-grab');
    setAttrs(grab, { 'aria-hidden': 'true' });
    grab.addEventListener('pointerdown', onDragStart);

    head = create('div', 'ss-head');
    head.addEventListener('pointerdown', onDragStart);

    avatarBox = create('div', 'ss-avatar');
    setAttrs(avatarBox, { 'aria-hidden': 'true' });

    const idBox = create('div', 'ss-id');
    nameEl = create('div', 'ss-name');
    roleEl = create('div', 'ss-role');
    idBox.appendChild(nameEl);
    idBox.appendChild(roleEl);

    statusEl = create('span', 'ss-status');
    closeBtn = createButton('ss-close', '关闭', '✕');
    closeBtn.addEventListener('click', () => closeSheet('close'));

    head.appendChild(avatarBox);
    head.appendChild(idBox);
    head.appendChild(statusEl);
    head.appendChild(closeBtn);

    statsEl = create('div', 'ss-stats');

    taskEl = create('div', 'ss-task');
    taskEl.appendChild(create('em', null, '它被要求'));
    taskTextEl = create('p');
    taskEl.appendChild(taskTextEl);
    taskEl.hidden = true;

    flowEl = create('div', 'ss-flow');
    // 折叠按钮的 aria-controls 指到这块正文；同文档多实例时 id 不能撞
    flowSeq += 1;
    flowEl.id = `ss-flow-${flowSeq}`;

    panel.appendChild(grab);
    panel.appendChild(head);
    panel.appendChild(statsEl);
    panel.appendChild(taskEl);
    panel.appendChild(flowEl);

    root.appendChild(backdrop);
    root.appendChild(panel);

    // 拖动期间的移动 / 结束一律收在根节点上，监听随节点一起消失
    root.addEventListener('pointermove', onDragMove);
    root.addEventListener('pointerup', onDragEnd);
    root.addEventListener('pointercancel', onDragEnd);
  }

  /** 丢掉当前这份 DOM（不做关闭动画、不回调 onDismiss）：重开与 destroy 都走这里。 */
  function reset() {
    loadToken += 1;
    clearTimers();
    unbindDocKeys();
    unlockScroll();
    drag = null;
    if (panel && typeof panel.removeEventListener === 'function') {
      panel.removeEventListener('transitionend', onTransitionEnd);
    }
    if (root && root.parentNode) root.parentNode.removeChild(root);

    prevFocus = null;

    root = null;
    backdrop = null;
    panel = null;
    grab = null;
    head = null;
    avatarBox = null;
    avatarChild = null;
    avatarKey = null;
    deadAvatarUrl = null;
    nameEl = null;
    roleEl = null;
    statusEl = null;
    closeBtn = null;
    statsEl = null;
    statsKey = null;
    taskEl = null;
    taskTextEl = null;
    flowEl = null;
    lastSteps = null;
    target = null;
    open = false;
  }

  function onTransitionEnd(event) {
    if (!event || event.target !== panel) return;
    finishClose();
  }

  /** 动画收尾：把根节点移出文档。实例保留可复用（契约 2.4）。 */
  function finishClose() {
    if (closeTimer != null) {
      clearLater(closeTimer);
      closeTimer = null;
    }
    reset();     // 幂等：重复调用只是再确认一次 DOM 不在了
  }

  /* --------------------------- 对外 API --------------------------- */

  let viewMode = 'serene';

  /** 跟随聊天的视图设置：沉静下过程收成一行、思考只留一行，经典下全铺开。 */
  function setViewMode(mode) {
    const next = mode === 'classic' ? 'classic' : 'serene';
    const changed = next !== viewMode;
    viewMode = next;
    if (root) root.dataset.view = viewMode;
    // 在位切换要重画：折叠行与 clamp 都是渲染时决定的，只改 data-view 会留下
    // 「经典下还挂着折叠行」「沉静下没有过程行」这种半截状态。
    // 正文没渲染过（骨架 / 空态 / 错误态）就不用重画，等 loadBody 自己按新模渲。
    if (changed && open && !destroyed && flowEl && lastSteps) {
      setBody('steps', lastSteps);
    }
    return true;
  }

  /**
   * 打开。同一实例重复调用时先丢掉上一份（含正文），避免串内容。
   * 这里刻意**不**回调 onDismiss：重开不是用户关掉了什么，误报一次关闭会让装配层
   * 把"已关闭"的状态写脏。
   */
  function openSheet(nextTarget) {
    if (destroyed) return false;
    if (!nextTarget || typeof nextTarget !== 'object') return false;
    // 判断用 root 而不是 open：关闭动画期间 open 已经是 false，但旧节点还挂在文档里，
    // 这时重开必须先把那份（连同它排着的收尾定时器）彻底丢掉，否则会叠出两个根节点。
    if (root || open) reset();

    target = normalizeTarget(nextTarget);
    open = true;
    // 记下打开前的落点：没接 focusReturn 时关闭要能递回这里（reset 会清掉旧值，所以放它后面）
    prevFocus = focusLanding();
    build();
    host.appendChild(root);
    bindDocKeys();
    // 弹层打开期间背后的页面不该跟着滚（手机上尤其明显：手指一划底下的列表就跑了）
    lockScroll();
    paintIdentity();
    loadBody();
    // 打开就把火收进面板：Tab 陷阱、Escape、读屏都从这里开始（否则焦点还在背后页面上）
    focusPanel();

    // 先以 closed 落进文档、下一帧翻成 open，过渡才有起点（一次点击只挪一次，不是闪烁）
    waitFrame().then(() => {
      if (!open || destroyed || !root || root.dataset.state !== 'closed') return;
      root.dataset.state = 'open';
    });
    return true;
  }

  /** 关闭：幂等；reason 原样交回 onDismiss。动画结束后才摘节点。 */
  function closeSheet(reason = 'api') {
    if (destroyed || !open) return false;
    open = false;
    loadToken += 1;      // 在途正文作废，晚到的结果不许再画进来
    drag = null;
    if (panel && panel.classList) panel.classList.remove('is-dragging');

    if (root) {
      root.dataset.state = 'closing';
      if (panel && typeof panel.addEventListener === 'function') {
        panel.addEventListener('transitionend', onTransitionEnd);
      }
      // transitionend 优先；没样式 / 省电模式 / 假 DOM 时靠兜底定时器收尾
      closeTimer = later(finishClose, CLOSE_FALLBACK_MS);
    } else {
      finishClose();
    }

    if (typeof onDismiss === 'function') {
      try {
        onDismiss(reason);
      } catch (err) {
        // 关闭回调是装配方的：它抛错不该把 sheet 的收尾卡住
        console.error('[subagent-sheet] onDismiss error:', err);
      }
    }
    // 契约 2.5：焦点交回触发元素由装配方决定（sheet 不知道是谁打开的）
    if (typeof focusReturn === 'function') {
      try {
        focusReturn();
      } catch (err) {
        console.error('[subagent-sheet] focusReturn error:', err);
      }
    } else {
      // 没接这个钩子时 sheet 自己递回：打开时记下的落点（还挂在文档上才算数）
      restoreFocus();
    }
    return true;
  }

  function isOpen() {
    return open && !destroyed;
  }

  /**
   * 合并顶部身份区（契约 2.1：status / steps / tools / durationMs / model）。
   * 正文不动：过程是打开时那一份快照，实时追加是后续单独立项的事。
   */
  function update(patch) {
    if (destroyed || !open || !target) return false;
    if (!patch || typeof patch !== 'object') return false;
    // 带 taskId 的更新只认当前这份：慢响应的上一个分身不能把统计写到新开的这一个头上
    if (patch.taskId != null && target.taskId !== patch.taskId) return false;
    if (patch.status !== undefined) target.status = normalizeStatus(patch.status);
    if (patch.steps !== undefined) target.stepCount = numOrNull(patch.steps);
    if (patch.tools !== undefined) target.toolCount = numOrNull(patch.tools);
    if (patch.durationMs !== undefined) target.durationMs = numOrNull(patch.durationMs);
    if (patch.startedAt !== undefined) target.startedAt = numOrNull(patch.startedAt);
    if (patch.model !== undefined) target.model = text(patch.model) || null;
    paintIdentity();
    return true;
  }

  /** 移除节点与监听，可重复调用；之后这个实例不再响应任何调用。 */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    reset();
  }

  return {
    open: openSheet,
    close: closeSheet,
    isOpen,
    update,
    setViewMode,
    destroy,
  };
}
