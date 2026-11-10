/* Hana Mobile — v0.5
 * 自己写的移动端界面，后端仍是 hana-server（经同源网关）。
 * 本版按官方桌面端的视觉语言重做布局：文档式阅读、浅灰用户气泡、卡片式输入区。
 */

import { createToaster } from './toast.js';
import { createConnectionBanner } from './connection-banner.js';
import { createDraftStore } from './draft-store.js';
import { createLightbox } from './lightbox.js';
import { createCodeFolderPicker } from './code-folder-picker.js';
import { createCodePanel } from './code-panel.js';
import { installCardHeightBridge } from './card.js';
import { closeFilePreview } from './file-preview.js';
import { createSessionFileUrls } from './file-urls.js';
import { workspaceUrlForFile, matchWorkspaceByLabel, buildWorkspaceContentUrl } from './file-source.js';
import { createStreamState } from './stream-state.js';
import { createAbortQueue } from './abort-queue.js';
import { createEchoGuard } from './echo-guard.js';
import { createApiClient } from './http-client.js';
import { createAvatarView, agentAvatarUrl } from './avatar-view.js';
import { createAvatarPack } from './avatar-pack.js';
import { createSessionListView, baseName, sessionTitle } from './session-list-view.js';
import { createSessionActions, createSessionActionsView, sameSession } from './session-actions.js';
import { createSessionPanel } from './session-panel.js';
import { createAgentCarousel } from './agent-carousel.js';
import { createLoginController } from './login-controller.js';
import { createLoginView } from './login-view.js';
import { createActionConfirmation } from './action-confirmation.js';
import { createCardBridge } from './card-bridge.js';
import { createCardController } from './card-controller.js';
import { createWorkspaceService } from './workspace-service.js';
import { createWorkspaceView } from './workspace-view.js';
import { createWebsocketClient } from './websocket-client.js';
import { createChatPanel } from './chat-panel.js';
import { createRendererState } from './renderer-state.js';
import { createFinishedNotice, formatNotice } from './finished-notice.js';
import { createEventRouter } from './event-router.js';
import { createComposer } from './composer-controller.js';
import { createConversationController } from './conversation-controller.js';
import { createMobileLifecycle } from './mobile-lifecycle.js';
import { createSettingsPanel } from './settings-panel.js';
import { createChatViewMode } from './chat-view-mode.js';
import { createThemeController, THEME_META_COLORS } from './theme.js';
import { sereneSummary } from './turn-summary.js';
import { createSubagentView } from './subagent-view.js';
import { createSearchFeature } from './features/search.js';
import { createArchiveFeature } from './features/archive.js';
import { createNativeBridge } from './native-bridge.js';
import { createNotifications } from './notifications.js';
import { createCasualFeature } from './features/casual.js';
import { createFeedFeature } from './features/feed.js';
import { createFeatureRegistry } from './features/registry.js';
import { createMessageActionsMenu, runMessageAction, copyTextToClipboard } from './message-actions.js';
import { createQuoteBar } from './quote-bar.js';
import { createSubagentBar } from './subagent-bar.js';
import { createSubagentSheet } from './subagent-sheet.js';
import { toTimeline } from './subagent-transcript.js';
import { renderMarkdown } from './md.js';
import { resolveAgentLabel } from './agent-label.js';

const $ = (id) => document.getElementById(id);

/* 应用级状态。流式渲染进度（一轮消息画到哪儿了）不在这里：那份归 chat-renderer 私有，
 * 见 web/renderer-state.js；这里的 S 只放登入、会话、连接、输入区这些应用级的东西。 */
const S = {
  principal: null,
  sessions: [],
  session: null,
  ws: null,
  wsReady: false,
  reconnectDelay: 800,
  boot: null,
  agentName: 'Hana',
  userName: '你',
  homeFolder: '',
  memoryOn: null,
  busy: false,
  // 附件：聊天页与首页各一份托盘，上限与渲染共用
  attach: [],
  homeAttach: [],
  attachSeq: 0,
};

/* 流式渲染状态：渲染器私有，装配时注入（createChatRenderer 的 state 参数）。
 * 必须建在 renderer 之前；渲染器只认识它，不再认识 S。 */
const rendererState = createRendererState();

// 流式游标唯一实例：app 里不再把 streamId/lastSeq 挂在 S 上。
const streamState = createStreamState();

/* 「刚发出去的那条」：composer 记一笔、event-router 核销（去重语义全在 web/echo-guard.js）。
 * 两边必须拿到同一个实例：分头自建就永远对不上号。 */
const echoGuard = createEchoGuard();

/* 兼容入口：这两个名字原来长在 S 上，现在归 echoGuard：tests/send_race 用
 * S.sentInputs.clear() 重置，tests/composer_controller、tests/pending_state 直接读写
 * state.sentInputs / state.lastLocalUser。只给 getter：业务代码一律走实例，别在这里写。
 *
 * 渲染器那批字段（turn / streamingRaw / …）的转发层已在 D2 删除：夹具直接读
 * hana.rendererState。上下文占用也有自己的主人（conversation-controller 的副标题）。
 */
Object.defineProperty(S, 'sentInputs', {
  enumerable: true,
  get: () => echoGuard.ids,
});
Object.defineProperty(S, 'lastLocalUser', {
  enumerable: true,
  get: () => echoGuard.lastLocalUser,
});

/* 断线时点的「停止」：队列归 web/abort-queue.js，composer 写、websocket-client 重连后补发，
 * 两边拿到的是下面这一个实例。S 上只留一层兼容访问器——tests/abort_pending.test.mjs
 * 还按 S.pendingAbort 断言与重置（8 处），那些断言不在本次改写范围里。
 * 业务代码一律走 abortQueue（或注入的实例），不要用这一层。 */
const abortQueue = createAbortQueue();
Object.defineProperty(S, 'pendingAbort', {
  enumerable: true,
  get: () => abortQueue.peek(),
  set: (value) => {
    if (value) abortQueue.push(value);
    else abortQueue.clear();
  },
});

const DEBUG = new URLSearchParams(location.search).has('debug');
const LAYOUT_PROBE_BUILD = 'layout-probe-20261102-a'; // 临时取证标记；设备验收后移除

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 输入框按内容长高，最高 128px。历史里两次内联写同样的三行，收成一个函数。 */
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 128) + 'px';
}

/**
 * 非阻塞提示，用来替代 alert。
 *
 * 模态弹窗会把渲染进程整个冻住：页面点不动、脚本停摆、连 DevTools 都进不来。
 * 出错本身不该让界面失去操作能力，所以浮一条提示条。
 *
 * E5：显示逻辑搬到了 web/toast.js —— 业务性错误不再 4 秒自灭（长报错根本读不完），
 * 只有 info 才自动消失，长文本折叠、详情可展开、最多 3 条、同文案合并。
 * 函数名和签名都保留：十几个模块把它当 flash 依赖注入，只换这一处就全升级。
 * 顶层只留这一个实例，挂在 document.body 上；根节点 id 仍是 #flashBar。
 */
let toaster = null;
/** 上一次 bootstrap 失败留下的那条提示（重试成功时要按它关掉）。 */
let bootFailToast = null;
function flash(text, opts) {
  if (!toaster) {
    if (!document || !document.body) return;
    toaster = createToaster({ doc: document, mount: document.body });
  }
  // 默认按 error 处理：现在的调用点九成是失败提示，宁可常驻也不能让人没读到
  // 返回快照（带 id）：调用方拿到后可以 dismiss 掉自己那条（如 bootstrap 重试成功）。
  return toaster.show(text, { level: 'error', ...(opts || {}) });
}

/**
 * 工作区视图的提示混着过程、成功和失败（上传成功、正在上传…、上传失败…）。
 * 它们走同一条 flash，但只有失败需要用户处理；不分类的话「正在上传文件…」
 * 会变成一条永不消失的红色错误条，反而骗人。
 */
