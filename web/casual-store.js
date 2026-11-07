/* web/casual-store.js — 闲聊通道的状态机（无 DOM、无网络、零 import）
 *
 * 只依赖注入进来的 casual client（鸭子类型：getAgentId / setAgentId / loadSummary /
 * loadPage / send / markRead），不 import casual-client.js，也不碰任何其它功能模块，
 * 因此可以在 node 里用假 client + 假定时器完整单测。
 *
 * 对外快照（每次 onState 都传一份不可变副本）：
 *   {
 *     agentId,        // 当前闲聊对象
 *     entries,        // 服务端条目 + 尚未被服务端确认的本地乐观条目，按 occurredAt → id 排序
 *     hasMore,        // 是否还有更早的历史
 *     typing,         // 宿主是否正在输入
 *     unread,         // 摘要里的未读数（markReadThrough 到最新 agent 条目后本地清零）
 *     preview,        // 摘要里的最近一条预览 {text, occurredAt, previewKind?} | null（额外字段，供列表项）
 *     loading,        // 首屏 / 手动 refresh 进行中
 *     loadingEarlier, // loadEarlier 进行中
 *     error,          // 最近一次失败（Error | null）
 *     sending,        // Map<clientMessageId, {clientMessageId, payload, status, error, entryId, sentAt}>
 *   }
 *
 * 本地乐观条目在 Entry 形状上额外带：local:true / pending / failed / confirmed / error / payload。
 * 合并规则：按 sourceEntryId 去重、按 occurredAt 再按 id 排序、服务端条目优先于本地 pending。
 */

const POLL_ERROR_THRESHOLD = 3;

