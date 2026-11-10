/* tests/avatar_cache.test.mjs
 *
 * gateway/avatar-cache.mjs（头像缩放缓存）的纯单测：不起端口、不连网络。
 *
 * 为什么必须离线：这条链路要证明的正是「不依赖上游也能把头像发出去」——
 * 缓存命中时一个上游请求都不该发。所以这里注入假的 fetchUpstream / checkAuth，
 * 用一个只有 writeHead/end/destroy 的假响应对象（纯 WHATWG 形状，不监听任何端口），
 * 图片夹具用 sharp 现场生成（1024×1024 噪声 PNG ≈ 3MB，和真机上的原图同一量级）。
 *
 * 覆盖：
 * 1. 路由判定：命中的两种形态 + 十几种不命中的形态（大小写、多一层路径、空 id、
 *    编码斜杠、查询串、`.`/`..`、超长、`/api/agents/user/avatar` 的命名冲突）。
 * 2. 首次请求：回源一次 → 200 + image/webp + 5 分钟缓存 + etag + content-length，
 *    缓存文件按 `<id>-<原图哈希>.webp` 落盘，字节与响应一致，体积显著小于原图。
 * 3. 二次请求：命中索引，**fetchUpstream 计数不增加**；If-None-Match 命中回 304（无 body）；
 *    HEAD 回 200 但只写头不写 body。
 * 4. 失败一律退回「不处理」：上游 404/500/抛错/非 Buffer/坏图（sharp 抛错）→
 *    handle 返回 false、没写任何响应、也没落下坏缓存文件。
 * 5. 鉴权：401 走 denyRead 回 401 且不回源；鉴权服务不可用（503）交回反代。
 * 6. `/api/avatar/user` 按账号隔离：不同 Cookie 不会拿到彼此的头像。
 * 7. 同 id 旧文件清理（最多留 2 份）、内容未变不重编码、缓存文件被手工删掉后自动重建、
 *    缓存目录不可写时仍然照常出图（只是不缓存）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  AVATAR_CACHE_FILES_PER_ID,
  DEFAULT_AVATAR_CACHE_DIR,
  createAvatarCache,
  matchAvatarPath,
} from '../gateway/avatar-cache.mjs';

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

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-avatar-cache-'));
process.on('exit', () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // 临时目录清不掉不影响结论
  }
});
let caseNo = 0;
async function caseDir() {
  caseNo += 1;
  const dir = path.join(ROOT, `case-${caseNo}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* 夹具与假请求/响应                                                   */
/* ------------------------------------------------------------------ */

/**
 * 1024×1024 的确定性噪声 PNG。用噪声而不是纯色：纯色 PNG 本身就很小，
 * 量不出「原图 → WebP」的真实差距；手机上的头像都是照片类内容。
 */
function noiseRaw(size, seed) {
  const buf = Buffer.allocUnsafe(size * size * 3);
  // xorshift32：取高位字节。LCG 的低位周期很短，直接用低位会让 PNG 压到几十 KB，
  // 夹具就失真了（我们要的是「和真机原图同一量级」的 1~3MB）。
  let x = seed >>> 0 || 0x9e3779b9;
  for (let i = 0; i < buf.length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = (x >>> 16) & 0xff;
  }
  return buf;
}

async function makePng(seed) {
  return sharp(noiseRaw(1024, seed), { raw: { width: 1024, height: 1024, channels: 3 } })
    .png()
    .toBuffer();
}

const PNG_A = await makePng(20260101);
const PNG_B = await makePng(19700101);
const PNG_C = await makePng(5551212);