function workspaceToast(text) {
  const msg = text == null ? '' : String(text);
  const info = !/失败|异常|拒绝|错误|不可/.test(msg) && /成功|已取消|正在上传|稍候|安全取消/.test(msg);
  flash(msg, { level: info ? 'info' : 'error' });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const api = createApiClient();
const invokeApi = createApiClient({ timeoutMs: 150000 });

/* 聊天视图（沉静 / 经典）的装配点。
 * 数据在 chat-view-mode（读 /api/preferences/chat-ui），摘要文案在 turn-summary，
 * 渲染器与设置面板都不 import 它们，只收模式字符串和格式化函数。 */
// 初值是空函数，真正的实现到下面的 applyViewMode = (mode) => … 才装上；
// 两处（渲染器 + 详情页）都只认沉静/经典两种模式。
/** @type {(mode: 'serene' | 'classic') => void} */
let applyViewMode = () => {};
const chatViewMode = createChatViewMode({
  api,
  onChange: (mode) => applyViewMode(mode),
});

/*
 * 外观（浅色 / 深色 / 跟随系统）。纯本地偏好，不上服务端：换设备、登出都不应把屏刷白。
 * 首帧定色在 index.html 的内联脚本里（module 是 defer 执行的，等这里跑到会先闪一下浅色）。
 */
const theme = createThemeController({
  onChange: ({ resolved }) => {
    const meta = document.getElementById('metaThemeColor');
    if (meta) meta.setAttribute('content', THEME_META_COLORS[resolved] || THEME_META_COLORS.light);
    // 不在这里重画设置面板：用户点选时视图已经乐观迁移了选中态，系统深浅变化又不改选中项。
    // 整块 render() 会把面板 body 重建一次，滚动位置也会被清掉。
  },
});
// 尽早读偏好：设置面板构造时就带 theme.current()，晚了会先把选中态画成 auto。
// 首帧底色由 index.html 的内联脚本负责（module 是 defer 执行的）。
theme.load();
theme.watch();

const actionConfirmation = createActionConfirmation({ document });
const workspaceService = createWorkspaceService();

/* 新建 Code 会话时的目录选择器：数据源是工作区根（带 nativeRootPath 的那些）。
 * 懒建（第一次 open 时才创建 DOM），与其它浮层一致。 */
let codeFolderPicker = null;
function openCodeFolderPicker(opts) {
  if (!codeFolderPicker) {
    const host = document.body || document.documentElement;
    if (!host) return Promise.resolve(null);
    codeFolderPicker = createCodeFolderPicker({
      doc: document,
      mount: host,
      listRoots: () => codeFolderRoots(),
    });
  }
  return codeFolderPicker.open(opts);
}

/**
 * 目录选择器的数据源。
 *
 * 宿主对「非本机回环」的客户端会隐去 nativeRootPath（bundle 里的披露规则：
 * 只有 local_user + local + loopback_token 才给路径）。所以手机上工作区列表永远是空的，
 * 只剩手动输入——而手机用户并不背得宿主机的绝对路径。
 * 会话列表里本来就有 Code 会话的 cwd（列表上的仓库名就是它），这是手机端合法持有的数据，
 * 拿来当「最近用过的目录」候选，比让用户手敲 C:\... 实在得多。
 */
async function codeFolderRoots() {
  const recent = [];
  const seen = new Set();
  for (const row of Array.isArray(S.sessions) ? S.sessions : []) {
    if (!row || row.namespace !== 'code') continue;
    const path = typeof row.cwd === 'string' ? row.cwd.trim() : '';
    if (!path || seen.has(path)) continue;
    seen.add(path);
    recent.push({ path });
  }

  let workspaces = [];
  let degraded = false;
  try {
    const roots = await workspaceService.listRoots();
    workspaces = Array.isArray(roots?.workspaces) ? roots.workspaces : [];
  } catch {
    // 工作区读不到不该拖死整个选择器：最近会话的目录仍然可用
    degraded = true;
  }
  return { workspaces, recent, degraded };
}

/* 仓库面板（只读）：分支 / 工作树 / 变更 / diff。
 * 只有 Code 会话才显示入口；面板自己也对「没目录」与「没权限」分则挡回去。 */
let codePanel = null;
function openCodePanel() {
  if (!codePanel) {
    const host = document.body || document.documentElement;
    if (!host) return;
    codePanel = createCodePanel({ doc: document, mount: host, api, getSession: () => S.session });
  }
  codePanel.open();
}
const workspaceView = createWorkspaceView({
  service: workspaceService,
  document,
  confirmAction: (opts) => actionConfirmation.confirm(opts),
  toast: workspaceToast,
});

const cardBridgeApi = async (url, opts) => {
  if (typeof url === 'string' && url.includes('/api/card-host/tools/invoke')) {
    return invokeApi(url, opts);
  }
  return api(url, opts);
};

function getActiveContext() {
  const chatView = $('view-chat');
  const isChatVisible = Boolean(chatView && chatView.hidden === false);
  const isDocVisible = typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true;
  const isWsOpen = typeof workspaceView !== 'undefined' && typeof workspaceView.isOpen === 'function' ? workspaceView.isOpen() : false;
  return {
    sessionId: S.session?.sessionId || null,
    sessionPath: S.session?.path || null,
    isVisible: isChatVisible && isDocVisible && !isWsOpen,
  };
}

const cardBridge = createCardBridge({
  api: cardBridgeApi,
  window: globalThis.window,
  confirmAction: (opts) => actionConfirmation.confirm(opts),
  getActiveContext,
  getPrincipal: () => S.principal,
});

const cardController = createCardController({
  document,
  bridge: cardBridge,
  getSession: () => S.session,
});

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

/*
 * 装配在 settings-panel：controller、view 与四个异步写的归属校验都在那边。
 * 这里只递进宿主的能力——状态读取、主题与聊天视图的落地点、模型 chip 与提示。
 */
const settingsPanel = createSettingsPanel({
  document,
  getElement: $,
  api,
  views: {
    closeDrawer: () => sessionPanel.closeDrawer(),
    // 退出登录：生成中不自动停工具/会话，只提示用户稍后再来（兜底在 switchLogin 里）。
    openLogin: () => switchLogin(),
    // 壳里拦截 hana-setup:// 弹原生对话框（本页与壳同源、且是用户手势才会被受理）。
    goServerMode: () => {
      location.href = 'hana-setup://edit-url';
    },
  },
  getState: () => S,
  hooks: {
    navigationEpoch: () => conv.navigationEpoch(),
    findAgentForSession,
    renderModelChip,
    // 写成功后作废写之前发出的 chip GET（计数器归 app 维护，syncSessionModelChip 读它）。
    bumpChipToken: () => {
      sessionModelChipToken += 1;
    },
    flash,
    isStreaming: () => Boolean(S.busy),
    onThemeSelect: (mode) => theme.set(mode),
    onViewModeSelect: (mode) => chatViewMode.set(mode),
    currentViewMode: () => chatViewMode.current(),
    currentThemeMode: () => theme.current(),
  },
});

/** 打开设置：委托给面板（先关抽屉、画本地状态，再去拉真实模型与思考级别）。 */
function openSettings() {
  settingsPanel.open();
}

const transcriptEl = () => $('transcript');

/* ------------------------------------------------------------------ */
/* 消息操作（复制 / 重试 / 回填重发）                                   */
/* ------------------------------------------------------------------ */

/**
 * 从一条消息的 DOM 还原出模块需要的形状。
 * 正文取展示文本（已渲染的），不碰原始帧：用户看到什么就复制什么。
 */
function messageRefFromTurn(turn) {
  if (!turn) return null;
  const bubble = turn.querySelector('.bubble-user');
  const body = turn.querySelector('.turn-body');
  const isUser = Boolean(bubble);

  let text = '';
  if (isUser) {
    text = (bubble.textContent || '').trim();
  } else if (body) {
    // 去掉嘀咕、工具折叠、尾注这些机器块，只留助手正文字
    const clone = body.cloneNode(true);
    clone.querySelectorAll('.mood-strip, .turn-meta, details, .card-frame, .file-card').forEach((n) => n.remove());
    text = (clone.textContent || '').trim();
  }
  if (!text) return null;

  const turns = Array.from(transcriptEl()?.querySelectorAll('.turn') || []);
  const lastOfRole = (asUser) => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (Boolean(turns[i].querySelector('.bubble-user')) === asUser) return turns[i];
    }
    return null;
  };

  return {
    role: isUser ? 'user' : 'assistant',
    text,
    isLastUser: lastOfRole(true) === turn,
    isLastAssistant: lastOfRole(false) === turn,
  };
}

/** 把一段正文填回输入框并聚焦（不自动发送）。 */
function fillComposer(text) {
  const input = $('input');
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  composer.syncSendButton();
  input.focus();
}

/*
 * 引用条：挂在输入区卡片顶部。没有挂载点（测试夹具、旧页面）就整体降级——
 * set/clear 不报错、applyTo 原样返回，发送路径不受影响。
 */
const quoteBar = createQuoteBar({
  document,
  mount: document?.querySelector ? document.querySelector('.composer-card') : null,
});

/*
 * 运行中的子代理：一条小胶囊，挂在输入卡**上方**（与桌面端一致）。
 * 正文里那张卡片是完成后的记录，跑到一半想看「谁在干活」不用往下翻。
 */
const composerCardEl = document?.querySelector ? document.querySelector('.composer-card') : null;
const subagentBar = createSubagentBar({
  document,
  // 胶囊在输入卡外面、卡片上方：做进卡片里会把输入框往下顶，看着像占位内容
  mount: composerCardEl?.parentElement || null,
  avatarUrlById: agentAvatarUrlById,
  // 胶囊只在跑的时候存在，点一下看它在干什么（详情页自己会再拉一次过程）
  onOpen: (target) => openSubagentDetail(target),
});

/*
 * 菜单挂到 body（底部 sheet 不背滚动容器裁）。测试夹具的假 document 未必有 body，
 * 没挂载点就不建菜单，功能降级但不影响启动。
 */
const messageActionsHost =
  document?.body && typeof document.body.appendChild === 'function' ? document.body : null;

const messageActionsMenu = messageActionsHost
  ? createMessageActionsMenu({
    document,
    mount: messageActionsHost,
    onRun: async ({ action, message, context }) => {
      // 引用不走执行器：它只是把一条引用挂到输入区，真正拼接发生在发送前
      // （composer 的 prepareOutgoingText → quoteBar.applyTo）。
      if (action.id === 'quote') {
        quoteBar.set(action.plan || { text: message?.text || '' });
        return;
      }
      const result = await runMessageAction(action, { api, fillComposer });
      if (!result.ok) {
        flash(result.message || '操作失败');
        return;
      }
      if (action.id === 'copy') flash('已复制', { level: 'info' });
    },
  })
  : null;

function openMessageActions(turn) {
  if (!messageActionsMenu) return;
  const message = messageRefFromTurn(turn);
  if (!message) return;
  messageActionsMenu.open({
    message,
    context: {
      session: S.session,
      streaming: Boolean(S.busy),
      // 引用时需要知道说话人是谁；消息本身不带名字，用当前会话的双方称呼兜底。
      // agentName 必须按会话归属解：全局的 S.agentName 是「主 Agent」的名字，
      // 跟这个会话属于谁不一定相同（拿错过：会话是 hanako，引用却写成另一个 Agent）。
      userName: S.userName,
      agentName: resolveAgentLabel({ session: S.session, agents: S.agents, fallback: S.agentName }),
    },
  });
}

/*
 * 长按 / 右键一条消息开菜单。用事件委派，不给每条消息挂监听；
 * 模块自己不认识 DOM，「哪条消息」由这里告诉它。
 */
{
  const surface = transcriptEl();
  if (surface) {
    let pressTimer = null;
    const cancelPress = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    surface.addEventListener('pointerdown', (e) => {
      const turn = e.target?.closest?.('.turn');
      if (!turn) return;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        openMessageActions(turn);
      }, 480);
    });
    surface.addEventListener('pointerup', cancelPress);
    surface.addEventListener('pointercancel', cancelPress);
    surface.addEventListener('touchmove', cancelPress, { passive: true });
    surface.addEventListener('contextmenu', (e) => {
      const turn = e.target?.closest?.('.turn');
      if (!turn) return;
      e.preventDefault();
      cancelPress();
      openMessageActions(turn);
    });
  }
}

