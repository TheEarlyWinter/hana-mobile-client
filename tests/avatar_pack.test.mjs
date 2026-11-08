/* tests/avatar_pack.test.mjs
 *
 * gateway/avatar-pack.mjs（`GET /api/mobile/avatars` 头像聚合）的单元与网关端到端测试。
 *
 * 覆盖：
 * 1. 纯逻辑：ids 解析（空、超 32、非法字符、`user` 特例、去重保序、去空）、
 *    id → 上游路径、content-type → data URL、etag 生成与弱比较、路由精确匹配、
 *    以及各项硬上限常量（32 / 128KB / 1.5MB / 5s / 6 并发）。
 * 2. 抓取行为（真起一个假上游 http server，注入 upstream 地址）：
 *    正常返回 data URL、content-type 原样写进 data URL、单张超限进 skipped、
 *    上游 403 / 非图片 → skipped 不冒泡、总预算截断（注入小预算 + 真实 1.5MB）、
 *    并发不超过 6、超时进 skipped、条件请求头不转发给上游、热缓存不再打上游。
 * 3. 真网关（spawn gateway/server.mjs，假上游兼作登录态 + 头像源）：
 *    未带 Cookie → 与 denyRead 一致的拒绝且不问上游；带 Cookie → 200 +
 *    cache-control/etag；同 etag → 304 无 body 且不再拉头像；400（bad_ids/bad_id）、
 *    405（HEAD/POST）；不同 Cookie 不串缓存；鉴权先于 304。
 *
 * 变异自检（手工验证，改代码后必须有用例变红）：
 *   - 去掉 304 提前返回            → 「同 etag 再请求 → 304」与「304 不再拉头像」变红；
 *   - 去掉单张上限判断             → 「单张超限进 skipped」变红；
 *   - 去掉总预算判断               → 「总预算截断」变红；
 *   - 去掉点段（. / ..）拒绝        → 「点段 . / .. 额外拒绝」「ids 参数错误」变红；
 *   - 去掉并发上限（width 用 items.length）→ 「并发不超过 6」变红。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_CACHE_MAX_ENTRIES,
  AVATAR_FETCH_CONCURRENCY,
  AVATAR_PACK_PATH,
  AVATAR_UPSTREAM_TIMEOUT_MS,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_IDS,
  MAX_AVATAR_PACK_BYTES,
  USER_AVATAR_ID,
  createAvatarPack,
  etagForBody,
  etagMatches,
  isAvatarPackPath,
  normalizeImageMime,
  parseAvatarIds,
  toDataUrl,
  upstreamPathForAvatarId,
} from '../gateway/avatar-pack.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GATEWAY = path.join(ROOT, 'gateway', 'server.mjs');

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
/* 1. 纯逻辑                                                           */
/* ------------------------------------------------------------------ */

await t('parseAvatarIds：缺省/空串/只有逗号/超 32 → bad_ids', () => {
  for (const raw of [undefined, null, 42, '', '   ', ',,,', ' , , ']) {
    assert.deepEqual(parseAvatarIds(raw), { ok: false, status: 400, error: 'bad_ids' }, `输入 ${JSON.stringify(raw)}`);
  }
  const at32 = Array.from({ length: 32 }, (_, i) => `a${i}`).join(',');
  assert.equal(parseAvatarIds(at32).ok, true, '32 个正好是上限，必须放行');
  const at33 = Array.from({ length: 33 }, (_, i) => `a${i}`).join(',');
  assert.deepEqual(parseAvatarIds(at33), { ok: false, status: 400, error: 'bad_ids' }, '33 个必须 400');
});

await t('parseAvatarIds：去重复、保序、去空，重复项不计入上限', () => {
  assert.deepEqual(parseAvatarIds(' b , a ,, b '), { ok: true, ids: ['b', 'a'] });
  // 40 个原始项里只有 32 个不同 id：去重后再判上限
  const raw = [...Array.from({ length: 32 }, (_, i) => `d${i}`), ...Array.from({ length: 8 }, (_, i) => `d${i}`)].join(',');
  const parsed = parseAvatarIds(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ids.length, 32);
  assert.equal(parsed.ids[0], 'd0');
  assert.equal(parsed.ids[31], 'd31');
});

