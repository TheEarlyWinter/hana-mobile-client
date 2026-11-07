/* tests/conversation_new_session.test.mjs
 *
 * 新建会话必须带上当前命名空间；首屏重试要补上骨架屏。
 *
 * 真机反馈：在 Code 标签下点新建，建出来的却是 Chat 会话。
 * 宿主源码（bundle 1.5.70，`/sessions/new` 处理函数）已核实：
 *   const le = { workspaceFolders: ee, visibleInSessionList: !0 };
 *   X === "code" && (le.namespace = "code"),
 *   de && (le.codeWorktree = de),
 * 其中 X 来自 Bnt(body)，它只认 body.namespace（"home" / "code"），
 * 并且会 400 拒绝客户端自己塞 codeWorktree（client_code_worktree_forbidden）。
 * 所以前端能且只该传 namespace。
 *
 * 后半部分是首屏重试的骨架屏：
 *   - 首屏失败后的「重试」屏上什么都没有，必须给骨架屏；
 *   - 原会话重载（clearNow:false）时旧历史要一直看得见，不能被不透明骨架盖住。
 */

import assert from 'node:assert/strict';
import { createConversationController } from '../web/conversation-controller.js';
import { createScrollMemory } from '../web/scroll-memory.js';

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

const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 最小 DOM：只满足 conversation-controller 构造、newSession 与历史/骨架这两条路径需要的接口。 */
function makeEl(tag = 'div') {
  const listeners = new Map();
  let html = '';
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    children: [],
    style: {},
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(c) { node.children.push(c); c.parentNode = node; return c; },
    insertBefore(c, ref) {
      const i = node.children.indexOf(ref);
      node.children.splice(i < 0 ? node.children.length : i, 0, c);
      c.parentNode = node;
      return c;
    },
    removeChild(c) {
      const i = node.children.indexOf(c);
      if (i >= 0) { node.children.splice(i, 1); c.parentNode = null; }
      return c;
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.set(type, listeners.get(type).filter((f) => f !== fn));
    },
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt?.type;
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, target: node, preventDefault() {}, stopPropagation() {} });
      return true;
    },
    click() { node.dispatchEvent('click'); },
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get firstChild() { return node.children[0] || null; },
  };

  // 真 DOM 里 innerHTML='' 会把子节点从树上摘下来：切会话清屏靠的就是这一步。
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = String(value ?? '');
      for (const child of node.children) child.parentNode = null;
      node.children.length = 0;
    },
  });
  return node;
}

function makeDocument() {
  return {
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    body: makeEl('body'),
    documentElement: makeEl('html'),
  };
}

/**
 * 只搭 newSession 真正会走到的依赖。
 * loadSessions 故意返回永不 resolve 的 Promise：把流程停在「建完、还没进会话」这一步，
 * 这样断言的是请求体与筛选参数，不会被后面的历史/连接流程干扰。
 */
function makeController({ createResult } = {}) {
  const created = [];
  const loaded = [];
  const flashes = [];
  const state = {
    principal: { id: 'owner-1' },
    currentAgent: { id: 'agent-1', name: '小鲸鱼' },
    agentName: '小鲸鱼',
    sessions: [],
    session: null,
  };

  const api = async (url, init) => {
    if (url === '/api/sessions/new') {
      created.push(JSON.parse(init.body || '{}'));
      return createResult || { sessionId: 'sess-new', path: '/tmp/new.md', agentId: 'agent-1' };
    }
    return {};
  };

  const controller = createConversationController({
    state,
    document: makeDocument(),
    getElement: (id) => (id === 'transcript' ? makeEl('div') : null),
    api,
    renderer: {},
    composer: { clearAttach() {}, back: () => false },
    sockets: {},
    streamState: {},
    closeFilePreview: () => {},
    show: () => {},
    loadSessions: (ns) => {
      loaded.push(ns);
      return new Promise(() => {});
    },
    flash: (msg) => flashes.push(msg),
    sessionFolder: () => '',
    closeDrawer: () => {},
  });

  return { controller, created, loaded, flashes, state };
}

await t('新建 Code 会话：请求体带 namespace=code 与 cwd，并按 code 重新拉列表', async () => {
  const { controller, created, loaded } = makeController();

  controller.newSession('code', { cwd: 'C:\\proj\\demo' });
  await delay(20);

  assert.equal(created.length, 1, '必须只发一次创建请求');
  assert.equal(created[0].namespace, 'code', '宿主靠 body.namespace 决定 Chat / Code');
  assert.equal(created[0].cwd, 'C:\\proj\\demo', '宿主要求 Code 会话必须自带目录（code_repository_required）');
  assert.equal(created[0].agentId, 'agent-1', 'agentId 不能丢');
  assert.deepEqual(loaded, ['code'], '建完要按新会话的命名空间刷新列表');
});