function show(view) {
  for (const v of ['view-login', 'view-list', 'view-chat']) $(v).hidden = v !== view;
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function ensureAuth() {
  try {
    const s = await api('/api/web-auth/session');
    if (s && s.authenticated) {
      S.principal = s.principal || null;
      return true;
    }
  } catch (err) {
    // 不把接口原文写进 DOM：会话接口也会被代理/网关包一层，细节不可控。
    $('loginHint').textContent = '连不上 Hana，请检查网络后重试';
  }
  S.principal = null;
  show('view-login');
  return false;
}

// 登录视图与控制器：视图只产出纯 payload，控制器负责请求、互斥与脱敏错误。
// 手机只做账号密码登录；登录后的能力由宿主签发的 Cookie/principal 决定。
const loginView = createLoginView({
  document,
  onSubmit: (payload) => loginController.login(payload),
  onSwitchLogin: () => switchLogin(),
});

const loginController = createLoginController({
  api,
  onState: (state) => {
    loginView.setState(state);
    // 已登录时登录页是隐藏的（比如退出失败），安全错误必须浮在当前页上。
    if (state && state.error && S.principal) flash(state.error);
  },
  onAuthenticated: async () => {
    // Cookie 已由宿主写入；只信服务器 /session 返回的官方 principal。
    // 返回 false = 会话没生效，由 controller 统一提示，app 不另管一套错误文案。
    if (!(await ensureAuth())) return false;
    await boot();
    return true;
  },
  onLoggedOut: () => resetAfterLogout(),
});

/** 退出登录只清手机端这份登录，不删除服务端会话数据。 */
function switchLogin() {
  if (!S.principal) {
    show('view-login');
    return;
  }
  // 生成中不自动停工具/会话，只提示用户稍后再来。
  if (S.busy) {
    flash('正在生成回复，等完成后再切换登录');
    return;
  }
  loginController.logout();
}

/** logout 成功后的本地收尾：旧用户的连接/卡片/历史/在途列表全部废弃。 */
function resetAfterLogout() {
  S.principal = null;
  S.session = null;
  // 身份变了：在途的重连定时器、旧连接回调、工作区根缓存全部作废。
  // （导航代次 / 连接 / 分页 / 在途新建的复位全在 conversation-controller.reset 里）
  conv.reset();
  // 上家的草稿不能留给下一个人看（隐私），也不能在切换后莫名复活。
  clearAllDrafts();
  // 引用里带着上家的消息正文，同样不能跟着进下一次发送。
  quoteBar.clear();
  // 上家的会话条数基线也不能留着：否则换号回前台会拿别人的条数做差。
  finishedNotice.reset();
  resetFileRoots();
  streamState.reset();
  if (actionConfirmation && typeof actionConfirmation.cancelAll === 'function') actionConfirmation.cancelAll();
  if (cardController && typeof cardController.clear === 'function') cardController.clear();
  if (workspaceView && typeof workspaceView.close === 'function') workspaceView.close();
  // 旧用户的私有历史不能留在 DOM 里等下一次误显。
  transcriptEl().innerHTML = '';
  // 旧用户在途的目录请求不能回填新登录；reset 只废弃在途结果，面板仍可用。
  // 筛选与新建按钮文案也一起回 Chat（原来是 tabs / label / currentNamespace 三处复位）。
  sessionPanel.reset();
  S.sessions = [];
  sessionPanel.paint([]);
  sessionPanel.closeDrawer();
  // 退出登录不能留下盖在登录页上的旧浮层。设置控制器复位但不 dispose，新登录仍可复用。
  settingsPanel.close();
  settingsPanel.reset();
  sessionActionsView?.close?.();
  messageActionsMenu?.close?.();
  closeFilePreview();
  composer.clearAttach();
  composer.clearAttach('home');
  // 旧账号的输入草稿不能留到新登录：聊天框与首页输入框都清掉。
  const chatInput = $('input');
  if (chatInput) chatInput.value = '';
  const homeInput = $('homeInput');
  if (homeInput) homeInput.value = '';
  // 旧身份的在途首页发送/新建：复位锁与归属 token，旧 finally 就不会再碰新 UI。
  homeSending = false;
  homeSendToken = null;
  const homeSendBtn = $('btnHomeSend');
  if (homeSendBtn) homeSendBtn.disabled = false;
  composer.syncSendButton();
  renderer.resetTurnState();
  renderer.clearStats();

  // 各 Feature（闲聊、归档、搜索）状态复位：关闭面板、清空缓存与输入、停轮询、废弃在途请求
  features?.get('casual')?.reset?.();
  features?.get('archive')?.reset?.();
  features?.get('search')?.reset?.();
  features?.get('feed')?.reset?.();

  loginView.setState({ pending: false, error: '' });
  loginView.clearSecrets();
  show('view-login');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  // 启动分段计时：冷启动的尾款几乎全在「哪些请求是被 await 串起来的」上，没有这组
  // 标记只能猜。只在控制台打一行，不进 UI。
  const bootT0 = performance.now();
  const bootMarks = [];
  const mark = (name) => bootMarks.push([name, Math.round(performance.now() - bootT0)]);
  mark('boot 开始');
  // 登录身份刚确认：上个身份的工作区根缓存不能再给这次用。
  resetFileRoots();
  // 登录身份就绪后才读偏好：接口需要会话，提前读只会拿到 401。
  // 读不到不阻塞启动，界面临时用默认沉静。
  void chatViewMode.load();
  await loadBootstrap();
  mark('bootstrap 回来');
  void features?.get('feed')?.refresh?.();
  mark('首屏渲染完成');
  mark('开始拉会话列表');

  await sessionPanel.loadSessions();
  mark('会话列表回来');
  // 刚登录/刚启动：此刻看到的列表就是基线，之后回前台做差才有意义。
  void refreshNoticeBaseline();
  show('view-list');
  mark('列表上屏');
  try { console.log('[boot]', JSON.stringify(bootMarks)); } catch { /* 打不出计时不影响启动 */ }
  // 启动后主动要一次通知权限（Android 13+）。没壳、已经拒过的会自己安静跳过。
  void notifications.ensurePermission();
}

/**
 * 拉启动配置（Agent 列表 / 署名 / 记忆开关）并上屏。
 *
 * 失败不拦启动：没配置也能用会话列表，但错误必须让用户看见——空 Agent 列表配默认署名
 * 看起来就是「App 坏了」，用户不知道是服务端没回。重试走首页右上角那个现有的「刷新」，
 * 不另造一个只在出错时出现的按钮。
 */
async function loadBootstrap() {
  let loaded = true;
  try {
    S.boot = await api('/api/mobile/bootstrap');
    // 重试成功要把那条常驻的失败提示收掉：错误提示不自动消失，留着就会出现
    // 「配置没加载成功」和「配置已重新加载」同屏互搏。
    if (bootFailToast) {
      toaster?.dismiss?.(bootFailToast.id);
      bootFailToast = null;
    }
  } catch (err) {
    S.boot = null;
    loaded = false;
    // 详情里带原始 message：`5xx …` 和 `请求超时` 一眼能分出是服务端还是网络。
    bootFailToast = flash('配置没加载成功，已用默认值启动；点右上角刷新可重试', {
      detail: String(err?.message || err),
    });
    console.warn('[app] bootstrap failed:', err);
  }
  // 失败也照样铺一遍：降级启动的界面与改动前一致（空 Agent 列表 + 默认署名），
  // 只是多了一条看得见的提示。
  applyBootstrap();
  return loaded;
}

/** 把 S.boot 铺到首屏。降级启动时 S.boot 为 null，这里自然落到默认值。 */
function applyBootstrap() {
  S.agents = Array.isArray(S.boot?.agents) ? S.boot.agents : [];
  const primary = S.agents.find((a) => a.isPrimary) || S.agents[0];
  S.currentAgent = primary || null;
  S.agentName = S.boot?.agentName || primary?.name || primary?.agentName || 'Hana';
  $('agentName').textContent = S.agentName;

  S.userName = S.boot?.userName || '你';
  $('userName').textContent = S.userName;
  paintAvatar($('userAvatar'), { url: userAvatarUrl(), name: S.userName });

  S.homeFolder = baseName(S.boot?.homeFolder) || '';
  S.memoryOn = S.boot ? (S.boot.memoryMasterEnabled !== false && S.boot.memoryEnabled !== false) : null;

  renderModelChip(primary?.chatModel);
  renderAgentCarousel();
  void primeStartupAvatars();
  // 首页首次选中的助手是直接赋值、不走 selectAgent：这里要把数据层的绑定一起补上。
  // 只刷新角标不够——store 的 agentId 还停在构造时的 null，WS 推来的 casual_* 会被它
  // 按「不是当前助手」丢掉，而 handleSocketMessage 已经 return true，事件就此消失：
  // 表现是冷启动后不打开闲聊，未读角标永远不涨。setAgent 会把 client 与 store 一起绑。
  casual.setAgent();
}

/* ------------------------------------------------------------------ */
/* 主页：Agent 横向滑轨与陪伴大屏                                       */
/* ------------------------------------------------------------------ */

/*
 * 滑轨与 hero 的 DOM（pill 节点、active、头像/模型/工作区文案）都在 agent-carousel 里；
 * 这里只做装配：把 S 的当前状态喂进去。pill 点击经模块的 onSelect 回到 selectAgent，
 * 换助手的业务仍留在本文件。
 */
function renderAgentCarousel() {
  agentCarousel.render({
    agents: S.agents,
    currentAgent: S.currentAgent,
    agentName: S.agentName,
    homeFolder: S.homeFolder,
  });
}

/** 助手切换后的扩展点：闲聊面板与角标都挂在这里，别往 selectAgent 里塞业务。 */
let onAgentSelected = null;

/* 换助手就换闲聊频道：视图与轮询收掉，角标按新助手重拉。 */
onAgentSelected = () => casual.setAgent();

function selectAgent(agent) {
  S.currentAgent = agent;
  S.agentName = agent.name || agent.agentName || 'Hana';
  $('agentName').textContent = S.agentName;

  // 轮播 active 与 hero 归模块：这里只喂刚更新的状态，不碰 DOM。
  agentCarousel.setActive(agent, { agentName: S.agentName, homeFolder: S.homeFolder });

  if (typeof onAgentSelected === 'function') onAgentSelected(agent);
}

/** 陪伴大屏的刷新出口：`__hana.updateHeroCompanion()` 与头像到了之后的补画都走它。 */
function updateHeroCompanion() {
  agentCarousel.updateHero({
    currentAgent: S.currentAgent,
    agentName: S.agentName,
    homeFolder: S.homeFolder,
  });
}

/* ------------------------------------------------------------------ */
/* 主页：从悬浮大输入岛直接发起新会话                                  */
/* ------------------------------------------------------------------ */

let homeSending = false;
// 本次首页发送的归属 token：logout 会把锁复位；旧 finally 只清自己的锁。
let homeSendToken = null;

async function sendFromHome() {
  if (homeSending) return;
  // 捕获身份快照（不新建 auth epoch）：每个 await 后都要核对。
  const owner = S.principal;
  const input = $('homeInput');
  const text = input ? input.value.trim() : '';
  const homeAttach = S.homeAttach || [];
  const homeReady = homeAttach.filter((a) => a && a.base64);
  const stillWorking = homeAttach.some((a) => !a || !a.base64);
  if (!text && !homeReady.length) return;
  if (stillWorking) {
    flash('图片还在处理，稍等一下再发');
    return;
  }

  const token = {};
  homeSending = true;
  homeSendToken = token;
  const sendBtn = $('btnHomeSend');
  if (sendBtn) sendBtn.disabled = true;
  // 导航代次快照：create 期间用户自己开了别的会话，这次就不抢焦点、不乱发。
  const epoch = conv.navigationEpoch();
  const imageSnapshot = homeReady.slice();

  try {
    const body = S.currentAgent?.id ? { agentId: S.currentAgent.id } : {};
    const created = await api('/api/sessions/new', { method: 'POST', body: JSON.stringify(body) });
    // 已发出的 create 不回滚，只丢弃旧身份后的后续步骤。
    if (S.principal !== owner) return;
    // 用户已经自己导航：草稿留在首页输入框和托盘里，不能被这次流程清掉。
    if (conv.navigationEpoch() !== epoch) return;

    const listed = await sessionPanel.loadSessions('home');
    if (!Array.isArray(listed)) {
      // 列表失败/被更新的请求顶掉：没有安全落地，首页草稿必须留着。
      if (S.principal === owner && conv.navigationEpoch() === epoch) {
        flash('会话列表加载失败，草稿已保留在首页');
      }
      return;
    }
    if (S.principal !== owner) return;
    if (conv.navigationEpoch() !== epoch) return;

    // 把 agent 带进去：新会话的第一轮消息要能立刻用上头像
    // openSession 的同步部分会立即设置 S.session，必须在 await 之前捕获本次对象；
    // 否则同一身份在历史挂起期间切了会话，会把后来选的会话当成本次结果。
    const opening = conv.openSession({
      path: created?.path,
      sessionId: created?.sessionId,
      title: '新对话',
      agentId: created?.agentId || S.currentAgent?.id,
      agentName: created?.agentName || S.currentAgent?.name || S.agentName,
    });
    const openedSession = S.session;
    await opening;
    if (S.principal !== owner || S.session !== openedSession) return;

    // 附件从首页托盘交给聊天页：只移除本次交接的快照，等待期间新加的仍留在首页。
    if (imageSnapshot.length) {
      S.attach = imageSnapshot.slice();
      S.homeAttach = (S.homeAttach || []).filter((item) => !imageSnapshot.includes(item));
      composer.renderAttachBar('home');
      composer.renderAttachBar('chat');
      composer.syncSendButton();
    }

    // 填入聊天输入框；只有这一步成功后才算安全移交。
    const chatInput = $('input');
    if (!chatInput) return;
    chatInput.value = text;
    autoGrow(chatInput);
    composer.syncSendButton();

    // 首页草稿的结算必须放在移交之后：只结算发出时的那份快照，
    // 等待期间新输入的内容归下一次发送（见 settleHomeDraftAfterHandoff）。
    settleHomeDraftAfterHandoff(text);

    // 发送就绪等待交给 composer（它已有单飞与身份复核）；不要再在外层叠一个超时。
    if (S.principal !== owner || S.session !== openedSession) return;
    await composer.sendMessage();
  } catch (err) {
    // 旧身份的失败不能浮到新用户界面上。
    if (S.principal === owner) flash('开启新对话失败：' + (err?.message || err));
  } finally {
    if (homeSendToken === token) {
      homeSending = false;
      homeSendToken = null;
      if (sendBtn) sendBtn.disabled = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 头像                                                                */
/* ------------------------------------------------------------------ */

const { paintAvatar } = createAvatarView({ document });

/* 头像包：一次请求取回全部头像，省掉「每个头像一次往返」。
 * 取不到不影响任何路径：urlFor 没命中就退回原来的逐张地址。 */
const avatarPack = createAvatarPack();

/* 首页 Agent 滑轨 + 陪伴大屏。DOM 与 active 状态在模块里，S 仍是唯一状态源：
 * 选中助手经 onSelect 回到 selectAgent（业务在本文件），按 id 取头像走 avatarUrlFor
 * （子代理卡片与胶囊也共用这条规则）。 */
const agentCarousel = createAgentCarousel({
  document,
  getElement: $,
  paintAvatar,
  agentAvatarUrl,
  modelLabel,
  onSelect: selectAgent,
  packedAvatarUrlOf: (id) => avatarPack.urlFor(id),
  agentsOf: () => S.agents,
});

/**
 * 启动时预取头像，到了再把依赖头像的几处重画一遍。
 * 不 await 进启动流程：它会和 loadSessions 并行，慢一点也不挡界面。
 */
async function primeStartupAvatars() {
  const ids = ['user', ...(S.agents || []).map((a) => a && (a.id || a.agentId)).filter(Boolean)];
  if (ids.length < 2) return;
  const before = avatarPack.size();
  await avatarPack.prime(ids);
  if (avatarPack.size() === before) return; // 一个都没拿到（离线/上游拒绝），保持现状

  paintAvatar($('userAvatar'), { url: userAvatarUrl(), name: S.userName });
  renderAgentCarousel();
  updateHeroCompanion();
  // 抽屉开着就不要再重画列表：重建行会打断正在看的位置。
  if (!sessionPanel.isDrawerOpen() && Array.isArray(S.sessions) && S.sessions.length) sessionListView.render(S.sessions);
}

/** 按 agent id 拼头像地址；规则（头像包 → agents → 兜底地址）在 agent-carousel 里。 */
function agentAvatarUrlById(id) {
  return agentCarousel.avatarUrlFor(id);
}

/** 用户本人的头像；bootstrap 明确说没有时就直接跳过，不去白撞一次 404。 */
function userAvatarUrl() {
  const packed = avatarPack.urlFor('user');
  if (packed) return packed;
  return S.boot?.hasUserAvatar === false ? null : '/api/avatar/user';
}

function modelLabel(model) {
  if (!model) return '';
  const raw = typeof model === 'string' ? model : (model.name || model.label || model.id || model.model || '');
  if (!raw) return '';
  return String(raw).replace(/^[a-z0-9]+[/:]/i, '');
}

function renderModelChip(model) {
  const chip = $('modelChip');
  const label = modelLabel(model);
  if (!label) { chip.hidden = true; return; }
  chip.textContent = label;
  chip.hidden = false;
}

function findAgentForSession(s) {
  if (!s) return null;
  const agents = S.agents || [];
  if (s.agentId) {
    const byId = agents.find((a) => a && a.id === s.agentId);
    if (byId) return byId;
  }
  if (s.agentName) {
    const byName = agents.find((a) => a && a.name === s.agentName);
    if (byName) return byName;
  }
  return null;
}

let sessionModelChipToken = 0;

/**
 * 刷新当前会话模型 chip：
 * 1. 优先调用 settingsPanel.controller.fetchSessionModel(sessionPath)
 * 2. 查不到时退回该会话所属 Agent 的 chatModel（不借用当前 Agent，精确匹配）
 * 3. 都取不到则 hidden = true
 * 4. 退出会话（session 为 null）时恢复成当前 Agent 的默认模型
 * 5. 竞态防御：token + 当前 S.session.path 校验，晚到响应丢弃
 */
async function syncSessionModelChip(session = S.session) {
  const token = ++sessionModelChipToken;

  // 没有会话时（如在主页/列表页）：恢复当前 Agent 的默认模型
  if (!session || !session.path) {
    const currentAgentModel = S.currentAgent?.chatModel || null;
    renderModelChip(currentAgentModel);
    return;
  }

  const targetPath = session.path;
  // 会话所属 Agent 的兜底模型（按 agentId / agentName 严格匹配，不借用当前 Agent）
  const sessionAgent = findAgentForSession(session);
  const fallbackModel = sessionAgent?.chatModel || null;

  // 先用 fallbackModel 做乐观占位渲染，避免打开时残留上一条会话的模型
  renderModelChip(fallbackModel);

  try {
    const fetched = await settingsPanel.controller.fetchSessionModel(targetPath);
    // 竞态守卫：代次不一致或用户已经切换到其他会话，晚到结果作废
    if (token !== sessionModelChipToken || !S.session || S.session.path !== targetPath) {
      return;
    }
    if (fetched) {
      renderModelChip(fetched);
    } else if (fallbackModel) {
      renderModelChip(fallbackModel);
    } else {
      const chip = $('modelChip');
      if (chip) chip.hidden = true;
    }
  } catch {
    if (token !== sessionModelChipToken || !S.session || S.session.path !== targetPath) {
      return;
    }
    if (fallbackModel) {
      renderModelChip(fallbackModel);
    } else {
      const chip = $('modelChip');
      if (chip) chip.hidden = true;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 会话列表                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 会话操作（重命名 / 置顶 / 归档）                                     */
/* ------------------------------------------------------------------ */

/*
 * 执行器管请求与乐观更新，视图管菜单，两层都不认识应用状态。
 * 唯一的接线：列表从 S.sessions 读，落地后回写并让列表重绘。
 */
const sessionActionsCore = createSessionActions({
  fetchImpl: (url, init) => api(url, init),
  getList: () => S.sessions,
  // 身份快照：await 后若已换 principal，底层不提交回滚、不 flash。
  getContext: () => S.principal,
  commitList: (list, meta) => {
    S.sessions = list;
    sessionListView.render(list);
    // 菜单拿着一份列表快照，不一起更新的话再打开同一条会看到旧标题/旧置顶态
    sessionActionsView?.setList(list);

    // 只有改名需要同步当前聊天的标题；且目标必须仍是当前会话。
    // 归档的列表删除是乐观更新，绝不能在这里根据「列表里没有当前会话」就退出聊天。
    if (!meta || !S.session || !meta.target || meta.action !== 'rename') return;
    if (!sameSession(S.session, meta.target)) return;

    const found = (Array.isArray(list) ? list : []).find((row) => sameSession(row, meta.target));
    if (found && found.title && found.title !== S.session.title) {
      S.session.title = found.title;
      const titleEl = $('chatTitle');
      if (titleEl) titleEl.textContent = found.title;
    }
  },
  onError: (event) => flash(event?.error?.message || '会话操作失败'),
});

/**
 * 归档的退出条件必须等请求成功：乐观删除只是列表变化，不是导航信号。
 * 同时要求「发起时仍为当前」的会话在成功时还是当前，避免操作其他行或中途切会话误退。
 */
async function archiveWithActiveExit(session) {
  const owner = S.principal;
  const activeAtStart = S.session;
  const archivedActive = Boolean(activeAtStart) && sameSession(session, activeAtStart);

  const result = await sessionActionsCore.archive(session);
  if (!result || result.stale || S.principal !== owner) return result;
  if (result.ok && archivedActive && S.session && sameSession(activeAtStart, S.session)) {
    conv.backToList();
  }
  return result;
}

const sessionActions = {
  ...sessionActionsCore,
  archive: archiveWithActiveExit,
};

// 菜单挂到 body；夹具的假 document 未必有 body，没挂载点就降级不建（不影响启动）。
const sessionActionsHost =
  document?.body && typeof document.body.appendChild === 'function' ? document.body : null;

const sessionActionsView = sessionActionsHost
  ? createSessionActionsView({
    document,
    mount: sessionActionsHost,
    list: S.sessions,
    onAction: async ({ type, session, title }) => {
      if (type === 'rename') return await sessionActions.rename(session, title);
      if (type === 'pin') return await sessionActions.togglePin(session);
      if (type === 'archive') return await sessionActions.archive(session);
      return null;
    },
  })
  : null;

// 只在这里构造视图，不主动渲染；render 由 controller 的 onLoaded 或 DEBUG 入口触发。
const sessionListView = createSessionListView({
  document,
  container: $('sessionList'),
  getContext: () => ({
    agentName: S.agentName,
    homeFolder: S.homeFolder,
    agents: S.agents,
  }),
  onOpenSession: (s) => {
    // chip 刷新由 conversation-controller 的 onSessionOpened 统一触发，这里不再单独同步。
    conv.openSession(s);
  },
  // 长按 / 右键：开会话操作菜单（这里把展示标题算好，菜单模块不认识列表数据）
  onRowAction: (s) => sessionActionsView?.open({ ...s, title: sessionTitle(s) }),
});

// 会话面板：抽屉开合、Chat / Code 筛选、新建按钮文案与列表数据的接线都在模块里。
// homeFolder 的兜底（sessionFolder）由 homeFolderOf 交给它，与 bootstrap 一致。
const sessionPanel = createSessionPanel({
  document,
  getElement: $,
  api,
  sessionListView,
  sessionActionsView,
  // 打开会话：chip 刷新由 conversation-controller 的 onSessionOpened 统一触发。
  onOpenSession: (s) => {
    conv.openSession(s);
  },
  // 长按 / 右键：开会话操作菜单（这里把展示标题算好，菜单模块不认识列表数据）
  onRowAction: (s) => sessionActionsView?.open({ ...s, title: sessionTitle(s) }),
  // 列表数据落地：DEBUG 面与搜索缓存都读 S.sessions。
  onSessionsLoaded: (list) => {
    S.sessions = list;
  },
  homeFolderOf: () => S.homeFolder,
});

// mobile-lifecycle 在 pagehide 时对 controller 与 tabs 各调一次 dispose()：
// 两样现在都归 session-panel，面板的 dispose 幂等，所以两个槽位共用一个适配对象。
const sessionPanelDispose = { dispose: () => sessionPanel.dispose() };

/* ------------------------------------------------------------------ */
/* 回前台「谁跑完了」                                                     */
/* ------------------------------------------------------------------ */

/** 网关给的会话摘要：只有 id / 标题 / 条数 / 是否在跑。拿不到就安静退。 */
async function fetchSessionDigest() {
  let res;
  try {
    res = await fetch('/gw/session-digest', { headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const payload = await res.json();
    return Array.isArray(payload?.sessions) ? payload.sessions : null;
  } catch {
    return null;
  }
}

const finishedNotice = createFinishedNotice();

/** 页面现在是不是真的在前台。
 *
 * WebView 切到桌面后仍可能报 `visibilityState: 'visible'`（真机见过），
 * 所以两个信号一起看：hasFocus 为真且不是 hidden 才算在眼前。
 */
function pageIsForeground() {
  try {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  } catch {
    // 老 WebView 没有 hasFocus：退回只看可见性
  }
  return document.visibilityState !== 'hidden';
}

/**
 * 把「现在看到的」记成基线：登录后、每轮生成结束（用户就在屏幕前看着）各做一次，
 * 这样回前台时做差才只压中「离开期间真的变了」的那几个。
 *
 * 后台时一律不拍：真机上 App 切走后 WebView 仍会收事件、跑定时器，
 * 如果它偷偷把基线推到了「跑完之后」，回前台就再也报不出来了。
 */
async function refreshNoticeBaseline() {
  if (noticeBusy || !pageIsForeground()) return;
  const sessions = await fetchSessionDigest();
  if (!sessions) return;
  // 请求飞出去到回来之间可能已经切到后台了，再确认一次。
  if (!pageIsForeground()) return;
  finishedNotice.snapshot(sessions);
}

/** 回前台那一次做差期间，不许别的路径把基线推走（对账会触发 onSessionIdle）。 */
let noticeBusy = false;

/** 回前台：拉一次摘要，与基线做差，变了就提示一句。 */
async function resumeNotice() {
  noticeBusy = true;
  try {
    const sessions = await fetchSessionDigest();
    if (!sessions) return;
    const report = finishedNotice.diff(sessions);
    if (report.total) flash(formatNotice(report), { level: 'info' });
    finishedNotice.snapshot(sessions);
  } finally {
    noticeBusy = false;
  }
}

// 兼容 DEBUG / 回归入口：仍可单独重绘或取一行（适配层现在在 session-panel）。
$('btnRefresh').addEventListener('click', () => {
  // 启动时 bootstrap 没拿到：刷新连配置一起重试。不接这一步的话，用户只能重启 App
  // 才能拿到 Agent 列表与署名，而屏幕上写的是「点刷新可重试」。
  if (!S.boot) {
    void loadBootstrap().then((loaded) => {
      if (loaded) flash('配置已重新加载', { level: 'info' });
    });
  }
  void sessionPanel.loadSessions();
  void features?.get('feed')?.refresh?.();
});
$('btnNew').addEventListener('click', () => void startNewSession());
$('btnNewChat').addEventListener('click', () => void startNewSession());

/**
 * 新建会话前读宿主的思考档位。
 *
 * 档位是会话级设置，宿主新建时不带就落回默认；而用户在宿主里调的档位不会自动传过来。
 * 读不到不阻塞新建（不能因为一个偏好请求失败就让新建按钮点不动），只退成宿主默认。
 */
async function hostThinkingLevel() {
  try {
    const res = await api('/api/session-thinking-level');
    const level = typeof res?.thinkingLevel === 'string' ? res.thinkingLevel.trim() : '';
    return level || null;
  } catch {
    return null;
  }
}

async function startNewSession() {
  // Code 会话必须点名目录。规则定得直白一点：
  // 你就在某个 Code 会话里 → 就地建在同一个仓库（可预测，不每次弹框）；否则就问。
  let cwd = null;
  if (sessionPanel.namespace === 'code') {
    const here = S.session && S.session.namespace === 'code' ? S.session.cwd : null;
    cwd = typeof here === 'string' && here.trim()
      ? here.trim()
      : await openCodeFolderPicker({ title: '选择代码目录' });
    if (!cwd) return;              // 用户取消就停手，不要退回到猜一个目录
  }
  const level = await hostThinkingLevel();
  conv.newSession(sessionPanel.namespace, { cwd, thinkingLevel: level });
}

/* ------------------------------------------------------------------ */
/* 渲染：历史                                                          */
/* ------------------------------------------------------------------ */

/* 文件的两个地址（读 / 下载）：路径映射在 file-source.js，白名单判定在 download.js，
 * 根缓存与身份隔离在 file-urls.js。app 只把服务与当前会话/身份接进去。 */
const fileUrls = createSessionFileUrls({
  service: workspaceService,
  getSession: () => S.session,
  getPrincipal: () => S.principal,
  workspaceUrlForFile,
  matchWorkspaceByLabel,
  buildWorkspaceContentUrl,
});

/** 登录身份变化 / 退出登录时丢掉工作区根缓存，别把上一个人的根用在这一回。 */
function resetFileRoots() {
  fileUrls.reset();
}

async function ensureFileRoots() {
  return fileUrls.ensureRoots();
}

async function fileHrefFor(file) {
  return fileUrls.downloadUrlFor(file);
}

/* 消息区的渲染：DOM 结构、思考/工具折叠、mood、文件卡、历史回放、尾注数字。
 * 只接 DOM 与状态，不碰网络；「该不该画」由事件路由决定。 */
/** 文章、子代理这类“旁路内容”的视图：都不 import 回渲染器，在这里注入。 */
const subagentView = createSubagentView({
  document,
  avatarUrlById: agentAvatarUrlById,
  // 点卡片/胶囊都落到同一张详情 sheet（桌面端点开的是子会话预览）
  onOpenSession: (target) => openSubagentDetail(target),
});

/*
 * 子代理详情：从底部弹出的 3/4 高只读 sheet（身份卡 + 过程时间轴）。
 * 正文不在这里取——loader 注入进去，sheet 自己不认识网络；测试夹具里的假 document
 * 没有 body 时直接不建，后续调用都是 null 保护。
 */
const subagentSheet = document?.body
  ? createSubagentSheet({
    document,
    mount: document.body,
    avatarUrlById: agentAvatarUrlById,
    // 结论里会有 ** 与反引号，交给和聊天同一个渲染器消化
    renderText: renderMarkdown,
    loadTranscript: (target) => loadSubagentTranscript(target),
  })
  : null;

/* 子代理过程一次取这么多条消息；超出部分由 toTimeline 掉中间并标「已省略」。 */
const SUBAGENT_TRANSCRIPT_LIMIT = 200;

/* 卡片用 aborted / interrupted，详情页只有五档；对上桌子，别让「已中止」显示成「运行中」。 */
const SUBAGENT_SHEET_STATUS = {
  aborted: 'canceled',
  abort: 'canceled',
  interrupted: 'canceled',
  cancelled: 'canceled',
  canceled: 'canceled',
};

function openSubagentDetail(target) {
  if (!subagentSheet || !target || typeof target !== 'object') return false;
  const raw = typeof target.status === 'string' ? target.status.trim().toLowerCase() : '';
  const status = SUBAGENT_SHEET_STATUS[raw] || raw || 'idle';
  try {
    subagentSheet.open({ ...target, status });
    startDetailTicker();
    return true;
  } catch (err) {
    console.error('[subagent] open sheet error:', err);
    return false;
  }
}

/*
 * 详情页的「用时」跟胶囊一样要往前走：sheet 自己不开表（模块不碰 setInterval），
 * 由这里每秒喂一次空补丁让它按 startedAt 重算。面板一关就停，不常驻。
 */
let detailTicker = null;

function stopDetailTicker() {
  if (detailTicker == null) return;
  clearInterval(detailTicker);
  detailTicker = null;
}

function startDetailTicker() {
  stopDetailTicker();
  detailTicker = setInterval(() => {
    if (!subagentSheet || !subagentSheet.isOpen()) {
      stopDetailTicker();
      return;
    }
    subagentSheet.update({});
  }, 1000);
}

/**
 * 子代理的过程快照：一次 GET，把 messages 与锚在消息后面的 blocks 拼成一条线。
 * 合并规则跟历史分页一致（web/history-pager.js）：block.afterIndex 是页内消息下标，
 * 插到那条消息之后；越界或缺失就丢掉，不猜相邻。
 */
function mergeAnchoredBlocks(messages, blocks) {
  const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m === 'object') : [];
  const anchored = new Map();
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const at = Number(block.afterIndex);
      if (!Number.isInteger(at) || at < 0 || at >= list.length) continue;
      const bucket = anchored.get(at);
      if (bucket) bucket.push(block);
      else anchored.set(at, [block]);
    }
  }
  const merged = [];
  for (let index = 0; index < list.length; index += 1) {
    merged.push(list[index]);
    const bucket = anchored.get(index);
    if (bucket) merged.push(...bucket);
  }
  return merged;
}

async function loadSubagentTranscript(target) {
  const query = new URLSearchParams();
  if (target.sessionId) query.set('sessionId', target.sessionId);
  if (target.sessionPath) query.set('path', target.sessionPath);
  query.set('limit', String(SUBAGENT_TRANSCRIPT_LIMIT));
  const body = await api(`/api/sessions/messages?${query.toString()}`);
  const timeline = toTimeline(mergeAnchoredBlocks(body?.messages, body?.blocks));
  // 顶部「它被要求」已经写了任务原文；时间轴第一条 ask 再写一遍就是重复
  const steps = timeline.steps.slice();
  if (steps.length && steps[0].kind === 'ask') {
    const same = steps[0].text.trim() === (target.task || timeline.task || '').trim();
    if (same || !(target.task || timeline.task)) steps.shift();
  }
  // 顶部三格用真实统计，不用卡片上那句摘要。带上 taskId：慢响应的 A 不能把统计
  // 写进后来打开的 B（sheet 自己按 taskId 校验，不匹配就丢掉）。
  subagentSheet?.update?.({
    taskId: target.taskId,
    steps: timeline.stats.stepCount,
    tools: timeline.stats.toolCount,
  });
  return steps;
}

/* 全屏看图（E12）：懒建，只有真点开图片时才建 DOM。 */
let imageViewer = null;
function openImageSet(items, index) {
  if (!imageViewer) {
    const host = document.body || document.documentElement;
    if (!host) return;
    imageViewer = createLightbox({ doc: document, mount: host });
  }
  imageViewer.open(items, index);
}

/* 生成状态的界面联动只有这一处。
 * 为什么收成一个函数：busy 有两个来源（渲染器的 onBusyChange、事件路由的 setBusy），
 * 两边各写一份就会出现「一边置了常亮、另一边不撤」的情况——真机上已经撞过一次：
 * 生成结束后 KEEP_SCREEN_ON 还挂在窗口上。 */
/** 上一次真正应用过的生成状态：只为调试日志与「原生报文去重」留着。
 *
 * 注意：**不能拿它拦住界面更新**。事件流里 busy 会重复上报（一次生成几十条），
 * 确实需要拦的是往原生壳发的报文；而 composer / settings 的 setBusy 本身幂等，
 * 多调几次没有代价。真机上撞过反例：夹具或外部代码直接改 S.busy 时，
 * 这里一旦提前 return，按钮就停在旧文案上——断线点「停止」会变成发消息。
 * （拦 UI 的版本让 tests/abort_pending 的第三个用例失败，已修。）
 */
let lastBusyApplied = null;
/** 上一次发给原生壳的常亮状态：这层才是真正需要去重的地方。 */
let lastScreenOnApplied = null;

function applyBusyUi(busy) {
  const on = Boolean(busy);
  if (DEBUG && on !== lastBusyApplied) console.info('[busy]', on);
  lastBusyApplied = on;
  composer.setBusy(on);
  settingsPanel.controller.setStreaming(on);
  // 生成中屏幕不要熄：长任务锁屏后 WebView 被冻结，回来还得靠对账补。
  // 桥不可用（桌面浏览器）时这里就是个空调用。
  // 重复的 busy 不上报（一次生成能收到几十条），只拦这一层。
  if (on === lastScreenOnApplied) return;
  lastScreenOnApplied = on;
  void nativeBridge.setKeepScreenOn?.(on);
}

/* 聊天区装配：渲染器、代码块复制、搜索定位、等首屏都在 chat-panel 里。
 * 这里只交出宿主侧的东西——两个状态袋子、头像、busy 联动、看图、翻页、历史容器；
 * 子代理回放顺手把「历史里仍在跑」的条目回灌给胶囊，跨模块，所以适配体留在这边。 */
const chatPanel = createChatPanel({
  document,
  getElement: $,
  rendererState,
  // 会话 / 身份 / 署名这些应用级字段还是从 S 读：渲染器自己那份只管「画到哪了」。
  appState: S,
  cardController,
  fileUrls,
  avatars: { paint: paintAvatar, agentUrlById: agentAvatarUrlById, userUrl: userAvatarUrl },
  flash,
  onBusyChange: (busy) => {
    applyBusyUi(busy);
  },
  // 摘要文案由 turn-summary 提供；渲染器只负责画，不反向依赖视图模式模块。
  formatSereneSummary: sereneSummary,
  // 历史里的子代理条目交给注入的视图画；没注入时渲染器行为与原版一致。
  // 顺手把「历史里仍在跑」的条目回灌给胶囊：胶囊只靠实时事件建，重开 App 后
  // 正在跑的分身会凭空消失（卡片还在、胶囊没了），这一步就是把两个来源对齐。
  renderSubagent: (entry, opts) => {
    const drawn = subagentView.render(entry, opts);
    if (drawn && entry && entry.type === 'subagent') {
      // 终态条目会被 bar 自己忽略（它只认还在跑的），不用在这里判状态
      subagentBar.consume({ type: 'content_block', block: entry }, { startUnknown: true });
    }
    return drawn;
  },
  // 全屏看图交给 lightbox 模块；渲染器只负责算出「哪几张图、点的是第几张」。
  openImageViewer: (items, index) => openImageSet(items, index),
  // 复制实现由这边注入：code-copy 与 chat-panel 都不 import message-actions。
  copyText: copyTextToClipboard,
  loadOlder: () => conv.loadOlderPage(),
  getHistoryView: () => conv.historyView,
});

const renderer = chatPanel.renderer;
const searchJump = chatPanel.searchJump;
/* 名字保持原样：搜索那次「打开会话 → 等首屏 → 定位」的时序靠它，改动只在这里收成引用。 */
const waitForTranscript = chatPanel.waitForTranscript;

// 模式一变就重画摘要；首屏再补一次，避免「设置说沉静、界面还是默认」的静默不一致。
applyViewMode = (mode) => {
  // 渲染器那半（摘要怎么画）归 chat-panel，这里不再直接碰 renderer.setViewMode
  chatPanel.setViewMode(mode);
  // 详情页跟同一个设置走：沉静下思考只留一行，点开才铺全文
  subagentSheet?.setViewMode?.(mode);
};
chatPanel.setViewMode(chatViewMode.current());
subagentSheet?.setViewMode?.(chatViewMode.current());

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

// 连接代次 / 重连定时器在 websocket-client 里，断线时排队的 abort 在 abort-queue 里；
// 这里只把状态对象、那个队列、DOM 反馈和业务回调接进去。
/* 闲聊特性实例。它在下面才构造，但 WS 回调可能先于装配完成被调到，
 * 所以用可空引用而不是闭包常量（常量在 TDZ 里取值会抛）。 */
let casual = null;
let features = null;

/* 断线告知（E9）：只在真断了一段时间后浮一条细条，恢复后自消。
 * 它用 fixed 定位、不改布局高度，所以网络拖一下聊天区不会跳。
 * 延迟到真的需要显示时才建：极简假 DOM 里可能连 body 都没有，不该在这一步就报错。 */
let connectionBanner = null;
function paintConnectionStatus(status) {
  if (!connectionBanner) {
    const host = document.body || document.documentElement;
    if (!host) return;
    connectionBanner = createConnectionBanner({ doc: document, mount: host });
  }
  connectionBanner.update(status);
}

const sockets = createWebsocketClient({
  state: S,
  abortQueue,
  getLocation: () => location,
  // 闲聊面板可以脱离会话单独打开；面板开着也算「有活干」，否则纯闲聊场景永远不会重连。
  shouldReconnect: () => Boolean(S.session) || Boolean(casual && casual.isOpen()),
  getResumeFields: () => streamState.resumeFields(),
  makeAbortFrame: (pending) => {
    if (!pending) return null;   // 队列空时不该走到这里；给个空帧比抛异常好排查
    return {
      type: 'abort',
      ...(S.session?.sessionId ? { sessionId: S.session.sessionId } : {}),
      sessionPath: pending.sessionPath,
      ...(pending.streamId ? { streamId: pending.streamId } : {}),
    };
  },
  debug: debugLog,
  // 状态回调只用来画细条；重连语义、退避参数、事件顺序都不归它管。
  onStatusChange(status) {
    paintConnectionStatus(status);
  },
  onReadyChange(ready) {
    if (ready) {
      $('connDot').className = 'dot on';
      composer.syncSendButton();
      // 连上以后闲聊靠推送，轮询退成兜底；断了再收回来。
      if (casual) casual.setSocketLive(true);
    } else {
      $('connDot').className = 'dot off';
      $('btnSend').disabled = true;
      if (casual) casual.setSocketLive(false);
    }
  },
  onError() {
    // 只是报错，不一定断线：不碰按钮可用性（等 close 再说）。
    $('connDot').className = 'dot off';
  },
  onUnavailable(reason, error) {
    // 这不是断线：重连没用，所以要有一句能行动的话，而不是那条「正在重连」的细条。
    $('connDot').className = 'dot off';
    flash(
      reason === 'unsupported'
        ? '当前应用内核没有 WebSocket，连不上 Hana；请更新系统 WebView 后重开'
        : '连接建立失败：' + (error?.message || '未知错误'),
      { detail: error ? String(error.stack || error) : '' },
    );
  },
  onMessage(data) {
    // 只记类型，不记内容：排查「有没有收到」时够用。
    if (data && typeof data.type === 'string') {
      debugEvents.push(data.type);
      if (debugEvents.length > 40) debugEvents.shift();
    }
    // 宿主在同一个 WS 上推五类 casual_* 事件（studio 订阅已放行）。它们不归会话路由器管，
    // 直接交给闲聊状态机；否则会被 event-router 的会话过滤丢掉。
    if (casual && casual.handleSocketMessage(data)) return;
    router.handleEvent(data);
  },
  onAbortFlushed() {
    renderer.finishTurn();
  },
});

/* 通知：原生桥在握手成功前恒为 unavailable，桌面浏览器里就是安静的空实现。
 * 权限在启动后主动请求一次：等回合结束才要权限的话，人往往已经切走了，那一轮通知会丢。 */
const nativeBridge = createNativeBridge({
  window,
  expectedOrigin: window.location.origin,
});

const notifications = createNotifications({
  notify: (title, body) => nativeBridge.notify(title, body),
  requestPermission: () => nativeBridge.requestPermission(),
  // 真机实测：应用切后台后 document.visibilityState 仍是 'visible'，只有 hasFocus() 变 false。
  // 光看 visibilityState 会把每一轮都当成「在前台」而全部抑制掉。
  // 壳自己也会在 onResume+有焦点时再拦一道。
  isForeground: () => document.visibilityState !== 'hidden' && document.hasFocus(),
  agentName: () => S.agentName || S.currentAgent?.name || 'Hana',
});

/* 系统分享进来的文字：只放进草稿，不自动发送。
 * 手机上的真实场景是「看到一段东西 → 分享 → 小鲸鱼」，人往往还没想好要问什么，
 * 自动发送等于替用户做决定，所以这里只负责把字送到他手边。 */
nativeBridge.onShare(({ text, title } = {}) => {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return;
  const chatVisible = $('view-chat') && !$('view-chat').hidden;
  if (chatVisible && S.session) {
    composer.setText(value);
  } else {
    // 首页的 id 是 view-list（不是 view-home）：show() 只认 view-login / view-list / view-chat，
    // 传错一个名字会把三个视图全藏起来，屏幕就白成一片。
    show('view-list');
    const home = $('homeInput');
    if (home) {
      home.value = value;
      try {
        home.dispatchEvent(new Event('input', { bubbles: true }));
        home.focus();
      } catch {
        // 值已经写进去了，事件派发不了不影响使用
      }
    }
  }
  flash(title ? `已收到分享：${title}` : '已收到分享内容，确认后发送', { level: 'info' });
});

/* 真机排障出口：只读、不含内容与凭据。
 * 手机上没法开 devtools 控制台时，靠它看「到底有没有收到事件、收到什么类型」。 */
const debugEvents = [];
if (typeof window !== 'undefined') {
  window.__hanaDebug = {
    state: () => ({
      sessionId: S.session?.sessionId || null,
      sessionPath: S.session?.path || null,
      wsReady: Boolean(S.wsReady),
      agent: S.currentAgent?.id || null,
    }),
    events: () => debugEvents.slice(),
    resumes: () => resumeCatchUpCount,
    clear: () => { debugEvents.length = 0; },
  };
}

/* 回到前台补一次历史。
 *
 * 真机上的问题：切后台期间 WebView 会被挂起或节流，错过的 WS 推送补不回来，
 * 于是“电脑上已经回复了，手机上还停在半边”。这里在重新获得焦点时补拉一次历史；
 * 不靠 visibilitychange，因为 Android WebView 切后台后 visibilityState 仍可能报 visible。 */
let resumeCatchUpTimer = null;
let resumeCatchUpCount = 0;

/**
 * 对齐当前会话的历史。
 *
 * 三个触发点：宿主权威 idle（onSessionIdle）、重新获得焦点、页面重新可见。
 * 前者防「跑完了但只收到半段」或「等待首字时只收到结束」；后两者防「切后台期间
 * 进程被系统杀掉，回来时页面是旧的」，也兼容本地已经 idle 的恢复。
 *
 * 400ms 防抖把同一轮里多个触发合并成一次请求。计时器会核对「排这次补拉的会话与身份」
 * 仍是当前归属：换会话/退出登录后旧计时器醒来必须自己作废，不能拿新会话发请求。
 */
function scheduleHistorySync() {
  const session = S.session;
  if (!session) return;
  // 历史刚刚才被对账取回来：同一个事件都没新来，再取一次不可能更新。
  // 真机上息屏恢复会因此多打一次 60KB / 3.4s 的完全相同的请求。
  // 只认对账（justReconciled），普通 loadHistory 之后的 idle 同步是正常补全，不能噤。
  if (typeof conv.justReconciled === 'function' && conv.justReconciled(2000)) {
    if (DEBUG) console.info('[app] history sync skipped: just reconciled');
    return;
  }
  const owner = S.principal;
  if (resumeCatchUpTimer) clearTimeout(resumeCatchUpTimer);
  resumeCatchUpTimer = setTimeout(() => {
    resumeCatchUpTimer = null;
    if (!S.session || S.session !== session || S.principal !== owner) return;
    resumeCatchUpCount += 1;
    void conv.loadHistory();
  }, 400);
}

function catchUpAfterResume() {
  scheduleHistorySync();
  void features?.get('feed')?.refresh?.();
}

window.addEventListener('focus', catchUpAfterResume);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') catchUpAfterResume();
});

/** 等 WebSocket 就绪；超时返回 false。取消条件（切会话）由发送方给。 */
function waitForWs(timeoutMs = 4000, shouldCancel) {
  return sockets.waitForReady(timeoutMs, shouldCancel);
}
function connectWS() {
  sockets.connect();
}

function dropConnection() {
  sockets.drop();
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

/* 事件分派：会话过滤、流式游标、各类型分支都在 event-router；这里只把
 * 渲染器 / 连接 / 卡片桥 / 历史重拉这几个下游接进去。 */
const router = createEventRouter({
  state: S,
  getElement: $,
  renderer,
  sockets,
  cardBridge,
  streamState,
  // 与 composer 同一份「刚发出去的那条」：回显靠它去重。
  echoGuard,
  flash,
  setBusy: (busy) => {
    applyBusyUi(busy);
  },
  loadSessions: () => sessionPanel.loadSessions(),
  loadHistory: () => conv.loadHistory(),
  chatSubtitle: (folder) => conv.chatSubtitle(folder),
  // context_usage 的数字存在副标题的家里：路由只转达，不自己留一份。
  setContextPercent: (pct) => conv.setContextPercent(pct),
  // 子代理的实时状态走 block_update / content_block，同样注入，不 import。
  handleSubagentEvent: (ev) => {
    const handled = subagentView.handleEvent(ev);
    // 输入框上方那条「谁在跑」的胶囊，和正文卡片共用同一份事件。
    subagentBar.consume(ev);
    return handled;
  },
  // 回合结束的旁路：只发手机通知。历史对齐统一走权威 idle（onSessionIdle），
  // 不再依赖某一类结束事件是否存在。
  onTurnEnd: (info) => {
    notifications.onTurnEnd(info);
  },
  // 宿主确认当前会话已空闲（整轮收尾，或没有活动轮但运行态已停）：对齐一次历史。
  onSessionIdle: () => {
    scheduleHistorySync();
    // 用户就在屏幕前看着这一轮跑完：把基线推到最新，回前台时才不会把自己看过的报成新回复。
    void refreshNoticeBaseline();
  },
  // 前台恢复对账：窗口到期（这段时间一条事件都没来）且仍在生成时，放行一次历史补拉。
  // 判断全在 conversation-controller：拿回来的历史如果比屏上这一轮更完整，才走整轮收尾；
  // 否则只合并不收尾。activityToken 用来在取历史期间再确认一次「真的没有再新事件」。
  onIdleReconcile: ({ activityToken }) => {
    void conv.reconcileAfterForeground({
      // 事件计数也交给控制器：同一批事件下重复对账不重复打上游。
      activityToken,
      isStillQuiet: () => router.activityCount() === activityToken,
      onRecovered: () => {
        router.completeIdleReconcile(activityToken);
        // 对账真的拿回了更完整的一轮，就说明「锁屏期间跑完了」。
        // 这里是唯一可靠的信号：会话列表里的时间戳只跟用户发消息走，
        // 助手跑完不一定会动它（真机验过）。
        const title = S.session?.title;
        flash(title ? `「${title}」有新回复` : '有新回复', { level: 'info' });
      },
    });
  },
  // 全局日报广播在 event-router 的会话归属过滤前转发。
  onFeedChanged: () => { void features?.get('feed')?.onChanged?.(); },
  debug: DEBUG,
});

/** 兼容旧调用点（__hana.handleEvent / 卡片回调）的薄入口。 */
function handleEvent(ev) {
  router.handleEvent(ev);
}

/* ------------------------------------------------------------------ */
/* 输入区                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 草稿落盘（B2）                                                     */
/* ------------------------------------------------------------------ */

/* 文字只存本机、不进任何请求：切会话、误触返回、杀进程都不该丢。
 * 写盘防抖 400ms（每次写要重排整个草稿包），失焦与切会话时立刻刷。 */
const draftStore = createDraftStore();
/* 聊天框还没有归属会话时的草稿键。必须是内部占位，不能复用首页输入框的 'home'：
 * 否则启动后首次打开会话时，聊天框会把（通常是空的）自己写进 home，
 * 把独立首页输入框已经持久化的草稿删掉。 */
const CHAT_DRAFT_NO_SESSION = '__chat-no-session__';
let draftKey = CHAT_DRAFT_NO_SESSION;
let draftTimer = null;

function draftInputEl() {
  return $('input');
}

function flushChatDraftNow() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  const input = draftInputEl();
  if (input) draftStore.save(draftKey, input.value);
}

function flushDraftNow() {
  flushChatDraftNow();
  // 首页那个大输入岛也要存：从首页打字打到一半被杀掉，回来还得看得到。
  const home = $('homeInput');
  if (home) draftStore.save('home', home.value);
}

function scheduleDraftSave() {
  const input = draftInputEl();
  if (!input) return;
  const text = input.value;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    draftStore.save(draftKey, text);
  }, 400);
}

/** 发出去/被手动清空的内容不该再从磁盘里复活。 */
function clearDraftFor(key) {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  draftStore.clear(key || draftKey);
}

function clearAllDrafts() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  for (const item of draftStore.list()) draftStore.clear(item.key);
}

/** 会话切进来之后：先把上一份落盘，再换成目标会话的草稿。 */
function restoreDraftForSession(session) {
  // 没有真实 path 的退化会话用自己的内部键，绝不落到首页输入框的 'home' 上。
  const next = session && session.path ? session.path : CHAT_DRAFT_NO_SESSION;
  // 同一个会话重开（历史重拉 / 回列表再进来）：输入框里的字仍属于它，
  // 不能拿磁盘里的旧草稿盖掉刚补的内容；只把还没跑的防抖写掉。
  if (next === draftKey) {
    if (draftTimer) flushChatDraftNow();
    return;
  }
  // 换归属：输入框里此刻的文字属于上一个会话，先记到它的键下。
  // 不能只在防抖计时器还在时才保存——已经落盘、或从列表直接切进来时它可能
  // 不存在，那样上一个会话的字会留在新会话的输入框里，下一笔输入就把两边
  // 草稿混在一起（draftKey 已是新会话，落盘却带着旧字）。
  // 只落当前会话这一份：首页草稿有自己的防抖，不能被切会话顺手改写。
  flushChatDraftNow();
  draftKey = next;
  // 引用属于上一条消息、也属于上一个会话：跟着归属一起收掉，
  // 否则它会拼进新会话的第一条发送（把上一个会话的正文带过去）。
  quoteBar.clear();
  const input = draftInputEl();
  if (!input) return;
  const saved = draftStore.get(next);
  // 目标会话的草稿说了算：没有草稿就是空串，不能留着上一个会话的文字。
  input.value = saved || '';
  autoGrow(input);
  if (composer && typeof composer.syncSendButton === 'function') composer.syncSendButton();
}

/* 发送 / 停止 / 图片附件托盘：单飞锁与等待连接在 send-controller，
 * 断线时排队补发在 websocket-client，这里只做「按钮与托盘」这一层。 */
const composer = createComposer({
  state: S,
  getElement: $,
  renderer,
  sockets,
  abortQueue,
  streamState,
  // 与 event-router 同一份「刚发出去的那条」。
  echoGuard,
  flash,
  waitForReady: waitForWs,
  autoGrow,
  onDraftCleared: () => {
    clearDraftFor();
    // 发成功了：下一条历史请求要绕过网关快照，不然刚发的那条会被旧快照盖掉。
    conv?.markTailDirty?.();
  },
  // 引用只在「发送成功」时按发起时的版本消费：等待期间改稿不影响它，
  // 等待期间改选的新引用也不会被这次发送误清（见 quote-bar 的 getVersion/consume）。
  captureQuote: () => quoteBar.getVersion(),
  consumeQuote: (token) => quoteBar.consume(token),
  // 引用块在这里拼进正文：输入框里只放用户自己写的字，发出去的才是「> 引用 + 正文」。
  prepareOutgoingText: (text) => quoteBar.applyTo(text),
});

/* 草稿监听挂一次：输入防抖存、失焦立刻存。*/
if (draftInputEl()) {
  draftInputEl().addEventListener('input', scheduleDraftSave);
  draftInputEl().addEventListener('blur', () => {
    if (draftTimer) flushDraftNow();
  });
}

/* 首页草稿：同样的防抖，但固定存在 'home' 键下。
 * 计时器提到模块作用域：首页发送成功移交后要停掉它并结算草稿——
 * 否则它会在输入框清空后再把已发送的文字写回存储。 */
let homeDraftTimer = null;

/**
 * 首页发送安全移交之后结算首页草稿。
 *  - 输入框仍是发出时那份：清空输入、删掉 'home' 草稿（成功发出去的文字不该复活）；
 *  - 等待期间用户又打了新内容：那份新内容归下一次发送，立即落盘保留。
 * 两种情况都先停掉旧防抖，避免它随后用旧值覆盖结算结果。
 */
function settleHomeDraftAfterHandoff(sentText) {
  const home = $('homeInput');
  if (!home) return;
  if (homeDraftTimer) {
    clearTimeout(homeDraftTimer);
    homeDraftTimer = null;
  }
  const current = String(home.value || '');
  if (current.trim() === sentText) {
    home.value = '';
    draftStore.clear('home');
    return;
  }
  draftStore.save('home', current);
}

if ($('homeInput')) {
  const saveHomeDraft = () => {
    homeDraftTimer = null;
    draftStore.save('home', $('homeInput').value);
  };
  $('homeInput').addEventListener('input', () => {
    if (homeDraftTimer) clearTimeout(homeDraftTimer);
    homeDraftTimer = setTimeout(saveHomeDraft, 400);
  });
  $('homeInput').addEventListener('blur', () => {
    if (homeDraftTimer) {
      clearTimeout(homeDraftTimer);
      saveHomeDraft();
    }
  });
  const savedHome = draftStore.get('home');
  if (savedHome && !$('homeInput').value) $('homeInput').value = savedHome;
}

/* 大图：点一下关掉 */
$('lightbox').addEventListener('click', () => {
  $('lightbox').hidden = true;
  $('lightboxImg').removeAttribute('src');
});

/* ------------------------------------------------------------------ */
/* 会话进出                                                            */
/* ------------------------------------------------------------------ */

/* 新建 / 打开 / 重载历史 / 退回列表 / 退出登录后的收尾都在 conversation-controller；
 * 导航代次（navEpoch）也只在那边维护，首页发送通过 navigationEpoch() 取快照。 */
const conv = createConversationController({
  state: S,
  document,
  getElement: $,
  api,
  renderer,
  composer,
  sockets,
  streamState,
  cardController,
  actionConfirmation,
  workspaceView,
  closeFilePreview: () => closeFilePreview(),
  show,
  loadSessions: (ns) => sessionPanel.loadSessions(ns),
  flash,
  sessionFolder: (s) => sessionPanel.sessionFolder(s),
  closeDrawer: () => sessionPanel.closeDrawer(),
  // 所有真实导航（新建 / 列表打开 / 首页发送打开）都从这里拿统一通知，
  // 模型 chip 跟着会话立即刷新，不在每个入口各写一遍。
  onSessionOpened: (session) => {
    // 详情 sheet 属于上一个会话的分身：换会话/重新打开才关。
    // 同一会话的历史重载只走 onTranscriptCleared，那里不关——否则「点开一个跑着的分身，
    // 父回合一收尾 sheet 就被关掉」。
    subagentSheet?.close?.('session');
    restoreDraftForSession(session);
    syncSessionModelChip(session);
    // 仓库面板只对 Code 会话有意义；Chat 会话里不给一个点开就说「没目录」的按钮。
    const repoBtn = $('btnRepo');
    if (repoBtn) repoBtn.hidden = session?.namespace !== 'code';
  },
  // 清屏时把子代理卡自己的节点引用一起收掉。视图不 import 会话控制器，反向也不 import 它。
  onTranscriptCleared: () => {
    subagentView.reset();
    // 只清胶囊：同一会话里的整页替换不该忘掉 taskId 的终态；换会话走 clear()
    subagentBar.clearChips?.();
  },
  // 发完消息 → 回列表 → 再点进来：那一页可能停在发送之前，气泡会随清屏一起没。
  pendingLocalSend: () => echoGuard.lastLocalUser,
});

/* ------------------------------------------------------------------ */
/* 消息搜索                                                            */
/* ------------------------------------------------------------------ */

/* 搜索整块搬到了 features/search.js：这里只登记，启动时装配。
 * 注册表放这里是因为入口按钮的插入顺序有意义：搜索按钮要先于闲聊按钮出现（闲聊拿它当锚点）。 */
const featureRegistry = createFeatureRegistry();

featureRegistry.register({
  name: 'search',
  register: (ctx) => {
    const feature = createSearchFeature({
      getElement: $,
      api,
      getNamespace: () => sessionPanel.namespace,
      openSession: (session) => {
        const norm = (p) => (typeof p === 'string' ? p.trim().replace(/\\/g, '/').toLowerCase() : '');
        const targetPath = norm(session?.path);
        const cached = (Array.isArray(S.sessions) ? S.sessions : []).find(
          (s) => s && norm(s.path) === targetPath,
        );
        const merged = {
          ...(cached || {}),
          ...session,
          agentId: session?.agentId || cached?.agentId || null,
          agentName: session?.agentName || cached?.agentName || null,
          cwd: session?.cwd || cached?.cwd || null,
          workspaceMountId: session?.workspaceMountId || cached?.workspaceMountId || null,
          workspaceLabel: session?.workspaceLabel || cached?.workspaceLabel || null,
          namespace: session?.namespace || cached?.namespace || 'home',
        };
        // 搜索过来的：打开之后按文字定位。原词、snippet、命中类型、会话总条数一并交给模块，
        // 它自己决定试哪些锚点、翻几页、找不到时退到哪里；上限、超时、取消也都在模块里，
        // 这里只负责传参、收起上一次、把提示接给 flash。
        searchJump.cancel();
        const opened = conv.openSession(merged);
        if (merged.locateQuery) {
          void opened.then(waitForTranscript).then(() => searchJump.locate({
            query: merged.locateQuery,
            snippet: merged.locateSnippet,
            matchKind: merged.locateMatchKind,
            messageCount: merged.messageCount,
          }));
        }
      },
      document,
    });
    feature.mount();
    ctx.expose('search', feature);
    return { dispose: () => feature.close() };
  },
});

/* ------------------------------------------------------------------ */
/* 闲聊（Casual Chat）                                                  */
/*                                                                      */
/* 跟会话是两条通道：闲聊不走 WS 会话协议，也没有 jsonl 会话，全靠        */
/* /api/casual/* 的 HTTP 接口，因此这里用轮询而不是订阅。四个模块各自    */
/* 零依赖，这里只做装配，不把业务逻辑写回 app.js。                          */
/* ------------------------------------------------------------------ */

/* 闲聊整块搬到了 features/casual.js：这里只登记、启动，并把它暴露出来。
 * 依赖注入式装配，业务逻辑一条都不留在 app.js。 */
featureRegistry.register({
  name: 'feed',
  register: (ctx) => {
    const feature = createFeedFeature({
      api,
      document,
      window,
      getIdentity: () => S.principal,
      getNavigationEpoch: () => conv.navigationEpoch(),
      getSession: () => S.session,
      openSession: (session) => conv.openSession(session),
      sendPrepared: (input) => composer.sendPrepared(input),
      toast: flash,
    });
    feature.mount();
    ctx.expose('feed', feature);
    return { dispose: () => feature.dispose() };
  },
});

featureRegistry.register({
  name: 'archive',
  register: (ctx) => {
    const feature = createArchiveFeature({
      getElement: $,
      api,
      flash,
      // 还原后活跃列表要重新拉：会话文件从 archived/ 移回来了，本地列表不会自己知道。
      onRestored: () => { void sessionPanel.loadSessions(); },
      document,
    });
    feature.mount();
    ctx.expose('archive', feature);
    return { dispose: () => feature.close() };
  },
});

featureRegistry.register({
  name: 'casual',
  // 闲聊入口把搜索按钮当锚点，必须先有它。
  dependsOn: ['search'],
  register: (ctx) => {
    const feature = createCasualFeature({
      // currentAgent 是登录后由 boot() 补上的（见 S.currentAgent 的赋值），S 的字面量里没有
      // 这一项，而特性那边要求必填。这里只补类型，不动 S 的运行期形状。
      state: /** @type {typeof S & {currentAgent: object|null}} */ (S),
      getElement: $,
      api,
      flash,
      avatarUrl: agentAvatarUrl,
      document,
    });
    feature.mount();
    ctx.expose('casual', feature);
    return { dispose: () => feature.close() };
  },
});

features = featureRegistry.start();
casual = features.get('casual');

/* ------------------------------------------------------------------ */
/* 导航与主页事件                                                      */
/* ------------------------------------------------------------------ */

$('btnHomeSend')?.addEventListener('click', sendFromHome);
$('homeInput')?.addEventListener('keydown', (e) => {
  if (!composer.isSendEnter(e)) return;
  e.preventDefault();
  sendFromHome();
});
// 抽屉的三个开关（btnOpenDrawer / btnPeekRecent / btnCloseDrawer）与 drawerMask 的点击
// 都在 session-panel 里一起建、一起 dispose；这里不再重复接线。
// 接入方式：壳里拦截 hana-setup:// 弹原生对话框（本页与壳同源、且是用户手势才会被受理）。
// 侧边栏一个，登录页一个——登录页还没有侧边栏可点。
const openServerMode = () => { location.href = 'hana-setup://edit-url'; };
// 抽屉底部整行就是设置入口（div[role=button]）：回车与空格也要能开，不然只有触屏能用。
const footSettings = $('btnSettings');
footSettings?.addEventListener('click', openSettings);
footSettings?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openSettings();
});
// 这两个 chip 以前是死的（只有标记没有接线）：思考模式和模型都收进设置面板
$('btnHomeThinking')?.addEventListener('click', openSettings);
$('homeModelChip')?.addEventListener('click', openSettings);
$('btnLoginServerMode')?.addEventListener('click', openServerMode);

