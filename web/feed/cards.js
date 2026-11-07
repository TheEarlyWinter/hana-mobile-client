/* 日报卡片：向宿主申请当前 revision 的 HTML 包并挂到沙箱 iframe 里。
 *
 * 两种上下文：
 * - list（保留原调用接口兼容性，不由当前列表调用）：按可见性惰性挂载，等高度消息才算 ready。
 * - reader（阅读层，界面唯一使用的方式）：由用户显式打开，最多一个；iframe 高度走
 *   CSS 百分比链（100%），folio 加 #feed-mode=open，native 完整文档只进
 *   sandbox=allow-scripts 的 srcdoc（head 最先严格 CSP + expanded hash + ready 脚本）。
 *   列表本身不铸卡、不取正文。
 *
 * iframe 只开 allow-scripts（不加 allow-same-origin / 顶层导航 / 弹窗），不注册聊天
 * 工具桥。ready 只能由本模块已登记 iframe 发来：folio 等 __hanaCardHeight 数值，native
 * 只认本次加载 token 的 __hanaReaderReady 握手。准备请求按 itemId+revision 合并，但只共享
 * 仍然有效的在途项；reset 作废在途结果。
 */

const DEFAULT_TIMEOUT_MS = 15000;
const HEIGHT_MAX = 100000;
/** 列表不内嵌、只能进阅读层看的宿主原生文档模板。 */
const NATIVE_DOCUMENT_TEMPLATE = 'automation-digest';
/**
 * 阅读层内联文档的 CSP：只允许内联脚本/样式与 data 图片。
 * 不能继承聊天页的工具权限；页面侧外发请求被 connect/form/frame 指令封住
 * （图片仅允许 data:，不引入外部资源）。
 */
const READER_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
].join('; ');
/** 宿主原生文档用 location.hash 决定展开：先设 hash 再让宿主脚本执行。 */
const READER_HASH_INIT = "<script>location.hash='digest-view=expanded'<\/script>";

/**
 * 目标文档就绪握手：脚本随目标文档一起解析，等文档 load 后再用两帧 rAF 确认布局已落地，
 * 向上报本次加载的 token。iframe 的初始 about:blank 里没有这段脚本，所以空白 load 永不会
 * 被误判为就绪。
 */
function readerReadyScript(token) {
  return `<script>(function(){window.__hanaReaderToken = ${JSON.stringify(token)};`
    + 'function ping(){try{parent.postMessage({__hanaReaderReady:'
    + `${JSON.stringify(token)}},'*')}catch(e){}}`
    + 'function settle(){if(window.requestAnimationFrame){requestAnimationFrame(function(){requestAnimationFrame(ping)})}else{setTimeout(ping,0)}}'
    + "if(document.readyState==='complete'){settle()}else{window.addEventListener('load',function(){settle()})}"
    + '})()<\/script>';
}

function readerHeadInject(token) {
  return `<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">${READER_HASH_INIT}${readerReadyScript(token)}`;
}

/**
 * 把宿主原生文档包装成可放进 srcdoc 的字符串：
 * 第一个 head 里最前面插入严格 CSP 与 expanded hash 初始化；没有 head 就补一个，
 * 让浏览器的隐式 head 也拿到 CSP。
 */
