/* web/event-router.js — 把一条宿主事件分派到界面
 *
 * handleEvent 是整条实时链路的唯一入口：先按会话过滤，再交给流式游标去重，
 * 然后按事件类型落到「渲染 / 卡片 / 历史重拉 / 上下文用量」这几个分支上。
 *
 * 单独成模块的理由：这里的每个分支都对应一种「线上才会出现」的事件形状
 * （card_host_confirm、stage_files 的 file 块、session_output_receipt_required…），
 * 挤在 app.js 里既难读也难改。模块只做分派，具体画法都交给 renderer。
 *
 * 三个必须守住的顺序：
 *  - app_event/card-data-changed 没有 session 字段，必须在会话过滤之前拦截；
 *  - 普通事件先 streamState.observe 再分派（done/turn_end 也算普通事件）；
 *  - stream_resume 的每条内嵌事件要先过会话过滤，再推进游标，再递归分派。
 */

import { splitUserContent, imagesFromAttachments } from './attach.js';
import { parseReferenceBlocks } from './reference-block.js';
import { belongsToSession, unwrapReplayEvent } from './protocol.js';
import { fileUrlFor, resourceContentUrl } from './file-urls.js';

/** 消息里引用的会话文件（sf_…）→ 资源内容地址。 */
const resourceUrl = resourceContentUrl;

/**
 * 前台恢复对账窗口的默认时长。
 *
 * 取值理由：
 *  - 太短（<1.5s）：真机上 resume_stream 的回包要经过一次 WebSocket 往返 +
 *    宿主读缓存，隔隧道的场景实测 200~900ms，慢的时候接近 1.5s；窗口赶在回包
 *    之前到期，就会在「回放马上就到」的情况下多发一次历史 GET。
 *  - 太长（>2.5s）：这条对账本来就是「没人理它才动手」，窗口越长，用户盯着
 *    半截回复干等的时间越长；而这段时间屏幕是完全静止的。
 *  - 2s 留出了一次心跳（1s）的余量，足够让正常的回放/事件先到，又不会让人明显
 *    感觉到「卡了一下才补上」。
 */
const DEFAULT_IDLE_RECONCILE_WINDOW_MS = 2000;

/**
 * 不构成「流还活着」的记账类事件。
 *
 * context_usage 是连接 open 后我们自己要的上下文用量，notification / interlude /
 * 去重回执也都是旁路告知：它们来了不代表这一轮在生成，不能用来取消对账窗口，
 * 否则「回放为空、只回了 context_usage」这种真机形状会永远收不了尾。
 * 除此之外的任何会话事件（正文/思考/工具/状态/回放/结束）都算「有动静」。
 */
const RECONCILE_NEUTRAL_EVENTS = new Set([
  'context_usage', 'notification', 'interlude', 'client_message_deduplicated',
]);

/**
 * @param {object} options
 * @param {object} options.state 共享状态对象
 * @param {(id: string) => Element|null} options.getElement
 * @param {object} options.renderer chat-renderer 实例
 * @param {object} options.sockets websocket-client 实例
 * @param {object|null} options.cardBridge 卡片桥（可能还没建）
 * @param {object} options.streamState 流式游标
 * @param {(msg: string) => void} options.flash
 * @param {(busy: boolean) => void} options.setBusy
 * @param {() => void|Promise<void>} options.loadSessions
 * @param {() => Promise<void>} options.loadHistory
 * @param {(folder: string) => string} options.chatSubtitle
 * @param {((ev: object) => boolean)|null} [options.handleSubagentEvent]
 *   子代理（分身）的实时事件，装配时注入 subagent-view.js 的 handleEvent。
 *   路由只负责「把事件送到」，画法与状态都在被注入的模块里（相互不 import）。
 * @param {((info: object) => void)|null} [options.onTurnEnd]
 *   一轮回复结束的旁路通知（手机通知之类），装配时注入 notifications.onTurnEnd。
 *   info 只放客观事实：{ sessionId, sessionPath, streamId, aborted, truncated,
 *   stopReason, seq, type }——宿主不给标题、正文和 failed，文案由消费方自己定。
 *   不传就完全不影响现有行为；它抛错只记日志，不能把收尾搞断。
 * @param {(() => void)|null} [options.onSessionIdle]
 *   宿主确认「当前会话已经空闲」的旁路通知（整轮收尾，或没有活动轮但运行态已停）。
 *   与 onTurnEnd 分工：这里只表示可以对齐历史了，不依赖某个具体的结束事件，也不依赖
 *   state.turn 是否存在。装配层用它补历史；重复触发由消费方防抖合并。它抛错只记日志。
 * @param {((ev: object) => void)|null} [options.onFeedChanged]
 *   全局日报变更广播；必须先于无会话/归属过滤转发，不改变聊天流状态。
 * @param {((info: object) => void)|null} [options.onIdleReconcile]
 *   前台恢复对账窗口到期时的旁路通知（窗口内一条事件都没收到、当前会话还在 busy）。
 *   装配层在这里绕过一次 history-pager 的 busy 门禁取最新一页，再自己判断要不要收尾；
 *   info.activityToken 是窗口到期时的事件计数，取历史期间又有事件进来就必须放弃。
 *   它抛错只记日志，不影响连接与渲染。
 * @param {number} [options.idleReconcileWindowMs] 对账窗口时长（默认 2000ms，理由见常量注释）
 * @param {boolean} [options.debug]
 */
