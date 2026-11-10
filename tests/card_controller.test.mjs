/* tests/card_controller.test.mjs
 *
 * CardController 单元测试与契约测试
 * 覆盖：
 * 1. 同步返回 wrapper，异步准备后挂载 iframe
 * 2. 身份隔离：只取明确 cardId，绝不借用 toolcall ev.id；不匹配当前 snapshot 会话不授桥（仅只读）
 * 3. 路径比对：Windows 路径大小写与斜杠规范化比较，传给 bridge 保持原 sessionPath
 * 4. Package 模式：HEAD 校验同源 redirect、前缀匹配、X-Hana-Card-Source-Version 格式
 * 5. Package 模式：缺 header 降级只读、HEAD 失败明确占位、旧 HEAD 晚到被 generation 丢弃
 * 6. Fragment 模式：receipt.code 优先，不误把 regular filePath 当目录；crypto.subtle SHA-256 计算，不可用降级 null
 * 7. clear(): 递增 generation，abort 在途 HEAD，通知 bridge.clear()
 */

import assert from 'node:assert/strict';
import { createCardController } from '../web/card-controller.js';
import { cardUrlFor } from '../web/card.js';
import { b64url as sharedB64url } from '../web/file-urls.js';

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/** 轮询等某个子节点出现：异步渲染的完成时机不能靠固定 sleep 赌。 */
async function waitForNode(root, selector, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = root.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

function createMockDocument() {
  function createMockElement(tag, cls = '') {
    const listeners = new Map();
    const children = [];
    const classListSet = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);

    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      attributes: new Map(),
      dataset: {},
      children,
      get className() {
        return Array.from(classListSet).join(' ');
      },
      set className(val) {
        classListSet.clear();
        if (val) val.split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
      },
      classList: {
        add: (...args) => args.forEach(c => classListSet.add(c)),
        remove: (...args) => args.forEach(c => classListSet.delete(c)),
        contains: (c) => classListSet.has(c),
      },
      _text: '',
      get textContent() {
        if (children.length > 0) {
          return children.map(c => c.textContent || '').join(' ');
        }
        return this._text;
      },
      set textContent(val) {
        this._text = String(val == null ? '' : val);
        children.length = 0;
      },
      _html: '',
      get innerHTML() {
        return this._html;
      },
      set innerHTML(val) {
        this._html = String(val == null ? '' : val);
        if (val === '') {
          children.length = 0;
          this._text = '';
        }
      },
      appendChild(child) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) {
          children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      addEventListener(type, fn, options = {}) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, once: !!options.once });
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const list = listeners.get(type) ? [...listeners.get(type)] : [];
        for (const item of list) {
          item.fn.call(this, typeof event === 'string' ? { type } : event);
          if (item.once) {
            const arr = listeners.get(type);
            const idx = arr.indexOf(item);
            if (idx !== -1) arr.splice(idx, 1);
          }
        }
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
        if (k === 'src') this.src = String(v);
      },
      getAttribute(k) { return this.attributes.get(k) || null; },
      querySelector(sel) {
        return findFirst(this, sel);
      },
      querySelectorAll(sel) {
        const res = [];
        findAll(this, sel, res);
        return res;
      },
    };
    return el;
  }

  function matches(node, sel) {
    if (sel.startsWith('.')) {
      const classes = sel.split('.').filter(Boolean);
      return classes.every(c => node.classList.contains(c));
    }
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findFirst(parent, sel) {
    for (const child of parent.children) {
      if (matches(child, sel)) return child;
      const found = findFirst(child, sel);
      if (found) return found;
    }
    return null;
  }

  function findAll(parent, sel, res) {
    for (const child of parent.children) {
      if (matches(child, sel)) res.push(child);
      findAll(child, sel, res);
    }
  }

  return {
    createElement: (tag) => createMockElement(tag),
  };
}

function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const doc = createMockDocument();
globalThis.document = doc;

// 模拟 window.location
globalThis.location = {
  origin: 'http://localhost:24000',
  protocol: 'http:',
  host: 'localhost:24000',
};

/* ------------------------------------------------------------------ */
/* 1. 同步返回与异步加载                                                */
/* ------------------------------------------------------------------ */

