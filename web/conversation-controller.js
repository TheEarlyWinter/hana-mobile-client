/* web/conversation-controller.js — 会话的进出
 *
 * 管「进入一个会话 / 新建会话 / 重载历史 / 退回列表 / 退出登录后收尾」这一圈。
 * 导航代次（navEpoch）是这里唯一的所有者：所有异步流程（新建、首页发送）在 await
 * 之后都得来问一句「代次还是我出发时那个吗」。
 *
 * 几个容易重犯的坑，注释留在对应位置：
 *  - 新建会话的两个入口共用一把锁，两个按钮一起禁用；
 *  - 会话切换必须立刻清屏，原会话重载必须等数据到了再替换；
 *  - 历史请求慢、用户已经切走时，收尾不能再 connectWS，否则会掐断新会话的连接。
 */

import { createHistoryPager } from './history-pager.js';
import { createHistoryPaginationView } from './history-pagination-view.js';
import { createScrollMemory } from './scroll-memory.js';
import { sessionTitle } from './session-list-view.js';
// mood 块是渲染标记，不属于「回复正文」：对账比较正文前要先剥掉（纯函数，不碰 DOM）。
import { splitMoodBlock } from './protocol.js';

/**
 * @param {object} options
 * @param {object} options.state 共享状态对象
 * @param {Document} options.document
 * @param {(id: string) => Element|null} options.getElement
 * @param {Function} options.api 带鉴权的请求函数
 * @param {object} options.renderer chat-renderer 实例
 * @param {object} options.composer composer-controller 实例
 * @param {object} options.sockets websocket-client 实例
 * @param {object} options.streamState 流式游标
 * @param {object|null} options.cardController
 * @param {object|null} options.actionConfirmation
 * @param {object|null} options.workspaceView
 * @param {() => boolean} options.closeFilePreview
 * @param {(view: string) => void} options.show 视图切换
 * @param {(ns?: string) => Promise<void>} options.loadSessions
 * @param {(msg: string) => void} options.flash
 * @param {(s: object) => string} options.sessionFolder
 * @param {() => void} options.closeDrawer 打开/新建会话前把抽屉收起来
 * @param {(session: object) => void} [options.onSessionOpened] 会话已同步就位（历史还没到）时通知，
 *   给模型 chip 这类「一看会话就要刷新」的东西用
 * @param {() => void} [options.onTranscriptCleared] 消息区被整页清空时通知（切会话/重载），
 *   给子代理卡这类自己持有节点引用的视图做重置用
 * @param {object|null} [options.scrollMemory] 阅读位置记忆实例（测试注入；缺省自建）
 * @param {object|null} [options.scrollStorage] 自建记忆用的 storage（缺省 localStorage）
 * @param {number} [options.scrollMemoryMaxEntries=50] 记忆最多保留多少个会话
 */