await t('Code 新建缺目录：不发请求，直接提示（宿主要求目录且不会替我们猜）', async () => {
  const { controller, created, loaded, flashes } = makeController();

  controller.newSession('code');
  await delay(20);

  assert.equal(created.length, 0, '没目录就不该发注定 400 的请求');
  assert.deepEqual(loaded, []);
  assert.equal(flashes.length, 1);
  assert.ok(flashes[0].includes('Code'), `提示要说清是 Code 会话缺目录，实际：${flashes[0]}`);
});

await t('新建 Chat 会话：namespace=home', async () => {
  const { controller, created, loaded } = makeController();

  controller.newSession('home');
  await delay(20);

  assert.equal(created[0].namespace, 'home');
  assert.deepEqual(loaded, ['home']);
});

await t('不传命名空间时按 home 处理，保持旧调用方行为', async () => {
  const { controller, created, loaded } = makeController();

  controller.newSession();
  await delay(20);

  assert.equal(created[0].namespace, 'home');
  assert.deepEqual(loaded, ['home']);
});

await t('未知命名空间不往下传，收敛成 home（宿主只认 home/code）', async () => {
  const { controller, created, loaded } = makeController();

  controller.newSession('weird');
  await delay(20);

  assert.equal(created[0].namespace, 'home');
  assert.deepEqual(loaded, ['home']);
});

/* ------------------------------------------------------------------ */
/* 首屏重试的骨架屏                                                    */
/* ------------------------------------------------------------------ */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`等待超时：${label}`);
}

function textOf(node) {
  if (!node) return '';
  let out = String(node.textContent ?? '');
  for (const child of node.children || []) out += ` ${textOf(child)}`;
  return out;
}

/** 宿主历史页：messages 只有 user/assistant，id 是十进制字符串。 */
function pageOf(text) {
  return {
    messages: [{ id: '1', role: 'user', content: text, timestamp: '2026-11-04T00:00:00.000Z' }],
    blocks: [],
    hasMore: false,
  };
}

/**
 * 只搭「进会话 → 渲染历史 → 重载/重试」这条路径的依赖。
 * pages 是预置的响应队列：{ page } / { fail } / { pending: deferred }，每次 GET 消费一个，
 * 这样用例能把请求挂在途，观察骨架屏在「等待中」那一刻的状态。
 */
function makeHistoryController({ scrollMemory = null, inChat = false } = {}) {
  const transcript = makeEl('div');
  const skeleton = makeEl('div');
  // index.html 里 #chatSkeleton 自带 hidden：起始是收起的，只看 controller 开关
  skeleton.hidden = true;
  const chatView = makeEl('div');
  chatView.hidden = !inChat;
  const els = {
    transcript,
    chatSkeleton: skeleton,
    chatTitle: makeEl('div'),
    chatSub: makeEl('div'),
    'view-chat': chatView,
  };
  const scrollCalls = [];
  const state = {
    principal: { id: 'owner-1' },
    currentAgent: { id: 'agent-1', name: '小鲸鱼' },
    memoryOn: null,
    ctxPct: null,
    busy: false,
    session: null,
  };
  const pages = [];
  const calls = [];

  const api = (url) => {
    const href = String(url);
    calls.push(href);
    if (!href.startsWith('/api/sessions/messages')) return Promise.resolve({});
    const next = pages.shift();
    if (!next) return Promise.reject(Object.assign(new Error('用例没预置下一页'), { status: 500 }));
    if (next.pending) return next.pending.promise;
    if (next.fail) {
      return Promise.reject(Object.assign(new Error(next.message || 'boom'), { status: next.status || 500 }));
    }
    return Promise.resolve(next.page);
  };

  const renderer = {
    renderEntry(entry) {
      const node = makeEl('div');
      node.className = 'turn';
      node.textContent = String(entry?.content ?? '');
      transcript.appendChild(node);
      return true;
    },
    appendSystem(text) {
      const node = makeEl('div');
      node.className = 'system';
      node.textContent = String(text);
      transcript.appendChild(node);
      return node;
    },
    scrollToBottom(force) {
      scrollCalls.push(force === true);
    },
    resetTurnState() {},
    clearStats() {},
  };

  const controller = createConversationController({
    state,
    document: makeDocument(),
    getElement: (id) => els[id] || null,
    api,
    renderer,
    composer: { clearAttach() {}, setBusy() {} },
    sockets: { connect() {}, drop() {} },
    streamState: { reset() {} },
    closeFilePreview: () => {},
    show: () => {},
    loadSessions: async () => {},
    flash: () => {},
    sessionFolder: () => '',
    closeDrawer: () => {},
    scrollMemory,
  });

  return { controller, state, transcript, skeleton, pages, calls, scrollCalls };
}

