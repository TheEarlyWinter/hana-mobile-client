/* tests/tail_serve.test.mjs — 会话尾部快照的命中与刷新
 *
 * 这一层只做三件事：判定该不该管、命中就回包、后台换新。缓存本身由
 * tests/tail_cache.test.mjs 覆盖，所以这里用假缓存，专测「网关什么时候自己回包、
 * 回的是什么状态、什么时候该刷新、什么时候坚决不存」。
 *
 * 全部同步或微任务内完成：刷新用注入的假实现，不碰网络、不睡眠。
 */

import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createTailServe } from '../gateway/tail-serve.mjs';

/* --------------------------- 假缓存 --------------------------- */

function createFakeCache({ entries = new Map() } = {}) {
  const refreshing = new Set();
  const calls = { get: 0, set: 0, beginRefresh: 0, endRefresh: 0 };
  return {
    entries,
    refreshing,
    calls,
    isTailRequest(method, path, query) {
      if (method !== 'GET' || path !== '/api/sessions/messages') return false;
      if (!query.get('sessionId')) return false;
      return !query.get('cursor') && !query.get('before');
    },
    parseTailRequest(method, path, query) {
      if (method !== 'GET' || path !== '/api/sessions/messages') return { ok: false, reason: 'path' };
      const sessionId = query.get('sessionId');
      if (!sessionId) return { ok: false, reason: 'no_session' };
      if (query.get('cursor') || query.get('before')) return { ok: false, reason: 'cursor' };
      const rawLimit = query.get('limit');
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit <= 0 || limit > 200) return { ok: false, reason: 'bad_limit' };
      return { ok: true, sessionId, limit };
    },
    key(cookieHash, sessionId, limit) {
      return `${cookieHash}|${sessionId}|${limit}`;
    },
    get(key) {
      calls.get += 1;
      const entry = entries.get(key);
      if (!entry) return { state: 'miss' };
      return { state: entry.state || 'fresh', entry };
    },
    set(key, body, meta = {}) {
      calls.set += 1;
      entries.set(key, { body: Buffer.from(body), storedAt: Date.now(), ...meta });
      return true;
    },
    beginRefresh(key) {
      calls.beginRefresh += 1;
      if (refreshing.has(key)) return false;
      refreshing.add(key);
      return true;
    },
    endRefresh(key) {
      calls.endRefresh += 1;
      refreshing.delete(key);
    },
  };
}

function makeReq({ method = 'GET', url = '/api/sessions/messages?sessionId=s1&limit=50', cookie = 'sid=abc', acceptEncoding } = {}) {
  const headers = { cookie };
  if (acceptEncoding !== undefined) headers['accept-encoding'] = acceptEncoding;
  return { method, url, headers };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(payload) {
      res.body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''));
    },
  };
  return res;
}

/** 刷新期间排队的微任务：让 scheduleRefresh 里的 then 链跑完。 */
async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/* --------------------------- 用例表 --------------------------- */

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('不相关的请求一律不管：非 GET、别的路径、带游标', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  assert.equal(serve.tryServe(makeReq({ method: 'POST' }), makeRes()), false);
  assert.equal(serve.tryServe(makeReq({ url: '/api/sessions?limit=50' }), makeRes()), false);
  assert.equal(serve.tryServe(makeReq({ url: '/api/sessions/messages?sessionId=s1&before=100' }), makeRes()), false);
});

test('没有快照时交给反代，不写响应', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  const res = makeRes();
  assert.equal(serve.tryServe(makeReq(), res), false);
  assert.equal(res.statusCode, 0);
  assert.equal(res.body, null);
});

test('新鲜快照直接回包：200 + JSON + no-store + fresh 标记', () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ id: 'm1' }] }));
  const cache = createFakeCache();
  const serve = createTailServe({ cache, refresh: () => assert.fail('新鲜的快照不该触发刷新') });
  const req = makeReq();
  cache.entries.set(serve.keyFor(req), { body });
  const res = makeRes();

  assert.equal(serve.tryServe(req, res), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-gw-tail-cache'], 'fresh');
  assert.equal(Number(res.headers['content-length']), body.length);
  assert.equal(res.body.toString(), body.toString());
  assert.equal(cache.calls.beginRefresh, 0);
});

test('旧快照先回包，并在后台刷新替换', async () => {
  const staleBody = Buffer.from(JSON.stringify({ messages: [] }));
  const freshBody = Buffer.from(JSON.stringify({ messages: [{ id: 'm2' }] }));
  const cache = createFakeCache();
  const seen = [];
  const serve = createTailServe({
    cache,
    refresh: async ({ sessionId, limit }) => {
      seen.push([sessionId, limit]);
      return { status: 200, body: freshBody, etag: 'e1' };
    },
  });
  const req = makeReq();
  const key = serve.keyFor(req);
  cache.entries.set(key, { body: staleBody, state: 'stale' });
  const res = makeRes();

  assert.equal(serve.tryServe(req, res), true);
  assert.equal(res.headers['x-gw-tail-cache'], 'stale');
  assert.equal(res.body.toString(), staleBody.toString());

  await flush();
  assert.equal(cache.calls.set, 1);
  assert.equal(cache.calls.endRefresh, 1);
  assert.equal(cache.refreshing.size, 0);
  assert.equal(cache.entries.get(key).body.toString(), freshBody.toString());
  assert.equal(cache.entries.get(key).etag, 'e1');
});

