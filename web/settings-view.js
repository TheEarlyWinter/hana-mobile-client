/* web/settings-view.js
 *
 * 设置面板视图层与 DOM 交互控制器。
 *
 * 管什么：
 * 1. 负责在宿主传入的 container 内部构建完整的设置面板 DOM（遮罩、抽屉、头部、内容滚动区）。
 * 2. 状态渲染：
 *    - 加载态（settings-loading）：展示温和骨架与中文提示；
 *    - 失败态（settings-error）：展示错误详情与重试按钮；
 *    - 内容态：
 *      a. 模型列表（settings-section-models）：按厂商与名称展示可用模型，高亮当前选中模型，响应点击切换；
 *      b. 思考级别（settings-section-thinking）：动态根据可用集合 thinkingLevels 渲染分段按钮，不可用时显示友好提示；
 *      c. 外观配色（settings-section-theme）：跟随系统 / 浅色 / 深色三选一，只把点选意图抛给回调；
 *      d. 外观字号（settings-section-appearance）：展示小/标准/大/特大档位选择，切换时即时响应并将 CSS 变量 --chat-message-font-size 作用于文档根节点；
 *      e. 聊天视图（settings-section-chat-view）：沉静视图 / 经典视图二选一，只把点选意图抛给回调。
 * 3. 抽屉的开闭交互、动画控制、遮罩点击关闭、ESC 关闭等事件监听管理。
 * 4. 彻底的资源销毁（destroy）：移除所有监听器、清空 DOM 节点、解除页面滚动锁，确保在移动端高频开关下零内存与事件残留。
 *
 * 不管什么：
 * 1. 不在 DOM 中通过 document.getElementById 或全局查询外界的任何节点，仅操作传入的 container。
 * 2. 不发起任何网络请求，所有用户交互（切模型、切级别、切字号、切视图、重试、关闭）均通过注入的回调函数委托给调用方。
 * 3. 不管理应用持久化状态与业务上下文。
 * 4. 不认识聊天视图的数据来源（不 import chat-view-mode.js）：读哪个字段、写哪个接口都由父层装配，
 *    视图只拿一个 viewMode 字符串做标记，点选后回调一个 mode，不在本地存储偏好。
 * 5. 也不认识深色模式怎么落地：外观三档只做「点选 → 回调」，data-theme 由 web/theme.js 的
 *    控制器写在 <html> 上（theme.js 是纯模块，这里只借用它的值归一化，不碰存储与 DOM 根）。
 */

import { FONT_SIZE_OPTIONS, DEFAULT_FONT_SIZE } from './settings-controller.js';
import { DEFAULT_THEME_MODE, normalizeTheme } from './theme.js';

/**
 * 思考级别中文友好映射（展示用，不硬编码集合枚举）
 */
const THINKING_LEVEL_LABELS = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

function formatThinkingLevel(level) {
  if (!level) return '';
  return THINKING_LEVEL_LABELS[level] || level;
}

/**
 * 聊天视图模式：只是宿主桌面端两种聊天视图的开关值，与模型、思考级别完全无关。
 * 顺序固定（沉静在前），保证面板里第一次渲染就能看到两个选项。
 */
const VIEW_MODE_OPTIONS = Object.freeze([
  { mode: 'serene', label: '沉静视图' },
  { mode: 'classic', label: '经典视图' },
]);

const VIEW_MODE_HINT = '沉静视图把过程收进一行摘要，经典视图保留逐条过程。';

/** 只接受契约内的两个值，其余（null/旧值/拼写错）返回 null，不假认选中 */
function normalizeViewMode(mode) {
  return VIEW_MODE_OPTIONS.some((opt) => opt.mode === mode) ? mode : null;
}

/**
 * 外观三档。顺序即面板顺序，且与 theme.js 的 THEME_MODES 一致。
 * 这里不 import THEME_MODES：面板文案（中文标签）属于视图，值域交给 normalizeTheme 兜底。
 */
