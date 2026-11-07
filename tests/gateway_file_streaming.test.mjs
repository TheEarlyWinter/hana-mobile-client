/* gateway：文件响应的流式路径（任务 3）
 *
 * 目标行为：
 *   - 非 HTML 卡片资源、会话图片、前端静态文件：GET 流式返回，HEAD 只回元数据；
 *   - 静态条件请求：ETag 在读正文前判定，304 不打开内容流，也不再同步 stat；
 *   - 卡片 HTML 保持完整读取：runtime 注入、resize 脚本、源版本按原始 UTF-8 计算；
 *   - 客户端中途断开时销毁读取流（不留 fd），文件打开/读取失败不产生未处理异常；
 *   - stat 时 0 字节、打开前增长：不发正文并销毁流；stat 后文件变短：断开连接，不让客户端死等。
 *
 * 观测方式：真实 http.Server + 真实临时文件 + 真实 web/ 文件，并在本进程沙箱里包裹
 * fs.createReadStream / fs.promises.readFile / fs.promises.open / fs.statSync，
 * 记录每个「打开正文」的真实调用。断言的是请求期间到底有没有打开文件内容，
 * 不是匹配源码文本。
 *
 * 夹具全部落在临时目录；上游是 127.0.0.1 上的假 web-auth，不碰真实凭据、网关或设备。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');

/* ------------------------------------------------------------------ */
/* fs 沙箱：记录真实的内容打开调用                                      */
/* ------------------------------------------------------------------ */

const realCreateReadStream = fs.createReadStream;
const realReadFile = fsp.readFile;
const realOpen = fsp.open;
const realStatSync = fs.statSync;
// realpath 的原生实现也要在包裹之前抓住：下面判定「是不是同一个文件」时会反复用，
// 但不能走 fs.statSync 那条已进探测范围的入口，否则事件会被自己的判定过程搅浑。
const nativeRealpathSync = fs.realpathSync.native;

/* ------------------------------------------------------------------ */
/* 路径同一性                                                          */
/* ------------------------------------------------------------------ */

/*
 * 为什么「同一个文件」不能只比 path.resolve：
 *   gateway 的 file-utils.resolveInsideRoots 会先把请求路径 realpath 成真实路径再打开，
 *   于是进到 fs 里的是真实路径，而测试手里是自己拼的字面路径。两者在下面几种情形下不等：
 *     - Windows 8.3 短名：os.tmpdir() 可以返回 `...\HANA-S~2\...`，realpath 展开成长名；
 *     - junction / 符号链接：realpath 会跳到链接目标；
 *     - 磁盘上的真实大小写与拼出来的不同（这里统一按大小写不敏感比）。
 *   CI 的 TEMP 是短名路径，本地开发机是长名，所以「必须打开过内容」的断言只在 runner 上红。
 * 判定顺序：realpath（含「父目录 realpath + basename」，文件已被删掉也能对上）→ 字面路径
 *   → 同 basename 且同 size；三层都不中就当没记录到，断言里会说明哪一层没命中。
 */

