/* 历史分页接线（TDD 红灯 → 后续集成复验）
 *
 * 缺陷背景：长会话只拉一页，早期消息（含历史卡片）根本看不到。宿主已支持
 * `GET /api/sessions/messages?...&limit=50` 与 `before=<最早 raw id>`，但 app 还没接线。
 *
 * 本文件只锁 app 侧可观测行为，不测 B 的 history-pager 内部：
 * 1. 最新历史显式带 sessionId / path / limit=50，不带 namespace / all；
 * 2. 响应 hasMore=true 时 UI 出现「加载更早」；
 * 3. 点它发同会话请求，before=当前最早 raw id（>0），limit=50；
 * 4. 早期消息（含 show_card 回执）插在原消息之前；旧消息、旧卡片节点不被清空或重建；
 * 5. 加载中重复点击不并发；
 * 6. 换会话后，旧会话的迟到响应不回填；
 * 7. 失败可重试（同一 before 再发一次）；
 * 8. busy（正在生成）时不发请求，也不许迟到的早期历史回放改掉流式 turn / cursor；
 * 9. 原有 Chat / Code 目录切换不回退。
 *
 * 夹具形状已按 B 的 history-pager.js（2026-11-03 07:32 契约）对齐：
 *   宿主返回 { messages: [...], blocks: [...], hasMore }；messages 只有 user/assistant，
 *   messages[].id 是十进制字符串（可见消息全局索引）；show_card 投影在 blocks 里
 *   （type=interactive_card，cardId/title/code/sessionId 原值，afterIndex 是页内锚点）。
 *   pager 把消息与块按锚点交错成 entries，cursor 只取 messages 的 id，且必须 >0。
 *   若宿主后续换成 entries/items 或别的游标字段，只需改 fetch mock，断言口径不变。
 *
 * 做法：Node 里加载真 web/app.js，用极简 DOM + 路由化 fetch 当探针；
 * 不引依赖、不起服务、不发真实请求、不新增测试专用生产 hook。
 * 打开会话走既有 DEBUG 的 __hana.openSession；「加载更早」按可见文案找可点击节点，
 * 不依赖未来 history-pagination-view 的 id/class。
 */

import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* 极简 DOM（要能承载 transcript / turn / 卡片 iframe）                  */
/* ------------------------------------------------------------------ */

const elements = new Map();
const allEls = []; // 所有创建过的节点：用于按文案找「加载更早」这类未定结构的按钮

function splitClasses(value) {
  return String(value || '').split(/\s+/).filter(Boolean);
}

function matchesSimple(node, token) {
  if (token.startsWith('.')) return splitClasses(node.className).includes(token.slice(1));
  if (token.startsWith('#')) return node.id === token.slice(1);
  return false;
}

