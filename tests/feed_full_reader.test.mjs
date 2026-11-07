/* 日报完整阅读层契约测试
 *
 * 三段互相独立的约定，全部用假 api / 假 DOM，不开浏览器、不请求网络：
 * 1. client.card(itemId, revision, { template, isCurrent })：
 *    documentPath 缺失且 template=automation-digest 时，用宿主规范 cardId 校验绑定，
 *    再经 GET /api/cards/:cardId/mobile-document-chunk 逐片拼出完整 html；
 *    片边界（ok/offset/length/data.length/稳定总长/eof/前进）与总量上限都必须严格。
 *    其他模板继续明确「没有网页正文」，不把摘要当正文。
 * 2. cards.render(item, { mode:'reader' })：阅读上下文用真实可用高度、folio 加
 *    #feed-mode=open、native 只进 sandbox=allow-scripts 的 srcdoc（head 最先 CSP +
 *    expanded hash），native 内联文档 onload 且仍属当前 attempt 才算 ready；
 *    列表上下文不为 native 模板铸卡/取正文。
 * 3. view：标题按钮与「阅读全文」都能打开唯一阅读层，返回顺序提问→阅读层→日报，
 *    列表 DOM 与滚动位置保留，继续聊回到同一条目的原编辑器，版本漂移/条目消失释放旧层。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createFeedClient } from '../web/feed/client.js';
import { createFeedCards } from '../web/feed/cards.js';
import { createFeedView } from '../web/feed/view.js';
import { createFeedFeature } from '../web/features/feed.js';

const ID_A = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_B = 'fi_ZYXWVTSRQPNMKJHGFEDCBA9876';
const IDENTITY = { ownerId: 'owner-1', deviceId: 'dev-1', clientKind: 'mobile' };
const ISO = '2026-11-06T09:00:00.000Z';
const DIGEST_TEMPLATE = 'automation-digest';
const CHUNK_PATH = (cardId) => `/api/cards/${cardId}/mobile-document-chunk`;
const NATIVE_CARD_ID = (itemId, revision) => `feed-${itemId}-r${revision}`;

let bad = 0;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) await tick();
};

function makeItem(itemId, extra = {}) {
  return {
    itemId,
    revision: 1,
    lane: 'content',
    laneKind: 'content',
    template: 'folio-card',
    title: `标题-${itemId.slice(-1)}`,
    ask: '要跟进这件事吗？',
    topics: ['工作'],
    source: { sourceId: 'src-1', displayName: '日报助手' },
    createdAt: ISO,
    unread: true,
    favorite: false,
    ...extra,
  };
}

function snapshot(items, extra = {}) {
  return {
    open: true,
    loading: false,
    loadingMore: false,
    error: null,
    items,
    cursor: null,
    slateId: 'slate-1',
    unreadTaskCount: 0,
    nextPatrolAt: null,
    lane: 'all',
    pendingIds: [],
    ...extra,
  };
}

function fakeApi(handler) {
  const calls = [];
  const api = async (pathname, init = {}) => {
    calls.push({ pathname, init, index: calls.length - 1 });
    return handler({ pathname, init, index: calls.length - 1 });
  };
  api.calls = calls;
  return api;
}

async function caught(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('期望抛出异常，但没有');
}

/* ---- 原生文档分片 ---- */

const DOC_PARTS = [
  '<!doctype html><html><head><title>假原生日报</title></head><body><main>',
  '第一段正文'.repeat(40),
  '<p id="tail">尾段哨兵</p></main></body></html>',
];

/** 按需发片的假宿主：card 响应固定，分片按请求偏移切片，overrides 按分片序号覆盖字段。 */
function chunkApi({ cardResponse, text = DOC_PARTS.join(''), chunkSize = 32 * 1024, overrides = {} } = {}) {
  let chunkIndex = 0;
  return fakeApi(({ pathname }) => {
    if (pathname.startsWith('/api/feed/items/') && pathname.endsWith('/card')) return cardResponse;
    if (pathname.startsWith('/api/cards/') && pathname.includes('/mobile-document-chunk')) {
      const offset = Number(new URL(`http://local${pathname}`).searchParams.get('offset'));
      const index = chunkIndex;
      chunkIndex += 1;
      const length = Math.min(chunkSize, text.length - offset);
      const base = {
        ok: true,
        offset,
        length,
        totalChars: text.length,
        eof: offset + length >= text.length,
        data: text.slice(offset, offset + length),
      };
      const override = overrides[index];
      return override ? { ...base, ...override } : base;
    }
    throw new Error(`unexpected fake api path: ${pathname}`);
  });
}

t('client.card：native 无 documentPath 时按规范 cardId 分片拼出完整 html', async () => {
  const api = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 3), revision: 3 },
    chunkSize: 30,
  });
  const card = await createFeedClient({ api }).card(ID_A, 3, { template: DIGEST_TEMPLATE });

  assert.equal(api.calls[0].pathname, `/api/feed/items/${ID_A}/card`);
  assert.equal(api.calls[0].init.method, 'POST');
  const chunkCalls = api.calls.slice(1);
  assert.ok(chunkCalls.length >= 3, '应按片请求直到 eof');
  assert.equal(chunkCalls[0].pathname, `${CHUNK_PATH(NATIVE_CARD_ID(ID_A, 3))}?offset=0`);
  assert.equal(chunkCalls[0].init.method, undefined, '分片是 GET，不带方法体');
  assert.equal(card.cardId, NATIVE_CARD_ID(ID_A, 3));
  assert.equal(card.revision, 3);
  assert.equal(card.url, null, 'native 文档没有可导航 URL');
  assert.equal(card.html, DOC_PARTS.join(''), '必须拼出完整正文，不能少一段');
  assert.ok(card.html.includes('尾段哨兵'), '尾部内容必须包含在拼出的文档里');
  const offsets = chunkCalls.map((call) => Number(new URL(`http://local${call.pathname}`).searchParams.get('offset')));
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b), '偏移必须单调前进');
  assert.equal(new Set(offsets).size, offsets.length, '不得重复请求同一偏移');
});

