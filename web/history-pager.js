/* web/history-pager.js
 *
 * 历史消息分页纯控制器。
 *
 * 只负责「取哪一页、何时能取、哪些条目是新的」：不碰 DOM、不读取 app 的 S，
 * 不 import 任何 UI/应用模块。渲染与滚动仍由调用方在 onPage / onState 里处理。
 *
 * 宿主事实（bundle 1.5.48-beta 已定点核对）：
 *   - GET /api/sessions/messages?sessionId=&path=&limit=50
 *     返回 { messages: [...], hasMore, blocks, sessionFiles, ... }。
 *     sessionFiles 是宿主按全 raw 引用集序列化的正式目录元数据数组，本模块只原样
 *     交给当前页回调，不并入 block/message，不缓存、不跨会话复用。
 *   - before 是「排除当前窗口之前」的可见消息全局索引；宿主用
 *     avn(beforeId, limit) 切 [before-limit, before)。before<=0 会被当成最新页。
 *   - messages 只含 user/assistant，messages[].id 是可见消息全局索引的十进制
 *     字符串（源码 id: String(index)），本模块统一转成数字比较；0 是合法消息 id，
 *     但绝不能作为 before 发出。
 *   - toolResult / 卡片投影在 blocks，块上额外带 afterIndex（页内消息下标）与
 *     sourceIndex（原始 session entry 下标）；show_card 投影为 interactive_card
 *     （code 或 packageRef），本模块原样透传，不伪造 receipt、不补路径/身份。
 *
 * 契约：
 *   createHistoryPager({ api, pageSize=50, onPage, onState, canLoad, retry })
 *     -> { open, loadOlder, reset, dispose }
 *
 *   - open(session)：同步捕获 sessionId/path 标量（至少一者非空，否则抛 TypeError），
 *     递增 epoch、清空 seen/游标，请求最新一页：
 *       GET /api/sessions/messages?sessionId=...&path=...&limit=50
 *     只带有效身份与 limit，不带 namespace / all / before。旧 open 的成功/失败因
 *     epoch 不匹配而静默丢弃。成功后 onPage({entries, prepend:false, hasMore, sessionFiles})。
 *   - loadOlder()：仅当 hasMore && cursor>0 && !loading 且 canLoad('older') 放行可尝试请求
 *       ...&before=<已加载页最早 raw message id>&limit=50
 *     成功后 onPage({entries, prepend:true, hasMore, sessionFiles})；重叠/已见 id 会被过滤。
 *     全重叠的空页只更新 onState，不调用 onPage。并行调用只有第一次生效；
 *     cursor 为 0/缺失/不前进时关闭 hasMore，绝不请求 before=0，也不会自动循环拉全史。
 *   - onPage({entries, prepend, hasMore, sessionFiles})：entries 是「原始 message
 *     对象 + 原始 block 对象」按锚点交错的当前页投影：第 i 条消息之后按宿主顺序
 *     插入 afterIndex=i 的块；消息按 id 去重，重复消息锚点上的块随之丢弃。block
 *     不伪装成 toolResult；cursor 只取 messages 的 id，绝不用 block 的 cardId /
 *     sourceIndex / afterIndex / id。sessionFiles 是当前页响应数组的同一引用，
 *     缺失/null 为 []；它只随本次 onPage 交付，不保存。
 *   - open/loadOlder 返回 Promise<boolean>：获胜成功交付为 true；被拦截、出错或过期
 *     为 false（错误已经通过 onState 上报，不 reject）。open 的初始页即使为空也会
 *     调用 onPage（prepend:false），便于调用方渲染空历史状态。
 *   - onState({loading, hasMore, error, phase})：每次状态变化给全量快照。请求/响应
 *     错误与 canLoad 拦截都只走 error，不伪装空成功；已加载内容与 cursor 保留，可重试。
 *     phase 是本次（或最近一次）请求的来源：open() 为 'initial'，loadOlder() 为
 *     'older'；没有请求时沿用最近一次，初次为 'initial'。error 为 null 时也照给，
 *     视图只在有 error 时读它，用来区分「首屏失败」与「加载更早失败」。
 *   - 瞬时故障自动重试：HTTP 502/503/504（Cloudflare 隧道瞬断的码）与没有 HTTP 状态的
 *     网络层失败（fetch 抛错 / TypeError / ECONNRESET）最多再试 2 次，退避 400ms、
 *     1200ms，总共最多 3 次请求。500 和其它状态码、4xx、busy、超时（code='timeout'）、
 *     响应形状错误（shapeError）立即上报，不重试：500 是宿主真实报错，快速失败让人看见
 *     比静默重试更合适；4xx 重试只会重复同一个失败；超时（客户端 15s）已经等过了，再重试只是
 *     把 3×15s 的空白全甩给用户，而隧道瞬断已经在 15s 内看到状态码了。
 *     重试期间保持 loading:true 且不报 error（用户不该看到闪一下的错误），每次请求
 *     前与退避等待后都重新核对 epoch：切走/重置立即放弃，绝不把旧会话的结果写进
 *     新会话。重试用尽才把最后一次的原始错误交给 onState，不包装、不改状态码。
 *     retry 选项可注入 { attempts, delays, sleep }；测试注入假 sleep，不真等 1.6 秒。
 *     生产默认 setTimeout，调用方不必传。
 *   - canLoad(kind) 在每次发 GET 前（含退避后的下一次）与响应提交前各检查一次。kind 是
 *     本次请求的类型：open()（首屏 / 重载，整页替换）传 'open'，loadOlder()（往更早翻一页，
 *     prepend）传 'older'；重试前的复核与响应提交前的复核都沿用同一个 kind。缺省 / 未知
 *     值一律按 'open' 处理，所以旧的无参 canLoad（例如 () => !busy）语义不变，只是拿不到
 *     类型、两条路径行为一致。返回 false（例如正在生成回复）时不发请求 / 不交付该页、
 *     不推进 cursor、不改 seen，error.code='busy'，稍后可重试。
 *     kind 只描述请求类型，不改变拦截语义：要不要放开生成中的「加载更早」由调用方决定
 *     （控制器传 canLoad: (kind) => (kind === 'older' ? true : !state.busy)）。
 *   - reset()：废弃在途结果，清空身份/游标/seen，并 onState 空状态。
 *   - dispose()：废弃在途结果并永久静默；之后 open/loadOlder 无操作、不再回调。
 *
 * 兼容：响应为数组、{ messages: [...] }、{ entries: [...] } 或 { items: [...] }。
 * hasMore 只认显式 true；缺失按「没有更早」处理。blocks 缺失/null 视为空；显式
 * 非数组则抛「blocks 格式不正确」，交给 onState error，不静默当空页。单块
 * afterIndex 缺失/非整数/越界时丢弃该块，绝不挂到相邻消息；未知 type 仍原样交付。
 * sessionFiles 缺失/null 视为 []；显式非数组抛「sessionFiles 格式不正确」。一样不猜。
 * 数组 / entries / items 的 legacy toolResult 条目只作旧响应兼容，不是真实宿主形状。
 *
 * 内存：不保存历史条目，只保留已交付消息 id 的 Set 与 block 去重 key；
 * sessionFiles 只存在于当前页回调参数里。
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// canLoad 的请求类型：'open' 是整页替换（首屏 / 重载），'older' 是往更早翻一页（prepend）。
const KIND_OPEN = 'open';
const KIND_OLDER = 'older';
// 瞬断重试：首试之外最多 2 次，退避 400ms、1200ms。
const DEFAULT_RETRY = { attempts: 2, delays: [400, 1200] };
// 只重试真机见过的隧道瞬断码。500 是宿主真实报错，快速失败比静默重试更合适。
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function normalizePageSize(value) {
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

// messages[].id 是十进制字符串（"0"、"42"…）；统一转成正整数/零索引。
function toMessageIndex(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

function messageIndexOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return toMessageIndex(entry.id);
}

function earliestIndex(entries) {
  let earliest = null;
  for (const entry of entries) {
    const id = messageIndexOf(entry);
    if (id == null) continue;
    if (earliest == null || id < earliest) earliest = id;
  }
  return earliest;
}

function captureIdentity(session) {
  const sessionId = typeof session?.sessionId === 'string' && session.sessionId.trim()
    ? session.sessionId
    : null;
  const path = typeof session?.path === 'string' && session.path.trim()
    ? session.path
    : null;
  if (!sessionId && !path) {
    throw new TypeError('历史分页需要 sessionId 或 path');
  }
  return { sessionId, path };
}

function shapeError(message) {
  const error = new Error(
    message || '历史消息响应格式不正确：期望数组或 { messages/entries/items: [...] }',
  );
  error.code = 'malformed-response';
  return error;
}

function busyError() {
  const error = new Error('正在生成回复，稍后再加载更早的消息');
  error.code = 'busy';
  return error;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HTTP 状态码只认显式数字/数字字符串；拿不到就按「没有 HTTP 响应」处理。
function httpStatusOf(cause) {
  if (!cause || typeof cause !== 'object') return null;
  for (const value of [cause.status, cause.statusCode]) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      if (n > 0) return n;
    }
  }
  const response = cause.response;
  if (response && typeof response === 'object') {
    return httpStatusOf({ status: response.status, statusCode: response.statusCode });
  }
  return null;
}

/**
 * 只对瞬时故障重试：502/503/504 + 网络层失败（没有 HTTP 状态）。
 * 500 与其它状态码、4xx（权限/参数/不存在/冲突）、busy、超时、响应形状错误都不重试：
 * 500 是宿主真实报错，4xx 重试也只会重复同一个失败；超时已经耗完客户端 15s 预算，
 * 再重试只是把等待翻三倍。
 */