/** 与模块内部同口径：文件名里的原图内容哈希（sha256 前 16 位 hex）。 */
function hash16(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function makeReq({ method = 'GET', url = '/api/agents/hanako/avatar', headers = {} } = {}) {
  return { method, url, headers: { cookie: 'hana_session=abc', ...headers } };
}

/**
 * 只会被网关用到的四个成员：headersSent / writableEnded / writeHead / end / destroy。
 * 不监听端口，不碰 socket。
 */
function makeRes() {
  const state = { status: 0, headers: null, body: null, ended: false, destroyed: false, error: null };
  const res = {
    destroyed: false,
    get headersSent() {
      return state.status !== 0;
    },
    get writableEnded() {
      return state.ended;
    },
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? {};
      return res;
    },
    end(body) {
      state.ended = true;
      if (body !== undefined) state.body = body;
      return res;
    },
    destroy(err) {
      res.destroyed = true;
      state.destroyed = true;
      if (err) state.error = err;
    },
  };
  return { res, state };
}

/** 固定「已登录」的鉴权桩：绝大多数用例只关心缓存行为。 */
const allowAuth = async () => ({ ok: true, principal: { kind: 'owner' } });

async function listCacheFiles(dir) {
  try {
    return (await fsp.readdir(dir)).filter((name) => name.endsWith('.webp')).sort();
  } catch {
    return [];
  }
}

/** 建一个缓存实例：注入回源计数与自定义上游。 */
function makeCache({ dir, fetchUpstream, ...rest } = {}) {
  const calls = { count: 0, ids: [] };
  const cache = createAvatarCache({
    cacheDir: dir,
    checkAuth: allowAuth,
    fetchUpstream: async (id, ctx) => {
      calls.count += 1;
      calls.ids.push(id);
      return fetchUpstream(id, ctx);
    },
    ...rest,
  });
  return { cache, calls };
}

/* ------------------------------------------------------------------ */
/* 1. 路由判定                                                         */
/* ------------------------------------------------------------------ */

await t('matchAvatarPath：两种命中形态', () => {
  assert.deepEqual(matchAvatarPath('/api/agents/hanako/avatar'), { id: 'hanako', kind: 'agent' });
  assert.deepEqual(matchAvatarPath('/api/avatar/user'), { id: 'user', kind: 'user' });
  // 带连字符/下划线/点的 agent id（宿主真实 id 是 agent-xxxx 形态）
  assert.deepEqual(matchAvatarPath('/api/agents/agent-mqb7zal0/avatar'), {
    id: 'agent-mqb7zal0',
    kind: 'agent',
  });
  assert.deepEqual(matchAvatarPath('/api/agents/a.b_c:d/avatar'), { id: 'a.b_c:d', kind: 'agent' });
  // 百分号编码的合法 id：解码后仍要通过同一套 id 规则
  assert.deepEqual(matchAvatarPath('/api/agents/hana%2Dko/avatar'), { id: 'hana-ko', kind: 'agent' });
  // id 的大小写是内容的一部分，原样保留
  assert.deepEqual(matchAvatarPath('/api/agents/Hanako/avatar'), { id: 'Hanako', kind: 'agent' });
  // 空查询串是等价 URL（`?` 后面什么都没有）：与上游资源一致，照常命中
  assert.deepEqual(matchAvatarPath('/api/agents/hanako/avatar?'), { id: 'hanako', kind: 'agent' });
});