export function createCasualStore({
  client,
  now = () => Date.now(),
  pollMs = 4000,
  setTimer,
  clearTimer,
  onState,
} = {}) {
  if (!client || typeof client !== 'object') {
    throw new TypeError('createCasualStore 需要注入 casual client');
  }
  for (const method of ['getAgentId', 'setAgentId', 'loadSummary', 'loadPage', 'send', 'markRead']) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`createCasualStore 的 client 缺少 ${method}() 方法`);
    }
  }
  if (typeof now !== 'function') throw new TypeError('createCasualStore 的 now 必须是函数');

  const setTimerImpl = typeof setTimer === 'function' ? setTimer : (fn, ms) => {
    const handle = globalThis.setTimeout(fn, ms);
    // Node 里让进程在只剩轮询定时器时能退出：否则一个 30 秒的兜底轮询会把测试/脚本挂住。
    // 浏览器里 setTimeout 返回数字，没有 unref，这行等于不存在。
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };
  const clearTimerImpl = typeof clearTimer === 'function' ? clearTimer : (handle) => globalThis.clearTimeout(handle);

  /* ---------------- 内部状态 ---------------- */

  let agentId = client.getAgentId() || null;
  let entries = []; // 合并后的对内外条目
  let serverEntries = []; // 服务端条目（服务端返回顺序仅作插入顺序）
  const serverIndex = new Map(); // sourceEntryId → serverEntries 下标
  const localEntries = new Map(); // clientMessageId → 本地乐观条目
  const sending = new Map(); // clientMessageId → 发送状态

  let hasMore = false;
  let typing = false;
  let unread = 0;
  let preview = null;
  let loading = false;
  let loadingEarlier = false;
  let error = null;
  let loadedEarlier = false;

  let opened = false;
  let pollGen = 0;
  // 登录上下文代次：reset / 换 agent 时推进。同一个 agent 重登也必须让旧请求作废。
  let contextEpoch = 0;
  let pollFailures = 0;
  let timerHandle = null;
  let refreshPromise = null;
  // 实际轮询间隔：WS 连着的时候可以放得很大，断线了再收回来。
  let currentPollMs = pollMs;

  const reportedRead = new Set(); // 已成功上报的 entryId
  let readInFlight = null; // { entryId, promise }

  /* ---------------- 小工具 ---------------- */

  function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
  }

  function settle(thunk) {
    try {
      return Promise.resolve(thunk()).then(
        (value) => ({ ok: true, value }),
        (reason) => ({ ok: false, error: reason }),
      );
    } catch (reason) {
      return Promise.resolve({ ok: false, error: reason });
    }
  }

  function timeOf(entry) {
    const ms = Date.parse(entry && entry.occurredAt);
    return Number.isFinite(ms) ? ms : 0;
  }

  function compareEntries(a, b) {
    const delta = timeOf(a) - timeOf(b);
    if (delta !== 0) return delta;
    const idA = String(a && a.id != null ? a.id : '');
    const idB = String(b && b.id != null ? b.id : '');
    if (idA === idB) return 0;
    return idA < idB ? -1 : 1;
  }

  function defaultMessageId() {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      try {
        return cryptoObj.randomUUID();
      } catch {
        // 非安全上下文下退回时间戳+随机数
      }
    }
    return `casual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function stamp() {
    const value = Number(now());
    const ms = Number.isFinite(value) ? value : Date.now();
    return new Date(ms).toISOString();
  }

  /* ---------------- 快照 ---------------- */

  function snapshotEntry(entry) {
    // item / payload 里可能有 block、attachments 等嵌套结构：深拷贝后冻结，
    // 既不把内部引用递给监听器，也不会因为监听器改动而反噬重试用的 payload。
    const copy = {
      ...entry,
      item: cloneAndFreeze(entry.item),
    };
    if (entry.payload) copy.payload = cloneAndFreeze(entry.payload);
    return Object.freeze(copy);
  }

  function cloneAndFreeze(value) {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item) => cloneAndFreeze(item)));
    }
    if (value && typeof value === 'object') {
      const copy = {};
      for (const key of Object.keys(value)) copy[key] = cloneAndFreeze(value[key]);
      return Object.freeze(copy);
    }
    return value;
  }

  function snapshotSending() {
    const copy = new Map();
    for (const [key, value] of sending) {
      copy.set(key, Object.freeze({ ...value }));
    }
    return copy;
  }

  function snapshot() {
    return Object.freeze({
      agentId,
      entries: Object.freeze(entries.map(snapshotEntry)),
      hasMore,
      typing,
      unread,
      preview: preview ? Object.freeze({ ...preview }) : null,
      loading,
      loadingEarlier,
      error,
      sending: snapshotSending(),
    });
  }

  function emit() {
    if (typeof onState !== 'function') return;
    try {
      onState(snapshot());
    } catch {
      // 监听器自己炸了不能反噬状态机（尤其是轮询回调里）
    }
  }

  /* ---------------- 合并 ---------------- */

  /**
   * 把服务端条目并入列表：按 sourceEntryId 去重，同 key 用新对象覆盖（审批状态等会变）。
   * 返回是否真的发生了合并。
   */
  function mergeServerEntries(list) {
    if (!Array.isArray(list)) throw new Error('闲聊分页数据缺少 entries 数组');
    let changed = false;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') throw new Error('闲聊条目格式不正确');
      const key =
        typeof entry.sourceEntryId === 'string' && entry.sourceEntryId
          ? entry.sourceEntryId
          : typeof entry.id === 'string' && entry.id
            ? entry.id
            : null;
      if (!key) throw new Error('闲聊条目缺少 id / sourceEntryId');

      const index = serverIndex.get(key);
      if (index == null) {
        serverEntries.push(entry);
        serverIndex.set(key, serverEntries.length - 1);
        changed = true;
      } else if (serverEntries[index] !== entry) {
        serverEntries[index] = entry;
        changed = true;
      }
    }
    if (changed) rebuild();
    return changed;
  }

  /** 重建对外的 entries：服务端条目优先，被服务端确认过的本地乐观条目直接丢掉。 */
  function rebuild() {
    const confirmed = new Set();
    for (const entry of serverEntries) {
      if (entry && typeof entry.clientMessageId === 'string' && entry.clientMessageId) {
        confirmed.add(entry.clientMessageId);
      }
    }
    for (const clientMessageId of confirmed) {
      localEntries.delete(clientMessageId);
      sending.delete(clientMessageId);
    }

    const locals = [];
    for (const entry of localEntries.values()) locals.push(entry);
    entries = [...serverEntries, ...locals].sort(compareEntries);
  }

  function earliestServerEntry() {
    let earliest = null;
    for (const entry of serverEntries) {
      if (!earliest || compareEntries(entry, earliest) < 0) earliest = entry;
    }
    return earliest;
  }

  function latestAgentEntryId() {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].actor === 'agent') return entries[index].id;
    }
    return null;
  }

  /* ---------------- 应用摘要 / 分页 ---------------- */

  function applySummary(summary) {
    if (!summary || typeof summary !== 'object') throw new Error('闲聊摘要格式不正确');
    if (typeof summary.unread === 'number' && Number.isFinite(summary.unread)) {
      unread = Math.max(0, Math.trunc(summary.unread));
    }
    preview = summary.preview || null;
  }

  function applyPage(page, { first = false } = {}) {
    if (!page || typeof page !== 'object') throw new Error('闲聊分页数据格式不正确');
    mergeServerEntries(page.entries);
    typing = page.typing === true;
    // 已经翻过更早的历史时，第一页的 hasMore 不能把状态改回「还有更多」。
    if (!first || !loadedEarlier) hasMore = page.hasMore === true;
  }

  /* ---------------- 发送 ---------------- */

  function normalizeOutgoing(input) {
    if (typeof input === 'string') {
      if (input.trim() === '') throw new Error('发送内容为空：文本不能只有空白');
      return { text: input };
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('send 需要文本字符串或 { text, stickerId, attachments } 对象');
    }

    const payload = {};
    if (input.text != null) {
      if (typeof input.text !== 'string') throw new Error('send 的 text 必须是字符串');
      if (input.text.trim() !== '') payload.text = input.text;
    }
    if (input.stickerId != null) {
      if (typeof input.stickerId !== 'string' || input.stickerId.trim() === '') {
        throw new Error('send 的 stickerId 必须是非空字符串');
      }
      payload.stickerId = input.stickerId;
      if (typeof input.stickerUrl === 'string' && input.stickerUrl) payload.stickerUrl = input.stickerUrl;
    }
    if (input.attachments != null) {
      if (!Array.isArray(input.attachments)) throw new Error('send 的 attachments 必须是数组');
      if (input.attachments.length > 0) {
        payload.attachments = input.attachments.map((att) => ({ ...att }));
      }
    }

    const hasContent = Boolean(
      payload.text || payload.stickerId || (payload.attachments && payload.attachments.length),
    );
    if (!hasContent) throw new Error('发送内容为空：文本、贴纸与附件至少要有一项');
    return payload;
  }

  /** 乐观条目先给界面一个可渲染的 item；真实内容以服务端回显为准。 */
  function localItemFor(payload) {
    if (payload.stickerId) {
      return {
        kind: 'sticker',
        stickerId: payload.stickerId,
        url: payload.stickerUrl || '',
      };
    }
    if (payload.text && payload.text.trim() !== '') {
      return { kind: 'text', text: payload.text };
    }
    const first = Array.isArray(payload.attachments) ? payload.attachments[0] : null;
    if (first) {
      return {
        kind: 'file',
        fileId: first.fileId,
        name: first.name || '附件',
        mime: first.mime,
        attachments: payload.attachments.map((att) => ({ ...att })),
      };
    }
    return { kind: 'text', text: '' };
  }

  function createLocalEntry(payload, clientMessageId) {
    return {
      id: `local:${clientMessageId}`,
      sourceEntryId: null,
      actor: 'user',
      occurredAt: stamp(),
      clientMessageId,
      item: localItemFor(payload),
      local: true,
      pending: true,
      failed: false,
      payload: { ...payload },
    };
  }

  /** reset 回执：宿主已经清空闲聊，本地不能还留着旧条目。 */
  function applyReset() {
    serverEntries = [];
    serverIndex.clear();
    localEntries.clear();
    sending.clear();
    hasMore = false;
    typing = false;
    unread = 0;
    preview = null;
    loadedEarlier = false;
    reportedRead.clear();
    error = null;
    rebuild();
  }

  /**
   * 退出登录 / 身份切换：作废所有在途异步（包括同 agent 重登），并释放刷新单飞标记。
   * 宿主 /reset 回执仍走 applyReset()，不推进上下文代次。
   */
  function reset() {
    contextEpoch += 1;
    pollGen += 1;
    stopTimer();
    refreshPromise = null;
    loading = false;
    loadingEarlier = false;
    readInFlight = null;
    pollFailures = 0;
    opened = false;
    applyReset();
    emit();
  }

  async function dispatch(payload, clientMessageId, { reuse = false } = {}) {
    const local = reuse ? localEntries.get(clientMessageId) : null;
    if (local) {
      local.pending = true;
      local.failed = false;
      delete local.error;
    } else {
      localEntries.set(clientMessageId, createLocalEntry(payload, clientMessageId));
    }

    const previous = sending.get(clientMessageId);
    sending.set(clientMessageId, {
      clientMessageId,
      payload,
      status: 'sending',
      error: null,
      entryId: previous ? previous.entryId : null,
      sentAt: now(),
    });
    rebuild();
    emit();

    const agentAtSend = agentId;
    const epochAtSend = contextEpoch;
    try {
      const result = await client.send({ ...payload, clientMessageId });
      if (epochAtSend !== contextEpoch || agentAtSend !== agentId) {
        return {
          ok: false,
          clientMessageId,
          error: new Error('闲聊上下文已重置，本次发送结果已丢弃'),
          stale: true,
        };
      }

      if (result && result.reset === true) applyReset();
      if (result && Array.isArray(result.entries)) mergeServerEntries(result.entries);

      sending.delete(clientMessageId);
      const pendingLocal = localEntries.get(clientMessageId);
      if (pendingLocal) {
        // 服务端回显里若带了同 clientMessageId 的条目，rebuild 会丢掉本地副本；
        // 没带的时候先把它标成已确认，等下一轮轮询到达后再由 rebuild 收掉。
        pendingLocal.pending = false;
        pendingLocal.failed = false;
        pendingLocal.confirmed = true;
        if (result && typeof result.entryId === 'string' && result.entryId) {
          pendingLocal.id = result.entryId;
        }
        delete pendingLocal.error;
      }
      rebuild();
      emit();
      return {
        ok: true,
        clientMessageId,
        entryId: result && result.entryId ? result.entryId : null,
      };
    } catch (cause) {
      if (epochAtSend !== contextEpoch || agentAtSend !== agentId) {
        return {
          ok: false,
          clientMessageId,
          error: new Error('闲聊上下文已重置，本次发送结果已丢弃'),
          stale: true,
        };
      }
      const failure = toError(cause);
      const info = sending.get(clientMessageId);
      if (info) sending.set(clientMessageId, { ...info, status: 'failed', error: failure });
      const failedLocal = localEntries.get(clientMessageId);
      if (failedLocal) {
        failedLocal.pending = false;
        failedLocal.failed = true;
        failedLocal.error = failure.message;
      }
      rebuild();
      emit();
      return { ok: false, clientMessageId, error: failure };
    }
  }

  /* ---------------- 轮询 ---------------- */

  function stopTimer() {
    if (timerHandle != null) {
      clearTimerImpl(timerHandle);
      timerHandle = null;
    }
  }

  function schedulePoll() {
    if (!opened) return;
    stopTimer();
    const generation = pollGen;
    timerHandle = setTimerImpl(() => {
      timerHandle = null;
      // 返回 promise，测试里的假定时器可以直接 await 这一轮
      return pollOnce(generation);
    }, currentPollMs);
  }

  async function pollOnce(generation) {
    if (!opened || generation !== pollGen) return;
    const agentAtPoll = agentId;
    const epochAtPoll = contextEpoch;

    const [summaryResult, pageResult] = await Promise.all([
      settle(() => client.loadSummary()),
      settle(() => client.loadPage()),
    ]);

    if (!opened || generation !== pollGen || epochAtPoll !== contextEpoch || agentAtPoll !== agentId) return;

    let failure = null;
    try {
      if (summaryResult.ok) {
        applySummary(summaryResult.value);
      } else {
        failure = toError(summaryResult.error);
      }
    } catch (cause) {
      failure = toError(cause);
    }
    try {
      if (pageResult.ok) {
        applyPage(pageResult.value, { first: true });
      } else {
        failure = failure || toError(pageResult.error);
      }
    } catch (cause) {
      failure = failure || toError(cause);
    }

    // 连续失败 3 轮才把 error 抬给界面；任何一轮全部成功就恢复。
    if (failure) {
      pollFailures += 1;
      if (pollFailures >= POLL_ERROR_THRESHOLD) error = failure;
    } else {
      pollFailures = 0;
      error = null;
    }

    rebuild();
    emit();

    schedulePoll();
  }

  /* ---------------- WS 事件 ---------------- */

  /**
   * 应用一条宿主推来的闲聊事件。
   *
   * 宿主会在同一条 `/ws` 连接上推五类事件（它给 studio 订阅放行，不需要额外订阅帧）：
   *   casual_entry  { agentId, entry }        新条目；超大时 entry 只有 { id, sourceEntryId, deferred:true }
   *   casual_typing { agentId, state }        state 只有 'start' / 'end'，只在状态变化时发
   *   casual_unread { agentId, unread, preview }  摘要推送
   *   casual_error  { agentId, code }
   *   casual_style  { agentId }               风格变了，面板下次打开自己重拉
   *
   * 返回是否真的改动了状态。不是本 agent 的事件、认不出的类型、格式不对，都安静返回 false，
   * 不抛给调用方——WS 回调里抛异常会把整条连接的消息处理链打断。
   */
  function applyEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (typeof event.type !== 'string' || !event.type.startsWith('casual_')) return false;
    if (typeof event.agentId === 'string' && event.agentId && event.agentId !== agentId) return false;

    let changed = false;

    try {
      switch (event.type) {
        case 'casual_entry': {
          const entry = event.entry;
          if (!entry || typeof entry !== 'object') return false;
          // 帖子太大时宿主只推壳，让客户端自己拉：整页刷一次比猜单条接口稳。
          if (entry.deferred) {
            void refresh();
            return true;
          }
          changed = mergeServerEntries([entry]);
          break;
        }
        case 'casual_typing': {
          if (event.state === 'start') changed = typing !== true;
          else if (event.state === 'end') changed = typing !== false;
          else return false;
          typing = event.state === 'start';
          break;
        }
        case 'casual_unread': {
          const beforeUnread = unread;
          const beforePreview = preview;
          applySummary(event);
          changed =
            beforeUnread !== unread ||
            JSON.stringify(beforePreview) !== JSON.stringify(preview);
          break;
        }
        case 'casual_error': {
          const code = typeof event.code === 'string' ? event.code : 'unknown';
          error = new Error(`闲聊暂时不可用（${code}）`);
          error.code = code;
          changed = true;
          break;
        }
        case 'casual_style':
          // 风格数据不归状态机管：面板打开时自己重拉，这里不触发重渲染。
          return false;
        default:
          return false;
      }
    } catch {
      // 单条事件格式不对不应该影响连接，也不应该让界面报错。
      return false;
    }

    if (changed) {
      rebuild();
      emit();
    }
    return changed;
  }

  /* ---------------- 首屏 / 手动刷新 ---------------- */

  async function runRefresh() {
    const agentAtLoad = agentId;
    const epochAtLoad = contextEpoch;
    const [summaryResult, pageResult] = await Promise.all([
      settle(() => client.loadSummary()),
      settle(() => client.loadPage()),
    ]);

    if (epochAtLoad !== contextEpoch || agentAtLoad !== agentId) return false;

    let failure = null;
    try {
      if (summaryResult.ok) applySummary(summaryResult.value);
      else failure = toError(summaryResult.error);
    } catch (cause) {
      failure = toError(cause);
    }
    try {
      if (pageResult.ok) applyPage(pageResult.value, { first: true });
      else failure = failure || toError(pageResult.error);
    } catch (cause) {
      failure = failure || toError(cause);
    }

    if (failure) {
      error = failure;
    } else {
      error = null;
      pollFailures = 0;
    }

    loading = false;
    rebuild();
    emit();
    return !failure;
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;
    loading = true;
    const task = runRefresh();
    // 先占位再 emit：监听器里若同步调用 refresh()/open()，拿到的也是同一个请求。
    refreshPromise = task;
    const clear = () => {
      if (refreshPromise === task) refreshPromise = null;
    };
    task.then(clear, clear);
    emit();
    return task;
  }

  /* ---------------- 对外方法 ---------------- */

  async function open() {
    if (opened) return true;
    opened = true;
    pollGen += 1;
    const generation = pollGen;
    const ok = await refresh();
    if (opened && generation === pollGen) schedulePoll();
    return ok;
  }

  function close() {
    if (!opened) return;
    opened = false;
    pollGen += 1;
    stopTimer();
    loading = false;
    loadingEarlier = false;
    emit();
  }

  async function loadEarlier() {
    if (loadingEarlier) return false;
    if (!hasMore) return false;

    const earliest = earliestServerEntry();
    if (!earliest || !earliest.sourceEntryId) {
      hasMore = false;
      emit();
      return false;
    }

    const agentAtLoad = agentId;
    const epochAtLoad = contextEpoch;
    loadingEarlier = true;
    emit();

    try {
      const page = await client.loadPage({ before: earliest.sourceEntryId });
      if (epochAtLoad !== contextEpoch || agentAtLoad !== agentId) return false;
      applyPage(page, { first: false });
      loadedEarlier = true;
      error = null;
      return true;
    } catch (cause) {
      if (epochAtLoad !== contextEpoch || agentAtLoad !== agentId) return false;
      error = toError(cause);
      return false;
    } finally {
      if (epochAtLoad === contextEpoch && agentAtLoad === agentId) {
        loadingEarlier = false;
        emit();
      }
    }
  }

  async function send(input) {
    const payload = normalizeOutgoing(input);
    return dispatch(payload, defaultMessageId());
  }

  async function retry(clientMessageId) {
    if (typeof clientMessageId !== 'string' || clientMessageId.trim() === '') {
      throw new Error('retry 需要非空的 clientMessageId');
    }
    // 视图层点重试时传的是条目 id；本地乐观条目的 id 是 local:<clientMessageId>。
    // 两种写法都认，接线时不用再转换。
    let key = clientMessageId;
    if (!sending.has(key) && key.startsWith('local:')) key = key.slice('local:'.length);

    const info = sending.get(key);
    if (!info || info.status !== 'failed') {
      return {
        ok: false,
        clientMessageId: key,
        error: new Error('没有可重试的失败条目'),
      };
    }
    // 关键：沿用同一个 clientMessageId，服务端才能把两次请求认成同一条消息。
    return dispatch({ ...info.payload }, key, { reuse: true });
  }

  async function markReadThrough(entryId) {
    if (typeof entryId !== 'string' || entryId.trim() === '') return false;
    if (entryId.startsWith('local:')) return false; // 本地乐观条目没有服务端 id
    if (reportedRead.has(entryId)) return false;

    // 身份快照必须在任何 await 之前：B 排队等 A 时如果 reset/换 Agent，
    // 排队结束后的 B 仍属于旧上下文，不能拿新身份继续发请求。
    const agentAtRead = agentId;
    const epochAtRead = contextEpoch;

    if (readInFlight) {
      try {
        await readInFlight.promise;
      } catch {
        // 上一次已读失败不影响这一次
      }
      // 等待期间 reset/换 Agent：直接作废 B，不碰可能已经属于新上下文的 readInFlight。
      if (agentAtRead !== agentId || epochAtRead !== contextEpoch) return false;
      if (reportedRead.has(entryId)) return false;
    }

    const holder = { entryId, promise: null };
    readInFlight = holder;

    const attempt = (async () => {
      try {
        await client.markRead(entryId);
        if (epochAtRead !== contextEpoch || agentAtRead !== agentId) return false;
        reportedRead.add(entryId);
        if (entryId === latestAgentEntryId()) {
          unread = 0;
          emit();
        }
        return true;
      } catch {
        // 已读是尽力而为：失败不置全局 error，也不记账，下次状态更新会再试
        return false;
      } finally {
        if (readInFlight === holder) readInFlight = null;
      }
    })();

    holder.promise = attempt;
    return attempt;
  }

  async function setAgentId(nextAgentId) {
    if (typeof nextAgentId !== 'string' || nextAgentId.trim() === '') {
      throw new Error('setAgentId 需要非空的 agentId 字符串');
    }
    if (nextAgentId === agentId) return true;

    client.setAgentId(nextAgentId);
    agentId = nextAgentId;
    contextEpoch += 1;

    entries = [];
    serverEntries = [];
    serverIndex.clear();
    localEntries.clear();
    sending.clear();
    hasMore = false;
    typing = false;
    unread = 0;
    preview = null;
    loading = false;
    loadingEarlier = false;
    error = null;
    loadedEarlier = false;
    pollFailures = 0;
    reportedRead.clear();
    readInFlight = null;
    // 旧 agent 的 refresh 即使还在途也不能再占着 refreshPromise，否则本次重载拿不到新数据。
    refreshPromise = null;

    pollGen += 1;
    stopTimer();
    rebuild();
    emit();

    if (!opened) return true;

    const ok = await refresh();
    if (opened) schedulePoll();
    return ok;
  }

  /**
   * 调轮询间隔。
   *
   * WS 连着时事件是推的，轮询只用来兜底校正（默认放到 30 秒），面板开着也不用心疼流量；
   * 断线了就收回 4 秒。面板没开时只记下数值，等下次打开按新值跑。
   */
  function setPollMs(nextMs) {
    const value = Number(nextMs);
    if (!Number.isFinite(value) || value < 1000) {
      throw new Error('setPollMs 需要一个不小于 1000 的毫秒值');
    }
    if (value === currentPollMs) return false;
    currentPollMs = value;
    if (opened) schedulePoll();
    return true;
  }

  function getState() {
    return snapshot();
  }

  return {
    open,
    close,
    reset,
    refresh,
    loadEarlier,
    send,
    retry,
    markReadThrough,
    setAgentId,
    applyEvent,
    setPollMs,
    isOpen: () => opened,
    getState,
  };
}
