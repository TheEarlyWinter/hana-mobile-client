/* web/websocket-client.js — 与宿主的 /ws 长连接
 *
 * 从 app.js 抽出来的一整块：连接代次、重连定时器、断线时排队的 abort、
 * 以及三条「和连接状态强相关」的协议帧（client_attention / context_usage / resume_stream）。
 *
 * 为什么值得单独一个模块：这里的每个 bug 都是时序 bug（旧连接的迟到事件、没取消的
 * 定时器、断线时点停止），把它们集中在一处才能一眼看全。所有副作用通过注入的
 * onReadyChange / onOpen / onMessage / onAbortFlushed 回调交回给 app，模块自己不碰 DOM。
 *
 * 状态仍然放在调用方给的 state 对象上（ws / wsReady / reconnectDelay / session），
 * 因为 app 里别处也要读它们（发送按钮可用性、等连接的循环）；模块只负责维护一致性。
 * 断线时排队的 abort 不在 state 上了：归 abort-queue.js，由调用方注入（见 abortQueue 参数）。
 *
 * 契约：
 *   - connect()：取消排队中的重连，代次 +1，先摘旧引用再关旧连接，再建新的；
 *     旧连接晚到的 open/message/close/error 一律因代次不符被丢弃。
 *     没有 WebSocket 能力或构造失败时**不抛**，改报 onUnavailable：调用方是
 *     openSession / 重连定时器 / 前台恢复，没有一处 catch，抛出去就是未捕获错误。
 *   - drop()：彻底放弃连接与排队中的重连（退出登录 / 回首页 / 身份切换）。
 *   - send(frame)：连接不是 OPEN 时返回 false 并且不丢帧；返回 true 表示已写进连接。
 *   - waitForReady(ms, shouldCancel)：等连接就绪，超时或被取消都返回 false（不 reject）。
 *     取消只结束等待，不代表别处不该发帧——发不发由调用方按自己的归属条件决定。
 *   - scheduleReconnect(delay)：只保留一个定时器引用，重复调用以最后一次为准。
 *   - flushPendingAbort()：断线时点的「停止」排进 abortQueue，
 *     连接恢复后先补发；发出去之后才回调 onAbortFlushed 收本地生成态。
 *     入队由 composer 负责（它是「停止」的生产者），这里只负责补发。
 *
 * 连接状态（onStatusChange，给 E9 顶部断线细条用）：
 *   - 'connecting'：刚发起一次连接（首屏、手动重连、退避到点后的自动重连）；
 *   - 'connected'：当前代次的连接真的 open 了；
 *   - 'reconnecting'：掉线且 shouldReconnect() 为真，重连定时器已排上；
 *   - 'closed'：掉线且不再重连，或调用方主动 drop()（退出登录 / 回首页）。
 *   只在既有回调之后追加，不改变 onReadyChange / onOpen / onMessage 的原有顺序；
 *   这个回调只做提示，抛异常也不会影响连接逻辑（内部吞掉并写 debug）。
 *   error 事件不算状态变化：报错不等于断线，等 close 再说。
 */

import { parseSocketPayload } from './protocol.js';
import { createAbortQueue } from './abort-queue.js';

const DEFAULT_RECONNECT_DELAY = 800;
const MAX_RECONNECT_DELAY = 8000;

/**
 * @param {object} [options]
 * @param {object} [options.state] 持有 ws / wsReady / reconnectDelay / session 的状态对象
 * @param {{ push: (entry: any) => boolean, peek: () => any, take: () => any, clear: () => void, size: () => number }} [options.abortQueue] 断线时「停止」的待补发队列（与 composer 共用同一个实例）；缺省自建
 * @param {() => object|null} [options.getSession]
 * @param {() => any} [options.getWebSocket] 取 WebSocket 构造器（测试可替换）
 * @param {() => {protocol: string, host: string}} [options.getLocation]
 * @param {() => {streamId: string|null, sinceSeq: number}} [options.getResumeFields]
 * @param {(pending: object) => object|null} [options.makeAbortFrame] 由 pending 拼 abort 帧
 * @param {(ready: boolean) => void} [options.onReadyChange] 连接就绪/断开（改指示灯、按钮）
 * @param {(status: 'connecting'|'connected'|'reconnecting'|'closed') => void} [options.onStatusChange]
 *        连接层状态（细条提示用）；在任何业务回调之后触发
 * @param {(reason: 'unsupported'|'constructor', error?: any) => void} [options.onUnavailable]
 *        连不了：内核没有 WebSocket（unsupported）或构造器当场抛错（constructor）。
 *        这不是断线，重连也没用，所以不排重连、只报一次。
 * @param {() => void} [options.onError] socket 报错（只改指示灯，不动按钮）
 * @param {(info: {aborted: boolean}) => void} [options.onOpen] 连接就绪后的业务钩子
 * @param {(data: object) => void} [options.onMessage] 收到一条 JSON 事件
 * @param {() => void} [options.onAbortFlushed] 排队的 abort 真的发出去之后
 * @param {(dir: string, obj: object) => void} [options.debug]
 * @param {() => boolean} [options.shouldReconnect] 断开后要不要自己重连；默认「有会话才重连」。
 *        闲聊面板能脱离会话单独打开，所以调用方要能把「面板开着」也算成有活干。
 */