await t('matchAvatarPath：不命中的形态一律返回 null', () => {
  const noMatch = [
    '/api/agent/x/avatar', // 少一个 s
    '/api/agents/x/avatars', // 后缀不对
    '/api/agents//avatar', // 空 id
    '/api/agents/x/avatar/', // 尾斜杠
    '/api/agents/x/y/avatar', // 多一层
    '/api/agents/x//avatar', // id 带斜杠
    '/api/agents/../avatar', // URL 归一化后变成 /api/avatar，不再命中
    '/api/agents/./avatar', // 同上
    '/api/agents/%2E%2E/avatar', // 编码的点段，解码后被 id 规则拒掉
    '/api/agents/x%2Fy/avatar', // 编码斜杠
    '/api/agents/%zz/avatar', // 坏编码
    '/api/agents/user/avatar', // 与 /api/avatar/user 的文件名前缀冲突，故意不加速
    '/API/agents/x/avatar', // 路由大小写敏感
    '/api/Agents/x/avatar',
    '/api/avatar/User',
    '/api/avatar/user/extra',
    '/api/agents/x/avatar?v=2', // 带查询串
    '/api/avatar/user?x=1',
    '/api/agents/x/avatar#frag',
    '/api/agents/x/avatar%20', // 尾随空白
    '/api/agents/%20x/avatar', // trim 之后才合法的 id 不算同一个 id
    `/api/agents/${'a'.repeat(65)}/avatar`, // 超长
    '', // 空串
    'api/agents/x/avatar', // 非 origin-form
    'http://evil.example/api/agents/x/avatar',
    '/api/agents/x/avatar\nHost: evil', // 头注入形态
    null,
    undefined,
    42,
  ];
  for (const url of noMatch) {
    assert.equal(matchAvatarPath(url), null, `不应命中：${JSON.stringify(url)}`);
  }
});

await t('DEFAULT_AVATAR_CACHE_DIR 指向 gateway/cache/avatars', () => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(
    DEFAULT_AVATAR_CACHE_DIR,
    path.resolve(moduleDir, '..', 'gateway', 'cache', 'avatars'),
  );
  assert.deepEqual(DEFAULT_AVATAR_CACHE_DIR.split(path.sep).slice(-2), ['cache', 'avatars']);
});

/* ------------------------------------------------------------------ */
/* 2. 首次请求：回源 → 缩放 → 写盘 → 回 WebP                            */
/* ------------------------------------------------------------------ */

await t('首次请求：回源一次，回 200 image/webp，按 <id>-<原图哈希>.webp 落盘', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  const { res, state } = makeRes();

  const handled = await cache.handle(makeReq(), res);

  assert.equal(handled, true, '命中路由就该由缓存层处理');
  assert.equal(calls.count, 1, '首次请求必须回源一次');
  assert.deepEqual(calls.ids, ['hanako']);
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-type'], 'image/webp');
  assert.equal(state.headers['cache-control'], 'public, max-age=300', '不能发 immutable：URL 稳定但内容会变，换头像就永远刷不到');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.match(state.headers.etag, /^"[0-9a-f]{16}"$/);
  assert.ok(Buffer.isBuffer(state.body));
  assert.equal(state.headers['content-length'], state.body.length);
  // 真的是一张 WebP：RIFF....WEBP
  assert.equal(state.body.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(state.body.subarray(8, 12).toString('latin1'), 'WEBP');

  const files = await listCacheFiles(dir);
  assert.deepEqual(files, [`hanako-${hash16(PNG_A)}.webp`], '文件名 = <id>-<原图 sha256 前 16 位>.webp');
  const onDisk = await fsp.readFile(path.join(dir, files[0]));
  assert.deepEqual(onDisk, state.body, '磁盘上的字节必须就是发出去的那份');
  // etag 是产物内容的哈希，和文件名里的原图哈希不同（换缩放参数时才能正确失效）
  assert.equal(state.headers.etag, `"${hash16(state.body)}"`);
});

await t('缩放后体积显著小于原图（1024×1024 PNG → 长边 256 WebP）', async () => {
  const dir = await caseDir();
  const { cache } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  const { res, state } = makeRes();
  await cache.handle(makeReq({ url: '/api/agents/size/avatar' }), res);

  const out = state.body;
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);
  console.log(
    `      原图 ${PNG_A.length} B → WebP ${out.length} B（${(PNG_A.length / out.length).toFixed(1)}× 更小）`,
  );
  // 只断言「显著更小」，不定死具体字节数（WebP 编码器版本会变）
  assert.ok(PNG_A.length > 500 * 1024, `夹具要够大才有说服力，实际 ${PNG_A.length} B`);
  assert.ok(out.length * 4 < PNG_A.length, `${out.length} B 应该远小于 ${PNG_A.length} B`);
});