/** 分页控制带里的主按钮：控制带永远是 transcript 的第一个子节点。 */
function retryButton(transcript) {
  const bar = transcript.children.find((c) => String(c.className || '').includes('history-pagination-bar'));
  assert.ok(bar, '应该有一条分页控制带');
  const button = bar.children.find((c) => String(c.className || '').includes('history-load-older'));
  assert.ok(button, '控制带里应该有一个按钮');
  return button;
}

const turnsOf = (transcript) => transcript.children.filter((c) => String(c.className || '').includes('turn'));

await t('会话切换（clearNow:true）：等数据时骨架屏可见，数据到了收起', async () => {
  const h = makeHistoryController();
  const pending = deferred();
  h.pages.push({ pending });

  const opening = h.controller.openSession({ path: 'C:/sessions/first', sessionId: 'sess-first' });
  await delay(5);
  assert.equal(h.skeleton.hidden, false, '切会话等首屏时就是骨架屏的地盘');

  pending.resolve(pageOf('FIRST-PAGE'));
  await opening;
  await waitFor(() => textOf(h.transcript).includes('FIRST-PAGE'), '首屏历史');
  assert.equal(h.skeleton.hidden, true, '数据到了骨架屏必须收起');
});

await t('首屏失败后点「重试」：空 transcript 上骨架屏重新出现', async () => {
  const h = makeHistoryController();
  h.pages.push({ fail: true, status: 500 });
  await h.controller.openSession({ path: 'C:/sessions/retry', sessionId: 'sess-retry' });
  await waitFor(() => /会话加载失败/.test(textOf(h.transcript)), '首屏失败文案');
  assert.equal(h.skeleton.hidden, true, '首屏失败后骨架屏必须收起，否则错误信息永远看不到');

  const pending = deferred();
  h.pages.push({ pending });
  const button = retryButton(h.transcript);
  assert.equal(button.disabled, false, '失败后重试按钮要可点');
  button.click();
  await delay(10);

  assert.equal(h.skeleton.hidden, false, '屏上还什么都没有，重试必须给骨架屏反馈');
  assert.equal(turnsOf(h.transcript).length, 0, '骨架屏不能顺手清 DOM 或凭空造成消息');

  pending.resolve(pageOf('RETRY-OK'));
  await waitFor(() => textOf(h.transcript).includes('RETRY-OK'), '重试成功');
});

await t('首屏重试成功：骨架屏收起，新历史落到 transcript', async () => {
  const h = makeHistoryController();
  h.pages.push({ fail: true, status: 500 });
  await h.controller.openSession({ path: 'C:/sessions/retry-ok', sessionId: 'sess-ok' });
  await waitFor(() => /会话加载失败/.test(textOf(h.transcript)), '首屏失败文案');

  h.pages.push({ page: pageOf('RETRY-DATA') });
  retryButton(h.transcript).click();
  await waitFor(() => textOf(h.transcript).includes('RETRY-DATA'), '重试拿到的历史');

  assert.equal(h.skeleton.hidden, true, '成功拿到数据后骨架屏必须收起');
  assert.equal(turnsOf(h.transcript).length, 1, '只应渲染这一页的一条消息');
  assert.ok(!/会话加载失败/.test(textOf(h.transcript)), '成功后旧错误文案要被清掉');
});

await t('首屏重试再失败：骨架屏收起、错误可见', async () => {
  const h = makeHistoryController();
  h.pages.push({ fail: true, status: 500 });
  await h.controller.openSession({ path: 'C:/sessions/retry-fail', sessionId: 'sess-rf' });
  await waitFor(() => /会话加载失败/.test(textOf(h.transcript)), '首屏失败文案');

  h.pages.push({ fail: true, status: 500, message: '宿主炸了' });
  retryButton(h.transcript).click();
  await waitFor(() => /宿主炸了/.test(textOf(h.transcript)), '重试失败文案');

  assert.equal(h.skeleton.hidden, true, '失败后骨架屏必须收起，不能盖住错误');
  const button = retryButton(h.transcript);
  assert.equal(button.disabled, false, '再失败也要能再点一次重试');
});