$('btnBack').addEventListener('click', () => {
  const feedFeature = features?.get?.('feed');
  if (feedFeature?.back?.()) return;
  conv.backToList();
  syncSessionModelChip(null);
});

/*
 * Android 壳通过 evaluateJavascript 调这一个入口，没有原生桥、也没有别的能力。
 * 只有一个返回函数，别的什么都不能从这里够到（卡片 iframe 更够不到）。
 * 冻结一下，避免后续脚本把它换成别的东西。
 */
window.HanaMobile = Object.freeze({
  back: () => {
    // 先落盘再走：输入是 400ms 防抖写的，连按返回时上一次输入可能还没写完（E6）。
    // 只保存、不拦截：现在草稿不会丢，没必要为它多弹一次确认框。
    flushDraftNow();
    if (composer.back()) return true;
    if (typeof settingsPanel.isOpen === 'function' && settingsPanel.isOpen()) {
      settingsPanel.close();
      return true;
    }
    const archiveFeature = features?.get?.('archive');
    if (archiveFeature && typeof archiveFeature.isOpen === 'function' && archiveFeature.isOpen()) {
      archiveFeature.close();
      return true;
    }
    const casualFeature = features?.get?.('casual');
    if (casualFeature && typeof casualFeature.back === 'function' && casualFeature.back()) {
      return true;
    }
    // 会话菜单先收子场景（确认态 / 重命名），再关整张菜单
    if (sessionActionsView?.back?.()) return true;
    const searchFeature = features?.get?.('search');
    if (searchFeature && typeof searchFeature.isOpen === 'function' && searchFeature.isOpen()) {
      searchFeature.close();
      return true;
    }
    // 底部菜单盖在最上面，再是设置面板，最后才轮到列表返回
    if (messageActionsMenu && typeof messageActionsMenu.isOpen === 'function' && messageActionsMenu.isOpen()) {
      messageActionsMenu.close();
      return true;
    }
    const feedFeature = features?.get?.('feed');
    if (feedFeature && typeof feedFeature.back === 'function' && feedFeature.back()) return true;
    // 子代理详情盖在会话之上，先关它，再轮到会话列表
    if (subagentSheet && typeof subagentSheet.isOpen === 'function' && subagentSheet.isOpen()) {
      subagentSheet.close('api');
      return true;
    }
    const handled = conv.backToList();
    if (!S.session) {
      syncSessionModelChip(null);
    }
    return handled;
  },
});