await t('parseAvatarIds：非法字符 → bad_id（不静默丢弃）', () => {
  for (const raw of ['a/b', 'a b', 'a?b', 'a%2fb', 'ok,a/b', '头像', 'a'.repeat(65), 'a\nb']) {
    assert.deepEqual(parseAvatarIds(raw), { ok: false, status: 400, error: 'bad_id' }, `输入 ${JSON.stringify(raw)}`);
  }
  // 允许的字符集与长度边界
  assert.equal(parseAvatarIds('a'.repeat(64)).ok, true, '64 个字符是上限');
  assert.equal(parseAvatarIds('A-z_0.9:').ok, true, '点/冒号/下划线/短横都允许');
});

await t('parseAvatarIds：user 是字面量特例，位置任意且去重', () => {
  assert.deepEqual(parseAvatarIds('user'), { ok: true, ids: ['user'] });
  assert.deepEqual(parseAvatarIds('cat,user,user'), { ok: true, ids: ['cat', 'user'] });
  assert.equal(USER_AVATAR_ID, 'user');
});

await t('parseAvatarIds：点段 . / .. 额外拒绝（正则放行，网关有意收紧）', () => {
  assert.deepEqual(parseAvatarIds('.'), { ok: false, status: 400, error: 'bad_id' });
  assert.deepEqual(
    parseAvatarIds('..'),
    { ok: false, status: 400, error: 'bad_id' },
    '.. 会拼出 /api/agents/../avatar，上游会把它归一化成 /api/avatar',
  );
  assert.deepEqual(parseAvatarIds('cat,..'), { ok: false, status: 400, error: 'bad_id' }, '混在合法 id 里也要显式 400');
  // 只拒绝恰好是点段的 id：含点的普通 id 照常放行
  assert.equal(parseAvatarIds('studio.owner').ok, true);
  assert.equal(parseAvatarIds('a.b').ok, true);
  assert.equal(parseAvatarIds('...').ok, true, '三个点不是点段，仍按正则放行');
});

await t('upstreamPathForAvatarId：user 走 /api/avatar/user，其余按 agent 头像拼并转义', () => {
  assert.equal(upstreamPathForAvatarId('user'), '/api/avatar/user');
  assert.equal(upstreamPathForAvatarId('cat'), '/api/agents/cat/avatar');
  assert.equal(upstreamPathForAvatarId('a:b'), '/api/agents/a%3Ab/avatar');
  assert.equal(upstreamPathForAvatarId('studio.owner'), '/api/agents/studio.owner/avatar');
});

await t('normalizeImageMime / toDataUrl：content-type 原样进 data URL，非 image/* 拒绝', () => {
  assert.equal(normalizeImageMime('image/png'), 'image/png');
  assert.equal(normalizeImageMime(' IMAGE/PNG '), 'IMAGE/PNG', '只去首尾空白，大小写原样');
  assert.equal(normalizeImageMime('image/jpeg; charset=binary'), 'image/jpeg;charset=binary', '参数保留、分隔符后空白去掉');
  for (const value of ['text/html', 'application/json', 'image/', '', undefined, 42]) {
    assert.equal(normalizeImageMime(value), null, `应拒绝 ${JSON.stringify(value)}`);
  }
  assert.equal(normalizeImageMime(['image/webp']), 'image/webp', '数组形式取第一个');
  assert.equal(toDataUrl('image/png', Buffer.from('hi')), 'data:image/png;base64,aGk=');
});

await t('etag：弱 etag 形状、同 body 同值、弱比较与列表/星号', () => {
  const etag = etagForBody('{"a":1}');
  assert.match(etag, /^W\/"[0-9a-f]{16}"$/);
  assert.equal(etagForBody('{"a":1}'), etag, '同 body 必须同 etag');
  assert.notEqual(etagForBody('{"a":2}'), etag);

  assert.equal(etagMatches(etag, etag), true);
  assert.equal(etagMatches(etag.replace('W/', ''), etag), true, '强形式也命中（弱比较）');
  assert.equal(etagMatches(`"other", ${etag}`, etag), true, '列表里任一项命中即可');
  assert.equal(etagMatches('*', etag), true);
  assert.equal(etagMatches('W/"0000000000000000"', etag), false);
  assert.equal(etagMatches('', etag), false);
  assert.equal(etagMatches(undefined, etag), false);
});

