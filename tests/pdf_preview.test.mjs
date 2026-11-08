/* tests/pdf_preview.test.mjs — 内置 PDF 预览（web/pdf-preview.js）
 *
 * 跑法：node tests/pdf_preview.test.mjs
 *
 * 为什么不跑真 pdf.js：它要真实 canvas / 字体栈，在 Node 里跑真实渲染既慢又依赖可选包。
 * 这里用注入的假库（mountPdf 的 loadLibrary 参数）覆盖行为契约：
 *   - 第一页立刻画、按钮翻页、不可见页不画；
 *   - 只渲染前 30 页，多出来的给提示；
 *   - destroy 取消在途渲染、队列不再前进、容器清干净；
 *   - 库加载失败 / 不是 PDF / 有密码 / HTTP 失败都抛带中文原因的 Error。
 * pdf.js 本身能不能解 PDF、画不画得出来，用临时脚本另跑（不写进默认路径，见汇报）。
 *
 * 另一条硬契约：**默认路径必须是动态 import**。静态 import 会把 pdf.js 拉进主包，
 * 所以这里直接读源码断言（这是唯一能在无浏览器环境下验证拆分意图的手段）。
 *
 * 夹具：tests/support/app_harness.mjs 的假 DOM（没有 canvas，下面给 createElement 补桩）。
 * 全部用例登记在 CASES 里，跑完统一打印 —— 用例必须写在跑测循环之前，
 * 写在后面就永远不会执行却还会打印 ALL PASS（历史事故）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './support/app_harness.mjs';
import { mountPdf, MAX_PAGES, MAX_CANVAS_WIDTH, PdfPreviewError } from '../web/pdf-preview.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const SRC_PATH = path.join(ROOT, 'web', 'pdf-preview.js');
const CSS_PATH = path.join(ROOT, 'web', 'pdf-preview.css');

const h = createHarness();
const { doc } = h;

/* ---------------------------- 夹具 ---------------------------- */

/** 假 canvas：getContext('2d') 给一个记数用的上下文桩。 */
const contexts = [];
const harnessCreate = doc.createElement;
doc.createElement = (tag) => {
  const node = harnessCreate(tag);
  if (String(tag).toLowerCase() === 'canvas') {
    node.getContext = (kind) => {
      if (kind !== '2d') return null;
      const ctx = { kind, canvas: node, paints: 0, fillRect() { this.paints += 1; } };
      contexts.push(ctx);
      return ctx;
    };
  }
  return node;
};

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const NOT_PDF_BYTES = new TextEncoder().encode('这不是 PDF，只是一段文本。'.repeat(4));

const flush = async (rounds = 6) => {
  // 让微任务与 0ms 宏任务都跑完，不是固定等待时长
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function bytesResponse(bytes, { ok = true, status = 200 } = {}) {
  const copy = new Uint8Array(bytes);
  return {
    ok,
    status,
    async arrayBuffer() {
      return copy.buffer;
    },
  };
}

/**
 * 可驱动的 IntersectionObserver 假实现。
 * 滚动在假 DOM 里没法真发生，但「哪页进了视野」这件事实在模块里就是靠观察器回调传达的，
 * 所以直接喂回调就是走真实分支（而不是另开一个只给测试用的入口）。
 */
function installFakeObserver() {
  const instances = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = [];
      this.disconnected = false;
      instances.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    unobserve() {}

    disconnect() {
      this.disconnected = true;
    }
  }
  h.window.IntersectionObserver = FakeIntersectionObserver;
  return {
    instances,
    /** pairs: [{ page, visible }] → 一次相交变化批次 */
    fire(container, pairs) {
      const slots = container.querySelectorAll('.pdf-page');
      const entries = pairs.map(({ page, visible }) => ({
        target: slots[page - 1],
        isIntersecting: Boolean(visible),
        intersectionRatio: visible ? 1 : 0,
      }));
      for (const instance of instances) instance.callback(entries);
    },
    last() {
      return instances[instances.length - 1] || null;
    },
  };
}