await t('render: 同步返回占位容器 wrapper', () => {
  const doc = createMockDocument();
  const mockBridge = { register: () => {}, unregister: () => {}, clear: () => {} };
  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: async () => ({ ok: true }),
  });

  const node = controller.render(
    { details: { cardId: 'c1', code: '<div>hello</div>' } },
    { sessionId: 's1', sessionPath: 'C:/s1.jsonl' }
  );

  assert.ok(node, '必须同步返回 DOM 节点');
  assert.equal(node.className, 'card-controller-wrapper');
});

/* ------------------------------------------------------------------ */
/* 2. 身份与会话匹配保护                                                */
/* ------------------------------------------------------------------ */

await t('身份隔离: 不匹配当前会话 snapshot 则不授桥（仅安全只读）', async () => {
  const doc = createMockDocument();
  let bridgeRegistered = false;
  const mockBridge = {
    register: () => { bridgeRegistered = true; },
    unregister: () => {},
    clear: () => {},
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: async () => ({ ok: true }),
  });

  // receipt 的 sessionId 为 s-other，当前 session 为 s-current
  const wrapper = controller.render(
    { details: { cardId: 'c1', sessionId: 's-other', code: '<div>hello</div>' } },
    { sessionId: 's-current', sessionPath: 'C:/current.jsonl' }
  );

  // 等异步准备完毕。不用固定 10ms：CI 的慢机器上 sha256/建 iframe 可能超过它，
  // 那会让这条断言变成随机红（本地永远过）。
  const iframe = await waitForNode(wrapper, 'iframe');
  assert.equal(bridgeRegistered, false, '非当前会话的卡片绝不能授桥');
  assert.ok(iframe, '仍然作为只读卡片展示 iframe');
});

await t('身份隔离: 只取明确 cardId，绝不借用 toolcall ev.id', async () => {
  const doc = createMockDocument();
  let registeredContext = null;
  const mockBridge = {
    register: (_, ctx) => { registeredContext = ctx; },
    unregister: () => {},
    clear: () => {},
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: async () => ({ ok: true }),
  });

  // 仅有 ev.id (tool call id)，无明确 cardId
  controller.render(
    { id: 'call_12345', details: { code: '<div>no card id</div>' } },
    { sessionId: 's1', sessionPath: 'C:/s1.jsonl' }
  );

  await new Promise(r => setTimeout(r, 10));
  assert.equal(registeredContext, null, '缺少明确 cardId 时绝不能借用 tool call id 注册桥');
});

/* ------------------------------------------------------------------ */
/* 3. Package 模式: HEAD 验证、token URL 与版本注入                     */
/* ------------------------------------------------------------------ */

await t('Package 模式: renderer 接收 hostBridge 与 context，controller 不二次注册（防重置 nonce）', async () => {
  const doc = createMockDocument();
  let registerCallCount = 0;
  let registeredIframe = null;
  let registeredContext = null;

  const mockBridge = {
    register: (frame, ctx) => {
      registerCallCount += 1;
      registeredIframe = frame;
      registeredContext = ctx;
    },
    unregister: () => {},
    clear: () => {},
  };

  const validVersion = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const pkgDir = 'C:\\Users\\WIT\\.hanako\\session-files\\s1\\c_dir';
  const finalTokenUrl = `http://localhost:24000/gw/card/${b64url(pkgDir)}/index.html?token=tok123`;

  const fakeFetch = async (url, opts) => {
    assert.equal(opts.method, 'HEAD');
    return {
      ok: true,
      url: finalTokenUrl,
      headers: {
        get: (h) => (h.toLowerCase() === 'x-hana-card-source-version' ? validVersion : null),
      },
    };
  };

  let capturedOptions = null;
  const mockRenderCardByPath = (dir, opts) => {
    capturedOptions = { dir, ...opts };
    const iframe = doc.createElement('iframe');
    iframe.src = `${opts.sourceUrl}#nonce=random-nonce-12345`;
    const node = doc.createElement('div');
    node.appendChild(iframe);
    // 新规范：低层 renderer 在内部调用 hostBridge.register 获取 nonce
    if (opts.hostBridge && typeof opts.hostBridge.register === 'function') {
      opts.hostBridge.register(iframe, opts.context);
    }
    return { node, iframe };
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetch,
    renderCardByPath: mockRenderCardByPath,
  });

  const ev = {
    details: {
      cardId: 'card-pkg-1',
      title: '测试包卡片',
      sessionFile: {
        kind: 'directory',
        isDirectory: true,
        realPath: pkgDir,
      },
    },
  };

  const wrapper = controller.render(ev, { sessionId: 's1', sessionPath: 'C:/s1.jsonl' });
  await new Promise(r => setTimeout(r, 10));

  assert.ok(capturedOptions, '必须调用 renderCardByPath');
  assert.equal(capturedOptions.sourceUrl, finalTokenUrl, 'sourceUrl 必须为 HEAD 校验后的最终 token URL');
  assert.equal(capturedOptions.hostBridge, mockBridge, '必须把 hostBridge 传入底层 renderer');
  assert.ok(capturedOptions.context, '必须把 cardContext 传入底层 renderer');
  assert.equal(registerCallCount, 1, '整个挂载流程 bridge.register 必须且只能被底层注册 1 次，严禁 controller 二次注册');
  assert.equal(registeredIframe.src, `${finalTokenUrl}#nonce=random-nonce-12345`);
  assert.equal(registeredContext.sourceVersion, validVersion);
});

