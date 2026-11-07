/* 网关路径规范化与外部 HTTPS 的边界回归。
 *
 * 覆盖：
 * - P1-5 工作区 content 路径的百分号编码别名（单/双重编码、%2F、%2e）必须被拒绝，
 *   不能绕过「强制下载」那套响应头；非受保护路径的编码保持原有转发行为
 * - P1-6 HANA_GW_EXTERNAL_HTTPS：默认不给 Set-Cookie 补 Secure；显式为 1 时补；
 *   X-Forwarded-Proto 不能代替这个开关（伪造头不生效）
 * - 卡片 CSP 的源码前缀用「对外 scheme」：外部 HTTPS 时为 https，否则等于本机监听 scheme；
 *   同样不看 X-Forwarded-Proto
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import {
  decodedPathname,
  isEncodedAliasOfProtectedPath,
  isWorkspaceContentPath,
} from '../gateway/security-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.HANA_GW_SERVER_PATH
  ? path.resolve(process.env.HANA_GW_SERVER_PATH)
  : path.join(ROOT, 'gateway', 'server.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function waitTcp(port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`gateway 未就绪（port ${port}）`));
        else setTimeout(attempt, 80);
      });
    };
    attempt();
  });
}

function request(port, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: rawPath, headers: { connection: 'close', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error(`timeout ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

/* ---- 夹具 ---- */

let tmpRoot;
let hanaHome;
let cardDir;
let upstream;
let upstreamPort;
const hits = [];
const gateways = [];

async function makeFixtures() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-path-'));
  hanaHome = path.join(tmpRoot, 'hana-home');
  await fsp.mkdir(path.join(hanaHome, 'session-files'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'uploads'), { recursive: true });
  await fsp.mkdir(path.join(hanaHome, 'attachments'), { recursive: true });

  cardDir = path.join(hanaHome, 'session-files', 'card-csp');
  await fsp.mkdir(cardDir, { recursive: true });
  await fsp.writeFile(path.join(cardDir, 'index.html'), '<!doctype html><html><body>CARD</body></html>');
}

async function startUpstream() {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // 上游按 Node 默认行为解码：这里记录解码后的 pathname，证明网关没把请求送进来
    hits.push(url.pathname);
    if (url.pathname === '/api/web-auth/session') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"authenticated":true,"principal":null}');
      return;
    }
    if (url.pathname === '/api/cookie') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': ['cookie_a=1; HttpOnly; SameSite=Lax; Path=/', 'cookie_b=2; Secure; Path=/'],
      });
      res.end('{"ok":true}');
      return;
    }
    const workspace = new Set([
      '/api/workspace/content',
      '/api/mobile/workspace/content',
      '/api/workbench/content',
      '/api/mobile/workbench/content',
    ]);
    if (workspace.has(url.pathname)) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'inline; filename="preview.html"',
        'cache-control': 'public, max-age=3600',
      });
      res.end('<html><body>WORKSPACE_CONTENT</body></html>');
      return;
    }
    if (url.pathname === '/api/doc') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  upstreamPort = await listen(upstream);
}

function gatewayEnv(overrides = {}) {
  const env = {
    ...process.env, HANA_GATEWAY_LOG: 'off',
    HANA_HOME: hanaHome,
    HANA_UPSTREAM_HOST: '127.0.0.1',
    HANA_UPSTREAM_PORT: String(upstreamPort),
    HANA_GW_HOST: '127.0.0.1',
    HANA_GW_LOG_WS: '',
  };
  for (const key of [
    'HANA_GW_ALLOWED_ORIGINS',
    'HANA_GW_EXTERNAL_HTTPS',
    'HANA_GW_ALLOW_INSECURE_LAN',
    'HANA_GW_TLS_CERT_FILE',
    'HANA_GW_TLS_KEY_FILE',
  ]) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

async function startGateway(overrides = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: gatewayEnv({ HANA_GW_PORT: String(port), ...overrides }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString('utf8');
  });
  child.stderr.on('data', (c) => {
    log += c.toString('utf8');
  });
  const entry = { port, child, log: () => log, stop: () => child.exitCode === null && child.kill() };
  gateways.push(entry);
  try {
    await waitTcp(port);
  } catch (err) {
    throw new Error(`${err.message}\n${log}`);
  }
  return entry;
}

/* ---- 用例 ---- */

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('decodedPathname：单层/多层编码都解到同一路径，非法编码返回 null', () => {
  assert.equal(decodedPathname('/api/workspace/content'), '/api/workspace/content');
  assert.equal(decodedPathname('/api/workspace/con%74ent'), '/api/workspace/content');
  assert.equal(decodedPathname('/api/workspace/%2563ontent'), '/api/workspace/content');
  assert.equal(decodedPathname('/api/workspace%2Fcontent'), '/api/workspace/content');
  // WHATWG URL 已经把 %2e%2e 当点段折叠了，这里顺带锁住这个已知行为
  assert.equal(decodedPathname('/api/%2e%2e/api/workspace/content'), '/api/workspace/content');
  assert.equal(decodedPathname('/api/x%ZZ'), null);
  assert.equal(decodedPathname('http://evil/api'), null, '非 origin-form 不参与');
});

