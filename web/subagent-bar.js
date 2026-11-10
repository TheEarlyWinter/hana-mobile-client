/**
 * 运行中的子代理（分身），在输入框上方排成一条小胶囊。
 *
 * 为什么放这里：桌面端就是这样——分身跑起来以后，它的进度挂在输入区上方，
 * 不打断正文，也不在对话流里插一张大卡片。手机端原来只有正文里的卡片
 * （那是完成后的记录），跑到一半想看「谁在干活」得往下翻。
 *
 * 设计约束：
 *  - 没有挂载点（测试夹具、旧页面）就整体降级：所有方法都能调、不抛错；
 *  - 卡片仍由 subagent-view 负责，这里只做「一条胶囊 + 终结时移除」；
 *  - 只认 subagent 的两种事件（content_block / block_update），别的一律忽略。
 */

/**
 * 归一化后的五个状态 → 中文。**五个都要有**：缺一个，兜底那条 `||` 就会把已知状态
 * 念成「运行中」——胶囊一到终态就收掉，这四行平时走不到 paint，但读屏文案、
 * 导出的 statusTextOf 和将来的终态提示共用这张表，少一个键就是对用户撒谎。
 */
const STATUS_TEXT = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
  interrupted: '已中断'
};

/**
 * 状态别名 → 本模块认的五个。
 *
 * 口径照抄 web/subagent-view.js 的 STATUS_ALIAS：卡片和胶囊对「跑完没跑完」必须给同一个答案，
 * 否则会出现卡片已经停下、胶囊还在转。本模块刻意不 import 项目模块（能被单测、也不把视图
 * 拖进依赖树），所以在这里留一份——改一边就要顺手改另一边。
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
  interrupted: 'interrupted'
};

/** 终态：到这一步就把胶囊收掉（正文里那张卡片还在，可以去翻）。只在归一化后的值上判。 */
const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

/** 宿主的 streamStatus → 本模块认的五个；认不出来的（脏值、新枚举）按 running。 */
function normalizeStatus(raw) {
  return STATUS_ALIAS[str(raw).toLowerCase()] || 'running';
}

/**
 * 状态 → 中文。先归一，所以已知状态一定有话说；认不出来的脏值才按「运行中」兜底
 * （与 normalizeStatus 的口径一致，绝不会把「已中断」说成「运行中」）。
 *
 * 导出给测试与将来的终态提示用：终态胶囊一出现就被收掉，这些文案在胶囊上走不到点。
 */
export function statusTextOf(raw) {
  const status = normalizeStatus(raw);
  return STATUS_TEXT[status] || STATUS_TEXT.running;
}

/** 记性上限：这一排胶囊只服务「这一轮正在跑的分身」，长会话里 taskId 会一直累积。 */
const TASK_MEMORY_LIMIT = 200;

/**
 * 每条 taskId 的记性：`{ finished, startedAt }`。
 *
 * 两件事同生共死，所以放同一张表（以前 finished 只有一个 Set，起点只挂在胶囊上）：
 *  - finished：收过的胶囊不许被晚到的 running 复活；
 *  - startedAt：胶囊在 clearChips() 里被整批收掉后重灌（历史整页替换），块里没有时间戳，
 *    起点只能从这张表里捞回来，否则同一个分身第二次冒出来时计时从 0:00 重来。
 *
 * 刻意设上限（见 remember 里的淘汰）：不设就是一条随会话变长的泄漏。
 */
function createTaskMemory(limit) {
  const table = new Map();
  return {
    get(taskId) {
      return table.get(taskId) || null;
    },
    /**
     * 认一件事。已有记录**不重排**：Map 的插入序就是「第一次见到这个 taskId 的顺序」，
     * 淘汰按它走（补丁不能把老记录刷新成新的，否则被淘汰的永远是刚活跃过的那批）。
     * finished 只置位不回退；startedAt 只补空不覆盖（后到的补丁不重置起点）。
     */
    remember(taskId, { finished = false, startedAt = null } = {}) {
      const prev = table.get(taskId);
      if (prev) {
        if (finished) prev.finished = true;
        if (prev.startedAt == null && startedAt != null) prev.startedAt = startedAt;
        return prev;
      }
      const record = { finished, startedAt };
      table.set(taskId, record);
      // 淘汰即「彻底忘掉这个 taskId」：终态没了、起点也没了。
      // 代价明说：淘汰之后旧事件可能重新长出一条胶囊（最坏多挂一条已经收过尾的分身），
      // 换的是内存有界——重长出来的胶囊仍指向同一个子会话，点开详情照样能看。
      while (table.size > limit) {
        const oldest = table.keys().next().value;
        table.delete(oldest);
      }
      return record;
    },
    clear() {
      table.clear();
    }
  };
}