test('同一个键在刷新途中再来请求：只刷新一次', async () => {
  const cache = createFakeCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const serve = createTailServe({
    cache,
    refresh: async () => {
      calls += 1;
      await gate;
      return { status: 200, body: Buffer.from('{"ok":1}') };
    },
  });

  const req = makeReq();
  cache.entries.set(serve.keyFor(req), { body: Buffer.from('{}'), state: 'stale' });
  serve.tryServe(req, makeRes());
  serve.tryServe(req, makeRes());
  await flush(10);
  assert.equal(calls, 1);
  assert.equal(cache.refreshing.size, 1);

  release();
  await flush();
  assert.equal(cache.refreshing.size, 0);
});

test('刷新失败不写缓存：宁可继续用旧快照', async () => {
  const cache = createFakeCache();
  const lines = [];
  const serve = createTailServe({
    cache,
    log: (line) => lines.push(line),
    refresh: async () => { throw new Error('ECONNRESET'); },
  });

  const req = makeReq();
  cache.entries.set(serve.keyFor(req), { body: Buffer.from('{"old":1}'), state: 'stale' });
  serve.tryServe(req, makeRes());
  await flush(6);
  assert.equal(cache.calls.set, 0);
  assert.equal(cache.calls.endRefresh, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ECONNRESET/);
});

test('只缓存 200 + JSON：错误响应与非 JSON 一律不存', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  const req = makeReq();
  const res = makeRes();
  const body = Buffer.from('{"messages":[]}');

  assert.equal(serve.capture(req, res, 502, { 'content-type': 'application/json' }, body), false);
  assert.equal(serve.capture(req, res, 200, { 'content-type': 'text/html' }, body), false);
  assert.equal(serve.capture(req, res, 200, { 'content-type': 'application/json' }, Buffer.alloc(0)), false);
  assert.equal(cache.calls.set, 0);

  assert.equal(serve.capture(req, res, 200, { 'content-type': 'application/json; charset=utf-8' }, body), true);
  assert.equal(cache.calls.set, 1);
});

test('带 gzip 的客户端拿到的响应解压后与快照一致', () => {
  const body = Buffer.from(JSON.stringify({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}` })) }));
  const cache = createFakeCache();
  const serve = createTailServe({ cache, refresh: () => assert.fail('不该刷新') });
  cache.entries.set(serve.keyFor(makeReq()), { body });
  const res = makeRes();

  assert.equal(serve.tryServe(makeReq({ acceptEncoding: 'gzip, deflate' }), res), true);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.equal(gunzipSync(res.body).toString(), body.toString());

  const plain = makeRes();
  assert.equal(serve.tryServe(makeReq({ acceptEncoding: 'gzip;q=0, *' }), plain), true);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), body.toString());
});

test('没有 cookie 也照常工作：键里用空串的哈希', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  const key = serve.keyFor(makeReq({ cookie: '' }));
  assert.ok(key);
  assert.match(key, /^[0-9a-f]{32}\|/);
  assert.equal(key, serve.keyFor(makeReq({ cookie: '' })), '同一个请求算出来的键必须稳定');
});

test('limit 缺省按 50，且 limit / path 不同就是不同的键', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  const base = serve.keyFor(makeReq({ url: '/api/sessions/messages?sessionId=s1' }));
  const explicit = serve.keyFor(makeReq({ url: '/api/sessions/messages?sessionId=s1&limit=50' }));
  const other = serve.keyFor(makeReq({ url: '/api/sessions/messages?sessionId=s1&limit=20' }));
  const withPath = serve.keyFor(makeReq({ url: '/api/sessions/messages?sessionId=s1&path=a.jsonl' }));
  const withOtherPath = serve.keyFor(makeReq({ url: '/api/sessions/messages?sessionId=s1&path=b.jsonl' }));

  assert.equal(base, explicit, '缺省 50 与显式 50 是同一份');
  assert.notEqual(base, other, 'limit 不同不能共用一个键');
  assert.notEqual(withPath, base, '带 path 与不带 path 不是同一份');
  assert.notEqual(withPath, withOtherPath, 'path 不同不是同一份');
});

test('_nc 只绕过读取，不影响写入：这条请求照旧能刷新快照', () => {
  const cache = createFakeCache();
  const serve = createTailServe({ cache });
  const body = Buffer.from('{"messages":[]}');
  const plain = makeReq({ url: '/api/sessions/messages?sessionId=s1&path=p.jsonl' });
  const bypass = makeReq({ url: '/api/sessions/messages?sessionId=s1&path=p.jsonl&_nc=1' });

  // 先存一份，否则下面「命中」无从谈起。
  assert.equal(serve.capture(plain, makeRes(), 200, { 'content-type': 'application/json' }, body), true);
  assert.equal(serve.keyFor(bypass), serve.keyFor(plain), '_nc 不参与键');
  assert.equal(serve.tryServe(bypass, makeRes()), false, '带 _nc 的请求必须走上游');
  assert.equal(serve.tryServe(plain, makeRes()), true, '不带 _nc 的请求照旧命中');
});

/* --------------------------- 跑测 --------------------------- */

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
