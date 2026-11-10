/* web/settings-panel.js
 *
 * 设置面板装配（D1 第三步：从 app.js 整块迁出）。
 *
 * 职责：
 *   1. 建 settings-controller（状态与请求）与 settings-view（DOM），把视图抛出的意图接到
 *      controller 与宿主钩子上；
 *   2. 四个异步写（切模型 / 切思考档位 / 重试 / 重试档位）的接线。其中前两个带「归属校验」：
 *      点击时钉住 principal、session、导航代次，await 回来再核一次——过期结果既不写模型
 *      chip 也不冒提示。这段判断与迁移前逐字等价，只是取状态的方式换成 getState()；
 *   3. 对宿主只开五个入口：render / open / close / isOpen / reset，外加 controller 与 view
 *      两个实例（app 的 applyBusyUi、syncSessionModelChip、返回键与 __hana 出口还要用）。
 *
 * 不负责：深色模式与聊天视图怎么落地（theme.js / chat-view-mode.js 的控制器留在 app.js，
 * 这里只经 hooks 读当前值、把点选回传）、模型 chip 怎么画、会话抽屉怎么关、登录流程与
 * hana-setup:// 壳协议——这些是宿主的能力，经 views / hooks 注入。
 *
 * 依赖注入：模块自己不读全局、不 import app，也不认识 S。
 */

import { createSettingsController } from './settings-controller.js';
import { createSettingsView } from './settings-view.js';

/**
 * 创建设置面板（controller + view + 两者之间的接线）。
 *
 * @param {object} [options]
 * @param {Document} [options.document] DOM 工厂，交给 settings-view
 * @param {(id: string) => (Element|null|undefined)} [options.getElement] 取容器节点（app 传 `$`）
 * @param {(pathname: string, init?: object) => Promise<any>} [options.api] 同源请求，交给 controller
 * @param {{closeDrawer?: Function, openLogin?: Function, goServerMode?: Function}} [options.views]
 *   三个宿主动作：关会话抽屉、走退出登录流程、跳壳的接入方式对话框
 * @param {() => object} [options.getState] 读宿主状态（只读 principal / session / currentAgent / busy）
 * @param {object} [options.hooks] 取值与动作（见下方解构），全部是函数
 * @param {Function} [options.createController] 单测缝：默认就是 settings-controller 的真工厂
 * @param {Function} [options.createView] 单测缝：默认就是 settings-view 的真工厂
 * @returns {{
 *   render: (state: object) => void, open: () => void, close: () => void,
 *   isOpen: () => boolean, reset: () => void,
 *   controller: object, view: object,
 * }}
 */