await t('isAvatarPackPath：只认精确路径，前后缀与编码别名都不算', () => {
  assert.equal(isAvatarPackPath('/api/mobile/avatars'), true);
  assert.equal(isAvatarPackPath('/api/mobile/avatars?ids=a,b'), true);
  assert.equal(isAvatarPackPath('/api/mobile/avatars/'), false, '结尾斜杠不是同一条路由');
  assert.equal(isAvatarPackPath('/api/mobile/avatarsX'), false);
  assert.equal(isAvatarPackPath('/api/mobile/avatar%73'), false, '编码别名交给反代，不在这里猜');
  assert.equal(isAvatarPackPath('/api/agents/cat/avatar'), false);
  assert.equal(isAvatarPackPath('http://evil/api/mobile/avatars'), false, '绝对形式不参与');
  assert.equal(isAvatarPackPath(undefined), false);
  assert.equal(AVATAR_PACK_PATH, '/api/mobile/avatars');
});

await t('契约常量：32 个 id / 128KB 单张 / 1.5MB 整包 / 5s 超时 / 6 并发 / 64 条缓存', () => {
  assert.equal(MAX_AVATAR_IDS, 32);
  assert.equal(MAX_AVATAR_BYTES, 128 * 1024);
  assert.equal(MAX_AVATAR_PACK_BYTES, 1536 * 1024);
  assert.equal(AVATAR_UPSTREAM_TIMEOUT_MS, 5_000);
  assert.equal(AVATAR_FETCH_CONCURRENCY, 6);
  assert.equal(AVATAR_CACHE_MAX_ENTRIES, 64);
});

/* ------------------------------------------------------------------ */
/* 夹具：假上游（单元级） / 假上游（网关级） / 真网关                    */
/* ------------------------------------------------------------------ */

const PNG_OK = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** 总预算用例用的单张原始字节数（< 128KB 单张上限）。 */
const BULK_IMAGE_BYTES = 120 * 1024;
const CONCURRENCY_DELAY_MS = 20;

/** 单元用例的假上游：记录每个请求的路径与关键头，按 id 造不同结果。 */
let unitUpstream;
let unitPort;
const unitSeen = [];
let unitInflight = 0;
let unitMaxInflight = 0;

function sendImage(res, contentType, bytes) {
  res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
  res.end(bytes);
}

function unitUpstreamHandler(req, res) {
  // 客户端提前断开（超限/超时）时写 socket 会 EPIPE：不接住就是一个未捕获 'error'。
  res.on('error', () => {});
  const pathname = new URL(req.url, 'http://x').pathname;
  unitSeen.push({
    pathname,
    cookie: req.headers.cookie,
    accept: req.headers.accept,
    ifNoneMatch: req.headers['if-none-match'],
    userAgent: req.headers['user-agent'],
  });

  if (pathname === '/api/avatar/user') {
    sendImage(res, 'image/jpeg', Buffer.from('user-jpeg-bytes'));
    return;
  }
  const match = /^\/api\/agents\/([^/]+)\/avatar$/.exec(pathname);
  if (!match) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('no such avatar');
    return;
  }
  const id = decodeURIComponent(match[1]);
  if (id === 'ok') return sendImage(res, 'image/png', PNG_OK);
  if (id === 'mime') return sendImage(res, 'image/jpeg; charset=binary', Buffer.from('mime-body'));
  if (id === 'big') return sendImage(res, 'image/png', Buffer.alloc(MAX_AVATAR_BYTES + 1, 1));
  if (id === 'html') return sendImage(res, 'text/html; charset=utf-8', Buffer.from('<html>nope</html>'));
  if (id === 'forbidden') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  if (id === 'hang') {
    // 永不回应：等客户端 5s（测试注入更短）超时把连接拆掉。
    return;
  }
  if (id.startsWith('c')) {
    unitInflight += 1;
    unitMaxInflight = Math.max(unitMaxInflight, unitInflight);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unitInflight -= 1;
    };
    res.on('finish', release);
    res.on('close', release);
    setTimeout(() => {
      if (!res.writableEnded) sendImage(res, 'image/png', Buffer.from(`png:${id}`));
    }, CONCURRENCY_DELAY_MS);
    return;
  }
  if (/^r\d+$/.test(id)) return sendImage(res, 'image/png', Buffer.alloc(BULK_IMAGE_BYTES, 0x41));
  if (/^t\d+$/.test(id)) return sendImage(res, 'image/png', Buffer.alloc(2000, 2));
  return sendImage(res, 'image/png', Buffer.from(`png:${id}`));
}

