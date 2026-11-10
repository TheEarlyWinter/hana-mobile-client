/* web/session-panel.js
 *
 * 历史会话抽屉 + 会话列表接线（D1 第一步：从 app.js 整块迁出）。
 *
 * 职责：
 *   - 抽屉开合：只动 mask.hidden、面板的 'open' class 与 aria-hidden 三样，
 *     不改 id / class 名 / 样式，别的状态一概不碰；
 *   - 目录筛选的接线：Chat / Code 标签、新建按钮文案、list controller 的四个回调；
 *   - 列表的薄适配：loadSessions / paint / row / sessionFolder，让 app.js 的启动、
 *     刷新、前后台恢复、搜索、归档与 DEBUG 出口继续按原签名调用。
 *
 * 不负责：会话行怎么画（session-list-view）、请求与筛选竞态（session-list-controller）、
 * 打开会话与行菜单背后的业务（由宿主注入 onOpenSession / onRowAction）。
 *
 * 依赖注入：document 用来建标签与按钮视图，getElement 用来取抽屉节点，api 交给
 * list controller；模块自己不读全局状态、不 import app。
 */

import { sessionFolder as sessionFolderBase } from './session-list-view.js';
import { createSessionListController } from './session-list-controller.js';
import { createSessionNamespaceTabs } from './session-namespace-tabs.js';
import { createNewSessionLabel } from './new-session-label.js';

/**
 * 创建会话面板（抽屉 + 列表接线）。
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂，杜绝全局隐式读取
 * @param {(id: string) => (Element|null|undefined)} [options.getElement] 取抽屉节点（app 传 `$`）
 * @param {(pathname: string) => Promise<any>} [options.api] 同源请求函数，交给 list controller
 * @param {object} [options.sessionListView] 会话列表视图（render / row / showLoading / showError）
 * @param {object|null} [options.sessionActionsView] 会话操作菜单视图（setList），可缺
 * @param {(s: object) => void} [options.onOpenSession] 行级：打开会话（宿主组装）
 * @param {(s: object) => void} [options.onRowAction] 行级：长按/右键开菜单（宿主组装）
 * @param {(list: object[]) => void} [options.onSessionsLoaded] 列表数据的落地回调，宿主据此维护 S.sessions
 * @param {() => string} [options.homeFolderOf] 会话文件夹兜底（宿主传 `() => S.homeFolder`）
 * @returns {{
 *   openDrawer: () => void, closeDrawer: () => void, isDrawerOpen: () => boolean,
 *   loadSessions: (namespace?: string) => Promise<object[]|undefined>,
 *   paint: (list: object[]) => void, row: (s: object) => Element,
 *   sessionFolder: (s: object) => string, reset: () => void, dispose: () => void,
 *   readonly namespace: string,
 * }}
 */
