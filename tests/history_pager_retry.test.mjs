/* tests/history_pager_retry.test.mjs
 *
 * web/history-pager.js 的「瞬断自动重试」契约（TDD：先红后绿）。
 *
 * 背景：3111 条消息的大会话经公网入口偶尔 502（Cloudflare 隧道瞬断），宿主直连
 * 同一条请求是 200 / 81 KB / 323 ms，重试一次就好。用户不该为隧道抖动手点重试。
 *
 * 覆盖：
 * 1. 5xx 一次后成功：总请求 2、最终 error=null、中途不闪错误、loading 不断
 * 2. 连续 3 次 5xx：总请求 3（首试 + 2 次重试），退避 400/1200，错误保留原始状态码
 * 3. 502/503/504 各码都算瞬时；500 不重试（宿主真实报错必须立刻上抛）
 * 4. 4xx（400/401/403/404/409）不重试
 * 5. 网络层失败（fetch throw / TypeError / ECONNRESET）重试，且沿用同一 before
 * 6. 响应形状错误、busy 不重试
 * 7. 重试等待期间 epoch 失效：不再发请求、不改状态、不污染新会话
 * 8. phase：open 失败为 'initial'，loadOlder 失败为 'older'，无请求时沿用最近一次
 * 9. 默认 retry：调用方只注入 sleep 时仍是 attempts=2 / delays=[400,1200]
 * 10. 重试用尽：保留 cursor/hasMore，手动重试仍从原 before 开始
 *
 * 注入假 sleep：测试里不真的等 1.6 秒，只记录延迟序列。
 */

import assert from 'node:assert/strict';
import { createHistoryPager } from '../web/history-pager.js';

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

// 与 web/http-client.js 一致：HTTP 错误是带 .status 的 Error，message 以状态码开头。
function httpError(status, detail = 'boom') {
  const err = new Error(`${status} ${detail}`);
  err.status = status;
  err.body = { detail };
  return err;
}

// 与 web/http-client.js 一致：超时是 code='timeout' 的普通 Error，没有 HTTP status。
function timeoutError(pathname) {
  const err = new Error(`请求超时：${pathname}`);
  err.code = 'timeout';
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

function autoSleep() {
  const slept = [];
  async function sleep(ms) {
    slept.push(ms);
  }
  return { sleep, slept };
}

/** 手动放行的 sleep：用来在「退避等待中」插入换会话。 */
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

/**
 * steps：每次请求按顺序取一个 step，返回响应体（同步抛错 = fetch 立即失败，
 * reject = fetch 异步失败）。用不到 step 就直接抛错，防止意外多发请求。
 */
function harness({ steps = [], retry, canLoad = () => true } = {}) {
  const calls = [];
  const queue = steps.slice();
  const pages = [];
  const states = [];
  const auto = autoSleep();

  function api(url) {
    calls.push(String(url));
    const step = queue.shift();
    if (!step) throw new Error(`unexpected api call: ${url}`);
    return step(String(url));
  }

  const options = {
    api,
    onPage: (page) => pages.push(page),
    onState: (state) => states.push(state),
    canLoad,
    retry: retry || { attempts: 2, delays: [400, 1200], sleep: auto.sleep },
  };
  const pager = createHistoryPager(options);
  return { pager, calls, pages, states, slept: auto.slept };
}

const lastState = (h) => h.states[h.states.length - 1];
const paramsOf = (url) => Object.fromEntries(new URLSearchParams(String(url).split('?')[1] || ''));
const idsOf = (entries) => entries.map((entry) => entry.id);

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ */
/* 1. 5xx 自动重试                                                     */
/* ------------------------------------------------------------------ */

await t('502 一次后成功：自动重试一次，最终 error=null，总请求 2', async () => {
  const h = harness({
    steps: [
      () => { throw httpError(502, 'origin web server returned an invalid or incomplete response'); },
      () => ({ messages: rows(1, 3), hasMore: false }),
    ],
  });

  const opening = h.pager.open({ sessionId: 'sess-502' });
  assert.equal(h.states[0].loading, true, '首试期间保持 loading');
  assert.equal(h.states[0].error, null);
  assert.equal(h.states[0].phase, 'initial');
  assert.equal(await opening, true);

  assert.equal(h.calls.length, 2, '首试 + 1 次重试');
  assert.deepEqual(h.slept, [400], '第一次重试前等 400ms');
  assert.equal(h.pages.length, 1);
  assert.deepEqual(idsOf(h.pages[0].entries), ['1', '2', '3']);
  assert.equal(lastState(h).error, null);
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).phase, 'initial');
  assert.ok(h.states.every((s) => s.error === null), '重试期间不能先报错再重试（用户不该看到闪一下的错误）');
});