function buildReaderDocument(html, token) {
  const inject = readerHeadInject(token);
  const text = String(html ?? '');
  const head = /<head\b[^>]*>/i.exec(text);
  if (head) {
    const at = head.index + head[0].length;
    return `${text.slice(0, at)}${inject}${text.slice(at)}`;
  }
  const htmlTag = /<html\b[^>]*>/i.exec(text);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${text.slice(0, at)}<head>${inject}</head>${text.slice(at)}`;
  }
  return `${inject}${text}`;
}

function cardError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function identityKey(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toCardError(err) {
  const code = err && typeof err.code === 'string' && err.code ? err.code : 'feed_card_error';
  const message = err && typeof err.message === 'string' && err.message ? err.message : '卡片加载失败';
  return { code, message };
}

/**
 * @param {object} options
 * @param {Document} [options.document]
 * @param {Window} [options.window]
 * @param {typeof IntersectionObserver} [options.IntersectionObserver]
 * @param {(item: import('./client.js').FeedItem, options: {isCurrent: () => boolean}) => Promise<{cardId:string,revision:number,url:string|null,html?:string}>} options.prepareCard
 * @param {ReturnType<import('./read-tracker.js').createFeedReadTracker>} [options.readTracker]
 * @param {() => object|null} [options.getIdentity]
 * @param {(err: Error) => void} [options.onError]
 * @param {number} [options.timeoutMs]
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 */
export function createFeedCards({
  document: doc = globalThis.document,
  window: win = globalThis.window,
  IntersectionObserver: Observer = globalThis.IntersectionObserver,
  prepareCard,
  readTracker = null,
  getIdentity,
  onError,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimeout: setTimeoutFn = globalThis.setTimeout,
  clearTimeout: clearTimeoutFn = globalThis.clearTimeout,
} = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createFeedCards 需要 document');
  }
  if (typeof prepareCard !== 'function') throw new TypeError('createFeedCards 需要 prepareCard');

  const records = new Set();
  const byNode = new Map();
  const inflight = new Map();
  const timers = new Set();
  let observer = null;
  let generation = 0;
  let destroyed = false;
  let listening = false;
  let readerTokenSeq = 0;

  const waitMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

  function report(err) {
    if (typeof onError !== 'function') return;
    try {
      onError(err);
    } catch {
      // 回调出错不能打断卡片收尾。
    }
  }

  function currentIdentityKey() {
    if (typeof getIdentity !== 'function') return 'none';
    try {
      return identityKey(getIdentity());
    } catch (err) {
      report(err);
      return 'error';
    }
  }

  function ensureObserver() {
    if (observer) return observer;
    if (typeof Observer !== 'function') return null;
    try {
      observer = new Observer(
        (entries) => {
          if (destroyed) return;
          for (const entry of entries) {
            const record = byNode.get(entry.target);
            if (!record) continue;
            const ratio =
              typeof entry.intersectionRatio === 'number'
                ? entry.intersectionRatio
                : entry.isIntersecting
                  ? 1
                  : 0;
            if (entry.isIntersecting === true || ratio > 0) load(record);
          }
        },
        { rootMargin: '240px 0px', threshold: 0 },
      );
    } catch {
      observer = null;
    }
    return observer;
  }

  /** 卡片 ready：只做一次标记与通知。 */
  function markReady(record) {
    if (record.ready) return;
    clearRecordTimer(record);
    record.ready = true;
    record.state = 'mounted';
    try {
      readTracker?.markReady?.(record.item.itemId, record.item.revision);
    } catch {
      // tracker 已被销毁时忽略。
    }
  }

  function onMessage(event) {
    if (destroyed || !event) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // native 阅读层：只认带本次加载 token 且来自登记 iframe 的握手。
    if (typeof data.__hanaReaderReady === 'string') {
      for (const record of records) {
        if (record.state !== 'mounted' || !record.native || !record.iframe || record.ready) continue;
        if (!record.token || record.token !== data.__hanaReaderReady) continue;
        const source = record.source || record.iframe.contentWindow;
        if (!source || event.source !== source) continue;
        record.source = source;
        markReady(record);
      }
      return;
    }

    const height = data.__hanaCardHeight;
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > HEIGHT_MAX) {
      return;
    }
    for (const record of records) {
      if (record.state !== 'mounted' || !record.iframe) continue;
      if (record.node && record.node.isConnected === false) continue;
      const source = record.source || record.iframe.contentWindow;
      if (!source || event.source !== source) continue;
      record.source = source;
      // 阅读层 iframe 就是可用视口：高度消息只作 folio 的 ready 信号，不改 iframe 高度。
      if (record.mode !== 'reader') {
        record.iframe.style.height = `${Math.round(height)}px`;
        record.iframe.style.visibility = 'visible';
      }
      // native 内联文档只认 token 握手，高度消息不参与。
      if (record.native) continue;
      markReady(record);
    }
  }

  function ensureListener() {
    if (listening || typeof win?.addEventListener !== 'function') return;
    win.addEventListener('message', onMessage);
    listening = true;
  }

  function removeListener() {
    if (!listening || typeof win?.removeEventListener !== 'function') return;
    win.removeEventListener('message', onMessage);
    listening = false;
  }

  function clearRecordTimer(record) {
    if (record.timer === null) return;
    clearTimeoutFn(record.timer);
    timers.delete(record.timer);
    record.timer = null;
  }

  function releaseRecord(record) {
    if (!record || !records.has(record)) return;
    record.attempt += 1;
    record.state = 'released';
    record.token = null;
    clearRecordTimer(record);
    try {
      observer?.unobserve?.(record.node);
    } catch {
      // observer 已经被断开时忽略。
    }
    if (record.iframe) {
      const iframe = record.iframe;
      record.iframe = null;
      unloadFrame(iframe);
    }
    record.source = null;
    record.ready = false;
    record.body.replaceChildren();
    records.delete(record);
    if (byNode.get(record.node) === record) byNode.delete(record.node);
    readTracker?.unobserve?.(record.node);
    if (records.size === 0) {
      try {
        observer?.disconnect?.();
      } catch {
        // 忽略已断开的 observer。
      }
      observer = null;
      removeListener();
    }
  }

  /**
   * 卸下一帧：先清除 srcdoc 字符串、再导航到 about:blank、最后移除节点。
   * 显式清空文档，便于验证释放流程；不依赖节点何时被垃圾回收。
   */
  function unloadFrame(iframe) {
    try {
      if (typeof iframe.removeAttribute === 'function') iframe.removeAttribute('srcdoc');
      iframe.style.height = '';
      iframe.style.visibility = 'hidden';
      iframe.src = 'about:blank';
    } catch {
      // 某些 WebView 对已卸载 iframe 写 src 会抛错，释放节点仍由界面完成。
    }
    iframe.remove?.();
  }

  function startHeightTimeout(record) {
    clearRecordTimer(record);
    const attempt = record.attempt;
    const timer = setTimeoutFn(() => {
      if (record.timer === timer) record.timer = null;
      timers.delete(timer);
      if (
        destroyed ||
        record.generation !== generation ||
        record.attempt !== attempt ||
        record.state !== 'mounted' ||
        record.ready ||
        !record.iframe
      ) {
        return;
      }
      const iframe = record.iframe;
      record.iframe = null;
      record.source = null;
      record.ready = false;
      unloadFrame(iframe);
      const error = cardError('feed_card_height_timeout', '卡片正文高度等待超时，请重试');
      showError(record, error);
      report(error);
    }, waitMs);
    record.timer = timer;
    timers.add(timer);
  }

  function showLoading(record) {
    record.body.replaceChildren();
    const loading = doc.createElement('div');
    loading.className = 'feed-card-loading';
    loading.textContent = '卡片加载中…';
    record.body.appendChild(loading);
  }

  /** 列表里不内嵌正文的条目（如原生文档）：只提示去阅读全文，不铸卡也不错误重试。 */
  function showNote(record, text) {
    record.state = 'note';
    record.body.replaceChildren();
    const box = doc.createElement('div');
    box.className = 'feed-card-note';
    box.textContent = text;
    record.body.appendChild(box);
  }

  function showError(record, error) {
    record.state = 'error';
    record.body.replaceChildren();
    const box = doc.createElement('div');
    box.className = 'feed-card-error';
    box.textContent = error.message || '卡片加载失败';
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'feed-card-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', () => {
      if (destroyed || record.state === 'loading' || record.state === 'mounted') return;
      load(record);
    });
    box.appendChild(retry);
    record.body.appendChild(box);
  }

  /** 原生内联文档只认 ready token 握手（见 readerReadyScript），不再依赖 load 事件。 */

  function mount(record, result) {
    const readerMode = record.mode === 'reader';
    const nativeHtml = readerMode && typeof result.html === 'string' && result.html ? result.html : null;
    if (!nativeHtml && result.url === null) {
      throw cardError(
        'feed_card_unavailable',
        readerMode
          ? '这条日报没有可展开的正文，暂时只能看列表里的信息'
          : '这个模板没有网页正文，暂时只能看上面的信息',
      );
    }

    record.body.replaceChildren();
    const iframe = doc.createElement('iframe');
    iframe.className = 'feed-card-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', record.item.title || '日报卡片');
    iframe.dataset.itemId = record.item.itemId;
    iframe.dataset.revision = String(record.item.revision);
    // 高度不进像素：阅读层用 CSS 百分比链，旋转/改窗口自动跟随。
    iframe.style.height = readerMode ? '100%' : '0px';
    iframe.style.visibility = readerMode ? 'visible' : 'hidden';
    record.iframe = iframe;
    record.source = null;
    record.ready = false;
    record.native = Boolean(nativeHtml);
    record.state = 'mounted';
    record.token = null;

    if (nativeHtml) {
      // 宿主原生文档只走 srcdoc：不导航到任何 URL，也不把 HTML 放进父 DOM。
      // 只写一次（属性）且插进 DOM 之前写：双写会触发两次内联文档导航。
      readerTokenSeq += 1;
      record.token = `feed-reader-${readerTokenSeq}`;
      iframe.setAttribute('srcdoc', buildReaderDocument(nativeHtml, record.token));
    } else if (readerMode) {
      iframe.src = result.url.includes('#') ? result.url : `${result.url}#feed-mode=open`;
    } else {
      iframe.src = result.url;
    }

    record.body.appendChild(iframe);
    // iframe 进入文档后才登记 contentWindow，用于校验消息来源。
    record.source = iframe.contentWindow || null;
    ensureListener();
    startHeightTimeout(record);
  }

  /**
   * 准备请求按 itemId+revision 合并，但只共享“仍然有效”的在途请求。
   * 每个 inflight 项带自己的 isCurrent：关闭/释放会让旧项的归属失效，同 key 重开必须
   * 开新请求，不能接到旧项上；旧项迟到完成也不能删掉新项。
   */
  function prepareFor(item, isCurrent) {
    const key = `${item.itemId}:${item.revision}`;
    const existing = inflight.get(key);
    if (existing) {
      let alive = false;
      try {
        alive = typeof existing.isCurrent === 'function' && existing.isCurrent();
      } catch {
        alive = false;
      }
      if (alive) return { key, entry: existing };
    }
    const entry = { promise: null, isCurrent };
    entry.promise = Promise.resolve().then(() => prepareCard(item, { isCurrent }));
    inflight.set(key, entry);
    const clear = () => {
      if (inflight.get(key) === entry) inflight.delete(key);
    };
    entry.promise.then(clear, clear);
    return { key, entry };
  }

  function withTimeout(preparation, record) {
    const { key, entry } = preparation;
    return new Promise((resolve, reject) => {
      const timer = setTimeoutFn(() => {
        if (record.timer === timer) record.timer = null;
        timers.delete(timer);
        if (inflight.get(key) === entry) inflight.delete(key);
        reject(cardError('feed_card_timeout', '卡片准备超时，请重试'));
      }, waitMs);
      record.timer = timer;
      timers.add(timer);
      Promise.resolve(entry.promise).then(
        (value) => {
          if (record.timer === timer) {
            clearTimeoutFn(timer);
            timers.delete(timer);
            record.timer = null;
          }
          resolve(value);
        },
        (err) => {
          if (record.timer === timer) {
            clearTimeoutFn(timer);
            timers.delete(timer);
            record.timer = null;
          }
          reject(err);
        },
      );
    });
  }

  function load(record) {
    if (destroyed || !records.has(record) || record.generation !== generation) return;
    if (record.state === 'loading' || record.state === 'mounted') return;

    const attempt = (record.attempt += 1);
    record.state = 'loading';
    showLoading(record);
    const expectedIdentity = currentIdentityKey();
    const expectedGeneration = generation;
    // 失效/关闭/超时/换条目后，分片读取在下一片前停下，迟到的结果也不挂回 DOM。
    const isCurrent = () => (
      !destroyed &&
      expectedGeneration === generation &&
      record.generation === generation &&
      record.attempt === attempt &&
      record.state === 'loading' &&
      currentIdentityKey() === expectedIdentity
    );
    const prepared = withTimeout(prepareFor(record.item, isCurrent), record);

    prepared
      .then((result) => {
        if (destroyed || expectedGeneration !== generation || record.generation !== generation) return;
        if (record.attempt !== attempt || record.state !== 'loading') return;
        if (currentIdentityKey() !== expectedIdentity) return;
        mount(record, result);
      })
      .catch((err) => {
        if (destroyed || expectedGeneration !== generation || record.generation !== generation) return;
        if (record.attempt !== attempt || record.state !== 'loading') return;
        const error = toCardError(err);
        showError(record, error);
        report(err);
      });
  }

  function render(item, context = {}) {
    if (destroyed) {
      const dead = doc.createElement('div');
      dead.className = 'feed-card feed-card-destroyed';
      return dead;
    }

    const mode = context?.mode === 'reader' ? 'reader' : 'list';
    const node = doc.createElement('div');
    node.className = mode === 'reader' ? 'feed-card feed-card-reader' : 'feed-card';
    node.dataset.itemId = item.itemId;
    node.dataset.revision = String(item.revision);
    const body = doc.createElement('div');
    body.className = 'feed-card-body';
    node.appendChild(body);

    const record = {
      node,
      body,
      item,
      mode,
      context: context || {},
      generation,
      state: 'idle',
      attempt: 0,
      timer: null,
      iframe: null,
      source: null,
      ready: false,
      native: false,
      token: null,
    };
    records.add(record);
    byNode.set(node, record);

    // 列表不为原生模板铸卡、不取正文，也不拿标题当已读；用户点阅读全文才进阅读层。
    if (mode === 'list' && item.template === NATIVE_DOCUMENT_TEMPLATE) {
      showNote(record, '这条日报不内嵌列表正文，点「阅读全文」查看完整内容');
      return node;
    }

    try {
      readTracker?.observe?.(node, item, {
        slateId: context?.slateId,
        position: context?.position,
      });
    } catch {
      // 阅读计时只是增强，不能阻断卡片占位。
    }

    if (mode === 'reader') {
      // 阅读层是用户显式打开的：不靠可见性探测，立即准备并挂载。
      load(record);
      return node;
    }

    const io = ensureObserver();
    if (io) io.observe(node);
    else showError(record, cardError('feed_card_visibility_unsupported', '当前环境无法检测可见区域，卡片未加载'));

    return node;
  }

  function release(node) {
    releaseRecord(byNode.get(node));
  }

  function reset() {
    generation += 1;
    for (const record of [...records]) releaseRecord(record);
    inflight.clear();
    for (const timer of timers) clearTimeoutFn(timer);
    timers.clear();
    try {
      observer?.disconnect?.();
    } catch {
      // 忽略已断开的 observer。
    }
    observer = null;
    removeListener();
  }

  function destroy() {
    if (destroyed) return;
    reset();
    destroyed = true;
    removeListener();
  }

  return { render, release, reset, destroy };
}
