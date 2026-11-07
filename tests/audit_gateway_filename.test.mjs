/* 网关下载文件名回归（审计 G2）。
 *
 * 直接用 createHttpProxy 起进程内网关，mock upstream 返回真实响应头；
 * 断言的是 proxyHttp 实际写给客户端的 Content-Disposition，不 grep 源码。
 *
 * 目标行为：
 * - Unicode 名保留在 RFC 5987 的 filename* 里；
 * - 另给 ASCII fallback filename，ASCII 名保持不变；
 * - 路径分隔符、控制字符、引号等注入字符仍被清理。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_ROOT = path.resolve(__dirname, 'artifacts');

let upstreamServer;
let upstreamPort;
let gatewayServer;
let gatewayPort;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatewayPort, method: 'GET', path: rawPath, headers: { connection: 'close' } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`request timeout: ${rawPath}`)));
    req.on('error', reject);
    req.end();
  });
}

function parseDisposition(raw) {
  const value = String(raw || '');
  const ascii = /filename="([^"]*)"/.exec(value)?.[1] ?? null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1] ?? null;
  let unicodeName = null;
  if (encoded) {
    try {
      unicodeName = decodeURIComponent(encoded);
    } catch {
      unicodeName = null;
    }
  }
  return { raw: value, ascii, unicode: unicodeName };
}

function assertSafeHeader(parsed, label) {
  assert.ok(parsed.raw, `${label} 应有 Content-Disposition`);
  assert.match(parsed.raw, /^attachment(?:;|$)/, `${label} 必须是 attachment`);
  assert.ok(!/[\r\n]/.test(parsed.raw), `${label} 不得含 CR/LF`);
  assert.ok(parsed.ascii !== null, `${label} 应有 ASCII fallback filename`);
  assert.match(parsed.ascii, /^[\x20-\x7e]+$/, `${label} 的 filename 必须是可打印 ASCII`);
  assert.ok(!/[\\/:*?"<>|]/.test(parsed.ascii), `${label} 的 filename 不得含路径分隔符或注入字符`);
  assert.ok(parsed.unicode !== null, `${label} 应有可解码的 filename*`);
  for (const ch of ['\r', '\n', '"', '\\', '/']) {
    assert.ok(!parsed.unicode.includes(ch), `${label} 的 filename* 不得含 ${JSON.stringify(ch)}`);
  }
  assert.ok(!parsed.unicode.includes('..'), `${label} 的 filename* 不得含 ..`);
}

async function startUpstream() {
  upstreamServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const kind = url.searchParams.get('case') || 'unicode';
    const headers = { 'content-type': 'application/octet-stream' };

    if (kind === 'unicode') {
      headers['content-disposition'] =
        "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%E6%8A%A5%E5%91%8A.pdf";
    } else if (kind === 'ascii') {
      headers['content-disposition'] = 'attachment; filename="report-2026.pdf"';
    } else if (kind === 'evil') {
      headers['content-disposition'] =
        "attachment; filename*=UTF-8''..%2F..%2Fevil%0D%0ASet-Cookie%3A%20x%3D1%22.pdf";
    } else if (kind === 'evildoc') {
      headers['content-type'] = 'text/html; charset=utf-8';
      headers['content-disposition'] =
        'attachment; filename="doc.pdf"; filename*=UTF-8\'\'..%2F..%2Fevil%0D%0AX-Evil%3A%20yes.pdf';
    } else if (kind === 'noheader') {
      delete headers['content-disposition'];
    }

    res.writeHead(200, headers);
    res.end(kind === 'evildoc' ? '<html><body>DOC</body></html>' : 'x');
  });
  upstreamPort = await listen(upstreamServer);
}

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('上游 filename* 中文：filename* 保留 Unicode，filename 是 ASCII fallback', async () => {
  const res = await request('/api/workspace/content?case=unicode');
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assertSafeHeader(parsed, '上游 filename* 中文');
  assert.equal(parsed.unicode, '中文报告.pdf', 'filename* 不能把中文替换成下划线');
  assert.equal(parsed.ascii, '____.pdf', 'ASCII fallback 应由 Unicode 名逐字替换得到');
  assert.ok(!parsed.raw.includes('中文'), 'filename= 里不应直接出现非 ASCII 字节');
});

t('URL name 中文兜底：上游没有 Content-Disposition 时仍保留 Unicode 到 filename*', async () => {
  const res = await request('/api/mobile/workspace/content?case=noheader&name=%E4%B8%AD%E6%96%87.pdf');
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assertSafeHeader(parsed, 'URL name 中文');
  assert.equal(parsed.unicode, '中文.pdf');
  assert.equal(parsed.ascii, '__.pdf');
});

t('ASCII 文件名保持不变，仍同时给出 filename 与 filename*', async () => {
  const res = await request('/api/workspace/content?case=ascii');
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assert.equal(parsed.ascii, 'report-2026.pdf');
  assert.equal(parsed.unicode, 'report-2026.pdf');
  assert.equal(
    parsed.raw,
    'attachment; filename="report-2026.pdf"; filename*=UTF-8\'\'report-2026.pdf',
  );
});

t('恶意分隔符与控制字符仍安全：不产生 CRLF/引号注入或路径穿越', async () => {
  const res = await request('/api/workspace/content?case=evil');
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assertSafeHeader(parsed, '上游恶意 filename*');
  assert.equal(res.headers['set-cookie'], undefined, '文件名不得注入 Set-Cookie');
  assert.ok(parsed.unicode.includes('evil'), '清理后仍应保留可识别的主体');
  assert.ok(parsed.unicode.endsWith('.pdf'));
});

t('URL name 里的恶意分隔符/CRLF 同样被清理', async () => {
  const res = await request(
    '/api/workspace/content?case=noheader&name=..%5C..%5Cevil%22%0D%0AX%3A%20y.pdf',
  );
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assertSafeHeader(parsed, 'URL name 恶意');
  assert.ok(parsed.unicode.includes('evil'));
  assert.ok(parsed.unicode.endsWith('.pdf'));
});

t('任意 /api 文档响应也走同一套文件名清理', async () => {
  const res = await request('/api/doc?case=evildoc');
  assert.equal(res.status, 200);
  const parsed = parseDisposition(res.headers['content-disposition']);
  assertSafeHeader(parsed, '文档响应恶意 filename*');
  assert.ok(parsed.unicode.includes('evil'));
  assert.ok(parsed.unicode.endsWith('.pdf'));
});

let bad = 0;
try {
  await startUpstream();
  process.env.HANA_UPSTREAM_HOST = '127.0.0.1';
  process.env.HANA_UPSTREAM_PORT = String(upstreamPort);
  process.env.HANA_HOME = path.join(ARTIFACTS_ROOT, 'audit-filename-fake-home');
  process.env.HANA_GW_LOG_WS = '';

  const { createHttpProxy } = await import('../gateway/http-proxy.mjs');
  const proxy = createHttpProxy({
    isApiPath: (rawUrl) => rawUrl.startsWith('/api/') || rawUrl.startsWith('/mobile/api/'),
  });
  gatewayServer = http.createServer((req, res) => proxy.proxyHttp(req, res));
  gatewayPort = await listen(gatewayServer);

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
  if (gatewayServer) await new Promise((resolve) => gatewayServer.close(resolve));
  if (upstreamServer) {
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
  console.log(`artifacts kept at ${ARTIFACTS_ROOT}`);
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