await t('连续 502 三次：最多重试 2 次（总请求 3），退避 400/1200，错误保留原始状态码', async () => {
  const h = harness({
    steps: [
      () => { throw httpError(502); },
      () => { throw httpError(502); },
      () => { throw httpError(502); },
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-dead' }), false);
  assert.equal(h.calls.length, 3, '首试 + 2 次重试，不能无限重试');
  assert.deepEqual(h.slept, [400, 1200], '第二次重试前等 1200ms');
  assert.equal(h.pages.length, 0, '失败不得伪装成空成功页');

  const err = lastState(h).error;
  assert.equal(err.status, 502, '原始 HTTP 状态码必须留着，视图要用它判断展示');
  assert.match(err.message, /502/);
  assert.equal(lastState(h).loading, false, '重试用尽必须收掉 loading，露出可重试入口');
  assert.equal(lastState(h).phase, 'initial');
  assert.equal(h.states.filter((s) => s.error).length, 1, '只报一次最终错误');
});

await t('502/503/504 都算瞬时故障：各重试一次后成功', async () => {
  for (const status of [502, 503, 504]) {
    const h = harness({
      steps: [
        () => { throw httpError(status); },
        () => ({ messages: rows(1, 2), hasMore: false }),
      ],
    });
    assert.equal(await h.pager.open({ sessionId: 's' }), true, `${status} 后应重试成功`);
    assert.equal(h.calls.length, 2, `${status} 应重试一次`);
    assert.deepEqual(h.slept, [400]);
    assert.equal(lastState(h).error, null);
  }
});

/* ------------------------------------------------------------------ */
/* 2. 不该重试的失败                                                   */
/* ------------------------------------------------------------------ */

await t('500 不重试：宿主真实报错立刻上抛，请求数 1', async () => {
  const h = harness({
    steps: [
      () => { throw httpError(500, 'boom'); },
      () => { throw new Error('500 不该重试'); },
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-500' }), false);
  assert.equal(h.calls.length, 1, '500 不得自动重试');
  assert.deepEqual(h.slept, [], '500 不得进入退避等待');
  assert.equal(h.pages.length, 0, '失败不得伪装成空成功页');
  assert.equal(lastState(h).error.status, 500, '原始状态码必须原样上报');
  assert.equal(lastState(h).loading, false, '立刻失败，露出可重试入口');
  assert.equal(lastState(h).phase, 'initial');
});

await t('501/505 也不重试：只有 502/503/504 算瞬断', async () => {
  for (const status of [501, 505]) {
    const h = harness({
      steps: [
        () => { throw httpError(status); },
        () => { throw new Error(`${status} 不该重试`); },
      ],
    });
    assert.equal(await h.pager.open({ sessionId: 's' }), false);
    assert.equal(h.calls.length, 1, `${status} 不得重试`);
    assert.deepEqual(h.slept, []);
    assert.equal(lastState(h).error.status, status);
  }
});

await t('4xx 不重试：400/401/403/404/409 只发一次请求', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const h = harness({
      steps: [
        () => { throw httpError(status); },
        () => { throw new Error('4xx 不该重试'); },
      ],
    });
    assert.equal(await h.pager.open({ sessionId: 's' }), false);
    assert.equal(h.calls.length, 1, `${status} 不得重试`);
    assert.deepEqual(h.slept, [], `${status} 不得进入退避等待`);
    assert.equal(lastState(h).error.status, status);
    assert.equal(lastState(h).loading, false);
  }
});

await t('响应形状错误不重试：立即上报 malformed-response', async () => {
  const h = harness({
    steps: [() => ({ messages: rows(1, 2), blocks: 'nope' })],
  });
  assert.equal(await h.pager.open({ sessionId: 's' }), false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.slept, []);
  assert.equal(lastState(h).error.code, 'malformed-response');
  assert.equal(h.pages.length, 0);
});

await t('busy 不重试：canLoad=false 时根本不发请求', async () => {
  const h = harness({ steps: [], canLoad: () => false });
  assert.equal(await h.pager.open({ sessionId: 's' }), false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.slept, []);
  assert.equal(lastState(h).error.code, 'busy');
  assert.equal(lastState(h).phase, 'initial');
});

await t('200 但响应是 HTML：形状错误不重试，报 malformed-response', async () => {
  // 网关登录页 / Cloudflare 错误页会以 200 + text/html 回来，它不是瞬断，重试只会再碰一次。
  const h = harness({
    steps: [
      () => '<!doctype html><html><body>sign in</body></html>',
      () => ({ messages: rows(1, 2), hasMore: false }),
    ],
  });
  assert.equal(await h.pager.open({ sessionId: 'sess-html' }), false);
  assert.equal(h.calls.length, 1, 'HTML 形状错误不得重试');
  assert.deepEqual(h.slept, []);
  assert.equal(h.pages.length, 0, '不得把 HTML 当成空页交付');
  assert.equal(lastState(h).error.code, 'malformed-response');
  assert.equal(lastState(h).loading, false);
});

/* ------------------------------------------------------------------ */
/* 2b. 超时：15s 已经等够了，不再自动重试                              */
/* ------------------------------------------------------------------ */

await t('open 超时（code=timeout）：只发一次请求，code 原样透传，不进退避', async () => {
  const h = harness({
    steps: [
      (url) => { throw timeoutError(url); },
      () => ({ messages: rows(1, 2), hasMore: false }), // 被误当成重试时会被吃掉
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-timeout' }), false);
  assert.equal(h.calls.length, 1, '超时不得自动重试（否则用户要等 3×15s）');
  assert.deepEqual(h.slept, [], '超时不得进入退避等待');
  assert.equal(h.pages.length, 0, '失败不得伪装成空成功页');
  assert.equal(lastState(h).error.code, 'timeout', '视图靠 code 区分超时与 HTTP 错误');
  assert.match(lastState(h).error.message, /请求超时/, '中文提示必须原样保留');
  assert.equal(lastState(h).error.status, undefined, '超时不是 HTTP 状态');
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).phase, 'initial');
});

await t('loadOlder 超时：只发一次请求，保留 cursor/hasMore，手动重试仍从原 before 开始', async () => {
  const h = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      (url) => { throw timeoutError(url); },
      () => ({ messages: rows(50, 99), hasMore: false }), // 被误当成重试时会被吃掉
      () => ({ messages: rows(50, 99), hasMore: false }),
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-timeout-older' }), true);
  assert.equal(await h.pager.loadOlder(), false);
  assert.equal(h.calls.length, 2, 'loadOlder 超时只发一次，不重试');
  assert.deepEqual(h.slept, []);
  assert.equal(h.pages.length, 1, '失败不得伪装空页');
  assert.equal(lastState(h).error.code, 'timeout');
  assert.equal(lastState(h).hasMore, true, '超时后必须保留可重试能力');
  assert.equal(lastState(h).phase, 'older');

  assert.equal(await h.pager.loadOlder(), true);
  assert.equal(paramsOf(h.calls[2]).before, '100', '超时后仍从原 cursor 重试');
  assert.equal(lastState(h).error, null);
});

/* ------------------------------------------------------------------ */
/* 3. 网络层失败                                                       */
/* ------------------------------------------------------------------ */

await t('网络层失败重试：fetch 抛 TypeError，第二次成功', async () => {
  const h = harness({
    steps: [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => ({ messages: rows(100, 149), hasMore: true }),
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-net' }), true);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.slept, [400]);
  assert.equal(lastState(h).error, null);
});

await t('网络层失败重试：ECONNRESET 也重试，loadOlder 沿用同一 before', async () => {
  const h = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      },
      () => ({ messages: rows(50, 99), hasMore: false }),
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-reset' }), true);
  assert.equal(await h.pager.loadOlder(), true);

  assert.equal(h.calls.length, 3, 'loadOlder 首试 + 1 次重试');
  assert.equal(paramsOf(h.calls[1]).before, '100');
  assert.equal(paramsOf(h.calls[2]).before, '100', '重试必须沿用同一 before');
  assert.equal(lastState(h).error, null);
  assert.equal(lastState(h).phase, 'older');
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(50, 99)));
});

/* ------------------------------------------------------------------ */
/* 4. 重试与 epoch                                                     */
/* ------------------------------------------------------------------ */

await t('重试等待期间 epoch 失效：不再发下一次请求、不改状态、不污染新会话', async () => {
  const control = controlledSleep();
  const h = harness({
    steps: [
      () => { throw httpError(502); },                      // A 的首试
      () => ({ messages: rows(200, 202), hasMore: false }),  // B 的首试
      () => { throw new Error('A 不该再发请求'); },
    ],
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
  });

  const openingA = h.pager.open({ sessionId: 'sess-A' });
  await settle(4);
  assert.deepEqual(control.slept, [400], 'A 应进入第一次退避等待');

  const openingB = h.pager.open({ sessionId: 'sess-B' });
  assert.equal(await openingB, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.pages.length, 1);
  const statesAfterB = h.states.length;

  control.release(); // A 的退避结束：epoch 已失效，必须直接放弃
  await settle(6);

  assert.equal(await openingA, false, '旧 epoch 的 open 必须返回 false');
  assert.equal(h.calls.length, 2, 'A 不得在 epoch 失效后再发请求');
  assert.equal(h.states.length, statesAfterB, 'A 不得再改 onState');
  assert.equal(h.pages.length, 1, 'A 不得把旧会话的页写进新会话');
  assert.deepEqual(idsOf(h.pages[0].entries), ['200', '201', '202']);
  assert.equal(lastState(h).phase, 'initial');
});

await t('重试等待期间 reset：立即放弃，不再请求也不报错', async () => {
  const control = controlledSleep();
  const h = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      () => { throw httpError(503); },
      () => { throw new Error('reset 后不该再请求'); },
    ],
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-r' }), true);
  const loadingOlder = h.pager.loadOlder();
  await settle(4);
  assert.deepEqual(control.slept, [400], 'loadOlder 应进入退避等待');

  h.pager.reset();
  const statesAfterReset = h.states.length;
  assert.equal(lastState(h).loading, false, 'reset 后不能停在进行中');

  control.release();
  await settle(6);

  assert.equal(await loadingOlder, false);
  assert.equal(h.calls.length, 2, 'reset 后不得再发重试请求');
  assert.equal(h.states.length, statesAfterReset, 'reset 后不得再有状态变化');
  assert.equal(lastState(h).error, null);
});

await t('退避期间转 busy：下一次 GET 前重新核对 canLoad，不再发请求，以 busy 结束', async () => {
  let busy = false;
  const control = controlledSleep();
  const h = harness({
    canLoad: () => !busy,
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }), // open
      () => { throw httpError(502); },                     // loadOlder 首试
      () => ({ messages: rows(50, 99), hasMore: false }),  // 退避后不该再发（会被这里的“成功”出卖）
      () => ({ messages: rows(50, 99), hasMore: false }),  // 恢复后手动重试
    ],
    retry: { attempts: 2, delays: [400, 1200], sleep: control.sleep },
  });

  assert.equal(await h.pager.open({ sessionId: 'sess-busy-retry' }), true);
  const loadingOlder = h.pager.loadOlder();
  await settle(4);
  assert.deepEqual(control.slept, [400], '502 应进入第一次退避');

  // 这 400ms 里用户开始生成：退避结束不能再打宿主的消息接口。
  busy = true;
  control.release();
  await settle(6);

  assert.equal(await loadingOlder, false);
  assert.equal(h.calls.length, 2, 'busy 之后不得再发 GET');
  assert.equal(h.pages.length, 1, '不得交付任何页');
  assert.equal(lastState(h).error.code, 'busy');
  assert.match(lastState(h).error.message, /稍后/);
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).hasMore, true, 'cursor 未推进，必须保留重试能力');
  assert.equal(lastState(h).phase, 'older');

  // cursor/seen 没动：恢复后仍从原 before 取，且这一页条目齐全。
  busy = false;
  const retry = h.pager.loadOlder();
  assert.equal(paramsOf(h.calls[2]).before, '100');
  assert.equal(await retry, true);
  assert.deepEqual(idsOf(h.pages[1].entries), idsOf(rows(50, 99)));
  assert.equal(lastState(h).error, null);
});

