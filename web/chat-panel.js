/* web/chat-panel.js
 *
 * 聊天区装配（D1-剩余：把 app.js 里最后一块、也是最大的一块接线整块迁出）。
 *
 * 职责：
 *   1. 建 chat-renderer：十来个注入位（渲染进度袋子、应用级状态、取节点、历史容器、
 *      卡片控制器、文件地址、头像、busy 回报、摘要文案、历史子代理回放、渲染后钩子、
 *      全屏看图）一次接好。渲染器自己的依赖一个都不 import，全部由这里收进来再交出去；
 *   2. 代码块复制的安装：root 固定是 #transcript（事件委托的挂点），复制实现由宿主注入——
 *      code-copy 不 import message-actions，这个模块也不；
 *   3. waitForTranscript：最多等 2 秒（20 轮 × 100ms）让消息区出现第一屏子节点。
 *      openSession 的 Promise 回来时首屏有时还差一帧，搜索定位常在那之前就跑，拿到一次
 *      空扫描还会被当成「没有更多历史」。这段逻辑逐字搬自 app.js，不要「优化」成微任务；
 *   4. search-jump 的装配：findTurnByText 必须把容器绑上——模块要的是 (query) => Element，
 *      而渲染器交出来的是 (container, query) => Element。不包这层，模块会拿 query 当容器，
 *      永远返回 null（真机踩过，见 tests/chat_panel.test.mjs 的反向用例）；
 *   5. setViewMode：转发给渲染器（沉静 / 经典怎么画归渲染器）。
 *
 * 不负责：
 *   - 视图模式的读写与落库（chat-view-mode 留在 app.js，首屏那次 setViewMode 也由 app 调）；
 *   - 子代理详情页（subagent-sheet 的开合与它那一半 setViewMode 留在 app.js 的 hook 里）；
 *   - 全屏看图怎么建 DOM（lightbox 懒建留在 app.js，这里只把渲染器的调用转发给注入实现）；
 *   - busy 的界面联动（applyBusyUi 在 app.js：composer / 设置面板 / 原生常亮都在那边，这里只回调）；
 *   - 「历史里仍在跑的条目回灌胶囊」这类跨模块对齐（renderSubagent 的适配体在 app.js）。
 *
 * 依赖注入：模块自己不读全局状态、不 import app、不认识 S。document / getElement / 两个状态
 * 袋子 / 复制实现全部由装配层传；单测缝只有 createRenderer（装配层测试用它换成假渲染器，
 * 验证 setViewMode 真的转发出去），生产装配不传。提示与滚动不开放注入：模块内就有确定的默认实现
 * （提示转给 flash 的 info 层，滚动带老 WebView 降级），多开两个口子只会让契约变长。
 */

import { createChatRenderer, findTurnByText } from './chat-renderer.js';
import { createSearchJump } from './search-jump.js';
import { installCodeCopy } from './code-copy.js';

/** 等首屏的子节点：最多 20 轮，每轮 100ms（合计 2 秒）。原样搬自 app.js。 */
const TRANSCRIPT_WAIT_ROUNDS = 20;
const TRANSCRIPT_WAIT_MS = 100;

/**
 * 默认的滚动实现：优先带 options 的平滑居中，老 WebView 不认就退化成直接对齐。
 * 滚动只是增强，滚不动不影响「已经找到了」这个结论，所以两层都吞掉异常。
 */
function defaultScrollIntoView(el) {
  try {
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  } catch {
    // 老 WebView 不认 options：退化成直接对齐
    try { el?.scrollIntoView?.(); } catch { /* 没有布局就算了 */ }
  }
}

/**
 * 创建聊天区装配。
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂；代码块按钮与 search-jump 都用它，缺了就报错
 * @param {(id: string) => any} [options.getElement] 按 id 取节点（app 传 `$`，即 document.getElementById）
 * @param {any} [options.rendererState] 渲染进度袋子（renderer-state.js 的实例）：只管「画到哪了」
 * @param {any} [options.appState] 应用级状态（app 传 S）：会话 / 身份 / 署名从这里读
 * @param {any} [options.cardController] 卡片渲染（card-controller.js 的实例），可缺
 * @param {any} [options.fileUrls] 会话文件的两个地址（file-urls.js 的实例），可缺
 * @param {{paint?: Function, agentUrlById?: Function, userUrl?: Function}} [options.avatars]
 *   三个头像钩子：画头像、按 id 取 Agent 头像、当前用户头像
 * @param {Function} [options.flash] 提示条（定位失败的提示转给它），可缺
 * @param {(busy: boolean) => void} [options.onBusyChange] 一轮开始/结束/重置时回报给宿主
 * @param {Function} [options.formatSereneSummary] 沉静摘要文案（turn-summary 的 sereneSummary）
 * @param {Function} [options.renderSubagent] 历史里的子代理条目交给宿主视图画
 * @param {Function} [options.openImageViewer] 全屏看图：(items, index) => void
 * @param {(text: string) => Promise<any>} [options.copyText] 复制实现（message-actions 的 copyTextToClipboard）
 * @param {(() => Promise<boolean>)|null} [options.loadOlder] 往前翻一页（app 传 `() => conv.loadOlderPage()`）
 * @param {Function} [options.getHistoryView] 历史容器（app 传 `() => conv.historyView`）
 * @param {Function} [options.onBlocksRendered] 宿主附加的「渲染后」钩子，排在代码块复制之后
 * @param {Function} [options.showHint] 定位结束时的用户可见提示；默认 `flash(text, { level: 'info' })`
 * @param {((el: Element) => void)|null} [options.scrollIntoView] 滚动实现；默认带老 WebView 降级
 * @param {Function} [options.createRenderer] 单测缝：默认 createChatRenderer
 * @returns {{
 *   renderer: any,
 *   searchJump: { locate: Function, cancel: Function, isLocating: Function, dispose: Function },
 *   codeCopy: { sync: (scope?: Element) => number },
 *   waitForTranscript: () => Promise<void>,
 *   setViewMode: (mode: string) => void,
 * }}
 */