function isRetryableError(cause) {
  if (!cause || typeof cause !== 'object') return false;
  if (cause.code === 'busy' || cause.code === 'malformed-response' || cause.code === 'timeout') return false;
  const status = httpStatusOf(cause);
  if (status != null) return RETRYABLE_STATUS.has(status);
  // 没有 HTTP 状态：fetch 抛错 / TypeError / ECONNRESET 这类传输层失败，按瞬时处理。
  return true;
}

// 只覆盖调用方真的传了的字段，其余沿用默认（例如只注入 sleep 的测试）。
function normalizeRetry(options) {
  const source = options && typeof options === 'object' ? options : {};
  const attempts = Number.isInteger(source.attempts) && source.attempts >= 0
    ? source.attempts
    : DEFAULT_RETRY.attempts;
  const delays = Array.isArray(source.delays)
    ? source.delays.filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)
    : DEFAULT_RETRY.delays;
  return {
    attempts,
    delays,
    sleep: typeof source.sleep === 'function' ? source.sleep : defaultSleep,
  };
}

// block 的稳定身份字段：只用来做跨页去重，不改写也不推断任何缺失值。
function blockIdentity(block) {
  const parts = [];
  for (const key of ['cardId', 'toolCallId', 'messageId', 'fileId']) {
    const value = block[key];
    if (typeof value === 'string' && value) parts.push(`${key}:${value}`);
  }
  const ref = block.packageRef;
  if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    for (const key of ['fileId', 'sessionId', 'sessionPath', 'entryName']) {
      const value = ref[key];
      if (typeof value === 'string' && value) parts.push(`packageRef.${key}:${value}`);
    }
  }
  return parts.join('|');
}