/* ------------------------------------------------------------------ */
/* 5. phase                                                            */
/* ------------------------------------------------------------------ */

await t('phase：open 失败为 initial，loadOlder 失败为 older', async () => {
  const openFail = harness({ steps: [() => { throw httpError(403); }] });
  const opening = openFail.pager.open({ sessionId: 's' });
  assert.equal(lastState(openFail).phase, 'initial', '进行中的 open 就要带 phase');
  assert.equal(await opening, false);
  assert.equal(lastState(openFail).phase, 'initial', 'open 失败仍是 initial');

  const olderFail = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      () => { throw httpError(403); },
    ],
  });
  assert.equal(await olderFail.pager.open({ sessionId: 's' }), true);
  const loading = olderFail.pager.loadOlder();
  assert.equal(lastState(olderFail).phase, 'older', '进行中的 loadOlder 就是 older');
  assert.equal(await loading, false);
  assert.equal(lastState(olderFail).phase, 'older', 'loadOlder 失败仍是 older');
  assert.equal(lastState(olderFail).error.status, 403);
});

await t('phase：无请求时沿用最近一次（error 为 null 也照给）', async () => {
  const h = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      () => { throw httpError(403); },
    ],
  });
  assert.equal(await h.pager.open({ sessionId: 's' }), true);
  assert.equal(lastState(h).phase, 'initial', '成功页也带 phase');

  await h.pager.loadOlder();
  h.pager.reset();
  assert.equal(lastState(h).phase, 'older', '无任何请求时给最近一次的 phase');
  assert.equal(lastState(h).error, null);
});