export function createChatPanel({
  document: doc,
  getElement,
  rendererState,
  appState,
  cardController = null,
  fileUrls = null,
  avatars = {},
  flash = null,
  onBusyChange = () => {},
  formatSereneSummary = null,
  renderSubagent = null,
  openImageViewer = null,
  copyText = null,
  loadOlder = null,
  getHistoryView = null,
  onBlocksRendered = null,
  // 单测缝：生产装配（app.js）不传，走真渲染器；这里只让装配层可被假实现替换。
  createRenderer = createChatRenderer,
} = {}) {
  if (!doc) throw new TypeError('createChatPanel requires { document }');
  if (typeof getElement !== 'function') throw new TypeError('createChatPanel requires { getElement }');
  if (!rendererState) throw new TypeError('createChatPanel requires { rendererState }');
  if (!appState) throw new TypeError('createChatPanel requires { appState }');
  if (typeof copyText !== 'function') throw new TypeError('createChatPanel requires { copyText }');

  const {
    paint: paintAvatar = null,
    agentUrlById = null,
    userUrl = null,
  } = avatars || {};

  const notify = typeof flash === 'function' ? flash : () => {};

  /* 代码块复制先装：渲染器的 onBlocksRendered 要引用它，建渲染器之前就得有实例。
   * root 固定是消息区（事件委托挂点）；复制实现由宿主注入，模块自己不碰剪贴板。 */
  const codeCopy = installCodeCopy({ root: getElement('transcript'), doc, copy: copyText });

  const renderer = createRenderer({
    state: rendererState,
    // 会话 / 身份 / 署名这些应用级字段还是从 appState 读：渲染进度袋子里不装它们。
    appState,
    getElement,
    getHistoryView,
    cardController,
    fileUrls,
    paintAvatar,
    agentAvatarUrlById: agentUrlById,
    userAvatarUrl: userUrl,
    flash,
    onBusyChange,
    // 摘要文案由 turn-summary 提供；渲染器只负责画，不反向依赖视图模式模块。
    formatSereneSummary,
    // 历史里的子代理条目交给注入的视图画；没注入时渲染器行为与原版一致。
    renderSubagent,
    // 每次有新内容上屏（含流式重绘）后补一次代码块复制按钮：代码块是
    // `innerHTML = renderMarkdown(...)` 重画出来的，只在挂载时同步一次不够。
    onBlocksRendered: (node) => {
      codeCopy.sync(node);
      if (typeof onBlocksRendered === 'function') onBlocksRendered(node);
    },
    // 全屏看图交给宿主注入的 lightbox；渲染器只算「哪几张图、点的是第几张」。
    openImageViewer,
  });

  /**
   * 等消息区真的有内容。
   *
   * openSession 的 Promise 回来时首屏有时还差一帧：真机上定位常常在 turn 节点插进去之前就跑了，
   * 拿到的是一次空扫描，还被当成「没有更多历史」，定位直接放弃。这里最多等 2 秒，超时就交给
   * 定位模块自己攒。
   */
  async function waitForTranscript() {
    for (let i = 0; i < TRANSCRIPT_WAIT_ROUNDS; i += 1) {
      // 判据是「真的有轮次」，不是「有子节点」：历史控制带（.history-pagination-bar）
      // 在 pager 发请求前就 emitState 插进 #transcript，按 children.length 判会立刻返回，
      // 等于这条等待不存在（装配到 app 后就是这样，定位又变成扫空屏）。
      const box = getElement('transcript');
      if (box && typeof box.querySelector === 'function' && box.querySelector('.turn')) return;
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_WAIT_MS));
    }
  }

  const searchJump = createSearchJump({
    document: doc,
    getContainer: () => getElement('transcript'),
    // 模块要的是 (query) => Element；chat-renderer 交出来的是 (container, query) => Element，
    // 这里必须把容器绑上。不绑的话它拿 query 当容器，永远返回 null（真机踩过）。
    findTurnByText: (query) => findTurnByText(getElement('transcript'), query),
    loadOlder,
    // 标题命中、正文里实在没有锚点时，模块会滚回会话开头并调这里说一句——没这句话用户只会
    // 以为搜索没生效（真机反馈）。
    showHint: (text) => notify(text, { level: 'info' }),
    scrollIntoView: defaultScrollIntoView,
  });

  /** 视图模式只转发：首屏那次由 app 调，之后每次切换由 app 的 applyViewMode 调。 */
  function setViewMode(mode) {
    renderer.setViewMode(mode);
  }

  return { renderer, searchJump, codeCopy, waitForTranscript, setViewMode };
}