t('client.card：cardId 与 feed-<itemId>-r<revision> 不匹配时拒绝且不请求分片', async () => {
  const api = chunkApi({ cardResponse: { cardId: 'card-other', revision: 3 } });
  const err = await caught(() =>
    createFeedClient({ api }).card(ID_A, 3, { template: DIGEST_TEMPLATE }),
  );
  assert.equal(err.code, 'feed_card_binding_mismatch');
  assert.equal(api.calls.length, 1, '绑定不成立时不得读取任何分片');
});

t('client.card：其他模板无 documentPath 仍然明确没有网页正文，不读分片', async () => {
  const api = chunkApi({ cardResponse: { cardId: 'card-9', revision: 3 } });
  const other = await createFeedClient({ api }).card(ID_A, 3, { template: 'plain-note' });
  assert.deepEqual(other, { cardId: 'card-9', revision: 3, url: null });
  assert.equal('html' in other, false);
  const omitted = await createFeedClient({ api }).card(ID_A, 3);
  assert.deepEqual(omitted, { cardId: 'card-9', revision: 3, url: null });
  assert.equal(api.calls.length, 2, '只有两次铸造请求');
});

t('client.card：分片 ok/offset/length/长漂移/eof/前进的坏片一律报错', async () => {
  const cases = [
    ['ok=false', { 0: { ok: false } }, 'feed_card_document_unavailable'],
    ['offset 不是请求偏移', { 1: { offset: 0 } }, 'feed_card_document_offset_mismatch'],
    ['length 与 data 长度不符', { 1: { length: 3, data: 'ab' } }, 'feed_card_document_length_mismatch'],
    ['length 超过宿主单片上限', { 1: { length: 40000, data: 'x'.repeat(40000) } }, 'feed_card_document_chunk_too_large'],
    ['总长漂移', { 1: { totalChars: 999999 } }, 'feed_card_document_total_changed'],
    ['eof 与偏移不符', { 0: { eof: true } }, 'feed_card_document_eof_mismatch'],
    ['空片不前进', { 1: { length: 0, data: '', eof: false } }, 'feed_card_document_no_progress'],
    ['越过总长', { 1: { length: 999999, data: 'y'.repeat(999999), totalChars: 10 } }, 'feed_card_document_chunk_too_large'],
    ['data 不是字符串', { 1: { data: 42 } }, 'feed_card_document_length_mismatch'],
    ['eof 不是布尔', { 1: { eof: 'yes' } }, 'feed_card_document_eof_mismatch'],
  ];

  for (const [label, overrides, expected] of cases) {
    const api = chunkApi({
      cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1 },
      chunkSize: 10,
      overrides,
    });
    const err = await caught(() =>
      createFeedClient({ api }).card(ID_A, 1, { template: DIGEST_TEMPLATE }),
    );
    assert.equal(err.code, expected, `${label} 应报 ${expected}，实际 ${err.code}`);
  }
});

t('client.card：2MiB 总量与 64 片上限都有明确边界', async () => {
  const bigTotal = 3 * 1024 * 1024;
  const bigApi = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1 },
    text: 'x'.repeat(bigTotal),
    chunkSize: 32 * 1024,
  });
  const bigErr = await caught(() =>
    createFeedClient({ api: bigApi }).card(ID_A, 1, { template: DIGEST_TEMPLATE }),
  );
  assert.equal(bigErr.code, 'feed_card_document_too_large');
  assert.equal(bigApi.calls.length, 2, '超过总量上限时第一片就停，不继续拉');

  const manyApi = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1 },
    text: 'y'.repeat(200),
    chunkSize: 1,
  });
  const manyErr = await caught(() =>
    createFeedClient({ api: manyApi }).card(ID_A, 1, { template: DIGEST_TEMPLATE }),
  );
  assert.equal(manyErr.code, 'feed_card_document_too_many_chunks');
  assert.equal(manyApi.calls.length, 65, '最多 64 次分片请求（另加一次铸造）');
});

t('client.card：恰好 2MiB / 64 片是合法上限，能完整拼出', async () => {
  const total = 2 * 1024 * 1024;
  const text = 'x'.repeat(total);
  const api = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1 },
    text,
    chunkSize: 32 * 1024,
  });
  const card = await createFeedClient({ api }).card(ID_A, 1, { template: DIGEST_TEMPLATE });
  assert.equal(card.html.length, total, '恰好 2MiB 的正文必须能拼完整');
  assert.equal(api.calls.length, 1 + 64, '恰好 64 片分片请求（加一次铸造）');
  assert.equal(card.html[0], 'x');
  assert.equal(card.html[total - 1], 'x');
});