await t('maxPx / quality 可注入：128px + q50 的产物比默认更小', async () => {
  const dir = await caseDir();
  const { cache } = makeCache({
    dir,
    maxPx: 128,
    quality: 50,
    fetchUpstream: async () => ({ ok: true, bytes: PNG_A }),
  });
  const { res, state } = makeRes();
  await cache.handle(makeReq(), res);
  const meta = await sharp(state.body).metadata();
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 128);
});

/* ------------------------------------------------------------------ */
/* 3. 命中：不回源、304、HEAD                                          */
/* ------------------------------------------------------------------ */

await t('二次请求命中缓存：不再调用 fetchUpstream，字节与 etag 完全一致', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });

  const first = makeRes();
  await cache.handle(makeReq(), first.res);
  const second = makeRes();
  const handled = await cache.handle(makeReq(), second.res);

  assert.equal(handled, true);
  assert.equal(calls.count, 1, '命中磁盘缓存后不能再回源');
  assert.equal(second.state.status, 200);
  assert.deepEqual(second.state.body, first.state.body);
  assert.equal(second.state.headers.etag, first.state.headers.etag);
  assert.deepEqual(await listCacheFiles(dir), [`hanako-${hash16(PNG_A)}.webp`], '命中不该多写文件');
});

await t('If-None-Match 命中 → 304 且不带 body（弱/强/列表/* 都认）', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  const warm = makeRes();
  await cache.handle(makeReq(), warm.res);
  const etag = warm.state.headers.etag;
  const token = etag.slice(1, -1); // 去掉引号

  for (const inm of [etag, `W/${etag}`, token, `"deadbeefdeadbeef", ${etag}`, '*']) {
    const { res, state } = makeRes();
    const handled = await cache.handle(makeReq({ headers: { 'if-none-match': inm } }), res);
    assert.equal(handled, true);
    assert.equal(state.status, 304, `if-none-match: ${inm} 应该 304`);
    assert.equal(state.body, null, '304 不能有 body');
    assert.equal(state.headers.etag, etag);
    // 304 也必须带同一份缓存策略：否则浏览器会把「没带策略」当成默认值，重算一遍新鲜度。
    assert.equal(state.headers['cache-control'], 'public, max-age=300');
  }

  // 不匹配的 etag 照常回 200 全量
  const stale = makeRes();
  await cache.handle(makeReq({ headers: { 'if-none-match': '"0000000000000000"' } }), stale.res);
  assert.equal(stale.state.status, 200);
  assert.deepEqual(stale.state.body, warm.state.body);
  assert.equal(calls.count, 1, '304 判定只用本地缓存，不该回源');
});

await t('HEAD：回 200 + 完整 content-length，但不写 body', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  const { res, state } = makeRes();
  const handled = await cache.handle(makeReq({ method: 'HEAD' }), res);

  assert.equal(handled, true);
  assert.equal(state.status, 200);
  assert.equal(state.ended, true);
  assert.equal(state.body, null, 'HEAD 不能写 body');
  assert.equal(state.headers['content-type'], 'image/webp');
  assert.ok(state.headers['content-length'] > 0);
  // HEAD 也算一次正常请求：首次仍回源并落盘，第二次不再回源
  assert.equal(calls.count, 1);
  const again = makeRes();
  await cache.handle(makeReq({ method: 'HEAD' }), again.res);
  assert.equal(calls.count, 1);
});

await t('非 GET/HEAD → 不处理（交给反代，不在这里发明 405）', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const { res, state } = makeRes();
    const handled = await cache.handle(makeReq({ method }), res);
    assert.equal(handled, false, `${method} 不该被缓存层处理`);
    assert.equal(state.status, 0);
    assert.equal(state.ended, false);
  }
  assert.equal(calls.count, 0);
});