// sourceIndex 是原始 session entry 下标，跨页稳定；同 source 的多个块用页内序号区分。
// 没有 sourceIndex 的块返回 null，不做跨页 key，交给锚点去重。
function blockKey(block, counters) {
  const source = toMessageIndex(block.sourceIndex);
  if (source == null) return null;
  const type = typeof block.type === 'string' ? block.type : '';
  const identity = blockIdentity(block);
  if (identity) return `s${source}|${type}|${identity}`;
  const base = `s${source}|${type}`;
  const next = (counters.get(base) || 0) + 1;
  counters.set(base, next);
  return `${base}|#${next}`;
}

function parsePage(raw) {
  let messages = null;
  let blocks = [];
  let sessionFiles = [];
  let hasMore = false;

  if (Array.isArray(raw)) {
    messages = raw;
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.messages)) {
      messages = raw.messages;
    } else if (Array.isArray(raw.entries)) {
      messages = raw.entries;
    } else if (Array.isArray(raw.items)) {
      messages = raw.items;
    }

    // blocks/sessionFiles 缺失/null 按旧响应兼容；显式给了非数组就必须报错，不能猜。
    if (Object.prototype.hasOwnProperty.call(raw, 'blocks') && raw.blocks != null) {
      if (!Array.isArray(raw.blocks)) {
        throw shapeError('历史消息响应 blocks 格式不正确：期望数组');
      }
      blocks = raw.blocks;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'sessionFiles') && raw.sessionFiles != null) {
      if (!Array.isArray(raw.sessionFiles)) {
        throw shapeError('历史消息响应 sessionFiles 格式不正确：期望数组');
      }
      sessionFiles = raw.sessionFiles;
    }
    if (messages) hasMore = raw.hasMore === true;
  }

  if (!Array.isArray(messages)) throw shapeError();
  return { messages, blocks, sessionFiles, hasMore };
}