/**
 * 假 pdf.js。
 * control.mode = 'instant' 时 render 立刻完成；'manual' 时挂起，由用例决定放行还是取消。
 */
function createFakeLibrary({ numPages = 3, mode = 'instant' } = {}) {
  const calls = { getDocument: [], getPage: [], render: [], cancel: [], destroyed: 0 };
  const pending = [];
  const control = { mode, numPages };

  function makePage(pageNo) {
    return {
      pageNumber: pageNo,
      getViewport({ scale = 1 } = {}) {
        return { width: 600 * scale, height: 800 * scale, scale };
      },
      render(params) {
        calls.render.push(pageNo);
        let settle = () => {};
        let fail = () => {};
        const promise = new Promise((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        const task = {
          pageNo,
          promise,
          cancel() {
            calls.cancel.push(pageNo);
            fail(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
          },
          settle,
        };
        if (control.mode === 'instant') settle();
        else pending.push(task);
        return task;
      },
      cleanup() {},
    };
  }

  const library = {
    getDocument(options) {
      calls.getDocument.push(options);
      const pdf = {
        numPages: control.numPages,
        getPage(pageNo) {
          calls.getPage.push(pageNo);
          return Promise.resolve(makePage(pageNo));
        },
        cleanup() {},
      };
      return {
        promise: Promise.resolve(pdf),
        destroy() {
          calls.destroyed += 1;
          return Promise.resolve();
        },
      };
    },
  };

  return { library, calls, pending, control, load: async () => library };
}

/** 造一个容器并挂到 body 上（假 DOM 的 body 支持 querySelectorAll）。 */
function makeContainer() {
  const container = doc.createElement('div');
  container.className = 'pdf-host';
  doc.body.appendChild(container);
  return container;
}

function resetEnv() {
  h.window.innerWidth = 400;
  delete h.window.devicePixelRatio;
  h.window.IntersectionObserver = undefined;
}

const canvasOf = (container) => container.querySelector('.pdf-page-canvas');
const counterOf = (container) => String(container.querySelector('.pdf-counter')?.textContent || '').trim();

/** 统一 mount：默认给假库 + 一份合法 PDF 字节。 */
async function mountInto(container, { fake = createFakeLibrary(), bytes = PDF_BYTES, url = '/api/files/a.pdf', loadLibrary = null, fetch: fetchOverride = null, headers = null } = {}) {
  h.setFetch(fetchOverride || (async () => bytesResponse(bytes)));
  const handle = await mountPdf({
    url,
    container,
    headers,
    loadLibrary: loadLibrary || fake.load,
  });
  return { handle, fake };
}

/* ---------------------------- 用例表 ---------------------------- */

const CASES = [];
const test = (name, fn) => CASES.push({ name, fn });

/* -------- 1. 源码契约：动态 import、顶部没有 pdfjs 静态依赖 -------- */

test('源码：pdfjs 只出现在 await import(...) 里，顶部没有静态 import', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf8');

  assert.ok(
    src.includes("await import('pdfjs-dist/legacy/build/pdf.js')"),
    '默认库加载器必须写 `await import(\'pdfjs-dist/legacy/build/pdf.js\')`',
  );
  assert.ok(
    src.includes("await import('pdfjs-dist/legacy/build/pdf.worker.js')"),
    'worker 也必须走 `await import(...)`',
  );

  // 任何 from 'pdfjs-dist…' 都是静态依赖，会直接进主包
  assert.equal(/from\s+['"]pdfjs-dist/.test(src), false, '文件里不许出现 from \'pdfjs-dist…\'');
  assert.equal(/\bimport\s+['"]pdfjs-dist/.test(src), false, '也不许出现副作用式的 import \'pdfjs-dist…\'');

  // 每一处 pdfjs-dist 字符串都必须紧跟在 import( 后面
  const refs = src.match(/['"]pdfjs-dist[^'"]*['"]/g) || [];
  assert.ok(refs.length >= 2, `应至少有两处 pdfjs-dist 引用，实际 ${refs.length}`);
  for (const ref of refs) {
    assert.ok(src.includes(`import(${ref})`), `${ref} 不是动态 import 的入参`);
  }

  // worker 处理方式必须在文件头交代清楚（换实现的人不能只看到一行魔法赋值）
  assert.ok(/pdfjsWorker/.test(src), '文件头应说明 worker 走主线程的实现方式');
});

/* -------- 2. 第一页立即画 -------- */

test('第一页立即画出：canvas 进容器，计数器 1 / 3', async () => {
  const container = makeContainer();
  const { handle } = await mountInto(container);

  const canvas = canvasOf(container);
  assert.ok(canvas, 'mount 完成时第一页的 canvas 应在容器里');
  assert.equal(canvas.width, 400, 'canvas 像素宽 = 容器宽 400 × dpr 1');
  assert.equal(canvas.height, Math.round(400 * 800 / 600), 'canvas 高度按页面比例');
  assert.equal(canvas.style.width, '100%', 'canvas 必须吃满容器宽（不横向溢出）');
  assert.equal(canvas.style.height, 'auto', 'canvas 高度按比例自适应');
  assert.equal(counterOf(container), '1 / 3', '计数器');
  assert.deepEqual(handle.getState().rendered, [1], '只画了第一页，其余页按需');
  assert.equal(container.querySelectorAll('.pdf-page').length, 3, '每页一个占位槽');

  handle.destroy();
});

/* -------- 3. 页数上限 -------- */

test('上限：45 页的 PDF 只渲染前 30 页，并提示「仅显示前 30 页」', async () => {
  assert.equal(MAX_PAGES, 30, 'MAX_PAGES 应为 30');

  const container = makeContainer();
  const fake = createFakeLibrary({ numPages: 45 });
  const { handle } = await mountInto(container, { fake });

  assert.equal(container.querySelectorAll('.pdf-page').length, 30, '占位槽只建 30 个');
  assert.equal(counterOf(container), '1 / 30', '计数器按上限算');
  const hint = String(container.querySelector('.pdf-hint')?.textContent || '');
  assert.ok(hint.includes('仅显示前 30 页'), `应有上限提示，实际「${hint}」`);
  assert.ok(hint.includes('45'), '提示里应带上原页数');

  // 一路点到底：第 31 页绝不能被请求
  const next = container.querySelector('.pdf-next');
  for (let i = 0; i < 40; i += 1) {
    next.click();
    await flush(2);
  }
  await flush(10);

  const requested = fake.calls.getPage;
  assert.ok(!requested.includes(31), `第 31 页不该被渲染，实际请求了 ${requested.slice(-3).join(',')}`);
  assert.equal(Math.max(...requested), 30, '最大请求页号应为 30');
  // 一路点下来，中间页会被内存窗口回收，所以看 painted（画过）而不是 rendered（当前在位）
  assert.equal(handle.getState().painted.length, 30, '30 页全部画过');
  assert.deepEqual(handle.getState().rendered, [28, 29, 30], '只有末尾窗口的页还在位');
  assert.equal(counterOf(container), '30 / 30', '到底后的计数器');

  handle.destroy();
});

/* -------- 4. 尺寸：dpr 与 1600 上限 -------- */

test('canvas 尺寸按 devicePixelRatio 放大，dpr 压到 2，并封顶 1600px', async () => {
  const wide = makeContainer();
  h.window.innerWidth = 400;
  h.window.devicePixelRatio = 2;
  const first = await mountInto(wide);
  const canvas1 = canvasOf(wide);
  assert.equal(canvas1.width, 800, '400 × dpr2 = 800');
  assert.equal(canvas1.height, Math.round(800 * 800 / 600), '高度按比例');
  first.handle.destroy();

  // 真机常见 dpr 3 / 4：一律压到 2（否则单张位图 9MB+，Android 上直接 OOM）
  const retina = makeContainer();
  h.window.innerWidth = 400;
  h.window.devicePixelRatio = 3;
  const third = await mountInto(retina);
  assert.equal(canvasOf(retina).width, 800, 'dpr 3 必须压到 2（不是 1200）');
  third.handle.destroy();

  h.window.devicePixelRatio = 4;
  const fourth = await mountInto(retina);
  assert.equal(canvasOf(retina).width, 800, 'dpr 4 也必须压到 2');
  fourth.handle.destroy();

  // 撞上限：1000 × dpr2 = 2000 → 1600
  const huge = makeContainer();
  h.window.innerWidth = 1000;
  h.window.devicePixelRatio = 2;
  const second = await mountInto(huge);
  const canvas2 = canvasOf(huge);
  assert.equal(MAX_CANVAS_WIDTH, 1600, 'MAX_CANVAS_WIDTH 应为 1600');
  assert.equal(canvas2.width, 1600, '超过上限应夹到 1600');
  assert.equal(canvas2.height, Math.round(1600 * 800 / 600), '高度按夹住后的宽度算比例');
  second.handle.destroy();
});

/* -------- 5. 按钮翻页 -------- */

test('按钮翻页：next 画下一页、计数器跟着走；首末页按钮置灰', async () => {
  const container = makeContainer();
  const fake = createFakeLibrary({ numPages: 3 });
  const { handle } = await mountInto(container, { fake });

  const prev = container.querySelector('.pdf-prev');
  const next = container.querySelector('.pdf-next');
  assert.equal(prev.disabled, true, '第一页时上一页应置灰');

  next.click();
  await flush();
  assert.equal(counterOf(container), '2 / 3', '翻到第 2 页');
  assert.deepEqual(handle.getState().rendered, [1, 2], '第 2 页应被渲染');
  assert.equal(container.querySelectorAll('.pdf-page-canvas').length, 2, '两页各有 canvas');

  next.click();
  await flush();
  assert.equal(counterOf(container), '3 / 3', '翻到第 3 页');
  assert.equal(next.disabled, true, '末页时下一页应置灰');

  prev.click();
  await flush();
  assert.equal(counterOf(container), '2 / 3', '回到第 2 页');

  handle.destroy();
});

/* -------- 6. destroy 停止续渲染（核心） -------- */

test('destroy 停止续渲染：在途渲染被取消，排队中的页不再请求', async () => {
  const container = makeContainer();
  const fake = createFakeLibrary({ numPages: 8 });
  const { handle } = await mountInto(container, { fake });

  // 之后的渲染都挂起，由用例决定何时结束
  fake.control.mode = 'manual';
  const next = container.querySelector('.pdf-next');

  next.click(); // 请求第 2 页，pump 卡在它的 render 上
  await flush();
  assert.equal(fake.calls.getPage.length, 2, '第 2 页应已开始取页（1 是首页）');
  assert.equal(fake.pending.length, 1, '第 2 页的 render 应挂起');

  next.click(); // 请求第 3 页：进队列，但泵被第 2 页占着
  await flush();
  assert.equal(fake.calls.getPage.length, 2, '泵被占住时不该取第 3 页');
  assert.deepEqual(handle.getState().queued, [3], '第 3 页应还在队列里');

  handle.destroy();
  assert.equal(fake.calls.cancel.includes(2), true, 'destroy 应取消在途渲染');
  assert.equal(container.children.length, 0, 'destroy 后容器应清空');
  assert.equal(fake.calls.destroyed, 1, 'destroy 应释放 pdf.js 的 loadingTask');

  // 挂起的渲染结束后也不能再往下画
  for (const task of fake.pending) task.settle();
  await flush();
  assert.equal(fake.calls.getPage.length, 2, 'destroy 之后不许再取新页（续渲染必须停住）');
  assert.equal(container.children.length, 0, '迟到的渲染结果不许再写回容器');

  // 再点按钮也不干活
  next.click();
  await flush();
  assert.equal(fake.calls.getPage.length, 2, 'destroy 后按钮不应再触发渲染');
});

/* -------- 6b. 内存：保留窗口与回收（滚回来必须重画） -------- */

test('内存上限：离开当前页 ±2 的页释放位图，滚回来重画；destroy 释放全部', async () => {
  h.window.innerWidth = 400;
  h.window.devicePixelRatio = 3; // 真机常见值，必须被压到 2
  const io = installFakeObserver();
  const container = makeContainer();
  const fake = createFakeLibrary({ numPages: 25 });
  const { handle } = await mountInto(container, { fake });

  const slot1 = container.querySelectorAll('.pdf-page')[0];
  const firstCanvas = slot1.querySelector('.pdf-page-canvas');
  assert.ok(firstCanvas, '第 1 页应有 canvas');
  assert.equal(firstCanvas.width, 800, 'dpr 3 压到 2：400 × 2 = 800');
  assert.equal(handle.getState().rendered.length, 1, '初始只画了第一页');

  // 滑到第 20 页：第 1 页离视野、第 20 页进视野
  io.fire(container, [{ page: 1, visible: false }, { page: 20, visible: true }]);
  await flush();

  assert.equal(counterOf(container), '20 / 25', '计数器跟着视野走');
  assert.equal(firstCanvas.width, 0, '第 1 页的 canvas 必须释放（width 归零）');
  assert.equal(firstCanvas.height, 0, '第 1 页的 canvas 必须释放（height 归零）');
  assert.equal(firstCanvas.parentNode, null, '释放后 canvas 应脱引（从槽里搞掉）');
  assert.equal(slot1.querySelector('.pdf-page-canvas'), null, '第 1 页槽里不应再挂 canvas');
  assert.deepEqual(handle.getState().rendered, [20], '在位的只剩第 20 页');
  assert.ok(handle.getState().painted.includes(1), '第 1 页记为「画过、已回收」，不是「没画」');
  assert.ok(!handle.getState().rendered.includes(1), 'rendered 必须不含已回收页');
  assert.ok(handle.getState().evicted >= 1, '回收次数应被记账');

  // 滚回第 1 页：必须重画（「画过」不等于「不用再画」）
  const fetchedBefore = fake.calls.getPage.filter((n) => n === 1).length;
  io.fire(container, [{ page: 20, visible: false }, { page: 1, visible: true }]);
  await flush();

  const again = slot1.querySelector('.pdf-page-canvas');
  assert.ok(again, '滚回来必须重新画出 canvas');
  assert.notEqual(again, firstCanvas, '应是一张新 canvas，不是旧的那张');
  assert.equal(again.width, 800, '重画的尺寸与原来一致');
  assert.equal(fake.calls.getPage.filter((n) => n === 1).length, fetchedBefore + 1, '第 1 页应重新取页渲染');
  assert.deepEqual(handle.getState().rendered, [1], '重画后重新挂上');
  assert.equal(slot1.querySelectorAll('.pdf-page-canvas').length, 1, '一槽只能有一张 canvas');

  // 再前后翻两页，凑出 3 张在位的位图，然后验 destroy 全部释放
  const next = container.querySelector('.pdf-next');
  next.click();
  await flush();
  next.click();
  await flush();
  const attached = [...container.querySelectorAll('.pdf-page-canvas')];
  assert.equal(attached.length, 3, `在位页数应为 3，实际 ${attached.length}`);

  handle.destroy();
  for (const canvas of [...attached, firstCanvas, again]) {
    assert.equal(canvas.width, 0, 'destroy 后 canvas 宽必须归零');
    assert.equal(canvas.height, 0, 'destroy 后 canvas 高必须归零');
  }
  assert.equal(container.children.length, 0, 'destroy 后容器清空');
  assert.equal(io.last()?.disconnected, true, 'destroy 应断开观察器');
});

/* -------- 7. destroy 幂等 / 只清自己的树 -------- */

test('destroy 幂等，且只清自己挂进去的那棵树', async () => {
  const container = makeContainer();
  const { handle } = await mountInto(container);
  assert.equal(container.children.length, 1, 'mount 后容器里是 viewer 根节点');

  handle.destroy();
  assert.equal(container.children.length, 0, '第一次 destroy 清空');
  handle.destroy(); // 幂等：不抛
  assert.equal(container.children.length, 0, '重复 destroy 不炸');

  // 容器被下一次预览复用时，旧句柄的 destroy 不许把别人的内容清掉
  const other = makeContainer();
  const second = await mountInto(other);
  const stranger = doc.createElement('div');
  stranger.className = 'not-pdf';
  other.appendChild(stranger); // 模拟装配层往里塞了别的东西
  second.handle.destroy();
  assert.equal(other.children.length, 0, '正常自己的容器：destroy 清空');
});

/* -------- 8. 失败路径：库加载 -------- */

test('库加载失败：抛带中文原因的 Error（调用方据此回落下载）', async () => {
  const container = makeContainer();
  let message = '';
  try {
    await mountInto(container, {
      loadLibrary: async () => {
        throw new Error('chunk 404');
      },
    });
  } catch (err) {
    message = String(err && err.message);
    assert.ok(err instanceof PdfPreviewError, '应为 PdfPreviewError，实际 ' + (err && err.name));
    assert.equal(err instanceof Error, true, '必须是 Error 实例');
  }
  assert.ok(message.includes('加载失败'), `错误信息应说明加载失败，实际「${message}」`);
  assert.equal(container.children.length, 0, '失败时不该留下半成品 DOM');
});

/* -------- 9. 失败路径：不是 PDF -------- */

test('不是 PDF：文件头不对就直接抛错，且不去加载 pdf.js', async () => {
  const container = makeContainer();
  let loaded = 0;
  let message = '';
  try {
    await mountInto(container, {
      bytes: NOT_PDF_BYTES,
      loadLibrary: async () => {
        loaded += 1;
        return createFakeLibrary().library;
      },
    });
  } catch (err) {
    message = String(err && err.message);
  }
  assert.ok(message.includes('不是 PDF'), `错误信息应说明不是 PDF，实际「${message}」`);
  assert.equal(loaded, 0, '判出不是 PDF 之后不该再去拉那 1.5MB 的库');
});

/* -------- 10. 失败路径：密码 / HTTP / 网络 -------- */

test('密码保护：PasswordException 变成中文提示', async () => {
  const container = makeContainer();
  const passwordError = Object.assign(new Error('No password given'), { name: 'PasswordException' });
  const brokenLibrary = {
    getDocument() {
      return { promise: Promise.reject(passwordError), destroy() {} };
    },
  };
  let message = '';
  try {
    await mountInto(container, { loadLibrary: async () => brokenLibrary });
  } catch (err) {
    message = String(err && err.message);
  }
  assert.ok(message.includes('密码'), `应说明有密码，实际「${message}」`);
  assert.equal(container.children.length, 0, '失败时不留 DOM');
});

test('HTTP 失败与网络中断：各给一条中文原因', async () => {
  const container = makeContainer();
  let httpMessage = '';
  try {
    await mountInto(container, {
      fetch: async () => bytesResponse(PDF_BYTES, { ok: false, status: 404 }),
    });
  } catch (err) {
    httpMessage = String(err && err.message);
  }
  assert.ok(httpMessage.includes('读取失败'), `HTTP 失败提示，实际「${httpMessage}」`);
  assert.ok(httpMessage.includes('404'), `应带上状态码，实际「${httpMessage}」`);

  const container2 = makeContainer();
  let netMessage = '';
  try {
    await mountInto(container2, {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
  } catch (err) {
    netMessage = String(err && err.message);
  }
  assert.ok(netMessage.includes('网络'), `网络中断提示，实际「${netMessage}」`);
});

test('非法参数：缺 url / 缺容器都抛中文错误', async () => {
  const container = makeContainer();
  let missingUrl = '';
  try {
    await mountPdf({ container, loadLibrary: async () => createFakeLibrary().library });
  } catch (err) {
    missingUrl = String(err && err.message);
  }
  assert.ok(missingUrl.includes('地址'), `缺 url 的提示，实际「${missingUrl}」`);

  let missingBox = '';
  try {
    await mountPdf({ url: '/api/files/a.pdf', loadLibrary: async () => createFakeLibrary().library });
  } catch (err) {
    missingBox = String(err && err.message);
  }
  assert.ok(missingBox.includes('容器'), `缺容器的提示，实际「${missingBox}」`);
});

/* -------- 11. 请求契约：同源凭据 + headers 透传 -------- */

test('读取请求带 credentials: same-origin，headers 原样透传', async () => {
  const container = makeContainer();
  const seen = [];
  await mountInto(container, {
    headers: { 'X-Hana-Test': '1' },
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return bytesResponse(PDF_BYTES);
    },
  });
  assert.equal(seen.length, 1, '只读一次');
  assert.equal(seen[0].url, '/api/files/a.pdf', '读取地址');
  assert.equal(seen[0].init.credentials, 'same-origin', '必须带同源凭据');
  assert.deepEqual(seen[0].init.headers, { 'X-Hana-Test': '1' }, 'headers 透传');
});

/* -------- 12. 样式表前缀 -------- */

test('样式表：类名全部 pdf- 前缀（状态类 is- 除外），且不写死颜色', () => {
  const raw = fs.readFileSync(CSS_PATH, 'utf8');
  // 先剥注释：注释里会提到别的模块的类名（.file-preview-body）和文件名（.js/.css）
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const selectors = css.match(/\.[a-zA-Z][\w-]*/g) || [];
  assert.ok(selectors.length > 5, `样式表里应有若干类名，实际 ${selectors.length}`);
  // is- 是仓库通用的状态修饰类（lightbox 的 is-single 同款），只当后缀用，不单独成选择器
  const foreign = [...new Set(selectors)].filter(
    (name) => !name.startsWith('.pdf-') && !name.startsWith('.is-'),
  );
  assert.deepEqual(foreign, [], `出现了非 pdf- 前缀的类名：${foreign.join(', ')}`);

  // 十六进制颜色 / rgb() 一律不许出现：深色主题靠变量切换
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, '样式表里不许写死十六进制颜色');
  assert.equal(/\brgba?\(/.test(css), false, '样式表里不许写死 rgb() 颜色');
});

/* ---------------------------- 跑测 ---------------------------- */

let failed = 0;
let executed = 0;

for (const item of CASES) {
  executed += 1;
  resetEnv();
  try {
    await item.fn();
    console.log(`PASS  ${item.name}`);
  } catch (err) {
    failed += 1;
    const detail = String((err && err.message) || err).split('\n').slice(0, 12).join('\n      ');
    console.log(`FAIL  ${item.name}\n      ${detail}`);
  }
  // 每个用例之后把假 DOM 清干净，用例之间的数字才可比
  for (const host of doc.body.querySelectorAll('.pdf-host')) host.remove();
}

assert.equal(executed, CASES.length, '有登记却没执行的用例（用例写在了跑测循环后面）');
console.log(`\ncases=${CASES.length}`);
if (failed === 0) console.log('ALL PASS');
else console.log(`${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