await t('未命中的 URL 形态 → 不处理且不写响应', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  for (const url of ['/api/sessions', '/api/agents/x/avatar?v=2', '/api/avatar/user/extra', '/api/agents/user/avatar']) {
    const { res, state } = makeRes();
    const handled = await cache.handle(makeReq({ url }), res);
    assert.equal(handled, false, `${url} 不该被缓存层处理`);
    assert.equal(state.status, 0);
  }
  assert.equal(calls.count, 0);
});

/* ------------------------------------------------------------------ */
/* 4. 任何失败都退回「不处理」                                          */
/* ------------------------------------------------------------------ */

await t('上游 404 / 500 / 无返回 / 抛错 / 非 Buffer → false，不写响应也不写坏缓存', async () => {
  const cases = [
    ['上游 404', async () => ({ ok: false, status: 404 })],
    ['上游 500', async () => ({ ok: false, status: 500 })],
    ['上游返回 undefined', async () => undefined],
    ['上游 ok:false 没带状态', async () => ({ ok: false })],
    ['上游抛错', async () => { throw new Error('ECONNREFUSED'); }],
    ['bytes 不是 Buffer', async () => ({ ok: true, bytes: 'not-a-buffer' })],
    ['bytes 是空 Buffer', async () => ({ ok: true, bytes: Buffer.alloc(0) })],
  ];

  for (const [label, fetchImpl] of cases) {
    const dir = await caseDir();
    const { cache } = makeCache({ dir, fetchUpstream: fetchImpl });
    const { res, state } = makeRes();
    const handled = await cache.handle(makeReq(), res);
    assert.equal(handled, false, `${label}：必须交回原代理`);
    assert.equal(state.status, 0, `${label}：不该写任何响应`);
    assert.equal(state.ended, false);
    assert.deepEqual(await listCacheFiles(dir), [], `${label}：不该留下缓存文件`);
  }
});

await t('坏图（sharp 编码失败）→ false，且不落盘', async () => {
  const dir = await caseDir();
  const garbage = Buffer.from('this is definitely not an image, not even close'.repeat(20), 'utf8');
  const { cache } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: garbage }) });
  const { res, state } = makeRes();
  const handled = await cache.handle(makeReq(), res);

  assert.equal(handled, false);
  assert.equal(state.status, 0);
  assert.equal(state.ended, false);
  assert.deepEqual(await listCacheFiles(dir), [], '缩放失败的图不能进缓存');

  // 同一张坏图再请求一次：仍然退回原代理，不是发一个空 200
  const again = makeRes();
  assert.equal(await cache.handle(makeReq(), again.res), false);
  assert.equal(again.state.status, 0);
});

await t('缓存目录不可写：照常出图（returns true），只是不落缓存', async () => {
  const dir = await caseDir();
  // 把「目录」位置上放一个普通文件，mkdir 必然失败
  const blocker = path.join(dir, 'blocked');
  await fsp.writeFile(blocker, 'not a directory');
  const cacheDir = path.join(blocker, 'avatars');

  const { cache } = makeCache({ dir: cacheDir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  const { res, state } = makeRes();
  const handled = await cache.handle(makeReq(), res);

  assert.equal(handled, true, '写不了盘也必须把头发出');
  assert.equal(state.status, 200);
  assert.equal(state.headers['content-type'], 'image/webp');
  const meta = await sharp(state.body).metadata();
  assert.equal(meta.format, 'webp');
});

/* ------------------------------------------------------------------ */
/* 5. 鉴权                                                             */
/* ------------------------------------------------------------------ */

await t('未登录（401）→ 直接拒绝，不回源；鉴权服务不可用 → 交回反代', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });

  const denied = makeRes();
  const deniedCache = createAvatarCache({
    cacheDir: dir,
    checkAuth: async () => ({ ok: false, status: 401, reason: 'unauthenticated' }),
    fetchUpstream: async () => {
      calls.count += 1;
      return { ok: true, bytes: PNG_A };
    },
  });
  assert.equal(await deniedCache.handle(makeReq(), denied.res), true);
  assert.equal(denied.state.status, 401);
  assert.equal(calls.count, 0, '没登录就不该去上游取图');

  // 鉴权服务本身挂了：不在这里造 503 文本，交回反代走它自己的错误契约
  const unavailable = makeRes();
  const brokenAuth = createAvatarCache({
    cacheDir: dir,
    checkAuth: async () => ({ ok: false, status: 503, reason: 'auth_upstream_unreachable' }),
    fetchUpstream: async () => ({ ok: true, bytes: PNG_A }),
  });
  assert.equal(await brokenAuth.handle(makeReq(), unavailable.res), false);
  assert.equal(unavailable.state.status, 0);

  // 鉴权实现自己抛错：同样退回原代理
  const throwing = makeRes();
  const throwingAuth = createAvatarCache({
    cacheDir: dir,
    checkAuth: async () => {
      throw new Error('boom');
    },
    fetchUpstream: async () => ({ ok: true, bytes: PNG_A }),
  });
  assert.equal(await throwingAuth.handle(makeReq(), throwing.res), false);
  assert.equal(throwing.state.status, 0);

  // 已登录的实例对照：同一个 url 是能出图的（证明上面不是路由问题）
  const ok = makeRes();
  assert.equal(await cache.handle(makeReq(), ok.res), true);
  assert.equal(ok.state.status, 200);
});

