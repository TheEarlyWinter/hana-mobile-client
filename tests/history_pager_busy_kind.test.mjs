/* tests/history_pager_busy_kind.test.mjs
 *
 * 单元 A：生成中放开「加载更早」——canLoad 带 kind（'open' | 'older'）那一层。
 *
 * 覆盖（历史契约（生成中翻页）第 2.1 / 2.2 / 3 节）：
 * 1. canLoad('older') 放行时生成中能取到更早一页；canLoad('open') 为 false 时首屏仍被拦；
 * 2. 旧的无参 canLoad 夹具（() => !busy / () => false）语义不变，两条路径照旧一起拦；
 * 3. pager 传给 canLoad 的 kind 永远是显式的 'open' / 'older'，缺省不会变成 undefined；
 * 4. 请求前、响应提交前、重试退避后的复核都带对 kind（用 kind 敏感夹具反证：传错就拦）；
 * 5. 控制器接线：canLoad 只看 open 的 busy，loadOlder 在生成中照发；
 *    renderHistoryPage 的边界调用形状 begin/endHistoryPage({ preserveLiveTurn })。
 *
 * 只改单元 A 的两个文件；渲染器 / 分页视图的实现由 B、C 两个单元负责，这里只锁调用形状。
 */

import assert from 'node:assert/strict';
import { createHistoryPager } from '../web/history-pager.js';
import { createHarness } from './support/app_harness.mjs';

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
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const SESSION = { sessionId: 'sess-kind', path: 'C:/sessions/kind.jsonl' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 手动放行的 sleep：用来在「退避等待中」改 canLoad 的口径。 */
function controlledSleep() {
  const slept = [];
  const waiting = [];
  function sleep(ms) {
    slept.push(ms);
    return new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    for (const resolve of waiting.splice(0)) resolve();
  }
  return { sleep, slept, release };
}

function httpError(status) {
  const err = new Error(`${status} boom`);
  err.status = status;
  return err;
}

function msg(id) {
  const numeric = Number(id);
  return {
    id: String(id),
    role: numeric % 2 === 0 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `m${id}` }],
  };
}

function rows(from, to) {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(msg(i));
  return out;
}

function paramsOf(url) {
  return Object.fromEntries(new URLSearchParams(String(url).split('?')[1] || ''));
}

/** 手动 resolve 的 api：用例自己决定每一页什么时候回来。 */
function makePager({ canLoad, retry } = {}) {
  const calls = [];
  const pending = [];
  function api(url) {
    const d = deferred();
    calls.push(String(url));
    pending.push(d);
    return d.promise;
  }
  const pages = [];
  const states = [];
  const options = {
    api,
    onPage: (page) => pages.push(page),
    onState: (state) => states.push(state),
  };
  if (canLoad) options.canLoad = canLoad;
  if (retry) options.retry = retry;
  const pager = createHistoryPager(options);
  return { pager, calls, pending, pages, states };
}

/** 会记下每次收到的 kind 的夹具；decide(kind, kindsSoFar) 决定放行与否。 */
function kindAware(decide = () => true) {
  const kinds = [];
  function canLoad(kind) {
    kinds.push(kind);
    return decide(kind, kinds);
  }
  return { canLoad, kinds };
}

const lastState = (h) => h.states[h.states.length - 1];
const onlyKinds = ['open', 'older'];

/* ------------------------------------------------------------------ */
/* 1. canLoad 带 kind：older 放行、open 仍拦                            */
/* ------------------------------------------------------------------ */

