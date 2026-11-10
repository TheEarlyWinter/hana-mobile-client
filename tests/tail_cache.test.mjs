/* tests/tail_cache.test.mjs — 网关侧「会话尾部缓存」（gateway/tail-cache.mjs）
 *
 * 纯内存模块，不建 socket、不读文件：所有时间都来自注入的 clock，
 * 任何一个用例都不许 sleep（真定时器会让用例又慢又飘，而且没法测 10 分钟窗口）。
 *
 * 覆盖（父代理给的验收点，一条一个用例，另加几条边界）：
 *   接口契约常量、fresh 命中、stale 窗口、过期变 miss 且条目被删、cookie 隔离、
 *   limit 隔离、非 GET / 路径不符 / 带游标 / limit 非法 / sessionId 为空一律拒绝、
 *   超大 body 拒绝、LRU 按条数与按字节淘汰、刷新互斥、invalidate、stats、
 *   注入时钟推进后的窗口边界、stale entry 指针不被后续 set 串改、etag 存取。
 *
 * 用例注册必须先于跑测：全部 test() 都在文件末尾的 run 之前调用完
 * （历史事故：写在跑测循环之后的用例从未执行，却照样打印 ALL PASS）。
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_FRESH_MS,
  DEFAULT_MAX_STALE_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_BODY_BYTES,
  TAIL_PATH,
  createTailCache,
  isTailRequest,
  parseTailRequest,
} from '../gateway/tail-cache.mjs';

/* --------------------------- 夹具 --------------------------- */

const tests = [];

function test(name, run) {
  tests.push([name, run]);
}

/** 可控时钟：窗口判定全靠它，测试里推进多少就是多少，不受真实时间影响。 */
function createClock(start = 1_000_000) {
  let nowMs = start;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
      return nowMs;
    },
  };
}

function makeCache(options = {}) {
  const clock = createClock(options.startAt ?? 1_000_000);
  const rest = { ...options };
  delete rest.clock;
  delete rest.startAt;
  const cache = createTailCache({ ...rest, now: clock.now });
  return { cache, clock };
}

/** 一条典型的尾部请求：sessionId + path + limit（真机上 path 一直在）。 */
function tailQuery(search = '') {
  return new URLSearchParams(search);
}

const CURSOR_NAMES = ['before', 'after', 'cursor', 'offset', 'until', 'maxId', 'minId', 'anchor'];

/* --------------------------- 契约常量 --------------------------- */

test('默认参数与契约一致：30s 新鲜 / 10min 陈旧 / 64 条 / 8MB 总量 / 2MB 单条', () => {
  assert.equal(DEFAULT_FRESH_MS, 30_000);
  assert.equal(DEFAULT_MAX_STALE_MS, 600_000);
  assert.equal(DEFAULT_MAX_ENTRIES, 64);
  assert.equal(DEFAULT_MAX_TOTAL_BYTES, 8 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_BODY_BYTES, 2 * 1024 * 1024);
  assert.equal(TAIL_PATH, '/api/sessions/messages');
});

test('不传 options 时实际窗口就是默认常量（29.999s 新鲜、30.001s 已 stale）', () => {
  const { cache, clock } = makeCache();
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, 'body');

  clock.advance(DEFAULT_FRESH_MS - 1);
  assert.equal(cache.get(key).state, 'fresh');

  clock.advance(2);
  assert.equal(cache.get(key).state, 'stale');

  clock.advance(DEFAULT_MAX_STALE_MS - DEFAULT_FRESH_MS);
  assert.equal(cache.get(key).state, 'miss', '超过 10 分钟就当没有');
});

/* --------------------------- key --------------------------- */

