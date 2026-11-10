/* web/mobile-lifecycle.js — 移动端的窗口与页面生命周期
 *
 * 三件在真机上才会咬人的事：
 *  - 键盘弹起时聊天区会变矮，而且有两条完全不同的路径：VisualViewport 内缩（靠 --kb
 *    把视图抬起来）与布局视口直接缩小（Android WebView 的 adjustResize，此时 --kb 恒 0）。
 *    两条路径下「本来就贴着底」的内容都必须仍然贴着底——所以贴底状态是持续跟踪的，
 *    既不能在布局变矮之后现算，也不能挂在 --kb 是否变化上；
 *  - 切到后台再回来：连接可能已经断了，要先连、再重报前台、再续流；
 *  - 真正销毁文档时才释放列表控制器，进 bfcache 不能 dispose，否则恢复后列表再也加载不出来。
 *
 * 顺带把「任何未捕获错误都要看得见」的兜底和临时布局探针也放这里：它们都只跟
 * 窗口尺寸与页面生命周期打交道。
 */

/**
 * @param {object} [options]
 * @param {object} [options.state] 共享状态对象
 * @param {Document} [options.document]
 * @param {Window} [options.window]
 * @param {(id: string) => Element|null} [options.getElement]
 * @param {object} [options.renderer] chat-renderer 实例
 * @param {() => void} [options.connectWS] 重连（app 的薄入口）
 * @param {(() => void)|null} [options.onForegroundResume]
 *   前台恢复真的跑起来（重连已发起）之后通知一次装配层。app 用它开一个短的对账窗口，
 *   等一段时间看有没有任何事件到来；本模块只管「什么时候」，判断与收尾不在这一层。
 * @param {(() => void)|null} [options.onForegroundSuspend]
 *   进后台 / 失焦 / 文档卸载时通知：前台恢复与它的对账窗口一起作废。
 * @param {object|null} [options.actionConfirmation]
 * @param {object} [options.sessionListController]
 * @param {object} [options.namespaceTabs]
 * @param {string} [options.probeBuild] 布局探针的构建标记
 * @param {string} [options.probeModuleUrl] 探针要报告的入口脚本 URL（默认本模块）
 * @param {boolean} [options.debug]
 */