/* ------------------------------------------------------------------ */
/* 6. /api/avatar/user 按账号隔离                                       */
/* ------------------------------------------------------------------ */

await t('/api/avatar/user：不同 Cookie 不会拿到彼此的头像', async () => {
  const dir = await caseDir();
  let body = PNG_A;
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: body }) });

  const a = makeRes();
  await cache.handle(makeReq({ url: '/api/avatar/user', headers: { cookie: 'sid=A' } }), a.res);
  assert.equal(a.state.status, 200);
  assert.equal(calls.count, 1);

  // 换了账号、上游内容也变了：必须重新回源，绝不能把 A 的图发给 B
  body = PNG_B;
  const b = makeRes();
  await cache.handle(makeReq({ url: '/api/avatar/user', headers: { cookie: 'sid=B' } }), b.res);
  assert.equal(b.state.status, 200);
  assert.equal(calls.count, 2, '换了 Cookie 必须重新回源（用户头像是按账号变的）');
  assert.notDeepEqual(b.state.body, a.state.body, 'B 不能拿到 A 的头像');
  // public + vary: cookie：不让中间缓存把一个人的头像发给另一个人
  assert.equal(b.state.headers.vary, 'cookie');

  // 同一个账号再来一次：这次走缓存，不再回源
  const b2 = makeRes();
  await cache.handle(makeReq({ url: '/api/avatar/user', headers: { cookie: 'sid=B' } }), b2.res);
  assert.equal(calls.count, 2);
  assert.deepEqual(b2.state.body, b.state.body);

  // A 也还认得自己那份（内容寻址：A 的原图文件还在）
  const a2 = makeRes();
  await cache.handle(makeReq({ url: '/api/avatar/user', headers: { cookie: 'sid=A' } }), a2.res);
  assert.equal(a2.state.status, 200);
  assert.deepEqual(a2.state.body, a.state.body);
});

await t('agent 头像与 Cookie 无关：不同账号共用同一份缓存', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  await cache.handle(makeReq({ headers: { cookie: 'sid=A' } }), makeRes().res);
  const other = makeRes();
  await cache.handle(makeReq({ headers: { cookie: 'sid=B' } }), other.res);
  assert.equal(calls.count, 1, 'agent 头像是全局内容，换账号不该重新回源');
  assert.equal(other.state.headers.vary, undefined, '只有用户头像才带 vary: cookie');
});

/* ------------------------------------------------------------------ */
/* 7. 存储细节：清理、内容未变不重编码、文件被删后重建                   */
/* ------------------------------------------------------------------ */