await t("canLoad('older') 放行：生成中能加载更早一页；canLoad('open') 拦首屏/重载", async () => {
  let busy = false;
  const { canLoad, kinds } = kindAware((kind) => (kind === 'older' ? true : !busy));
  const h = makePager({ canLoad });

  const opening = h.pager.open(SESSION);
  assert.deepEqual(kinds, ['open', 'open'], 'open 的同步复核与发请求前的复核都是 open');
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await opening, true);
  assert.deepEqual(kinds, ['open', 'open', 'open'], 'open 的发出前 + 提交前复核也都是 open');
  assert.equal(h.pages.length, 1);

  // 开始生成：older 照走（open 被拦的场景在下面用独立 pager 验，因为 open 会清游标）。
  busy = true;
  const older = h.pager.loadOlder();
  assert.equal(h.calls.length, 2, '生成中 loadOlder 必须真的发请求');
  assert.equal(paramsOf(h.calls[1]).before, '100');
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, true, '生成中到达的更早页必须交付');

  assert.equal(h.pages.length, 2);
  assert.equal(h.pages[1].prepend, true);
  assert.deepEqual(h.pages[1].entries.map((e) => e.id), rows(50, 99).map((e) => e.id));
  assert.equal(lastState(h).error, null, '生成中 prepend 不能被自己的 busy 复核拦掉');

  const olderKinds = kinds.slice(3);
  assert.deepEqual(olderKinds, ['older', 'older', 'older'], 'loadOlder 的请求前 / 发出前 / 提交前都是 older');
  assert.ok(kinds.every((kind) => onlyKinds.includes(kind)), 'kind 永远是显式字符串，绝不会是 undefined');

  // 生成中的 open（首屏 / 重载）仍被拦：用独立 pager，免得被上面 open 的清游标行为干扰。
  const blocked = makePager({ canLoad });
  assert.equal(await blocked.pager.open(SESSION), false, '生成中 open 仍必须被拦');
  assert.equal(blocked.calls.length, 0, '被拦的 open 不得发请求');
  assert.equal(lastState(blocked).error?.code, 'busy');
  assert.equal(kinds[kinds.length - 1], 'open', '被拦的 open 复核用的是 open');
});

/* ------------------------------------------------------------------ */
/* 2. 向后兼容：旧的无参夹具语义不变                                    */
/* ------------------------------------------------------------------ */

await t('旧的无参 canLoad（() => !busy）语义不变：生成中 open 与 older 都被拦', async () => {
  let busy = false;
  const h = makePager({ canLoad: () => !busy });
  // 夹具忽略 kind 参数，等价于改动前的行为。
  const opening = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await opening, true);

  busy = true;
  assert.equal(await h.pager.loadOlder(), false, '旧夹具在 busy 时仍然拦加载更早');
  assert.equal(h.calls.length, 1, '旧夹具下 busy 不得发 loadOlder 请求');
  assert.equal(lastState(h).error?.code, 'busy');
  assert.equal(lastState(h).hasMore, true, '必须保留重试能力');

  busy = false;
  const retry = h.pager.loadOlder();
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await retry, true);
});

await t('旧的无参 canLoad（() => false）语义不变：open 与 older 都拦，且都不发请求', async () => {
  const h = makePager({ canLoad: () => false });
  assert.equal(await h.pager.open(SESSION), false);
  assert.equal(lastState(h).error?.code, 'busy');
  assert.equal(h.calls.length, 0);
  // 没有首屏就没有游标，loadOlder 本来也会早退；这里锁的是「不会因为 kind 被换成 older 而放行」。
  assert.equal(await h.pager.loadOlder(), false);
  assert.equal(h.calls.length, 0);
});

await t('不传 canLoad 时默认全放行：open 与 loadOlder 都照常工作', async () => {
  const h = makePager();
  const opening = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await opening, true);

  const older = h.pager.loadOlder();
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, true);
  assert.equal(h.pages.length, 2);
});

/* ------------------------------------------------------------------ */
/* 3. 提交前的复核带对 kind（kind 敏感夹具反证）                        */
/* ------------------------------------------------------------------ */

await t('loadOlder 响应提交前的复核用 older：若是 open 口径就会被拦', async () => {
  // open 阶段全放行；只要已经出现过 older 复核，就把 open 口径拒掉。
  // 提交前复核若用错成 open，这一页会被拦，断言立刻红。
  const { canLoad, kinds } = kindAware((kind, seen) => {
    if (kind === 'open' && seen.filter((k) => k === 'older').length > 0) return false;
    return true;
  });
  const h = makePager({ canLoad });

  const opening = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await opening, true);

  const older = h.pager.loadOlder();
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, true, '提交前复核必须是 older（放行）');
  assert.equal(h.pages.length, 2);
  assert.deepEqual(kinds.slice(3), ['older', 'older', 'older']);
});