test('key 稳定、16 位 hex，且 cookieHash / sessionId / limit 三段各自隔离', () => {
  const { cache } = makeCache();

  const base = cache.key('cookie-a', 'sess-1', 50);
  assert.match(base, /^[0-9a-f]{16}$/, 'key 必须是 sha256 前 16 hex');
  assert.equal(cache.key('cookie-a', 'sess-1', 50), base, '同样的输入必须得到同样的 key');

  assert.notEqual(cache.key('cookie-b', 'sess-1', 50), base, '换 cookie 必须换 key');
  assert.notEqual(cache.key('cookie-a', 'sess-2', 50), base, '换 session 必须换 key');
  assert.notEqual(cache.key('cookie-a', 'sess-1', 100), base, '换 limit 必须换 key');

  // 分隔符撞车：`a` + `b|c` 和 `a|b` + `c` 之类不能拼成同一个 key。
  assert.notEqual(cache.key('c', 'a\nb', 50), cache.key('c\n', 'a\nb', 50));
  assert.notEqual(cache.key('c', 'x', 50), cache.key('c', 'x\n', 50));
});

/* --------------------------- 命中与窗口 --------------------------- */

test('fresh 命中：返回 body 原文，hits 加一，不重复发上游', () => {
  const { cache, clock } = makeCache();
  const key = cache.key('cookie', 'sess', 50);

  assert.equal(cache.set(key, Buffer.from('{"messages":[1,2,3]}', 'utf8')), true);

  const hit = cache.get(key);
  assert.equal(hit.state, 'fresh');
  assert.ok(Buffer.isBuffer(hit.entry.body), 'entry.body 必须是 Buffer');
  assert.equal(hit.entry.body.toString('utf8'), '{"messages":[1,2,3]}');
  assert.equal(hit.entry.bytes, 20);

  clock.advance(1_000);
  const again = cache.get(key);
  assert.equal(again.state, 'fresh');
  assert.equal(again.entry, hit.entry, '同一条没有被重存时 entry 指针应保持不变');

  const s = cache.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.stores, 1);
  assert.equal(s.misses, 0);
});

test('stale 窗口内命中：状态是 stale，但仍拿得到旧 body（先回旧内容再后台刷新）', () => {
  const { cache, clock } = makeCache({ freshMs: 1_000, maxStaleMs: 10_000 });
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, '{"messages":[]}');

  clock.advance(5_000);
  const hit = cache.get(key);
  assert.equal(hit.state, 'stale');
  assert.equal(hit.entry.body.toString('utf8'), '{"messages":[]}');

  const s = cache.stats();
  assert.equal(s.staleHits, 1);
  assert.equal(s.hits, 0, 'stale 命中不能算进 hits');
  assert.equal(s.entries, 1, 'stale 命中不能把条目弄丢');
});

test('超过 maxStaleMs 变 miss，并且条目当场被删掉（不再占字节）', () => {
  const { cache, clock } = makeCache({ freshMs: 1_000, maxStaleMs: 5_000 });
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, '{"messages":[]}');
  assert.equal(cache.stats().bytes, Buffer.byteLength('{"messages":[]}'));

  clock.advance(5_001);
  assert.equal(cache.get(key).state, 'miss');
  assert.equal(cache.size, 0, '过期条目必须被删除');
  assert.equal(cache.stats().bytes, 0, '字节预算必须跟着退回来');

  assert.equal(cache.get(key).state, 'miss', '第二条同样是 miss');
  assert.equal(cache.stats().misses, 2);
});

test('注入时钟推进后不误判：freshMs / maxStaleMs 两个边界各差 1ms 都判对', () => {
  const { cache, clock } = makeCache({ freshMs: 100, maxStaleMs: 300 });
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, 'v');

  clock.advance(100);
  assert.equal(cache.get(key).state, 'fresh', '正好 freshMs：按约定算新鲜');

  clock.advance(1);
  assert.equal(cache.get(key).state, 'stale', 'freshMs + 1ms：进 stale 窗口');

  clock.advance(199); // 累计 300，正好 maxStaleMs
  assert.equal(cache.get(key).state, 'stale', '正好 maxStaleMs：仍可当 stale 用');

  clock.advance(1); // 累计 301
  assert.equal(cache.get(key).state, 'miss', 'maxStaleMs + 1ms：必须当没有');
  assert.equal(cache.size, 0);
});