/* 「...」目前只有「原始事件」抽屉一个用途，是开发排障出口，对普通用户没有意义：
 * 它只在带 ?debug 启动时才有内容，平时点开就是一片黑。所以平时干脆不显示。 */
const debugBtn = $('btnMenu');
if (DEBUG) {
  if (debugBtn) {
    debugBtn.hidden = false;
    debugBtn.addEventListener('click', () => {
      const drawer = $('debug');
      drawer.hidden = !drawer.hidden;
    });
  }
}

$('btnDebugClose')?.addEventListener('click', () => { $('debug').hidden = true; });

// 首页工作区入口
$('homeWorkspaceChip')?.addEventListener('click', async () => {
  const agentId = S.currentAgent?.id;
  // listRoots() 返回的是 { ok, studioId, workspaces }（也兼容老后端直接给数组），
  // 两种形状下面都要接，所以这里按 any 记；展开前用 Array.isArray 逐个判。
  /** @type {any} */
  let roots = [];
  try {
    roots = await workspaceService.listRoots();
  } catch (err) {
    flash('获取具名工作区列表失败，已使用默认工作区');
  }
  const allRoots = [
    { mountId: 'default', agentId, label: 'Agent 默认工作区' },
    // listRoots() 返回的是 { workspaces: [...] }，不是数组；直接用会把具名根全丢掉
    ...(Array.isArray(roots?.workspaces) ? roots.workspaces : Array.isArray(roots) ? roots : []),
  ];
  workspaceView.setRoots(allRoots);
  workspaceView.open({ mountId: 'default', agentId, label: 'Agent 默认工作区' });
});

