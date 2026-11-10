/* web/pdf-preview.js — 手机端内置 PDF 预览：pdf.js 按需加载，逐页画到 canvas
 *
 * 为什么 pdfjs-dist 3.11.174（v3 最后一个版本）+ legacy 构建：
 *   - 目标是 Android WebView（Chrome ≥ 120）与桌面 Chrome/Edge，esbuild 打包 target 是 chrome100。
 *     v4 系列一路在追新运行时能力（Promise.withResolvers 之类，各小版本要求还不一致），
 *     一旦遇到 WebView 落后一点就整块白屏；v3 的 legacy 构建是 ES5 转译 + polyfill 的保守版本，
 *     在 chrome100 这个 target 下没有语法风险。
 *   - 非 legacy 构建（pdfjs-dist/build/pdf.js）试过：同一份代码只换入口路径，打包后
 *     pdf 360KB→300KB、worker 1080KB→1035KB，合计 1441KB→1335KB，差 106KB / 7.3%；
 *     在真 Chromium 上同样能跑通（numPages、文本、渲染像素完全一致）。
 *     但 7% 不足以改变「首次开 PDF 要拉一个 1.4MB 级 chunk」的量级，而且 legacy 多出的那份
 *     polyfill 恰好是 WebView 版本参差时的保险 —— 收益不够明显，故保持 legacy。
 *   - 版本写死（package.json 里 3.11.174，不用 ^），因为构建产物会随小版本漂；这个库的解析行为
 *     一改，30 页上限、canvas 尺寸这些都得重新量一遍。
 *
 * worker 怎么处理（关键决定：不新起独立 worker 资源）：
 *   pdf.js 默认要 `new Worker(GlobalWorkerOptions.workerSrc)`，那个 workerSrc 是个独立文件，
 *   在当前架构里必须带内容哈希、进 manifest、由网关发 immutable —— 多一个资源多一处可能配错的地方。
 *   pdf.js 自己留了后门：`PDFWorker._mainThreadWorkerMessageHandler` 读 `globalThis.pdfjsWorker
 *   .WorkerMessageHandler`，拿到就不建 Worker，直接在**主线程**用 LoopbackPort 跑（见
 *   pdfjs-dist/legacy/build/pdf.js 的 PDFWorker._initialize / _setupFakeWorkerGlobal）。
 *   所以这里把 worker 模块的 WorkerMessageHandler 挂到那个全局上，走「假 worker」路径：
 *   两个 UMD 模块都在同一个动态 import 里，最后一起被打进同一个按需 chunk，运行时零额外资源。
 *   代价是解析在主线程上（大页会占几帧），因此下面全程逐页、按可见范围渲染，并封顶 30 页。
 *
 * 体积契约（主包是硬指标）：
 *   本模块**不静态**依赖 pdfjs-dist —— 两个 import() 都写在 defaultLoadLibrary() 里，
 *   esbuild 走 splitting 时它们会变成独立 chunk。打开非 PDF 的预览时这里一个字节都不会被下载。
 *
 * 内存上限（Android WebView 上这是硬要求，不是优化）：
 *   一张 A4 页在 dpr 3 下是 1290×1824 ≈ 9.4MB 位图，30 页就是 280MB 量级 —— OOM。
 *   两道闸：
 *   1. canvas 的 devicePixelRatio 压到 MAX_DPR=2（不看真机 dpr），
 *      430px 宽的单张降到 860×1216 ≈ 4.2MB；
 *   2. 只保留当前页 ±EVICT_RADIUS 的位图，离开窗口的页 canvas 宽高归零并脱引用，
 *      滚回来重画（`rendered` 与 `painted` 两个集分开，回收过的页依然可重画）。
 *   在位的页数上限因此是 5，内存稳定在 21MB 量级，与文档总页数无关。
 *
 * 接口：
 *   mountPdf({ url, container, headers?, loadLibrary?, doc?, win? }) -> { destroy(), getState() }
 *   - url 用同源凭据 fetch；失败/不是 PDF/有密码都抛 PdfPreviewError（中文原因），
 *     调用方据此回落到「下载后打开」。
 *   - container 里的内容由本模块独占：mount 时清空，destroy 时清空。
 *   - loadLibrary 只给测试注入假库用，默认实现才是 import('pdfjs-dist/…')。
 */