async function startUnitUpstream() {
  unitUpstream = http.createServer(unitUpstreamHandler);
  unitPort = await listen(unitUpstream, 0);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

/* 网关用例的假上游：兼作登录态与头像源，记录头像请求次数。 */
let gwUpstream;
let gwUpstreamPort;
const gwPaths = [];
const gwImageHits = [];
let gwSessionHits = 0;

function gwUpstreamHandler(req, res) {
  res.on('error', () => {});
  const url = new URL(req.url, 'http://x');
  gwPaths.push(url.pathname);
  if (url.pathname === '/api/web-auth/session') {
    gwSessionHits += 1;
    if (!req.headers.cookie) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"authenticated":false}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"authenticated":true,"principal":null}');
    return;
  }
  if (url.pathname === '/api/avatar/user') {
    gwImageHits.push('user');
    sendImage(res, 'image/jpeg', Buffer.from('gw-user-jpeg'));
    return;
  }
  const match = /^\/api\/agents\/([^/]+)\/avatar$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (id === 'ghost') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('no such agent');
      return;
    }
    gwImageHits.push(id);
    sendImage(res, 'image/png', Buffer.from(`gw-png:${id}`));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

async function startGwUpstream() {
  gwUpstream = http.createServer(gwUpstreamHandler);
  gwUpstreamPort = await listen(gwUpstream, 0);
}

/* 真网关 */
let gatewayPort = 0;
let gatewayChild = null;
let gatewayLog = '';
let tmpRoot = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 等网关能连上：不依赖日志文案，直接打一个静态资源。 */
function waitGateway(port, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      gatewayRequest(port, '/index.html')
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) reject(new Error(`gateway 未就绪\n${gatewayLog}`));
          else setTimeout(attempt, 100);
        });
    };
    attempt();
  });
}