await t('Package 模式: HEAD 超时 deadline 触发明确错误占位，不无限挂起', async () => {
  const doc = createMockDocument();
  let bridgeRegistered = false;
  const mockBridge = {
    register: () => { bridgeRegistered = true; },
    unregister: () => {},
    clear: () => {},
  };

  // 永不 resolve 的 fetch 请求
  const neverFetch = () => new Promise(() => {});

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: neverFetch,
    headTimeoutMs: 20, // 短超时测试
  });

  const ev = {
    details: {
      cardId: 'card-pkg-timeout',
      sessionFile: { isDirectory: true, realPath: 'C:\\Users\\WIT\\.hanako\\session-files\\s1\\c_timeout' },
    },
  };

  const wrapper = controller.render(ev, { sessionId: 's1', sessionPath: 'C:/s1.jsonl' });
  await new Promise(r => setTimeout(r, 60));

  assert.equal(bridgeRegistered, false, '超时后绝不能挂载授桥');
  const errorText = wrapper.textContent;
  assert.ok(errorText.includes('超时') || errorText.includes('异常') || errorText.includes('失败'), '超时必须展示错误占位');
});

await t('Package 模式: 跨 origin 或同 origin 不同 encoded 目录 redirect 必须阻断', async () => {
  const doc = createMockDocument();
  let bridgeRegistered = false;
  const mockBridge = {
    register: () => { bridgeRegistered = true; },
    unregister: () => {},
    clear: () => {},
  };

  // 1. 同源但重定向到了另一个 encoded 目录
  const fakeFetchDiffDir = async () => ({
    ok: true,
    url: `http://localhost:24000/gw/card/${b64url('C:\\forged\\hacked')}/index.html`,
    headers: { get: () => 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
  });

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetchDiffDir,
  });

  const ev = {
    details: {
      cardId: 'card-hack-dir',
      sessionFile: { isDirectory: true, realPath: 'C:\\valid\\dir' },
    },
  };

  const wrapper = controller.render(ev, { sessionId: 's1', sessionPath: 'C:/s1.jsonl' });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(bridgeRegistered, false, '目录不匹配重定向绝不得授桥');
  assert.equal(wrapper.querySelector('iframe'), null, '目录不匹配重定向绝不得挂载 iframe');
  assert.ok(wrapper.textContent.includes('非法') || wrapper.textContent.includes('失败'), '必须提示目录非法');
});

await t('身份核验: 每一个显式声明冲突或 snapshot 缺项绝不给桥（降级安全只读）', async () => {
  const doc = createMockDocument();
  let registeredCtx = null;
  const mockBridge = {
    register: (_, ctx) => { registeredCtx = ctx; },
    unregister: () => {},
    clear: () => {},
  };

  const mockRender = (code, opts) => {
    const iframe = doc.createElement('iframe');
    const node = doc.createElement('div');
    node.appendChild(iframe);
    if (opts.hostBridge && typeof opts.hostBridge.register === 'function') {
      opts.hostBridge.register(iframe, opts.context);
    }
    return { node, iframe };
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    renderCard: mockRender,
  });

  // receipt 声明 s1，sessionFile 声明 s2 -> 冲突必须拒绝
  registeredCtx = null;
  controller.render(
    { details: { cardId: 'c-conflict', sessionId: 's1', sessionFile: { sessionId: 's2' }, code: '<div>conflict</div>' } },
    { sessionId: 's1', sessionPath: 'C:/s1.jsonl' }
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(registeredCtx, null, 'sessionId 声明冲突绝不得授桥');

  // snapshot 缺少 sessionId -> 必须拒绝
  registeredCtx = null;
  controller.render(
    { details: { cardId: 'c-nosnap', sessionId: 's1', code: '<div>nosnap</div>' } },
    { sessionId: null, sessionPath: 'C:/s1.jsonl' }
  );
  await new Promise(r => setTimeout(r, 10));
  assert.equal(registeredCtx, null, 'snapshot 缺失 sessionId 绝不得授桥');
});