await t('原会话重载（已有内容）：不盖骨架、旧历史留到新数据到，到了才整页替换', async () => {
  const h = makeHistoryController();
  h.pages.push({ page: pageOf('OLD-HISTORY') });
  await h.controller.openSession({ path: 'C:/sessions/reload', sessionId: 'sess-reload' });
  await waitFor(() => textOf(h.transcript).includes('OLD-HISTORY'), '首屏历史');
  assert.equal(h.skeleton.hidden, true);

  const pending = deferred();
  h.pages.push({ pending });
  const reloading = h.controller.loadHistory();
  await delay(10);

  assert.equal(h.skeleton.hidden, true, '骨架是 position:absolute 的不透明遮罩，盖上去等于把正在看的历史藏起来');
  assert.ok(textOf(h.transcript).includes('OLD-HISTORY'), '旧历史必须留到新数据到（先清后取的老 bug 不能再回来）');

  pending.resolve(pageOf('NEW-HISTORY'));
  await reloading;
  await waitFor(() => textOf(h.transcript).includes('NEW-HISTORY'), '重载后的新历史');
  assert.equal(h.skeleton.hidden, true, '替换完成骨架屏保持收起');
  assert.ok(!textOf(h.transcript).includes('OLD-HISTORY'), '整页替换后旧内容应被换掉，不能两份叠在一起');
});

await t('原会话重载失败：旧历史仍在、骨架屏收起、错误可见', async () => {
  const h = makeHistoryController();
  h.pages.push({ page: pageOf('KEEP-ME') });
  await h.controller.openSession({ path: 'C:/sessions/reload-fail', sessionId: 'sess-rlf' });
  await waitFor(() => textOf(h.transcript).includes('KEEP-ME'), '首屏历史');

  h.pages.push({ fail: true, status: 500, message: '重载失败' });
  await h.controller.loadHistory();
  await waitFor(() => /重载失败/.test(textOf(h.transcript)), '重载失败文案');

  assert.ok(textOf(h.transcript).includes('KEEP-ME'), '重载失败不能动已渲染的历史');
  assert.equal(h.skeleton.hidden, true, '重载失败也要收起骨架屏');
});

await t('新建会话带上宿主思考档位（会话级设置，不带就落回默认）', async () => {
  const { controller, created } = makeController();

  controller.newSession('home', { thinkingLevel: 'max' });
  await delay(20);

  assert.equal(created[0].thinkingLevel, 'max', '档位必须随请求发给宿主');
});

await t('没拿到档位时不带这个字段，不编造默认值', async () => {
  const { controller, created } = makeController();

  controller.newSession('home', { thinkingLevel: '' });
  await delay(20);

  assert.equal('thinkingLevel' in created[0], false, '读不到档位就不该写字段');
});

/* ------------------------------------------------------------------ */
/* E2：每个会话的阅读位置                                            */
/* ------------------------------------------------------------------ */

/** 只关心内存读数的记忆实例：节流定时器永不触发，避免用例真等 400ms。 */
function makeScrollMemory() {
  return createScrollMemory({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    now: () => 1_000_000,
    schedule: () => ({ id: 'timer' }),
    cancelSchedule: () => {},
  });
}

function memoryWith(entries) {
  const memory = makeScrollMemory();
  for (const [key, position] of Object.entries(entries)) memory.remember(key, position);
  return memory;
}

await t('打开会话：有阅读位置就恢复到保存处，不强制贴底', async () => {
  const memory = memoryWith({
    'C:/sessions/mem-a': { scrollTop: 1200, scrollHeight: 3000, clientHeight: 600 },
  });
  const h = makeHistoryController({ scrollMemory: memory });
  h.transcript.clientHeight = 600;
  h.transcript.scrollHeight = 3000;
  h.pages.push({ page: pageOf('MEM-A') });

  await h.controller.openSession({ path: 'C:/sessions/mem-a', sessionId: 'sess-mem-a' });
  await waitFor(() => textOf(h.transcript).includes('MEM-A'), '历史');

  assert.equal(h.transcript.scrollTop, 1200, '必须回到用户上次读到的地方');
  assert.deepEqual(h.scrollCalls, [], '有阅读位置时不能再强制贴底');
});