/* ------------------------------------------------------------------ */
/* 6. 配置与重试用尽                                                   */
/* ------------------------------------------------------------------ */

await t('默认 retry：调用方只注入 sleep 时仍用 attempts=2 / delays=[400,1200]', async () => {
  const auto = autoSleep();
  const h = harness({
    steps: [
      () => { throw httpError(502); },
      () => { throw httpError(502); },
      () => { throw httpError(502); },
    ],
    retry: { sleep: auto.sleep },
  });

  assert.equal(await h.pager.open({ sessionId: 's' }), false);
  assert.equal(h.calls.length, 3, '默认最多重试 2 次');
  assert.deepEqual(auto.slept, [400, 1200], '默认退避序列不能被覆盖掉');
});

await t('loadOlder 重试用尽：保留 cursor/hasMore，手动重试仍从原 before 开始', async () => {
  const h = harness({
    steps: [
      () => ({ messages: rows(100, 149), hasMore: true }),
      () => { throw httpError(502); },
      () => { throw httpError(502); },
      () => { throw httpError(502); },
      () => ({ messages: rows(50, 99), hasMore: false }),
    ],
  });

  assert.equal(await h.pager.open({ sessionId: 's' }), true);
  assert.equal(await h.pager.loadOlder(), false);
  assert.equal(h.calls.length, 4, 'loadOlder 首试 + 2 次重试');
  assert.equal(h.pages.length, 1, '失败不得伪装空页');
  assert.equal(lastState(h).hasMore, true, '失败后必须保留可重试能力');
  assert.equal(lastState(h).loading, false);
  assert.equal(lastState(h).phase, 'older');
  assert.equal(lastState(h).error.status, 502);

  assert.equal(await h.pager.loadOlder(), true);
  assert.equal(h.calls.length, 5);
  for (const url of h.calls.slice(1)) {
    assert.equal(paramsOf(url).before, '100', '每次重试（含手动）都必须用原 cursor');
  }
  assert.equal(lastState(h).error, null);
  assert.equal(lastState(h).phase, 'older');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