await t('异步核对与清理: getSession 切会话取消晚回包，clear() 先调用 disposers', async () => {
  const doc = createMockDocument();
  let currentSession = { sessionId: 's1', sessionPath: 'C:/s1.jsonl' };
  let resolveHead;
  const headPromise = new Promise(r => { resolveHead = r; });
  let disposeCalled = false;

  const mockBridge = {
    register: () => {},
    unregister: () => {},
    clear: () => {},
  };

  const fakeFetch = async (url) => {
    await headPromise;
    const parsed = new URL(url, 'http://localhost:24000');
    return {
      ok: true,
      url: `http://localhost:24000${parsed.pathname}index.html?token=tok-disp`,
      headers: { get: () => 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    };
  };

  const mockRender = (dir, opts) => {
    const iframe = doc.createElement('iframe');
    const node = doc.createElement('div');
    node.appendChild(iframe);
    return {
      node,
      iframe,
      dispose: () => { disposeCalled = true; },
    };
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetch,
    getSession: () => currentSession,
    renderCardByPath: mockRender,
  });

  const wrapper = controller.render(
    { details: { cardId: 'c-late', sessionFile: { isDirectory: true, realPath: '/data/late' } } },
    { sessionId: 's1', sessionPath: 'C:/s1.jsonl' }
  );

  // 1. 用户中途切换了当前会话至 s2
  currentSession = { sessionId: 's2', sessionPath: 'C:/s2.jsonl' };
  resolveHead();
  await new Promise(r => setTimeout(r, 15));

  assert.equal(wrapper.querySelector('iframe'), null, 'getSession 发生切换时，晚回包绝不得插入 iframe');

  // 会话消失或身份字段丢失，也不能让旧请求继续挂载。
  for (const missingSession of [null, {}, { sessionId: 's1' }]) {
    currentSession = missingSession;
    const stale = controller.render(
      { details: { cardId: 'c-missing', sessionFile: { isDirectory: true, realPath: '/data/missing' } } },
      { sessionId: 's1', sessionPath: 'C:/s1.jsonl' }
    );
    await new Promise(r => setTimeout(r, 15));
    assert.equal(stale.querySelector('iframe'), null, '当前会话缺失或身份不完整时，旧请求不得挂载');
  }

  // 2. clear() 调用已挂载卡片的 dispose
  currentSession = { sessionId: 's2', sessionPath: 'C:/s2.jsonl' };
  disposeCalled = false;
  const okWrapper = controller.render(
    { details: { cardId: 'c-disp', sessionFile: { isDirectory: true, realPath: '/data/disp' } } },
    { sessionId: 's2', sessionPath: 'C:/s2.jsonl' }
  );
  await new Promise(r => setTimeout(r, 15));
  assert.equal(disposeCalled, false, '挂载后尚未调用 dispose');
  controller.clear();
  assert.equal(disposeCalled, true, 'clear 必须调用已挂载卡片的 dispose');
});

await t('Package 模式: 跨 origin redirect 必须阻断挂载', async () => {
  const doc = createMockDocument();
  let bridgeRegistered = false;
  const mockBridge = {
    register: () => { bridgeRegistered = true; },
    unregister: () => {},
    clear: () => {},
  };

  // 重定向到了外部 origin
  const fakeFetch = async () => ({
    ok: true,
    url: 'http://malicious.com/stolen',
    headers: { get: () => 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
  });

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetch,
  });

  const ev = {
    details: {
      cardId: 'card-hack',
      sessionFile: { isDirectory: true, realPath: '/data/card' },
    },
  };

  const wrapper = controller.render(ev, { sessionId: 's1' });
  await new Promise(r => setTimeout(r, 10));

  assert.equal(bridgeRegistered, false);
  const iframe = wrapper.querySelector('iframe');
  assert.equal(iframe, null, '跨源重定向不得挂载 iframe');
});