await t('同 id 换图：最多留 2 份文件，且发的是最新的那张', async () => {
  const dir = await caseDir();
  let body = PNG_A;
  // revalidateMs: 0 → 每次请求都回源比对内容（模拟「头像换了」）
  const { cache, calls } = makeCache({
    dir,
    revalidateMs: 0,
    fetchUpstream: async () => ({ ok: true, bytes: body }),
  });

  await cache.handle(makeReq(), makeRes().res); // A
  body = PNG_B;
  const second = makeRes();
  await cache.handle(makeReq(), second.res); // B
  const metaB = await sharp(second.state.body).metadata();
  assert.equal(metaB.format, 'webp');
  body = PNG_C;
  const third = makeRes();
  await cache.handle(makeReq(), third.res); // C
  assert.equal(calls.count, 3);

  const files = await listCacheFiles(dir);
  assert.ok(
    files.length <= AVATAR_CACHE_FILES_PER_ID,
    `同 id 最多留 ${AVATAR_CACHE_FILES_PER_ID} 份，实际 ${files.length}：${files.join(', ')}`,
  );
  assert.ok(files.includes(`hanako-${hash16(PNG_C)}.webp`), '最新的那份必须还在');
  // 发的确实是 C 的产物（不是第一次的 A）
  const fresh = await fsp.readFile(path.join(dir, `hanako-${hash16(PNG_C)}.webp`));
  assert.deepEqual(third.state.body, fresh);
});

await t('revalidateMs: 0 + 内容没变：再回源但不重编码，只留一份文件', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({
    dir,
    revalidateMs: 0,
    fetchUpstream: async () => ({ ok: true, bytes: PNG_A }),
  });
  const first = makeRes();
  await cache.handle(makeReq(), first.res);
  const second = makeRes();
  await cache.handle(makeReq(), second.res);

  assert.equal(calls.count, 2, '索引过期后要回源比一次内容哈希');
  assert.deepEqual(await listCacheFiles(dir), [`hanako-${hash16(PNG_A)}.webp`], '同内容不该写第二份');
  assert.deepEqual(second.state.body, first.state.body);
  assert.equal(second.state.headers.etag, first.state.headers.etag);
});

await t('缓存文件被手工删掉：索引失效，重新回源并重建', async () => {
  const dir = await caseDir();
  const { cache, calls } = makeCache({ dir, fetchUpstream: async () => ({ ok: true, bytes: PNG_A }) });
  await cache.handle(makeReq(), makeRes().res);
  await fsp.rm(path.join(dir, `hanako-${hash16(PNG_A)}.webp`));

  const again = makeRes();
  const handled = await cache.handle(makeReq(), again.res);
  assert.equal(handled, true);
  assert.equal(again.state.status, 200);
  assert.equal(calls.count, 2, '文件不在就只能重来一遍');
  assert.deepEqual(await listCacheFiles(dir), [`hanako-${hash16(PNG_A)}.webp`]);
});

await t('同一 id 的并发首次请求只回源一次（in-flight 合并）', async () => {
  const dir = await caseDir();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cache, calls } = makeCache({
    dir,
    fetchUpstream: async () => {
      await gate;
      return { ok: true, bytes: PNG_A };
    },
  });

  const one = makeRes();
  const two = makeRes();
  const p1 = cache.handle(makeReq(), one.res);
  const p2 = cache.handle(makeReq(), two.res);
  // 让两个请求都进到 in-flight 再放开上游
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [true, true]);

  assert.equal(calls.count, 1, '并发首次请求应该合并成一次回源');
  assert.equal(one.state.status, 200);
  assert.equal(two.state.status, 200);
  assert.deepEqual(one.state.body, two.state.body);
});

await t('createAvatarCache 必须注入 fetchUpstream', () => {
  assert.throws(() => createAvatarCache({}), /fetchUpstream/);
});

/* ------------------------------------------------------------------ */

console.log(
  bad === 0
    ? '\n全部通过（avatar-cache）'
    : `\n${bad} 个用例失败（avatar-cache）`,
);
if (bad) process.exitCode = 1;