// 聊天页仓库入口（仅 Code 会话可见，显隐由 onSessionOpened 控制）
$('btnRepo')?.addEventListener('click', () => openCodePanel());

// 聊天页工作区入口
$('btnWorkspace')?.addEventListener('click', async () => {
  const agentId = S.session?.agentId;
  if (!agentId) {
    flash('无法确认当前会话所属智能体，请回首页选择工作区');
    return;
  }
  // 同首页入口：listRoots() 给的是 { workspaces: [...] }，老后端也可能是数组。
  /** @type {any} */
  let roots = [];
  try {
    roots = await workspaceService.listRoots();
  } catch (err) {
    flash('获取具名工作区列表失败，已使用默认工作区');
  }
  const allRoots = [
    { mountId: 'default', agentId, label: 'Agent 默认工作区' },
    // 同首页入口：listRoots() 返回 { workspaces: [...] }，不能当数组展开
    ...(Array.isArray(roots?.workspaces) ? roots.workspaces : Array.isArray(roots) ? roots : []),
  ];
  workspaceView.setRoots(allRoots);
  workspaceView.open({ mountId: 'default', agentId, label: 'Agent 默认工作区' });
});

/* ------------------------------------------------------------------ */
/* 调试                                                                */
/* ------------------------------------------------------------------ */