export function createMobileLifecycle({
  state,
  document,
  window,
  getElement,
  renderer,
  connectWS,
  onForegroundResume = null,
  onForegroundSuspend = null,
  actionConfirmation = null,
  sessionListController,
  namespaceTabs,
  probeBuild = '',
  probeModuleUrl = '',
  debug = false,
} = {}) {
  if (!state) throw new TypeError('createMobileLifecycle requires { state }');

  /** 盘底：任何未捕获的错误都要能看见，不能留一块白屏。 */
  function fatal(msg) {
    console.error('[hana]', msg);
    const n = getElement('bootError');
    if (!n) return;
    n.textContent = String(msg || '未知错误');
    n.hidden = false;
  }

  /** 临时真机探针。只有 URL 带 debug 参数时才渲染，不参与正常布局。 */
  function installLayoutProbe() {
    if (!debug || !document.body) return;

    const panel = document.createElement('pre');
    panel.id = 'layoutDebugProbe';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-label', '聊天输入区布局诊断');
    panel.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'margin:0', 'padding:6px 8px', 'max-height:38vh', 'overflow:hidden',
      'background:rgba(12,18,24,.94)', 'color:#c9ffd0',
      'font:10px/1.35 ui-monospace,monospace', 'white-space:pre-wrap',
      'overflow-wrap:anywhere', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(panel);

    const chatView = getElement('view-chat');
    const attachButton = getElement('btnAttach');
    const root = document.documentElement;
    const pxRatio = () => window.devicePixelRatio || 1;
    const round = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    const rectOf = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      const rect = node.getBoundingClientRect();
      const scale = pxRatio();
      return {
        left: round(rect.left), top: round(rect.top),
        right: round(rect.right), bottom: round(rect.bottom),
        width: round(rect.width), height: round(rect.height),
        devicePx: {
          left: round(rect.left * scale), top: round(rect.top * scale),
          right: round(rect.right * scale), bottom: round(rect.bottom * scale),
          width: round(rect.width * scale), height: round(rect.height * scale),
        },
      };
    };
    const formatRect = (rect) => rect
      ? `css=[${rect.left},${rect.top}][${rect.right},${rect.bottom}] ${rect.width}x${rect.height}; webview-local px=[${rect.devicePx.left},${rect.devicePx.top}][${rect.devicePx.right},${rect.devicePx.bottom}] ${rect.devicePx.width}x${rect.devicePx.height}`
      : 'missing';
    const refresh = () => {
      const vv = window.visualViewport;
      const screenInfo = window.screen || {};
      const rootStyle = window.getComputedStyle ? window.getComputedStyle(root) : null;
      const viewChatRect = rectOf(chatView);
      const btnAttachRect = rectOf(attachButton);
      const documentRect = rectOf(root);
      const metrics = {
        build: probeBuild,
        // 探针现在住在本模块里，但真机取证要回答的是「跑的是哪个 app 入口」，
        // 所以入口 URL 由调用方传进来；再附一份本模块自己的地址供对照。
        moduleUrl: probeModuleUrl || import.meta.url,
        lifecycleModuleUrl: import.meta.url,
        screen: { width: screenInfo.width ?? null, height: screenInfo.height ?? null, availWidth: screenInfo.availWidth ?? null, availHeight: screenInfo.availHeight ?? null },
        devicePixelRatio: pxRatio(),
        innerHeight: round(window.innerHeight),
        outerHeight: round(window.outerHeight),
        documentClientHeight: root.clientHeight,
        documentScrollHeight: root.scrollHeight,
        visualViewport: vv ? {
          width: round(vv.width), height: round(vv.height),
          offsetLeft: round(vv.offsetLeft), offsetTop: round(vv.offsetTop),
          pageLeft: round(vv.pageLeft), pageTop: round(vv.pageTop),
        } : null,
        keyboardInset: rootStyle?.getPropertyValue('--kb')?.trim() || 'unavailable',
        viewChatHidden: chatView?.hidden ?? null,
        viewChatRect,
        btnAttachRect,
        documentRect,
      };
      window.__hanaLayoutProbe = metrics;
      panel.textContent = [
        `LAYOUT PROBE ${metrics.build}`,
        `module=${metrics.moduleUrl}`,
        `screen=${metrics.screen.width}x${metrics.screen.height} dpr=${metrics.devicePixelRatio}`,
        `innerHeight=${metrics.innerHeight} outerHeight=${metrics.outerHeight} documentClientHeight=${metrics.documentClientHeight}`,
        `VisualViewport=${metrics.visualViewport ? `${metrics.visualViewport.width}x${metrics.visualViewport.height} offset=${metrics.visualViewport.offsetLeft},${metrics.visualViewport.offsetTop}` : 'unavailable'}`,
        `--kb=${metrics.keyboardInset}`,
        `view-chat hidden=${metrics.viewChatHidden} ${formatRect(viewChatRect)}`,
        `btnAttach ${formatRect(btnAttachRect)}`,
        `documentElement ${formatRect(documentRect)}`,
      ].join('\n');
    };
    const scheduleRefresh = () => window.requestAnimationFrame(refresh);

    window.addEventListener('resize', scheduleRefresh);
    window.addEventListener('orientationchange', scheduleRefresh);
    window.visualViewport?.addEventListener('resize', scheduleRefresh);
    window.visualViewport?.addEventListener('scroll', scheduleRefresh);
    if (window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(scheduleRefresh);
      if (chatView) resizeObserver.observe(chatView);
      if (attachButton) resizeObserver.observe(attachButton);
    }
    if (window.MutationObserver && chatView) {
      const mutationObserver = new MutationObserver(scheduleRefresh);
      mutationObserver.observe(chatView, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    }
    refresh();
  }

  function watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;

    /* 贴底状态必须持续跟踪，不能等到视口变化时现算：
     *  - VisualViewport 内缩模式（iOS 那套）：resize 到达时布局还没变，现算能得到真值，
     *    但改完 --kb 之后视图变矮，再算就永远 false；
     *  - adjustResize 模式（Android WebView）：键盘把布局视口一起缩小，resize 到达时
     *    transcript 的 clientHeight 已经变矮，现算一定 false，而 --kb 的 inset 恒为 0。
     * 两种情况下「现算」都错，所以只认用户最后一次真实滚动留下的结果。 */
    let pinned = true;

    const trackPinned = () => {
      pinned = renderer.nearBottom();
    };

    // 滚动事件不冒泡，但会经过捕获阶段；挂在 document 上能兜住任何滚动容器。
    document.addEventListener('scroll', trackPinned, { capture: true, passive: true });
    // transcript 自己的滚动是最要紧的那一个，直接挂一份：不依赖捕获阶段的投递。
    const box = renderer.container?.();
    box?.addEventListener?.('scroll', trackPinned, { passive: true });

    const nextFrame = typeof window.requestAnimationFrame === 'function'
      ? (fn) => window.requestAnimationFrame(fn)
      : (fn) => setTimeout(fn, 0);

    /** 只有「当前在会话里」且「用户本来就贴着底」才动滚动位置。 */
    const scrollIfPinned = () => {
      if (!state?.session || !pinned) return;
      renderer.scrollToBottom(true);
    };

    const adjust = () => {
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      const inset = Math.max(0, layoutHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', `${inset}px`);
      // 没有活动会话时只更新布局变量，不碰滚动位置。
      if (!state?.session || !pinned) return;
      // 滚两次：同步这次按当前布局立刻贴底；下一帧再补一次，等浏览器把新高度
      //（键盘动画、输入框自增高）算完，否则会在动画中途停在半路。
      scrollIfPinned();
      nextFrame(scrollIfPinned);
    };

    vv.addEventListener('resize', adjust);
    vv.addEventListener('scroll', adjust);
    window.addEventListener('resize', adjust);
    window.addEventListener('orientationchange', adjust);
    adjust();
  }

  /*
   * 回到前台要做的连接恢复。
   *
   * Android WebView 切后台再回来时 visibilityState 仍然可能是 visible，只有 focus 会来；
   * 而 wsReady 只说明「页面最后一次看到的连接是好的」——WebView 被挂起时底层 socket
   * 已经断了，标志位却不会变。所以这里不信 wsReady：focus / visible 都安排一次真实重连，
   * 由 connectWS() 换一条新连接，open 后照旧重报前台与续流。
   *
   * 100ms 合并窗口：同时收到 focus 与 visibilitychange 时只连一次。排队期间隐藏、
   * 失焦、换会话或退出登录都作废——旧归属的恢复不能落到新会话头上。
   */
  const FOREGROUND_RESUME_DELAY_MS = 100;
  let foregroundResumeTimer = null;

  function cancelForegroundResume() {
    if (!foregroundResumeTimer) return;
    clearTimeout(foregroundResumeTimer);
    foregroundResumeTimer = null;
  }

  /**
   * 真的进后台 / 失焦 / 卸载：取消待执行的恢复，并通知装配层把它那边的对账窗口一起作废。
   *
   * 和 cancelForegroundResume 分开：同一个 100ms 合并窗口内的重复 focus/visible 也会走
   * 取消（见 scheduleForegroundResume），那种情况不能顺带把刚开的对账窗口作废。
   */
  function suspendForegroundResume() {
    cancelForegroundResume();
    if (typeof onForegroundSuspend !== 'function') return;
    try {
      onForegroundSuspend();
    } catch (err) {
      console.error('[hana] onForegroundSuspend error:', err);
    }
  }

  function scheduleForegroundResume() {
    const session = state.session;
    if (!session) return;
    const principal = state.principal ?? null;
    cancelForegroundResume();
    foregroundResumeTimer = setTimeout(() => {
      foregroundResumeTimer = null;
      // 排队期间换了会话 / 退出登录：这次恢复属于旧归属，直接作废。
      if (state.session !== session || (state.principal ?? null) !== principal) return;
      // 已经又转回后台：等下一次真正回到前台再说。
      if (document.visibilityState === 'hidden') return;
      connectWS();
      // 对账窗口从「重连已发起」开始算，而不是等 socket open：
      // 底层连接没醒过来时窗口照样会到期，那正是最需要拿历史对账的情形。
      // 回包晚到只会多取一次历史，不会误伤正在跑的流（收尾前还要再比一次事件计数）。
      if (typeof onForegroundResume !== 'function') return;
      try {
        onForegroundResume();
      } catch (err) {
        console.error('[hana] onForegroundResume error:', err);
      }
    }, FOREGROUND_RESUME_DELAY_MS);
  }

  /** 页面可见性与焦点：回到前台确保连接在，转后台取消排队中的恢复。 */
  function watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.session) {
        scheduleForegroundResume();
      } else if (document.visibilityState === 'hidden') {
        suspendForegroundResume();
        if (actionConfirmation && typeof actionConfirmation.cancelAll === 'function') {
          actionConfirmation.cancelAll();
        }
      }
    });
    // Android 只给 focus（visibilityState 恒 visible）；桌面浏览器切窗口也给。
    window.addEventListener('focus', () => {
      if (state.session) scheduleForegroundResume();
    });
    window.addEventListener('blur', () => {
      suspendForegroundResume();
    });
  }

  /** 未捕获错误与未处理的 Promise 拒绝都要浮到界面上。 */
  function watchErrors() {
    window.addEventListener('error', (e) => fatal(e.message || '脚本错误'));
    window.addEventListener('unhandledrejection', (e) => fatal(e.reason?.message || String(e.reason || '未处理的异步错误')));
  }

  /**
   * 只在真正销毁文档时释放列表控制器。进 bfcache（persisted）不能 dispose，
   * 否则恢复后控制器永久失效、列表再也加载不出来；backToList / 隐藏也不释放。
   *
   * 刻意不在这里拆胶囊 / 主题：真销毁时整个 JS 上下文都要回收，拆了零收益；
   * 而「pagehide 了但文档其实还活着」（WebView 挂起之类）会把胶囊与自动跟随系统主题一起弄死。
   */
  function watchPagehide() {
    window.addEventListener('pagehide', (event) => {
      if (event?.persisted) return;
      suspendForegroundResume();
      sessionListController.dispose();
      namespaceTabs.dispose();
    });
  }

  // 可见性在创建时就绑上，和原来「模块尾部直接 addEventListener」的时机等价。
  watchVisibility();

  return {
    fatal,
    watchErrors,
    watchKeyboard,
    installLayoutProbe,
    watchPagehide,
    watchVisibility,
  };
}