t('client.card：isCurrent 变假后在下一片前停下，不再发请求', async () => {
  let current = true;
  const api = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1 },
    text: 'z'.repeat(100),
    chunkSize: 10,
  });
  const err = await caught(async () => {
    const card = createFeedClient({ api }).card(ID_A, 1, {
      template: DIGEST_TEMPLATE,
      isCurrent: () => {
        // 第一片返回后立刻失效，模拟关闭/超时/切换条目。
        const value = current;
        current = false;
        return value;
      },
    });
    await card;
  });
  assert.equal(err.code, 'feed_card_document_cancelled');
  assert.equal(api.calls.length, 2, '失效后只保留铸造与第一片');
});

t('client.card：documentPath 存在时仍走 folio URL，不读分片', async () => {
  const api = chunkApi({
    cardResponse: { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1, documentPath: 'C:/private/index.html' },
  });
  const card = await createFeedClient({ api }).card(ID_A, 1, { template: DIGEST_TEMPLATE });
  assert.deepEqual(card, { cardId: NATIVE_CARD_ID(ID_A, 1), revision: 1, url: `/gw/feed/${ID_A}/r1/` });
  assert.equal('html' in card, false);
  assert.equal(api.calls.length, 1);
});

/* ---- cards：阅读上下文 ---- */

function setupCards({ timeoutMs = 25, ioClass, clock = null, prepare } = {}) {
  const h = createHarness({ debug: false });
  // 假 DOM 没有原生 iframe.contentWindow：补一个只在进入文档后存在的 WindowProxy，
  // 让高度消息的来源校验走真实代码路径。
  const createElement = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const node = createElement(tag);
    if (String(tag).toLowerCase() === 'iframe') {
      let contentWindow = null;
      Object.defineProperty(node, 'contentWindow', {
        configurable: true,
        get() {
          if (!node.parentNode) return null;
          if (!contentWindow) contentWindow = { postMessage() {} };
          return contentWindow;
        },
      });
    }
    return node;
  };

  const ioInstances = [];
  class FakeIO {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      this.disconnected = false;
      ioInstances.push(this);
    }

    observe(element) { this.observed.add(element); }

    unobserve(element) { this.observed.delete(element); }

    disconnect() { this.observed.clear(); this.disconnected = true; }

    fire(entries) {
      this.callback(entries.map(([target, ratio]) => ({
        target,
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
      })));
    }
  }

  const prepares = [];
  let prepImpl = prepare || ((item) => ({
    cardId: 'card-1',
    revision: item.revision,
    url: `/gw/feed/${item.itemId}/r${item.revision}/`,
  }));
  const errors = [];
  const ready = [];
  const observed = [];
  const unobserved = [];
  const readTracker = {
    observe(element, item, context) { observed.push({ element, item, context }); },
    unobserve(element) { unobserved.push(element); },
    markReady(itemId, revision) { ready.push([itemId, revision]); },
    setActive() {},
    reset() {},
    destroy() {},
  };

  const Observer = ioClass === undefined ? FakeIO : ioClass;
  const options = {
    document: h.doc,
    window: h.window,
    prepareCard: (item, prepareOptions) => {
      prepares.push({ item, options: prepareOptions });
      return prepImpl(item, prepareOptions);
    },
    readTracker,
    getIdentity: () => IDENTITY,
    onError: (err) => errors.push(err),
    timeoutMs,
  };
  if (Observer !== undefined) options.IntersectionObserver = Observer;
  if (clock) {
    options.setTimeout = clock.setTimeout;
    options.clearTimeout = clock.clearTimeout;
  }
  const cards = createFeedCards(options);

  return {
    h,
    cards,
    prepares,
    errors,
    ready,
    observed,
    unobserved,
    ioInstances,
    lastIO: () => ioInstances[ioInstances.length - 1],
    setPrepare: (fn) => { prepImpl = fn; },
  };
}

function createTimeoutClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue;
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

/**
 * 阅读层容器：高度由 CSS 100% 链决定，这里不给 clientHeight，
 * 用来证明卡片不再依赖父容器像素测量。
 */
function mountReaderCard(s, item) {
  const host = s.h.doc.createElement('div');
  host.className = 'feed-reader-body';
  s.h.doc.body.appendChild(host);
  const node = s.cards.render(item, { mode: 'reader', slateId: 'slate-1', position: 0 });
  host.appendChild(node);
  return { host, node };
}

/** 从注入脚本里取出本轮 ready token（产品用同一行声明）。 */
function readerToken(srcdoc) {
  const match = /__hanaReaderToken = "([^"]+)"/.exec(String(srcdoc || ''));
  assert.ok(match, 'srcdoc 必须带本轮 ready token');
  return match[1];
}

t('cards 阅读层：folio 用 CSS 高度链 + #feed-mode=open，收到可信高度才算 ready 且不被拉长', async () => {
  const clock = createTimeoutClock();
  const s = setupCards({ timeoutMs: 5000, clock });
  const item = makeItem(ID_A);
  const { node } = mountReaderCard(s, item);
  await settle();

  const frame = s.h.find(node, '.feed-card-frame');
  assert.ok(frame, '阅读层应立刻挂 iframe，不等 IntersectionObserver');
  assert.equal(s.prepares.length, 1);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(String(frame.getAttribute('sandbox')).includes('allow-same-origin'), false);
  assert.equal(frame.src, `/gw/feed/${ID_A}/r1/#feed-mode=open`, 'folio 阅读层必须带宿主展开 hash');
  assert.equal(frame.style.height, '100%', 'iframe 走 100% 高度链，不再算一次像素高度');
  assert.equal(frame.style.visibility, 'visible', '阅读层 iframe 不必等高度消息才可见');
  assert.equal(s.ready.length, 0, 'folio 仍要等受信任高度消息');

  s.h.fireWindow('message', { data: { __hanaCardHeight: 2400 }, source: frame.contentWindow });
  assert.equal(frame.style.height, '100%', '阅读层不把 iframe 拉成长文高度');
  assert.deepEqual(s.ready, [[ID_A, 1]]);

  s.h.fireWindow('message', { data: { __hanaCardHeight: 2400 }, source: { stranger: true } });
  assert.equal(s.ready.length, 1, '陌生来源的高度不能算 ready');
  s.cards.destroy();
});