function findDescendant(root, selector) {
  const token = String(selector || '').trim().split(/\s+/).pop();
  if (!token) return null;
  const walk = (node) => {
    for (const child of node.children || []) {
      if (matchesSimple(child, token)) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function collectDescendants(root, out = []) {
  for (const child of root.children || []) {
    out.push(child);
    collectDescendants(child, out);
  }
  return out;
}

function makeEl(tag = 'div', id = '') {
  const listeners = {};
  const classes = new Set();
  const children = [];

  const node = {
    tagName: String(tag).toUpperCase(),
    id,
    children,
    listeners,
    style: {},
    dataset: {},
    attributes: new Map(),
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    scrollHeight: 600,
    scrollTop: 0,
    clientHeight: 600,
    parentNode: null,
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(value) {
      classes.clear();
      for (const c of splitClasses(value)) classes.add(c);
    },
    classList: {
      add(...cls) {
        for (const c of cls) classes.add(c);
      },
      remove(...cls) {
        for (const c of cls) classes.delete(c);
      },
      contains(cls) {
        return classes.has(cls);
      },
    },
    get previousElementSibling() {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = parent.children.indexOf(node);
      return index > 0 ? parent.children[index - 1] : null;
    },
    addEventListener(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    removeEventListener(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((f) => f !== fn);
    },
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt?.type;
      const payload = typeof evt === 'string'
        ? { type, target: node, preventDefault() {}, stopPropagation() {} }
        : { ...evt, target: evt?.target || node };
      for (const fn of [...(listeners[type] || [])]) fn.call(node, payload);
    },
    appendChild(child) {
      if (child) {
        child.parentNode = node;
        children.push(child);
      }
      return child;
    },
    insertBefore(child, ref) {
      const index = ref ? children.indexOf(ref) : -1;
      children.splice(index === -1 ? children.length : index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) {
        children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    querySelector(selector) {
      return findDescendant(node, selector);
    },
    querySelectorAll(selector) {
      const token = String(selector || '').trim().split(/\s+/).pop();
      return collectDescendants(node).filter((n) => matchesSimple(n, token));
    },
    setAttribute(key, value) {
      node.attributes.set(key, String(value));
    },
    getAttribute(key) {
      return node.attributes.has(key) ? node.attributes.get(key) : null;
    },
    removeAttribute(key) {
      node.attributes.delete(key);
    },
    hasAttribute(key) {
      return node.attributes.has(key);
    },
    focus() {},
    click() {
      node.dispatchEvent('click');
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };

  // 真视图用 innerHTML = '' 清空容器；探针必须同步丢掉旧节点，否则看不出是否被清空。
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() {
      return html;
    },
    set(value) {
      html = String(value ?? '');
      if (!html) {
        for (const child of children) child.parentNode = null;
        children.length = 0;
      }
    },
  });

  allEls.push(node);
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements.has(id)) elements.set(id, makeEl('div', id));
  return elements.get(id);
}

const docListeners = new Map();
const mockBody = makeEl('body');
const mockRoot = makeEl('html');
mockRoot.style.setProperty = () => {};

globalThis.location = { protocol: 'http:', host: 'localhost:8080', origin: 'http://localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  body: mockBody,
  documentElement: mockRoot,
  visibilityState: 'visible',
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  querySelector(selector) {
    const token = String(selector || '').trim().split(/\s+/).pop();
    return allEls.find((n) => matchesSimple(n, token)) || null;
  },
  querySelectorAll(selector) {
    const token = String(selector || '').trim().split(/\s+/).pop();
    return allEls.filter((n) => matchesSimple(n, token));
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0, width: 400 };
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// 发送按钮在 index.html 里有 .send-label；setBusy 分支会读它，这里补上真结构。
{
  const label = makeEl('span');
  label.className = 'send-label';
  getEl('btnSend').appendChild(label);
}

const wsInstances = [];
globalThis.WebSocket = class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    wsInstances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closed = true;
    this.closeCalls = (this.closeCalls || 0) + 1;
  }
};

/* ------------------------------------------------------------------ */
/* 会话历史夹具                                                         */
/* ------------------------------------------------------------------ */

const SID_A = 'sess-hist-a';
const PATH_A = 'C:/Users/qa/.hana/sessions/hist-a';
const SID_B = 'sess-hist-b';
const PATH_B = 'C:/Users/qa/.hana/sessions/hist-b';
const SID_C = 'sess-hist-c';
const PATH_C = 'C:/Users/qa/.hana/sessions/hist-c';
const SID_P = 'sess-pkg-p';
const PATH_P = 'C:/Users/qa/.hana/sessions/pkg-p';
const SID_F = 'sess-pkg-f';
const PATH_F = 'C:/Users/qa/.hana/sessions/pkg-f';
const SID_G = 'sess-hist-g';
const PATH_G = 'C:/Users/qa/.hana/sessions/hist-g';
const SID_H = 'sess-hist-h';
const PATH_H = 'C:/Users/qa/.hana/sessions/hist-h';
const SID_I = 'sess-hist-i';
const PATH_I = 'C:/Users/qa/.hana/sessions/hist-i';
const SID_J = 'sess-hist-j';
const PATH_J = 'C:/Users/qa/.hana/sessions/hist-j';

// 卡片包官方目录：全小写，避免 A 侧 normalizePath 大小写归一后编码不一致。
const CARD_DIR_P_LATEST = 'c:/users/qa/.hana/session-files/sess-pkg-p/c_latest';
const CARD_DIR_P_EARLY = 'c:/users/qa/.hana/session-files/sess-pkg-p/c_early';
const CARD_DIR_F_FOREIGN = 'c:/users/qa/.hana/session-files/sess-pkg-f/c_foreign';

const stamp = (id) => new Date(Date.UTC(2026, 10, 1, 0, 0, 0) + id * 60_000).toISOString();

// canonical：messages 只有 user/assistant，show_card 投影在 blocks 里。
function userMessage(id, text) {
  return { id: String(id), role: 'user', content: text, timestamp: stamp(id) };
}

function assistantMessage(id, text) {
  return { id: String(id), role: 'assistant', content: [{ type: 'text', text }], timestamp: stamp(id) };
}

/**
 * 宿主历史里的交互卡片块（canonical 形状）：
 * 不是 toolResult 消息，而是独立 block；cardId / sessionId / code 都是宿主给的原值。
 * afterIndex 是页内锚点（0-based，指的是一条 message 在这个页里的位置）。
 */
function cardBlock({ cardId, title, sessionId, afterIndex }) {
  return {
    type: 'interactive_card',
    cardId,
    title,
    code: `<div class="probe-card">${title}</div>`,
    sessionId,
    afterIndex,
    sourceIndex: 0,
  };
}

/**
 * 宿主的 packageRef 历史块：没有内联 code，只有官方包引用。
 * 字段名与 B 的 blockIdentity 一致（fileId/sessionId/sessionPath/entryName），
 * 不是为 A 的匹配器倒推的形状。
 */
function packageRefBlock({ fileId, sessionId, sessionPath, title, afterIndex, sourceIndex }) {
  return {
    type: 'interactive_card',
    title,
    packageRef: { fileId, sessionId, sessionPath, entryName: 'index.html' },
    afterIndex,
    sourceIndex,
  };
}

/** GET /messages 随页返回的正式目录元数据（只给 A 真实匹配用，不在 app 里消费）。 */
function sessionFileMeta({ fileId, sessionId, sessionPath, dir }) {
  return {
    fileId,
    sessionId,
    sessionPath,
    name: dir.slice(dir.lastIndexOf('/') + 1),
    realPath: dir,
    filePath: dir,
    kind: 'directory',
    isDirectory: true,
    status: 'available',
  };
}

function b64url(value) {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const cardPathFor = (dir) => `/gw/card/${b64url(dir)}/`;

/** 一页历史：messages 连续 id，卡片作为独立 block 挂在页内锚点后。 */
function historyPage(prefix, from, to, sessionId, card = null) {
  const messages = [];
  for (let id = from; id <= to; id += 1) {
    messages.push(id % 2 === 0 ? assistantMessage(id, `${prefix}-${id}`) : userMessage(id, `${prefix}-${id}`));
  }
  const blocks = card ? [cardBlock({ ...card, sessionId })] : [];
  return { messages, blocks };
}


// A：最新 50 条 message（id 51..100）+ 1 个卡片 block；早期 50 条（id 1..50）+ 1 个早期卡片 block。
const FIXTURES = {
  A: {
    sessionId: SID_A,
    path: PATH_A,
    title: '分页会话 A',
    agentId: 'agent-home',
    latest: {
      ...historyPage('LATEST-A', 51, 100, SID_A, { cardId: 'card-latest-a', title: 'LATEST-A-CARD', afterIndex: 5 }),
      hasMore: true,
    },
    older: {
      ...historyPage('EARLY-A', 1, 50, SID_A, { cardId: 'card-early-a', title: 'EARLY-A-CARD', afterIndex: 9 }),
      hasMore: false,
    },
    earliestId: 51,
  },
  B: {
    sessionId: SID_B,
    path: PATH_B,
    title: '分页会话 B',
    agentId: 'agent-home',
    latest: { ...historyPage('LATEST-B', 1, 3, SID_B), hasMore: false },
    older: { messages: [], blocks: [], hasMore: false },
    earliestId: 1,
  },
  // C：首屏故意失败一次，用来验证「open 失败要提示，不能伪装空会话」。
  C: {
    sessionId: SID_C,
    path: PATH_C,
    title: '分页会话 C',
    agentId: 'agent-home',
    latest: null,
    older: { messages: [], blocks: [], hasMore: false },
    earliestId: 1,
  },
  // P：packageRef + sessionFiles 官方元数据。前后两页各有一张包卡片，用来验证
  // 「HEAD 精确命中官方目录」与「prepend 不重建旧 iframe」。
  P: {
    sessionId: SID_P,
    path: PATH_P,
    title: '包卡片会话 P',
    agentId: 'agent-home',
    latest: {
      messages: [
        userMessage(51, 'P-LATEST-51'),
        assistantMessage(52, 'P-LATEST-52'),
        userMessage(53, 'P-LATEST-53'),
      ],
      blocks: [
        packageRefBlock({
          fileId: 'sf-p-latest',
          sessionId: SID_P,
          sessionPath: PATH_P,
          title: 'PACKAGE-LATEST',
          afterIndex: 1,
          sourceIndex: 51,
        }),
      ],
      sessionFiles: [
        sessionFileMeta({ fileId: 'sf-p-latest', sessionId: SID_P, sessionPath: PATH_P, dir: CARD_DIR_P_LATEST }),
      ],
      hasMore: true,
    },
    older: {
      messages: [userMessage(1, 'P-EARLY-1'), assistantMessage(2, 'P-EARLY-2')],
      blocks: [
        packageRefBlock({
          fileId: 'sf-p-early',
          sessionId: SID_P,
          sessionPath: PATH_P,
          title: 'PACKAGE-EARLY',
          afterIndex: 0,
          sourceIndex: 2,
        }),
      ],
      sessionFiles: [
        sessionFileMeta({ fileId: 'sf-p-early', sessionId: SID_P, sessionPath: PATH_P, dir: CARD_DIR_P_EARLY }),
      ],
      hasMore: false,
    },
    earliestId: 51,
  },
  // F：packageRef 的 fileId 不在本页 sessionFiles 里（列表里只有另一份文件），
  // 任何「猜测目录」的实现都会在这里发出 HEAD 或启动桥。
  F: {
    sessionId: SID_F,
    path: PATH_F,
    title: '外来卡片会话 F',
    agentId: 'agent-home',
    latest: {
      messages: [userMessage(1, 'F-LATEST-1')],
      blocks: [
        packageRefBlock({
          fileId: 'sf-not-listed',
          sessionId: SID_F,
          sessionPath: PATH_F,
          title: 'PACKAGE-FOREIGN',
          afterIndex: 0,
          sourceIndex: 1,
        }),
      ],
      sessionFiles: [
        sessionFileMeta({ fileId: 'sf-other', sessionId: SID_F, sessionPath: PATH_F, dir: CARD_DIR_F_FOREIGN }),
      ],
      hasMore: false,
    },
    older: { messages: [], blocks: [], hasMore: false },
    earliestId: 1,
  },
  // G：页边界两侧都是 assistant —— 最新页最后一条是 assistant(5)，更早页首条是
  // assistant(2)。回放合并状态如果跨页沿用，早期 assistant 会被并进最新页最后一轮：
  // 正文落到页面底部、两页顺序颠倒。这是「一页一个回放边界」要锁的行为。
  G: {
    sessionId: SID_G,
    path: PATH_G,
    title: '页边界会话 G',
    agentId: 'agent-home',
    latest: {
      messages: [userMessage(4, 'G-LATEST-4'), assistantMessage(5, 'G-LATEST-5')],
      blocks: [],
      hasMore: true,
    },
    older: {
      messages: [assistantMessage(2, 'G-EARLY-2'), userMessage(3, 'G-EARLY-3')],
      blocks: [],
      hasMore: false,
    },
    earliestId: 4,
  },
  // H：同页连续 assistant 合并 + 页尾 assistant。用来锁「历史轮不能留给实时路由」：
  // 页尾之后来一条实时 delta / status，必须另起一轮，不能续写历史。
  H: {
    sessionId: SID_H,
    path: PATH_H,
    title: '页尾轮会话 H',
    agentId: 'agent-home',
    latest: {
      messages: [
        userMessage(1, 'H-USER-1'),
        assistantMessage(2, 'H-ASSIST-2'),
        assistantMessage(3, 'H-ASSIST-3'),
      ],
      blocks: [],
      hasMore: false,
    },
    older: { messages: [], blocks: [], hasMore: false },
    earliestId: 1,
  },
  // I：file 块锚在 user 后面（afterIndex=0）——宿主完全可能这么投影。
  // 首次页与 prepend 两路各一张，用来锁「只挂本页落点」。
  I: {
    sessionId: SID_I,
    path: PATH_I,
    title: 'user 锚定文件会话 I',
    agentId: 'agent-home',
    latest: {
      messages: [userMessage(3, 'I-LATEST-U-3'), assistantMessage(4, 'I-LATEST-A-4')],
      blocks: [
        { type: 'file', fileId: 'sf_i_latest', label: 'i-latest.txt', ext: 'txt', size: 10, afterIndex: 0 },
      ],
      hasMore: true,
    },
    older: {
      messages: [userMessage(1, 'I-EARLY-U-1'), assistantMessage(2, 'I-EARLY-A-2')],
      blocks: [
        { type: 'file', fileId: 'sf_i_early', label: 'i-early.txt', ext: 'txt', size: 10, afterIndex: 0 },
      ],
      hasMore: false,
    },
    earliestId: 3,
  },
  // J：本页首条消息画不出任何东西（空 user），file 块没有可用的消息落点。
  J: {
    sessionId: SID_J,
    path: PATH_J,
    title: '无落点文件会话 J',
    agentId: 'agent-home',
    latest: {
      messages: [{ id: '1', role: 'user', content: [], timestamp: stamp(1) }],
      blocks: [
        { type: 'file', fileId: 'sf_j', label: 'j-standalone.txt', ext: 'txt', size: 5, afterIndex: 0 },
      ],
      hasMore: false,
    },
    older: { messages: [], blocks: [], hasMore: false },
    earliestId: 1,
  },
};

/* ------------------------------------------------------------------ */
/* 路由化 fetch                                                         */
/* ------------------------------------------------------------------ */

const state = {
  log: [],
  holdOlder: false,
  pendingOlder: [], // { sessionId, resolve }
  holdLatest: new Set(), // 故意挂起的首屏请求（排掉迟到收尾类用例）
  pendingLatest: [], // { sessionId, resolve }
  cAttempts: 0,
  cardHeads: [], // /gw/card/* 的 HEAD 请求（卡片包目录校验）
};

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : `HTTP ${status}`,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

globalThis.fetch = async (url, init = {}) => {
  const full = String(url);
  const [path, query = ''] = full.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  state.log.push({ url: full, path, query, params, method: String(init?.method || 'GET').toUpperCase() });

  if (path === '/api/sessions/messages') {
    // 故意挂起首屏：用来制造「A 的 openSession 尾部晚于 B 打开」的真实时序。
    if (params.before === undefined && state.holdLatest.has(params.sessionId)) {
      return new Promise((resolve) => {
        state.pendingLatest.push({ sessionId: params.sessionId, resolve });
      });
    }
    if (params.sessionId === SID_C && params.before === undefined) {
      state.cAttempts += 1;
      // 第一次 500：视图要提示错误；重试（再次 open）时给一页正常历史。
      if (state.cAttempts === 1) return jsonRes({ detail: 'boom' }, { ok: false, status: 500 });
      return jsonRes({ messages: [userMessage(1, 'C-LATEST-1')], blocks: [], hasMore: false });
    }
    const fixture = Object.values(FIXTURES).find((f) => f.sessionId === params.sessionId);
    if (!fixture || !fixture.latest) throw new Error(`unexpected history session: ${params.sessionId}`);
    if (params.before !== undefined) {
      if (state.holdOlder) {
        return new Promise((resolve) => {
          state.pendingOlder.push({ sessionId: params.sessionId, resolve });
        });
      }
      return jsonRes(fixture.older);
    }
    return jsonRes(fixture.latest);
  }
  if (path.startsWith('/gw/card/')) {
    // 卡片包目录的官方校验请求：只记录，不返回版本头（版本注入由 A 自己的单测覆盖）。
    state.cardHeads.push({ path, url: full, method: String(init?.method || 'GET').toUpperCase() });
    return {
      ok: true,
      status: 200,
      url: full,
      headers: { get: () => null },
      async json() {
        return {};
      },
      async text() {
        return '';
      },
    };
  }
  if (path === '/api/web-auth/session') return jsonRes({ authenticated: true, principal: { id: 'user-qa' } });
  if (path === '/api/mobile/bootstrap') {
    return jsonRes({
      agents: [{ id: 'agent-home', name: 'Hakimi', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions') return jsonRes([]);
  throw new Error(`unexpected fetch: ${full}`);
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await delay(0);
}

async function waitFor(pred, label, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pred()) return;
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

const transcript = () => getEl('transcript');
const historyRequests = () => state.log.filter((r) => r.path === '/api/sessions/messages');
const olderRequests = () => historyRequests().filter((r) => r.params.before !== undefined);

/** 节点是否还挂在界面树上（历史用例会反复换会话，allEls 里的旧按钮必须排除）。 */
function isAttached(node) {
  const roots = [mockBody, transcript(), getEl('view-chat'), getEl('view-list'), getEl('view-login')];
  let cur = node;
  while (cur) {
    if (roots.includes(cur)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function subtreeText(node) {
  // 探针不解析 innerHTML，但 app 把消息正文写在那里（renderMarkdown）；
  // 文本断言需要把标签去掉后一起算进来。
  let out = String(node?.textContent ?? '');
  const html = String(node?.innerHTML ?? '');
  if (html) out += ' ' + html.replace(/<[^>]*>/g, ' ');
  for (const child of node?.children || []) out += ' ' + subtreeText(child);
  return out;
}

const transcriptText = () => subtreeText(transcript());

/** transcript 的顶层消息节点（排除分页控制带与临时锚点）。 */
function isHistoryChrome(node) {
  const classes = splitClasses(node?.className);
  return classes.includes('history-pagination-bar') || classes.includes('history-pagination-anchor');
}
const messageChildren = () => transcript().children.filter((n) => !isHistoryChrome(n));
const turns = () => messageChildren().filter((n) => splitClasses(n.className).includes('turn'));
/** 夹具 A 的一页：50 条 message + 1 个卡片 block。 */
const MESSAGE_TURNS = 50;
const PAGE_ENTRIES = 51;

/** 找可点击、文案包含任一关键字、且还挂在界面上的节点（不依赖未来 view 的 id/class）。 */
function findClickable(texts) {
  const hits = [];
  for (const node of allEls) {
    if (!isAttached(node)) continue;
    if (!(node.listeners?.click || []).length) continue;
    const text = subtreeText(node);
    if (!texts.some((t) => text.includes(t))) continue;
    hits.push(node);
  }
  // 取最小的那个：避免把包着按钮的容器也当成按钮。
  hits.sort((a, b) => collectDescendants(a).length - collectDescendants(b).length);
  return hits[0] || null;
}

function cardFrames() {
  return collectDescendants(transcript()).filter((n) => splitClasses(n.className).includes('card-frame'));
}

async function waitForCardFrames(count, label) {
  await waitFor(() => cardFrames().length >= count, label);
  return cardFrames();
}

/** 从 iframe 往上找到 transcript 的直接子节点（卡片 wrapper 或 turn）。 */
function topLevelChildOf(node) {
  let cur = node;
  while (cur.parentNode && cur.parentNode !== transcript()) cur = cur.parentNode;
  return cur.parentNode === transcript() ? cur : null;
}

/** 释放上一个用例遗留的挂起请求，避免跨用例串状态（结果属于旧 epoch，会被 pager 丢弃）。 */
async function drainPending() {
  while (state.pendingOlder.length) {
    const [pending] = state.pendingOlder.splice(0, 1);
    pending.resolve(jsonRes({ messages: [], blocks: [], hasMore: false }));
  }
  while (state.pendingLatest.length) {
    const [pending] = state.pendingLatest.splice(0, 1);
    const fixture = Object.values(FIXTURES).find((f) => f.sessionId === pending.sessionId);
    pending.resolve(jsonRes(fixture?.latest || { messages: [], blocks: [], hasMore: false }));
  }
  state.holdLatest.clear();
  state.holdOlder = false;
  await settle(2);
}

async function openFixture(key, { drain = true } = {}) {
  if (drain) await drainPending();
  const fixture = FIXTURES[key];
  const before = historyRequests().length;
  await globalThis.__hana.openSession({
    path: fixture.path,
    sessionId: fixture.sessionId,
    title: fixture.title,
    agentId: fixture.agentId,
  });
  await waitFor(() => historyRequests().length > before, `打开 ${key} 应拉一次历史`);
  await settle(3);
  // 返回本次打开新增的历史请求，避免用例之间累计计数互相干扰。
  return historyRequests().slice(before);
}

async function releaseOlder({ ok = true, status = 200, body } = {}) {
  assert.ok(state.pendingOlder.length > 0, '没有挂起中的「加载更早」请求可释放');
  const [pending] = state.pendingOlder.splice(0, 1);
  const fixture = Object.values(FIXTURES).find((f) => f.sessionId === pending.sessionId);
  pending.resolve(jsonRes(body === undefined ? fixture.older : body, { ok, status }));
  await settle(4);
}

/* ------------------------------------------------------------------ */
/* 加载真 app.js                                                        */
/* ------------------------------------------------------------------ */

const unhandled = [];
process.on('unhandledRejection', (err) => {
  unhandled.push(err);
});

await import('../web/app.js');

await waitFor(() => globalThis.__hana, 'window.__hana 就绪');
const hana = globalThis.__hana;
const S = hana.S;
await waitFor(() => S.currentAgent, 'boot 完成（S.currentAgent 就绪）');

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

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

await t('夹具自检：最新一页 50 条（含 1 张卡片）能按现有 app 渲染', async () => {
  // 这一条不测新功能，只证明探针本身能承载 transcript / turn / 卡片 iframe。
  // 它当前就应该绿；如果它红了，说明下面那些红是夹具问题，不是业务缺口。
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应渲染成 turn');
  assert.ok(transcriptText().includes('LATEST-A-51'), '消息正文应进入 transcript');
  await waitFor(() => findClickable(['加载更早']), 'hasMore=true 时 UI 应出现「加载更早」');
});

await t('最新历史显式带 sessionId/path/limit=50，hasMore=true 时出现「加载更早」', async () => {
  const opened = await openFixture('A');

  const first = opened[0];
  assert.ok(first, '打开会话应拉一次历史');
  assert.equal(first.params.sessionId, SID_A, '历史请求必须带会话自己的 sessionId');
  assert.equal(first.params.path, PATH_A, '历史请求必须带会话自己的 path');
  assert.equal(
    first.params.limit,
    '50',
    `最新历史必须显式带 limit=50，实际 URL：${first.url}`,
  );
  assert.equal('before' in first.params, false, '最新一页不能带 before');
  assert.equal(new URLSearchParams(first.query).has('namespace'), false, `历史请求不能带 namespace：${first.url}`);
  assert.equal(new URLSearchParams(first.query).has('all'), false, `历史请求不能带 all：${first.url}`);
  assert.equal(
    opened.length,
    1,
    `打开会话只该拉一次最新页（旧 loadHistory 与新 pager 不能同时请求），实际：${opened.map((r) => r.url).join(' | ')}`,
  );

  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');
  await waitFor(() => findClickable(['加载更早']), 'hasMore=true 时 UI 应出现「加载更早」');
});

await t('加载更早：before=最早 id、同会话；早期消息插在原消息前，旧卡片不重建', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');
  const framesBefore = await waitForCardFrames(1, '最新一页的卡片 block 应渲染');
  assert.equal(
    messageChildren().length,
    PAGE_ENTRIES,
    '最新一页应是 50 条消息 + 1 个卡片块 = 51 个顶层节点',
  );
  const oldCard = framesBefore[0];
  const oldCardId = oldCard.dataset.cardId;
  const oldChildren = [...messageChildren()];
  const requestCount = historyRequests().length;

  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  assert.equal(button.disabled, false, '「加载更早」不能是禁用态（有 hasMore 就应该能点）');
  button.dispatchEvent('click');

  await waitFor(() => historyRequests().length === requestCount + 1, '点「加载更早」应发第二次历史请求');
  const older = historyRequests().at(-1);
  assert.equal(older.params.before, String(FIXTURES.A.earliestId), `before 必须是当前最早 raw id，实际 URL：${older.url}`);
  assert.ok(Number(older.params.before) > 0, 'before 必须是 >0 的 raw id');
  assert.equal(older.params.limit, '50', '旧页同样要带 limit=50');
  assert.equal(older.params.sessionId, SID_A, '旧页必须仍是同一个 sessionId');
  assert.equal(older.params.path, PATH_A, '旧页必须仍是同一个 path');
  assert.equal(new URLSearchParams(older.query).has('namespace'), false, '旧页不能带 namespace');

  await waitFor(() => transcriptText().includes('EARLY-A-1'), '早期消息应被渲染');
  await settle(6);

  const liveChildren = () => [...messageChildren()];
  for (const node of oldChildren) {
    assert.ok(liveChildren().includes(node), '加载更早不能清空或重建已有消息节点');
  }
  const firstOldIndex = Math.min(...oldChildren.map((n) => liveChildren().indexOf(n)));
  const earlyTurn = liveChildren().find((n) => subtreeText(n).includes('EARLY-A-1'));
  assert.ok(earlyTurn, '早期消息应作为新的顶层节点插入');
  assert.ok(
    liveChildren().indexOf(earlyTurn) < firstOldIndex,
    '早期消息必须插在原消息之前（不能追加到末尾）',
  );

  // 旧卡片：同一个 iframe 对象、同一个 cardId，说明没有被重绘/重新注册。
  assert.ok(collectDescendants(transcript()).includes(oldCard), '已有卡片的 iframe 不能被清掉重建');
  assert.equal(oldCard.dataset.cardId, oldCardId, '已有卡片不能重新注册成新的 cardId');

  // 早期 show_card 回执也要渲染成卡片，并插在旧内容之前。
  const framesNow = await waitForCardFrames(2, '早期 show_card 回执应渲染出卡片');
  const earlyCard = framesNow.find((f) => !framesBefore.includes(f));
  assert.ok(earlyCard, '早期卡片应是新渲染的 iframe');
  const earlyWrapper = topLevelChildOf(earlyCard);
  assert.ok(earlyWrapper, '早期卡片应挂在 transcript 顶层');
  assert.ok(
    liveChildren().indexOf(earlyWrapper) >= 0 && liveChildren().indexOf(earlyWrapper) < firstOldIndex,
    '早期卡片必须插在原消息之前',
  );
});

await t('加载中重复点击不并发：只发一个 before 请求', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');

  state.holdOlder = true;
  const olderBefore = olderRequests().length;
  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => state.pendingOlder.length === 1, '第一次点击应发出一个挂起的 before 请求');

  const again = findClickable(['加载更早']);
  if (again) again.dispatchEvent('click');
  button.dispatchEvent('click'); // 旧节点即使是分离的，也不该再发一次
  await settle(10);

  assert.equal(state.pendingOlder.length, 1, '加载中重复点击不能并发第二个请求');
  assert.equal(
    olderRequests().length,
    olderBefore + 1,
    `加载中只允许一个 before 请求，实际新增：${olderRequests().length - olderBefore}`,
  );

  state.holdOlder = false;
  await releaseOlder();
});

await t('换会话后旧响应不回填：A 的早期历史不能进 B 的 transcript', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');

  state.holdOlder = true;
  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => state.pendingOlder.length === 1, 'A 的 before 请求应挂起');

  await openFixture('B', { drain: false });
  await waitFor(() => transcriptText().includes('LATEST-B-1'), 'B 的最新消息应渲染');

  state.holdOlder = false;
  await releaseOlder(); // 释放 A 的迟到响应
  await settle(10);

  assert.equal(S.session.path, PATH_B, '活动会话必须仍是 B');
  assert.ok(
    !transcriptText().includes('EARLY-A-1'),
    'A 的迟到早期历史不能回填到 B 的 transcript',
  );
  assert.ok(transcriptText().includes('LATEST-B-2'), 'B 的最新消息不能被迟到响应冲掉');
});

await t('慢历史收尾：A 迟到时不能重连/关闭 B 已建立的 WS', async () => {
  await drainPending();
  state.holdLatest.add(SID_A);
  // 真实 app.openSession：S.session 先切到 A，然后卡在 loadHistory。
  const openingA = globalThis.__hana.openSession({
    path: PATH_A,
    sessionId: SID_A,
    title: '分页会话 A',
    agentId: 'agent-home',
  });
  await waitFor(() => state.pendingLatest.length === 1, 'A 的最新历史应挂起');

  await openFixture('B', { drain: false });
  await waitFor(() => transcriptText().includes('LATEST-B-1'), 'B 的最新消息应渲染');
  const wsB = S.ws;
  assert.ok(wsB, 'B 打开后应建立 WS');
  const instancesBefore = wsInstances.length;
  const closesBefore = wsB.closeCalls || 0;

  // A 的响应迟到：pager 会按 epoch 丢掉，但 openSession 的尾部收尾也必须被丢弃。
  const [pending] = state.pendingLatest.splice(0, 1);
  state.holdLatest.delete(SID_A);
  pending.resolve(jsonRes(FIXTURES.A.latest));
  await openingA;
  await settle(8);

  assert.equal(wsInstances.length, instancesBefore, 'A 迟到的收尾不能新建第二条 WS');
  assert.equal(S.ws, wsB, 'S.ws 必须还是 B 建立的连接');
  assert.equal(wsB.closeCalls || 0, closesBefore, 'A 迟到的收尾不能关闭 B 的 WS');
  assert.equal(S.session.path, PATH_B, '活动会话必须仍是 B');
  assert.ok(!transcriptText().includes('LATEST-A-51'), 'A 的迟到历史不能进 B 的 transcript');
});

await t('加载失败可重试：保留已有消息，点击后同一 before 再发一次', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');

  state.holdOlder = true;
  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => state.pendingOlder.length === 1, 'before 请求应挂起');

  await releaseOlder({ ok: false, status: 500, body: { detail: 'boom' } });
  await settle(8);

  assert.ok(transcriptText().includes('LATEST-A-51'), '加载失败不能清空已有消息');
  assert.equal(S.session.path, PATH_A, '加载失败不能换会话');
  const retry = findClickable(['加载更早', '重试']);
  assert.ok(retry, '加载失败后应保留可重试入口');
  assert.equal(retry.disabled, false, '失败后的重试入口不能是禁用态');

  state.holdOlder = false;
  const countBefore = olderRequests().length;
  retry.dispatchEvent('click');
  await waitFor(() => olderRequests().length === countBefore + 1, '重试应再发一次 before 请求');
  assert.equal(
    olderRequests().at(-1).params.before,
    String(FIXTURES.A.earliestId),
    '重试的 before 必须与首次一致',
  );
  await waitFor(() => transcriptText().includes('EARLY-A-1'), '重试成功后早期消息应渲染');
});

await t('首屏加载失败：视图提示错误，不伪装成空会话；重试可恢复', async () => {
  await openFixture('C');
  await settle(8);

  assert.ok(
    !transcriptText().includes('这个会话还没有消息'),
    '首屏加载失败不能伪装成「会话无消息」',
  );
  assert.ok(
    transcriptText().includes('失败') || transcriptText().includes('重试'),
    `首屏加载失败应在视图里提示，实际：${transcriptText()}`,
  );

  const retry = findClickable(['重试']);
  assert.ok(retry, '首屏加载失败后应有可点的「重试」入口');
  assert.equal(retry.disabled, false);

  retry.dispatchEvent('click');
  await waitFor(() => transcriptText().includes('C-LATEST-1'), '重试成功后应渲染最新一页');
});

await t('生成中：允许加载更早，流式轮的身份 / 正文 / 游标都不许被改写', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');

  // 模拟一个正在流式的 turn：生成期间可以回放更早页，但不能改它的身份或正文。
  const liveTurn = makeEl('div');
  liveTurn.className = 'turn assistant';
  const liveBody = makeEl('div');
  liveBody.className = 'turn-body';
  liveBody.textContent = 'LIVE-STREAM-TEXT';
  liveTurn.appendChild(liveBody);
  S.turn = liveTurn;
  const turnBefore = S.turn;

  // 1) 生成中点「加载更早」：请求照发，更早页照样回放（旧契约是直接拦住）
  S.busy = true;
  const olderBefore = olderRequests().length;
  const cursor = hana.streamState.snapshot();
  const button = findClickable(['加载更早']);
  assert.ok(button, '生成中也该有可点的「加载更早」');
  button.dispatchEvent('click');
  await waitFor(() => olderRequests().length === olderBefore + 1, '生成中点加载更早应照常发请求');
  await waitFor(() => transcriptText().includes('EARLY-A-1'), '更早页应正常回放上屏');

  assert.deepEqual(hana.streamState.snapshot(), cursor, '回放更早页不能动流式 cursor');
  assert.equal(S.turn, turnBefore, '回放更早页不能把正在生成的那一轮顶掉');
  assert.equal(liveBody.textContent, 'LIVE-STREAM-TEXT', '流式轮正文不能被动');
  S.busy = false;
  S.turn = null;
});

await t('请求在飞时转 busy：更早页仍可提交，但不能动流式轮', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');

  const liveTurn = makeEl('div');
  liveTurn.className = 'turn assistant';
  const liveBody = makeEl('div');
  liveBody.className = 'turn-body';
  liveBody.textContent = 'LIVE-STREAM-TEXT';
  liveTurn.appendChild(liveBody);
  S.turn = liveTurn;
  const turnBefore = S.turn;

  // 先把请求挂起来，再在它飞行的路上转成生成态：提交复核必须放行 older，同时不碰实时轮
  state.holdOlder = true;
  const olderBefore = olderRequests().length;
  const button = findClickable(['加载更早']);
  assert.ok(button, '应该有可点的「加载更早」');
  button.dispatchEvent('click');
  await waitFor(() => state.pendingOlder.length === 1, 'before 请求应挂起');

  S.busy = true;
  const cursor = hana.streamState.snapshot();
  state.holdOlder = false;
  await releaseOlder();
  await waitFor(() => olderRequests().length === olderBefore + 1, '早页请求已经发出');
  await waitFor(() => transcriptText().includes('EARLY-A-1'), '迟到的更早页应该照常提交上屏');
  await settle(8);

  assert.deepEqual(hana.streamState.snapshot(), cursor, '迟到响应不能动流式 cursor');
  assert.equal(S.turn, turnBefore, '迟到响应不能动流式 turn');
  assert.equal(liveBody.textContent, 'LIVE-STREAM-TEXT', '迟到响应不能动流式 turn 正文');
  S.busy = false;
  S.turn = null;
});

await t('原有 Chat / Code 切换不回退：换目录筛选不动活动会话和已加载历史', async () => {
  await openFixture('A');
  await waitFor(() => turns().length === MESSAGE_TURNS, '最新 50 条消息应全部渲染');
  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => transcriptText().includes('EARLY-A-1'), '早期消息应渲染');

  const listBefore = state.log.filter((r) => r.path === '/api/sessions').length;
  const historyBefore = historyRequests().length;

  getEl('btnNamespaceCode').dispatchEvent('click');
  await waitFor(
    () => state.log.filter((r) => r.path === '/api/sessions' && r.params.namespace === 'code').length > 0,
    '点 Code 应请求 namespace=code 的目录',
  );
  await settle(4);
  assert.equal(S.session.path, PATH_A, '切目录筛选不能改活动会话');
  assert.ok(transcriptText().includes('EARLY-A-1'), '切目录筛选不能清掉已加载的早期历史');
  assert.equal(historyRequests().length, historyBefore, '切目录筛选不应重拉历史');

  getEl('btnNamespaceHome').dispatchEvent('click');
  await waitFor(
    () => state.log.filter((r) => r.path === '/api/sessions' && r.params.namespace === 'home').length > listBefore,
    '点 Chat 应请求 namespace=home 的目录',
  );
  await settle(4);
  assert.equal(S.session.path, PATH_A, '切回 Chat 也不能改活动会话');
  assert.ok(transcriptText().includes('EARLY-A-1'), '切回 Chat 不能清掉已加载的历史');
});

await t('页边界两侧都是 assistant：更早页首条不能合并进最新页最后一轮', async () => {
  await openFixture('G');
  await waitFor(() => turns().length === 2, 'G 最新页 2 条消息应渲染');

  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => transcriptText().includes('G-EARLY-2'), '早期 assistant 消息应渲染');
  await settle(4);

  const kids = messageChildren();
  const earlyTurn = kids.find((n) => subtreeText(n).includes('G-EARLY-2'));
  const earlyUser = kids.find((n) => subtreeText(n).includes('G-EARLY-3'));
  const latestTurn = kids.find((n) => subtreeText(n).includes('G-LATEST-5'));
  assert.ok(earlyTurn, '早期 assistant 消息应作为独立节点出现');
  assert.ok(earlyUser, '早期 user 消息应作为独立节点出现');
  assert.ok(latestTurn, '最新页的 assistant 轮应还在');
  assert.notEqual(
    earlyTurn,
    latestTurn,
    '更早页首条 assistant 不能合并进最新页最后一轮（跨页邻接没有身份）',
  );
  assert.ok(
    kids.indexOf(earlyTurn) < kids.indexOf(earlyUser),
    '更早页内部的顺序必须保持（assistant 在 user 之前）',
  );
  assert.ok(
    kids.indexOf(earlyUser) < kids.indexOf(latestTurn),
    '更早页的内容必须排在最新页之前',
  );
  assert.equal(
    (transcriptText().match(/G-EARLY-2/g) || []).length,
    1,
    `早期 assistant 内容只能出现一次，实际：${transcriptText()}`,
  );
  assert.equal(turns().length, 4, `两页各 2 条消息应各自成轮（共 4 个 turn），实际 ${turns().length}`);
});