await t('loadOlder 提交前被 older 拒绝时：不交付、不推进游标，报 busy', async () => {
  // 第三次出现的 older 就是提交前复核：只拦它，反证它确实带的是 older。
  const { canLoad } = kindAware((kind, seen) => {
    if (kind === 'older' && seen.filter((k) => k === 'older').length === 3) return false;
    return true;
  });
  const h = makePager({ canLoad });

  const opening = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(100, 149), hasMore: true });
  assert.equal(await opening, true);

  const older = h.pager.loadOlder();
  h.pending[1].resolve({ messages: rows(50, 99), hasMore: false });
  assert.equal(await older, false);
  assert.equal(h.pages.length, 1, '提交前被拦的页不得上屏');
  assert.equal(lastState(h).error?.code, 'busy');
  assert.equal(lastState(h).hasMore, true);
});

await t('open 响应提交前的复核用 open：故意只拦 open 时必须丢弃整页', async () => {
  const { canLoad, kinds } = kindAware((kind, seen) => {
    if (kind === 'open' && seen.filter((k) => k === 'open').length === 3) return false;
    return true;
  });
  const h = makePager({ canLoad });

  const opening = h.pager.open(SESSION);
  h.pending[0].resolve({ messages: rows(150, 199), hasMore: true });
  assert.equal(await opening, false);
  assert.equal(h.pages.length, 0, 'open 提交前复核必须是 open');
  assert.deepEqual(kinds, ['open', 'open', 'open']);
  assert.equal(lastState(h).error?.code, 'busy');
});

/* ------------------------------------------------------------------ */
/* 4. 重试退避后的复核带对 kind                                         */
/* ------------------------------------------------------------------ */

await t('loadOlder 退避后的复核用 older：口径切换后能重试成功', async () => {
  const control = controlledSleep();
  let mode = 'all';
  const { canLoad, kinds } = kindAware((kind) => (mode === 'all' ? true : kind === mode));

  const steps = [
    () => ({ messages: rows(100, 149), hasMore: true }), // open
    () => { throw httpError(502); },                     // loadOlder 首试
    () => ({ messages: rows(50, 99), hasMore: false }),  // 退避后的重试
  ];
  const calls = [];
  let index = 0;
  const pages = [];
  const states = [];
  const pager = createHistoryPager({
    api: (url) => {
      calls.push(String(url));
      const step = steps[index];
      index += 1;
      return step();
    },
    canLoad,
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
    onPage: (page) => pages.push(page),
    onState: (state) => states.push(state),
  });

  assert.equal(await pager.open(SESSION), true);
  const loading = pager.loadOlder();
  await settle(4);
  assert.deepEqual(control.slept, [400], '502 应进入第一次退避');

  // 退避期间口径收紧成「只放行 older」：复核若用 open 就会被 busy 拦死。
  mode = 'older';
  control.release();
  await settle(8);

  assert.equal(await loading, true, '退避后的复核必须带 older 才能重试成功');
  assert.equal(calls.length, 3, 'open 1 次 + loadOlder 首试 + 1 次重试');
  assert.equal(paramsOf(calls[2]).before, '100', '重试沿用同一 before');
  assert.deepEqual(pages.map((page) => page.prepend), [false, true]);
  assert.equal(states[states.length - 1].error, null);
  assert.ok(kinds.every((kind) => onlyKinds.includes(kind)));
});