export function createConversationController({
  state,
  document,
  getElement,
  api,
  renderer,
  composer,
  sockets,
  streamState,
  cardController = null,
  actionConfirmation = null,
  workspaceView = null,
  closeFilePreview,
  show,
  loadSessions,
  flash,
  sessionFolder,
  closeDrawer,
  onSessionOpened = () => {},
  onTranscriptCleared = null,
  scrollMemory: injectedScrollMemory = null,
  scrollStorage,
  scrollMemoryMaxEntries = 50,
} = {}) {
  if (!state) throw new TypeError('createConversationController requires { state }');

  /* ------------------------------------------------------------------ */
  /* 阅读位置记忆（E2）                                                */
  /* ------------------------------------------------------------------ */

  function defaultScrollStorage() {
    try {
      const storage = globalThis.localStorage;
      if (storage && typeof storage.getItem === 'function') return storage;
    } catch (err) {
      // 隐私模式 / 无来源的 iframe 读 localStorage 会直接抛：退化成仅内存。
    }
    return null;
  }

  const scrollMemory = injectedScrollMemory || createScrollMemory({
    storage: scrollStorage === undefined ? defaultScrollStorage() : scrollStorage,
    maxEntries: scrollMemoryMaxEntries,
  });

  /** 阅读位置用会话文件路径做键（列表里的 path 稳定；sessionId 可能为空）。 */
  function scrollKeyOf(session) {
    if (!session) return null;
    if (typeof session.path === 'string' && session.path.trim()) return session.path;
    if (typeof session.sessionId === 'string' && session.sessionId.trim()) return `id:${session.sessionId}`;
    return null;
  }

  function readTranscriptScroll() {
    const box = getElement('transcript');
    if (!box) return null;
    return {
      scrollTop: Number(box.scrollTop) || 0,
      scrollHeight: Number(box.scrollHeight) || 0,
      clientHeight: Number(box.clientHeight) || 0,
    };
  }

  /**
   * 把当前会话读到哪儿记下来。flush=true 用于离开/切走：不等节流窗口。
   * 屏上还没有任何历史（骨架屏 / 首屏失败）时不写：那时的 scrollTop=0 是清屏的结果，
   * 写进去会把用户上次真正的位置覆盖掉。
   */
  function rememberCurrentScroll({ flush = false } = {}) {
    if (!transcriptRendered) return;
    const key = scrollKeyOf(state.session);
    if (!key) return;
    const position = readTranscriptScroll();
    if (!position) return;
    scrollMemory.remember(key, position);
    if (flush) scrollMemory.flush();
  }

  // 滚动过程中持续更新（内存立即更新，写 storage 由 scroll-memory 自己节流）。
  {
    const box = getElement('transcript');
    if (box && typeof box.addEventListener === 'function') {
      box.addEventListener('scroll', () => rememberCurrentScroll(), { passive: true });
    }
  }

  // 打开会话时待恢复的阅读位置：只在「本次打开的首屏落地」那一次消费。
  let pendingScrollKey = null;

  // 用户导航代次：每次「打开会话 / 回到列表 / 退出登录」都递增。
  // 异步流程（新建会话、首页发送）在 await 之后核对它：代次变了说明用户已经自己导航过，
  // 流程必须放弃后面的「打开并发送」，不能把用户刚选中的会话顶掉。
  let navEpoch = 0;

  let newSessionToken = null;

  /** 新建会话的两个入口共用一把锁：锁着时两边一起禁用。 */
  function setNewSessionPending(pending) {
    for (const id of ['btnNew', 'btnNewChat']) {
      const btn = getElement(id);
      if (btn) btn.disabled = Boolean(pending);
    }
  }

  async function newSession(namespace = 'home', { cwd, thinkingLevel } = {}) {
    // 宿主只认 home / code（Bnt(body) 读到其它值直接 400），未知值在入口就收敷成 home。
    const ns = namespace === 'code' ? 'code' : 'home';
    // 宿主不会替 Code 会话挑目录（code_repository_required），没目录就不发这个注定失败的请求。
    const folder = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
    if (ns === 'code' && !folder) {
      flash('Code 会话需要一个项目目录：请重新选择目录后再建');
      return;
    }
    // 思考档位是会话级的：新建时不带就落回默认档，所以由装配层读好宿主当前档位再传进来。
    const level = typeof thinkingLevel === 'string' && thinkingLevel.trim() ? thinkingLevel.trim() : null;
    // 单飞：请求在途时再点（侧栏顶部按钮 / 抽屉里的按钮）直接忽略。
    if (newSessionToken) return;
    const owner = state.principal;
    const token = {};
    newSessionToken = token;
    setNewSessionPending(true);
    closeDrawer();
    // 导航代次快照：create 期间用户自己打开了别的会话，就不能再抢回来。
    const epoch = navEpoch;
    try {
      const body = {
        ...(state.currentAgent?.id ? { agentId: state.currentAgent.id } : {}),
        // 命名空间必须显式传：不传宿主一律建 Chat。
        namespace: ns,
      };
      if (ns === 'code') body.cwd = folder;
      if (level) body.thinkingLevel = level;
      const created = await api('/api/sessions/new', { method: 'POST', body: JSON.stringify(body) });
      // 身份已换：create 已经发生，但后续开旧会话/刷列表必须丢掉。
      if (state.principal !== owner || newSessionToken !== token) return;
      await loadSessions(ns);
      if (state.principal !== owner || newSessionToken !== token) return;
      // 用户已经在 create 期间自己导航（选了一个会话/退回列表）：不要拿新建的顶掉他。
      if (navEpoch !== epoch) return;
      await openSession({
        path: created?.path,
        sessionId: created?.sessionId,
        title: '新对话',
        namespace: ns,
        // 刚建的 Code 会话也要立刻知道自己属于哪个仓库，否则要回列表再进来才有目录。
        cwd: created?.cwd || folder || undefined,
        agentId: created?.agentId || state.currentAgent?.id,
        agentName: created?.agentName || state.currentAgent?.name || state.agentName,
      });
      if (state.principal !== owner) return;
    } catch (err) {
      if (state.principal === owner) flash('新建失败：' + err.message);
    } finally {
      // 旧 owner 只清自己的锁，不能解锁新身份的下一次新建。
      if (newSessionToken === token) {
        newSessionToken = null;
        setNewSessionPending(false);
      }
    }
  }


  /* ------------------------------------------------------------------ */

  async function openSession(s) {
    // 切走之前先把上一个会话读到哪儿记住：下面换成新会话后旧 DOM 会被清屏，读数就没了。
    rememberCurrentScroll({ flush: true });
    // 每次打开都是一次导航：异步流程靠这个号判断「用户是不是已经自己走了」。
    navEpoch += 1;
    const openEpoch = navEpoch;
    closeDrawer();
    state.session = {
      path: s.path,
      sessionId: s.sessionId || null,
      title: sessionTitle(s),
      folder: sessionFolder(s),
      agentName: s.agentName || s.agentId || null,
      agentId: s.agentId || null,
      // 会话自己的 namespace 跟着行数据走（缺省 Chat）；目录筛选只属于列表。
      namespace: s.namespace === 'code' ? 'code' : 'home',
      cwd: s.cwd,
      workspaceMountId: s.workspaceMountId,
      workspaceLabel: s.workspaceLabel,
    };
    state.ctxPct = null;
    // 记下本次打开归属的会话对象：慢历史收尾时如果用户已经切走，不能再碰别人的连接。
    const openedSession = state.session;
    // 首屏落地时如果记忆里有位置就恢复它，否则照旧贴底（见 renderHistoryPage）。
    pendingScrollKey = scrollKeyOf(openedSession);
    // 同步通知：会话对象已经就位，模型 chip 等可以立刻刷新，不用等历史加载。
    // 走到这里就是一次真实导航；失败的新建/首页发送根本不会调到这里，
    // 调用方在 await 之后也已核过导航代次，所以这里不另存第二份导航状态。
    onSessionOpened(openedSession);
    streamState.reset();
    if (actionConfirmation && typeof actionConfirmation.cancelAll === 'function') actionConfirmation.cancelAll();
    if (cardController && typeof cardController.clear === 'function') cardController.clear();
    if (workspaceView && typeof workspaceView.close === 'function') workspaceView.close();
    // 文件预览是最上面一层浮层：换会话时先关掉，不能把上一个会话的文件盖在下一个会话上。
    if (typeof closeFilePreview === 'function') closeFilePreview();
    getElement('chatTitle').textContent = state.session.title;
    getElement('chatSub').textContent = chatSubtitle(state.session.folder);
    composer.clearAttach();
    renderer.resetTurnState();
    composer.setBusy(false);   // 切会话时回到可发送状态，别继承上一个会话的「停止」
    renderer.clearStats();
    show('view-chat');

    // 切会话必须立刻清屏（旧会话的消息不能挂在新标题下面）：clearNow 走的是
    // 「会话切换」这条路，和下面 loadHistory() 默认的「原会话重载」分开处理。
    await loadHistory({ clearNow: true });
    // 历史请求慢时，用户可能已经打开了另一个会话。pager 会丢掉旧响应，但这里也不能
    // 无条件 connectWS——它先 close() 旧连接，会把新会话刚建好的 WS 打断。
    if (openEpoch !== navEpoch || state.session !== openedSession) return;
    sockets.connect();
  }

  /** 头部的副标题：工作目录 · 记忆开关 · 上下文占用。 */
  function chatSubtitle(folder) {
    const bits = [];
    if (folder) bits.push(folder);
    if (state.memoryOn === true) bits.push('记忆开');
    else if (state.memoryOn === false) bits.push('记忆关');
    if (Number.isFinite(state.ctxPct)) bits.push(`上下文 ${state.ctxPct}%`);
    return bits.join(' · ');
  }

  /**
   * 历史分页接线。
   *
   * 状态机（游标 / 去重 / epoch / busy 复核）全在 history-pager；控制带与插入锚点
   * 全在 history-pagination-view。这里只负责把两者接起来，并让历史回放走 transcript
   * 的 append 入口，保证更早页的节点一开始就落在旧消息之前。
   */
  const historyView = createHistoryPaginationView({
    document,
    container: getElement('transcript'),
    onLoadOlder: () => {
      // 首屏都没落地（open 失败）时，重试的是 open；否则才是更早一页。
      if (historyPageRendered) historyPager.loadOlder();
      else loadHistory();
    },
  });

  // 只是「首屏是否已经渲染过」的一比特，用来区分重试 open 还是 loadOlder；
  // 游标 / 去重 / epoch 仍然只在 history-pager 里，app 不保存第二份分页状态机。
  let historyPageRendered = false;
  // 「屏上已经有用户看得见的历史了」：只要有一页落到 transcript 就置位，切会话清屏时复位。
  // 骨架屏该不该出现，只在这条路径上参考它（见 loadHistory）。
  // 不能用 DOM 子节点数判断——分页控制带本身就挂在 transcript 的第一个子节点上，
  // 数节点会把那条「加载中…/重试」误当成已有内容。
  let transcriptRendered = false;
  // 首屏/重载是否要等「这一页真的到了」再替换 DOM（见 loadHistory 注释）。
  let historyPendingReplace = false;

  /* ------------------------------------------------------------------ */
  /* 前台恢复对账（foreground idle reconcile）                            */
  /* ------------------------------------------------------------------ */

  /**
   * 正在进行的对账。pager 的 onPage 看到它就走对账分支，而不是常规渲染。
   *
   * 为什么不能直接复用 loadHistory：重载默认就是「整页替换」，而这时屏上还有
   * 一轮可能正在生成的实时正文。要先把这一页和实时轮比一下才能决定换不换屏。
   */
  let pendingReconcile = null;

  /** 去掉 mood 块与多余空白：实时正文与历史正文的渲染标记不一样，比较前先归一。 */
  function comparableText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    const { body } = splitMoodBlock(raw);
    return String(body || '').replace(/\s+/g, ' ').trim();
  }

  /** 一条历史条目里的 assistant 正文（只认 text 块；工具/卡片/思考不参与比较）。 */
  function assistantTextOf(entry) {
    const msg = entry?.message || entry;
    if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return '';
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return typeof msg.text === 'string' ? msg.text : '';
    let out = '';
    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') out += block.text;
    }
    return out;
  }

  /** 这一页历史里最后一条 assistant 正文；没有就是空串。 */
  function lastAssistantText(page) {
    let last = '';
    for (const entry of page?.entries || []) {
      const text = assistantTextOf(entry);
      if (text) last = text;
    }
    return last;
  }

  /**
   * 历史里的回复是不是「比屏上这一轮更新/更完整」。
   *
   * 判据刻意保守（宁可继续等，也不误伤真正在跑的流）：
   *  - 屏上还没有正文（等首字、只有思考）→ 没有可对照的内容，一律不算；这时真正的
   *    权威信号（status:false / runtimeIsStreaming:false）会走既有路径收尾；
   *  - 历史正文与实时正文相等 / 历史更短 / 对不上 → 没有新内容，只合并不收尾；
   *  - 历史正文包含屏上这段实时正文、并且真的更长 → 离线期间已经生成完毕，可以收尾。
   * 「包含」而不「相等」：实时正文可能只是多段正文里最后一段（中间穿插过工具），
   * 也可能带着 mood 块，逐字相等永远对不上。
   */
  function hasNewerCompleteReply(page) {
    const live = comparableText(state.streamingRaw);
    if (!live) return false;
    const history = comparableText(lastAssistantText(page));
    if (!history || history.length <= live.length) return false;
    return history.includes(live);
  }

  /**
   * 对账拿到最新一页后的判断：要不要按「整轮跑完」收尾换屏。
   * 任何一条自证条件不满足都返回 false（只合并不收尾）。
   */
  function applyReconcileDecision(reconcile, page) {
    // 取历史期间用户切了会话 / 登出：这页属于旧归属，不能落到新会话头上。
    if (!state.session || reconcile.session !== state.session) return false;
    if (reconcile.epoch !== navEpoch) return false;
    // 已经不忙了（权威 idle / 用户中止已经收过尾）：没有要对账的东西。
    if (!state.busy) return false;
    // 只吃最新一页：更早页的内容与「这一轮跑完没有」无关。
    if (page?.prepend) return false;
    // 取历史期间又来了一条事件：流还活着，立刻放弃（装配层传进来的复核）。
    if (typeof reconcile.isStillQuiet === 'function' && !reconcile.isStillQuiet()) return false;
    return hasNewerCompleteReply(page);
  }

  /**
   * 前台恢复对账的入口（app 在 event-router 的对账窗口到期时调）。
   *
   * 只做一件事：绕过一次 history-pager 的 busy 门禁，把最新一页取回来。
   * 要不要收尾、要不要换屏全在拿到这一页之后判断（见 onPage 里的 pendingReconcile 分支），
   * 绝不先清 busy 再取、也不先换屏再判断。
   *
   * @param {object} [options]
   * @param {(() => boolean)|null} [options.isStillQuiet] 取历史期间「一条事件都没来」的复核
   * @param {(() => void)|null} [options.onRecovered] 历史证明这一轮已跑完时的收尾回调
   * @returns {Promise<boolean>} 是否按「跑完了」收尾并换屏
   */
  async function reconcileAfterForeground({ isStillQuiet = null, onRecovered = null } = {}) {
    const session = state.session;
    if (!session) return false;
    // 已经不忙（正常前台使用）：这条对账根本不需要动手，也不该发请求。
    if (!state.busy) return false;
    // 上一次对账还没落地（网络慢）：不叠加第二次请求。
    if (pendingReconcile) return false;
    const reconcile = { session, epoch: navEpoch, isStillQuiet, onRecovered, recovered: false };
    pendingReconcile = reconcile;
    try {
      await historyPager.open(session, { bypassBusy: true });
    } catch (err) {
      // open 不 reject（错误走 onState），这里只兜真出意外的装配错误。
      flash('前台恢复对账失败：' + (err?.message || String(err)));
    } finally {
      // open 失败/被拦时 onPage 不会来：标记必须自己收掉，否则会留给下一次普通重载。
      if (pendingReconcile === reconcile) pendingReconcile = null;
    }
    return reconcile.recovered === true;
  }

  function showSkeleton() {
    const el = getElement('chatSkeleton');
    if (el) el.hidden = false;
  }

  function hideSkeleton() {
    const el = getElement('chatSkeleton');
    if (el) el.hidden = true;
  }

  const historyPager = createHistoryPager({
    api,
    pageSize: 50,
    // kind 区分两条路径：'older'（加载更早，prepend）在生成中也放行——它只往旧消息前面
    // 插节点，不动实时轮；'open'（首屏 / 重载）仍是整页替换，生成中照旧拦住。
    canLoad: (kind) => (kind === 'older' ? true : !state.busy),
    onPage: (page) => {
      // 前台对账取回来的这一页：先判断要不要收尾换屏，再决定走不走常规渲染。
      const reconcile = pendingReconcile;
      if (reconcile) {
        pendingReconcile = null;
        const recovered = applyReconcileDecision(reconcile, page);
        // 这一次 open 的机会已经用掉了：早先被 busy 拦下的「原会话重载」不能借这一页
        // 把屏上内容顺手替换掉（否则「只合并」就成了整页丢失）。
        historyPendingReplace = false;
        if (!recovered) {
          // 只合并、不收尾：这一页不比屏上更新（离线期间没跑出新回复）。
          // 整页替换会把正在生成的实时轮丢掉，所以刻意不碰 DOM，busy 也保持原样；
          // 真正的收尾等宿主的权威 idle（或下一次前台恢复）再走既有路径。
          // 游标/hasMore 已经由 pager 推进，直接返回不会把分页卡死。
          hideSkeleton();
          historyPageRendered = true;
          return;
        }
        // 历史里有比屏上更完整的回复：走既有「原会话重载」路径换屏——
        // renderHistoryPage 的页边界会把实时轮指针让给历史轮（preserveLiveTurn 那套），
        // 不丢已经上屏的卡片/文件，也不给下一个 delta 留脏指针。
        historyPendingReplace = true;
      }
      // 只有真的拿到一页（并且 pager 已经过了 busy 复核）才动 DOM。
      if (historyPendingReplace && page && !page.prepend) {
        historyPendingReplace = false;
        replaceTranscriptHistory();
      }
      hideSkeleton();
      historyPageRendered = true;
      renderHistoryPage(page);
      if (reconcile) {
        reconcile.recovered = true;
        // 换屏之后才收尾：这时屏上是权威历史，清 busy/游标不会把半截内容当成完成。
        try {
          reconcile.onRecovered?.();
        } catch (err) {
          flash('前台恢复对账收尾失败：' + (err?.message || String(err)));
        }
      }
    },
    onState: (pagerState) => {
      if (pagerState?.error) hideSkeleton();
      historyView.setState(pagerState);
    },
  });

  /** 把 transcript 换成本会话的空白起点：清消息、清分页带、清还在跑的卡片。 */
  function replaceTranscriptHistory() {
    getElement('transcript').innerHTML = '';
    transcriptRendered = false;
    historyView.reset();
    // DOM 整页换掉：回放合并状态里握着的旧轮已经脱离文档，不清就会把下一页的正文写进孤儿节点。
    if (typeof renderer.beginHistoryPage === 'function') renderer.beginHistoryPage();
    if (cardController && typeof cardController.clear === 'function') cardController.clear();
    // 清屏后旧会话的卡片/子代理节点全成孤儿，通知装配层一并重置，避免留着失效引用。
    if (typeof onTranscriptCleared === 'function') onTranscriptCleared();
  }

  /**
   * 首屏落地后把上次的阅读位置恢复回来；返回 false 表示没有可恢复的记录（调用方照旧贴底）。
   * 只在「打开会话后的第一页」消费一次：重载、翻页都不走这里。
   */
  function restorePendingScroll() {
    if (!pendingScrollKey) return false;
    const key = pendingScrollKey;
    pendingScrollKey = null;
    const saved = scrollMemory.recall(key);
    // 当时就贴着底（或没记过）的，維持原来的强制贴底。
    if (!saved || saved.atBottom) return false;
    const box = getElement('transcript');
    if (!box) return false;
    const maxScroll = Math.max(0, (Number(box.scrollHeight) || 0) - (Number(box.clientHeight) || 0));
    // 图片 / 卡片还没撑开时 maxScroll 比记忆里小：收敛到当前能到的位置，不硬塞。
    box.scrollTop = Math.max(0, Math.min(saved.scrollTop, maxScroll));
    // 告诉视图「这一拍是我写的」：写入可能被 clamp 改值，由它自己读回生效值记账，
    // 否则补偿窗口里这条 scroll 会被当用户滚动而提前收手。
    historyView.noteProgrammaticScroll?.();
    return true;
  }

  /** 一页历史落到 DOM：更早页先立锚点，节点从第一次挂载就在最终位置。 */
  function renderHistoryPage({ entries, prepend = false, hasMore = false, sessionFiles = [] } = {}) {
    const into = Boolean(prepend);
    // 每页都是一个回放边界：只在同一页内合并连续的 assistant，不凭无身份的邻接跨页合并。
    // prepend 是往更早翻一页，可能落在生成中：preserveLiveTurn 让渲染器把实时轮指针
    // 暂存起来、结束边界再原样还原，否则历史回放会把正在追加的那一轮顶掉。
    // 非 prepend（首屏 / 重载）传 false，语义与改动前的无参调用一致。
    if (typeof renderer.beginHistoryPage === 'function') {
      renderer.beginHistoryPage({ preserveLiveTurn: into });
    }
    if (into) historyView.beginPrepend();

    let count = 0;
    try {
      for (const entry of entries || []) {
        if (renderer.renderEntry(entry, { sessionFiles })) count += 1;
      }
    } finally {
      // 结束边界：本页的历史轮已经上屏，但一个都不能留在 state.turn 里——
      // 否则实时 delta 会续进历史轮，status:true/turn_end 会把它当本轮收尾（改尾注、发通知）。
      // preserveLiveTurn 时渲染器只把「暂存的实时轮」还原回去，不把历史轮留在实时的位置。
      if (typeof renderer.endHistoryPage === 'function') {
        renderer.endHistoryPage({ preserveLiveTurn: into });
      }
      if (into) historyView.endPrepend();
    }

    // 一页落地就算「屏上已有内容」（哪怕是空会话的「还没有消息」提示）：
    // 之后的重载都是“看着旧内容换新内容”，不该再拿骨架遮住。
    transcriptRendered = true;

    if (!into) {
      // 首屏为空且明确没有更早，才说「还没有消息」；hasMore=true 时可能只是这页空。
      if (count === 0 && !hasMore) renderer.appendSystem('这个会话还没有消息。');
      // 有阅读记忆且当时不在底部：回到原处；否则维持现在的强制贴底。
      if (!restorePendingScroll()) renderer.scrollToBottom(true);
    }
  }

  /**
   * 打开 / 重开当前会话的历史：请求、竞态、去重都交给 pager。
   *
   * 两条路径必须分开：
   *   - clearNow=true（会话切换）：立刻清屏，旧会话的内容不能挂在新标题下面；
   *   - clearNow=false（原会话重载：回执重拉 / 首屏重试）：拿到数据且通过 busy 复核后
   *     才整页替换。旧行为是先清后取，一旦 busy 或请求失败，旧历史已被删、新历史又被
   *     pager 丢掉，屏幕上什么都不剩。
   *
   * 骨架屏跟着「屏上有没有东西」走，不跟着参数走：
   *   - 会话切换（清屏后）和首屏重试（之前就失败过，屏上还空着）都盖骨架；
   *   - 已经有历史的重载不盖，旧内容一直看得见。
   */
  async function loadHistory({ clearNow = false } = {}) {
    if (!state.session) return;
    historyPageRendered = false;
    if (clearNow) {
      replaceTranscriptHistory();
      historyPendingReplace = false;
      showSkeleton();
    } else {
      historyPendingReplace = true;
      // 原会话重载（回执重拉 / 首屏重试）不清屏，旧历史要留到新数据到。
      // 骨架屏是 position:absolute + 不透明底的全屏遮罩：盖到已有历史上，等于把用户
      // 正在看的消息藏起来，比让控制带说「加载中…」更差。所以只在该路径「屏上还什么
      // 都没有」时才补骨架——首屏失败后的重试就是这个情形，之前那里只有一行小字。
      if (!transcriptRendered) showSkeleton();
    }
    await historyPager.open(state.session);
  }

  /**
   * 「往回退一步」。按钮和 Android 系统返回键共用这一份逻辑。
   *
   * 返回 true 表示这次返回被网页吃掉了（聊天 → 列表），false 表示已经在根视图，
   * 交由外壳决定（Android 壳里就是原来的 canGoBack()/finish() 退出策略）。
   *
   * 必须是同步返回：Android 侧用 evaluateJavascript 取值，Promise 拿不到结果。
   */
  function backToList() {
    // 文件预览是最上面一层：先关掉它，不要连带退到列表
    if (typeof closeFilePreview === 'function' && closeFilePreview()) return true;
    if (actionConfirmation && typeof actionConfirmation.isOpen === 'function' && actionConfirmation.isOpen()) {
      actionConfirmation.cancelAll();
      return true;
    }
    // 工作区的层级（预览 → 面板）由 view 自己同步消费；app 不窥探 preview DOM，
    // 也不复制层级状态。back() 返回 false 才继续往下退。
    if (workspaceView && typeof workspaceView.back === 'function' && workspaceView.back()) return true;
    // 调试抽屉盖在页面上时，先收起它，别直接退到列表或退出 App
    const debugPanel = getElement('debug');
    if (debugPanel && debugPanel.hidden === false) {
      debugPanel.hidden = true;
      return true;
    }
    const chatView = getElement('view-chat');
    // hidden 只有明确为 false 才算「正在聊天」：启动中三个视图都没显示，不能误吃返回键
    if (!chatView || chatView.hidden !== false) return false;

    if (actionConfirmation && typeof actionConfirmation.cancelAll === 'function') actionConfirmation.cancelAll();
    if (cardController && typeof cardController.clear === 'function') cardController.clear();
    if (workspaceView && typeof workspaceView.close === 'function') workspaceView.close();
    // 退出聊天前把阅读位置留下（不写就会丢掉用户这一次读到的位置）。
    rememberCurrentScroll({ flush: true });
    pendingScrollKey = null;
    // 退出聊天就把分页状态一起收掉，避免下一次打开时旧游标/旧视图残存。
    hideSkeleton();
    historyPager.reset();
    historyView.reset();
    historyPendingReplace = false;
    transcriptRendered = false;

    // 一次真的导航：递增代次，在途的新建/首页发送不能再把用户拉回聊天。
    navEpoch += 1;
    sockets.drop();
    state.session = null;
    composer.clearAttach();
    renderer.resetTurnState();
    show('view-list');
    loadSessions();
    return true;
  }

  /** 当前导航代次：给 app 里的异步流程（首页发送）做快照用。 */
  function navigationEpoch() {
    return navEpoch;
  }

  /** 退出登录 / 换身份：代次 +1、连接丢掉、分页与在途新建全部作废，阅读记忆也清空。 */
  function reset() {
    hideSkeleton();
    // 上一个账号的阅读位置不能留给下一个登录。
    pendingScrollKey = null;
    scrollMemory.clearAll();
    navEpoch += 1;
    sockets.drop();
    historyPager.reset();
    historyView.reset();
    historyPageRendered = false;
    historyPendingReplace = false;
    transcriptRendered = false;
    newSessionToken = null;
    setNewSessionPending(false);
  }

  return {
    historyView,
    // 阅读位置记忆：装配层需要在退出登录之外单独清时（例如确定换账号）直接调 clearAll()。
    scrollMemory,
    navigationEpoch,
    reset,
    newSession,
    openSession,
    loadHistory,
    // 前台恢复对账（app 在 event-router 的对账窗口到期时调）
    reconcileAfterForeground,
    backToList,
    chatSubtitle,
    renderHistoryPage,
  };
}