export const MAX_PAGES = 30;
export const MAX_CANVAS_WIDTH = 1600;

/** pdf.js 只在文件头 1024 字节里找 %PDF-（PDF 规范允许头部前面有垃圾字节）。 */
const PDF_HEADER_WINDOW = 1024;
const PDF_HEADER = '%PDF-';
const DEFAULT_VIEW_WIDTH = 360;
/** 容器宽度变化小于这个值不重排（横竖屏切换、软键盘弹出都会抖）。 */
const RESIZE_TOLERANCE = 32;
/** 观察器预取范围：上下各多留一屏，滑动时不至于先看见空白。 */
const OBSERVER_MARGIN = '600px 0px';
/**
 * canvas 的 devicePixelRatio 上限。
 * 真机 dpr 常见 2.6～3.5，按真实值放大一张 A4 位图就是 9MB 量级（宽 1290 × 高 1824 × 4B），
 * 5 页窗口就吃 45MB，Android WebView 里这是会被系统直接杀掉的量级。
 * 压到 2 是清晰度与内存的分界线：430px 宽 × 2 = 860px，排版正文仍然锐利。
 */
const MAX_DPR = 2;
/**
 * 保留窗口：当前页 ±2。超过这个距离的页把 canvas 位图放掉（width/height 归零并脱引用），
 * 滚回来时重新渲染。5 页在位 ≈ 5 × 4.2MB（430px × dpr2 → 860×1216）≈ 21MB，是可以接受的上限。
 */
const EVICT_RADIUS = 2;

/* ------------------------------ 错误 ------------------------------ */

/** 预览失败一律用它：message 是可以直接给用户看的中文原因。 */
export class PdfPreviewError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PdfPreviewError';
    if (cause !== undefined) this.cause = cause;
  }
}

function toUserError(err) {
  if (err instanceof PdfPreviewError) return err;
  const name = String(err?.name || '');
  if (name === 'PasswordException') return new PdfPreviewError('这个 PDF 设置了打开密码，暂时打不开', err);
  if (name === 'InvalidPDFException') return new PdfPreviewError('这个文件不是 PDF（内容解析失败）', err);
  if (name === 'MissingPDFException') return new PdfPreviewError('PDF 文件不存在或已经被移走', err);
  if (name === 'UnexpectedResponseException') return new PdfPreviewError('PDF 读取失败（服务器返回异常）', err);
  const detail = err?.message ? `：${err.message}` : '';
  return new PdfPreviewError(`PDF 解析失败${detail}`, err);
}

/* ------------------------------ 库加载 ------------------------------ */

let libraryPromise = null;

/**
 * 默认库加载器：整个过程只发生一次，失败不缓存（下次打开还能重试）。
 * 注意这两个 import() 必须是动态的 —— 静态 import 会把 pdf.js 拉进主包。
 */
export function loadPdfLibrary() {
  if (!libraryPromise) {
    libraryPromise = defaultLoadLibrary().catch((err) => {
      libraryPromise = null;
      throw new PdfPreviewError('PDF 预览组件加载失败（可能是网络中断），可以下载后用系统应用打开', err);
    });
  }
  return libraryPromise;
}

async function defaultLoadLibrary() {
  const pdfModule = await import('pdfjs-dist/legacy/build/pdf.js');
  const workerModule = await import('pdfjs-dist/legacy/build/pdf.worker.js');
  installMainThreadWorker(workerModule);
  const api = pickPdfApi(pdfModule);
  if (typeof api?.getDocument !== 'function') {
    throw new Error('pdf.js 这个构建没有 getDocument');
  }
  return api;
}