/**
 * 名字链（与 subagent-view 的 nameOf 同序）：执行者 → 请求者。
 * summary 是「一句话结果」，不是名字——拿它当胶囊标签会把结论顶上去。
 */
function namedFrom(src) {
  if (!src || typeof src !== 'object') return '';
  return str(src.agentName)
    || str(src.executorAgentNameSnapshot)
    || str(src.requestedAgentName)
    || str(src.requestedAgentNameSnapshot)
    || '';
}

/**
 * agentId 的尾段：`agents:quill` / `agents/quill` / `hana-deepseek` 这种带前缀的 id，
 * 只留最后一段当兜底名字（整个 id 塞进胶囊既长又认不出是谁）。
 */
function idTail(id) {
  const value = str(id);
  if (!value) return '';
  const parts = value.split(/[:/\-]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

/**
 * 首字认谁（与卡片 avatarNameOf 同序）：执行者快照 → 请求者快照 → 真名字。
 * 刻意不含「拿 id 顶名字」那一档：补丁里只带 executorAgentId 时，首字不能变成 id 的首字母。
 */
function avatarNameOf(src) {
  if (!src || typeof src !== 'object') return '';
  return str(src.executorAgentNameSnapshot)
    || str(src.requestedAgentNameSnapshot)
    || str(src.agentName)
    || str(src.requestedAgentName)
    || '';
}

/** 头像 id（与卡片 avatarIdOf 同序）：执行者 → 请求者 → 通用。 */
function avatarIdOf(src) {
  if (!src || typeof src !== 'object') return '';
  return str(src.executorAgentId)
    || str(src.requestedAgentId)
    || str(src.agentId)
    || '';
}

/** 首字：英文首字母大写，中文取第一个字；都没有给一个居中点（与卡片 initialOf 一致）。 */
function initialOf(entry) {
  const name = str(entry && entry.avatarName) || str(entry && entry.name);
  if (!name) return '·';
  return /[a-zA-Z]/.test(name[0]) ? name[0].toUpperCase() : name[0];
}

/**
 * 造一条「谁在干活」的胶囊。
 *
 * 形参里 `document: doc` 是重命名解构且没有默认值，tsc 推 JS 形参时会把它漏掉（同 makeAction
 * 的 available）；不写下面这份 JSDoc 参数块，装配处传 document 就会被当成多余属性。
 *
 * @param {object} [options]
 * @param {Document} [options.document] 建节点用；测试夹具可注入假 document
 * @param {Element|null} [options.mount] 挂载点，没有就整体降级
 * @param {(agentId: string) => string|null} [options.avatarUrlById] 头像地址来源
 * @param {(target: object) => void} [options.onOpen] 点胶囊时的回调（打开详情 sheet）
 * @param {{ now?: () => number, setInterval?: Function, clearInterval?: Function }} [options.clock]
 *   计时与定时器来源（测试不用等真实时间）
 */
export function createSubagentBar({ document: doc, mount = null, avatarUrlById = null, onOpen = null, clock = null } = {}) {
  const entries = new Map();
  // 终态与计时起点：胶囊收掉、甚至 clearChips() 之后仍然记得（见 createTaskMemory）。
  const taskMemory = createTaskMemory(TASK_MEMORY_LIMIT);

  // 桌面端的胶囊带计时（1:12）。时钟可注入：测试不用等真实时间，也不用真定时器。
  const nowFn = clock && typeof clock.now === 'function' ? clock.now : () => Date.now();
  const setTimer = clock && typeof clock.setInterval === 'function'
    ? (fn, ms) => clock.setInterval(fn, ms)
    : (fn, ms) => globalThis.setInterval(fn, ms);
  const clearTimer = clock && typeof clock.clearInterval === 'function'
    ? (id) => clock.clearInterval(id)
    : (id) => globalThis.clearInterval(id);
  let ticker = null;
  let destroyed = false;
  // 挂过的监听统一登记：闭包里是匿名箭头，destroy() 想摘就得先留个名字。
  const listeners = [];
  const root = doc && typeof doc.createElement === 'function' && mount && typeof mount.insertBefore === 'function'
    ? doc.createElement('div')
    : null;

  function listen(target, name, fn) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(name, fn);
    listeners.push({ target, name, fn });
  }

  /** 页面现在是不是看不见了（切标签页 / 切后台）。读不了就说看得见，别把计时器误停。 */
  function pageHidden() {
    if (!doc) return false;
    if (typeof doc.hidden === 'boolean') return doc.hidden;
    return doc.visibilityState === 'hidden';
  }

  /** 后台别再每秒唤醒一次：回来时按 startedAt 现算，所以停表不会让计时归零。 */
  function onVisibilityChange() {
    if (pageHidden()) {
      stopTicker();
      return;
    }
    if (entries.size > 0) startTicker();
  }

  if (root) {
    root.className = 'subagent-bar';
    root.hidden = true;
    mount.insertBefore(root, mount.firstChild || null);
    // 转屏/窗口变化会改变可用宽度，跟着重量一次；键盘弹出只改 visualViewport，不会发 window resize
    const view = doc && doc.defaultView;
    listen(view, 'resize', () => syncDensity());
    const visual = view && view.visualViewport;
    listen(visual, 'resize', () => syncDensity());
    // 只在工厂里注册一次：ticker 是单例，多注册一次就多一个每秒唤醒的源头
    listen(doc, 'visibilitychange', onVisibilityChange);
  }

  function avatarOf(id) {
    if (typeof avatarUrlById !== 'function' || !id) return null;
    try {
      const url = avatarUrlById(id);
      return typeof url === 'string' && url ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * 胶囊上只留短名：label 通常是「审查1：分页器与控制器」这种「短名：长说明」，
   * 分隔符前那一截才是几个胶囊之间真正的区别。全名留给 aria-label 和详情页。
   * 只切段、不在这里数字数：宽度交给 CSS（.subagent-chip-label 的 max-width + ellipsis），
   * JS 里硬切会把「DeepSeek」切成「DeepSe」，而且永远看不到省略号。
   */
  function shortOf(value) {
    const text = str(value);
    if (!text) return '';
    const head = text.split(/[：:·・｜|（(]/)[0].trim();
    return head || text;
  }

  /** 解析事件 → { taskId, label, name, status, agentId }；不是子代理事件就返回 null。 */
  function parse(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.type === 'content_block') {
      const block = ev.block;
      if (!block || typeof block !== 'object' || block.type !== 'subagent') return null;
      const taskId = str(block.taskId);
      if (!taskId) return null;
      return {
        taskId,
        // 胶囊上要能分辨「哪一个」：label 是派活时人写的短标签（例如「审3：theme 模块」），
        // 四个 DeepSeek 并排时 agentName 全一样，光看它等于没标签。
        label: str(block.label) || str(block.title) || '',
        // 名字只走名字链：summary 是「一句话结果」，不是名字；id 不当名字（upsert 里才用尾段兜底）
        name: namedFrom(block),
        // 首字认执行者快照（与卡片同口径）：有 label 时显示名是标题，首字不该跟着变成标题首字
        avatarName: avatarNameOf(block),
        agentId: avatarIdOf(block),
        status: normalizeStatus(block.streamStatus),
        // 详情页靠这两个找子会话；胶囊以前只显状态，点开就会是空态。
        sessionId: str(block.sessionId) || str(block.childSessionId),
        sessionPath: str(block.streamKey) || str(block.childSessionPath) || str(block.sessionPath),
        // 详情页顶部那两行「它被要求」和「角色 · 模型」：字段名照 subagent-view 的卡片入口
        task: str(block.task) || str(block.taskTitle),
        model: str(block.model) || str(block.executorModel)
      };
    }
    if (ev.type === 'block_update') {
      const taskId = str(ev.taskId);
      const patch = ev.patch;
      if (!taskId || !patch || typeof patch !== 'object') return null;
      return {
        taskId,
        label: str(patch.label) || str(patch.title) || '',
        // 补丁只带真名字：只有 executorAgentId 的补丁不能把已有名字改成 id
        name: namedFrom(patch),
        avatarName: avatarNameOf(patch),
        agentId: avatarIdOf(patch),
        // 补丁没带状态就留空，交给 upsert 保留上一条（不能拿 running 把已有状态冲掉）
        status: str(patch.streamStatus) ? normalizeStatus(patch.streamStatus) : '',
        sessionId: str(patch.sessionId) || str(patch.childSessionId),
        sessionPath: str(patch.streamKey) || str(patch.childSessionPath) || str(patch.sessionPath),
        task: str(patch.task) || str(patch.taskTitle),
        model: str(patch.model) || str(patch.executorModel)
      };
    }
    return null;
  }

  function upsert(info, { startUnknown = false } = {}) {
    if (!root || destroyed) return null;
    const memory = taskMemory.get(info.taskId);
    // 收过终态的 taskId 不许复活：宿主会在 finishRun 之后再补一条带 running 的 content_block。
    if (memory && memory.finished) return null;
    const prev = entries.get(info.taskId) || {};
    // 这次派活的短标签（人写的，例如「审3：theme 模块」）：不是角色，也不是执行者名字。
    const taskLabel = info.label || prev.label || '';
    // 执行者名字只走名字链；都没名字才拿 agentId 尾段顶（`agents:quill` → `quill`）。
    const name = info.name || prev.name || idTail(info.agentId) || idTail(prev.agentId) || '子代理';
    // 胶囊文本链：label → name（name 里已含尾段）；再按分隔符取第一段，宽度交 CSS。
    const display = taskLabel || name;
    // 计时起点：胶囊上的起点 → 记性里的起点 → 现在。
    // 第三档只在实时事件里取：从历史回灌的块没有时间戳，宁可不显，也不编一个从 0:00 起的假数。
    // 判空一律用 == null：注入的假时钟可以从 0 起，0 是合法起点，不能被当成「没有」。
    let startedAt = prev.startedAt;
    if (startedAt == null && memory) startedAt = memory.startedAt;
    if (startedAt == null && !startUnknown) startedAt = nowFn();
    // 起点一学到就记在胶囊之外：clearChips() 把胶囊全收掉之后（历史整页替换），
    // 重灌的块还认得出同一个分身从什么时候开始跑。
    if (startedAt != null) taskMemory.remember(info.taskId, { startedAt });
    const next = {
      label: taskLabel,
      name,
      // 首字单独一条线：只跟着执行者名字走，不受 label / 结果摘要影响
      avatarName: info.avatarName || prev.avatarName || '',
      short: shortOf(display) || '分身',
      agentId: info.agentId || prev.agentId || '',
      status: info.status || prev.status || 'running',
      startedAt: startedAt ?? null,
      // 先到的 block 带了跟，后到的 update 没带，不能把已有身份冲掉
      sessionId: info.sessionId || prev.sessionId || '',
      sessionPath: info.sessionPath || prev.sessionPath || '',
      // 派活原文与模型同理：后到的补丁没带就保留先到的那份
      task: info.task || prev.task || '',
      model: info.model || prev.model || '',
      // 头像按 key 比较，key 不变就不重建 <img>；坏图地址记住，别再撞
      avatarKey: prev.avatarKey || '',
      avatarDeadUrl: prev.avatarDeadUrl || null
    };
    entries.set(info.taskId, next);
    if (!prev.node) {
      const chip = doc.createElement('div');
      chip.className = 'subagent-chip';
      chip.dataset.taskId = info.taskId;

      const avatar = doc.createElement('span');
      avatar.className = 'subagent-chip-avatar';
      chip.appendChild(avatar);

      const label = doc.createElement('span');
      label.className = 'subagent-chip-label';
      chip.appendChild(label);

      // 桌面端同位：名字后面跟一个已跑时长（1:12），状态只靠右端那粒点
      const time = doc.createElement('span');
      time.className = 'subagent-chip-time';
      time.setAttribute('aria-hidden', 'true');
      chip.appendChild(time);

      const dot = doc.createElement('span');
      dot.className = 'subagent-chip-dot';
      dot.setAttribute('aria-hidden', 'true');
      chip.appendChild(dot);

      prev.node = chip;
      prev.avatarEl = avatar;
      prev.labelEl = label;
      prev.timeEl = time;
      // 可点：正在跑的分身点一下能看它在干什么。没接 onOpen 就不装这个能力，
      // 也不加可点暗示（宁可看着普通，也别按下去没反应）。
      if (typeof onOpen === 'function') {
        chip.classList.add('is-openable');
        chip.setAttribute('role', 'button');
        chip.tabIndex = 0;
        const fire = () => {
          const current = entries.get(info.taskId);
          if (!current) return;
          try {
            onOpen({
              taskId: info.taskId,
              name: current.name,
              // 详情页身份行：主标题是执行者 name，副标题是「label · model」（subagent-sheet）；
              // 缺 label 就和卡片入口两张脸
              label: current.label || null,
              agentId: current.agentId || null,
              status: current.status,
              sessionId: current.sessionId || null,
              sessionPath: current.sessionPath || null,
              // 详情页顶部：它被要求（task）+ 角色 · 模型（model），与卡片入口同一套字段名
              task: current.task || null,
              model: current.model || null,
              // 详情页的「用时」靠它现算：跑的过程中宿主不给 durationMs
              startedAt: current.startedAt == null ? null : current.startedAt
            });
          } catch (err) {
            console.error('[subagent-bar] onOpen error:', err);
          }
        };
        chip.addEventListener('click', fire);
        chip.addEventListener('keydown', (ev) => {
          if (ev && (ev.key === 'Enter' || ev.key === ' ')) fire();
        });
      }
      root.appendChild(chip);
    }

    const { node, avatarEl, labelEl, timeEl } = prev;
    next.node = node;
    next.avatarEl = avatarEl;
    next.labelEl = labelEl;
    next.timeEl = timeEl;
    entries.set(info.taskId, next);

    paintAvatar(next, info.taskId);
    // 胶囊上只写短标签（桌面端也一样）：状态交给点的颜色，别把三个字占掉半条胶囊
    labelEl.textContent = next.short || next.name;
    timeEl.textContent = next.startedAt == null ? '' : elapsedOf(next);
    timeEl.hidden = next.startedAt == null;
    node.dataset.status = next.status;
    // 胶囊上被截断的那半句（完整 label / 执行者名字）在这里补全给读屏器
    node.setAttribute('aria-label', ariaOf(next));
    syncVisibility();
    startTicker();
    syncDensity();
    return node;
  }

  /**
   * 读屏器听到的一整句：执行者 · 派活标签 · 状态 · 已跑时长。
   * label 是「这次派活的短标签」，名字是执行者；两者相同（或其中一个为空）就只说一遍，
   * 与卡片副标题同一条规矩。
   */
  function ariaOf(entry) {
    const parts = [];
    for (const value of [entry.name, entry.label]) {
      const text = str(value);
      if (!text || parts.includes(text)) continue;
      parts.push(text);
    }
    parts.push(statusTextOf(entry.status));
    if (entry.startedAt != null) parts.push(elapsedOf(entry));
    return parts.join(' · ');
  }

  /**
   * 这一行真正能用的宽度。clientWidth **含左右 padding**（.subagent-bar 是 `0 4px 8px`），
   * 直接拿它当可用宽度会高估 8px，把「刚好放不下」判成放得下、该压窄时不压。
   * 读不到计算样式（假 DOM / 还没上屏）就退回 clientWidth：宁可按宽松算，也不误判成紧凑。
   */
  function contentWidth() {
    const box = Number(root.clientWidth) || 0;
    if (!box) return 0;
    let style = null;
    try {
      const view = doc && doc.defaultView;
      if (view && typeof view.getComputedStyle === 'function') style = view.getComputedStyle(root);
    } catch {
      style = null;   // 计算样式读不到不是错，退回 clientWidth
    }
    if (!style) return box;
    // 只读一次计算样式，且在量 offsetWidth 之前：不额外制造一次强制重排
    const inner = box - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    return inner > 0 ? inner : box;
  }

  /*
   * 自适应宽度，两阶收缩：
   *   1) 先压窄（is-dense）：名字缩到三四个字、计时先收，保住「谁在跑」；
   *   2) 真放不下才只剩头像（is-compact）。
   * 量真宽度：一个长名字顶两个短名字，按个数拍脑袋会误判。
   * 量不到布局（假 DOM / 还没上屏）就保持完整样式。
   */
  function syncDensity() {
    if (!root || !root.classList) return;
    const chips = [];
    for (const entry of entries.values()) {
      if (entry.node) chips.push(entry.node);
    }
    root.classList.remove('is-dense');
    root.classList.remove('is-compact');
    if (chips.length === 0) return;
    const available = contentWidth();
    if (!available) return;

    const gap = 6;
    const measure = () => {
      let needed = gap * (chips.length - 1);
      for (const chip of chips) needed += Number(chip.offsetWidth) || 0;
      return needed;
    };
    if (measure() <= available) return;

    // 第一阶：压窄。读 offsetWidth 会强制重排，所以量到的是压窄后的真宽度。
    root.classList.add('is-dense');
    if (measure() <= available) return;

    // 第二阶：只剩头像。
    root.classList.add('is-compact');
  }

  /* 已跑时长：分:秒，超过一小时也只进分钟位（子代理活不到那么久） */
  function elapsedOf(entry) {
    const started = entry && entry.startedAt;
    if (started == null) return '0:00';
    const total = Math.max(0, Math.floor((nowFn() - started) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /* 只在有胶囊、且至少有一条在计时时跑表；全部收掉就停，不常驻唤醒 */
  function startTicker() {
    if (ticker || entries.size === 0) return;
    // 页面在后台就别建表：回来由 visibilitychange 起，不在后台每秒空转
    if (pageHidden()) return;
    // 全是历史回灌的条目（起点未知、不显计时）就没有要刷的数：别建一张每秒空转的表
    let timed = false;
    for (const entry of entries.values()) {
      if (entry.startedAt != null) { timed = true; break; }
    }
    if (!timed) return;
    ticker = setTimer(() => {
      for (const entry of entries.values()) {
        if (entry.timeEl && entry.startedAt != null) entry.timeEl.textContent = elapsedOf(entry);
      }
    }, 1000);
    if (ticker && typeof ticker.unref === 'function') ticker.unref();
  }

  function stopTicker() {
    if (!ticker) return;
    clearTimer(ticker);
    ticker = null;
  }

  /** 把头像位擦回空的：只在 key 变了的时候调，平时不动节点（不闪白）。 */
  function clearAvatarSlot(el) {
    for (const kid of Array.from(el.children || [])) kid.remove?.();
    el.textContent = '';
    el.classList.remove('has-image');
  }

  /**
   * 头像优先用真图，取不到就画名字首字（和卡片同一套规则）。
   * 按 key 比较后原地不动：以前每条补丁都先 textContent='' 再新建 <img>，
   * 图片会反复白闪、重新下载。首字也进 key，从「有图」回落成「没图」时才重画。
   */
  function paintAvatar(entry, taskId) {
    const el = entry && entry.avatarEl;
    if (!el) return;
    const initial = initialOf(entry);
    const url = avatarOf(entry.agentId);
    // 已知撞过坏图的地址不再撞：宁可是首字，也不要一张破图
    const wantUrl = url && url !== entry.avatarDeadUrl ? url : null;
    const key = wantUrl || `initial:${initial}`;
    if (entry.avatarKey === key) return;

    // key 变了才动：先把上一种画法（<img> 或首字）擦干净，绝不让两个头像叠在一起
    clearAvatarSlot(el);

    if (!wantUrl) {
      el.textContent = initial;
      entry.avatarKey = key;
      void taskId;
      return;
    }

    const img = doc.createElement('img');
    img.className = 'subagent-chip-img';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener?.('error', () => {
      // 每条事件都会换一个新的 entry 对象，所以按 taskId 取当前那条再改
      const current = entries.get(taskId) || entry;
      current.avatarDeadUrl = wantUrl;
      if (current.avatarKey !== key) return;   // 已经换成别的身份了，别抢
      img.remove?.();
      el.classList.remove('has-image');
      el.textContent = initial;
      current.avatarKey = `initial:${initial}`;
    });
    img.src = wantUrl;
    el.classList.add('has-image');
    el.appendChild(img);
    entry.avatarKey = key;
  }

  function remove(taskId) {
    const entry = entries.get(taskId);
    if (!entry) return false;
    entry.node?.remove?.();
    entries.delete(taskId);
    syncVisibility();
    if (entries.size === 0) stopTicker();
    syncDensity();
    return true;
  }

  function syncVisibility() {
    if (root) root.hidden = entries.size === 0;
  }

  /** 吃一个宿主事件：非子代理事件返回 false，什么也不做；真画/真收了才返回 true。
   *  `startUnknown` 给历史回灌用：那块不知道啥时候开始的，不显计时。 */
  function consume(ev, { startUnknown = false } = {}) {
    if (!root || destroyed) return false;
    const info = parse(ev);
    if (!info) return false;
    // 终态先判、先记账：哪怕这一条没挂过胶囊（App 在后台丢事件、重连只收到尾巴），
    // 「这个 taskId 已经收尾」也要记住。宿主的事件顺序是 finishRun → tool_end，
    // 终态之后还会来一条带 running 的 content_block，不记账就会造出收不掉的胶囊。
    if (TERMINAL.has(normalizeStatus(info.status))) {
      taskMemory.remember(info.taskId, { finished: true });
      // 终结时收胶囊；正文里那张卡片仍在，是完成的记录。
      if (!entries.has(info.taskId)) return false;
      return remove(info.taskId);
    }
    // block_update 里形形色色的补丁都有（workflow 也发同一种），只有带子代理身份的补丁
    // 才说明「这是个刚派出去的分身」：子会话路径 / 执行者名字 / 执行者 id。别的补丁一律
    // 不建胶囊——没有卡片对应、也没有后续终态的胶囊会永远挂在输入框上方。
    if (ev.type === 'block_update' && !entries.has(info.taskId)) {
      const patch = ev.patch || {};
      if (!str(patch.streamKey) && !namedFrom(patch) && !avatarIdOf(patch)) return false;
    }
    // 终态记忆里已经有的 taskId，upsert 会拒绝；如实返回 false，不要报「我处理了」
    upsert(info, { startUnknown });
    return Boolean(entries.has(info.taskId));
  }

  /** 只清胶囊，不动记性（终态与起点）：同一个会话里的历史整页替换走这里
   *  ——taskId 的终态不该被忘掉，计时起点也不该丢（否则重灌的胶囊从 0:00 重来）。 */
  function clearChips() {
    for (const [taskId, entry] of entries) {
      entry.node?.remove?.();
      entries.delete(taskId);
    }
    syncVisibility();
    stopTicker();
    syncDensity();
  }

  /** 清胶囊 + 清记性（终态与起点）：切会话 / 换身份用（新会话里 taskId 可能重用）。 */
  function clear() {
    clearChips();
    taskMemory.clear();
  }

  function list() {
    return Array.from(entries.entries()).map(([taskId, entry]) => ({ taskId, ...entry }));
  }

  /**
   * 拆掉这一排：resize / visualViewport / visibilitychange 都在闭包里常驻，
   * 装配方换页或卸载时要能把监听和定时器一起收干净，否则整页重建后旧栏还在跟着回调。
   * 拆完就作废：consume 一律 false，也不再建节点（拆了还能用的栏只会复活成孤儿）。
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const { target, name, fn } of listeners.splice(0, listeners.length)) {
      try {
        target.removeEventListener?.(name, fn);
      } catch {
        // 摘监听失败不该挡住销毁
      }
    }
    clear();
    root?.remove?.();
  }

  return { consume, clear, clearChips, list, remove, destroy, element: root };
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}