test('时钟回拨不把新鲜内容判成过期（http server 时钟抖动不至于清表）', () => {
  const { cache, clock } = makeCache({ freshMs: 1_000, maxStaleMs: 5_000 });
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, 'v');

  clock.advance(2_000); // 先到 stale
  assert.equal(cache.get(key).state, 'stale');

  clock.advance(-5_000); // 时间源回拨
  assert.equal(cache.get(key).state, 'fresh');
  assert.equal(cache.size, 1);
});

/* --------------------------- 请求判定 --------------------------- */

test('只认 GET：POST / HEAD / PUT / 小写 get / 缺失 method 全部拒绝', () => {
  const q = tailQuery('sessionId=sess-1&limit=50');
  assert.equal(isTailRequest('GET', TAIL_PATH, q), true, '夹具：GET 必须能进');

  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'get', 'Get', ' GET', '']) {
    assert.equal(isTailRequest(method, TAIL_PATH, q), false, `method=${JSON.stringify(method)} 不该进缓存`);
  }
  assert.equal(isTailRequest(undefined, TAIL_PATH, q), false);
  assert.equal(isTailRequest(null, TAIL_PATH, q), false);
});

test('路径必须正好是 /api/sessions/messages：结尾斜杠、多一层、大小写、带 ? 的整串都不算', () => {
  const q = tailQuery('sessionId=sess-1&limit=50');
  assert.equal(isTailRequest('GET', '/api/sessions/messages', q), true);

  for (const wrong of [
    '/api/sessions/messages/',
    '/api/sessions/message',
    '/api/sessions/messages/extra',
    '/api/sessions/messages?sessionId=sess-1&limit=50',
    '/API/sessions/messages',
    '/api/sessions/mess%61ges',
    '/gw/api/sessions/messages',
    'api/sessions/messages',
    '',
    '/',
  ]) {
    assert.equal(isTailRequest('GET', wrong, q), false, `path=${JSON.stringify(wrong)} 不该进缓存`);
  }
  assert.equal(isTailRequest('GET', null, q), false);
  assert.equal(isTailRequest('GET', undefined, q), false);
});