export function createWebsocketClient({
  state,
  abortQueue = null,
  getSession = () => state.session,
  shouldReconnect = () => Boolean(getSession()),
  getWebSocket = () => globalThis.WebSocket,
  getLocation = () => globalThis.location,
  getResumeFields = () => ({ streamId: null, sinceSeq: 0 }),
  makeAbortFrame = () => null,
  onReadyChange = () => {},
  onStatusChange = () => {},
  onUnavailable = () => {},
  onError = () => {},
  onOpen = () => {},
  onMessage = () => {},
  onAbortFlushed = () => {},
  debug = () => {},
} = {}) {
  if (!state) throw new TypeError('createWebsocketClient requires { state }');

  /** 断线时点的「停止」排在这里，连接恢复后补发。生产装配会传与 composer 相同的那一个。 */
  const aborts = abortQueue || createAbortQueue();

  // 连接代次：每次 connect 换一个号。所有回调只认自己那一代，旧连接晚到的
  // message/close/error 一律丢弃。否则一条迟到的 close 会把刚建好的连接标成断线，
  // 还会再排一个把新连接关掉的重连定时器。
  let generation = 0;
  // 重连定时器只留一个引用：手动连接、切会话、退出登录都要能取消它。
  let reconnectTimer = null;

  /**
   * 报一次连接层状态。
   *
   * 只给提示用（顶部细条），所以这里把回调的异常吞掉：一个画细条的 bug 不该让
   * 连接建立、续流、补发 abort 这些真业务半路中断。排查时看 debug 日志。
   */
  function emitStatus(status) {
    try {
      onStatusChange(status);
    } catch (err) {
      debug('status:error', { status, error: String(err && err.message ? err.message : err) });
    }
  }

  function isOpen() {
    const impl = getWebSocket();
    return Boolean(state.ws) && state.ws.readyState === impl.OPEN;
  }

  function isReady() {
    return Boolean(state.wsReady) && isOpen();
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(delay = state.reconnectDelay) {
    cancelReconnect();
    const wait = Math.max(0, Number(delay) || 0);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // 业务已无需重连、或者连接已经好了：这个定时器就是废的，不能去动新连接。
      if (!shouldReconnect()) return;
      if (isReady()) return;
      connect();
    }, wait);
  }

  /** 彻底放弃当前连接与排队中的重连（退出登录 / 回首页 / 身份切换）。 */
  function drop() {
    cancelReconnect();
    generation += 1;   // 让在途回调全部作废
    aborts.clear();
    const wasReady = Boolean(state.wsReady);
    const ws = state.ws;
    state.ws = null;
    if (ws) { try { ws.close(); } catch {} }
    state.wsReady = false;
    // 主动收摊也要通知界面：指示灯和发送按钮不能停在「已连接」。
    if (wasReady) onReadyChange(false);
    // 主动收摊不是故障：让调用方把「正在重连」的提示一起收掉。
    emitStatus('closed');
  }

  /**
   * 报一次「连接能力不可用」。状态已由 connect 收干净（旧连接、就绪位都掉了），
   * 这里只通报。不排重连：重试只会重复同一个失败，而用户要的是一句说得清的话
   * （更新内核、稍后重开页面），不是一条永远在闪的细条。
   */
  function reportUnavailable(reason, error) {
    emitStatus('closed');
    onUnavailable(reason, error);
  }

  function connect() {
    cancelReconnect();
    const myGeneration = ++generation;
    // 新连接还没 open：从「已就绪」换成连接中时必须先把状态和界面收回来，
    // 否则旧连接已经关掉，页面还亮着灯、发送按钮还能点。
    const wasReady = Boolean(state.wsReady);
    state.wsReady = false;
    if (wasReady) onReadyChange(false);
    // 先摘旧引用再关：旧连接的 close 回调会因代次不符直接返回，
    // 不会把 wsReady 打回 false，也不会再排一次重连。
    const previous = state.ws;
    state.ws = null;
    if (previous) { try { previous.close(); } catch {} }

    const loc = getLocation();
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    const Impl = getWebSocket();
    // 老 WebView 没有 WebSocket：调用方是 openSession / 重连定时器 / 前台恢复，
    // 没有一个 catch，`new undefined` 会变成白屏级的未捕获错误。
    if (typeof Impl !== 'function') {
      reportUnavailable('unsupported');
      return;
    }
    let ws;
    try {
      ws = new Impl(`${proto}://${loc.host}/ws`);
    } catch (err) {
      // 构造器当场炸（内核损坏、地址被安全策略拒）：同样不能抛给上面那些没 catch 的调用方。
      reportUnavailable('constructor', err);
      return;
    }
    state.ws = ws;
    const isCurrent = () => myGeneration === generation && state.ws === ws;

    ws.addEventListener('open', () => {
      if (!isCurrent()) return;
      state.wsReady = true;
      state.reconnectDelay = DEFAULT_RECONNECT_DELAY;
      onReadyChange(true);
      emitStatus('connected');
      // 断线期间点的「停止」在这里补发：先 abort 再谈续流，
      // 否则 resume_stream 会把用户要停的那一轮重新拉回来。
      const aborted = flushPendingAbort();
      claimAttention();
      requestContextUsage();
      if (!aborted) resumeStream();
      onOpen({ aborted });
    });

    ws.addEventListener('message', (ev) => {
      if (!isCurrent()) return;
      const data = parseSocketPayload(ev.data);
      if (!data) return;
      debug('R←', data);
      onMessage(data);
    });

    ws.addEventListener('close', () => {
      if (!isCurrent()) return;
      state.ws = null;
      state.wsReady = false;
      onReadyChange(false);
      const delay = state.reconnectDelay;
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, MAX_RECONNECT_DELAY);
      const willReconnect = Boolean(shouldReconnect());
      if (willReconnect) scheduleReconnect(delay);
      // 会重连才是「断开重连中」；不会重连说明业务已收摊，别让界面报假故障。
      emitStatus(willReconnect ? 'reconnecting' : 'closed');
    });

    ws.addEventListener('error', () => {
      if (!isCurrent()) return;
      onError();
    });

    emitStatus('connecting');
  }

  function send(frame) {
    if (!isOpen()) return false;
    state.ws.send(JSON.stringify(frame));
    debug('S→', frame);
    return true;
  }

  /**
   * 等连接就绪。
   *
   * 新建会话会重连 WS，这期间 wsReady 是 false。直接 return 的话消息就这样静静消失
   * （输入框已经清空、用户消息已经画上去了）。这里等一会儿，超时交回给调用方决定。
   *
   * shouldCancel 给「等到一半就不该再等」用（切会话 / 退回列表）：单飞锁在调用方的
   * finally 里，晚一轮返回就多锁 60ms，最坏锁满整个 timeoutMs，用户看到的是发送键
   * 灰着点不动。
   */
  function waitForReady(timeoutMs = 4000, shouldCancel = null) {
    if (isReady()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (shouldCancel && shouldCancel()) { resolve(false); return; }
        if (isReady()) { resolve(true); return; }
        if (performance.now() - started > timeoutMs) { resolve(false); return; }
        setTimeout(tick, 60);
      };
      tick();
    });
  }

  /** 告诉服务端「这个会话在前台」，用于推送路由。 */
  function claimAttention() {
    const session = getSession();
    if (!session) return false;
    return send({
      type: 'client_attention',
      surface: 'hana.client.mobile',
      state: 'foreground',
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session.path ? { sessionPath: session.path } : {}),
    });
  }

  function requestContextUsage() {
    const session = getSession();
    if (!session?.path) return false;
    return send({ type: 'context_usage', sessionPath: session.path });
  }

  function resumeStream() {
    const session = getSession();
    if (!session?.path) return false;
    const cursor = getResumeFields() || {};
    return send({
      type: 'resume_stream',
      sessionPath: session.path,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      streamId: cursor.streamId || null,
      sinceSeq: cursor.sinceSeq,
    });
  }

  /**
   * 把断线期间排队的 abort 补发出去。
   * @returns {boolean} 这次是否真的发出去了（发出去才收本地的生成态）
   */
  function flushPendingAbort() {
    const pending = aborts.peek();
    if (!pending) return false;
    const session = getSession();
    // 会话已经换了或退了：那一轮不属于现在的界面，排队作废。
    if (!session || session.path !== pending.sessionPath) {
      aborts.take();
      return false;
    }
    const frame = makeAbortFrame(pending);
    if (!frame || !send(frame)) return false;   // 还是发不出去，继续排队
    aborts.take();
    onAbortFlushed();
    return true;
  }

  return {
    connect,
    drop,
    cancelReconnect,
    scheduleReconnect,
    send,
    waitForReady,
    isReady,
    claimAttention,
    requestContextUsage,
    resumeStream,
    // 队列实例对外露一手：composer 装配时没单独注入时拿这个，保证
    // 「写的那个」和「补发的这个」是同一个，不会各存各的。
    abortQueue: aborts,
    flushPendingAbort,
  };
}
