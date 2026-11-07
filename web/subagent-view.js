/* web/subagent-view.js — 子代理（分身）卡片
 *
 * 宿主把 `subagent` 工具的 details 投影成 `{ type: 'subagent' }` 的块，两条路进手机：
 *
 *   历史：GET /api/sessions/messages 的 blocks 里一条独立 entry（带 afterIndex）
 *   实时：`content_block` 事件（块出结果那一下）
 *         `block_update` 事件（{ taskId, patch: { streamStatus, summary, streamKey, sessionId, agentName } }）
 *
 * 块形状（宿主 bundle 里 subagent 的 block-extractor + /sessions/messages 的补全逻辑）：
 *   taskId / task / taskTitle / label
 *   agentId / agentName / requestedAgentId / requestedAgentName
 *   executorAgentId / executorAgentNameSnapshot
 *   sessionId（子会话身份） / streamKey（子会话路径）
 *   streamStatus: 'running' | 'done' | 'failed' | 'aborted'（历史里会被补成终态）
 *   summary（一句话结果，失败时是原因）
 *
 * 桌面端画的是「分身头像 + 名字 + 状态 + 一句话」的任务卡，点开右边预览子会话。
 * 手机端压成一张两行小卡：第一行名字与状态，第二行「它在干什么 / 干完说了什么」。
 *
 * 头像不在这里算地址：只有装配方的 bootstrap 里才有 agent 列表，所以地址由注入的
 * avatarUrlById 给；拿不到地址就退成名字首字的圆点，没注入就保持原样（一个「分」徽标）。
 *
 * 本模块刻意**不 import 任何项目模块**：document 由参数注入，渲染器 / 事件路由
 * 只在装配时把 render / handleEvent 传进来（互相之间也没有 import 关系）。
 * 这样它既能单独测，也不会把聊天渲染器拖进任何新的依赖边。
 */

/** 状态 → 中文（与桌面端 zh 词典的 subagent.status.* 对齐）。 */
const STATUS_TEXT = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  aborted: '已终止',
  interrupted: '已中断',
};

/**
 * 宿主/历史里可能出现的状态别名 → 本模块认的五个。
 * 认不出来的（脏值、新枚举）一律按 running：分身块本来就默认 running，
 * 宁可显示「运行中」，也不要往界面里塞一个用户看不懂的英文枚举。
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
  aborted: 'aborted',
  abort: 'aborted',
  cancelled: 'aborted',
  canceled: 'aborted',
  interrupted: 'interrupted',
};

/** 终态：到了这里就不会再变，后到的 running 不能把卡片打回去。 */
const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

/** 从 block_update 的 patch 里认领这些字段（其余的是 workflow / 卡片自己的东西）。 */
const PATCH_KEYS = [
  'streamStatus',
  'summary',
  'error',
  'message',
  'agentName',
  'executorAgentNameSnapshot',
  'requestedAgentName',
  'requestedAgentNameSnapshot',
  'agentId',
  'requestedAgentId',
  'executorAgentId',
  'streamKey',
  'sessionId',
  'label',
  'taskTitle',
  'task',
  'processRecordsDeleted',
];

/** 还没画出来的补丁最多记这么多条：分身任务数不会多，但别让它无限长。 */
const PENDING_LIMIT = 50;

/** 只认非空字符串；别的一律当没有（数字 taskId、布尔 summary 都是脏数据）。 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStatus(raw) {
  const key = text(raw).toLowerCase();
  return STATUS_ALIAS[key] || 'running';
}

function isTerminal(status) {
  return TERMINAL.has(normalizeStatus(status));
}

/**
 * 非空值覆盖：宿主投影会把空字段显式写成 null（`summary: t.summary || null`），
 * 直接展开会把先到的好值（比如收尾摘要）冲掉，所以空值不参与覆盖。
 */
function overlay(base, patch) {
  const out = { ...(base || {}) };
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  return out;
}

/** 分身的名字：优先实际执行者，再退到请求者，最后才是通用「分身」。 */
function nameOf(block) {
  return text(block?.agentName)
    || text(block?.executorAgentNameSnapshot)
    || text(block?.requestedAgentName)
    || text(block?.requestedAgentNameSnapshot)
    || text(block?.executorAgentId)
    || text(block?.requestedAgentId)
    || '分身';
}