export function createSettingsPanel({
  document: doc,
  getElement,
  api,
  views = {},
  getState,
  hooks = {},
  // 单测缝：生产装配（app.js）不传，走真 controller / view；这里只让装配层可被假实现替换。
  createController = createSettingsController,
  createView = createSettingsView,
} = {}) {
  if (!doc) throw new TypeError('createSettingsPanel requires { document }');
  if (typeof getElement !== 'function') throw new TypeError('createSettingsPanel requires { getElement }');
  if (typeof api !== 'function') throw new TypeError('createSettingsPanel requires { api }');
  if (typeof getState !== 'function') throw new TypeError('createSettingsPanel requires { getState }');

  const {
    closeDrawer = () => {},
    openLogin = () => {},
    goServerMode = () => {},
  } = views;

  const {
    navigationEpoch = () => 0,
    findAgentForSession = () => null,
    renderModelChip = () => {},
    bumpChipToken = () => {},
    flash = () => {},
    isStreaming = () => false,
    onThemeSelect = () => {},
    onViewModeSelect = () => {},
    currentViewMode = () => null,
    currentThemeMode = () => null,
  } = hooks;

  /* view 要在 controller 之后才建（视图的回调全指向 controller），但 controller 的
   * onStateChange 理论上可能在建视图之前就回调：用 let 占位 + 可选链，谁先 notify 都不撞 TDZ。 */
  let view = null;

  /** 把宿主的当前档位并进 state 再画：面板每次渲染都拿到最新的外观与聊天视图。 */
  function render(state) {
    view?.render?.({ ...state, viewMode: currentViewMode(), themeMode: currentThemeMode() });
  }

  /* 状态与请求归 controller：它不碰 DOM，也不知道 app 的存在。 */
  const controller = createController({
    request: (pathname, init) => api(pathname, init),
    onStateChange: (state) => render(state),
  });

  /* DOM 与交互归 view：它只发意图，落地全在下面这组回调里。 */
  view = createView({
    container: getElement('settingsContainer'),
    document: doc,
    onClose: () => view.close(),
    // 聊天视图同接入方式一样：视图只发意图，落库与重画在装配层。
    viewMode: currentViewMode(),
    onSelectViewMode: (mode) => onViewModeSelect(mode),
    // 外观同理：视图只报「用户选了哪档」，落地、订阅系统主题都在 theme 控制器里。
    themeMode: currentThemeMode(),
    onSelectTheme: (mode) => onThemeSelect(mode),
    // 接入方式与退出登录：视图只发意图，壳协议与登录流程留在宿主。
    onServerMode: () => goServerMode(),
    onLogout: () => openLogin(),
    onSelectModel: async (modelId, provider) => {
      // 请求是异步的：先钉住「这次点击属于谁、哪个会话、哪次导航」，回调回来再核。
      const host = getState();
      const owner = host.principal;
      const session = host.session;
      const epoch = navigationEpoch();
      const stillMine = () => {
        const live = getState();
        return live.principal === owner && live.session === session && navigationEpoch() === epoch;
      };
      try {
        const res = await controller.switchModel(modelId, provider);
        if (!stillMine()) return;
        // controller 返回 null = 过期写/重复写（新 load 或 dispose 已推进代次），不得回写 chip。
        if (res === null || res === undefined) return;
        // 写已生效：先作废写之前发出的 chip GET，再画新模型，避免旧 GET 晚到盖回来。
        bumpChipToken();
        renderModelChip(res?.model || res?.modelId || modelId);
      } catch (err) {
        if (!stillMine()) return;
        flash(err?.message || '切换模型失败');
      }
    },
    onSelectThinkingLevel: async (level) => {
      // 与模型写同一套归属：思考写的迟到结果不能落到新会话/新身份头上。
      const host = getState();
      const owner = host.principal;
      const session = host.session;
      const epoch = navigationEpoch();
      const stillMine = () => {
        const live = getState();
        return live.principal === owner && live.session === session && navigationEpoch() === epoch;
      };
      try {
        const res = await controller.setThinkingLevel(level);
        if (!stillMine()) return;
        // null = 过期写/重复写；思考级别不改模型 chip，设置面板由 controller 自己重绘。
        if (res === null || res === undefined) return;
      } catch (err) {
        // 旧会话/旧身份的错误不能冒到当前界面；只有仍属于本次点击才提示。
        if (!stillMine()) return;
        flash(err?.message || '切换思考级别失败');
      }
    },
    onSelectFontSize: (size) => {
      controller.setFontSize(size);
      render(controller.getState());
    },
    onRetry: () => controller.retry(),
    // 只重拉档位：不重拉模型列表，也不把整个面板打进加载态。
    onRetryThinking: async () => {
      try {
        await controller.retryThinking();
      } catch (err) {
        flash(err?.message || '读取思考档位失败');
      }
    },
    onNotice: (msg) => flash(msg, { level: 'info' }),
  });

  // 启动时先把上次选的字号落到根节点上，不然只有打开设置才会生效。
  render(controller.getState());

  /** 打开设置：先画本地状态（含字号），再去拉真实模型与思考级别。 */
  function open() {
    closeDrawer();
    view.open();
    controller.setStreaming(isStreaming());
    render(controller.getState());
    const host = getState();
    const session = host.session;
    // 会话面板只认会话自己的 Agent；没有会话时才用当前 Agent，
    // 绝不拿当前 Agent 替别的会话兜底。
    const sessionAgent = session ? findAgentForSession(session) : null;
    controller.load({
      sessionPath: session?.path || null,
      agentId: session ? (session.agentId || null) : (host.currentAgent?.id || null),
      streaming: isStreaming(),
      fallbackModel: session ? (sessionAgent?.chatModel || null) : (host.currentAgent?.chatModel || null),
    });
  }

  /* 关面板、读开合、退出登录后的复位：都只转发，不在这里加业务。 */
  function close() {
    view.close();
  }

  function isOpen() {
    return view.isOpen();
  }

  /**
   * 登录身份换人后的复位：废弃在途 load / 写 / chip GET，清空会话相关状态，
   * 但保留字号偏好（这些都在 controller.reset 里）。关面板是宿主自己的事
   * （app 在 resetAfterLogout 里先 close 再 reset，顺序与迁移前一致）。
   */
  function reset() {
    controller.reset();
  }

  return {
    render,
    open,
    close,
    isOpen,
    reset,
    controller,
    view,
  };
}