t('cards 阅读层：native 只进 srcdoc，CSP + expanded hash 在前，且要本次加载 token 握手才算 ready', async () => {
  const nativeHtml = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>原生日报</title>',
    '<style>.digest-full{display:none}</style>',
    '<script>window.__hostDigestRan = true;<\/script>',
    '</head><body><main><p>摘要</p><div class="digest-full">完整正文</div></main></body></html>',
  ].join('');
  const s = setupCards({
    timeoutMs: 5000,
    clock: createTimeoutClock(),
    prepare: (item) => ({ cardId: NATIVE_CARD_ID(item.itemId, item.revision), revision: item.revision, url: null, html: nativeHtml }),
  });
  const item = makeItem(ID_A, { template: DIGEST_TEMPLATE });
  const { node } = mountReaderCard(s, item);
  await settle();

  const frame = s.h.find(node, '.feed-card-frame');
  assert.ok(frame, 'native 阅读层应挂 iframe');
  assert.equal(frame.src, '', 'native 不设置可导航 src');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.style.height, '100%');
  const srcdoc = frame.getAttribute('srcdoc');
  assert.equal(typeof srcdoc, 'string');
  assert.ok(srcdoc.includes('<!doctype html'), 'srcdoc 就是完整宿主文档');
  assert.equal(s.h.findAll(s.h.doc.body, '.digest-full').length, 0, '宿主文档不得进入父 DOM');

  const headIndex = srcdoc.toLowerCase().indexOf('<head');
  const cspIndex = srcdoc.indexOf('Content-Security-Policy');
  assert.ok(headIndex >= 0 && cspIndex > headIndex, 'CSP 必须插在 head 里');
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
  ]) {
    assert.ok(srcdoc.includes(directive), `CSP 缺少 ${directive}`);
  }
  const hashIndex = srcdoc.indexOf("location.hash='digest-view=expanded'");
  const hostScriptIndex = srcdoc.indexOf('__hostDigestRan');
  assert.ok(hashIndex > cspIndex, 'expanded hash 初始化必须在 CSP 之后');
  assert.ok(hostScriptIndex > hashIndex, '宿主文档脚本必须在 hash 初始化之后才运行');

  const token = readerToken(srcdoc);
  assert.equal(s.ready.length, 0, 'native 未收到本次 token 前不算 ready');

  // 初始空白 load（以及任何 load）都不能直接 ready 或清超时。
  frame.dispatchEvent('load');
  assert.equal(s.ready.length, 0, '拿到 load 不等于拿到目标文档的布局确认');

  s.h.fireWindow('message', { data: { __hanaReaderReady: 'not-this-load' }, source: frame.contentWindow });
  assert.equal(s.ready.length, 0, '其他加载的 token 无效');

  s.h.fireWindow('message', { data: { __hanaReaderReady: token }, source: { stranger: true } });
  assert.equal(s.ready.length, 0, '陌生来源的确认无效');

  s.h.fireWindow('message', { data: { __hanaReaderReady: token }, source: frame.contentWindow });
  assert.deepEqual(s.ready, [[ID_A, 1]]);

  // 关闭后旧 token/旧 source 都不能复活旧卡片。
  s.cards.reset();
  s.h.fireWindow('message', { data: { __hanaReaderReady: token }, source: frame.contentWindow });
  assert.equal(s.ready.length, 1);
  s.cards.destroy();
});

t('cards 阅读层：native 未收到 token 前超时移除并可重试', async () => {
  const clock = createTimeoutClock();
  const s = setupCards({
    timeoutMs: 15,
    clock,
    prepare: (item) => ({ cardId: NATIVE_CARD_ID(item.itemId, item.revision), revision: item.revision, url: null, html: '<html><head></head><body>正文</body></html>' }),
  });
  const item = makeItem(ID_A, { template: DIGEST_TEMPLATE });
  const { node } = mountReaderCard(s, item);
  await settle();
  const frame = s.h.find(node, '.feed-card-frame');
  assert.ok(frame);

  // 光有 load 不算 ready，超时照常计时。
  frame.dispatchEvent('load');
  clock.advance(15);
  await settle();
  assert.equal(s.h.find(node, '.feed-card-frame'), null, 'native 未确认就绪，超时后移除 iframe');
  assert.equal(s.h.find(node, '.feed-card-error').textContent.includes('超时'), true);
  assert.equal(s.errors.at(-1).code, 'feed_card_height_timeout');

  s.h.find(node, '.feed-card-retry').click();
  await settle();
  const retryFrame = s.h.find(node, '.feed-card-frame');
  assert.ok(retryFrame, '用户点重试可重新挂载');
  const retryToken = readerToken(retryFrame.getAttribute('srcdoc'));
  s.h.fireWindow('message', { data: { __hanaReaderReady: retryToken }, source: retryFrame.contentWindow });
  assert.equal(s.ready.length, 1);
  s.cards.destroy();
});