/**
 * 创建历史分页控制器。
 *
 * @param {object} options
 * @param {(pathname: string) => Promise<any>} options.api 同源请求函数
 * @param {number} [options.pageSize=50] 每页条数，1..200（超出按 200）
 * @param {(page: {entries: object[], prepend: boolean, hasMore: boolean, sessionFiles: object[]}) => void} [options.onPage]
 * @param {(state: {loading: boolean, hasMore: boolean, error: Error|null, phase: 'initial'|'older'}) => void} [options.onState]
 * @param {(kind: 'open'|'older') => boolean} [options.canLoad] 当前是否允许取这一类历史
 *   （kind: 'open' 整页替换受 busy 保护，'older' 加载更早）；缺省按 'open' 处理
 * @param {{attempts?: number, delays?: number[], sleep?: (ms: number) => Promise<void>}} [options.retry]
 *   瞬时故障重试策略，默认 { attempts: 2, delays: [400, 1200], sleep: setTimeout }
 * @returns {{ open: (session: object) => Promise<boolean>, loadOlder: () => Promise<boolean>, reset: () => void, dispose: () => void }}
 */
export function createHistoryPager({
  api,
  pageSize = DEFAULT_PAGE_SIZE,
  onPage = () => {},
  onState = () => {},
  canLoad = () => true,
  retry,
} = {}) {
  if (typeof api !== 'function') {
    throw new TypeError('createHistoryPager requires { api }');
  }

  const limit = normalizePageSize(pageSize);
  const retryPlan = normalizeRetry(retry);

  /**
   * canLoad 的类型归一：只认 'older'，其余（undefined / null / 未知值）一律按 'open'。
   * 'open' 是整页替换、保护最严，把缺省当 'open' 不会让旧调用方的语义变宽。
   * 返回值按真值判断，和改动前的 `!canLoad()` 完全一致。
   */
  function allowsLoad(kind) {
    return Boolean(canLoad(kind === KIND_OLDER ? KIND_OLDER : KIND_OPEN));
  }

  /** 本次请求对应的 canLoad 类型：prepend 是加载更早，其余都是整页替换。 */
  function kindOf(prepend) {
    return prepend ? KIND_OLDER : KIND_OPEN;
  }

  let epoch = 0;
  let disposed = false;
  let identity = null;
  let cursor = null;
  let hasMore = false;
  let loading = false;
  let error = null;
  // 最近一次请求的来源。reset/dispose 不归零：契约要求「无请求时沿用最近一次」，
  // 而且视图只在 error 非空时才读 phase。
  let phase = 'initial';
  const seen = new Set();
  const seenBlocks = new Set();

  function isCurrent(myEpoch) {
    return !disposed && myEpoch === epoch;
  }

  function emitState() {
    onState({ loading, hasMore, error, phase });
  }

  function buildUrl(before) {
    const query = new URLSearchParams();
    if (identity.sessionId) query.set('sessionId', identity.sessionId);
    if (identity.path) query.set('path', identity.path);
    if (before != null) query.set('before', String(before));
    query.set('limit', String(limit));
    return `/api/sessions/messages?${query.toString()}`;
  }

  function fail(myEpoch, cause) {
    if (!isCurrent(myEpoch)) return false;
    loading = false;
    error = cause instanceof Error ? cause : new Error(String(cause));
    emitState();
    return false;
  }

  /** 生成态拦截：不发 GET、不动 cursor/seen，只报 busy 并收掉 loading，稍后可重试。 */
  function busyStop(myEpoch) {
    if (!isCurrent(myEpoch)) return false;
    loading = false;
    error = busyError();
    emitState();
    return false;
  }

  function commit(myEpoch, raw, prepend) {
    if (!isCurrent(myEpoch)) return false;

    let parsed;
    try {
      parsed = parsePage(raw);
    } catch (err) {
      return fail(myEpoch, err);
    }

    // 响应已回来，但用户可能刚进入生成态：整页丢弃，不 render、不推进游标。
    // 复核必须沿用本页的类型（更早页用 'older'），否则生成中 prepend 会被自己拦掉。
    if (!allowsLoad(kindOf(prepend))) return busyStop(myEpoch);

    const entries = [];
    const messages = parsed.messages;
    const blocksByAnchor = new Map();

    for (const block of parsed.blocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const anchor = toMessageIndex(block.afterIndex);
      // 锚点是页内消息下标；越界或缺失一律丢弃，绝不猜相邻消息。
      if (anchor == null || anchor >= messages.length) continue;
      let anchored = blocksByAnchor.get(anchor);
      if (!anchored) {
        anchored = [];
        blocksByAnchor.set(anchor, anchored);
      }
      anchored.push(block);
    }

    const blockCounters = new Map();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;

      const id = messageIndexOf(message);
      if (id != null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      entries.push(message);

      const anchored = blocksByAnchor.get(index);
      if (!anchored) continue;
      for (const block of anchored) {
        const key = blockKey(block, blockCounters);
        if (key != null) {
          if (seenBlocks.has(key)) continue;
          seenBlocks.add(key);
        }
        entries.push(block);
      }
    }

    const earliestRaw = earliestIndex(messages);
    let nextCursor = cursor;
    let nextHasMore = parsed.hasMore;

    if (nextHasMore) {
      if (earliestRaw == null || earliestRaw <= 0) {
        // 没有可用的正数 before：before=0 会被宿主当成最新页，必须停。
        nextHasMore = false;
      } else if (!prepend) {
        nextCursor = earliestRaw;
      } else if (cursor == null || earliestRaw >= cursor) {
        // 游标不前进（服务端忽略 before / 返回重复页）：停，避免无限循环。
        nextHasMore = false;
      } else {
        nextCursor = earliestRaw;
      }
    } else if (earliestRaw != null) {
      nextCursor = earliestRaw;
    }

    loading = false;
    hasMore = nextHasMore;
    cursor = nextCursor;
    error = null;

    const page = {
      entries,
      prepend: Boolean(prepend),
      hasMore: nextHasMore,
      sessionFiles: parsed.sessionFiles,
    };
    // 渲染抛错不能把 pager 卡在 loading：收成一次失败（可重试），绝不让 Promise 崩给调用方。
    try {
      if (!prepend || entries.length > 0) onPage(page);
    } catch (err) {
      return fail(myEpoch, err);
    }
    emitState();
    return true;
  }

  /** 发一次请求；api 同步抛错也折成 { error }，调用方统一判断要不要重试。 */
  function requestOnce(before) {
    let pending;
    try {
      pending = api(buildUrl(before));
    } catch (err) {
      return Promise.resolve({ raw: undefined, error: err });
    }
    return Promise.resolve(pending).then(
      (raw) => ({ raw, error: null }),
      (err) => ({ raw: undefined, error: err }),
    );
  }

  /**
   * 取一页，瞬时故障自动重试。
   *
   * 重试期间故意不动 loading / error：用户看到的还是「加载中」，不会先闪一下错误。
   * 每次请求前、退避等待后都重新核对 epoch：切走/重置就立刻放弃，旧会话的结果
   * 不能落进新会话。重试用尽才把最后一次的原始错误交给 onState（不包装、不改码）。
   */
  async function request(myEpoch, before, prepend) {
    for (let attempt = 0; ; attempt += 1) {
      if (!isCurrent(myEpoch)) return false;
      // 每次真正发 GET 之前都重新核对一次（首试 + 每次退避之后）：退避的几百毫秒里
      // 用户可能刚好开始生成，这时不能再打宿主的消息接口。复核带上本次请求的类型
      // （open 走 'open'、加载更早走 'older'），退避期间的类型不会被换成另一条路径。
      if (!allowsLoad(kindOf(prepend))) return busyStop(myEpoch);

      const result = await requestOnce(before);
      if (!isCurrent(myEpoch)) return false;
      if (!result.error) return commit(myEpoch, result.raw, prepend);

      if (!isRetryableError(result.error) || attempt >= retryPlan.attempts) {
        return fail(myEpoch, result.error);
      }

      const delay = retryPlan.delays.length
        ? retryPlan.delays[Math.min(attempt, retryPlan.delays.length - 1)]
        : 0;
      try {
        await retryPlan.sleep(delay);
      } catch (err) {
        // 连 sleep 都失败（测试夹具）也不能把 Promise reject 出去：错误只走 onState。
        return isCurrent(myEpoch) ? fail(myEpoch, result.error) : false;
      }
    }
  }

  function open(session) {
    if (disposed) return Promise.resolve(false);
    const nextIdentity = captureIdentity(session);
    const sameTarget = Boolean(
      identity
      && identity.sessionId === nextIdentity.sessionId
      && identity.path === nextIdentity.path,
    );

    // 生成中后台补拉被 busy 拦下时，不能顺手把已加载页的游标清掉：
    // 目标没变就只是「这次不重载」，已翻过的页要能继续往前翻；
    // 目标变了才必须清干净（旧页属于别的会话，迟到的响应一律作废）。
    if (sameTarget && !allowsLoad(KIND_OPEN)) {
      error = busyError();
      emitState();
      return Promise.resolve(false);
    }

    epoch += 1;
    const myEpoch = epoch;
    identity = nextIdentity;
    phase = 'initial';
    seen.clear();
    seenBlocks.clear();
    cursor = null;
    hasMore = false;
    loading = false;
    error = null;

    // open 是整页替换：仍按 'open' 问调用方（生成中默认不放行，避免顶掉实时轮）。
    if (!allowsLoad(KIND_OPEN)) {
      error = busyError();
      emitState();
      return Promise.resolve(false);
    }

    loading = true;
    emitState();
    return request(myEpoch, null, false);
  }

  function loadOlder() {
    if (disposed || !identity || loading || !hasMore) return Promise.resolve(false);
    phase = 'older';

    if (!Number.isInteger(cursor) || cursor <= 0) {
      // 游标不可用：关掉 hasMore，给出状态但绝不发 before=0。
      hasMore = false;
      emitState();
      return Promise.resolve(false);
    }

    // 加载更早是 prepend：只看调用方给 'older' 的口径（生成中通常放行）。
    if (!allowsLoad(KIND_OLDER)) {
      error = busyError();
      emitState();
      return Promise.resolve(false);
    }

    const myEpoch = epoch;
    loading = true;
    error = null;
    emitState();
    return request(myEpoch, cursor, true);
  }

  function reset() {
    if (disposed) return;
    epoch += 1;
    identity = null;
    seen.clear();
    seenBlocks.clear();
    cursor = null;
    hasMore = false;
    loading = false;
    error = null;
    emitState();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch += 1;
    identity = null;
    seen.clear();
    seenBlocks.clear();
    cursor = null;
    hasMore = false;
    loading = false;
    error = null;
  }

  return { open, loadOlder, reset, dispose };
}