/** CJS/UMD 的 interop 形状不确定：esbuild 打包后是具名导出，Node 里往往只有 default。 */
function pickPdfApi(mod) {
  if (mod && typeof mod.getDocument === 'function') return mod;
  const fallback = mod?.default;
  if (fallback && typeof fallback.getDocument === 'function') return fallback;
  return null;
}

/**
 * 把 worker 的 WorkerMessageHandler 挂到 globalThis.pdfjsWorker。
 * pdf.js 的 PDFWorker._mainThreadWorkerMessageHandler 只认这个全局；有它就不再 new Worker，
 * 主线程直接跑。挂在全局上是 pdf.js 自己的约定，不是这里的临时发明。
 */
function installMainThreadWorker(workerModule) {
  const handler = workerModule?.WorkerMessageHandler
    || workerModule?.default?.WorkerMessageHandler
    || null;
  if (!handler) return;
  globalThis.pdfjsWorker = { WorkerMessageHandler: handler };
}

/* ------------------------------ 取字节 ------------------------------ */

async function readPdfBytes({ url, headers, win }) {
  const fetchImpl = typeof win?.fetch === 'function' ? win.fetch : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PdfPreviewError('这个环境不支持读取文件（没有 fetch）');
  }
  let res;
  try {
    res = await fetchImpl(url, {
      credentials: 'same-origin',
      headers: headers && typeof headers === 'object' ? headers : undefined,
    });
  } catch (err) {
    throw new PdfPreviewError('PDF 读取失败（网络中断）', err);
  }
  if (!res || res.ok === false) {
    const status = res && res.status ? res.status : 0;
    throw new PdfPreviewError(`PDF 读取失败（HTTP ${status || '?'}）`);
  }
  let buffer;
  try {
    buffer = await res.arrayBuffer();
  } catch (err) {
    throw new PdfPreviewError('PDF 读取中断', err);
  }
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  assertLooksLikePdf(data);
  return data;
}

/**
 * 先自己判一次文件头：不花那 1.5MB 的库加载，也能给出「这不是 PDF」的确定结论。
 * 判据与 pdf.js 一致（头部 1024 字节内出现 %PDF-）。
 */
function assertLooksLikePdf(data) {
  if (!data || data.length < 8) throw new PdfPreviewError('这个文件不是 PDF（内容为空）');
  const window = data.subarray(0, Math.min(data.length, PDF_HEADER_WINDOW));
  const limit = window.length - PDF_HEADER.length;
  for (let i = 0; i <= limit; i += 1) {
    let hit = true;
    for (let k = 0; k < PDF_HEADER.length; k += 1) {
      if (window[i + k] !== PDF_HEADER.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (hit) return;
  }
  throw new PdfPreviewError('这个文件不是 PDF（文件头不对）');
}

/* ------------------------------ 小工具 ------------------------------ */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // 已经脱离文档的 canvas 赋 0 也可能抛：这时候没什么可放的
  }
}

function cleanupPage(page) {
  try {
    page?.cleanup?.();
  } catch {
    // 页对象可能已经被 transport 销毁
  }
}

function disposeTask(task) {
  if (!task || typeof task.destroy !== 'function') return;
  try {
    const result = task.destroy();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // 还没建好就被销毁，或者已经销毁过
  }
}

/* ------------------------------ 主体 ------------------------------ */

/**
 * 把一份 PDF 挂到 container 里。
 *
 * @param {object} [options]
 * @param {string} [options.url]            同源读取地址（/api/…）
 * @param {Element} [options.container]     容器，内容由本模块独占
 * @param {object} [options.headers]      额外请求头
 * @param {() => Promise<object>} [options.loadLibrary] 库加载器（测试注入假库）
 * @param {Document} [options.doc]        默认 globalThis.document
 * @param {Window} [options.win]          默认 globalThis（量宽度、取 devicePixelRatio、挂 resize）
 * @returns {Promise<{destroy: () => void, getState: () => object}>}
 */