await t('open 退避后的复核用 open：口径切换后能重试成功', async () => {
  const control = controlledSleep();
  let mode = 'all';
  const { canLoad } = kindAware((kind) => (mode === 'all' ? true : kind === mode));

  const steps = [
    () => { throw httpError(503); },                    // open 首试
    () => ({ messages: rows(150, 199), hasMore: false }), // 退避后的重试
  ];
  let index = 0;
  const calls = [];
  const pages = [];
  const pager = createHistoryPager({
    api: (url) => {
      calls.push(String(url));
      const step = steps[index];
      index += 1;
      return step();
    },
    canLoad,
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
    onPage: (page) => pages.push(page),
  });

  const opening = pager.open(SESSION);
  await settle(4);
  assert.deepEqual(control.slept, [400], '503 应进入第一次退避');

  mode = 'open';
  control.release();
  await settle(8);

  assert.equal(await opening, true, '退避后的复核必须带 open 才能重试成功');
  assert.equal(calls.length, 2);
  assert.equal(pages.length, 1);
});

await t('退避期间转 busy：older 路径仍以 busy 收尾并保留 cursor', async () => {
  const control = controlledSleep();
  let busy = false;
  const { canLoad, kinds } = kindAware((kind) => (kind === 'older' ? !busy : !busy));

  const steps = [
    () => ({ messages: rows(100, 149), hasMore: true }),
    () => { throw httpError(502); },
    () => ({ messages: rows(50, 99), hasMore: false }), // 不该被吃到
  ];
  let index = 0;
  const calls = [];
  const pages = [];
  const states = [];
  const pager = createHistoryPager({
    api: (url) => { calls.push(String(url)); const step = steps[index]; index += 1; return step(); },
    canLoad,
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
    onPage: (page) => pages.push(page),
    onState: (state) => states.push(state),
  });

  assert.equal(await pager.open(SESSION), true);
  const loading = pager.loadOlder();
  await settle(4);
  assert.deepEqual(control.slept, [400]);

  busy = true;
  control.release();
  await settle(8);

  assert.equal(await loading, false, '生成中（busy）不得继续重试');
  assert.equal(calls.length, 2, 'busy 之后不得再发 GET');
  assert.equal(pages.length, 1);
  const state = states[states.length - 1];
  assert.equal(state.error?.code, 'busy');
  assert.equal(state.hasMore, true, 'cursor 未推进，保留重试能力');
  assert.equal(state.phase, 'older');
  assert.equal(kinds[kinds.length - 1], 'older', '退避后的复核带的是 older');
});

/* ------------------------------------------------------------------ */
/* 5. 控制器接线 + renderHistoryPage 的边界调用形状（真 app.js）        */
/* ------------------------------------------------------------------ */

const h = createHarness();

const SID = 'sess-kind-ui';
const PATH = 'C:/sessions/kind-ui';

function uiMessage(id, text) {
  return {
    id: String(id),
    role: 'user',
    content: text,
    timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, Number(id))).toISOString(),
  };
}

const ui = {
  latest: {
    messages: [uiMessage(60, 'LATEST-K-60'), uiMessage(61, 'LATEST-K-61')],
    blocks: [],
    hasMore: true,
  },
  older: {
    messages: [uiMessage(40, 'EARLY-K-40'), uiMessage(41, 'EARLY-K-41')],
    blocks: [],
    hasMore: false,
  },
  messageCalls: [],
};