await t('打开会话：没有阅读位置时照旧贴底', async () => {
  const h = makeHistoryController({ scrollMemory: makeScrollMemory() });
  h.transcript.clientHeight = 600;
  h.transcript.scrollHeight = 3000;
  h.pages.push({ page: pageOf('FRESH') });

  await h.controller.openSession({ path: 'C:/sessions/fresh', sessionId: 'sess-fresh' });

  assert.deepEqual(h.scrollCalls, [true], '没见过的会话维持原来的强制贴底');
});

await t('阅读位置记的是「当时贴底」：打开后仍要贴底', async () => {
  const memory = memoryWith({
    'C:/sessions/mem-bottom': { scrollTop: 2400, scrollHeight: 3000, clientHeight: 600 },
  });
  const h = makeHistoryController({ scrollMemory: memory });
  h.transcript.clientHeight = 600;
  h.transcript.scrollHeight = 3000;
  h.pages.push({ page: pageOf('MEM-BOTTOM') });

  await h.controller.openSession({ path: 'C:/sessions/mem-bottom', sessionId: 'sess-mem-bottom' });

  assert.deepEqual(h.scrollCalls, [true], 'atBottom=true 的记忆不能让会话停在半路');
});

await t('保存位置超出当前页高度：收敛到当前最大滚动距离', async () => {
  const memory = memoryWith({
    'C:/sessions/mem-clamp': { scrollTop: 5000, scrollHeight: 12000, clientHeight: 600 },
  });
  const h = makeHistoryController({ scrollMemory: memory });
  h.transcript.clientHeight = 600;
  h.transcript.scrollHeight = 3000;
  h.pages.push({ page: pageOf('MEM-CLAMP') });

  await h.controller.openSession({ path: 'C:/sessions/mem-clamp', sessionId: 'sess-mem-clamp' });

  assert.equal(h.transcript.scrollTop, 2400, '不能把 scrollTop 设到 maxScroll 之外');
  assert.deepEqual(h.scrollCalls, [], '仍然不算「贴底」，不要另滚一次');
});

await t('切到别的会话前：先记住当前会话读到哪儿', async () => {
  const memory = makeScrollMemory();
  const h = makeHistoryController({ scrollMemory: memory });
  h.pages.push({ page: pageOf('SW-A') });
  await h.controller.openSession({ path: 'C:/sessions/sw-a', sessionId: 'sess-sw-a' });
  await waitFor(() => textOf(h.transcript).includes('SW-A'), 'A 的历史');

  h.transcript.scrollHeight = 4000;
  h.transcript.clientHeight = 600;
  h.transcript.scrollTop = 700;

  h.pages.push({ page: pageOf('SW-B') });
  await h.controller.openSession({ path: 'C:/sessions/sw-b', sessionId: 'sess-sw-b' });

  const saved = memory.recall('C:/sessions/sw-a');
  assert.ok(saved, '切走前必须记下上一个会话的位置');
  assert.equal(saved.scrollTop, 700);
  assert.equal(saved.atBottom, false);
});

await t('退回列表：记住当前阅读位置', async () => {
  const memory = makeScrollMemory();
  const h = makeHistoryController({ scrollMemory: memory, inChat: true });
  h.pages.push({ page: pageOf('BACK-A') });
  await h.controller.openSession({ path: 'C:/sessions/back-a', sessionId: 'sess-back-a' });

  h.transcript.scrollHeight = 2000;
  h.transcript.clientHeight = 600;
  h.transcript.scrollTop = 500;

  assert.equal(h.controller.backToList(), true, '在聊天视图里返回应该被吃掉');
  assert.equal(h.state.session, null);
  const saved = memory.recall('C:/sessions/back-a');
  assert.ok(saved, '退回列表也要留下阅读位置');
  assert.equal(saved.scrollTop, 500);
});

await t('退出登录 / reset：整份阅读记忆清空', async () => {
  const memory = memoryWith({
    'C:/sessions/x': { scrollTop: 100, scrollHeight: 1000, clientHeight: 600 },
    'C:/sessions/y': { scrollTop: 200, scrollHeight: 1000, clientHeight: 600 },
  });
  const h = makeHistoryController({ scrollMemory: memory });

  h.controller.reset();

  assert.deepEqual(memory.list(), [], '换身份不能把上一个账号的阅读位置留给下一个');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
