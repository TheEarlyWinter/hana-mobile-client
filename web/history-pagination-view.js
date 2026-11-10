/* web/history-pagination-view.js
 *
 * 历史分页的纯 DOM 视图。
 *
 * 职责边界（父代理划定）：
 *   - 只渲染「加载更早 / 重试 / 生成中稍后重试」这一条控制带；
 *   - 失败文案按 phase 区分首屏（initial）与翻页（older）：首屏没出来是「会话加载失败」，
 *     翻页断了才是「加载更早失败」，避免把整页失败读成历史翻到一半；
 *   - 只提供临时插入锚点与 append(node)，保证更早页的节点一开始就落在旧消息之前；
 *   - 不做 fetch、不读 S、不 import 任何业务/状态模块，也不保存分页状态；
 *   - 不移动任何已存在的节点（iframe 一旦挂上就不再搬家，避免重载打断 nonce / MessageChannel）。
 *
 * 分页状态（loading / hasMore / error / 游标 / 去重）全部由 history-pager 持有，
 * app 只把 onState / onPage 喂进来；本模块不猜业务，也不碰 S.busy。
 *
 * 滚动：
 *   - 初始最新页由 app 在渲染完后自己 scrollToBottom；
 *   - beginPrepend() 记下「旧内容的第一条」当参照锚点，连同它此刻的 getBoundingClientRect().top；
 *     endPrepend() 与随后的采样都只按锚点 top 的增量回填 scrollTop，让用户停在原来
 *     看的那条消息上，而不是被拽到底部；
 *   - 只认锚点位移，不认 scrollHeight 增量：生成中助手在锚点**下方**往下长，scrollHeight 会涨
 *     但锚点 top 不动；按高度算就会把这段流式增长当成「前面插进来的」，把用户往回带
 *     （docs/audit/2026-11-05-history-preview-fix.md 的 Minor 记录）；
 *   - 一次同步测量之后，图片 / 卡片 iframe 还会继续把 prepend 内容撑开：endPrepend 起在
 *     settleMs 窗口内继续按锚点位移补偿，用户自己滚了就立刻收手；锚点消失则结束观察；
 *   - 补偿窗口里「scrollTop 变了」有三种来源：本模块写的、装配层写的（scrollPin.pinNow /
 *     restorePendingScroll / renderer.scrollToBottom）、用户自己滚的。前两种都得放行，只有用户
 *     才收手，所以这里有一份显式记账（book.written / book.declared）而不是拿单一期望值去比；
 *     装配层的写入点在写完之后调一次 noteProgrammaticScroll() 报备即可（G7）；
 *   - 锚点上方变矮（控制带在 onPage 之后才收起，约 50px）也要补，否则翻到最后一页会看到内容
 *     上跳一截。但只补「记账里有主」的那一段（shrinkBudget），外部内容自己塌下去不补——
 *     那会把用户往上拽（G8）。
 *   - appendCard / appendUser 这类带强制滚动的路径由 app 用 isPrepending() 跳过。
 */

/**
 * @param {object} [options]
 * @param {Document} [options.document] - DOM 工厂，杜绝全局隐式读取
 * @param {HTMLElement} [options.container] - 消息容器（通常是 #transcript）
 * @param {Function} [options.onLoadOlder] - 点「加载更早 / 重试」
 * @param {object} [options.labels] - 覆盖默认文案
 * @param {() => number} [options.now] - 时钟（测试注入假时钟）
 * @param {(fn: Function, ms: number) => any} [options.schedule] - 定时器
 * @param {(id: any) => void} [options.cancelSchedule] - 取消定时器
 * @param {number} [options.settleMs=1200] - prepend 之后观察锚点位移的总窗口
 * @param {number} [options.sampleMs=100] - 采样间隔
 * @param {number} [options.stableMs=450] - 锚点多久没有正位移后提前收手
 * @returns {{
 *   setState: (state: {loading?: boolean, hasMore?: boolean, error?: any, phase?: 'initial'|'older'}) => void,
 *   beginPrepend: () => boolean,
 *   append: (node: any) => void,
 *   endPrepend: () => boolean,
 *   isPrepending: () => boolean,
 *   reset: () => void,
 *   dispose: () => void,
 *   noteProgrammaticScroll: (top?: number) => number,
 * }}
 */