h.setFetch(async (url) => {
  const pathname = String(url).split('?')[0];
  const params = paramsOf(url);
  if (pathname === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (pathname === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/OH-WorkSpace',
    });
  }
  if (pathname === '/api/sessions/messages') {
    ui.messageCalls.push(params);
    if (params.before != null) return h.jsonRes(ui.older);
    return h.jsonRes(ui.latest);
  }
  if (pathname === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const transcript = () => h.getEl('transcript');
const transcriptText = () => h.textOf(transcript());
const bars = () => h.findAll(transcript(), '.history-pagination-bar');
const barText = () => bars().map((node) => h.textOf(node)).join(' | ');

/** 「加载更早 / 重试」按钮：按分页视图的既有 class 找，不依赖文案以外的新结构。 */
function olderButton() {
  const buttons = h.findAll(transcript(), 'button');
  return buttons.find((node) => /加载更早|重试/.test(String(node.textContent || ''))) || null;
}

// 只观察 renderHistoryPage 交给渲染器的边界调用形状；真实实现仍照常执行。
const boundaryCalls = [];
const realBegin = hana.renderer.beginHistoryPage;
const realEnd = hana.renderer.endHistoryPage;
hana.renderer.beginHistoryPage = (...args) => {
  boundaryCalls.push({ fn: 'begin', args });
  return realBegin.apply(hana.renderer, args);
};
hana.renderer.endHistoryPage = (...args) => {
  boundaryCalls.push({ fn: 'end', args });
  return realEnd.apply(hana.renderer, args);
};

await t('首屏（非 prepend）：边界调用带 preserveLiveTurn=false', async () => {
  await hana.openSession({ path: PATH, sessionId: SID, title: '生成中翻页', agentId: 'agent-1' });
  await h.waitFor(() => transcriptText().includes('LATEST-K-60'), '首屏历史应渲染');
  await h.settle(4);

  const begins = boundaryCalls.filter((call) => call.fn === 'begin' && call.args.length > 0);
  const ends = boundaryCalls.filter((call) => call.fn === 'end' && call.args.length > 0);
  assert.ok(
    begins.some((call) => call.args[0] && call.args[0].preserveLiveTurn === false),
    `首屏 beginHistoryPage 必须带 { preserveLiveTurn: false }，实际：${JSON.stringify(begins.map((c) => c.args))}`,
  );
  assert.ok(
    ends.some((call) => call.args[0] && call.args[0].preserveLiveTurn === false),
    `首屏 endHistoryPage 必须带 { preserveLiveTurn: false }，实际：${JSON.stringify(ends.map((c) => c.args))}`,
  );
  assert.ok(/加载更早/.test(String(olderButton()?.textContent || '')), 'hasMore=true 时应露出「加载更早」');
});

await t('生成中点「加载更早」：请求照发、prepend 落地，边界调用带 preserveLiveTurn=true', async () => {
  const before = ui.messageCalls.length;
  const button = olderButton();
  assert.ok(button, '应能找到「加载更早」按钮');

  S.busy = true;
  boundaryCalls.length = 0;
  button.dispatchEvent('click');
  await h.waitFor(() => transcriptText().includes('EARLY-K-40'), '生成中更早一页应落地');
  await h.settle(4);

  assert.equal(ui.messageCalls.length, before + 1, '生成中 loadOlder 必须真的发请求');
  assert.deepEqual(ui.messageCalls[ui.messageCalls.length - 1], {
    sessionId: SID,
    path: PATH,
    before: '60',
    limit: '50',
  }, 'before 仍是最早 raw id，身份与 limit 不变');
  assert.ok(transcriptText().includes('LATEST-K-60'), '旧消息必须还在（prepend 不是替换）');

  const begins = boundaryCalls.filter((call) => call.fn === 'begin');
  const ends = boundaryCalls.filter((call) => call.fn === 'end');
  assert.ok(
    begins.some((call) => call.args[0] && call.args[0].preserveLiveTurn === true),
    `prepend 的 beginHistoryPage 必须带 { preserveLiveTurn: true }，实际：${JSON.stringify(begins.map((c) => c.args))}`,
  );
  assert.ok(
    ends.some((call) => call.args[0] && call.args[0].preserveLiveTurn === true),
    `prepend 的 endHistoryPage 必须带 { preserveLiveTurn: true }，实际：${JSON.stringify(ends.map((c) => c.args))}`,
  );

  S.busy = false;
});

await t('生成中 open（重载）：仍被 busy 拦住，不发请求、旧历史不丢', async () => {
  const before = ui.messageCalls.length;
  S.busy = true;
  await hana.loadHistory();
  await h.settle(6);

  assert.equal(ui.messageCalls.length, before, 'busy 时 open/重载不得发历史请求');
  assert.ok(transcriptText().includes('LATEST-K-60'), '旧历史不能被清掉');
  assert.ok(/正在生成回复|稍后/.test(barText()), `状态带要说明为什么没加载，实际：${barText()}`);
  S.busy = false;
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