const THEME_OPTIONS = Object.freeze([
  { mode: 'auto', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
]);

const THEME_HINT = '跟随系统时，随手机的深浅设置自动切换。';

/**
 * 创建设置视图管理器
 *
 * @param {object} options
 * @param {HTMLElement} options.container 外部传入的挂载容器（必选）
 * @param {Document} [options.document] Document 实例（单测可注入）
 * @param {Function} [options.onClose] 关闭面板回调
 * @param {Function} [options.onSelectModel] 选择模型回调 (modelId, provider) => void
 * @param {Function} [options.onSelectThinkingLevel] 选择思考级别回调 (level) => void
 * @param {Function} [options.onSelectFontSize] 选择字号回调 (fontSize) => void
 * @param {Function} [options.onSelectTheme] 选择外观三档回调 (mode: 'auto' | 'light' | 'dark') => void
 * @param {'auto'|'light'|'dark'} [options.themeMode] 当前外观档位，用来标记选中项
 * @param {Function} [options.onSelectViewMode] 选择聊天视图回调 (mode: 'serene' | 'classic') => void，可为 async
 * @param {'serene'|'classic'} [options.viewMode] 当前聊天视图模式，用来标记选中项
 * @param {Function} [options.onRetry] 点击重新加载回调 () => void
 * @param {Function} [options.onServerMode] 点击「切换接入方式」回调 () => void
 * @param {Function} [options.onLogout] 点击「退出登录」回调 () => void
 * @param {boolean} [options.applyFontSizeToRoot=true] 是否自动将字号更新到 documentElement
 */
export function createSettingsView({
  container,
  document: customDoc,
  onClose = () => {},
  onSelectModel = () => {},
  onSelectThinkingLevel = () => {},
  onRetryThinking = () => {},
  onSelectFontSize = () => {},
  onSelectTheme = () => {},
  themeMode = DEFAULT_THEME_MODE,
  onSelectViewMode = () => {},
  viewMode = null,
  onRetry = () => {},
  onNotice = () => {},
  onServerMode = () => {},
  onLogout = () => {},
  applyFontSizeToRoot = true,
} = {}) {
  if (!container) {
    throw new TypeError('createSettingsView 必须传入 container 宿主容器节点');
  }

  const doc = customDoc || (typeof document !== 'undefined' ? document : null);
  if (!doc) {
    throw new TypeError('createSettingsView 需要可用的 document 对象');
  }

  let isOpenState = false;
  let currentState = null;
  let prevOverflow = '';
  let isLockedScroll = false;

  // 聊天视图的当前值：先以构造入参为准，父层也可以随后随 render state 纠正。
  // 未知值一律当作「不知道」，不猜成任何一项，避免把别人的偏好显示错。
  const initialViewMode = normalizeViewMode(viewMode);
  let localViewMode = initialViewMode;

  // 外观档位：同字号/聊天视图一样是纯本地偏好。未知值一律落 auto（跟 normalizeTheme 一套规则），
  // 不猜成浅色或深色，避免把用户的系统级选择显示错。
  let localThemeMode = normalizeTheme(themeMode);

  // DOM 节点引用
  let maskEl = null;
  let drawerEl = null;
  let headEl = null;
  let titleBoxEl = null;
  let closeBtnEl = null;
  let bodyEl = null;

  // 工具函数：创建 element
  function el(tag, cls = '', text = null) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // 键盘 ESC 监听
  function handleKeyDown(e) {
    if (e.key === 'Escape' && isOpenState) {
      close();
      onClose();
    }
  }

  // 构建外层框架
  function buildShell() {
    container.innerHTML = '';

    maskEl = el('div', 'settings-mask');
    maskEl.hidden = true;
    maskEl.addEventListener('click', () => {
      close();
      onClose();
    });
    container.appendChild(maskEl);

    drawerEl = el('div', 'settings-drawer');
    drawerEl.setAttribute('role', 'dialog');
    drawerEl.setAttribute('aria-modal', 'true');
    drawerEl.setAttribute('aria-label', '设置');

    // 头部
    headEl = el('div', 'settings-head');
    titleBoxEl = el('div', 'settings-title-group');
    const titleEl = el('div', 'settings-title', '设置');
    const subTitleEl = el('div', 'settings-subtitle', '模型、推理与界面外观');
    titleBoxEl.appendChild(titleEl);
    titleBoxEl.appendChild(subTitleEl);

    closeBtnEl = el('button', 'settings-icon-btn settings-close-btn');
    closeBtnEl.setAttribute('type', 'button');
    closeBtnEl.setAttribute('aria-label', '关闭设置');
    closeBtnEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtnEl.addEventListener('click', () => {
      close();
      onClose();
    });

    headEl.appendChild(titleBoxEl);
    headEl.appendChild(closeBtnEl);
    drawerEl.appendChild(headEl);

    // 内容区
    bodyEl = el('div', 'settings-body');
    drawerEl.appendChild(bodyEl);

    container.appendChild(drawerEl);

    if (doc.addEventListener) {
      doc.addEventListener('keydown', handleKeyDown);
    }
  }

  buildShell();

  /**
   * 应用字号到 root 节点
   */
  function applyFontSize(size) {
    if (!applyFontSizeToRoot || !doc.documentElement || !doc.documentElement.style) return;
    try {
      if (typeof doc.documentElement.style.setProperty === 'function') {
        doc.documentElement.style.setProperty('--chat-message-font-size', size);
      }
    } catch {
      // 容错
    }
  }

  // 右箭头图标：与头部关闭按钮同一套 stroke 风格，避免引入图标库
  const CHEVRON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

  /**
   * 把选中态就地画到两个按钮上。
   * 不重渲整个 body：切视图只是勾一下，整屏重建会丢掉抽屉的滚动位置。
   */
  function paintViewModeSelection() {
    if (!bodyEl || typeof bodyEl.querySelectorAll !== 'function') return;
    const btns = Array.from(bodyEl.querySelectorAll('.settings-view-mode-btn'));
    for (const btn of btns) {
      const isCurrent = Boolean(localViewMode) && btn.dataset.viewMode === localViewMode;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    }
  }

  /**
   * 点选聊天视图。
   * 回调可能是 async（父层要写宿主 /api/preferences/chat-ui），只发意图不 await：
   * 选中态先本地迁移，写入结果与失败提示都由父层负责，不阻塞一次点击。
   */
  function selectViewMode(mode) {
    const next = normalizeViewMode(mode);
    if (!next || next === localViewMode) return;
    localViewMode = next;
    paintViewModeSelection();
    try {
      const ret = onSelectViewMode(next);
      if (ret && typeof ret.then === 'function') {
        ret.then(null, (err) => {
          console.warn('[SettingsView] 切换聊天视图失败', err);
        });
      }
    } catch (err) {
      console.warn('[SettingsView] 切换聊天视图失败', err);
    }
  }

  /**
   * 读一个外观按钮的档位值。
   * 真 DOM 里 setAttribute('data-theme-mode') 会同步进 dataset，但假 DOM 不一定（测试夹具各异），
   * 所以两种都试：dataset 优先，回退到 getAttribute。两者都没有就当「不认识」，不高亮。
   */
  function themeModeOf(btn) {
    const fromDataset = btn && btn.dataset ? btn.dataset.themeMode : undefined;
    if (typeof fromDataset === 'string' && fromDataset) return fromDataset;
    const fromAttr = btn && typeof btn.getAttribute === 'function' ? btn.getAttribute('data-theme-mode') : null;
    return fromAttr || null;
  }

  /** 把外观选中态就地画到三个按钮上（同聊天视图：不重渲整个 body，不丢滚动位置）。 */
  function paintThemeSelection() {
    if (!bodyEl || typeof bodyEl.querySelectorAll !== 'function') return;
    const btns = Array.from(bodyEl.querySelectorAll('.settings-theme-btn'));
    for (const btn of btns) {
      const isCurrent = themeModeOf(btn) === localThemeMode;
      btn.classList.toggle('active', isCurrent);
      btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
    }
  }

  /**
   * 点选外观档位。
   * 只发意图：写存储、算「跟随系统此刻该是什么色」、写 <html data-theme> 都是 theme.js 控制器的事。
   * 回调可能抛（比如宿主存储不可用），这里兜住，不让一次点击把面板弄坏。
   */
  function selectTheme(mode) {
    const next = normalizeTheme(mode);
    if (next === localThemeMode) return;
    localThemeMode = next;
    paintThemeSelection();
    try {
      const ret = onSelectTheme(next);
      if (ret && typeof ret.then === 'function') {
        ret.then(null, (err) => {
          console.warn('[SettingsView] 切换外观失败', err);
        });
      }
    } catch (err) {
      console.warn('[SettingsView] 切换外观失败', err);
    }
  }

  /**
   * 外观配色：三档分段控制器，复用字号/思考级别那一套选项样式，
   * 与下方「聊天视图」同属系统级分区，加载失败时也照给。
   */
  function buildThemeSection() {
    const sec = el('div', 'settings-section settings-section-theme');
    const head = el('div', 'settings-section-head');
    head.appendChild(el('div', 'settings-section-title', '外观'));
    head.appendChild(el('div', 'settings-section-desc', '深色 / 浅色'));
    sec.appendChild(head);

    const group = el('div', 'settings-segmented-control settings-theme-group');
    for (const opt of THEME_OPTIONS) {
      const isCurrent = opt.mode === localThemeMode;
      const btn = el('button', `settings-segment-btn settings-theme-btn${isCurrent ? ' active' : ''}`, opt.label);
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-theme-mode', opt.mode);
      btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      btn.addEventListener('click', () => selectTheme(opt.mode));
      group.appendChild(btn);
    }
    sec.appendChild(group);

    sec.appendChild(el('div', 'settings-section-foot', THEME_HINT));
    return sec;
  }

  /**
   * 聊天视图：与原字号分区一样是纯展示偏好，用分段控制器表达二选一，
   * 不另起一套选项样式，也看不到任何模型/会话信息。
   */
  function buildChatViewSection() {
    const sec = el('div', 'settings-section settings-section-chat-view');
    const head = el('div', 'settings-section-head');
    head.appendChild(el('div', 'settings-section-title', '聊天'));
    head.appendChild(el('div', 'settings-section-desc', '过程展示方式'));
    sec.appendChild(head);

    const group = el('div', 'settings-segmented-control settings-view-mode-group');
    for (const opt of VIEW_MODE_OPTIONS) {
      const isCurrent = opt.mode === localViewMode;
      const btn = el('button', `settings-segment-btn settings-view-mode-btn${isCurrent ? ' active' : ''}`, opt.label);
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-view-mode', opt.mode);
      btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
      btn.addEventListener('click', () => selectViewMode(opt.mode));
      group.appendChild(btn);
    }
    sec.appendChild(group);

    sec.appendChild(el('div', 'settings-section-foot', VIEW_MODE_HINT));
    return sec;
  }

  /** 网络与连接：低频配置收进二级面板，抽屉底部不再平铺大按钮。 */
  function buildConnectionSection() {
    const sec = el('div', 'settings-section settings-section-connection');
    const head = el('div', 'settings-section-head');
    head.appendChild(el('div', 'settings-section-title', '网络与连接'));
    head.appendChild(el('div', 'settings-section-desc', '地址与服务入口'));
    sec.appendChild(head);

    const row = el('button', 'settings-link-row');
    row.setAttribute('type', 'button');
    const textBox = el('div', 'settings-link-text');
    textBox.appendChild(el('div', 'settings-link-title', '切换接入方式'));
    textBox.appendChild(el('div', 'settings-link-desc', '本机 USB / Tailscale / 公网隧道 / 自定义'));
    row.appendChild(textBox);
    const arrow = el('span', 'settings-link-arrow');
    arrow.innerHTML = CHEVRON_SVG;
    row.appendChild(arrow);
    // 只发意图：真的跳到 hana-setup:// 由 app 决定，视图不认识地址协议。
    row.addEventListener('click', () => onServerMode());
    sec.appendChild(row);
    return sec;
  }

  /** 账号：破坏性操作，固定放内容区最底部，用弱危险态与常规配置区分。 */
  function buildAccountSection() {
    const sec = el('div', 'settings-section settings-section-account');
    const head = el('div', 'settings-section-head');
    head.appendChild(el('div', 'settings-section-title', '账号'));
    head.appendChild(el('div', 'settings-section-desc', '当前登录身份'));
    sec.appendChild(head);

    const btn = el('button', 'settings-danger-btn', '退出登录');
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => {
      // 生成中退出会把在跑的回复丢掉：先提示，不发退出意图（真正的兜底也在 app 的 switchLogin 里）。
      if (currentState && currentState.streaming) {
        onNotice('正在生成回复，等完成后再退出登录');
        return;
      }
      onLogout();
    });
    sec.appendChild(btn);
    return sec;
  }

  /**
   * 系统级分区在加载态/失败态也照给：
   * 改地址与退出登录是出问题时的救命路径，不能因为模型列表拉失败就一起藏起来。
   * 聊天视图切的是纯本地偏好（只写宿主偏好，不依赖模型列表），拉失败时更不该跟着消失，
   * 所以与这两个分区同属「始终渲染」的一组，放在一起维护。
   * 外观（深色模式）也是同一类：它甚至比模型列表更需要先能用——整屏刺眼时要能立刻切回去。
   */
  function appendSystemSections() {
    if (!bodyEl) return;
    // 外观置顶：模型拉失败时，用户第一件想干的事就是先把眼睛救回来
    bodyEl.appendChild(buildThemeSection());
    bodyEl.appendChild(buildChatViewSection());
    bodyEl.appendChild(buildConnectionSection());
    bodyEl.appendChild(buildAccountSection());
  }

  /**
   * 打开面板
   */
  function open() {
    if (isOpenState) return;
    isOpenState = true;
    if (maskEl) maskEl.hidden = false;
    if (drawerEl) drawerEl.classList.add('open');

    // 锁定 body 滚动
    if (doc.body && doc.body.style) {
      prevOverflow = doc.body.style.overflow || '';
      doc.body.style.overflow = 'hidden';
      isLockedScroll = true;
    }
  }

  /**
   * 关闭面板
   */
  function close() {
    if (!isOpenState) return;
    isOpenState = false;
    if (maskEl) maskEl.hidden = true;
    if (drawerEl) drawerEl.classList.remove('open');

    // 恢复 body 滚动
    if (isLockedScroll && doc.body && doc.body.style) {
      doc.body.style.overflow = prevOverflow;
      isLockedScroll = false;
    }
  }

  /**
   * 渲染主体内容
   */
  function render(state) {
    if (!state) return;
    currentState = state;

    // 父层如果把 viewMode 随 state 送来，以它为准（服务端/宿主偏好是真相）；
    // 没有这个字段就沿用构造入参或刚点选的结果，否则一次无关重渲会把选中态抹掉。
    if (state.viewMode != null) {
      const declared = normalizeViewMode(state.viewMode);
      if (declared) localViewMode = declared;
    }
    // 外观同理：父层把当前档位随 state 送来就以它为准（存储/控制器是真相），
    // 没这个字段就沿用构造入参或刚点选的结果。
    if (state.themeMode != null) {
      localThemeMode = normalizeTheme(state.themeMode);
    }

    if (state.fontSize) {
      applyFontSize(state.fontSize);
    }

    if (!bodyEl) return;
    bodyEl.innerHTML = '';

    // 1. 加载中态
    if (state.status === 'loading') {
      const loadingBox = el('div', 'settings-loading');
      const spinner = el('div', 'settings-spinner');
      const text = el('span', 'settings-loading-text', '正在加载中...');
      loadingBox.appendChild(spinner);
      loadingBox.appendChild(text);
      bodyEl.appendChild(loadingBox);
      appendSystemSections();
      return;
    }

    // 2. 失败态
    if (state.status === 'error') {
      const errorBox = el('div', 'settings-error');
      const icon = el('div', 'settings-error-icon');
      icon.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
      const msg = el('div', 'settings-error-msg', state.error || '加载失败');
      const retryBtn = el('button', 'settings-btn settings-retry-btn', '重新加载');
      retryBtn.setAttribute('type', 'button');
      retryBtn.addEventListener('click', () => {
        onRetry();
      });
      errorBox.appendChild(icon);
      errorBox.appendChild(msg);
      errorBox.appendChild(retryBtn);
      bodyEl.appendChild(errorBox);
      appendSystemSections();
      return;
    }

    // 3. 正常状态

    // ================== A. 模型选择区块 ==================
    const modelSec = el('div', 'settings-section settings-section-models');
    const modelSecHead = el('div', 'settings-section-head');
    const modelTitle = el('div', 'settings-section-title', '语言模型');
    const isStreaming = state.streaming === true;
    const isSaving = state.savingModel === true;
    const modelBadgeText = isSaving ? '正在切换' : isStreaming ? '正在生成' : `${state.models.length} 可用`;
    const modelCount = el('div', `settings-section-badge${(isStreaming || isSaving) ? ' warning' : ''}`, modelBadgeText);
    modelSecHead.appendChild(modelTitle);
    modelSecHead.appendChild(modelCount);
    modelSec.appendChild(modelSecHead);

    if (state.models.length === 0) {
      const emptyBox = el('div', 'settings-empty-tip', '未检测到可用模型配置');
      modelSec.appendChild(emptyBox);
    } else {
      const modelList = el('div', 'settings-model-list');
      for (const m of state.models) {
        // 模型身份必须按 provider + id 组合明确匹配，防止不同厂商同名 id 同时高亮；provider 未知时绝不假认选中
        const isCurrent = Boolean(state.currentProvider) && (
          m.id === state.currentModelId && m.provider === state.currentProvider
        );
        const isDisabled = (!isCurrent && isStreaming) || isSaving;
        const itemCls = `settings-model-item${isCurrent ? ' active' : ''}${isDisabled ? ' disabled' : ''}`;
        const item = el('button', itemCls);
        item.setAttribute('type', 'button');
        item.setAttribute('data-model-id', m.id);
        item.setAttribute('data-provider', m.provider);
        item.setAttribute('data-model-key', `${m.provider}/${m.id}`);
        if (isDisabled) {
          item.setAttribute('aria-disabled', 'true');
        }

        const infoBox = el('div', 'settings-model-info');
        const nameEl = el('div', 'settings-model-name', m.name || m.id);
        const providerName = (state.providerDisplayNames && state.providerDisplayNames[m.provider]) || m.provider;
        const providerEl = el('div', 'settings-model-provider', providerName);
        infoBox.appendChild(nameEl);
        infoBox.appendChild(providerEl);

        const checkEl = el('div', 'settings-model-check');
        checkEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>';

        item.appendChild(infoBox);
        item.appendChild(checkEl);

        item.addEventListener('click', () => {
          if (isCurrent) return;
          if (state.savingModel) return;
          if (state.streaming) {
            onNotice('正在生成，结束后再切');
            return;
          }
          onSelectModel(m.id, m.provider);
        });

        modelList.appendChild(item);
      }
      modelSec.appendChild(modelList);
    }
    bodyEl.appendChild(modelSec);

    // ================== B. 思考级别区块 ==================
    const thinkSec = el('div', 'settings-section settings-section-thinking');
    const thinkSecHead = el('div', 'settings-section-head');
    const thinkTitle = el('div', 'settings-section-title', '思考级别');
    const thinkDesc = el('div', 'settings-section-desc', '深度推理档位');
    thinkSecHead.appendChild(thinkTitle);
    thinkSecHead.appendChild(thinkDesc);
    thinkSec.appendChild(thinkSecHead);

    // 状态由 controller 判定（它收到的就是宿主的响应）；视图只负责表达，不猜值、不替用户选档。
    // 没带 thinkingStatus 的调用方（旧路径或直接构造的测试数据）按数据自行退化。
    const levels = Array.isArray(state.thinkingLevels) ? state.thinkingLevels : [];
    const derivedStatus = levels.length === 0
      ? 'unsupported'
      : (state.thinkingLevel && !levels.includes(state.thinkingLevel) ? 'inconsistent' : 'ready');
    const thinkStatus = state.thinkingStatus || derivedStatus;

    if (thinkStatus === 'loading') {
      thinkSec.appendChild(el('div', 'settings-unsupported-tip', '正在读取档位…'));
    } else if (thinkStatus === 'error') {
      thinkSec.appendChild(el('div', 'settings-unsupported-tip', '档位读取失败，请重试'));
      const retryBtn = el('button', 'settings-retry-btn', '重试');
      retryBtn.setAttribute('type', 'button');
      retryBtn.addEventListener('click', () => onRetryThinking());
      thinkSec.appendChild(retryBtn);
    } else if (thinkStatus === 'inconsistent') {
      // 集合和值对不上：把集合画出来让用户看见真实现状，但一个都不高亮，也不允许点。
      // 自动高亮「最近的一个」等于伪造当前设置。
      const segGroup = el('div', 'settings-segmented-control settings-level-group');
      for (const lvl of levels) {
        const btn = el('button', 'settings-segment-btn settings-level-btn');
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-level', lvl);
        btn.disabled = true;
        btn.textContent = formatThinkingLevel(lvl);
        segGroup.appendChild(btn);
      }
      thinkSec.appendChild(segGroup);
      thinkSec.appendChild(el('div', 'settings-unsupported-tip', '档位数据不一致，请重试'));
      const retryBtn = el('button', 'settings-retry-btn', '重试');
      retryBtn.setAttribute('type', 'button');
      retryBtn.addEventListener('click', () => onRetryThinking());
      thinkSec.appendChild(retryBtn);
    } else if (thinkStatus === 'ready' && levels.length > 0) {
      const segGroup = el('div', 'settings-segmented-control settings-level-group');
      for (const lvl of levels) {
        const isCurrentLvl = lvl === state.thinkingLevel;
        const btn = el('button', `settings-segment-btn settings-level-btn${isCurrentLvl ? ' active' : ''}`);
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-level', lvl);

        const labelText = formatThinkingLevel(lvl);
        btn.textContent = labelText;

        btn.addEventListener('click', () => {
          if (!isCurrentLvl) {
            onSelectThinkingLevel(lvl);
          }
        });
        segGroup.appendChild(btn);
      }
      thinkSec.appendChild(segGroup);
    } else {
      const unsupported = el('div', 'settings-unsupported-tip', '当前模型不支持调节思考级别');
      thinkSec.appendChild(unsupported);
    }
    bodyEl.appendChild(thinkSec);

    // ================== C. 外观区块（正文字号） ==================
    const appearSec = el('div', 'settings-section settings-section-appearance');
    const appearSecHead = el('div', 'settings-section-head');
    const appearTitle = el('div', 'settings-section-title', '聊天正文字号');
    const appearDesc = el('div', 'settings-section-desc', '调节用户消息与助手回复的阅读字号');
    appearSecHead.appendChild(appearTitle);
    appearSecHead.appendChild(appearDesc);
    appearSec.appendChild(appearSecHead);

    const fontGroup = el('div', 'settings-segmented-control settings-font-group');
    const currentSize = state.fontSize || DEFAULT_FONT_SIZE;

    for (const opt of FONT_SIZE_OPTIONS) {
      const isCurrentSize = opt.value === currentSize;
      const btn = el('button', `settings-segment-btn settings-font-btn${isCurrentSize ? ' active' : ''}`);
      btn.setAttribute('type', 'button');
      btn.setAttribute('data-size', opt.value);
      btn.textContent = `${opt.label} (${opt.value.replace('px', '')})`;

      btn.addEventListener('click', () => {
        if (opt.value !== currentSize) {
          applyFontSize(opt.value);
          onSelectFontSize(opt.value);
        }
      });
      fontGroup.appendChild(btn);
    }
    appearSec.appendChild(fontGroup);

    const noteEl = el('div', 'settings-section-foot', '保存在本地，切换会话保持生效。');
    appearSec.appendChild(noteEl);

    bodyEl.appendChild(appearSec);

    appendSystemSections();
  }

  /**
   * 彻底销毁清理
   */
  function destroy() {
    close();
    if (doc.removeEventListener) {
      doc.removeEventListener('keydown', handleKeyDown);
    }
    container.innerHTML = '';
    maskEl = null;
    drawerEl = null;
    headEl = null;
    titleBoxEl = null;
    closeBtnEl = null;
    bodyEl = null;
    currentState = null;
    localViewMode = initialViewMode;
    localThemeMode = normalizeTheme(themeMode);
  }

  return {
    open,
    close,
    isOpen: () => isOpenState,
    render,
    destroy,
  };
}
