/**
 * /gw/session-digest 的单元测试：只测归一化、缓存与响应形状，不起网络。
 *
 * 这条端点的存在理由见网关模块顶部注释：手机要知道「离开期间有没有会话跑完」，
 * 唯一可靠信号是宿主的 messageCount / status.isStreaming。
 */

import assert from 'node:assert/strict';
import { createSessionDigest, normalizeDigest, normalizeDigestRow, MAX_DIGEST_SESSIONS, SESSION_DIGEST_PATH } from '../gateway/session-digest.mjs';

let pass = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`ok ${pass} - ${name}`);
    })
    .catch((err) => {
      console.error(`not ok ${pass + 1} - ${name}`);
      console.error(err);
      process.exit(1);
    });
}

/** 最小 res 替身：记录 writeHead 与 end。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers || {};
      return res;
    },
    end(chunk) {
      res.body = chunk === undefined ? '' : String(chunk);
    },
  };
  return res;
}

const okAuth = async () => ({ ok: true, principal: { id: 'me' } });

await test('路径常量稳定（前端与路由共用一份）', () => {
  assert.equal(SESSION_DIGEST_PATH, '/gw/session-digest');
});

await test('normalizeDigestRow：正常行只留四个字段', () => {
  const row = normalizeDigestRow({
    sessionId: 's1',
    title: '会话一',
    messageCount: 6,
    status: { isStreaming: false, revision: 9, unreadStreamId: 'x' },
    path: '/secret/path',
    cwd: 'D:/secret',
  });
  assert.deepEqual(row, {
    sessionId: 's1',
    title: '会话一',
    messageCount: 6,
    isStreaming: false,
    hasStreaming: true,
  });
});

await test('normalizeDigestRow：缺 id / 条数非法一律丢弃', () => {
  assert.equal(normalizeDigestRow(null), null);
  assert.equal(normalizeDigestRow({}), null);
  assert.equal(normalizeDigestRow({ sessionId: '  ' }), null);
  assert.equal(normalizeDigestRow({ sessionId: 's', messageCount: -1 }), null);
  assert.equal(normalizeDigestRow({ sessionId: 's', messageCount: 'abc' }), null);
  assert.equal(normalizeDigestRow({ sessionId: 's' }), null);
});

await test('normalizeDigestRow：messageCount 小数向下取整、字符串数字可接受', () => {
  const row = normalizeDigestRow({ sessionId: 's', messageCount: '7.9', status: { isStreaming: true } });
  assert.equal(row.messageCount, 7);
  assert.equal(row.isStreaming, true);
});

await test('normalizeDigestRow：没有 status 时 isStreaming=false 但 hasStreaming=false（表示不知道）', () => {
  const row = normalizeDigestRow({ sessionId: 's', messageCount: 1 });
  assert.equal(row.isStreaming, false);
  assert.equal(row.hasStreaming, false);
});

await test('normalizeDigest：去重、按条数降序、截断', () => {
  const rows = [
    { sessionId: 'a', messageCount: 2, status: { isStreaming: false } },
    { sessionId: 'b', messageCount: 9, status: { isStreaming: true } },
    { sessionId: 'a', messageCount: 5, status: { isStreaming: false } },
    { sessionId: 'c', messageCount: 4 },
  ];
  const out = normalizeDigest(rows);
  assert.deepEqual(out.map((r) => r.sessionId), ['b', 'c', 'a']);
  assert.equal(out[2].messageCount, 2, '重复 id 保留第一条');
});

await test('normalizeDigest：超过上限时只回前 N 条', () => {
  const rows = Array.from({ length: MAX_DIGEST_SESSIONS + 12 }, (_, i) => ({
    sessionId: `s${i}`,
    messageCount: i,
  }));
  const out = normalizeDigest(rows);
  assert.equal(out.length, MAX_DIGEST_SESSIONS);
  assert.equal(out[0].sessionId, `s${MAX_DIGEST_SESSIONS + 11}`, '条数最多的在最前');
});

await test('normalizeDigest：非数组输入回空数组（不抛）', () => {
  assert.deepEqual(normalizeDigest(null), []);
  assert.deepEqual(normalizeDigest({ sessions: [] }), []);
});

await test('get：正常返回摘要，且不带 path/cwd 等字段', async () => {
  const digest = createSessionDigest({
    fetchRows: async () => [{ sessionId: 's1', title: 'T', messageCount: 3, status: { isStreaming: false }, path: '/x' }],
    now: () => 1000,
  });
  const body = await digest.get();
  assert.equal(body.sessions.length, 1);
  assert.deepEqual(body.sessions[0], { sessionId: 's1', title: 'T', messageCount: 3, isStreaming: false });
});

await test('get：TTL 内打缓存，上游只问一次', async () => {
  let calls = 0;
  let clock = 0;
  const digest = createSessionDigest({
    fetchRows: async () => {
      calls += 1;
      return [{ sessionId: 's1', messageCount: calls }];
    },
    ttlMs: 2000,
    now: () => clock,
  });
  await digest.get();
  clock = 1999;
  await digest.get();
  assert.equal(calls, 1);
  clock = 2000;
  await digest.get();
  assert.equal(calls, 2);
});

await test('get：并发请求共用同一次上游调用', async () => {
  let calls = 0;
  const digest = createSessionDigest({
    fetchRows: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return [{ sessionId: 's1', messageCount: 1 }];
    },
    ttlMs: 0,
  });
  await Promise.all([digest.get(), digest.get(), digest.get()]);
  assert.equal(calls, 1);
});

await test('get：上游失败回 null，且不写缓存（下一次还会重试）', async () => {
  let calls = 0;
  const digest = createSessionDigest({
    fetchRows: async () => {
      calls += 1;
      return calls === 1 ? null : [{ sessionId: 's1', messageCount: 2 }];
    },
    ttlMs: 60000,
  });
  assert.equal(await digest.get(), null);
  const body = await digest.get();
  assert.equal(body.sessions.length, 1);
  assert.equal(calls, 2);
});

await test('get：上游给的不是数组也当失败', async () => {
  const digest = createSessionDigest({ fetchRows: async () => ({ sessions: [] }) });
  assert.equal(await digest.get(), null);
});

await test('handle：未登录交给拒绝逻辑，不碰上游', async () => {
  let calls = 0;
  const denied = [];
  const digest = createSessionDigest({
    fetchRows: async () => {
      calls += 1;
      return [];
    },
    checkAuth: async () => ({ ok: false, reason: 'unauthenticated' }),
    deny: (res, auth) => {
      denied.push(auth.reason);
      res.writeHead(401, {});
      res.end('no');
    },
  });
  const res = fakeRes();
  await digest.handle({}, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(denied, ['unauthenticated']);
  assert.equal(calls, 0);
});

await test('handle：正常回 200 + no-store', async () => {
  const digest = createSessionDigest({
    fetchRows: async () => [{ sessionId: 's1', title: 'T', messageCount: 1 }],
    checkAuth: okAuth,
  });
  const res = fakeRes();
  await digest.handle({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(res.body).sessions[0].sessionId, 's1');
});

await test('handle：上游不可用回 502 digest_unavailable', async () => {
  const digest = createSessionDigest({ fetchRows: async () => null, checkAuth: okAuth });
  const res = fakeRes();
  await digest.handle({}, res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.body), { error: 'digest_unavailable' });
});

await test('clear：清掉缓存后重新问上游', async () => {
  let calls = 0;
  const digest = createSessionDigest({
    fetchRows: async () => {
      calls += 1;
      return [{ sessionId: 's1', messageCount: 1 }];
    },
    ttlMs: 60000,
  });
  await digest.get();
  digest.clear();
  await digest.get();
  assert.equal(calls, 2);
});

console.log(`\n${pass} passed`);