function caseKey(p) {
  const s = String(p);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function realpathOrNull(p) {
  try {
    return nativeRealpathSync.call(fs, p);
  } catch {
    return null;
  }
}

function sizeOrNull(p) {
  try {
    return realStatSync.call(fs, String(p)).size;
  } catch {
    return null;
  }
}

/** 一个路径可能的全部同一性写法：字面路径、真实路径、父目录真实路径 + 名字。 */
function identitiesOf(absPath) {
  const ids = new Set([caseKey(absPath)]);
  const real = realpathOrNull(absPath);
  if (real) ids.add(caseKey(real));
  const parentReal = realpathOrNull(path.dirname(absPath));
  if (parentReal) ids.add(caseKey(path.join(parentReal, path.basename(absPath))));
  return ids;
}

/** 事件与目标共用同一份判定依据（路径同一性集合 + basename + size）。 */
function describePath(p) {
  const abs = path.resolve(String(p));
  return { abs, ids: identitiesOf(abs), base: caseKey(path.basename(abs)), size: sizeOrNull(abs) };
}

/** 命中哪一层就返回哪一层（path / realpath / basename+size），不是同一个文件返回 null。 */
function matchLayer(subject, wanted) {
  const literal = caseKey(wanted.abs);
  for (const id of subject.ids) {
    if (!wanted.ids.has(id)) continue;
    return id === literal ? 'path' : 'realpath';
  }
  // 兜底只认「同 basename 且同 size」；两边 size 有一个拿不到就不算命中：
  // 宁可让断言报「没记录到」，也不要把另一个文件的事件算到目标头上。
  if (subject.base === wanted.base && subject.size !== null && subject.size === wanted.size) return 'basename+size';
  return null;
}

/** 三层比较逐条给结论，断言失败时用来指认是哪一层没命中。 */
function layerVerdicts(subject, wanted) {
  const literalKey = caseKey(wanted.abs);
  const literal = subject.ids.has(literalKey);
  const real = [...subject.ids].some((id) => id !== literalKey && wanted.ids.has(id));
  const bySize = subject.base === wanted.base && subject.size !== null && subject.size === wanted.size;
  return `path=${literal ? '命中' : '不等'}`
    + ` realpath=${real ? '命中' : '不等'}`
    + ` basename+size=${bySize ? '命中' : `不等(${subject.base}/${subject.size} vs ${wanted.base}/${wanted.size})`}`;
}

const probe = {
  events: [],
  /** 字面路径 -> 'delete-before-open' | 'error-after-chunk' …（键按同一性匹配，不按字符串相等） */
  faults: new Map(),
  reset() {
    this.events.length = 0;
  },
  contentOpsFor(target) {
    const wanted = describePath(target);
    return this.events.filter((e) => e.op !== 'statSync' && matchLayer(e.ident, wanted));
  },
  syncStatCount() {
    return this.events.filter((e) => e.op === 'statSync').length;
  },
  /** 断言失败时的现场：目标是哪个真实文件、这段时间到底记录了谁、哪一层比较没命中。 */
  diagnose(target) {
    const wanted = describePath(target);
    const content = this.events.filter((e) => e.op !== 'statSync');
    const real = realpathOrNull(wanted.abs) || '（取不到）';
    if (content.length === 0) {
      return `\n      目标 ${wanted.abs}（realpath=${real}）；这段时间内一条内容打开记录都没有`;
    }
    const seen = content
      .map((e) => `${e.op}(${e.path}) → ${matchLayer(e.ident, wanted) || '不命中'}; ${layerVerdicts(e.ident, wanted)}`)
      .join('\n        ');
    return `\n      目标 ${wanted.abs}（realpath=${real}）；这段时间记录到：\n        ${seen}`;
  },
};

function recordEvent(op, target, extra) {
  const raw = typeof target === 'string' ? target : String(target);
  probe.events.push({ op, path: raw, ident: describePath(raw), ...extra });
}

function takeFault(target) {
  if (!target) return null;
  const wanted = describePath(target);
  for (const [key, kind] of probe.faults) {
    if (matchLayer(describePath(key), wanted)) {
      probe.faults.delete(key);
      return kind;
    }
  }
  return null;
}

function applyFault(target) {
  if (!target) return null;
  const kind = takeFault(target);
  if (!kind) return null;
  if (kind === 'delete-before-open') {
    try {
      fs.unlinkSync(target);
    } catch {
      // 文件已经不在也算同一个故障语义
    }
  }
  if (kind === 'append-before-open') {
    // 模拟「stat 之后、打开之前」文件被追加：正文不能超过已声明的 content-length。
    fs.appendFileSync(target, Buffer.alloc(4096, 0x33));
  }
  if (kind === 'truncate-before-open') {
    // 模拟「stat 之后、打开之前」文件被截短：读流会提前结束，客户端不能等缺失的字节。
    try {
      fs.truncateSync(target, SHRUNK_BYTES);
    } catch {
      // 文件不在时保持原样，让打开失败路径自己报错
    }
  }
  return kind;
}

const patchedCreateReadStream = function patchedCreateReadStream(target, options) {
  const file = typeof target === 'string' ? target : null;
  const fault = applyFault(file);
  if (fault === 'error-after-chunk') {
    const stream = new Readable({
      read() {
        this.push(Buffer.alloc(1024, 0x5a));
        this.destroy(new Error('injected read failure'));
      },
    });
    recordEvent('createReadStream', file, { stream, fault });
    return stream;
  }
  const stream = realCreateReadStream.call(fs, target, options);
  recordEvent('createReadStream', file ?? target, { stream });
  return stream;
};
fs.createReadStream = patchedCreateReadStream;

const patchedReadFile = function patchedReadFile(target, options) {
  const file = typeof target === 'string' ? target : null;
  applyFault(file);
  recordEvent('readFile', file ?? target);
  return realReadFile.call(fsp, target, options);
};
fsp.readFile = patchedReadFile;

const patchedOpen = function patchedOpen(target, ...rest) {
  const file = typeof target === 'string' ? target : null;
  applyFault(file);
  recordEvent('open', file ?? target);
  return realOpen.call(fsp, target, ...rest);
};
fsp.open = patchedOpen;

const patchedStatSync = function patchedStatSync(target, options) {
  probe.events.push({ op: 'statSync', path: typeof target === 'string' ? target : String(target) });
  return realStatSync.call(fs, target, options);
};
fs.statSync = patchedStatSync;

/*
 * 补丁自检：如果 runner 上 node:fs 的命名空间属性不可写（或者哪天有人把 fs 换成代理），
 * 后面每条用例都会以「没打开过内容」的假象红，看不出是补丁没生效还是路径对不上。
 * 这里先确认四个入口真的被换掉了，不成立就立刻失败并指名道姓。
 */
for (const [name, actual, expected] of [
  ['fs.createReadStream', fs.createReadStream, patchedCreateReadStream],
  ['fs.promises.readFile', fs.promises.readFile, patchedReadFile],
  ['fs.promises.open', fs.promises.open, patchedOpen],
  ['fs.statSync', fs.statSync, patchedStatSync],
]) {
  if (actual !== expected) {
    console.log(`PROBE-PATCH-FAILED ${name}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const VALID_COOKIE = 'hana_session=valid';
/** 截短故障后文件剩下的字节数（用于「stat 之后文件变短」用例）。 */
const SHRUNK_BYTES = 32;
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-stream-'));
const hanaHome = path.join(tmpRoot, 'hana-home');
const sessionFiles = path.join(hanaHome, 'session-files');
const uploadsDir = path.join(hanaHome, 'uploads');
const attachmentsDir = path.join(hanaHome, 'attachments');
const cardDir = path.join(sessionFiles, 'card-stream');
const otherCardDir = path.join(sessionFiles, 'card-other');
const outsideDir = path.join(tmpRoot, 'outside');

await fsp.mkdir(cardDir, { recursive: true });
await fsp.mkdir(otherCardDir, { recursive: true });
await fsp.mkdir(uploadsDir, { recursive: true });
await fsp.mkdir(attachmentsDir, { recursive: true });
await fsp.mkdir(outsideDir, { recursive: true });

const CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>stream</title></head>
<body><p>CARD_STREAM</p></body></html>
`;
const BIG_CSS = Buffer.from(`/* card asset */\n${'a{color:#123456}\n'.repeat(90_000)}`, 'utf8');
const BIG_PNG = randomBytes(12 * 1024 * 1024);
const WEB_INDEX = await fsp.readFile(path.join(WEB_ROOT, 'index.html'));
const WEB_CSS = await fsp.readFile(path.join(WEB_ROOT, 'style.css'));

/**
 * 首页正文的期望值：网关会把 `/dist/app.js`、`/dist/app.css` 换成构建产物的哈希名，
 * 所以「正文正确」不再是原始文件的字节。这里按清单自己算一遍（不 import 被测函数），
 * 比较仍然是逐字节的；没有清单时网关原样发出，期望值也就是原样。
 */
async function expectedIndexHtml() {
  let html = WEB_INDEX.toString('utf8');
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(WEB_ROOT, 'dist', 'manifest.json'), 'utf8'));
    html = html.replaceAll('/dist/app.js', `/dist/${manifest.js}`).replaceAll('/dist/app.css', `/dist/${manifest.css}`);
  } catch {
    // 没构建：期望原文
  }
  return Buffer.from(html, 'utf8');
}

await fsp.writeFile(path.join(cardDir, 'index.html'), CARD_HTML);
await fsp.writeFile(path.join(cardDir, 'big.css'), BIG_CSS);
await fsp.writeFile(path.join(cardDir, 'logo.png'), TINY_PNG);
await fsp.writeFile(path.join(otherCardDir, 'secret.txt'), 'OTHER_SECRET');
await fsp.writeFile(path.join(outsideDir, 'secret.png'), 'OUTSIDE_SECRET');

const picPath = path.join(sessionFiles, 'pic.png');
const bigPicPath = path.join(sessionFiles, 'big.png');
const gonePath = path.join(sessionFiles, 'gone.png');
const brokenPath = path.join(sessionFiles, 'broken.png');
const growPath = path.join(sessionFiles, 'grow.png');
const zeroPath = path.join(sessionFiles, 'zero.png');
const zeroGrowPath = path.join(sessionFiles, 'zero-grow.png');
const shrinkPath = path.join(sessionFiles, 'shrink.png');
const docPath = path.join(sessionFiles, 'doc.txt');
const outsidePicPath = path.join(outsideDir, 'secret.png');
await fsp.writeFile(picPath, TINY_PNG);
await fsp.writeFile(bigPicPath, BIG_PNG);
await fsp.writeFile(gonePath, TINY_PNG);
await fsp.writeFile(brokenPath, TINY_PNG);
await fsp.writeFile(growPath, TINY_PNG);
await fsp.writeFile(zeroPath, Buffer.alloc(0));
await fsp.writeFile(zeroGrowPath, Buffer.alloc(0));
await fsp.writeFile(shrinkPath, TINY_PNG);
await fsp.writeFile(docPath, 'not an image');

/* ------------------------------------------------------------------ */
/* 假上游 + 真实 http 服务器（直接挂三个 serve 函数）                    */
/* ------------------------------------------------------------------ */

const fatal = [];
process.on('uncaughtException', (err) => fatal.push(err));
process.on('unhandledRejection', (err) => fatal.push(err));

const upstream = http.createServer(async (req, res) => {
  if (req.url === '/api/web-auth/session') {
    if (authGate) {
      enterAuthGateResolve?.();
      await authGate;
    }
    const authed = String(req.headers.cookie || '').includes(VALID_COOKIE);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ authenticated: authed, principal: authed ? { kind: 'local_user' } : null }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

/** 鉴权门：把请求挂在 checkReadAuth 里，模拟客户端在鉴权期间断开。 */
let authGate = null;
let authGateEntered = null;
let releaseAuthGate = null;
let enterAuthGateResolve = null;

function armAuthGate() {
  authGate = new Promise((resolve) => {
    releaseAuthGate = resolve;
  });
  authGateEntered = new Promise((resolve) => {
    enterAuthGateResolve = resolve;
  });
}

function disarmAuthGate() {
  releaseAuthGate?.();
  authGate = null;
  authGateEntered = null;
  releaseAuthGate = null;
  enterAuthGateResolve = null;
}

const upstreamPort = await new Promise((resolve, reject) => {
  upstream.once('error', reject);
  upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port));
});

// config.mjs 在 import 时读环境变量，必须先设好再动态 import 网关模块。
process.env.HANA_HOME = hanaHome;
process.env.HANA_UPSTREAM_HOST = '127.0.0.1';
process.env.HANA_UPSTREAM_PORT = String(upstreamPort);
process.env.HANA_GW_HOST = '127.0.0.1';
process.env.HANA_GW_PORT = '0';
process.env.HANA_GATEWAY_LOG = 'off';

const { serveCard } = await import('../gateway/card-host.mjs');
const { serveSessionFile } = await import('../gateway/session-files.mjs');
const { serveStatic } = await import('../gateway/static-files.mjs');

const handlerErrors = [];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const fail = (label) => (err) => {
    handlerErrors.push({ label, message: String(err?.stack || err) });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${label} error`);
  };
  if (pathname.startsWith('/gw/card/')) {
    serveCard(req, res, pathname).catch(fail('card'));
    return;
  }
  if (pathname.startsWith('/gw/file/')) {
    serveSessionFile(req, res, pathname).catch(fail('file'));
    return;
  }
  serveStatic(req, res).catch(fail('static'));
});

const port = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

/* ------------------------------------------------------------------ */
/* 请求工具                                                            */
/* ------------------------------------------------------------------ */

function request(rawPath, { method = 'GET', headers = {}, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: rawPath, headers: { connection: 'close', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

/** 收到第一块响应体后立刻断开，模拟取消下载/关页面。 */
function requestAndAbort(rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: rawPath, headers: { connection: 'close', ...headers } },
      (res) => {
        res.once('data', (chunk) => {
          resolve({ status: res.statusCode, headers: res.headers, received: chunk.length, ended: false });
          req.destroy();
          res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode, ended: true }));
        res.on('error', () => {
          // 主动断开后客户端可能收到 ECONNRESET，这是预期路径
        });
      },
    );
    req.on('error', () => {
      // 同上
    });
    req.end();
  });
}

/** 裸套接字 GET（keep-alive）：服务器若不主动断开，连接会一直等 content-length 里的缺失字节。 */
function rawGetKeepAlive(rawPath, cookie, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ raw: Buffer.concat(chunks), timedOut });
    };
    socket.on('connect', () => {
      const lines = [`GET ${rawPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: keep-alive'];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(true));
  });
}