t('isWorkspaceContentPath / isEncodedAliasOfProtectedPath：编码别名按受保护路径算', () => {
  assert.equal(isWorkspaceContentPath('/api/workspace/content'), true);
  assert.equal(isWorkspaceContentPath('/api/workspace/con%74ent'), true);
  assert.equal(isWorkspaceContentPath('/api/nope'), false);

  for (const rawUrl of [
    '/api/workspace/con%74ent',
    '/api/workspace%2Fcontent',
    '/api/workspace/%2563ontent',
    '/api/mobile/workspace/con%74ent',
    '/api/workbench/%63ontent',
    '/api/web-auth/l%6Fgout',
    '/api/sessions/n%65w',
    '/api/sessions/new-detac%68ed',
    '/api/card-host/tools/inv%6Fke',
  ]) {
    assert.equal(isEncodedAliasOfProtectedPath(rawUrl), true, `${rawUrl} 必须判为编码别名`);
  }

  assert.equal(isEncodedAliasOfProtectedPath('/api/workspace/content'), false, '无编码的精确路径不算别名');
  assert.equal(isEncodedAliasOfProtectedPath('/api/session%20list'), false, '非受保护路径的编码不拦');
  assert.equal(isEncodedAliasOfProtectedPath('/api/x%ZZ'), false, '解不开的编码不在这里处理');
});

t('编码别名请求：网关 400，且不把请求送进上游', async () => {
  const gw = await startGateway();
  for (const rawUrl of [
    '/api/workspace/con%74ent?kind=html',
    '/api/workspace%2Fcontent?kind=html',
    '/api/workspace/%2563ontent?kind=html',
    '/api/mobile/workbench/con%74ent?kind=svg',
  ]) {
    const before = hits.length;
    const res = await request(gw.port, rawUrl);
    assert.equal(res.status, 400, `${rawUrl} 必须是 400，实际 ${res.status}`);
    assert.equal(hits.length, before, `${rawUrl} 不应到达上游：${hits.slice(before).join(',')}`);
  }
});

t('非受保护路径的编码照旧转发，正常 content 路径仍是强制下载', async () => {
  const gw = await startGateway();
  const control = await request(gw.port, '/api/session%20list');
  assert.equal(control.status, 404, '非受保护路径的编码请求应照旧转发（这里上游回 404）');

  const ok = await request(gw.port, '/api/workspace/content?kind=html');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-disposition'] || '', /^attachment/, '未编码的正规路径仍是强制下载');
});

t('Set-Cookie 默认不补 Secure（HTTP 网关）', async () => {
  const gw = await startGateway();
  const res = await request(gw.port, '/api/cookie');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers['set-cookie'], ['cookie_a=1; HttpOnly; SameSite=Lax; Path=/', 'cookie_b=2; Secure; Path=/']);
});

t('HANA_GW_EXTERNAL_HTTPS=1：外部已终止 TLS，逐条补 Secure', async () => {
  const gw = await startGateway({ HANA_GW_EXTERNAL_HTTPS: '1' });
  const res = await request(gw.port, '/api/cookie');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers['set-cookie'], [
    'cookie_a=1; HttpOnly; SameSite=Lax; Path=/; Secure',
    'cookie_b=2; Secure; Path=/',
  ]);

  // 显式开关优先于任何来源头：伪造 X-Forwarded-Proto: http 也不能把 Secure 去掉
  const forged = await request(gw.port, '/api/cookie', { headers: { 'x-forwarded-proto': 'http' } });
  assert.deepEqual(forged.headers['set-cookie'], [
    'cookie_a=1; HttpOnly; SameSite=Lax; Path=/; Secure',
    'cookie_b=2; Secure; Path=/',
  ]);
});

t('HANA_GW_EXTERNAL_HTTPS 不是 1（含 0）时不补 Secure，伪造 X-Forwarded-Proto 也不生效', async () => {
  const gwOff = await startGateway({ HANA_GW_EXTERNAL_HTTPS: '0' });
  const off = await request(gwOff.port, '/api/cookie');
  assert.deepEqual(off.headers['set-cookie'], ['cookie_a=1; HttpOnly; SameSite=Lax; Path=/', 'cookie_b=2; Secure; Path=/']);

  const gwDefault = await startGateway();
  const forged = await request(gwDefault.port, '/api/cookie', { headers: { 'x-forwarded-proto': 'https' } });
  assert.deepEqual(forged.headers['set-cookie'], [
    'cookie_a=1; HttpOnly; SameSite=Lax; Path=/',
    'cookie_b=2; Secure; Path=/',
  ]);
});

/* ---- 卡片 CSP ---- */

