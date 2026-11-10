/* tests/history_pager_extra_query.test.mjs — open 的一次性旁路参数
 *
 * 网关给会话尾部加了快照缓存，这对「打开会话」是提速，但对两种情形是错的：
 *   1. 本地刚发过消息：快照比现实旧，照旧读会把刚发的那条盖掉；
 *   2. 前台恢复对账：它要的是「离线期间到底有没有新东西」，读到旧快照会得出「没有」。
 *
 * 两种情形都必须让这一次 open 带上 `_nc`（网关据此跳过快照），而且只能是**这一次**：
 * 粘住的话，缓存就永久失效了。
 */

import assert from 'node:assert/strict';
import { createHistoryPager } from '../web/history-pager.js';

const SESSION = { sessionId: 'sess-1', path: 'C:/sessions/sess-1.jsonl' };

function createApi() {
  const calls = [];
  const api = async (url) => {
    calls.push(String(url));
    return { messages: [{ id: '1', role: 'user', content: 'x' }], blocks: [], hasMore: false };
  };
  return { api, calls };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('extraQuery 返回参数时，这一次 open 带上 _nc', async () => {
  const { api, calls } = createApi();
  let dirty = true;
  const pager = createHistoryPager({
    api,
    extraQuery: () => {
      if (!dirty) return null;
      dirty = false;
      return { _nc: '123' };
    },
  });

  await pager.open(SESSION);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /[?&]_nc=123(&|$)/);
});

test('一次性：第二次 open 不再带 _nc', async () => {
  const { api, calls } = createApi();
  let dirty = true;
  const pager = createHistoryPager({
    api,
    extraQuery: () => {
      if (!dirty) return null;
      dirty = false;
      return { _nc: '1' };
    },
  });

  await pager.open(SESSION);
  await pager.open(SESSION);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /_nc=/);
  assert.doesNotMatch(calls[1], /_nc=/);
});

test('没有 extraQuery 时不带 _nc', async () => {
  const { api, calls } = createApi();
  const pager = createHistoryPager({ api });
  await pager.open(SESSION);
  assert.doesNotMatch(calls[0], /_nc=/);
});

test('bypassBusy:true 的 open 也带 _nc（前台对账必须看见真数据）', async () => {
  const { api, calls } = createApi();
  const pager = createHistoryPager({ api });
  await pager.open(SESSION, { bypassBusy: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /_nc=/);
});

test('正常 open（不带 bypassBusy）不带 _nc：旁路不能粘住', async () => {
  const { api, calls } = createApi();
  const pager = createHistoryPager({ api });
  await pager.open(SESSION, { bypassBusy: true });
  await pager.open(SESSION);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1], /_nc=/);
});

test('翻历史（before）不带 _nc：翻页本来就绕过快照', async () => {
  const { api, calls } = createApi();
  const pager = createHistoryPager({
    api: async (url) => {
      calls.push(String(url));
      return {
        messages: [{ id: '9', role: 'user', content: 'x' }],
        blocks: [],
        hasMore: true,
      };
    },
    extraQuery: () => ({ _nc: '1' }),
  });

  await pager.open(SESSION);
  // 首屏带 _nc 是预期；这里只关心翻页那一次。
  const beforeOpen = calls.length;
  await pager.loadOlder();
  const older = calls.slice(beforeOpen);
  assert.ok(older.length >= 1, '应该真的发起了翻页请求');
  for (const url of older) {
    assert.match(url, /before=/);
    assert.doesNotMatch(url, /_nc=/);
  }
});

let bad = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

if (bad === 0) console.log(`ALL PASS（${cases.length} 个用例）`);
else {
  console.log(`FAILED (${bad} tests failed)`);
  process.exitCode = 1;
}