/* ------------------------------------------------------------------ */
/* 4. Fragment 模式: 源码哈希计算与降级保护                              */
/* ------------------------------------------------------------------ */

await t('Fragment 模式: crypto.subtle 可用时计算 SHA-256，不可用降级为 null', async () => {
  const doc = createMockDocument();
  let registeredCtx = null;
  const mockBridge = {
    register: (_, ctx) => { registeredCtx = ctx; },
    unregister: () => {},
    clear: () => {},
  };

  // 1. subtle 可用
  const controllerWithCrypto = createCardController({
    document: doc,
    bridge: mockBridge,
    crypto: globalThis.crypto,
  });

  controllerWithCrypto.render(
    { details: { cardId: 'frag-1', code: '<div>frag code</div>' } },
    { sessionId: 's1' }
  );
  await new Promise(r => setTimeout(r, 10));

  assert.ok(registeredCtx);
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(registeredCtx.sourceVersion), '必须生成 SHA-256 哈希');

  // 2. crypto 不可用（无 subtle）
  registeredCtx = null;
  const controllerNoCrypto = createCardController({
    document: doc,
    bridge: mockBridge,
    crypto: null,
  });

  controllerNoCrypto.render(
    { details: { cardId: 'frag-2', code: '<div>frag code</div>' } },
    { sessionId: 's1' }
  );
  await new Promise(r => setTimeout(r, 10));

  assert.ok(registeredCtx);
  assert.equal(registeredCtx.sourceVersion, null, '无 crypto 环境必须降级为 null');
});

/* ------------------------------------------------------------------ */
/* 5. clear(): 失效在途 generation 并清理已挂载 bridge                   */
/* ------------------------------------------------------------------ */

await t('clear(): 使在途 HEAD 请求失效，晚回包不插入卡片', async () => {
  const doc = createMockDocument();
  let resolveHead;
  const headPromise = new Promise(r => { resolveHead = r; });
  let registeredCount = 0;

  const mockBridge = {
    register: () => { registeredCount += 1; },
    unregister: () => {},
    clear: () => {},
  };

  const fakeFetch = async (url) => {
    await headPromise;
    const parsed = new URL(url, 'http://localhost:24000');
    return {
      ok: true,
      url: `http://localhost:24000${parsed.pathname}index.html`,
      headers: { get: () => 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    };
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetch,
  });

  const ev = {
    details: {
      cardId: 'c-slow',
      sessionFile: { isDirectory: true, realPath: '/data/slow' },
    },
  };

  const wrapper = controller.render(ev, { sessionId: 's1' });

  // 立即触发 clear（例如切会话）
  controller.clear();

  // 放行慢 HEAD 请求
  resolveHead();
  await new Promise(r => setTimeout(r, 10));

  assert.equal(registeredCount, 0, '被 clear 的在途卡片绝不得注册到桥');
  assert.equal(wrapper.querySelector('iframe'), null, '被 clear 的在途卡片绝不得插入 iframe');
});

/* ------------------------------------------------------------------ */
/* 6. packageRef：历史投影引用 + 官方 sessionFiles 目录元数据            */
/* ------------------------------------------------------------------ */

const PKG_DIR = 'C:\\Users\\WIT\\.hanako\\session-files\\s1\\c_pkg';
const PKG_SNAPSHOT = { sessionId: 's1', sessionPath: 'C:/s1.jsonl' };

function pkgRecord(overrides = {}) {
  return {
    id: 'file-pkg-1',
    fileId: 'file-pkg-1',
    sessionId: 's1',
    sessionPath: 'C:/s1.jsonl',
    realPath: PKG_DIR,
    filePath: PKG_DIR,
    kind: 'directory',
    isDirectory: true,
    status: 'available',
    version: { mtimeMs: 111, size: 222, sha256: 'b'.repeat(64) },
    ...overrides,
  };
}