export async function mountPdf(options = {}) {
  const {
    url,
    container,
    headers = null,
    loadLibrary = loadPdfLibrary,
    doc = globalThis.document,
    win = globalThis,
  } = options || {};

  if (!url || typeof url !== 'string') throw new PdfPreviewError('没有可读取的 PDF 地址');
  if (!container || typeof container.appendChild !== 'function') {
    throw new PdfPreviewError('预览容器不可用，打不开 PDF');
  }
  if (!doc || typeof doc.createElement !== 'function') {
    throw new PdfPreviewError('当前环境没有 document，打不开 PDF');
  }

  /* 1. 取字节（同源凭据；不是 PDF 就直接挡在库加载之前） */
  const data = await readPdfBytes({ url, headers, win });

  /* 2. 加载库：默认实现是 await import(...)，主包里没有 pdf.js */
  let api;
  try {
    api = await loadLibrary();
  } catch (err) {
    // 拉 chunk 失败 / chunk 里抛错，都不是「文件有问题」，要分开说：
    // 用户看到「解析失败」会以为是文件坏了，实际重试一次就能好。
    throw err instanceof PdfPreviewError
      ? err
      : new PdfPreviewError('PDF 预览组件加载失败（可能是网络中断），可以下载后用系统应用打开', err);
  }
  const getDocument = typeof api?.getDocument === 'function'
    ? api.getDocument
    : api?.default?.getDocument;
  if (typeof getDocument !== 'function') {
    throw new PdfPreviewError('PDF 预览组件加载失败（导出形状不认识）');
  }

  /* 3. 解析 */
  const loadingTask = getDocument({ data, isEvalSupported: false, verbosity: 0 });
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    disposeTask(loadingTask);
    throw toUserError(err);
  }

  const totalPages = Number(pdf?.numPages) || 0;
  if (totalPages < 1) {
    disposeTask(loadingTask);
    throw new PdfPreviewError('这个 PDF 里没有页面');
  }
  const pageCount = Math.min(totalPages, MAX_PAGES);

  /* 4. 骨架：工具条 + 滚动区 + 每页一个占位槽 */
  const root = el(doc, 'div', 'pdf-viewer');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'PDF 预览');

  const toolbar = el(doc, 'div', 'pdf-toolbar');
  const prevBtn = el(doc, 'button', 'pdf-btn pdf-prev', '‹');
  prevBtn.setAttribute('type', 'button');
  prevBtn.setAttribute('aria-label', '上一页');
  const counter = el(doc, 'span', 'pdf-counter', `1 / ${pageCount}`);
  counter.setAttribute('aria-live', 'polite');
  const nextBtn = el(doc, 'button', 'pdf-btn pdf-next', '›');
  nextBtn.setAttribute('type', 'button');
  nextBtn.setAttribute('aria-label', '下一页');
  toolbar.appendChild(prevBtn);
  toolbar.appendChild(counter);
  toolbar.appendChild(nextBtn);
  root.appendChild(toolbar);

  const scroller = el(doc, 'div', 'pdf-scroll');
  const pagesBox = el(doc, 'div', 'pdf-pages');
  const slots = [];
  for (let i = 1; i <= pageCount; i += 1) {
    const slot = el(doc, 'div', 'pdf-page');
    slot.setAttribute('data-page', String(i));
    // 未渲染时占位里放页码，滑动过程中至少知道自己在第几页
    slot.appendChild(el(doc, 'span', 'pdf-page-index', String(i)));
    pagesBox.appendChild(slot);
    slots.push(slot);
  }
  scroller.appendChild(pagesBox);
  root.appendChild(scroller);

  if (totalPages > pageCount) {
    root.appendChild(el(doc, 'div', 'pdf-hint', `仅显示前 ${pageCount} 页（共 ${totalPages} 页）`));
  }

  container.replaceChildren(root);

  const state = {
    destroyed: false,
    current: 1,
    pageCount,
    // rendered：当前真正挂着 canvas 的页；painted：画过（曾经）的页。
    // 两套集分开存，是因为回收后的页必须能重新画——只看 rendered 会误以为「已经不需要了」。
    rendered: new Set(),
    painted: new Set(),
    visible: new Set(),
    tasks: new Map(),
    canvases: new Set(),
    queue: [],
    queued: new Set(),
    pumping: false,
    observer: null,
    evicted: 0,
    width: 0,
  };
  state.width = measureWidth();

  /* --------------------------- 尺寸 --------------------------- */

  function measureWidth() {
    const w = Number(scroller.clientWidth);
    if (Number.isFinite(w) && w > 0) return w;
    const vw = Number(win?.innerWidth);
    if (Number.isFinite(vw) && vw > 0) return vw;
    return DEFAULT_VIEW_WIDTH;
  }

  /** 目标像素宽 = 容器 CSS 宽 × min(devicePixelRatio, MAX_DPR)，再封顶 MAX_CANVAS_WIDTH。 */
  function targetPixelWidth() {
    const rawDpr = Number(win?.devicePixelRatio);
    const dpr = Math.min(MAX_DPR, Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1);
    const cssWidth = Math.max(1, state.width || DEFAULT_VIEW_WIDTH);
    return Math.min(MAX_CANVAS_WIDTH, Math.max(1, Math.round(cssWidth * dpr)));
  }

  /* --------------------------- 渲染 --------------------------- */

  function updateCounter() {
    counter.textContent = `${state.current} / ${state.pageCount}`;
    prevBtn.disabled = state.current <= 1;
    nextBtn.disabled = state.current >= state.pageCount;
  }

  function showPageError(pageNo, err) {
    const slot = slots[pageNo - 1];
    if (!slot || state.destroyed) return;
    slot.classList.add('is-failed');
    slot.replaceChildren(el(doc, 'span', 'pdf-page-error', `第 ${pageNo} 页画不出来：${err?.message || '未知原因'}`));
  }

  function requestRender(pageNo) {
    if (state.destroyed) return;
    const n = Math.trunc(Number(pageNo));
    if (!Number.isFinite(n) || n < 1 || n > state.pageCount) return;
    if (state.rendered.has(n) || state.queued.has(n)) return;
    state.queued.add(n);
    state.queue.push(n);
    void pump();
  }

  /**
   * 逐页渲染的泵：一次只画一页，画完再看队列。
   * destroy 之后循环条件立刻为假 —— 这是「停止续渲染」的唯一出口。
   * 「被回收取消」≠「停止」：前者是滚出了保留窗口，泵要继续画下一张。
   */
  async function pump() {
    if (state.pumping || state.destroyed) return;
    state.pumping = true;
    try {
      while (!state.destroyed && state.queue.length) {
        const pageNo = state.queue.shift();
        state.queued.delete(pageNo);
        if (state.rendered.has(pageNo)) continue;
        try {
          const status = await renderPage(pageNo);
          if (status === 'destroyed') break; // 已销毁：本轮回滚
        } catch (err) {
          // 单页失败不炸整个预览，标在那一页上继续下一张
          if (!state.destroyed) showPageError(pageNo, err);
        }
      }
    } finally {
      state.pumping = false;
    }
  }

  /**
   * 画一页。返回值：
   *   'rendered'  画好了，canvas 已挂上
   *   'cancelled' 被回收/重排取消（不是错误，泵继续）
   *   'destroyed' 已销毁（泵收尾退出）
   */
  async function renderPage(pageNo) {
    if (state.destroyed) return 'destroyed';
    const slot = slots[pageNo - 1];
    if (!slot) return 'cancelled';

    let page;
    try {
      page = await pdf.getPage(pageNo);
    } catch (err) {
      if (state.destroyed) return 'destroyed';
      throw toUserError(err);
    }
    if (state.destroyed) {
      cleanupPage(page);
      return 'destroyed';
    }
    // 取页期间滚出了保留窗口：这页不画了
    if (!inWindow(pageNo)) {
      cleanupPage(page);
      return 'cancelled';
    }

    let base;
    let viewport;
    try {
      base = page.getViewport({ scale: 1 });
      const baseWidth = Number(base?.width) || 0;
      if (baseWidth <= 0) throw new PdfPreviewError('这一页的尺寸读不出来');
      const scale = targetPixelWidth() / baseWidth;
      viewport = page.getViewport({ scale });
    } catch (err) {
      cleanupPage(page);
      throw toUserError(err);
    }

    const canvas = doc.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = Math.max(1, Math.round(Number(viewport.width) || 1));
    canvas.height = Math.max(1, Math.round(Number(viewport.height) || 1));
    // 样式表里有同样的两条：万一 css 没加载，也不会横向溢出
    canvas.style.width = '100%';
    canvas.style.height = 'auto';

    const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!context) {
      cleanupPage(page);
      throw new PdfPreviewError('这个 WebView 画不了 PDF（canvas 不可用）');
    }

    let task = null;
    try {
      task = page.render({ canvasContext: context, viewport });
    } catch (err) {
      releaseCanvas(canvas);
      cleanupPage(page);
      throw toUserError(err);
    }
    state.tasks.set(pageNo, task);

    try {
      await task.promise;
    } catch (err) {
      state.tasks.delete(pageNo);
      releaseCanvas(canvas);
      cleanupPage(page);
      if (state.destroyed) return 'destroyed';
      if (err?.name === 'RenderingCancelledException') return 'cancelled';
      throw toUserError(err);
    }
    state.tasks.delete(pageNo);

    if (state.destroyed) {
      releaseCanvas(canvas);
      cleanupPage(page);
      return 'destroyed';
    }
    // 画完才发现它已经滚出窗口：直接丢掉，不挂上去（挂上去又要立即回收）
    if (!inWindow(pageNo)) {
      releaseCanvas(canvas);
      cleanupPage(page);
      return 'cancelled';
    }

    // 换上新 canvas 之前先把旧的（重排后的上一版）位图放掉
    for (const child of slot.children || []) {
      if (child && child.tagName === 'CANVAS') {
        releaseCanvas(child);
        state.canvases.delete(child);
      }
    }
    slot.replaceChildren(canvas);
    slot.classList.remove('is-failed');
    slot.classList.add('is-ready');
    state.canvases.add(canvas);
    state.rendered.add(pageNo);
    state.painted.add(pageNo);
    cleanupPage(page);
    return 'rendered';
  }

  /* --------------------------- 保留窗口 / 回收 --------------------------- */

  /** 当前保留窗口：当前页 ±EVICT_RADIUS，夹在 1..pageCount。 */
  function windowBounds(center = state.current) {
    const c = Math.min(state.pageCount, Math.max(1, Math.trunc(Number(center) || 1)));
    return {
      lo: Math.max(1, c - EVICT_RADIUS),
      hi: Math.min(state.pageCount, c + EVICT_RADIUS),
    };
  }

  function inWindow(pageNo) {
    const { lo, hi } = windowBounds();
    return pageNo >= lo && pageNo <= hi;
  }

  /**
   * 放掉一页的位图：canvas 宽高归零、从槽里摘掉，状态回到「没画」。
   * rendered 去掉但 painted 保留 —— 后者只是记账，不影响下次重画。
   */
  function releasePage(pageNo) {
    const slot = slots[pageNo - 1];
    state.rendered.delete(pageNo);
    if (!slot) return;
    for (const child of [...(slot.children || [])]) {
      if (!child || child.tagName !== 'CANVAS') continue;
      releaseCanvas(child);
      state.canvases.delete(child);
    }
    slot.classList.remove('is-ready');
    // 回到占位态（A4 比例由 .pdf-page:not(.is-ready) 撑住，滚动位置不会跳）
    slot.replaceChildren(el(doc, 'span', 'pdf-page-index', String(pageNo)));
    state.evicted += 1;
  }

  /**
   * 把状态收敛到「以 center 为中心」：
   *   1. 队列里跑出窗口的页直接丢掉（滚得快时不做无用功）；
   *   2. 在途渲染跑出窗口的取消（是回收，不是失败）；
   *   3. 已经画好但跑出窗口的页放掉位图，滚回来再画。
   */
  function applyWindow(center = state.current) {
    state.current = Math.min(state.pageCount, Math.max(1, Math.trunc(Number(center) || 1)));
    const { lo, hi } = windowBounds();

    if (state.queue.length) {
      const kept = state.queue.filter((n) => n >= lo && n <= hi);
      state.queue.length = 0;
      state.queue.push(...kept);
      state.queued.clear();
      for (const n of kept) state.queued.add(n);
    }

    for (const [pageNo, task] of [...state.tasks]) {
      if (pageNo >= lo && pageNo <= hi) continue;
      try {
        task.cancel?.();
      } catch {
        // 任务刚结束
      }
    }

    for (const pageNo of [...state.rendered]) {
      if (pageNo >= lo && pageNo <= hi) continue;
      releasePage(pageNo);
    }
    return { lo, hi };
  }

  /* --------------------------- 滚动 / 翻页 --------------------------- */

  /**
   * 滚到第 n 页。滚动容器是上层面板（file-preview-body），不是本模块的节点，
   * 所以只认 scrollIntoView：它自己会找最近的滚动祖先，换宿主也不用改这里。
   */
  function scrollToPage(pageNo) {
    const slot = slots[pageNo - 1];
    if (!slot) return;
    if (typeof slot.scrollIntoView !== 'function') return;
    try {
      slot.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch {
      try {
        slot.scrollIntoView();
      } catch {
        // 老 WebView / 假 DOM：滚不动不影响看第一页
      }
    }
  }

  function go(target) {
    if (state.destroyed) return;
    const raw = Math.trunc(Number(target));
    if (!Number.isFinite(raw)) return;
    const n = Math.min(state.pageCount, Math.max(1, raw));
    // 先收窗口再提渲染：顺序反了会被 applyWindow 当成「跑出窗口」丢掉
    applyWindow(n);
    updateCounter();
    scrollToPage(n);
    requestRender(n);
  }

  function onPrev(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    go(state.current - 1);
  }

  function onNext(event) {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    go(state.current + 1);
  }

  function onResize() {
    if (state.destroyed) return;
    const width = measureWidth();
    if (Math.abs(width - state.width) < RESIZE_TOLERANCE) return;
    state.width = width;
    // 已画的位图是旧宽度算出来的：全部作废重排；旧 canvas 先留在 DOM 里
    // （模糊但不会白屏），新的一页画好就替换掉它。
    const stale = [...state.rendered];
    state.rendered.clear();
    requestRender(state.current);
    for (const n of stale) {
      if (inWindow(n)) requestRender(n);
    }
  }

  /**
   * 可见范围驱动渲染 + 回收：root 用 null（视口）而不是本模块的节点 —— 真正的滚动容器
   * 是上层的预览面板，root:null 的相交计算会连带算上所有祖先的裁剪，
   * 换成抽屉、整页、内嵌卡片都不用改这里。
   */
  function makeObserver() {
    const Observer = typeof win?.IntersectionObserver === 'function'
      ? win.IntersectionObserver
      : globalThis.IntersectionObserver;
    if (typeof Observer !== 'function') return null;
    let observer;
    try {
      observer = new Observer((entries) => {
        if (state.destroyed) return;
        for (const entry of entries) {
          if (!entry) continue;
          const n = Number(entry.target?.getAttribute?.('data-page'));
          if (!Number.isFinite(n)) continue;
          // 维护「现在看得见哪些页」的全量集，而不只看本次回调的增量：
          // 回收要根据当前视野判断，不能根据「刚发生了变化的页」判断。
          if (entry.isIntersecting) state.visible.add(n);
          else state.visible.delete(n);
        }

        // 当前页看不见了就跟着视野走（取最靠前的那页），看得见就不动它 ——
        // 否则按钮跳页后会被视野里的邻页拽回去。
        let center = state.current;
        if (state.visible.size && !state.visible.has(center)) {
          center = Math.min(...state.visible);
        }
        if (center !== state.current) {
          state.current = center;
          updateCounter();
        }
        const { lo, hi } = applyWindow(center);

        for (const n of state.visible) {
          if (n >= lo && n <= hi) requestRender(n);
        }
      }, { root: null, rootMargin: OBSERVER_MARGIN });
    } catch {
      return null; // 拿不到观察器就只靠按钮翻页，功能不受影响
    }
    for (const slot of slots) {
      try {
        observer.observe(slot);
      } catch {
        // 某个槽观察失败不影响其它页
      }
    }
    return observer;
  }

  /* --------------------------- 销毁 --------------------------- */

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.queue.length = 0;
    state.queued.clear();
    state.visible.clear();
    // 先取消在途渲染：pdf.js 的 renderTask.cancel() 会让 promise 以
    // RenderingCancelledException 结束，泵那边拿到 'destroyed' 就收尾退出。
    for (const task of state.tasks.values()) {
      try {
        task.cancel?.();
      } catch {
        // 任务刚好结束，cancel 会抛，忽略
      }
    }
    state.tasks.clear();
    if (state.observer) {
      try {
        state.observer.disconnect();
      } catch {
        // 观察器已失效
      }
      state.observer = null;
    }
    try {
      prevBtn.removeEventListener('click', onPrev);
      nextBtn.removeEventListener('click', onNext);
    } catch {
      // 假 DOM / 已移除的节点
    }
    if (win && typeof win.removeEventListener === 'function') {
      try {
        win.removeEventListener('resize', onResize);
      } catch {
        // 同上
      }
    }
    for (const canvas of state.canvases) releaseCanvas(canvas);
    state.canvases.clear();
    state.rendered.clear();
    // 只清自己挂进去的那棵树：容器可能已经被上层的下一次预览复用
    if (root.parentNode === container) container.replaceChildren();
    cleanupPage(pdf);
    disposeTask(loadingTask);
  }

  function bind() {
    prevBtn.addEventListener('click', onPrev);
    nextBtn.addEventListener('click', onNext);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);
    state.observer = makeObserver();
  }

  /* 5. 第一页立刻画：这一步失败就不给半成品，直接抛给调用方回落 */
  try {
    const status = await renderPage(1);
    if (status !== 'rendered') throw new PdfPreviewError('PDF 的第一页画不出来');
  } catch (err) {
    destroy();
    throw toUserError(err);
  }

  updateCounter();
  bind();
  applyWindow(state.current);

  return {
    destroy,
    /** 只读快照，给装配层与测试观察状态用。 */
    getState() {
      return {
        current: state.current,
        pageCount: state.pageCount,
        totalPages,
        /** 当前真正挂着 canvas 的页 */
        rendered: [...state.rendered].sort((a, b) => a - b),
        /** 画过（包括后来被回收放掉的）页 */
        painted: [...state.painted].sort((a, b) => a - b),
        queued: [...state.queue],
        /** 累计回收次数（诊断内存行为用） */
        evicted: state.evicted,
        destroyed: state.destroyed,
      };
    },
  };
}