export function createEventRouter({
  state,
  getElement,
  renderer,
  sockets,
  cardBridge = null,
  streamState,
  flash,
  setBusy,
  loadSessions,
  loadHistory,
  chatSubtitle,
  handleSubagentEvent = null,
  onTurnEnd = null,
  onSessionIdle = null,
  onFeedChanged = null,
  onIdleReconcile = null,
  idleReconcileWindowMs = DEFAULT_IDLE_RECONCILE_WINDOW_MS,
  debug = false,
} = {}) {
  if (!state) throw new TypeError('createEventRouter requires { state }');

  /**
   * 断线回放的嵌套层数。回放里的历史事件不应当成「刚发出去」：
   * 否则重连一次就会凭空多出一个「正在思考」。
   */
  let replayDepth = 0;

  /**
   * 「对方已经有反应了」的事件：占位块（chat-renderer.showPending）该收掉。
   *
   * 用白名单而不是黑名单：将来宿主新加的事件默认不动占位块，
   * 宁可他多留一会儿（反正有 30 秒防呆兜底），也不误清。
   */
  const ANSWER_EVENTS = new Set([
    // 正文 / 思考 / mood
    'content_block', 'block_update',
    'text_delta', 'assistant_delta', 'text',
    'thinking_start', 'thinking_delta', 'thinking', 'thinking_end',
    'mood_start', 'mood_text', 'mood_end',
    // 工具
    'tool_start', 'tool_call', 'tool_end', 'tool_result',
    // 卡片
    'card_host_confirm', 'card_host_confirmation',
    'interactive_card', 'interactive_card_pending', 'show_card',
    'plugin_card', 'mcp_app_card', 'suggestion_card', 'interactive_artifact',
    // 收尾与出错
    'stream_turn_end', 'turn_end', 'done', 'complete',
    'error',
  ]);

  /** 收占位块。renderer.clearPending 是它的必备导出（见 tests/mood_event 的静态网）。 */
  function dropPending() {
    renderer.clearPending?.();
  }

  /** 挂占位块。回放中的用户消息不算（那是历史，不是刚发出去）。 */
  function raisePending() {
    if (replayDepth > 0) return;
    renderer.showPending?.();
  }

  /**
   * 回合结束的摘要。
   *
   * stream_turn_end 自己不加修饰地就是权威信号，但它没有 title / 正文，也没有 failed：
   * 失败只能靠此前是否收到过 error 来推断，所以这里只抄客观字段，不做判断。
   * 会话字段缺省时用当前会话补，方便消费方拼「同一会话同一轮」的指纹。
   */
  function turnEndInfo(ev) {
    return {
      type: ev.type,
      sessionId: typeof ev.sessionId === 'string' ? ev.sessionId : (state.session?.sessionId || null),
      sessionPath: typeof ev.sessionPath === 'string' ? ev.sessionPath : (state.session?.path || null),
      streamId: typeof ev.streamId === 'string' ? ev.streamId : null,
      aborted: ev.aborted === true,
      // 被长度上限截断时宿主只给 stopReason:"length"，两者都认。
      truncated: ev.truncated === true || ev.stopReason === 'length',
      stopReason: typeof ev.stopReason === 'string' ? ev.stopReason : null,
      seq: typeof ev.seq === 'number' ? ev.seq : null,
    };
  }

  /**
   * 最后一段流的收尾信息（streamId / aborted / truncated / stopReason）。
   *
   * 这些字段只在 stream_turn_end 上，而整轮结束信号是 session_status{isStreaming:false}。
   * 所以分段时先存着，整轮收尾时再交给通知——否则「被截断」「被中断」这两条文案就丢了。
   */
  let lastSegmentEnd = null;

  /**
   * 上一条 status 是不是 isStreaming:true。
   *
   * 同一次回复里 status{isStreaming:true} 会重复到达（分段、重放都会再发一遍），
   * 直接「见 true 就先收旧轮」会把一条回复撕成好几条气泡，所以用它去重。
   */
  let lastStatusWasStreaming = false;

  /* ------------------------------------------------------------------ */
  /* 前台恢复对账（foreground idle reconcile）                             */
  /* ------------------------------------------------------------------ */

  /**
   * 本会话收到过多少个事件（只看条数，不看内容）。
   *
   * 两个用途：
   *  - 每条会话事件让它 +1，同时把对账窗口 clear 掉——「窗口内有没有动静」就是靠这个；
   *  - 取历史是异步的：窗口到期时把这个数字交给装配层，取完再比一次（completeIdleReconcile），
   *    涨了就说明流还活着，必须放弃收尾。
   */
  let sessionEventCount = 0;

  /** 待到期的对账窗口：timer + 开户时的归属。同一时刻最多一个。 */
  let reconcileTimer = null;
  let reconcileSession = null;

  /** 作废对账窗口（进后台、切会话、或窗口内真的来了事件）。不碰 busy 与渲染。 */
  function cancelIdleReconcile() {
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    reconcileSession = null;
  }

  /**
   * 前台恢复后开一个对账窗口。
   *
   * 只有一个来源：mobile-lifecycle 的「回到前台 → 强制重连」那一次。开窗时先作废旧窗口，
   * 所以同一次前台恢复不会排两个；窗口到期自己就没了，不会再排第二次（只有下一次真的
   * 回到前台才会重新开）。正常前台使用、切会话、发送消息都不会走到这里。
   *
   * 到期时三个条件全满足才请装配层放行一次历史补拉：归属没换、当前仍在 busy、
   * 且这一窗口内一条会话事件都没收到（后者由 handleEvent 收到事件就 clear 这个 timer
   * 保证）。任何一个不满足就什么都不做（保持现有行为）。
   */
  function beginIdleReconcile() {
    cancelIdleReconcile();
    const session = state.session;
    if (!session) return false;
    reconcileSession = session;
    const windowMs = Number.isFinite(idleReconcileWindowMs) && idleReconcileWindowMs > 0
      ? idleReconcileWindowMs
      : DEFAULT_IDLE_RECONCILE_WINDOW_MS;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      const armedFor = reconcileSession;
      reconcileSession = null;
      // 排队期间换了会话 / 退出登录：这次窗口属于旧归属，作废。
      if (!armedFor || armedFor !== state.session) return;
      // 已经不忙：不需要对账（正常前台使用、切会话都会走到这里）。
      if (!state.busy) return;
      // 「窗口内没有新事件」由 handleEvent 的事件计数 + 取消来保证：只要有会话事件
      // 进来，这个 timer 早就被 clear 掉了，走不到这里。
      if (typeof onIdleReconcile !== 'function') return;
      try {
        onIdleReconcile({ activityToken: sessionEventCount });
      } catch (err) {
        console.error('[app] onIdleReconcile error:', err);
      }
    }, windowMs);
    return true;
  }

  /**
   * 对账确认「这一轮其实已经跑完」之后的收尾。
   *
   * token 是窗口到期时的事件计数：取历史期间只要又来了一条事件（流还活着，只是回复
   * 还没落地），就必须放弃收尾并返回 false——屏幕、busy、游标一律不动。
   *
   * 收尾本身沿用既有路径（endTurn / finishIdleWithoutTurn），只关掉结束通知与历史旁路：
   * 完整历史就是这次对账刚刚取回来的那一份，不需要再补一次。
   */
  function completeIdleReconcile(token) {
    if (typeof token === 'number' && token !== sessionEventCount) return false;
    if (state.turn) endTurn({ type: 'foreground_reconcile' }, { announce: false });
    else finishIdleWithoutTurn({ announce: false });
    return true;
  }

  /** 收尾一整轮：通知 → 渲染器收尾 → 刷新上下文用量 → 重置游标。
   *
   * announce=false 只给「前台恢复对账」用：宿主没发结束事件，是历史证明这一轮跑完了，
   * 这时不该再弹结束通知，也不该再排一次历史补拉（历史刚被对账自己取回来）。
   */
  function endTurn(ev, { idle = true, announce = true } = {}) {
    // 旁路通知（手机通知）放在收尾之前：这一刻「刚跑完」的信息还在事件里。
    if (announce && typeof onTurnEnd === 'function') {
      const info = lastSegmentEnd || turnEndInfo(ev);
      try {
        onTurnEnd(info);
      } catch (err) {
        console.error('[app] onTurnEnd error:', err);
      }
    }
    lastSegmentEnd = null;
    lastStatusWasStreaming = false;
    renderer.markTurnEnd();
    renderer.finishTurn();
    sockets.requestContextUsage();
    streamState.reset();
    // 本地收尾已完成，宿主也说这一轮结束了：对齐历史的旁路走这里。
    // 被新一段流顶掉旧轮（idle:false）不算「会话空闲」，不能在这里补历史。
    if (announce && idle) notifySessionIdle();
  }

  /**
   * 宿主说会话已经空闲，但本地没有活动轮。
   *
   * 典型：等待首字时只收到 status:false；或恢复帧 runtimeIsStreaming:false、events 为空。
   * 这时没有 finishTurn 可走，但残留的流式标记、占位块、busy 都必须收干净，
   * 而且完整回复只能靠历史补回来——所以照样触发 idle 旁路。
   */
  function finishIdleWithoutTurn({ announce = true } = {}) {
    renderer.endStaleStreamingTurns?.();
    dropPending();
    // 与 endTurn 的收尾边界一致：旧段的结束元数据、true/false 锁存和流游标
    // 都属于上一轮，不能留给下一轮（否则旧段的 aborted 会把新轮通知压成
    // skipped-aborted，旧 streamId 还会被下一次 abort/resume 带上）。
    lastSegmentEnd = null;
    lastStatusWasStreaming = false;
    setBusy(false);
    streamState.reset();
    // announce=false 是前台对账：历史已经由对账自己上屏，不再排第二次补拉。
    if (announce) notifySessionIdle();
  }

  /** 权威空闲旁路：装配层用来对齐历史。它抛错只记日志，不能把收尾搞断。 */
  function notifySessionIdle() {
    if (typeof onSessionIdle !== 'function') return;
    try {
      onSessionIdle();
    } catch (err) {
      console.error('[app] onSessionIdle error:', err);
    }
  }

  /**
   * stream_resume 回放结束后的外层当前运行态。
   *
   * 宿主同一帧里有两个字段：
   *  - isStreaming：缓存下来的流快照，可能已经过期（正在生成时也可能报 false）；
   *  - runtimeIsStreaming：当前运行态，布尔值。只有 false 才是权威的「已经空闲」。
   *
   * 因此只认 runtimeIsStreaming：true 时这一轮还在生成，回放里与本状态冲突的整轮
   * 终态已经在回放时分流（只推进游标），这里必须把「正在生成」补回去：初始 idle
   * 的客户端不能停在 busy=false，否则随后的历史补拉会把正在生成的内容整页替换。
   * false 时本轮还在（有 state.turn）就正常整轮收尾，没有本轮就只清残留与 busy。
   * 两种都调度历史——恢复帧的 events 可以是空的，完整回复只能靠历史补回来。
   * 缺字段或非布尔时绝不推断完成，交回既有事件处理。
   */
  function applyResumeRuntimeState(ev) {
    if (typeof ev.runtimeIsStreaming !== 'boolean') return;
    if (ev.runtimeIsStreaming) {
      lastStatusWasStreaming = true;
      setBusy(true);
      return;
    }
    if (state.turn) {
      endTurn(ev);
      return;
    }
    finishIdleWithoutTurn();
  }

  /**
   * 整轮终态（不是段结束）：status / session_status 的 false，以及 turn_end/done/complete。
   * 只用于「同帧回放 + 外层 runtimeIsStreaming:true」的冲突分流；
   * stream_turn_end 只是分段结束，文本/工具/合法新状态也都照常分派。
   */
  function isWholeTurnTerminal(ev) {
    if (ev.type === 'status' || ev.type === 'session_status') return ev.isStreaming === false;
    return ev.type === 'turn_end' || ev.type === 'done' || ev.type === 'complete';
  }

  /**
   * 这条事件能不能当作「流还活着 / 有权威运行态」的证据。
   *
   * 默认任何会话事件都算。两个例外：
   *  - 记账类事件（用量/通知/插曲/去重回执）不算；
   *  - stream_resume 只有带了内嵌事件、或者带了 boolean 的 runtimeIsStreaming 才算。
   *    空回放且不带运行态正是「宿主什么都没说」：本地 busy 靠它永远清不掉，前台对账
   *    就是要等这个窗口过去再自己去拿历史对照。带了 false 的旧路径已经会收尾，
   *    带了 true 则说明还在生成，两者都不需要对账插手。
   */
  function isReconcileActivity(ev, type) {
    if (RECONCILE_NEUTRAL_EVENTS.has(type)) return false;
    if (type === 'stream_resume') {
      return (Array.isArray(ev.events) && ev.events.length > 0)
        || typeof ev.runtimeIsStreaming === 'boolean';
    }
    return true;
  }

  /**
   * 事件入口：先按会话过滤，再交给流式游标。
   * 普通事件（含 done/turn_end）只在这里 observe；stream_resume 自己走回放游标。
   *
   * replayRuntimeStreaming 只由 stream_resume 的逐条回放传入：外层当前运行态是
   * runtimeIsStreaming:true 时，回放里与本状态冲突的整轮终态只推进游标、不分派。
   */
  function handleEvent(ev, { replayRuntimeStreaming = false } = {}) {
    if (!ev || typeof ev !== 'object') return;

    // 全局卡片数据变更广播：由宿主 server 广播，无 session 字段，
    // 必须在 belongsToSession 过滤前拦截分发并 return，绝不普遍放宽其它会话事件
    if (ev.type === 'app_event' && ev.event?.type === 'card-data-changed') {
      if (cardBridge && typeof cardBridge.handleHostDataChanged === 'function') {
        try {
          cardBridge.handleHostDataChanged(ev);
        } catch (err) {
          console.error('[app] handleHostDataChanged error:', err);
        }
      }
      return;
    }

    // 日报广播是全局 app_event：即使当前没有聊天 session 也必须先交给日报特性，
    // 之后直接返回，避免它改变聊天 busy、通知或流式游标。
    if (ev.type === 'app_event' && ev.event?.type === 'feed-changed') {
      if (typeof onFeedChanged === 'function') {
        try {
          onFeedChanged(ev);
        } catch (err) {
          console.error('[app] onFeedChanged error:', err);
        }
      }
      return;
    }

    if (!belongsToSession(ev, state.session)) return;
    const type = ev.type;

    // 只要还有会话事件进来，就说明流还活着（或宿主有权威状态要告诉我们）：
    // 前台对账窗口立刻作废。记账类事件除外（见 RECONCILE_NEUTRAL_EVENTS）；
    // 空回放也算「宿主自证没有新事件」，不取消（那正是对账要处理的情形）。
    if (isReconcileActivity(ev, type)) {
      sessionEventCount += 1;
      if (reconcileTimer) cancelIdleReconcile();
    }

    // 同帧回放与外层当前运行态冲突：runtimeIsStreaming:true 说明这一轮还在生成，
    // 回放里的整轮终态只可能是缓存里的旧状态。序号已经由 acceptReplay 推进，这里
    // 只做过滤，不执行收尾、通知或 idle 副作用（也不能先 finishTurn 再补 busy）。
    if (replayRuntimeStreaming && isWholeTurnTerminal(ev)) return;

    // 普通事件（包括 done/turn_end）的唯一游标入口；stream_resume 自己走回放游标。
    if (type !== 'stream_resume') streamState.observe(ev);

    // E4：助手侧一有反应就把「正在思考」占位块收掉。
    // 只在这里多一次调用，下面任何分支的顺序与副作用都不变。
    if (ANSWER_EVENTS.has(type)) dropPending();

    switch (type) {
      case 'content_block': {
        if (ev.block?.type === 'card_host_confirm' || ev.block?.type === 'card_host_confirmation') {
          if (cardBridge && typeof cardBridge.handleHostConfirmation === 'function') {
            cardBridge.handleHostConfirmation(ev).catch((err) => flash('卡片确认异常: ' + (err.message || String(err))));
          }
          return;
        }
        // 子代理（分身）：宿主在 subagent 工具出结果时把块投影成 content_block 推过来。
        // 以前这里没有分支，块会一路 break 到底、整条消息被吞掉——手机上什么都不显示。
        // 画法在注入的 handleSubagentEvent 里（subagent-view.js），这里不 import 它。
        if (ev.block?.type === 'subagent') {
          if (typeof handleSubagentEvent === 'function') handleSubagentEvent(ev);
          return;
        }
        // 实时链路：stage_files 成功后宿主会推一个 file 块（历史里没有，只有 details.files）
        if (ev.block?.type === 'file') {
          renderer.appendFileCards([ev.block]);
          return;
        }
        break;
      }
      case 'block_update': {
        // 分身的状态补丁：{ taskId, patch: { streamStatus, summary, streamKey, sessionId, agentName } }。
        // 宿主的 subagent-tool 与 workflow-tool 都发这一种，路由分不清谁来处理，
        // 原样交给注入的句柄：它按 taskId 认领，不认识的补丁自己会无视。
        if (typeof handleSubagentEvent === 'function') handleSubagentEvent(ev);
        return;
      }
      case 'card_host_confirm':
      case 'card_host_confirmation': {
        if (cardBridge && typeof cardBridge.handleHostConfirmation === 'function') {
          cardBridge.handleHostConfirmation(ev).catch((err) => flash('卡片确认异常: ' + (err.message || String(err))));
        }
        return;
      }
      case 'session_user_message': {
        let msgText = ev.message?.text ?? ev.text ?? '';
        const id = typeof ev.inputId === 'string' && ev.inputId
          ? ev.inputId
          : (typeof ev.clientMessageId === 'string' ? ev.clientMessageId : '');
        if (id && state.sentInputs.has(id)) {
          state.sentInputs.delete(id);
          // 自己发的消息会被这条回显吞掉（气泡在发送成功那一刻已经乐观画好了），
          // 但恰恰就是这种「刚发出去」的时刻最需要占位块：模型还没吐字。
          raisePending();
          return;
        }
        if (!id && state.lastLocalUser && state.lastLocalUser.text === msgText && Date.now() - state.lastLocalUser.at < 5000) {
          raisePending();
          return;
        }
        const parsed = splitUserContent(ev.message?.content ?? '', { fileUrl: fileUrlFor, resourceUrl });
        let files = parsed.files;
        let references = parsed.references || [];
        // displayMessage 里的文本如果是原样带下来的，标记也要一并抽掉
        if (msgText && (msgText.includes('[SessionFile]') || msgText.includes('[hana_reference]'))) {
          const extra = splitUserContent(msgText, { fileUrl: fileUrlFor, resourceUrl });
          msgText = extra.text;
          files = files.concat(extra.files);
          // 引用块可能只存在于 displayMessage 里，两条路都要收，否则实时消息会丢引用
          references = references.concat(extra.references || []);
        }
        const inline = parsed.images;
        const images = inline.length
          ? inline
          : imagesFromAttachments(ev.message?.attachments, { fileUrl: fileUrlFor });
        if (msgText || images.length || files.length || references.length) {
          renderer.appendUser(msgText, images, files, Date.now(), references);
        }
        // 用户消息画完（或者本来就没东西可画）才挂占位块：顺序反过来会挂在气泡上面
        raisePending();
        return;
      }
      case 'text_delta':
      case 'assistant_delta':
      case 'text': {
        const d = ev.delta ?? ev.text ?? ev.value ?? '';
        if (!d) return;
        setBusy(true);
        if (!state.turn) renderer.startAssistantTurn();
        renderer.markFirstToken();
        state.charCount += String(d).length;
        renderer.addAssistantText(d);
        return;
      }
      case 'thinking_start':
        if (!state.turn) renderer.startAssistantTurn();
        return;
      case 'thinking_delta':
      case 'thinking': {
        const d = ev.delta ?? ev.text ?? ev.value ?? '';
        if (!d) return;
        if (!state.turn) renderer.startAssistantTurn();
        renderer.addThinking(d);
        return;
      }
      case 'thinking_end':
        if (state.turnMeta) renderer.paintMeta(state.turnMeta);
        return;
      case 'mood_start':
        renderer.ensureMoodEl();
        return;
      case 'mood_text': {
        const d = ev.delta ?? ev.text ?? '';
        if (d) renderer.appendMood(d);
        return;
      }
      case 'mood_end':
        state.moodEl = null;
        state.moodRaw = '';
        return;
      case 'tool_start':
      case 'tool_call': {
        if (!state.turn) renderer.startAssistantTurn();
        const callId = ev.toolCallId || ev.id;
        // args 是宿主白名单里的对象（command / file_path / url …），只用来把这一行写成
        // 「正在改 web/app.js」这样的人话。老形状把它叫 input；两者都没有就当空。
        const args = ev.args ?? ev.input ?? null;
        renderer.addTool(ev.toolName || ev.name || ev.tool?.name || 'tool', state.turn, '运行中', callId, args);
        setBusy(true);
        return;
      }
      case 'tool_end':
      case 'tool_result': {
        if (ev.name === 'show_card' || ev.toolName === 'show_card') {
          renderer.appendCard(ev);
        }
        // 行的匹配与「完成/失败」文案由渲染器统一处理（经典/沉静两种视图都要收尾），
        // 这里只负责把宿主的事件形状化简成 (callId, ok) 外加两个原始判据。
        // success/status 单独传：宿主有时只说 success:false、既不报 error 也不改 status，
        // 只靠 ok 会把一次失败画成完成。
        const callId = ev.toolCallId || ev.id;
        const ok = !(ev.error || ev.status === 'failed' || ev.status === 'error');
        const meta = {
          success: typeof ev.success === 'boolean' ? ev.success : undefined,
          status: typeof ev.status === 'string' ? ev.status : null,
        };
        renderer.finishTool(callId, ok, meta);
        return;
      }
      case 'stream_turn_end': {
        // 一段流结束 ≠ 一轮回复结束。
        // 实测（2026-11-05 手机 logcat）：宿主在**每个工具回合**后都发一次
        // stream_turn_end，一轮回复可能有好几次。以前在这里收尾，于是每个工具
        // 回合都开一条新气泡、计数永远停在「1 次思考 · 1 项操作」。
        renderer.endSegment?.();
        // 记住这一段的收尾信息：整轮结束时通知要用（截断/中断只在段上有）
        lastSegmentEnd = turnEndInfo(ev);
        return;
      }
      case 'status': {
        // 线上真实的整轮起止信号就是这个类型（2026-11-05 手机 logcat 实测）：
        // { type:'status', isStreaming, sessionPath, streamId, aborted?, reason? }。
        // 以前只认 session_status，于是 isStreaming:false 落进 default 被丢掉：
        // 一轮永远结束不了 → 按钮卡在「停止」、摘要永远「正在进行」。
        if (ev.isStreaming === false) {
          // 有活轮才走完整收尾（通知 + 渲染器收尾）；没活轮就只把输入区放回可发送，
          // 顺手把历史里残留的 streaming 标记收掉（比如生成中途重载了 App）。
          // 两种情况都说明宿主已空闲：历史必须在这之后补一次（等待首字时也没有 state.turn）。
          if (state.turn) endTurn(ev);
          else finishIdleWithoutTurn();
          lastStatusWasStreaming = false;
          return;
        }
        if (ev.isStreaming === true) {
          // 同一次回复里 isStreaming:true 会重复到达（segments/重放），
          // 只有「上一次不是 true」才当成新的一轮开头，否则会把一条回复撕成多条气泡。
          if (state.turn && !lastStatusWasStreaming) endTurn(ev, { idle: false });
          lastStatusWasStreaming = true;
          setBusy(true);
        }
        return;
      }
      case 'session_status': {
        // 整轮的真正起止信号：isStreaming true 开、false 收。
        if (ev.isStreaming === false) {
          endTurn(ev);
          return;
        }
        if (ev.isStreaming === true) {
          // 上一条流没收尾就开了新流（宿主没发 false、或上一轮中断）：先把旧的收了，
          // 否则两轮会并成一条气泡，计数与「正在进行」都会串。
          if (state.turn) endTurn(ev, { idle: false });
          setBusy(true);
        }
        return;
      }
      case 'turn_end':
      case 'done':
      case 'complete': {
        endTurn(ev);
        return;
      }
      case 'stream_resume': {
        streamState.beginReplay(ev);
        const events = Array.isArray(ev.events) ? ev.events : [];
        // 外层当前运行态；只有严格的 true 才进入冲突分流。缺字段/非布尔走原处理。
        const replayRuntimeStreaming = ev.runtimeIsStreaming === true;
        replayDepth += 1;
        try {
          for (const item of events) {
            const unwrapped = unwrapReplayEvent(item, ev);
            if (!unwrapped) continue;
            // 会话过滤必须先于游标推进：别让别的会话的高 seq 把本会话后续事件挡掉
            if (!belongsToSession(unwrapped.event, state.session)) continue;
            // 逐条接受、逐条递归处理：不预先整批推进游标
            if (!streamState.acceptReplay(unwrapped.seq)) continue;
            handleEvent(unwrapped.event, { replayRuntimeStreaming });
          }
        } finally {
          replayDepth -= 1;
        }
        // 先回放、再采外层运行态：回放里的内容可能已经把这一轮画完，
        // 但「现在还在不在生成」只能看外层这一帧的当前运行态。
        applyResumeRuntimeState(ev);
        return;
      }
      case 'session_created':
        loadSessions();
        return;
      case 'interactive_card':
      case 'interactive_card_pending':
      case 'show_card':
      case 'plugin_card':
      case 'mcp_app_card':
      case 'suggestion_card':
      case 'interactive_artifact':
        renderer.appendCard(ev);
        return;
      case 'context_usage': {
        // 老会话可能拿不到用量，服务端会发 percent: null。
        // 以前用 Number(null) 就变成 0，界面就硬写着「上下文 0%」。未知就是未知。
        if (ev.sessionPath && state.session?.path && ev.sessionPath !== state.session.path) return;
        const pct = ev.percent;
        state.ctxPct = typeof pct === 'number' && Number.isFinite(pct) ? Math.round(pct) : null;
        getElement('chatSub').textContent = chatSubtitle(state.session?.folder);
        return;
      }
      case 'notification':
      case 'interlude':
      case 'client_message_deduplicated':
        return;
      case 'error': {
        // Hana 1.5.48 起要求客户端同步「已完成输出的已读回执」，我们这套协议没这个字段，
        // 服务端会推 session_output_receipt_required 下来，叫客户端重新开一次会话。
        // 对我们而言只需要重拉一遍历史，不是错误——弹成红条只会让每次重连多一行英文。
        if (ev.code === 'session_output_receipt_required') {
          const now = Date.now();
          if (!state.busy && state.session?.path && now - (state.lastResyncAt || 0) > 8000) {
            state.lastResyncAt = now;
            loadHistory().catch(() => {});
          }
          return;
        }
        const msg = ev.message || ev.detail || ev.reason || ev.code || '出错了';
        renderer.appendSystem(String(msg), true);
        renderer.finishTurn();
        return;
      }
      default:
        if (debug) console.debug('[event]', type, ev);
    }
  }

  return {
    handleEvent,
    // 前台恢复对账：开窗口 / 作废 / 收尾（见各自的函数注释）。
    beginIdleReconcile,
    cancelIdleReconcile,
    completeIdleReconcile,
    /** 当前会话的事件计数：装配层用它确认「取历史期间没有新事件」。 */
    activityCount: () => sessionEventCount,
  };
}