function pkgEvent(overrides = {}) {
  return {
    type: 'interactive_card',
    cardId: 'card-pkg-1',
    title: '包卡片',
    packageRef: {
      fileId: 'file-pkg-1',
      sessionId: 's1',
      sessionPath: 'C:/s1.jsonl',
      entryName: 'index.html',
    },
    ...overrides,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

await t('packageRef: 官方目录记录匹配后只走既有 HEAD/桥路径，路径与上下文来自记录', async () => {
  const doc = createMockDocument();
  const record = pkgRecord();
  const ev = pkgEvent();
  const evBefore = JSON.stringify(ev);
  const recordBefore = JSON.stringify(record);
  const headVersion = 'sha256:' + 'a'.repeat(64);
  const tokenUrl = `http://localhost:24000/gw/card/${b64url(PKG_DIR)}/index.html?token=tok-pkg`;

  let headCalls = 0;
  const fakeFetch = async (url, opts) => {
    headCalls += 1;
    assert.equal(opts.method, 'HEAD');
    assert.equal(url, `/gw/card/${b64url(PKG_DIR)}/`, 'HEAD 必须指向官方记录目录');
    return {
      ok: true,
      url: tokenUrl,
      headers: {
        get: (h) => (h.toLowerCase() === 'x-hana-card-source-version' ? headVersion : null),
      },
    };
  };

  let captured = null;
  let registerCount = 0;
  let registeredContext = null;
  let registeredIframe = null;
  const mockBridge = {
    register: (iframe, ctx) => {
      registerCount += 1;
      registeredIframe = iframe;
      registeredContext = ctx;
    },
    unregister: () => {},
    clear: () => {},
  };
  const mockRenderByPath = (dir, opts) => {
    captured = { dir, ...opts };
    const iframe = doc.createElement('iframe');
    const node = doc.createElement('div');
    node.appendChild(iframe);
    if (opts.hostBridge && typeof opts.hostBridge.register === 'function') {
      opts.hostBridge.register(iframe, opts.context);
    }
    return { node, iframe };
  };

  const controller = createCardController({
    document: doc,
    bridge: mockBridge,
    fetchImpl: fakeFetch,
    renderCardByPath: mockRenderByPath,
  });

  const wrapper = controller.render(ev, PKG_SNAPSHOT, { sessionFiles: [record] });
  await tick();

  assert.equal(headCalls, 1, '只允许一次既有 HEAD 校验');
  assert.equal(captured?.dir, PKG_DIR, 'dirPath 必须来自官方记录 realPath');
  assert.equal(captured?.sourceUrl, tokenUrl, 'sourceUrl 必须是 HEAD 最终同源 token URL');
  assert.equal(captured?.hostBridge, mockBridge);
  assert.equal(registerCount, 1, '只允许底层 renderer 注册一次桥');
  assert.equal(registeredContext, captured.context);
  assert.equal(registeredContext.sourceVersion, headVersion, '版本必须来自 HEAD，不得用 record.version 伪造');
  assert.equal(registeredContext.sessionId, 's1');
  assert.equal(registeredContext.sessionPath, 'C:/s1.jsonl');
  assert.equal(registeredContext.cardId, 'card-pkg-1');
  assert.equal(registeredContext.cardEntityId, 'chat-card:card-pkg-1');
  assert.equal(wrapper.querySelector('iframe'), registeredIframe, 'iframe 必须挂载在 wrapper 内');
  assert.equal(JSON.stringify(ev), evBefore, '不得修改原 event');
  assert.equal(JSON.stringify(record), recordBefore, '不得修改原 record');
});

await t('packageRef: inline code 与 packageRef 双来源声明一律拒绝，零 HEAD/零桥/零 iframe', async () => {
  const cases = [
    ['同会话 ref + inline code', pkgEvent({ code: '<div>inline</div>' })],
    [
      '外会话 ref + inline code',
      pkgEvent({
        code: '<div>inline</div>',
        packageRef: { ...pkgEvent().packageRef, sessionId: 's2' },
      }),
    ],
    ['畸形 code + packageRef', pkgEvent({ code: { html: '<div>inline</div>' } })],
    ['畸形 receipt.code + packageRef', pkgEvent({ details: { code: 42 } })],
  ];

  for (const [label, ev] of cases) {
    const doc = createMockDocument();
    let fetchCalls = 0;
    let registerCount = 0;
    let renderCalls = 0;
    const mockBridge = {
      register: () => { registerCount += 1; },
      unregister: () => {},
      clear: () => {},
    };
    const controller = createCardController({
      document: doc,
      bridge: mockBridge,
      crypto: globalThis.crypto,
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, headers: { get: () => null } };
      },
      renderCard: () => {
        renderCalls += 1;
        const iframe = doc.createElement('iframe');
        const node = doc.createElement('div');
        node.appendChild(iframe);
        mockBridge.register(iframe, {});
        return { node, iframe };
      },
      renderCardByPath: () => {
        renderCalls += 1;
        const iframe = doc.createElement('iframe');
        const node = doc.createElement('div');
        node.appendChild(iframe);
        mockBridge.register(iframe, {});
        return { node, iframe };
      },
    });

    const wrapper = controller.render(ev, PKG_SNAPSHOT, { sessionFiles: [pkgRecord()] });
    await tick();

    assert.equal(fetchCalls, 0, `${label}: 不得发 HEAD`);
    assert.equal(renderCalls, 0, `${label}: 不得渲染内联或目录卡片`);
    assert.equal(registerCount, 0, `${label}: 不得授桥`);
    assert.equal(wrapper.querySelector('iframe'), null, `${label}: 不得创建 iframe`);
    assert.ok(
      wrapper.textContent.includes('source-conflict'),
      `${label}: 必须明确拒绝来源冲突，实际：${wrapper.textContent.slice(0, 160)}`
    );
  }
});