function debugLog(dir, obj) {
  if (!DEBUG) return;
  const body = $('debugBody');
  const line = `${dir} ${JSON.stringify(obj)}\n`;
  body.textContent = (body.textContent + line).slice(-20000);
  body.scrollTop = body.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/* 窗口与页面生命周期：键盘/视口、前后台切换、pagehide、错误兜底都在 mobile-lifecycle。 */

const lifecycle = createMobileLifecycle({
  state: S,
  document,
  window,
  getElement: $,
  renderer,
  connectWS,
  // 回到前台的那一次重连之后开一个对账窗口（窗口时长在 event-router 的常量里，2s）；
  // 进后台/失焦/卸载时把窗口一起作废。正常前台使用、切会话、发送消息都不会开窗。
  onForegroundResume: () => {
    router.beginIdleReconcile();
    // 壳会在 onPause 无条件清掉常亮，回到前台时如果还在生成得自己再要一次。
    void nativeBridge.setKeepScreenOn?.(Boolean(S.busy));
    // 离开期间跑完的会话：问一次摘要做差，提示一句。
    void resumeNotice();
  },
  onForegroundSuspend: () => {
    router.cancelIdleReconcile();
  },
  actionConfirmation,
  // mobile-lifecycle 只在这两个槽位上调 dispose()：把四个抽屉监听、目录控制器与
  // Chat / Code 标签一起收干净。面板的 dispose 幂等，两个槽位共用一个适配对象。
  sessionListController: sessionPanelDispose,
  namespaceTabs: sessionPanelDispose,
  probeBuild: LAYOUT_PROBE_BUILD,
  // 真机取证要知道「跑的是哪个入口脚本」，所以把 app 自己的 URL 报进去。
  probeModuleUrl: import.meta.url,
  debug: DEBUG,
});

(async function main() {
  lifecycle.watchErrors();

  installCardHeightBridge();
  lifecycle.watchKeyboard();
  lifecycle.installLayoutProbe();
  lifecycle.watchPagehide();

  if (DEBUG) {
    try {
      window.__hana = {
        appendUser: renderer.appendUser, addAssistantText: renderer.addAssistantText,
        addThinking: renderer.addThinking, addTool: renderer.addTool,
        appendSystem: renderer.appendSystem, startAssistantTurn: renderer.startAssistantTurn,
        finishTurn: renderer.finishTurn, mediaGrid: renderer.mediaGrid,
        openLightbox: renderer.openLightbox, addFiles: composer.addFiles,
        paintSessions: (list) => sessionPanel.paint(list),
        sessionRow: (s) => sessionPanel.row(s), S, sendMessage: composer.sendMessage,
        updateHeroCompanion, api, handleEvent, openSession: conv.openSession, streamState,
        ensureAuth, actionConfirmation, workspaceView, workspaceService,
        cardBridge, cardController, getActiveContext, flash,
        // 修复回归用的入口：都是本模块里本来就有的函数，不是为测试新开的分支。
        abortTurn: composer.abortTurn, connectWS, newSession: conv.newSession,
        sendFromHome, loadHistory: conv.loadHistory, loadOlderPage: conv.loadOlderPage,
        renderAttachBar: composer.renderAttachBar, clearAttach: composer.clearAttach,
        fileHrefFor, ensureFileRoots, resetFileRoots,
        fileUrls,
        isSendEnter: composer.isSendEnter, nearBottom: renderer.nearBottom,
        backToList: conv.backToList,
        renderer, rendererState, composer,
        settingsView: settingsPanel.view, messageActionsMenu, sessionActionsView,
        settingsController: settingsPanel.controller, loginController,
        sessionActions,
        casual, features, selectAgent,
        resetAfterLogout,
      };
    } catch (err) {
      console.warn('[hana] debug hook failed', err);
    }
  }
  try {
    if (await ensureAuth()) await boot();
  } catch (err) {
    lifecycle.fatal('启动失败：' + (err?.message || err));
    show('view-list');
  }
})();