/* ---- 历史轮 vs 实时轮：页尾之后不能续写、不能收尾 -------------------- */

/** 某个节点所在的最近一个 .turn（历史轮 / 实时轮都是这个形状）。 */
function turnOf(node) {
  let cur = node;
  while (cur) {
    if (splitClasses(cur.className).includes('turn')) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/** 节点属于哪一页（顶层节点里最早出现的祖先；越界返回 null）。 */
function topLevelIndexOf(node) {
  const top = topLevelChildOf(node);
  return top ? messageChildren().indexOf(top) : -1;
}

function footTextOf(turn) {
  const foot = turn ? collectDescendants(turn).find((n) => splitClasses(n.className).includes('foot-time')) : null;
  return foot ? subtreeText(foot) : '';
}

/** 探针 WS 发出的某一类帧数（frames 不叫 frames：探针只存 sent）。 */
function sentCount(socket, type) {
  return (socket?.sent || []).filter((frame) => frame && frame.type === type).length;
}

function fileCardsOf() {
  return collectDescendants(transcript()).filter((n) => splitClasses(n.className).includes('file-card'));
}

await t('同页连续 assistant 仍合成一轮，且页尾轮不回写 state.turn', async () => {
  await openFixture('H');
  await waitFor(() => turns().length === 2, 'H 应是 1 条 user + 1 条合并后的 assistant');

  const assistantTurn = turns()[1];
  const text = subtreeText(assistantTurn);
  assert.ok(text.includes('H-ASSIST-2'), '同页第一条 assistant 应在合并轮里');
  assert.ok(text.includes('H-ASSIST-3'), '同页第二条 assistant 也应在同一个合并轮里');
  assert.equal(
    (transcriptText().match(/H-ASSIST-3/g) || []).length,
    1,
    '合并后每条内容只能出现一次（不能拆成两轮也不能重复）',
  );
  assert.equal(S.turn, null, '历史页结束后 state.turn 必须是空的：历史轮不能留给实时路由');
  assert.equal(S.turnBody, null, 'state.turnBody 也不能残留历史轮');
});

await t('页尾 assistant 后的实时 delta 另起一轮，不改历史轮正文与尾注', async () => {
  await openFixture('H');
  await waitFor(() => turns().length === 2, 'H 应是 1 条 user + 1 条合并后的 assistant');

  const historyTurn = turns()[1];
  const historyText = subtreeText(historyTurn);
  const historyFoot = footTextOf(historyTurn);
  assert.ok(!historyText.includes('H-LIVE-DELTA'), '夹具：历史轮里不该有实时内容');

  hana.handleEvent({ type: 'text_delta', delta: 'H-LIVE-DELTA', sessionId: SID_H, sessionPath: PATH_H });
  await settle(4);

  const liveTurn = turns()[turns().length - 1];
  assert.ok(S.turn, '实时 delta 应开出一轮实时轮');
  assert.notEqual(liveTurn, historyTurn, '实时 delta 不能续进历史轮');
  assert.ok(subtreeText(liveTurn).includes('H-LIVE-DELTA'), `新轮应带实时正文，实际：${subtreeText(liveTurn)}`);
  assert.equal(subtreeText(historyTurn), historyText, '历史轮正文不能被实时 delta 改动');
  assert.equal(footTextOf(historyTurn), historyFoot, '历史轮尾注不能被实时 delta 改动');
});

await t('status:true 不把历史轮当本轮收尾：不改尾注、不触发整轮收尾', async () => {
  await openFixture('H');
  await waitFor(() => turns().length === 2, 'H 应是 1 条 user + 1 条合并后的 assistant');

  const historyTurn = turns()[1];
  const historyFoot = footTextOf(historyTurn);
  const ws = S.ws;
  assert.ok(ws, '夹具：打开会话后应建立 WS');
  // 探针 WS 只有 send/close：直接标成已连接，让 endTurn 的 context_usage 真能发出去。
  ws.readyState = 1;
  await settle(4);
  const usageBefore = sentCount(ws, 'context_usage');

  const originalFinish = hana.renderer.finishTurn;
  let finished = 0;
  hana.renderer.finishTurn = function finishSpy(...args) {
    finished += 1;
    return originalFinish.apply(this, args);
  };
  try {
    // 先 true 再 false：开轮信号也不能先把历史轮收掉。
    hana.handleEvent({ type: 'status', isStreaming: true, sessionId: SID_H, sessionPath: PATH_H });
    await settle(4);
    hana.handleEvent({ type: 'status', isStreaming: false, sessionId: SID_H, sessionPath: PATH_H });
    await settle(6);
  } finally {
    hana.renderer.finishTurn = originalFinish;
  }

  assert.equal(finished, 0, 'status 不能把历史轮当成本轮去收尾（finishTurn 不应被调用）');
  assert.equal(footTextOf(historyTurn), historyFoot, '历史轮尾注不能被 status 改写');
  assert.equal(
    sentCount(ws, 'context_usage'),
    usageBefore,
    '不能触发整轮收尾附带的 context_usage 请求（那是一次虚假的「回复完成」通知）',
  );
  assert.equal(historyTurn.classList.contains('streaming'), false, '历史轮不能被标成 streaming');
});

/* ---- file 块的页内落点 --------------------------------------------- */

await t('file 锚在 user 后面：首次页挂到这条 user，而不是后面的 assistant', async () => {
  await openFixture('I');
  await waitFor(() => turns().length === 2, 'I 最新页应是 1 条 user + 1 条 assistant');

  const cards = fileCardsOf();
  assert.equal(cards.length, 1, `最新页应渲染出 1 张文件卡，实际 ${cards.length}`);
  const host = turnOf(cards[0]);
  assert.ok(host, '文件卡应挂在某个消息轮里');
  assert.ok(splitClasses(host.className).includes('user'), `应挂在本页的 user 轮上，实际 ${host.className}`);
  assert.ok(subtreeText(host).includes('I-LATEST-U-3'), '应挂在 file 锚点前面那条 user 上');
  assert.equal(S.turn, null, '渲染完仍不能把历史轮留在 state.turn');
});

await t('file 锚在更早页 user 后面：prepend 不能挂到更新的一页上', async () => {
  await openFixture('I');
  await waitFor(() => turns().length === 2, 'I 最新页应是 1 条 user + 1 条 assistant');
  const latestCard = fileCardsOf()[0];
  assert.ok(latestCard, '夹具：最新页文件卡应存在');
  const latestTurn = turnOf(latestCard);

  const button = findClickable(['加载更早']);
  assert.ok(button, '缺少「加载更早」入口');
  button.dispatchEvent('click');
  await waitFor(() => turns().length === 4, '更早页 2 条消息应插入');
  await waitFor(() => fileCardsOf().length === 2, '更早页的文件卡也应渲染');
  await settle(4);

  const earlyCard = fileCardsOf().find((card) => card !== latestCard);
  assert.ok(earlyCard, '更早页应渲染出自己的文件卡');
  const earlyHost = turnOf(earlyCard);
  assert.ok(earlyHost, '更早页文件卡应挂在消息轮里');
  assert.ok(
    splitClasses(earlyHost.className).includes('user'),
    `更早页文件卡应挂在本页 user 轮上，实际 ${earlyHost.className}`,
  );
  assert.ok(subtreeText(earlyHost).includes('I-EARLY-U-1'), '应挂在更早页那条 user 上');
  assert.notEqual(earlyHost, latestTurn, '更早页文件不能挂到最新页的轮里');
  assert.ok(
    topLevelIndexOf(earlyCard) < topLevelIndexOf(latestCard),
    '更早页文件卡必须排在最新页之前',
  );
  // 最新页那张不能被挤走或换位置
  assert.equal(turnOf(latestCard), latestTurn, '最新页文件卡不能被 prepend 弄丢或搬家');
});

await t('本页没有可用落点时：file 块按本页顺序独立呈现，不丢', async () => {
  await openFixture('J');
  await settle(6);

  const cards = fileCardsOf();
  assert.equal(cards.length, 1, `没有消息落点时文件卡也不能丢，实际 ${cards.length} 张`);
  assert.equal(turnOf(cards[0]), null, '不能硬挂进某个消息轮里');
  const box = topLevelChildOf(cards[0]);
  assert.ok(box, '独立呈现的 file 块应是 transcript 的顶层节点');
  assert.ok(
    splitClasses(box.className).includes('history-file-cards'),
    `应是本页的独立文件块，实际 ${box.className}`,
  );
  assert.equal(turns().length, 0, '夹具：这一页没有能画成消息的条目');
});

/** 包一层真实 controller 观测 app 传参（原样转发）；不是 stub，不替代 A 的安全单测。 */
async function withRenderSpy(fn) {
  const original = hana.cardController.render;
  const calls = [];
  hana.cardController.render = function renderSpy(ev, snapshot, options) {
    calls.push({ ev, options });
    return original.call(this, ev, snapshot, options);
  };
  try {
    return await fn(calls);
  } finally {
    hana.cardController.render = original;
  }
}

await t('packageRef：按当前页 sessionFiles 的官方目录 HEAD，prepend 后旧卡片 iframe 不重建', async () => {
  await withRenderSpy(async (renderCalls) => {
    state.cardHeads.length = 0;
    await openFixture('P');
    await waitFor(() => turns().length === 3, 'P 最新页 3 条消息应渲染');
    // 先确认 packageRef 块本身已进入渲染（wrapper 算一个顶层节点），再要求它变成官方目录的 iframe。
    assert.equal(messageChildren().length, 4, 'P 最新页应是 3 条消息 + 1 个 packageRef 块');
    const packageCalls = renderCalls.filter((call) => call.ev && call.ev.packageRef);
    assert.equal(packageCalls.length, 1, '最新页应恰好渲染一次 packageRef 块');
    assert.deepEqual(
      packageCalls[0].options?.sessionFiles,
      FIXTURES.P.latest.sessionFiles,
      '当前页 sessionFiles 必须原样透传给 cardController（不能合并/替换）',
    );

    const frames = await waitForCardFrames(1, 'packageRef 卡片应按官方 sessionFiles 目录渲染出 iframe');
    assert.equal(
      state.cardHeads.length,
      1,
      `应只对官方目录发一次 HEAD，实际：${state.cardHeads.map((h) => h.url).join(' | ')}`,
    );
    assert.equal(state.cardHeads[0].method, 'HEAD', '卡片包目录只能用 HEAD 校验');
    assert.equal(
      state.cardHeads[0].path,
      cardPathFor(CARD_DIR_P_LATEST),
      'HEAD 必须精确命中官方 sessionFiles 目录，不能猜路径',
    );
    assert.ok(
      String(frames[0].src).includes(cardPathFor(CARD_DIR_P_LATEST)),
      `最新卡片 iframe 应指向官方目录，实际：${frames[0].src}`,
    );
    const oldFrame = frames[0];
    const oldTop = topLevelChildOf(oldFrame);
    assert.ok(oldTop, '最新卡片应挂在 transcript 顶层');

    const button = findClickable(['加载更早']);
    assert.ok(button, '缺少「加载更早」入口');
    button.dispatchEvent('click');
    await waitFor(() => turns().length === 5, '早期消息应插入');
    await waitForCardFrames(2, '早期页的 packageRef 卡片也应渲染');

    assert.equal(cardFrames().indexOf(oldFrame) >= 0, true, '旧卡片 iframe 必须还是同一个对象（不能重建）');
    assert.equal(topLevelChildOf(oldFrame), oldTop, '旧卡片的顶层节点也不能被替换');
    assert.equal(oldTop.parentNode, transcript(), '旧卡片仍应挂在 transcript 上');

    const earlyHeads = state.cardHeads.slice(1);
    assert.equal(
      earlyHeads.length,
      1,
      `只应为早期页官方目录再发一次 HEAD，实际：${earlyHeads.map((h) => h.url).join(' | ')}`,
    );
    assert.equal(earlyHeads[0].path, cardPathFor(CARD_DIR_P_EARLY), '早期 HEAD 必须精确命中官方目录');
    const after = cardFrames();
    const earlyFrame = after.find((frame) => frame !== oldFrame);
    assert.ok(earlyFrame, '早期页应渲染出第二张卡片 iframe');
    assert.ok(
      String(earlyFrame.src).includes(cardPathFor(CARD_DIR_P_EARLY)),
      `早期卡片 iframe 应指向官方目录，实际：${earlyFrame.src}`,
    );
    assert.ok(
      after.indexOf(earlyFrame) < after.indexOf(oldFrame),
      '早期卡片应插在最新卡片前面（prepend 不能把旧内容挤到后面）',
    );

    const earlyCalls = renderCalls.filter((call) => call.ev && call.ev.packageRef);
    assert.equal(earlyCalls.length, 2, '前后两页各应渲染一次 packageRef 块');
    assert.deepEqual(
      earlyCalls[1].options?.sessionFiles,
      FIXTURES.P.older.sessionFiles,
      '早期页必须用自己的 sessionFiles（不能复用最新页或缓存）',
    );
  });
});
await t('packageRef：foreign 元数据不命中官方目录，不发 HEAD、不启动桥、只给占位', async () => {
  const originalRegister = hana.cardBridge.register;
  const registrations = [];
  hana.cardBridge.register = function registerSpy(iframe, trustedContext) {
    registrations.push(iframe);
    return originalRegister.call(this, iframe, trustedContext);
  };
  try {
    state.cardHeads.length = 0;
    await openFixture('F');
    await waitFor(() => turns().length === 1, 'F 的消息应渲染');
    await settle(6);

    assert.equal(state.cardHeads.length, 0, `foreign 目录不能发 HEAD，实际：${state.cardHeads.map((h) => h.url).join(' | ')}`);
    assert.equal(registrations.length, 0, 'foreign 目录不能启动卡片桥');
    assert.equal(cardFrames().length, 0, 'foreign 目录不能渲染 iframe');
    assert.ok(
      collectDescendants(transcript()).some((node) => splitClasses(node.className).includes('card-placeholder')),
      'foreign 卡片应退回占位，而不是猜目录渲染',
    );
  } finally {
    hana.cardBridge.register = originalRegister;
  }
});

/* ------------------------------------------------------------------ */

if (unhandled.length) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝（${unhandled.length} 条）`);
  for (const err of unhandled) console.log(`      ${err?.stack || err}`);
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