t('cards 阅读层：prepareCard 拿到 isCurrent，释放/reset 后变假', async () => {
  let captured = null;
  // 用可控时钟：这个用例故意让准备 Promise 永不落地，不能被真实 25ms 超时抢先。
  const clock = createTimeoutClock();
  const s = setupCards({
    timeoutMs: 5000,
    clock,
    prepare: (item, options) => {
      captured = options;
      return new Promise(() => {});
    },
  });
  const item = makeItem(ID_A);
  const { node } = mountReaderCard(s, item);
  await settle();
  assert.equal(typeof captured?.isCurrent, 'function');
  assert.equal(captured.isCurrent(), true);

  s.cards.release(node);
  assert.equal(captured.isCurrent(), false, '释放后后续分片必须停止');

  const second = mountReaderCard(s, makeItem(ID_A, { revision: 2 })).node;
  await settle();
  const beforeReset = captured;
  assert.equal(beforeReset.isCurrent(), true);
  s.cards.reset();
  assert.equal(beforeReset.isCurrent(), false, 'reset 后归属失效');
  s.cards.destroy();
});

t('cards 列表：native 模板不铸卡、不取正文，只提示用阅读全文', async () => {
  const s = setupCards();
  const item = makeItem(ID_A, { template: DIGEST_TEMPLATE });
  const node = s.cards.render(item, { slateId: 'slate-1', position: 0 });
  s.h.doc.body.appendChild(node);

  assert.equal(s.prepares.length, 0, '列表不得为 native 模板铸造卡片');
  assert.equal(s.h.find(node, '.feed-card-frame'), null);
  assert.equal(s.h.findAll(s.h.doc.body, '.digest-full').length, 0);
  const note = s.h.find(node, '.feed-card-note');
  assert.ok(note, '列表应给出阅读全文提示，而不是空白或错误');
  assert.equal(note.textContent.includes('阅读全文'), true);
  assert.equal(s.observed.length, 0, '只有标题的列表行不进入阅读计时');
  s.cards.destroy();
});

t('cards 阅读层：释放先把 srcdoc 摘掉再 about:blank 并移除', async () => {
  const s = setupCards({
    timeoutMs: 5000,
    clock: createTimeoutClock(),
    prepare: (item) => ({ cardId: NATIVE_CARD_ID(item.itemId, item.revision), revision: item.revision, url: null, html: '<html><head></head><body>x</body></html>' }),
  });
  const item = makeItem(ID_A, { template: DIGEST_TEMPLATE });
  const { node } = mountReaderCard(s, item);
  await settle();
  const frame = s.h.find(node, '.feed-card-frame');
  assert.ok(frame.getAttribute('srcdoc'), 'native 阅读层把文档写进 srcdoc');

  s.cards.release(node);
  assert.equal(frame.getAttribute('srcdoc'), null, '释放时先移除 srcdoc');
  assert.equal(frame.src, 'about:blank');
  assert.equal(frame.parentNode, null, 'iframe 从 DOM 脱离');
  s.cards.destroy();
});

t('cards 阅读层：宿主没有正文时明确报不可用，不挂半截 iframe', async () => {
  const s = setupCards({
    timeoutMs: 5000,
    clock: createTimeoutClock(),
    prepare: (item) => ({ cardId: 'card-x', revision: item.revision, url: null }),
  });
  const item = makeItem(ID_A, { template: 'plain-note' });
  const { node } = mountReaderCard(s, item);
  await settle();

  assert.equal(s.h.find(node, '.feed-card-frame'), null, '没有正文就不挂 iframe');
  const error = s.h.find(node, '.feed-card-error');
  assert.ok(error);
  assert.equal(error.textContent.includes('正文'), true);
  assert.equal(s.errors.at(-1).code, 'feed_card_unavailable');
  assert.ok(s.h.find(node, '.feed-card-retry'), '失败可手动重试');
  s.cards.destroy();
});

t('cards 阅读层：同 itemId+revision 重开不复用已失效的准备归属', async () => {
  const gates = [];
  const s = setupCards({
    timeoutMs: 5000,
    clock: createTimeoutClock(),
    prepare: (item, options) => new Promise((resolve) => {
      gates.push({ item, options, resolve });
    }),
  });
  const item = makeItem(ID_A, { template: DIGEST_TEMPLATE });
  const first = mountReaderCard(s, item);
  await settle();
  assert.equal(gates.length, 1);
  const firstOptions = gates[0].options;
  assert.equal(firstOptions.isCurrent(), true);

  s.cards.release(first.node);
  assert.equal(firstOptions.isCurrent(), false, '释放后旧归属失效');

  const second = mountReaderCard(s, item);
  await settle();
  assert.equal(gates.length, 2, '同 key 重开必须新发准备请求，不能共享失效归属');
  assert.notEqual(gates[1].options, firstOptions);
  assert.equal(gates[1].options.isCurrent(), true, '新请求的归属必须是新的');

  // 旧响应迟到：不挂任何节点，也不能删掉新请求的 inflight。
  gates[0].resolve({ cardId: 'old', revision: 1, url: null, html: '<html><head></head><body>old</body></html>' });
  await settle();
  assert.equal(s.h.find(first.node, '.feed-card-frame'), null, '旧响应不能挂回已释放节点');
  assert.equal(s.h.find(second.node, '.feed-card-frame'), null, '旧响应不能冒充新请求结果');

  gates[1].resolve({ cardId: 'new', revision: 1, url: null, html: '<html><head></head><body>new</body></html>' });
  await settle();
  const frame = s.h.find(second.node, '.feed-card-frame');
  assert.ok(frame, '新请求独立成功挂载');
  assert.equal(String(frame.getAttribute('srcdoc')).includes('new'), true);
  assert.equal(s.prepares.length, 2);
  s.cards.destroy();
});