export function createSessionPanel({
  document: doc,
  getElement,
  api,
  sessionListView,
  sessionActionsView = null,
  onOpenSession = () => {},
  onRowAction = () => {},
  onSessionsLoaded = () => {},
  homeFolderOf = () => '',
} = {}) {
  if (!doc) throw new TypeError('createSessionPanel requires { document }');
  if (typeof getElement !== 'function') throw new TypeError('createSessionPanel requires { getElement }');
  if (!sessionListView) throw new TypeError('createSessionPanel requires { sessionListView }');

  const view = sessionListView;
  const actionsView = sessionActionsView;

  /*
   * 行级回调（onOpenSession / onRowAction）由宿主组装后传进来，但真正的绑定点在
   * 列表视图的构造处（视图自己管长按计时与「长按后吞掉 click」）。这里不再绑一次：
   * 同一行绑两次会让一次点击打开两次会话、菜单弹两次。参数保留在契约里，是为了
   * 「行级交互归面板」的形状——需要面板自己产行的入口时直接用它俩。
   */
  void onOpenSession;
  void onRowAction;

  /* ---------------------------------------------------------------- */
  /* 抽屉                                                              */
  /* ---------------------------------------------------------------- */

  // 抽屉开合只有三件事：遮罩 hidden、面板 'open' class、aria-hidden。
  // 别再往里加状态：CSS 与壳都按这套约定判断开合。
  function openDrawer() {
    const mask = getElement('drawerMask');
    const panel = getElement('drawerPanel');
    if (mask) mask.hidden = false;
    if (panel) {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
  }

  function closeDrawer() {
    const mask = getElement('drawerMask');
    const panel = getElement('drawerPanel');
    if (mask) mask.hidden = true;
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
  }

  /** 抽屉现在是不是开着：app 用它决定「头像到了要不要重画列表」。 */
  function isDrawerOpen() {
    const panel = getElement('drawerPanel');
    return Boolean(panel && panel.classList && panel.classList.contains('open'));
  }

  /* ---------------------------------------------------------------- */
  /* 列表接线                                                          */
  /* ---------------------------------------------------------------- */

  // 列表筛选与请求竞态只由 controller 维护；视图、tabs、新建按钮文案在这里接线。
  // tabs 先建：它的 onChange 只回传点击，真正加载交给下面的 loadSessions（函数声明会提升）。
  const namespaceTabs = createSessionNamespaceTabs({
    document: doc,
    onChange: (namespace) => loadSessions(namespace),
  });

  // 新建按钮的文案跟着当前筛选走（Chat / Code）。
  const newSessionLabel = createNewSessionLabel({ document: doc });

  const controller = createSessionListController({
    api,
    onLoading: () => {
      view.showLoading();
      // 换筛选时先丢掉上一份目录数据（宿主据此清 S.sessions），
      // 避免请求失败后还留着另一 namespace 的行。
      onSessionsLoaded([]);
    },
    onLoaded: (list) => {
      onSessionsLoaded(list);
      view.render(list);
      actionsView?.setList(list);
    },
    onError: (error) => view.showError(error),
    onNamespaceChange: (namespace) => {
      namespaceTabs.setNamespace(namespace);
      // 列表切到哪个模式，新建按钮就写哪个模式，不留在 Chat。
      newSessionLabel.setNamespace(namespace);
    },
  });

  namespaceTabs.setNamespace('home');
  newSessionLabel.setNamespace('home');

  /** 现有入口的薄适配：不保存筛选、不处理竞态，全部交给 controller。 */
  function loadSessions(namespace) {
    return controller.load(namespace);
  }

  /** 重绘整张列表（DEBUG / 回归入口与启动时头像就绪后的补画都走这里）。 */
  function paint(list) {
    view.render(list);
  }

  /** 取一行（DEBUG / 回归入口用），行内交互仍由视图自己绑。 */
  function row(s) {
    return view.row(s);
  }

  /** 会话所属文件夹展示名：行里没带目录时用宿主的 homeFolder 兜底。 */
  function sessionFolder(s) {
    return sessionFolderBase(s, homeFolderOf());
  }

  /**
   * 登录身份换人后的复位：废弃在途目录请求、筛选回 Chat、新建按钮文案一起回 Chat。
   * 不触发请求（controller.reset 只回退筛选），列表清空由宿主自己 paint。
   */
  function reset() {
    controller.reset();
    namespaceTabs.setNamespace('home');
    newSessionLabel.setNamespace('home');
  }

  /* ---------------------------------------------------------------- */
  /* 事件与销毁                                                        */
  /* ---------------------------------------------------------------- */

  const bindings = [];
  function bindClick(id, handler) {
    const node = getElement(id);
    if (!node || typeof node.addEventListener !== 'function') return;
    node.addEventListener('click', handler);
    bindings.push([node, 'click', handler]);
  }

  bindClick('btnOpenDrawer', openDrawer);
  bindClick('btnPeekRecent', openDrawer);
  bindClick('btnCloseDrawer', closeDrawer);
  bindClick('drawerMask', closeDrawer);

  let disposed = false;

  /**
   * 页面卸载 / 测试收尾：摘掉四个 DOM 监听，并让 controller 与标签一起失效。
   * 幂等——mobile-lifecycle 的 pagehide 对 controller 与 tabs 各调一次，都会落到这里。
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [node, type, handler] of bindings) {
      if (typeof node.removeEventListener === 'function') node.removeEventListener(type, handler);
    }
    bindings.length = 0;
    controller.dispose();
    namespaceTabs.dispose();
  }

  return {
    openDrawer,
    closeDrawer,
    isDrawerOpen,
    loadSessions,
    paint,
    row,
    sessionFolder,
    reset,
    dispose,
    // 当前筛选的唯一来源是 controller（它同时也管竞态）；reset 后自动回到 'home'。
    get namespace() {
      return controller.getNamespace();
    },
  };
}