/**
 * 头像认谁：实际执行者的 id 优先（那份身份对应的是真正干活的人），
 * 再退到请求者，最后才是块上通用的 agentId。都没有就是「没有 id」。
 */
function avatarIdOf(block) {
  return text(block?.executorAgentId)
    || text(block?.requestedAgentId)
    || text(block?.agentId);
}

/**
 * 没有 id 时的兜底身份：名字快照。顺序跟 avatarIdOf 对齐（执行者的快照配
 * executorAgentId），同一个子代理在多个块里就能落成同一个首字。
 */
function avatarNameOf(block) {
  return text(block?.executorAgentNameSnapshot)
    || text(block?.requestedAgentNameSnapshot)
    || text(block?.agentName)
    || text(block?.requestedAgentName)
    || nameOf(block);
}

/**
 * 名字的首字：英文首字母大写，中文取第一个字；空值给一个居中点。
 * 规则与 avatar-view.js 的 initialOf 一致（本模块不 import 项目模块，所以留一份在这里）。
 */
function initialOf(name) {
  const s = text(name);
  if (!s) return '·';
  return /[a-zA-Z]/.test(s[0]) ? s[0].toUpperCase() : s[0];
}

/**
 * 第二行：一句话结果或错误。
 * 跑着的时候显示它在干什么（taskTitle），收尾之后显示结果（summary）。
 * 过程记录被清理的会话，宿主只留一句说明，照桌面端的话术写。
 */
function noteOf(block, status) {
  const summary = text(block?.summary) || text(block?.error) || text(block?.message);
  const task = text(block?.taskTitle) || text(block?.task);
  if (block?.processRecordsDeleted === true) return summary || '过程记录已清理';
  if (status === 'running') return task || summary;
  return summary || task;
}

/** 子会话身份：有它才能点开（桌面端点开的是子会话预览）。 */
function sessionOf(block) {
  return {
    sessionId: text(block?.sessionId) || text(block?.childSessionId),
    sessionPath: text(block?.streamKey) || text(block?.childSessionPath) || text(block?.sessionPath),
  };
}

/**
 * 身份行第二行：`label · model`。
 *
 * label 是「这次派活的短标签」（人写的，例如「审3：theme 模块」），不是角色，也不是名字：
 * 执行者已经在主标题上，这里再贴一遍只是噪音，所以相同或为空就不重复。
 * 两样都没有就返回空串，那一行不占位。
 */
function subtitleOf(block, name) {
  const label = text(block?.label);
  const model = text(block?.model) || text(block?.executorModel);
  const parts = [];
  if (label && label !== name) parts.push(label);
  if (model) parts.push(model);
  return parts.join(' · ');
}

/**
 * 一条宿主块 → 卡片的呈现数据。没有 taskId 就没有身份，卡片无从对应，
 * 一律返回 null（宁可不画，也不要一张空卡片）。
 */
function specOf(block) {
  if (!block || typeof block !== 'object') return null;
  const taskId = text(block.taskId);
  if (!taskId) return null;
  const status = normalizeStatus(block.streamStatus);
  const session = sessionOf(block);
  const name = nameOf(block);
  return {
    taskId,
    name,
    label: text(block.label),
    // 主标题只放执行者（以前把 label 拼在名字后面，两张脸混成一行），标签和模型走副标题
    subtitle: subtitleOf(block, name),
    status,
    statusText: STATUS_TEXT[status] || STATUS_TEXT.running,
    note: noteOf(block, status),
    openable: Boolean(session.sessionId || session.sessionPath),
  };
}

/**
 * 子代理卡片视图。
 *
 * @param {object} options
 * @param {Document} options.document 注入的 document（不读全局）
 * @param {(target: {taskId: string, sessionId: string|null, sessionPath: string|null}) => void} [options.onOpenSession]
 *   点卡片时的回调：由装配方决定「打开子会话预览」怎么做；没给就只是不可点。
 * @param {(id: string) => (string|null)} [options.avatarUrlById]
 *   按 agent id 取头像地址。**不给就维持旧样**（一个「分」徽标，不出头像）；
 *   给了但返回 null/空串，这张卡就画名字首字的占位圆。回调抛错按「没有头像」处理。
 * @returns {{render: Function, handleEvent: Function, reset: Function}}
 */