await t('packageRef: 缺/歧义/冲突/失效引用一律零请求零桥并给明确占位', async () => {
  const baseRecord = pkgRecord();
  const baseEvent = pkgEvent();
  const baseSnapshot = { ...PKG_SNAPSHOT };
  const withRef = (patch) => ({ ...baseEvent, packageRef: { ...baseEvent.packageRef, ...patch } });

  const cases = [
    { label: '缺 sessionFiles', event: baseEvent, snapshot: baseSnapshot, files: undefined, reason: 'no-session-files' },
    { label: 'sessionFiles 非数组', event: baseEvent, snapshot: baseSnapshot, files: {}, reason: 'no-session-files' },
    { label: '无匹配记录', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ id: 'other', fileId: 'other' })], reason: 'no-match' },
    { label: '记录 id/fileId 冲突', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ fileId: 'other' })], reason: 'record-id-conflict' },
    { label: '匹配歧义', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord(), pkgRecord({ id: undefined })], reason: 'ambiguous-match' },
    { label: '记录属于外会话', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ sessionId: 's2' })], reason: 'session-mismatch' },
    { label: 'ref 属于外会话', event: withRef({ sessionId: 's2' }), snapshot: baseSnapshot, files: [baseRecord], reason: 'session-mismatch' },
    { label: '事件层 sessionId 冲突', event: { ...baseEvent, sessionId: 's2' }, snapshot: baseSnapshot, files: [baseRecord], reason: 'session-mismatch' },
    { label: 'snapshot 缺 sessionId', event: baseEvent, snapshot: { sessionPath: 'C:/s1.jsonl' }, files: [baseRecord], reason: 'missing-snapshot' },
    { label: 'snapshot 缺 sessionPath', event: baseEvent, snapshot: { sessionId: 's1' }, files: [baseRecord], reason: 'missing-snapshot' },
    { label: 'entryName 非 index.html', event: withRef({ entryName: 'card.html' }), snapshot: baseSnapshot, files: [baseRecord], reason: 'entry-not-index' },
    { label: 'entryName 缺失', event: withRef({ entryName: undefined }), snapshot: baseSnapshot, files: [baseRecord], reason: 'entry-not-index' },
    { label: '记录 isDirectory 非 true', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ isDirectory: false })], reason: 'not-directory' },
    { label: '记录 kind 非 directory', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ kind: 'file' })], reason: 'not-directory' },
    { label: '记录不可用', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ status: 'missing' })], reason: 'unavailable' },
    { label: '记录 status 缺失', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ status: undefined })], reason: 'unavailable' },
    { label: '记录缺真实路径', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ realPath: '', filePath: '' })], reason: 'missing-path' },
    { label: '记录 sessionPath 冲突', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ sessionPath: 'C:/s2.jsonl' })], reason: 'path-mismatch' },
    { label: 'ref sessionPath 冲突', event: withRef({ sessionPath: 'C:/s2.jsonl' }), snapshot: baseSnapshot, files: [baseRecord], reason: 'path-mismatch' },
    { label: '事件层 sessionPath 冲突', event: { ...baseEvent, sessionPath: 'C:/s2.jsonl' }, snapshot: baseSnapshot, files: [baseRecord], reason: 'path-mismatch' },
    { label: 'receipt 层 sessionPath 冲突', event: { ...baseEvent, details: { sessionPath: 'C:/s2.jsonl' } }, snapshot: baseSnapshot, files: [baseRecord], reason: 'path-mismatch' },
    { label: 'cardId 声明冲突', event: { ...baseEvent, details: { cardId: 'other-card' } }, snapshot: baseSnapshot, files: [baseRecord], reason: 'card-id-conflict' },
    { label: '记录 cardId 冲突', event: baseEvent, snapshot: baseSnapshot, files: [pkgRecord({ cardId: 'other-card' })], reason: 'card-id-conflict' },
    { label: '目录声明冲突', event: { ...baseEvent, cardDir: 'C:\\forged\\dir' }, snapshot: baseSnapshot, files: [baseRecord], reason: 'dir-path-conflict' },
    { label: 'ref fileId 缺失', event: withRef({ fileId: '' }), snapshot: baseSnapshot, files: [baseRecord], reason: 'invalid-reference' },
  ];

  for (const item of cases) {
    const doc = createMockDocument();
    let fetchCalls = 0;
    let registerCount = 0;
    let renderCalls = 0;
    const controller = createCardController({
      document: doc,
      bridge: {
        register: () => { registerCount += 1; },
        unregister: () => {},
        clear: () => {},
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, headers: { get: () => null } };
      },
      renderCard: () => {
        renderCalls += 1;
        return { node: doc.createElement('div'), iframe: doc.createElement('iframe') };
      },
      renderCardByPath: () => {
        renderCalls += 1;
        return { node: doc.createElement('div'), iframe: doc.createElement('iframe') };
      },
    });

    const wrapper = controller.render(item.event, item.snapshot, { sessionFiles: item.files });
    await tick(5);

    assert.equal(fetchCalls, 0, `${item.label}: 不得发 HEAD`);
    assert.equal(registerCount, 0, `${item.label}: 不得授桥`);
    assert.equal(renderCalls, 0, `${item.label}: 不得渲染卡片`);
    assert.equal(wrapper.querySelector('iframe'), null, `${item.label}: 不得挂载 iframe`);
    assert.ok(
      wrapper.textContent.includes(item.reason),
      `${item.label}: 占位必须带明确原因 ${item.reason}，实际：${wrapper.textContent.slice(0, 200)}`
    );
  }
});