const b64url = (s) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 走一次卡片 HTML 导航（302 → 令牌路径），返回 200 的 CSP 与令牌相对地址。 */
async function fetchCardHome(gw, extraHeaders = {}) {
  const headers = { cookie: 'probe=1', host: `127.0.0.1:${gw.port}`, ...extraHeaders };
  const nav = await request(gw.port, `/gw/card/${b64url(cardDir)}/`, { headers });
  assert.equal(nav.status, 302, `卡片导航应 302，实际 ${nav.status}：${nav.body}`);
  const location = nav.headers.location || '';
  assert.match(
    location,
    /^\/gw\/card\/[A-Za-z0-9_-]+\/t_[A-Za-z0-9_-]{43}\/$/,
    `导航后应拿到带令牌的相对地址：${location}`,
  );
  const page = await request(gw.port, location, { headers });
  assert.equal(page.status, 200, `令牌路径应 200，实际 ${page.status}：${page.body}`);
  return { csp: page.headers['content-security-policy'] || '', location };
}

t('卡片 CSP 前缀用对外 scheme：HTTP 网关只有 http，HANA_GW_EXTERNAL_HTTPS=1 时 https 在前', async () => {
  const localGw = await startGateway();
  const local = await fetchCardHome(localGw);
  const localPrefix = `http://127.0.0.1:${localGw.port}${local.location}`;
  assert.ok(local.csp.includes(`script-src 'unsafe-inline' ${localPrefix}`), `本地 HTTP 的 script-src 前缀不对：${local.csp}`);
  assert.ok(local.csp.includes(`style-src 'unsafe-inline' ${localPrefix}`), 'style-src 也应带同一前缀');
  assert.ok(local.csp.includes(`img-src data: blob: ${localPrefix}`), 'img-src 也应带同一前缀');
  assert.ok(local.csp.includes(`connect-src ${localPrefix}`), 'connect-src 也应带同一前缀');
  assert.ok(local.csp.includes("frame-src 'none'"), 'frame-src 不该被塞进绝对地址');
  assert.ok(local.csp.startsWith('sandbox allow-scripts'), 'sandbox 指令要保持');
  assert.ok(!local.csp.includes('https://'), '没开外部 HTTPS 时 CSP 不该出现 https 源');

  const extGw = await startGateway({ HANA_GW_EXTERNAL_HTTPS: '1' });
  const ext = await fetchCardHome(extGw, { host: 'hana.example.test' });
  const extPath = `/gw/card/${ext.location.split('/gw/card/')[1]}`;
  const httpsPrefix = `https://hana.example.test${extPath}`;
  const httpPrefix = `http://hana.example.test${extPath}`;
  assert.ok(ext.csp.includes(`script-src 'unsafe-inline' ${httpsPrefix}`), `外部 HTTPS 下 script-src 首个前缀应是 https：${ext.csp}`);
  assert.ok(ext.csp.includes(`img-src data: blob: ${httpsPrefix}`), '外部 HTTPS 下 img-src 首个前缀也应是 https');
  assert.ok(ext.csp.includes(`connect-src ${httpsPrefix}`), '外部 HTTPS 下 connect-src 首个前缀也应是 https');
  // 本机仍在 http 监听：保留同 Host/同令牌路径的 http 源，否则本地打开 http://127.0.0.1 的卡片会被自己拦掉。
  assert.ok(ext.csp.includes(httpPrefix), `外部 HTTPS 下应同时保留本机 http 源：${ext.csp}`);
  const scriptSrc = ext.csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  assert.ok(scriptSrc.indexOf(httpsPrefix) < scriptSrc.indexOf(httpPrefix), '对外 scheme 应排在前面');
});

t('伪造 X-Forwarded-Proto 不改变卡片 CSP 前缀；Host 的 :443 归一成默认端口', async () => {
  const plainGw = await startGateway();
  const forged = await fetchCardHome(plainGw, { 'x-forwarded-proto': 'https' });
  assert.ok(
    forged.csp.includes(`script-src 'unsafe-inline' http://127.0.0.1:${plainGw.port}${forged.location}`),
    `伪造头不能把 CSP 前缀改成 https：${forged.csp}`,
  );
  assert.ok(!forged.csp.includes('https://'), '伪造 X-Forwarded-Proto: https 不能给 CSP 加 https 源');

  const extGw = await startGateway({ HANA_GW_EXTERNAL_HTTPS: '1' });
  const downgraded = await fetchCardHome(extGw, { 'x-forwarded-proto': 'http', host: 'hana.example.test' });
  assert.ok(
    downgraded.csp.includes(`script-src 'unsafe-inline' https://hana.example.test${downgraded.location}`),
    `伪造 http 头不能把外部 HTTPS 的 CSP 主前缀降回 http：${downgraded.csp}`,
  );

  const withPort = await fetchCardHome(extGw, { host: 'hana.example.test:443' });
  assert.ok(
    withPort.csp.includes(`script-src 'unsafe-inline' https://hana.example.test${withPort.location}`),
    `Host 带 :443 时应归一成默认端口：${withPort.csp}`,
  );
  assert.ok(!withPort.csp.includes('hana.example.test:443'), `CSP 里不应出现 :443：${withPort.csp}`);
});

/* ---- 运行 ---- */

let bad = 0;
try {
  await makeFixtures();
  await startUpstream();
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      bad += 1;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }
} catch (err) {
  bad += 1;
  console.log(`FAIL  setup\n      ${err.stack || err.message}`);
} finally {
  for (const entry of gateways) entry.stop();
  if (upstream) {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