/** 裸套接字 GET：用来数「套接字上到底收到了多少正文字节」，不受 content-length 截断影响。 */
function rawGet(rawPath, cookie) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    socket.on('connect', () => {
      const lines = [`GET ${rawPath} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error('raw socket timeout')));
  });
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const fileUrl = (absPath) => `/gw/file/${b64url(absPath)}`;
const cardUrl = (dir, rel = '') => `/gw/card/${b64url(dir)}/${rel}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function waitFor(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return predicate();
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Cookie 导航拿一张卡片令牌，返回 /gw/card/<b64>/<token>/。 */
async function mintCardToken() {
  const res = await request(cardUrl(cardDir), { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 302, `卡片导航应 302，实际 ${res.status}: ${res.body.toString('utf8')}`);
  assert.ok(res.headers.location, '302 必须带 location');
  return res.headers.location;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

let bad = 0;
async function t(name, fn) {
  probe.reset();
  handlerErrors.length = 0;
  try {
    await fn();
    assert.deepEqual(
      handlerErrors,
      [],
      `请求处理不应以 reject 收场：${handlerErrors.map((e) => `${e.label}: ${e.message}`).join(' | ')}`,
    );
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

await t('会话图片 GET：流式返回完整内容，头保持', async () => {
  const res = await request(fileUrl(bigPicPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(Number(res.headers['content-length']), BIG_PNG.length, 'content-length 必须等于文件大小');
  assert.equal(res.body.length, BIG_PNG.length, '正文长度必须等于文件大小');
  assert.equal(sha256(res.body), sha256(BIG_PNG), '正文必须与文件逐字节一致');

  const ops = probe.contentOpsFor(bigPicPath);
  assert.equal(
    ops.filter((e) => e.op === 'createReadStream').length,
    1,
    `GET 必须打开一条内容流（实际内容打开调用：${ops.map((e) => e.op).join(',') || '无'}）${probe.diagnose(bigPicPath)}`,
  );
  assert.equal(
    ops.filter((e) => e.op === 'readFile' || e.op === 'open').length,
    0,
    `GET 不应整文件读入内存（实际：${ops.map((e) => e.op).join(',')}）`,
  );
});

await t('会话图片 HEAD：只回元数据，不打开内容流', async () => {
  const res = await request(fileUrl(bigPicPath), { method: 'HEAD', headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(Number(res.headers['content-length']), BIG_PNG.length);
  assert.equal(res.body.length, 0, 'HEAD 不能有正文');

  const ops = probe.contentOpsFor(bigPicPath);
  assert.deepEqual(ops, [], `HEAD 不应打开文件内容（实际：${ops.map((e) => e.op).join(',')}）`);
});

await t('会话图片：非图片/越界/缺失保持原语义', async () => {
  const nonImage = await request(fileUrl(docPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(nonImage.status, 403);
  const outside = await request(fileUrl(outsidePicPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(outside.status, 403);
  assert.ok(!outside.body.toString('utf8').includes('OUTSIDE_SECRET'));
  const missing = await request(fileUrl(path.join(sessionFiles, 'nope.png')), { headers: { cookie: VALID_COOKIE } });
  assert.equal(missing.status, 404);
  const unauth = await request(fileUrl(picPath));
  assert.equal(unauth.status, 401);
});

await t('卡片非 HTML 资源 GET：流式 + CSP/令牌头保持', async () => {
  const location = await mintCardToken();
  const res = await request(`${location}big.css`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(Number(res.headers['content-length']), BIG_CSS.length);
  assert.equal(sha256(res.body), sha256(BIG_CSS), '正文必须与文件一致');
  assert.equal(res.headers['access-control-allow-origin'], '*', '令牌响应必须允许 opaque origin 读取');
  assert.equal(res.headers['x-hana-card-source-version'], undefined, '非 HTML 资源没有源版本头');
  const csp = String(res.headers['content-security-policy'] || '');
  assert.ok(csp.includes(`${location}`), `CSP 必须限定到本卡令牌路径：${csp}`);
  assert.ok(csp.includes('sandbox allow-scripts'));

  const target = path.join(cardDir, 'big.css');
  const ops = probe.contentOpsFor(target);
  assert.equal(
    ops.filter((e) => e.op === 'createReadStream').length,
    1,
    `卡片资源 GET 必须走流（实际：${ops.map((e) => e.op).join(',') || '无'}）${probe.diagnose(target)}`,
  );
  assert.equal(ops.filter((e) => e.op === 'readFile' || e.op === 'open').length, 0, '卡片资源 GET 不应整文件缓冲');
});

await t('卡片非 HTML 资源 HEAD：只回元数据，头与 GET 一致', async () => {
  const location = await mintCardToken();
  const target = path.join(cardDir, 'big.css');
  const res = await request(`${location}big.css`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(Number(res.headers['content-length']), BIG_CSS.length);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.ok(String(res.headers['content-security-policy'] || '').includes(location));
  assert.equal(res.body.length, 0);

  const ops = probe.contentOpsFor(target);
  assert.deepEqual(ops, [], `卡片资源 HEAD 不应打开内容（实际：${ops.map((e) => e.op).join(',')}）`);
});

await t('卡片 HTML：GET/HEAD 仍完整读取、注入 runtime、源版本按原始 UTF-8 计算', async () => {
  const location = await mintCardToken();
  const target = path.join(cardDir, 'index.html');
  const expectedVersion = `sha256:${sha256(Buffer.from(CARD_HTML, 'utf8'))}`;

  const get = await request(location);
  assert.equal(get.status, 200);
  assert.equal(get.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(get.headers['x-hana-card-source-version'], expectedVersion, '源版本必须对原始文件计算');
  const html = get.body.toString('utf8');
  assert.ok(html.includes('__HANA_CARD_RUNTIME_INSTALLED__'), 'runtime 必须注入');
  assert.ok(html.includes('__hanaCardHeight'), '高度上报脚本必须注入');
  assert.ok(html.indexOf('__HANA_CARD_RUNTIME_INSTALLED__') < html.indexOf('CARD_STREAM'), 'runtime 必须早于业务内容');
  assert.equal(Number(get.headers['content-length']), get.body.length, 'content-length 必须是注入后的真实长度');

  const head = await request(location, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['x-hana-card-source-version'], expectedVersion, 'HEAD 必须返回同一可信版本');
  assert.equal(Number(head.headers['content-length']), get.body.length, 'HEAD 与 GET 的 content-length 必须一致');

  const ops = probe.contentOpsFor(target);
  assert.ok(
    ops.some((e) => e.op === 'readFile'),
    `HTML 需要注入与源版本，必须完整读取（不能为了流式省略注入）${probe.diagnose(target)}`,
  );
  assert.equal(ops.filter((e) => e.op === 'createReadStream').length, 0, 'HTML 不能被当普通静态流直接发出');
});

await t('卡片路径越界仍 403，缺失资源 404', async () => {
  const location = await mintCardToken();
  const escape = await request(`${location}..%2fcard-other%2fsecret.txt`);
  assert.equal(escape.status, 403);
  assert.ok(!escape.body.toString('utf8').includes('OTHER_SECRET'));
  const missing = await request(`${location}nope.css`);
  assert.equal(missing.status, 404);
});

await t('静态文件 GET：流式返回，无同步 stat', async () => {
  const res = await request('/style.css');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate');
  assert.equal(Number(res.headers['content-length']), WEB_CSS.length);
  assert.equal(sha256(res.body), sha256(WEB_CSS));
  assert.ok(res.headers.etag, '静态响应必须有 ETag');

  const target = path.join(WEB_ROOT, 'style.css');
  const ops = probe.contentOpsFor(target);
  assert.equal(
    ops.filter((e) => e.op === 'createReadStream').length,
    1,
    `静态 GET 必须走流（实际：${ops.map((e) => e.op).join(',') || '无'}）${probe.diagnose(target)}`,
  );
  assert.equal(ops.filter((e) => e.op === 'readFile' || e.op === 'open').length, 0, '静态 GET 不应整文件缓冲');
  assert.equal(probe.syncStatCount(), 0, '静态响应不应再调用同步 stat');
});

await t('静态文件 HEAD：只回元数据，不读正文', async () => {
  const res = await request('/style.css', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), WEB_CSS.length);
  assert.equal(res.body.length, 0);
  assert.ok(res.headers.etag);

  const ops = probe.contentOpsFor(path.join(WEB_ROOT, 'style.css'));
  assert.deepEqual(ops, [], `静态 HEAD 不应读正文（实际：${ops.map((e) => e.op).join(',')}）`);
  assert.equal(probe.syncStatCount(), 0);
});

await t('静态条件请求：304 在读正文前判定，不读正文、无同步 stat', async () => {
  const first = await request('/index.html');
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, '首次响应必须有 ETag');
  assert.equal(first.headers['content-security-policy'], "frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  assert.equal(first.headers['clear-site-data'], undefined, '文档层不再清 HTTP 缓存');

  probe.reset();
  const cached = await request('/index.html', { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body.length, 0);
  assert.equal(cached.headers.etag, etag);
  assert.equal(
    cached.headers['content-security-policy'],
    first.headers['content-security-policy'],
    '304 仍要带文档 CSP',
  );
  const ops = probe.contentOpsFor(path.join(WEB_ROOT, 'index.html'));
  assert.deepEqual(ops, [], `304 不应读正文（实际：${ops.map((e) => e.op).join(',')}）`);
  assert.equal(probe.syncStatCount(), 0, '304 不应同步 stat');

  probe.reset();
  const stale = await request('/index.html', { headers: { 'if-none-match': 'W/"deadbeef-1"' } });
  assert.equal(stale.status, 200);
  assert.equal(sha256(stale.body), sha256(await expectedIndexHtml()), 'ETag 不匹配时正文必须正确');
  assert.ok(
    probe.contentOpsFor(path.join(WEB_ROOT, 'index.html')).length > 0,
    'ETag 不匹配时必须真的读文件',
  );
});

await t('静态：目录回落与 404 保持', async () => {
  const fallback = await request('/some-app-route');
  assert.equal(fallback.status, 200);
  assert.equal(sha256(fallback.body), sha256(await expectedIndexHtml()), '无扩展名路径应回落 index.html');
  const missing = await request('/nope.js');
  assert.equal(missing.status, 404);
});

await t('客户端中途断开：读取流被销毁并关闭 fd，网关继续服务', async () => {
  const aborted = await requestAndAbort(fileUrl(bigPicPath), { cookie: VALID_COOKIE });
  assert.equal(aborted.status, 200);
  assert.equal(aborted.ended, false, '夹具：客户端必须在传输完成前断开');
  assert.ok(aborted.received < BIG_PNG.length, '夹具：只应收到开头一小段');

  const streamEvent = probe
    .contentOpsFor(bigPicPath)
    .find((e) => e.op === 'createReadStream');
  assert.ok(streamEvent, `夹具：GET 应打开内容流${probe.diagnose(bigPicPath)}`);
  const stream = streamEvent.stream;
  const closed = await waitFor(() => stream.destroyed && stream.closed);
  assert.equal(closed, true, `客户端断开后读取流必须销毁并关闭 fd（destroyed=${stream.destroyed}, closed=${stream.closed}）`);
  assert.ok(
    stream.bytesRead < BIG_PNG.length,
    `断开后不应继续读完整个文件（已读 ${stream.bytesRead} / ${BIG_PNG.length} 字节）`,
  );

  const after = await request(fileUrl(picPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200, '断开后网关必须还能服务后续请求');
  assert.equal(after.body.length, TINY_PNG.length);
});

await t('客户端在鉴权期间断开：不再打开文件内容，网关继续服务', async () => {
  armAuthGate();
  const req = http.request(
    { host: '127.0.0.1', port, method: 'GET', path: fileUrl(bigPicPath), headers: { cookie: VALID_COOKIE } },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  req.end();

  const entered = await Promise.race([authGateEntered.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  assert.equal(entered, true, '夹具：鉴权请求应已到达假上游');
  req.destroy();
  await new Promise((r) => setTimeout(r, 80));
  disarmAuthGate();

  // 鉴权放开后服务端才走到发文件那一步；给足时间观察有没有多打开一次内容。
  await new Promise((r) => setTimeout(r, 300));
  const ops = probe.contentOpsFor(bigPicPath);
  assert.deepEqual(ops, [], `断开的请求不应再打开文件内容（实际：${ops.map((e) => e.op).join(',')}）`);

  const after = await request(fileUrl(picPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200, '断开后网关必须还能服务后续请求');
  assert.deepEqual(fatal, [], '断开的请求不能产生未捕获异常');
});

await t('stat 之后文件变大：套接字上只出现 content-length 声明的字节', async () => {
  probe.faults.set(growPath, 'append-before-open');
  const raw = await rawGet(fileUrl(growPath), VALID_COOKIE);
  const sep = raw.indexOf('\r\n\r\n');
  assert.ok(sep > 0, '夹具：应收到完整响应头');
  const head = raw.subarray(0, sep).toString('latin1');
  const body = raw.subarray(sep + 4);
  assert.match(head, /^HTTP\/1\.1 200/);
  assert.match(head, new RegExp(`content-length: ${TINY_PNG.length}`, 'i'), `content-length 来自 stat：${head}`);
  assert.equal(body.length, TINY_PNG.length, `套接字上只能收到声明的字节（实际 ${body.length}）`);
  assert.equal(sha256(body), sha256(TINY_PNG), '发出的必须是 stat 时刻的前 N 字节');
  const after = await fsp.readFile(growPath);
  assert.equal(after.length, TINY_PNG.length + 4096, '夹具：文件确实在 stat 之后变大了');
});

await t('零字节文件 GET：200、content-length: 0、空正文，流被销毁', async () => {
  const res = await request(fileUrl(zeroPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), 0, 'content-length 必须等于 stat 的 0');
  assert.equal(res.body.length, 0, '零字节文件不能有正文');

  const streamEvent = probe.contentOpsFor(zeroPath).find((e) => e.op === 'createReadStream');
  assert.ok(streamEvent, `仍要先打开文件，才能区分可读的空文件与打不开的 404${probe.diagnose(zeroPath)}`);
  assert.equal(await waitFor(() => streamEvent.stream.destroyed), true, '空文件响应后读取流必须销毁（fd 不能留着）');
  assert.equal(streamEvent.stream.bytesRead, 0, `空文件不应读取正文（实际读了 ${streamEvent.stream.bytesRead} 字节）`);
});

await t('stat 时 0 字节、打开前增长：不发正文，流被销毁', async () => {
  probe.faults.set(zeroGrowPath, 'append-before-open');
  const raw = await rawGet(fileUrl(zeroGrowPath), VALID_COOKIE);
  const sep = raw.indexOf('\r\n\r\n');
  assert.ok(sep > 0, '夹具：应收到完整响应头');
  const head = raw.subarray(0, sep).toString('latin1');
  const body = raw.subarray(sep + 4);
  assert.match(head, /^HTTP\/1\.1 200/);
  assert.match(head, /content-length: 0/i, `content-length 来自 stat：${head}`);
  assert.equal(body.length, 0, `content-length: 0 的响应不能发出任何正文字节（实际 ${body.length}）`);

  const streamEvent = probe.contentOpsFor(zeroGrowPath).find((e) => e.op === 'createReadStream');
  assert.ok(streamEvent, `夹具：应先打开文件确认可读${probe.diagnose(zeroGrowPath)}`);
  assert.equal(await waitFor(() => streamEvent.stream.destroyed), true, '零字节响应必须销毁读取流');
  assert.equal(
    streamEvent.stream.bytesRead,
    0,
    `零字节响应不能读取正文（实际读了 ${streamEvent.stream.bytesRead} 字节）`,
  );
  const after = await fsp.readFile(zeroGrowPath);
  assert.equal(after.length, 4096, '夹具：文件确实在 stat 之后长出了内容');
});

await t('stat 之后文件变短：断开连接，不让客户端等缺失字节', async () => {
  probe.faults.set(shrinkPath, 'truncate-before-open');
  const res = await rawGetKeepAlive(fileUrl(shrinkPath), VALID_COOKIE, 2000);
  assert.equal(
    res.timedOut,
    false,
    '连接必须在客户端超时前关闭；否则客户端会一直等 content-length 声明的缺失字节',
  );
  const sep = res.raw.indexOf('\r\n\r\n');
  assert.ok(sep > 0, '夹具：应收到完整响应头');
  const head = res.raw.subarray(0, sep).toString('latin1');
  const body = res.raw.subarray(sep + 4);
  assert.match(head, /^HTTP\/1\.1 200/);
  assert.match(head, new RegExp(`content-length: ${TINY_PNG.length}`, 'i'), `content-length 来自 stat：${head}`);
  assert.ok(body.length < TINY_PNG.length, `正文必须短于声明长度（实际 ${body.length}）`);
  assert.deepEqual(fatal, [], '文件变短不能产生未捕获异常');

  const after = await request(fileUrl(picPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200, '截短故障后网关必须继续服务');
});

await t('文件打开失败：404 且不崩进程', async () => {
  probe.faults.set(gonePath, 'delete-before-open');
  const res = await request(fileUrl(gonePath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(res.status, 404, '打开失败必须回 404');
  assert.deepEqual(fatal, [], '打开失败不能产生未捕获异常');

  const after = await request(fileUrl(picPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200);
});

await t('读取中途失败：断开连接、不产生未处理异常', async () => {
  probe.faults.set(brokenPath, 'error-after-chunk');
  let clientError = null;
  let response = null;
  try {
    response = await request(fileUrl(brokenPath), { headers: { cookie: VALID_COOKIE } });
  } catch (err) {
    clientError = err;
  }
  // 要么客户端看到连接被断开，要么响应被截断；绝不能是「完整 200 正文」。
  assert.ok(
    clientError || (response && response.body.length !== TINY_PNG.length),
    '读取中途失败不能假装成功返回完整正文',
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fatal, [], '读取中途失败不能产生未捕获异常');

  const after = await request(fileUrl(picPath), { headers: { cookie: VALID_COOKIE } });
  assert.equal(after.status, 200, '故障后网关必须继续服务');
  assert.equal(after.body.length, TINY_PNG.length);
});

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => upstream.close(resolve));

assert.deepEqual(fatal, [], `不应出现未捕获异常：${fatal.map((e) => e?.message || e).join(' | ')}`);
assert.deepEqual(handlerErrors, [], '收尾时不应有请求处理 reject');

// 恢复被包裹的 fs 入口，避免影响同进程后续代码
fs.createReadStream = realCreateReadStream;
fsp.readFile = realReadFile;
fsp.open = realOpen;
fs.statSync = realStatSync;

// 只逐个删自己建的夹具文件，不做递归删除。
for (const file of [
  path.join(cardDir, 'index.html'),
  path.join(cardDir, 'big.css'),
  path.join(cardDir, 'logo.png'),
  path.join(otherCardDir, 'secret.txt'),
  path.join(outsideDir, 'secret.png'),
  picPath,
  bigPicPath,
  gonePath,
  brokenPath,
  growPath,
  zeroPath,
  zeroGrowPath,
  shrinkPath,
  docPath,
]) {
  await fsp.unlink(file).catch(() => {});
}
for (const dir of [cardDir, otherCardDir, outsideDir, sessionFiles, uploadsDir, attachmentsDir, hanaHome, tmpRoot]) {
  await fsp.rmdir(dir).catch(() => {});
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