function gatewayRequest(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: rawPath, headers: { connection: 'close', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

async function startGateway() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-avatar-pack-'));
  const port = await freePort();
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HANA_GATEWAY_LOG: 'off',
      HANA_HOME: path.join(tmpRoot, 'hana-home'),
      HANA_UPSTREAM_HOST: '127.0.0.1',
      HANA_UPSTREAM_PORT: String(gwUpstreamPort),
      HANA_GW_HOST: '127.0.0.1',
      HANA_GW_PORT: String(port),
      HANA_GW_LOG_WS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gatewayChild = child;
  child.stdout.on('data', (c) => {
    gatewayLog += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    gatewayLog += c.toString('utf8');
  });
  child.once('error', (err) => {
    gatewayLog += `[spawn error] ${err.message}\n`;
  });
  gatewayPort = port;
  await waitGateway(port);
}

async function teardown() {
  if (gatewayChild && gatewayChild.exitCode === null) gatewayChild.kill();
  for (const server of [unitUpstream, gwUpstream]) {
    if (!server) continue;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* 单元级：套在假 req/res 上跑 handle，验证抓取/缓存/序列化             */
/* ------------------------------------------------------------------ */

function unitPack(overrides = {}) {
  return createAvatarPack({
    upstream: { host: '127.0.0.1', port: unitPort },
    // 鉴权路径由网关级用例覆盖，这里只测抓取与序列化。
    checkAuth: async () => ({ ok: true }),
    deny: (res) => {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('deny');
    },
    ...overrides,
  });
}

function fakeReq(url, { method = 'GET', cookie = 'sid=unit', ifNoneMatch, userAgent } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch;
  if (userAgent) headers['user-agent'] = userAgent;
  return { method, url, headers, socket: {}, resume() {} };
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers = {}) {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) res.body += String(chunk);
      res.writableEnded = true;
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return res;
}

/** 走一次 handle；ids 传 undefined 表示不带 query。 */
async function callPack(pack, ids, options = {}) {
  const url = ids === undefined ? AVATAR_PACK_PATH : `${AVATAR_PACK_PATH}?ids=${encodeURIComponent(ids)}`;
  const res = fakeRes();
  await pack.handle(fakeReq(url, options), res);
  let json = null;
  if (res.body) json = JSON.parse(res.body);
  return { status: res.status, headers: res.headers, body: res.body, json };
}

let serversReady = false;
try {
  await startUnitUpstream();
  await startGwUpstream();
  await startGateway();
  serversReady = true;
} catch (err) {
  bad += 1;
  console.log(`FAIL  setup\n      ${err.stack || err.message}`);
}

if (serversReady) {
  await t('抓取：正常返回 data URL，user 走 /api/avatar/user，只带 cookie/accept/user-agent', async () => {
    const pack = unitPack();
    const before = unitSeen.length;
    const res = await callPack(pack, 'ok,user', { cookie: 'sid=unit', userAgent: 'hana-test/1' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
    assert.match(res.headers.etag, /^W\/"[0-9a-f]{16}"$/);
    assert.deepEqual(Object.keys(res.json.avatars), ['ok', 'user'], '顺序按请求里的 id');
    assert.equal(res.json.avatars.ok, `data:image/png;base64,${PNG_OK.toString('base64')}`);
    assert.equal(res.json.avatars.user, `data:image/jpeg;base64,${Buffer.from('user-jpeg-bytes').toString('base64')}`);
    assert.deepEqual(res.json.skipped, []);

    const seen = unitSeen.slice(before);
    assert.deepEqual(
      seen.map((hit) => hit.pathname).sort(),
      ['/api/agents/ok/avatar', '/api/avatar/user'],
    );
    for (const hit of seen) {
      assert.equal(hit.cookie, 'sid=unit', 'Cookie 必须转发（上游鉴权的唯一凭据）');
      assert.equal(hit.accept, 'image/*');
      assert.equal(hit.userAgent, 'hana-test/1');
      assert.equal(hit.ifNoneMatch, undefined, '条件请求头绝不能转发给上游');
    }
  });

  await t('抓取：上游 content-type 原样写进 data URL（含参数）', async () => {
    const pack = unitPack();
    const res = await callPack(pack, 'mime');
    assert.equal(res.status, 200);
    assert.equal(
      res.json.avatars.mime,
      `data:image/jpeg;charset=binary;base64,${Buffer.from('mime-body').toString('base64')}`,
    );
  });

  await t('抓取：单张超过 128KB 进 skipped，不报错也不影响同批其它 id', async () => {
    const pack = unitPack();
    const res = await callPack(pack, 'big,ok');
    assert.equal(res.status, 200, '超限是「跳过」而不是错误状态');
    assert.deepEqual(res.json.skipped, ['big']);
    assert.deepEqual(Object.keys(res.json.avatars), ['ok']);
    assert.equal(Buffer.from(res.json.avatars.ok.split(',')[1], 'base64').length, PNG_OK.length);
  });

  await t('抓取：上游 403 / 非 image content-type → skipped，不往上冒泡', async () => {
    const pack = unitPack();
    const res = await callPack(pack, 'forbidden,html,ok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.skipped, ['forbidden', 'html']);
    assert.deepEqual(Object.keys(res.json.avatars), ['ok']);
  });

  await t('抓取：总预算超限时从超限那张起剩下的都进 skipped（注入小预算）', async () => {
    const pack = unitPack({ maxPackBytes: 6000 });
    // 每个 data URL 约 22 + 2668 = 2690 字节：两张 5380 过得去，第三张会超 6000
    const res = await callPack(pack, 't1,t2,t3');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json.avatars), ['t1', 't2']);
    assert.deepEqual(res.json.skipped, ['t3'], '超限那张及其后的都进 skipped');
  });

  await t('抓取：真实 1.5MB 整包上限——12×120KB 只装下 9 张，后 3 张进 skipped', async () => {
    const pack = unitPack();
    const ids = Array.from({ length: 12 }, (_, i) => `r${i + 1}`).join(',');
    const res = await callPack(pack, ids);
    assert.equal(res.status, 200);
    const kept = Object.keys(res.json.avatars);
    assert.equal(kept.length, 9, `1.5MB 只装得下 9 张 120KB 的图，实际 ${kept.length}`);
    assert.deepEqual(kept, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    assert.deepEqual(res.json.skipped, ['r10', 'r11', 'r12']);
    const total = kept.reduce((sum, id) => sum + Buffer.byteLength(res.json.avatars[id]), 0);
    assert.ok(total <= MAX_AVATAR_PACK_BYTES, `拼出来的 data URL 总量 ${total} 不能超上限`);
    assert.ok(total + Buffer.byteLength(res.json.avatars.r1) > MAX_AVATAR_PACK_BYTES, '再多一张必然超限');
  });

  await t('抓取：并发不超过 6（12 个 id 同时抓）', async () => {
    unitMaxInflight = 0;
    const pack = unitPack();
    const ids = Array.from({ length: 12 }, (_, i) => `c${i + 1}`).join(',');
    const res = await callPack(pack, ids);
    assert.equal(res.status, 200);
    assert.equal(Object.keys(res.json.avatars).length, 12, '12 个都该成功');
    assert.ok(unitMaxInflight <= AVATAR_FETCH_CONCURRENCY, `在途请求数 ${unitMaxInflight} 超过 ${AVATAR_FETCH_CONCURRENCY}`);
    assert.ok(unitMaxInflight >= 2, `应当并发抓取（实际最多 ${unitMaxInflight} 个在途）`);
  });

  await t('抓取：上游超时 → skipped，同批其它 id 照常返回', async () => {
    // 注入 120ms 超时（默认 5s 由常量用例锁住），避免用例等 5 秒。
    const pack = unitPack({ timeoutMs: 120 });
    const startedAt = Date.now();
    const res = await callPack(pack, 'hang,ok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.skipped, ['hang']);
    assert.deepEqual(Object.keys(res.json.avatars), ['ok']);
    assert.ok(Date.now() - startedAt < 3000, '要按注入的超时收尾，不能挂着');
  });

  await t('抓取：热缓存——第二次请求 0 次上游，304 判定不重新拉图', async () => {
    const pack = unitPack();
    const first = await callPack(pack, 'ok,user');
    assert.equal(first.status, 200);
    const etag = first.headers.etag;

    const before = unitSeen.length;
    const second = await callPack(pack, 'ok,user');
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, first.json, '缓存命中必须拼出同样的 body');
    assert.equal(second.headers.etag, etag, '同 body 同 etag');
    assert.equal(unitSeen.length, before, '第二次请求不能再打上游');

    const third = await callPack(pack, 'ok,user', { ifNoneMatch: etag });
    assert.equal(third.status, 304);
    assert.equal(third.body, '');
    assert.equal(third.headers.etag, etag);
    assert.equal(unitSeen.length, before, '304 判定只走本地缓存');
  });

  await t('抓取：缓存按 Cookie 身份隔离，不同账号不串', async () => {
    const pack = unitPack();
    await callPack(pack, 'ok', { cookie: 'sid=alice' });
    const before = unitSeen.length;
    const other = await callPack(pack, 'ok', { cookie: 'sid=bob' });
    assert.equal(other.status, 200);
    assert.equal(unitSeen.length, before + 1, '换账号必须重新去上游取，不能读别人的缓存');

    const again = await callPack(pack, 'ok', { cookie: 'sid=bob' });
    assert.equal(again.status, 200);
    assert.equal(unitSeen.length, before + 1, 'bob 自己再请求则命中缓存');
    assert.equal(pack.cacheSize(), 2, '两个身份的条目都在缓存里');
  });

  await t('抓取：缓存条数上限 64（LRU 淘汰最久未用的）', async () => {
    const pack = unitPack();
    const ids = Array.from({ length: 65 }, (_, i) => `k${i}`);
    // 分两批（单批上限 32）把 65 个 id 都塞进缓存
    await callPack(pack, ids.slice(0, 32).join(','));
    await callPack(pack, ids.slice(33, 65).join(','));
    await callPack(pack, 'k32');
    assert.equal(pack.cacheSize(), AVATAR_CACHE_MAX_ENTRIES, '缓存条数必须停在 64');
  });

  await t('抓取：非 GET → 405 且带 allow: GET', async () => {
    const pack = unitPack();
    const res = await callPack(pack, 'ok', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
    assert.deepEqual(res.json, { error: 'method_not_allowed' });
  });

  await t('抓取：ids 参数错误 → 400 且该批一次上游都不打', async () => {
    const pack = unitPack();
    const before = unitSeen.length;
    const empty = await callPack(pack, '');
    assert.deepEqual({ status: empty.status, json: empty.json }, { status: 400, json: { error: 'bad_ids' } });

    const missing = await callPack(pack, undefined);
    assert.deepEqual({ status: missing.status, json: missing.json }, { status: 400, json: { error: 'bad_ids' } });

    const tooMany = await callPack(pack, Array.from({ length: 33 }, (_, i) => `i${i}`).join(','));
    assert.deepEqual({ status: tooMany.status, json: tooMany.json }, { status: 400, json: { error: 'bad_ids' } });

    const badId = await callPack(pack, 'ok,a/b');
    assert.deepEqual({ status: badId.status, json: badId.json }, { status: 400, json: { error: 'bad_id' } });

    const dotSegment = await callPack(pack, 'ok,..');
    assert.deepEqual(
      { status: dotSegment.status, json: dotSegment.json },
      { status: 400, json: { error: 'bad_id' } },
    );

    assert.equal(unitSeen.length, before, '参数不合法时不该问上游');
  });

  /* ------------------------------------------------------------------ */
  /* 网关级：真进程 + 真 HTTP，验证鉴权/路由/响应头/304                   */
  /* ------------------------------------------------------------------ */

  const AVATARS = `${AVATAR_PACK_PATH}?ids=`;

  await t('网关：未带 Cookie → 401，形状与 denyRead 一致，且不问上游登录态', async () => {
    const before = gwSessionHits;
    const res = await gatewayRequest(gatewayPort, `${AVATARS}cat`);
    assert.equal(res.status, 401);
    assert.equal(res.body, 'unauthorized');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(gwSessionHits, before, '没有 Cookie 时不该问上游');
  });

  await t('网关：带 Cookie → 200 + 正确响应头，头像请求数等于 id 数', async () => {
    const before = gwImageHits.length;
    const res = await gatewayRequest(gatewayPort, `${AVATARS}${encodeURIComponent('cat,user')}`, {
      headers: { cookie: 'sid=one' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
    assert.match(res.headers.etag, /^W\/"[0-9a-f]{16}"$/);
    const payload = JSON.parse(res.body);
    assert.deepEqual(Object.keys(payload.avatars), ['cat', 'user']);
    assert.match(payload.avatars.cat, /^data:image\/png;base64,/);
    assert.match(payload.avatars.user, /^data:image\/jpeg;base64,/);
    assert.deepEqual(payload.skipped, []);
    assert.deepEqual(gwImageHits.slice(before).sort(), ['cat', 'user']);
    assert.ok(!gwPaths.includes('/api/mobile/avatars'), '不能被当成 /api 反代出去');
  });

  await t('网关：同 etag 再请求 → 304 无 body，且不再拉头像（只多一次登录态确认）', async () => {
    const first = await gatewayRequest(gatewayPort, `${AVATARS}dog`, { headers: { cookie: 'sid=one' } });
    assert.equal(first.status, 200);
    const etag = first.headers.etag;

    const imageHitsBefore = gwImageHits.length;
    const second = await gatewayRequest(gatewayPort, `${AVATARS}dog`, {
      headers: { cookie: 'sid=one', 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(second.body, '', '304 不能带 body');
    assert.equal(second.headers.etag, etag, '304 要回同一条 etag');
    assert.equal(second.headers['cache-control'], 'private, max-age=60');
    assert.equal(gwImageHits.length, imageHitsBefore, '304 判定只走本地缓存，不能再拉头像');
  });

  await t('网关：etag 不匹配 → 200 带 body（不是无条件 304）', async () => {
    const res = await gatewayRequest(gatewayPort, `${AVATARS}dog`, {
      headers: { cookie: 'sid=one', 'if-none-match': 'W/"0000000000000000"' },
    });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.body).avatars.dog, '不命中就得给完整 body');
  });

  await t('网关：鉴权先于 304——没 Cookie 时即使 etag 命中也是 401', async () => {
    const warm = await gatewayRequest(gatewayPort, `${AVATARS}dog`, { headers: { cookie: 'sid=one' } });
    const res = await gatewayRequest(gatewayPort, `${AVATARS}dog`, {
      headers: { 'if-none-match': warm.headers.etag },
    });
    assert.equal(res.status, 401, '不能靠 etag 绕过鉴权');
    assert.equal(res.body, 'unauthorized');
  });

  await t('网关：不同 Cookie 不串缓存（同 id 会重新拉一次）', async () => {
    const before = gwImageHits.length;
    const res = await gatewayRequest(gatewayPort, `${AVATARS}cat`, { headers: { cookie: 'sid=two' } });
    assert.equal(res.status, 200);
    assert.deepEqual(gwImageHits.slice(before), ['cat'], '换账号必须重新取图');
    const again = await gatewayRequest(gatewayPort, `${AVATARS}cat`, { headers: { cookie: 'sid=two' } });
    assert.equal(again.status, 200);
    assert.equal(gwImageHits.length, before + 1, '同一账号第二次命中缓存');
  });

  await t('网关：400 bad_ids / bad_id 由网关直接返回，不进反代', async () => {
    const before = gwImageHits.length;
    const empty = await gatewayRequest(gatewayPort, `${AVATARS}`, { headers: { cookie: 'sid=one' } });
    assert.equal(empty.status, 400);
    assert.deepEqual(JSON.parse(empty.body), { error: 'bad_ids' });

    const tooMany = await gatewayRequest(
      gatewayPort,
      `${AVATARS}${encodeURIComponent(Array.from({ length: 33 }, (_, i) => `x${i}`).join(','))}`,
      { headers: { cookie: 'sid=one' } },
    );
    assert.equal(tooMany.status, 400);
    assert.deepEqual(JSON.parse(tooMany.body), { error: 'bad_ids' });

    const badId = await gatewayRequest(gatewayPort, `${AVATARS}${encodeURIComponent('cat,./evil')}`, {
      headers: { cookie: 'sid=one' },
    });
    assert.equal(badId.status, 400);
    assert.deepEqual(JSON.parse(badId.body), { error: 'bad_id' });
    assert.equal(gwImageHits.length, before, '参数不合法时不该拉头像');
  });

  await t('网关：只接 GET——HEAD / 同源 POST 都是 405', async () => {
    const head = await gatewayRequest(gatewayPort, `${AVATARS}cat`, { method: 'HEAD', headers: { cookie: 'sid=one' } });
    assert.equal(head.status, 405);
    assert.equal(head.headers.allow, 'GET');

    const post = await gatewayRequest(gatewayPort, `${AVATARS}cat`, {
      method: 'POST',
      headers: { cookie: 'sid=one', origin: `http://127.0.0.1:${gatewayPort}` },
    });
    assert.equal(post.status, 405, '同源写请求过 Origin 校验后，由端点自己回 405');
    assert.deepEqual(JSON.parse(post.body), { error: 'method_not_allowed' });
  });

  await t('网关：上游 404 的 id 进 skipped，同批其它头像照常返回', async () => {
    // 网关侧假上游只认识 agent id 与 user；一个不存在的 id 会 404 → skipped，而不是整批失败。
    const res = await gatewayRequest(gatewayPort, `${AVATARS}${encodeURIComponent('ghost,user')}`, {
      headers: { cookie: 'sid=one' },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.skipped, ['ghost']);
    assert.deepEqual(Object.keys(payload.avatars), ['user']);
  });
}

await teardown();

console.log(`\n${bad ? `${bad} 个用例失败` : '全部通过'}`);
if (bad && gatewayLog) console.log(`\n--- gateway log ---\n${gatewayLog.slice(-2000)}`);
process.exitCode = bad ? 1 : 0;