await t('packageRef: 非 interactive_card 不解析引用，保持旧占位且零请求', async () => {
  const doc = createMockDocument();
  let fetchCalls = 0;
  let registerCount = 0;
  const controller = createCardController({
    document: doc,
    bridge: {
      register: () => { registerCount += 1; },
      unregister: () => {},
      clear: () => {},
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, headers: { get: () => null } };
    },
  });

  const wrapper = controller.render(
    { ...pkgEvent(), type: 'card' },
    PKG_SNAPSHOT,
    { sessionFiles: [pkgRecord()] }
  );
  await tick(5);

  assert.equal(fetchCalls, 0);
  assert.equal(registerCount, 0);
  assert.equal(wrapper.querySelector('iframe'), null);
});

/* I3-3：卡片目录的 base64url 全库只留 web/file-urls.js 那一份（card.js / card-controller.js 不再自带）。
 * 两边一旦分叉（填充位、`+` `/` 的替换写错）这里就红——这是那条合并的唯一可观测证据。 */
await t('cardUrlFor: 目录编码与 file-urls 的 b64url 一致（共用一份实现）', () => {
  for (const dir of [
    'C:\\Users\\WIT\\.hanako\\session-files\\s1\\c_dir',
    '/home/u/cards/a',
    'C:\\工作\\卡片',
    'a+b/c=d?e&f',
    'a😀b',
  ]) {
    const url = cardUrlFor(dir);
    assert.equal(url, `/gw/card/${b64url(dir)}/`, `期望字节（夹具算）：${dir}`);
    assert.equal(url, `/gw/card/${sharedB64url(dir)}/`, `必须与 file-urls 的实现一致：${dir}`);
  }
  assert.equal(cardUrlFor(''), null, '空目录仍是 null，不拼出 /gw/card//');
  assert.equal(cardUrlFor(null), null);
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