export function createHistoryPaginationView({
  document: doc,
  container,
  onLoadOlder = () => {},
  labels = {},
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = (id) => clearTimeout(id),
  settleMs = 1200,
  sampleMs = 100,
  stableMs = 450,
} = {}) {
  if (!doc) throw new Error('createHistoryPaginationView requires { document }');
  if (!container) throw new Error('createHistoryPaginationView requires { container }');

  const copy = {
    loadOlder: '加载更早',
    loading: '加载中…',
    retry: '重试',
    busy: '正在生成回复，稍后再加载更早的消息',
    busyInitial: '正在生成回复，稍后重新加载会话',
    failed: '加载更早失败',
    initialFailed: '会话加载失败',
    ...labels,
  };

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const bar = el('div', 'history-pagination-bar');
  bar.hidden = true;

  const button = el('button', 'history-load-older', copy.loadOlder);
  if (typeof button.setAttribute === 'function') button.setAttribute('type', 'button');
  const status = el('div', 'history-pagination-status', '');

  bar.appendChild(button);
  bar.appendChild(status);

  let prependAnchor = null;
  // 锚点位移法的两个量：被参照的旧节点，以及它的**内容坐标**（视口 top + scrollTop）。
  // 基准用内容坐标而不是视口坐标：用户滚动只改 scrollTop 那一半，内容坐标不动，
  // 所以「锚点上方长高 / 变矮了多少」永远不含用户自己滚的那一段。
  let measureAnchor = null;
  let measureContent = null;
  let disposed = false;
  // prepend 之后的晚到位移补偿：{ timer, startedAt, lastChangeAt, anchor, baseContent }
  let settle = null;
  // 本模块自己造成、还没被采样消耗掉的高度缩减额度（控制带收起时量下来记的）。
  // 负位移补偿只认这个额度：没有主的高度缩水一律不补（见 shrinkAllowance）。
  let shrinkBudget = 0;

  /** 控制带永远是容器第一个子节点；容器被 innerHTML 清空后会被重新挂回去。 */
  function ensureBar() {
    if (bar.parentNode === container) return;
    const first = container.children && container.children.length ? container.children[0] : null;
    container.insertBefore(bar, first);
  }

  function setButton(label, disabled) {
    button.textContent = label;
    button.disabled = Boolean(disabled);
  }

  /**
   * phase 只由 pager 提供：'initial' 是首屏 open() 的请求，'older' 是「加载更早」。
   * 缺省（旧调用方）一律按 older 处理，文案与改动前完全一致。
   */
  function errorText(error, phase) {
    if (!error) return '';
    const prefix = phase === 'initial' ? copy.initialFailed : copy.failed;
    if (typeof error === 'object') {
      if (error.code === 'busy') return phase === 'initial' ? copy.busyInitial : copy.busy;
      return `${prefix}：${error.message || String(error)}`;
    }
    return `${prefix}：${String(error)}`;
  }

  /** 控制带当前高度；量不到（极简嵌入 / 没有布局 / 已不在文档里）返回 0。 */
  function barHeight() {
    if (bar.parentNode !== container) return 0;
    const rect = typeof bar.getBoundingClientRect === 'function' ? bar.getBoundingClientRect() : null;
    const fromRect = rect ? Number(rect.height) : NaN;
    if (Number.isFinite(fromRect) && fromRect > 0) return fromRect;
    const fromOffset = Number(bar.offsetHeight);
    return Number.isFinite(fromOffset) && fromOffset > 0 ? fromOffset : 0;
  }

  /**
   * 控制带显隐。收起的时刻很关键：pager 先 onPage 再 onState，控制带永远在 prepend 落地
   * **之后**才隐藏，而它是容器的第一个子节点——它一没，锚点上方立刻矮一截（一行按钮加内边距，
   * 约 50px）。所以隐藏之前先量高度记进 shrinkBudget，让补偿窗口把这段负位移补回来；
   * 量不到就记 0，宁可不补也不猜（G8）。
   */
  function applyBarVisibility(visible) {
    if (visible) {
      bar.hidden = false;
      return;
    }
    if (bar.hidden === true) return;
    const lost = barHeight();
    bar.hidden = true;
    if (lost > 0) shrinkBudget += lost;
  }

  function setState({ loading = false, hasMore = false, error = null, phase = null } = {}) {
    if (disposed) return;
    ensureBar();

    const visible = Boolean(loading || hasMore || error);
    applyBarVisibility(visible);
    if (!visible) {
      status.textContent = '';
      setButton(copy.loadOlder, false);
      return;
    }
    if (loading) {
      // 生成中/加载中都不允许再点，避免并发；按钮文案明确表示还在进行。
      setButton(copy.loading, true);
      status.textContent = '';
      return;
    }
    if (error) {
      setButton(copy.retry, false);
      status.textContent = errorText(error, phase);
      return;
    }
    setButton(copy.loadOlder, false);
    status.textContent = '';
  }

  /**
   * 量一个元素的视口坐标；量不到（极简嵌入的假 DOM 没有布局）返回 null，调用方按「不补」处理。
   */
  function rectTop(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    const rect = node.getBoundingClientRect();
    if (!rect) return null;
    const top = Number(rect.top);
    return Number.isFinite(top) ? top : null;
  }

  /** 容器里第一条真正的内容节点：跳过控制带与 prepend 占位结点，它们不是用户的阅读锚点。 */
  function firstContentChild() {
    for (const child of container.children || []) {
      if (child === bar || child === prependAnchor) continue;
      return child;
    }
    return null;
  }

  /* ---------------------- prepend 之后晚到的位移 ---------------------- */

  /*
   * 插进去的那一刻量到的高度只是「同步渲染完」的高度：图片还在下载、卡片 iframe 还没
   * 上报自己的高度，它们会在之后几百毫秒里陆续把内容撑开。不补这段增量，用户正在
   * 看的那一行就会往下跑（因为新内容全在它上面）。
   *
   * 补多少只问锚点：beginPrepend 时记住旧内容的第一条（它下面全是旧消息），新页插在它
   * 上面，它的 top 被往下推了多少就补多少。生成中的流式内容长在锚点下方，它的 top 不动，
   * 于是这里的位移天然只包含「前面插进来的高度」，不用再按 scrollHeight 去猜（那会把流式
   * 增长算成 prepend，见 docs/audit/2026-11-05-history-preview-fix.md 的 Minor 记录）。
   *
   * 做法：endPrepend 之后开一个观察窗口（默认 1.2 秒），每次采样只把锚点 top 的正增量
   * 加进 scrollTop；用户自己滚了（滚动事件里的位置与我们的预期值对不上）就立刻收手，
   * 以用户位置为准。连续 stableMs 没有正增量时提前结束。
   */
  function stopSettle({ keepAnchorPolicy = false } = {}) {
    // 即使 settle 已经是 null 也要还原：mute 是在 beginPrepend 就上的，可能比窗口先存在。
    if (settle && settle.timer != null) {
      try {
        cancelSchedule(settle.timer);
      } catch (err) {
        // 取消失败也要把状态丢掉，宁可不补也不能一直挂着。
      }
    }
    settle = null;
    if (!keepAnchorPolicy) restoreAnchorPolicy();
  }

  /*
   * 补偿窗口内临时关掉浏览器的 scroll anchoring。它会自己改 scrollTop，既和我们的
   * 锚点位移叠在一起，又会被记账判成「用户自己滚了」而提前收手。
   * 窗口一结束就还原成它本来的内联值（不是硬写空串）——平时「历史里图片加载把内容
   * 撑高」那种场景仍交给浏览器管。
   */
  let anchorPolicySaved = '';
  let anchorPolicyMuted = false;

  function muteAnchorPolicy() {
    if (!container || !container.style || !('overflowAnchor' in container.style)) return;
    if (!anchorPolicyMuted) {
      anchorPolicySaved = container.style.overflowAnchor || '';
      anchorPolicyMuted = true;
    }
    container.style.overflowAnchor = 'none';
  }

  function restoreAnchorPolicy() {
    if (!anchorPolicyMuted) return;
    if (container && container.style && 'overflowAnchor' in container.style) {
      container.style.overflowAnchor = anchorPolicySaved;
    }
    anchorPolicyMuted = false;
    anchorPolicySaved = '';
  }

  /* ------------------ 程序化滚动记账（G7） ------------------ */

  /*
   * 补偿窗口里必须分清三种「scrollTop 变了」：
   *   1. 本模块写的（同步回填、晚到位移补偿）；
   *   2. 装配层写的（scrollPin.pinNow() 贴底、restorePendingScroll() 恢复阅读位置、
   *      renderer.scrollToBottom()）；
   *   3. 用户自己滚的。
   * 1、2 都要放行，只有 3 才收手——用户位置永远优先。浏览器抛的 scroll 事件里没有「谁干的」，
   * 所以两份账都得记，不靠猜：
   *   - book.written：本模块最后一次**真正生效**的写入值（写完立刻回读，浏览器会 clamp）；
   *   - book.declared：装配层报备过的写入值（noteProgrammaticScroll），留最近 4 个——
   *     一拍里可能连写两次，scroll 事件也可能晚到一拍。
   * 比对统一用 ±SCROLL_EPS（亚像素舍入）。
   */
  const SCROLL_EPS = 1;
  const book = { written: 0, declared: [] };

  function readScrollTop() {
    return Number(container.scrollTop) || 0;
  }

  /**
   * 内容坐标：视口 top + scrollTop。
   *
   * 这个量只随「节点上方的内容高度」变化：用户滚动、装配层贴底、我们写 scrollTop 都不改它
   * （它们同时改 top 与 scrollTop，一加一减正好抵消）。所以内容坐标差 = 锚点上方长高 / 变矮
   * 了多少，正是要补的那一段；用户滚了多少从来不会混进来。
   * 量不到布局（极简嵌入）返回 null，调用方按「不补」处理。
   */
  function contentTopOf(node) {
    const top = rectTop(node);
    if (top == null) return null;
    return top + readScrollTop();
  }

  /** 所有程序化改滚动位置都走这里：写、回读生效值、记账。 */
  function writeScrollTop(next) {
    try {
      container.scrollTop = next;
    } catch (err) {
      // 极简嵌入的容器可能没有可写的 scrollTop：以回读为准，不算错。
    }
    const applied = readScrollTop();
    book.written = applied;
    return applied;
  }

  function rememberDeclared(value) {
    const top = Number(value);
    if (!Number.isFinite(top)) return;
    if (book.declared.some((x) => Math.abs(x - top) <= SCROLL_EPS)) return;
    book.declared.push(top);
    if (book.declared.length > 4) book.declared.shift();
  }

  /** 这一拍的位置是不是我自己写的。 */
  function matchesWritten(top) {
    return Math.abs(top - book.written) <= SCROLL_EPS;
  }

  /** 是不是装配层报备过的位置；认领一次就销账，同一个值不会长期吞掉真用户滚动。 */
  function consumeDeclared(top) {
    const index = book.declared.findIndex((x) => Math.abs(x - top) <= SCROLL_EPS);
    if (index === -1) return false;
    book.declared.splice(index, 1);
    return true;
  }

  /**
   * 装配层报备一次「这个 scrollTop 是我写的」（G7）。
   *
   * 必须在写完**之后**立刻调用（scrollPin.pinNow() 贴底、restorePendingScroll() 恢复阅读
   * 位置、renderer.scrollToBottom()）。不报备的话，紧随的 scroll 事件只会被认成用户滚动，
   * 补偿窗口提前收手——方向安全，但「保持阅读位置」名不副实。
   *
   * @param {number} [top] 写入的目标值；缺省读当前生效值
   * @returns {number} 记账用的生效值（浏览器 clamp 过的）
   */
  function noteProgrammaticScroll(top) {
    const applied = readScrollTop();
    rememberDeclared(applied);
    const requested = Number(top);
    if (Number.isFinite(requested) && Math.abs(requested - applied) > SCROLL_EPS) {
      // 目标值与生效值不同（写入还没被布局吸收）：scroll 事件可能报目标值，两个都认。
      rememberDeclared(requested);
    }
    return applied;
  }

  /**
   * 每一拍：量锚点的内容坐标差，把锚点上方的高度变化补掉。
   *
   * 正位移（上面长高：晚到的图片 / 卡片）无条件补；负位移（上面变矮）只有记账里有主时才补
   * （判据见 shrinkAllowance）。
   * 每拍都把基线复位成实测值：内容坐标补完之后**不会**自己回到旧值（补的只是 scrollTop，
   * 布局早就变了），不复位就会下一拍把同一段位移再补一次。
   */
  function settleTick() {
    if (!settle) return;
    settle.timer = null;
    if (disposed) {
      stopSettle();
      return;
    }

    const t = now();
    const anchor = settle.anchor;
    // 锚点被替换 / 移除（整页重绘、切会话、容器被清空）：这时已经没法区分「上面插进来的」
    // 与「下面流式长出来的」，能用的只剩高度法——而那正是本单元要修的误算来源。
    // 所以选择「结束观察」：不再动用户的滚动位置，也不会因为高度变化把人往回带；
    // 真被整页重绘的情况由 app 自己的贴底 / 恢复逻辑接手。
    if (!anchor || anchor.parentNode !== container) {
      stopSettle();
      return;
    }
    const content = contentTopOf(anchor);
    if (content == null) {
      // 量不到布局（极简嵌入）：没什么可补，直接收手，不猜。
      stopSettle();
      return;
    }

    const delta = content - settle.baseContent;
    // 先复位基线再补：内容坐标不会因为写 scrollTop 而变（滚动的两个分量一加一减抵消），
    // 所以同一段位移必须在这里销账，否则下一拍会再补一次。
    settle.baseContent = content;

    if (delta > SCROLL_EPS) {
      // 锚点上方长高了：补平，用户看到的仍是原来那一行。补到不了的位置由容器自己 clamp，
      // 基线已经复位，不会反复补。
      writeScrollTop(readScrollTop() + delta);
      settle.lastChangeAt = t;
    } else if (delta < -SCROLL_EPS) {
      const allowance = shrinkAllowance(delta);
      if (allowance > 0) {
        // 只补有主的那一段（控制带收起）。宁可少补一像素，也不多补——多补就是把用户往上拽。
        writeScrollTop(readScrollTop() - allowance);
        shrinkBudget -= allowance;
        settle.lastChangeAt = t;
      }
    }

    if (t - settle.startedAt >= settleMs) {
      stopSettle();
      return;
    }
    // 已经见过正位移、并且稳定了一段时间：提前收手；从没动过就等满窗口（图片可能来得晚）。
    if (settle.lastChangeAt != null && t - settle.lastChangeAt >= stableMs) {
      stopSettle();
      return;
    }
    settle.timer = schedule(settleTick, sampleMs);
  }

  function startSettle(anchor) {
    // 换一页时只换观察对象，不能把锚定开关提前放开：后面的 tick 还在补。
    stopSettle({ keepAnchorPolicy: true });
    if (disposed) return;
    muteAnchorPolicy();
    // 没有可锚定的元素就没有基线：宁可不补，也不退回高度法把流式增长重新算进来。
    if (!anchor || anchor.parentNode !== container) {
      restoreAnchorPolicy();
      return;
    }
    const baseContent = contentTopOf(anchor);
    if (baseContent == null) {
      // 量不到布局：同样没有基线，别把锚定永久关掉。
      restoreAnchorPolicy();
      return;
    }
    // 新窗口从实测内容坐标起步；上一页（或上一拍）记下的缩水额度不能算到这一页头上。
    shrinkBudget = 0;
    const t = now();
    settle = {
      timer: null,
      startedAt: t,
      lastChangeAt: null,
      anchor,
      baseContent,
    };
    settle.timer = schedule(settleTick, sampleMs);
  }

  /**
   * 负位移（锚点上方变矮）该补多少？三条判据同时成立才补，任一条不成立返回 0：
   *
   *   1. **确认是高度缩水**：基准是内容坐标，用户滚动不改内容坐标，所以内容坐标变负只可能
   *      是布局变矮了——「锚点在视口里往上跑」这件事本身分不清是缩水还是用户在往下滚，
   *      内容坐标分得清。
   *   2. **缩水有主**：只补本模块自己造成的那一段。目前唯一来源是控制带收起
   *      （applyBarVisibility 在隐藏之前量高度记进 shrinkBudget）。外部内容自己塌下去
   *      （图片加载失败、卡片塌高）不补——那不是「我改了高度」，补它等于把用户往上拽。
   *   3. **位置没被别人改过**：当前 scrollTop 仍等于我最后一次写入的值。用户刚往下滚、
   *      scroll 事件还在路上时，这一拍就交给用户（用户真实滚动永远优先）。
   *
   * @param {number} delta 内容坐标差（负数）
   * @returns {number} 要补回的正像素数，0 表示不补
   */
  function shrinkAllowance(delta) {
    const loss = -delta;
    if (!(loss > 0)) return 0;
    if (shrinkBudget <= 0) return 0;
    if (!matchesWritten(readScrollTop())) return 0;
    return Math.min(loss, shrinkBudget);
  }

  /**
   * 滚动事件不冒泡但会经过捕获；这里只关心「补偿期间用户自己动了没有」。
   *
   * 不是用户滚动的两种情形都放行，否则补偿窗口会把装配层的贴底 / 恢复阅读位置当成用户滚动：
   *   - 位置等于本模块最后写入的值（book.written）；
   *   - 位置等于装配层报备过的值（noteProgrammaticScroll），认领一次销账。
   * 其余一律按用户滚处理：以用户位置为准，立刻收手。
   */
  function onContainerScroll() {
    if (!settle) return;
    const top = readScrollTop();
    if (matchesWritten(top)) return;
    if (consumeDeclared(top)) {
      book.written = top;
      return;
    }
    // 位置和我写的、装配层报备的都对不上：只可能是用户自己滚的。
    stopSettle();
  }
  // 极简嵌入时容器可能连事件接口都没有；没有就只做同步补偿，不影响主流程。
  if (typeof container.addEventListener === 'function') {
    container.addEventListener('scroll', onContainerScroll, { passive: true });
  }

  /**
   * 开始一页「更早」的插入：把锚点放在控制带之后、旧消息之前。
   * 之后所有 append(node) 都插到锚点前，节点从一开始就在最终位置，
   * 不会先挂到底部再搬家（搬家会重载 iframe）。
   */
  function beginPrepend() {
    if (disposed) return false;
    ensureBar();
    if (prependAnchor) return true;

    // 上一页的晚到位移补偿到此为止：新一页按自己的锚点重新量。
    stopSettle();
    muteAnchorPolicy();

    // 参照锚点：此刻旧内容的第一条。新页插在它上面，它被往下推多少就补多少；
    // 生成中的流式内容长在它下面，不会改变它的内容坐标（这就是本单元与高度法的差别）。
    measureAnchor = firstContentChild();
    measureContent = contentTopOf(measureAnchor);
    // 上一页收控制带记下的缩水额度与这一页无关，别算到它头上；旧窗口的报备值也一并作废，
    // 否则用户以后恰好滚回同一个位置时会被误认成「装配层写的」。
    shrinkBudget = 0;
    book.declared.length = 0;

    const anchor = doc.createElement('div');
    anchor.className = 'history-pagination-anchor';
    container.insertBefore(anchor, measureAnchor);
    prependAnchor = anchor;
    return true;
  }

  function append(node) {
    if (!node) return;
    if (prependAnchor && prependAnchor.parentNode === container) {
      container.insertBefore(node, prependAnchor);
      return;
    }
    container.appendChild(node);
  }

  /**
   * 结束插入：移除占位锚点，把滚动位置按锚点位移回填，保持阅读位置不变，
   * 然后继续盯一小段时间——图片 / 卡片之后撑开的 prepend 高度也要补上。
   */
  function endPrepend() {
    if (!prependAnchor) return false;
    const anchor = prependAnchor;
    prependAnchor = null;
    if (anchor.parentNode === container) container.removeChild(anchor);

    // 同步回填也走内容坐标差，天然扣掉「用户在这期间自己滚的那一段」：用户往上看多少，
    // scrollTop 就少多少，一加一减正好抵消——旧的高度法本来就不受滚动影响，不能比它差。
    if (measureAnchor && measureAnchor.parentNode === container) {
      const content = contentTopOf(measureAnchor);
      if (content != null && measureContent != null) {
        const grown = content - measureContent;
        measureContent = content;
        // 只补 prepend 撑出来的那一段；用户自己的滚动意图原样保留。
        if (grown > SCROLL_EPS) writeScrollTop(readScrollTop() + grown);
        // 变矮（卡片塌下 / 图片失败 / 控制带收起）这里不拽：同步这一段不认负位移，
        // 有主的缩水交给补偿窗口按 shrinkBudget 处理（见 shrinkAllowance）。
      } else {
        // 现在也量不到布局：没有可信的位移，不补也不观察。
        measureContent = null;
      }
    } else {
      // 锚点在这期间就没了（被替换 / 移除）：没有可信的位移，不补也不观察。
      measureAnchor = null;
      measureContent = null;
    }
    startSettle(measureAnchor);
    return true;
  }

  function isPrepending() {
    return Boolean(prependAnchor);
  }

  function reset() {
    stopSettle();
    if (prependAnchor && prependAnchor.parentNode === container) container.removeChild(prependAnchor);
    prependAnchor = null;
    measureAnchor = null;
    measureContent = null;
    applyBarVisibility(false);
    status.textContent = '';
    setButton(copy.loadOlder, false);
    book.declared.length = 0;
    shrinkBudget = 0;
  }

  function onButtonClick() {
    if (button.disabled) return;
    onLoadOlder();
  }
  button.addEventListener('click', onButtonClick);

  function dispose() {
    if (disposed) return;
    stopSettle();
    disposed = true;
    reset();
    button.removeEventListener('click', onButtonClick);
    if (typeof container.removeEventListener === 'function') {
      container.removeEventListener('scroll', onContainerScroll);
    }
    if (bar.parentNode === container) container.removeChild(bar);
  }

  return {
    setState,
    beginPrepend,
    append,
    endPrepend,
    isPrepending,
    reset,
    dispose,
    noteProgrammaticScroll,
  };
}