test('带任何分页游标一律拒绝（8 个参数 × 大小写不敏感，值写成空也算出现）', () => {
  for (const name of CURSOR_NAMES) {
    for (const variant of [name, name.toLowerCase(), name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`]) {
      const q = new URLSearchParams({ sessionId: 'sess-1', limit: '50' });
      q.set(variant, '42');
      assert.equal(
        isTailRequest('GET', TAIL_PATH, q),
        false,
        `游标 ${variant}=42 必须拒绝（翻历史不能走尾部缓存）`,
      );
    }
    const empty = new URLSearchParams({ sessionId: 'sess-1', limit: '50' });
    empty.set(name, '');
    assert.equal(isTailRequest('GET', TAIL_PATH, empty), false, `游标 ${name}= 空值也算出现，必须拒绝`);
  }
});

test('非游标参数不影响判定：真机上一直带着的 path 必须放行', () => {
  const q = tailQuery(
    `sessionId=sess-1&path=${encodeURIComponent('C:/Users/x/.hana/sessions/abc.jsonl')}&limit=50`,
  );
  assert.equal(isTailRequest('GET', TAIL_PATH, q), true);

  const parsed = parseTailRequest('GET', TAIL_PATH, q);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, 'sess-1');
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.path, undefined, '返回值只给 sessionId/limit，path 不参与 key');
});

test('limit 非法一律拒绝：0 / 负数 / 小数 / 科学计数 / 超过 200 / 非数字 / 空格 / 空值', () => {
  for (const bad of ['0', '-1', '1.5', '1e2', '201', '1000', '', 'abc', ' 50', '50 ', '+50', '0x10', '50.0']) {
    const q = new URLSearchParams({ sessionId: 'sess-1', limit: bad });
    assert.equal(isTailRequest('GET', TAIL_PATH, q), false, `limit=${JSON.stringify(bad)} 不该进缓存`);
  }
  // 边界内必须放行：1 和 200 都是合法页大小
  for (const good of ['1', '50', '200']) {
    assert.equal(isTailRequest('GET', TAIL_PATH, new URLSearchParams({ sessionId: 'sess-1', limit: good })), true);
  }
});

test('limit 缺省按 50；写成 050 归一到 50，因此和缺省共用同一个 key', () => {
  const missing = parseTailRequest('GET', TAIL_PATH, tailQuery('sessionId=sess-1'));
  assert.equal(missing.ok, true);
  assert.equal(missing.limit, 50);

  const padded = parseTailRequest('GET', TAIL_PATH, tailQuery('sessionId=sess-1&limit=050'));
  assert.equal(padded.ok, true);
  assert.equal(padded.limit, 50, 'leading zero 要归一成数值，不能原样当 key');

  const { cache } = makeCache();
  assert.equal(
    cache.key('cookie', missing.sessionId, missing.limit),
    cache.key('cookie', padded.sessionId, padded.limit),
  );
});

test('sessionId 必填：缺参 / 空串 / 纯空白都拒绝', () => {
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('limit=50')), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=&limit=50')), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=%20%20&limit=50')), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=sess-1&limit=50')), true);
  // 前后有空白的 id 不裁切：裁了会把两个不同 id 并成一个 key
  const parsed = parseTailRequest('GET', TAIL_PATH, tailQuery('sessionId=%20sess-1&limit=50'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, ' sess-1');
});

test('同一个参数重复且值不同：拒绝（谁生效取决于上游，缓存不能赌）', () => {
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=a&sessionId=b&limit=50')), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=a&limit=50&limit=100')), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, tailQuery('sessionId=a&sessionId=a&limit=50')), true);
});

test('实例上也带判定函数，与模块级导出是同一对（接线层手里只有实例）', () => {
  const { cache } = makeCache();
  assert.equal(cache.isTailRequest, isTailRequest);
  assert.equal(cache.parseTailRequest, parseTailRequest);

  const q = tailQuery('sessionId=sess-1&limit=50');
  assert.equal(cache.isTailRequest('GET', TAIL_PATH, q), true);
  assert.equal(cache.isTailRequest('POST', TAIL_PATH, q), false);
  assert.equal(cache.parseTailRequest('GET', TAIL_PATH, q).limit, 50);
});

test('query 形状不对（不是 URLSearchParams）不缓存，也不抛', () => {
  assert.equal(isTailRequest('GET', TAIL_PATH, null), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, undefined), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, {}), false);
  assert.equal(isTailRequest('GET', TAIL_PATH, 'sessionId=a&limit=50'), false);
});

/* --------------------------- 存取边界 --------------------------- */

test('超大 body 拒绝：按 UTF-8 字节算，不是字符数；恰好等于上限要收下', () => {
  const { cache } = makeCache({ maxBodyBytes: 8 });
  const key = cache.key('cookie', 'sess', 50);

  assert.equal(cache.set(key, 'x'.repeat(9)), false, '超过 8 字节必须拒');
  assert.equal(cache.size, 0, '被拒的 body 不能留下任何条目');
  assert.equal(cache.stats().stores, 0);

  assert.equal(cache.set(key, Buffer.alloc(9)), false, 'Buffer 也一样');
  assert.equal(cache.set(key, '汉字汉'), false, '9 个字节（3 个汉字）必须拒');

  assert.equal(cache.set(key, '汉字'), true, '6 字节要收下');
  assert.equal(cache.size, 1);
  assert.equal(cache.get(key).entry.bytes, 6, 'bytes 必须是 UTF-8 字节数');

  assert.equal(cache.set(key, 'x'.repeat(8)), true, '正好等于上限要收下');
  assert.equal(cache.stats().bytes, 8);
});

test('空 body 与非 Buffer/string 一律拒绝', () => {
  const { cache } = makeCache();
  const key = cache.key('cookie', 'sess', 50);

  assert.equal(cache.set(key, ''), false);
  assert.equal(cache.set(key, Buffer.alloc(0)), false);
  assert.equal(cache.set(key, null), false);
  assert.equal(cache.set(key, undefined), false);
  assert.equal(cache.set(key, 123), false);
  assert.equal(cache.set(key, { messages: [] }), false);
  assert.equal(cache.set(key, new Uint8Array([1, 2])), false, '只收 Buffer 和 string，不做隐式转换');
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().stores, 0);
});

test('字符串 body 按 UTF-8 存成 Buffer；etag 原样存下，缺省是空串', () => {
  const { cache } = makeCache();
  const withEtag = cache.key('cookie', 'sess', 50);
  const noEtag = cache.key('cookie', 'sess', 100);

  cache.set(withEtag, '汉字', { etag: 'W/"deadbeefdeadbeef"' });
  cache.set(noEtag, 'plain');

  const hit = cache.get(withEtag);
  assert.ok(Buffer.isBuffer(hit.entry.body));
  assert.equal(hit.entry.body.toString('utf8'), '汉字');
  assert.equal(hit.entry.etag, 'W/"deadbeefdeadbeef"');

  assert.equal(cache.get(noEtag).entry.etag, '');
  assert.equal(typeof cache.stats().bytes, 'number');
});

test('覆盖同一个 key 不重复计字节，storedAt 也跟着刷新', () => {
  const { cache, clock } = makeCache({ freshMs: 100, maxStaleMs: 1_000, maxBodyBytes: 200 });
  const key = cache.key('cookie', 'sess', 50);

  cache.set(key, 'x'.repeat(40));
  assert.equal(cache.stats().bytes, 40);

  cache.set(key, 'x'.repeat(20));
  assert.equal(cache.size, 1);
  assert.equal(cache.stats().bytes, 20, '旧 body 的字节必须退回');
  assert.equal(cache.stats().stores, 2);

  clock.advance(90);
  assert.equal(cache.get(key).state, 'fresh', 'storedAt 必须跟着新内容一起刷新');
});

test('单条超过整个总预算时直接说存不下（不留一条永远超预算的条目）', () => {
  const { cache } = makeCache({ maxTotalBytes: 10, maxBodyBytes: 100 });
  const key = cache.key('cookie', 'sess', 50);

  assert.equal(cache.set(key, 'x'.repeat(11)), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.set(key, 'x'.repeat(10)), true);
  assert.equal(cache.stats().bytes, 10);
});

/* --------------------------- LRU 淘汰 --------------------------- */

test('LRU 按条数淘汰：get 也算访问，被 get 过的那条不会被先删', () => {
  const { cache } = makeCache({ maxEntries: 2 });
  const a = cache.key('cookie', 'a', 50);
  const b = cache.key('cookie', 'b', 50);
  const c = cache.key('cookie', 'c', 50);

  assert.equal(cache.set(a, 'A'), true);
  assert.equal(cache.set(b, 'B'), true);
  cache.get(a); // 触碰 a，最久没用的变成 b

  assert.equal(cache.set(c, 'C'), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.get(b).state, 'miss', '最久未访问的 b 应被淘汰');
  assert.equal(cache.get(a).state, 'fresh', '刚访问过的 a 必须留着');
  assert.equal(cache.get(c).state, 'fresh');

  const s = cache.stats();
  assert.equal(s.entries, 2);
  assert.equal(s.evictions, 1);
});

test('LRU 按字节淘汰：不超条数、只超总字节时也从最久未访问的删起', () => {
  const { cache } = makeCache({ maxEntries: 8, maxTotalBytes: 100, maxBodyBytes: 1_000 });
  const a = cache.key('cookie', 'a', 50);
  const b = cache.key('cookie', 'b', 50);
  const c = cache.key('cookie', 'c', 50);

  cache.set(a, 'x'.repeat(40));
  cache.set(b, 'x'.repeat(40));
  assert.equal(cache.stats().bytes, 80);

  cache.get(a); // 触碰 a，最久没用的是 b
  cache.set(c, 'x'.repeat(40)); // 120 > 100 → 淘汰 b → 80

  assert.equal(cache.size, 2);
  assert.equal(cache.stats().bytes, 80, '淘汰后字节必须回到预算内');
  assert.equal(cache.get(b).state, 'miss');
  assert.equal(cache.get(a).state, 'fresh');
  assert.equal(cache.get(c).state, 'fresh');
  assert.equal(cache.stats().evictions, 1);
});

test('字节淘汰会连删多条直到回到预算内', () => {
  const { cache } = makeCache({ maxEntries: 8, maxTotalBytes: 100, maxBodyBytes: 1_000 });
  const keys = ['a', 'b', 'c', 'd'].map((name) => cache.key('cookie', name, 50));
  for (const key of keys) cache.set(key, 'x'.repeat(30)); // 30 字节 × 4 = 120 → 需要删 1 条
  assert.equal(cache.size, 3);
  assert.equal(cache.stats().bytes, 90);
  assert.equal(cache.stats().evictions, 1);

  cache.set(cache.key('cookie', 'e', 50), 'x'.repeat(60)); // 90 + 60 = 150 → 删到 <= 100
  assert.equal(cache.stats().bytes, 90, '删掉了两条 30 字节的，剩最后一条 60 + 一条 30');
  assert.equal(cache.size, 2);
});

/* --------------------------- 刷新互斥 --------------------------- */

test('beginRefresh 同一 key 互斥，不同 key 各自独立，endRefresh 后可重来', () => {
  const { cache } = makeCache();
  const key = cache.key('cookie', 'sess', 50);
  const other = cache.key('cookie', 'sess', 100);

  assert.equal(cache.beginRefresh(key), true);
  assert.equal(cache.beginRefresh(key), false, '同一 key 已在刷：不能再起一个');

  assert.equal(cache.beginRefresh(other), true, '不同 key 互不影响');

  cache.endRefresh(key);
  assert.equal(cache.beginRefresh(key), true, 'endRefresh 之后可以再起');

  cache.endRefresh(key);
  cache.endRefresh(key); // 重复 end 不该抛
  assert.equal(cache.beginRefresh(key), true);
});

test('beginRefresh 不需要条目存在（刷新可能先于首次落盘），非法 key 返回 false', () => {
  const { cache } = makeCache();
  const key = cache.key('cookie', 'missing', 50);

  assert.equal(cache.size, 0);
  assert.equal(cache.beginRefresh(key), true);
  assert.equal(cache.beginRefresh(''), false);
  assert.equal(cache.beginRefresh(null), false);
});

/* --------------------------- 作废与清空 --------------------------- */

test('invalidate 清缓存与刷新标记：删完立刻能重新起刷新，返回值区分有没有条目', () => {
  const { cache } = makeCache();
  const key = cache.key('cookie', 'sess', 50);

  cache.set(key, 'v');
  assert.equal(cache.beginRefresh(key), true);

  assert.equal(cache.invalidate(key), true, '有条目被删时返回 true');
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.get(key).state, 'miss');

  assert.equal(cache.beginRefresh(key), true, 'invalidate 必须同时清掉刷新标记');

  cache.endRefresh(key);
  assert.equal(cache.invalidate(key), false, '没有条目时返回 false');
});

test('clear 清空条目与刷新标记，但累计计数保留（诊断量不随内容清空归零）', () => {
  const { cache } = makeCache();
  const a = cache.key('cookie', 'a', 50);
  const b = cache.key('cookie', 'b', 50);

  cache.set(a, 'A');
  cache.set(b, 'B');
  cache.get(a);
  cache.beginRefresh(b);
  assert.equal(cache.size, 2);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().bytes, 0);
  assert.equal(cache.stats().stores, 2, 'stores 是累计量，clear 不清');
  assert.equal(cache.stats().hits, 1, 'hits 是累计量，clear 不清');
  assert.equal(cache.beginRefresh(b), true, 'clear 必须同时清掉刷新标记');
});

/* --------------------------- stats --------------------------- */

test('stats 计数正确：miss / store / hit / staleHit / 过期删除 / 淘汰各算一次', () => {
  let storedAt = 5_000;
  const cache = createTailCache({
    freshMs: 100,
    maxStaleMs: 300,
    maxEntries: 1,
    now: () => storedAt,
  });
  const a = cache.key('cookie', 'a', 50);
  const b = cache.key('cookie', 'b', 50);

  assert.deepEqual(cache.stats(), {
    entries: 0,
    bytes: 0,
    hits: 0,
    staleHits: 0,
    misses: 0,
    stores: 0,
    evictions: 0,
  });

  assert.equal(cache.get(a).state, 'miss'); // misses 1
  cache.set(a, 'body'); // stores 1, bytes 4

  assert.equal(cache.get(a).state, 'fresh'); // hits 1
  storedAt += 150;
  assert.equal(cache.get(a).state, 'stale'); // staleHits 1

  storedAt += 1_000;
  assert.equal(cache.get(a).state, 'miss'); // misses 2，条目被删

  cache.set(a, 'body'); // stores 2
  cache.set(b, 'other'); // stores 3，maxEntries=1 → 淘汰 a → evictions 1

  assert.deepEqual(cache.stats(), {
    entries: 1,
    bytes: 5,
    hits: 1,
    staleHits: 1,
    misses: 2,
    stores: 3,
    evictions: 1,
  });
  assert.equal(cache.size, 1);
});

/* --------------------------- 指针稳定性 --------------------------- */

test('stale 拿到的 entry 指针不会被后续 set 串改（可以安全地异步写回）', () => {
  const { cache, clock } = makeCache({ freshMs: 100, maxStaleMs: 10_000 });
  const key = cache.key('cookie', 'sess', 50);

  cache.set(key, 'v1-old', { etag: 'W/"1"' });
  clock.advance(200);

  const stale = cache.get(key);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.entry.body.toString('utf8'), 'v1-old');

  cache.set(key, 'v2-brand-new-content', { etag: 'W/"2"' });

  assert.equal(stale.entry.body.toString('utf8'), 'v1-old', '旧指针必须还指向旧内容');
  assert.equal(stale.entry.etag, 'W/"1"');
  assert.equal(stale.entry.bytes, Buffer.byteLength('v1-old'));
  assert.equal(cache.get(key).entry.body.toString('utf8'), 'v2-brand-new-content');
  assert.equal(cache.stats().bytes, Buffer.byteLength('v2-brand-new-content'));
});

test('entry 是冻结的只读快照：改它必须抛错（避免有人就地改缓存）', () => {
  const { cache } = makeCache();
  const key = cache.key('cookie', 'sess', 50);
  cache.set(key, 'v', { etag: 'W/"a"' });

  const { entry } = cache.get(key);
  assert.equal(Object.isFrozen(entry), true);
  assert.throws(() => {
    entry.etag = 'W/"b"';
  }, TypeError);
  assert.throws(() => {
    entry.storedAt = 0;
  }, TypeError);
  assert.equal(cache.get(key).entry.etag, 'W/"a"', '缓存里的值不能被外部改掉');
});

/* --------------------------- 运行 --------------------------- */

let failed = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

if (failed > 0) {
  console.log(`\nFAILED (${failed} tests failed)`);
  process.exit(1);
} else {
  console.log(`\nALL PASS（${tests.length} 个用例）`);
}