/* ---- view：阅读层 ---- */

function setupView() {
  const h = createHarness({ debug: false });
  const actions = [];
  const cardCalls = [];
  const releaseCalls = [];
  const view = createFeedView({
    document: h.doc,
    onAction: (action) => actions.push(action),
    releaseCard: (node) => releaseCalls.push(node),
    renderCard: (item, context) => {
      cardCalls.push({ item, context });
      const node = h.makeNode('div');
      node.className = context?.mode === 'reader' ? 'fake-reader-card' : 'fake-card';
      node.dataset.itemId = item.itemId;
      node.textContent = `${context?.mode === 'reader' ? 'reader' : 'card'}:${item.itemId}:${item.revision}`;
      return node;
    },
  });
  return { h, view, actions, cardCalls, releaseCalls };
}

const panelOf = (h) => h.find(h.doc.body, '.feed-view');
const rowOf = (h, itemId) => h.findAll(h.doc.body, '.feed-item').find((row) => row.dataset.itemId === itemId);
const readerOf = (h) => h.find(panelOf(h), '.feed-reader');

t('view：标题是可访问按钮，真实点击打开唯一阅读层，列表 DOM 与滚动位置保留', () => {
  const { h, view, actions, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  const body = h.find(panelOf(h), '.feed-body');
  body.scrollTop = 180;
  const rowBefore = rowOf(h, ID_A);
  const title = h.find(rowBefore, '.feed-item-title');
  const titleButton = h.find(rowBefore, '.feed-item-title-btn');
  assert.ok(titleButton, '标题必须是按钮，才能点开全文');
  assert.equal(titleButton.tagName, 'BUTTON');
  assert.equal(titleButton.getAttribute('aria-label').includes('阅读全文'), true);
  assert.equal(title.textContent, '标题-S', '原标题文本不变');

  cardCalls.length = 0;
  actions.length = 0;
  titleButton.click();
  assert.equal(readerOf(h).hidden, false, '阅读层必须打开');
  assert.equal(actions.length, 0, '打开阅读层不派发动作');
  assert.deepEqual(cardCalls.map((entry) => entry.context.mode), ['reader']);
  assert.deepEqual(cardCalls[0].context.slateId, 'slate-1');
  assert.equal(h.find(readerOf(h), '.feed-reader-body .fake-reader-card').textContent, `reader:${ID_A}:1`);
  assert.equal(h.findAll(panelOf(h), '.feed-reader iframe').length, 0, '假卡片不产生 iframe');
  assert.equal(h.findAll(panelOf(h), '.feed-item').length, 2, '列表 DOM 不被重建');
  assert.equal(rowOf(h, ID_A), rowBefore, '行节点保持不变');
  assert.equal(body.scrollTop, 180, '打开阅读层不动列表滚动位置');
  view.destroy();
});

t('view：阅读全文按钮同样打开；收藏/隐藏/少推/继续聊不误开阅读层', () => {
  const { h, view, actions, cardCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  const row = rowOf(h, ID_A);
  cardCalls.length = 0;
  // 阅读层是惰性建的：没打开之前根本不应该存在，也不应该有阅读上下文渲染。
  const readerVisible = () => Boolean(readerOf(h)) && readerOf(h).hidden === false;

  h.find(row, '.feed-favorite').click();
  h.find(row, '.feed-hide').click();
  h.find(row, '.feed-less-like').click();
  h.find(row, '.feed-ask-open').click();
  assert.equal(readerVisible(), false, '普通操作不得打开阅读层');
  assert.equal(cardCalls.length, 0);

  h.find(row, '.feed-read').click();
  assert.equal(readerVisible(), true, '阅读全文按钮打开阅读层');
  assert.equal(cardCalls.length, 1);
  assert.equal(cardCalls[0].context.mode, 'reader');
  assert.equal(actions.map((action) => action.type).join(','), 'favorite,hide,less-like');
  view.destroy();
});

t('view：返回顺序是提问编辑 → 阅读层 → 日报', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  assert.equal(readerOf(h).hidden, false);

  actions.length = 0;
  view.back();
  assert.equal(readerOf(h).hidden, true, '第一层返回只退阅读层');
  assert.equal(view.isOpen(), true, '日报仍然打开');
  assert.deepEqual(actions, [], '退阅读层不派发 close');

  view.back();
  assert.deepEqual(actions.map((action) => action.type), ['close']);
  assert.equal(view.isOpen(), false);
  view.destroy();
});

t('view：从阅读层返回时用 preventScroll 聚焦标题，不强制把列表卷回标题', () => {
  const { h, view } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  const row = rowOf(h, ID_B);
  const focusCalls = [];
  const titleButton = h.find(row, '.feed-item-title-btn');
  titleButton.focus = (options) => focusCalls.push(options);

  h.find(row, '.feed-read').click();
  assert.equal(readerOf(h).hidden, false);
  h.find(readerOf(h), '.feed-reader-back').click();

  assert.equal(readerOf(h).hidden, true);
  assert.deepEqual(focusCalls, [{ preventScroll: true }], '返回聚焦不得滚动列表');
  view.destroy();
});

t('view：阅读层继续聊回到同一条目的原编辑器，不自动发消息', () => {
  const { h, view, actions } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  h.find(rowOf(h, ID_B), '.feed-item-title-btn').click();
  assert.equal(readerOf(h).hidden, false);

  actions.length = 0;
  const ask = h.find(readerOf(h), '.feed-reader-ask');
  assert.ok(ask, '阅读层底部应有继续聊');
  ask.click();
  assert.equal(readerOf(h).hidden, true, '继续聊先回到列表');
  const question = h.find(rowOf(h, ID_B), '.feed-question');
  assert.equal(question.hidden, false, '打开同一条目原来的问题编辑');
  assert.equal(h.find(rowOf(h, ID_B), '.feed-question-input').value, '要跟进这件事吗？');
  assert.deepEqual(actions, [], '只打开编辑，不创建会话也不发送');

  h.find(rowOf(h, ID_B), '.feed-question-input').value = '这条怎么跟进？';
  h.find(rowOf(h, ID_B), '.feed-question-send').click();
  assert.deepEqual(actions, [{ type: 'ask', itemId: ID_B, text: '这条怎么跟进？' }]);
  view.destroy();
});

t('view：切换阅读条目释放旧阅读卡，只保留一个阅读层', () => {
  const { h, view, releaseCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  const firstReader = h.find(readerOf(h), '.fake-reader-card');
  h.find(rowOf(h, ID_B), '.feed-read').click();

  assert.equal(releaseCalls.includes(firstReader), true, '换条目必须释放旧阅读卡');
  assert.equal(h.findAll(panelOf(h), '.fake-reader-card').length, 1, '同时只有一个阅读层');
  assert.equal(h.find(readerOf(h), '.fake-reader-card').textContent, `reader:${ID_B}:1`);
  view.destroy();
});

t('view：同 revision 刷新保留阅读层；版本漂移或条目消失释放并提示', () => {
  const { h, view, cardCalls, releaseCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  const readerCard = h.find(readerOf(h), '.fake-reader-card');
  const readerCalls = cardCalls.filter((entry) => entry.context.mode === 'reader').length;

  view.render(snapshot([makeItem(ID_A), makeItem(ID_B)]));
  assert.equal(readerOf(h).hidden, false, '同 revision 刷新保留阅读层');
  assert.equal(h.find(readerOf(h), '.fake-reader-card'), readerCard, '不重建阅读 iframe');
  assert.equal(cardCalls.filter((entry) => entry.context.mode === 'reader').length, readerCalls);

  view.render(snapshot([makeItem(ID_A, { revision: 2 })]));
  assert.equal(readerOf(h).hidden, true, '版本漂移退出阅读层');
  assert.equal(releaseCalls.includes(readerCard), true);
  const notice = h.find(panelOf(h), '.feed-notice');
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent.includes('更新'), true, '明确提示不能拿旧版本继续');

  h.find(rowOf(h, ID_A), '.feed-read').click();
  const driftedCard = h.find(readerOf(h), '.fake-reader-card');
  view.render(snapshot([makeItem(ID_B)]));
  assert.equal(readerOf(h).hidden, true, '条目消失退出阅读层');
  assert.equal(releaseCalls.includes(driftedCard), true);
  assert.equal(h.find(panelOf(h), '.feed-notice').textContent.includes('不在列表'), true);
  view.destroy();
});

t('view：关闭与销毁都释放阅读层，迟到渲染不会挂回 DOM', () => {
  const { h, view, releaseCalls } = setupView();
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  const readerCard = h.find(readerOf(h), '.fake-reader-card');
  view.close();
  assert.equal(releaseCalls.includes(readerCard), true, '关闭日报释放阅读卡');
  assert.equal(h.findAll(h.doc.body, '.fake-reader-card').length, 0);

  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  const second = h.find(readerOf(h), '.fake-reader-card');
  view.destroy();
  assert.equal(releaseCalls.includes(second), true, 'destroy 释放阅读卡');
  assert.equal(panelOf(h), null);
});

t('view：阅读层渲染失败给出可读错误，不崩也不显示半截', () => {
  const h = createHarness({ debug: false });
  const view = createFeedView({
    document: h.doc,
    onAction: () => {},
    releaseCard: () => {},
    renderCard: (item, context) => {
      if (context?.mode === 'reader') throw new Error('阅读层加载失败');
      const node = h.makeNode('div');
      node.className = 'fake-card';
      return node;
    },
  });
  view.open();
  view.render(snapshot([makeItem(ID_A)]));
  h.find(rowOf(h, ID_A), '.feed-read').click();
  const error = h.find(readerOf(h), '.feed-reader-error');
  assert.ok(error, '阅读层失败要有错误提示');
  assert.equal(error.textContent.includes('阅读层加载失败'), true);
  assert.equal(h.findAll(readerOf(h), '.fake-reader-card').length, 0);
  view.destroy();
});

/* ---- feature 装配 ---- */

function setupFeature({ template = DIGEST_TEMPLATE, gateFirstChunk = false } = {}) {
  const h = createHarness({ debug: false });
  h.getEl('homeComposer').parentNode = null;
  h.getEl('homeComposerDock').appendChild(h.getEl('homeComposer'));
  const calls = { card: [], chunk: [], signals: [] };
  const item = makeItem(ID_A, { template });
  const nativeDoc = '<!doctype html><html><head></head><body><p id="tail">尾段</p></body></html>';
  const gates = [];
  const api = async (pathname, init = {}) => {
    const path = String(pathname);
    if (path.startsWith('/api/feed/slate?')) {
      return { slateId: 'slate-1', items: [item], unreadTaskCount: 0, cursor: null, nextPatrolAt: null };
    }
    if (path === `/api/feed/items/${ID_A}/card` && init.method === 'POST') {
      calls.card.push(path);
      return { cardId: NATIVE_CARD_ID(ID_A, item.revision), revision: item.revision };
    }
    if (path.startsWith(`/api/cards/${NATIVE_CARD_ID(ID_A, item.revision)}/mobile-document-chunk`)) {
      calls.chunk.push(path);
      const offset = Number(new URL(`http://local${path}`).searchParams.get('offset'));
      const data = nativeDoc.slice(offset, offset + 20);
      const body = {
        ok: true,
        offset,
        length: data.length,
        totalChars: nativeDoc.length,
        eof: offset + data.length >= nativeDoc.length,
        data,
      };
      // 需要时用一个 gate 把首片挂起，验证“旧请求迟到”。
      if (gateFirstChunk && calls.chunk.length === 1) {
        return new Promise((resolve) => {
          gates.push(() => resolve(body));
        });
      }
      return body;
    }
    if (path === '/api/feed/signals') {
      calls.signals.push(path);
      return { accepted: 2, unreadTaskCount: 0 };
    }
    throw new Error(`unexpected feature fake api: ${path}`);
  };
  const feature = createFeedFeature({
    api,
    document: h.doc,
    window: h.window,
    getIdentity: () => IDENTITY,
    getNavigationEpoch: () => 0,
    getSession: () => null,
    openSession: async () => {},
    sendPrepared: async () => ({ frameWritten: false, committed: false }),
  });
  return { h, feature, calls, item, gates };
}

t('feature：列表不取正文，打开阅读层后才按 template 取分片并挂 srcdoc', async () => {
  const { h, feature, calls } = setupFeature();
  await feature.open();
  await settle(4);
  assert.equal(h.findAll(h.doc.body, '.feed-item').length, 1);
  assert.equal(calls.card.length, 0, '列表阶段不得为 native 模板铸造卡片');
  assert.equal(calls.chunk.length, 0, '列表阶段零正文请求');

  h.find(h.doc.body, '.feed-read').click();
  await settle(4);
  assert.equal(calls.card.length, 1, '打开阅读层才铸造卡片');
  assert.ok(calls.chunk.length >= 1, 'native 阅读层必须走分片接口');
  const frame = h.find(h.doc.body, '.feed-reader iframe');
  assert.ok(frame, '阅读层应挂 iframe');
  assert.equal(typeof frame.getAttribute('srcdoc'), 'string');
  assert.ok(frame.getAttribute('srcdoc').includes('尾段'), '完整正文进入 srcdoc');
  assert.equal(frame.src, '');
  feature.dispose();
});

t('feature：关闭后重开同一条目，旧分片迟到不拦新阅读层（不复用失效归属）', async () => {
  const { h, feature, calls, gates } = setupFeature({ gateFirstChunk: true });
  await feature.open();
  await settle(4);

  h.find(h.doc.body, '.feed-read').click();
  await settle(4);
  assert.equal(calls.card.length, 1, '首次打开铸造卡片');
  assert.equal(calls.chunk.length, 1, '首片已发出并挂起');
  assert.equal(gates.length, 1);
  assert.equal(h.find(h.doc.body, '.feed-reader iframe'), null, '首片未到前不挂 iframe');

  // 关闭阅读层：旧归属失效。
  h.find(h.doc.body, '.feed-reader-back').click();
  assert.equal(h.find(h.doc.body, '.feed-reader').hidden, true);

  // 同 itemId + 同 revision 重开：必须新发卡片与分片请求。
  h.find(h.doc.body, '.feed-read').click();
  await settle(4);
  assert.equal(calls.card.length, 2, '重开必须新铸造，不共享旧归属');
  assert.ok(calls.chunk.length >= 2, `重开必须新取分片（${calls.chunk.length} 次）`);
  const frames = h.findAll(h.doc.body, '.feed-reader iframe');
  assert.equal(frames.length, 1, '阅读层只挂一个 iframe');
  assert.equal(String(frames[0].getAttribute('srcdoc')).includes('尾段'), true);

  // 旧首片现在才到达：不得报错、不得改动新阅读层。
  gates[0]();
  await settle(6);
  const after = h.findAll(h.doc.body, '.feed-reader iframe');
  assert.equal(after.length, 1, '旧响应到达后仍然只有一个 iframe');
  assert.equal(after[0], frames[0], '旧响应不能替换新阅读层');
  assert.equal(String(after[0].getAttribute('srcdoc')).includes('尾段'), true);
  assert.equal(h.find(h.doc.body, '.feed-card-error'), null, '旧响应不能被当成新请求的错误');
  feature.dispose();
});

/* ---- 运行 ---- */

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

if (bad) {
  console.log(`\n${bad} 个用例失败（共 ${tests.length} 个）`);
  process.exitCode = 1;
} else {
  console.log(`\nALL PASS（${tests.length} 个用例）`);
}