export function createSubagentView({
  document: doc = null,
  onOpenSession = null,
  avatarUrlById = null,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createSubagentView requires { document }');
  }

  /** 有没有人给头像来源：typeof 判断而不是默认 `() => null`，
   *  这样才能区分「没接头像」和「接了但这张卡没地址」。 */
  const avatarEnabled = typeof avatarUrlById === 'function';

  /** taskId → { taskId, node, mainEl, avatarEl, avatarKey, avatarDeadUrl, block } */
  const cards = new Map();
  /** taskId → 还没画出来的补丁（事件乱序时先存着） */
  const pending = new Map();

  function create(tag, cls, content) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    return node;
  }

  /** id → 头像地址；装配方抛错就当没有头像，别把卡片渲染带崩。 */
  function avatarUrlOf(id) {
    if (!avatarEnabled || !id) return null;
    try {
      return text(avatarUrlById(id)) || null;
    } catch (err) {
      console.error('[subagent] avatarUrlById error:', err);
      return null;
    }
  }

  /** 首字占位圆：装饰性的（名字已经由卡片念出来），所以对读屏器隐形。 */
  function avatarFallbackNode(initial) {
    const box = create('div', 'subagent-avatar subagent-avatar-fallback', initial);
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  /** 头像图片：撞了 404 / 坏图就在原地换回首字，手机上不能留破图。 */
  function avatarImageNode(state, url, initial) {
    const img = create('img', 'subagent-avatar');
    img.alt = '';                    // 装饰性；卡片本身已经有可读名字，
    img.loading = 'eager';           //   也不需要再给头像加 aria-label
    img.decoding = 'async';
    img.addEventListener('error', () => {
      state.avatarDeadUrl = url;     // 这个地址已知拿不到，后面别再撞
      if (state.avatarEl !== img || !img.parentNode) return;   // 已经换成别的身份了，别抢
      const fallback = avatarFallbackNode(initial);
      img.parentNode.replaceChild(fallback, img);
      state.avatarEl = fallback;
      state.avatarKey = `initial:${initial}`;
    }, { once: true });
    img.src = url;
    return img;
  }

  /**
   * 卡片挂哪：最近一条助手回复的正文（和文件卡同一落点）。
   * 没有助手轮次时退到消息区根节点——卡片总比丢掉强，但不能抛错。
   */
  function findHost() {
    const box = typeof doc.getElementById === 'function' ? doc.getElementById('transcript') : null;
    if (!box) return null;
    const turns = box.querySelectorAll('.turn.assistant');
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const body = turns[i].querySelector('.turn-body');
      if (body) return body;
    }
    const kids = box.children || [];
    const tail = kids[kids.length - 1];
    if (tail) return tail.querySelector('.turn-body') || tail;
    return box;
  }

  function buildNode() {
    const node = create('div', 'subagent-card');
    // 头像位：接了 avatarUrlById 就空着等 paintAvatar 填（第一个孩子，占原来徽标的位置）；
    // 没接就照旧画那个「分」徽标，卡片结构一个字节都不变。
    const avatarEl = avatarEnabled ? null : create('span', 'subagent-card-icon', '分');
    if (avatarEl) node.appendChild(avatarEl);
    const main = create('div', 'subagent-card-main');
    const head = create('div', 'subagent-card-head');
    const nameEl = create('span', 'subagent-card-name');
    const statusEl = create('span', 'subagent-card-status');
    // 身份副标题（label · model）：单独一行，在主标题下、一句话结果上。
    // CSS 那一路还没给 .subagent-card-sub 规则，先借 .subagent-card-note 的字号/颜色落地
    // （不改 CSS 文件）；两份都带，等 CSS 归位后 .subagent-card-sub 可单独调。
    const subEl = create('div', 'subagent-card-sub subagent-card-note');
    const noteEl = create('div', 'subagent-card-note');
    head.appendChild(nameEl);
    head.appendChild(statusEl);
    main.appendChild(head);
    main.appendChild(subEl);
    main.appendChild(noteEl);
    node.appendChild(main);
    return { node, mainEl: main, avatarEl, nameEl, statusEl, subEl, noteEl };
  }

  /**
   * 画头像。同一身份（同一个地址，或同一个首字）就不动，避免每条补丁都重建节点；
   * 补丁之后才拿到 id 的卡片，在这里把首字就地换成图片，不重建整张卡。
   */
  function paintAvatar(state, block) {
    if (!avatarEnabled) return;
    const url = avatarUrlOf(avatarIdOf(block));
    const initial = initialOf(avatarNameOf(block));
    // 已知撞过 404 的地址不再撞：名片上宁可是首字，也不要一张破图
    const wantUrl = url && url !== state.avatarDeadUrl ? url : null;
    const key = wantUrl || `initial:${initial}`;
    if (state.avatarKey === key) return;

    const next = wantUrl
      ? avatarImageNode(state, wantUrl, initial)
      : avatarFallbackNode(initial);
    const prev = state.avatarEl;
    if (prev) {
      if (!prev.parentNode) return;      // 引用已脱离文档（切会话清屏）：不写孤儿节点
      prev.parentNode.replaceChild(next, prev);
    } else {
      state.node.insertBefore(next, state.mainEl);
    }
    state.avatarEl = next;
    state.avatarKey = key;
  }

  /** 把呈现数据刷到已有节点上（身份副标题与 note 都是有才占行，status 顺便落进 dataset 供上色）。 */
  function paint(state, spec) {
    // 主标题只写执行者：label 是这次派活的短标签，不是角色，也不该和名字糊成一行
    state.nameEl.textContent = spec.name;
    state.subEl.textContent = spec.subtitle;
    state.subEl.hidden = !spec.subtitle;
    state.statusEl.textContent = spec.statusText;
    state.noteEl.textContent = spec.note;
    state.noteEl.hidden = !spec.note;
    state.node.dataset.taskId = spec.taskId;
    state.node.dataset.status = spec.status;
    state.node.classList.toggle('is-openable', spec.openable);
    paintAvatar(state, state.block);   // 读合并后的块：补丁带来的 id 就靠这一步升级
  }

  function bindOpen(state) {
    state.node.addEventListener('click', () => {
      if (typeof onOpenSession !== 'function') return;
      const session = sessionOf(state.block);
      if (!session.sessionId && !session.sessionPath) return;   // 没身份，点了也没地方去
      const status = normalizeStatus(state.block?.streamStatus);
      try {
        onOpenSession({
          taskId: state.taskId,
          sessionId: session.sessionId || null,
          sessionPath: session.sessionPath || null,
          // 详情页顶部要显示的身份：卡片这一层已经算过一遍，一并带上，
          // 免得装配方再猜一次宿主字段（agentName / executorAgentId / summary 这几套）。
          name: nameOf(state.block),
          label: text(state.block?.label) || null,
          model: text(state.block?.model) || text(state.block?.executorModel) || null,
          agentId: avatarIdOf(state.block) || null,
          status,
          task: text(state.block?.taskTitle) || text(state.block?.task) || null,
        });
      } catch (err) {
        // 打开子会话是装配方的事；它抛错不该把整条消息链路带崩
        console.error('[subagent] onOpenSession error:', err);
      }
    });
  }

  /**
   * 把一份块并进卡片。
   * 状态只进不退：终态之后又来的 running（前台子代理的事件顺序是 finishRun → tool_end）
   * 不能把卡片打回「运行中」。
   */
  function applyBlock(state, incoming) {
    const merged = overlay(state.block, incoming);
    if (isTerminal(state.block?.streamStatus) && !isTerminal(incoming?.streamStatus)) {
      merged.streamStatus = state.block.streamStatus;
    }
    const spec = specOf(merged);
    if (!spec) return false;
    state.block = merged;
    paint(state, spec);
    return true;
  }

  /** 卡片节点是否还挂在文档里（切会话清屏后，引用会变成脱离文档的孤儿节点）。 */
  function isMounted(node) {
    if (!node) return false;
    // 假 DOM / 极简环境没有 isConnected：看不出来就当它还在，绝不因此重复插卡
    return typeof node.isConnected === 'boolean' ? node.isConnected : true;
  }

  /** 取这个 taskId 的活卡片；引用已经脱离文档就丢掉，让调用方重画一张。 */
  function liveCard(taskId) {
    const state = cards.get(taskId);
    if (!state) return null;
    if (isMounted(state.node)) return state;
    cards.delete(taskId);
    return null;
  }

  function createCard(block, host) {
    const spec = specOf(block);
    if (!spec || !host) return null;
    const state = { taskId: spec.taskId, block: {}, ...buildNode() };
    cards.set(spec.taskId, state);
    applyBlock(state, block);
    bindOpen(state);
    host.appendChild(state.node);
    return state;
  }

  /** 记下还没画出来的补丁；同 taskId 的多次补丁合并，条数封顶。 */
  function remember(taskId, patch) {
    const picked = {};
    for (const key of PATCH_KEYS) {
      if (patch && patch[key] !== undefined && patch[key] !== null) picked[key] = patch[key];
    }
    const stored = overlay(pending.get(taskId), picked);
    pending.delete(taskId);       // 重新插入，保证 Map 的先后就是补丁的先后
    pending.set(taskId, stored);
    while (pending.size > PENDING_LIMIT) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
    return stored;
  }

  /** 取出并清掉这个 taskId 攒着的补丁（补丁比内容块新，覆盖在内容块之上）。 */
  function takePending(taskId, block) {
    const stored = pending.get(taskId);
    if (!stored) return block;
    pending.delete(taskId);
    return overlay(block, stored);
  }

  /**
   * 历史回放：把一条 `{ type: 'subagent' }` 的 entry 画成卡片。
   * 由 chat-renderer 在 renderEntry 里按注入的 renderSubagent 调用。
   *
   * @param {object} entry 历史 entry（或任意形状的块）
   * @param {object} [options]
   * @param {Element} [options.host] 指定挂载点；不传就找最近一条助手正文
   * @returns {boolean} 是否画出了东西
   */
  function render(entry, { host = null } = {}) {
    const spec = specOf(entry);
    if (!spec) return false;

    const existing = liveCard(spec.taskId);
    if (existing) {
      // 同一 taskId 再来一次（重拉历史 / 分页重叠）：只更新，不重复插卡
      return applyBlock(existing, takePending(spec.taskId, entry));
    }

    const target = host || findHost();
    if (!target) return false;
    return Boolean(createCard(takePending(spec.taskId, entry), target));
  }

  /**
   * 实时事件。
   *   content_block（block.type === 'subagent'）→ 建卡 / 更新
   *   block_update（{ taskId, patch }）→ 只更新；带 streamKey 的补丁允许先建占位卡
   *
   * @param {object} ev 宿主推来的事件
   * @returns {boolean} 这次事件有没有落到一张卡上
   */
  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;

    if (ev.type === 'content_block') {
      const block = ev.block;
      if (!block || typeof block !== 'object' || block.type !== 'subagent') return false;
      const taskId = text(block.taskId);
      if (!taskId) return false;

      const existing = liveCard(taskId);
      if (existing) return applyBlock(existing, takePending(taskId, block));

      const target = findHost();
      if (!target) return false;
      return Boolean(createCard(takePending(taskId, block), target));
    }

    if (ev.type === 'block_update') {
      const taskId = text(ev.taskId);
      if (!taskId || !ev.patch || typeof ev.patch !== 'object') return false;

      const existing = liveCard(taskId);
      if (existing) return applyBlock(existing, ev.patch);

      const stored = remember(taskId, ev.patch);
      // 只有带子会话路径（streamKey）的补丁才说明「这是个刚派出去的分身」；
      // workflow 的 block_update 不带 streamKey，不能顺手造一张分身卡。
      if (text(stored.streamKey)) {
        const target = findHost();
        if (!target) return false;
        const state = createCard({ type: 'subagent', taskId, ...stored }, target);
        if (state) pending.delete(taskId);
        return Boolean(state);
      }
      return false;
    }

    return false;
  }

  /** 切会话：只清自己的节点引用与攒着的补丁，不碰 DOM（清屏由历史层负责）。 */
  function reset() {
    cards.clear();
    pending.clear();
  }

  return { render, handleEvent, reset };
}
