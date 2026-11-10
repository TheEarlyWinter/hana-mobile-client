/* tests/dist_cache.test.mjs
 *
 * 产物内容哈希 + 缓存分级。
 *
 * 锁住四件互相牵连的事：
 * 1. 构建产出 app.<8位hex>.js / app.<8位hex>.css 与 manifest.json，固定名的旧产物不留；
 * 2. 同一份源码连构两次，文件名与总哈希不变（否则每次构建都会让所有手机缓存全部失效）；
 * 3. 网关响应首页时按清单把稳定引用换成哈希名，首页自身仍然 no-store；
 * 4. 只有清单点名的产物发 immutable，清单与其它 dist 文件 no-store；
 *    上一版哈希名与固定名用当前产物兜底（no-store），其它不存在的 /dist/* 仍 404；
 *    清单缺失或被写坏时首页退化成原样输出（引用 /dist/app.js），不是 500；
 * 5. 条件请求按弱比较认 `W/` 前缀、逗号列表与 `*`，304 带的缓存策略/CSP 与 200 一致；
 *    错误响应（坏 URL 400、越界 403、404）一律显式 no-store。
 *
 * 全部判定来自构建产物与真实 HTTP 响应，不靠等待。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '../gateway/static-files.mjs';
import { webBundleState, readDistManifest, distDir } from '../gateway/web-build.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webRoot = path.join(repoRoot, 'web');
const dist = distDir(webRoot);
const manifestFile = path.join(dist, 'manifest.json');

const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML_NO_STORE = 'no-store, no-cache, must-revalidate';
const HTML_CSP = "frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

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

function buildOnce() {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-web.mjs'), '--silent'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function distEntries() {
  return (await fs.readdir(dist)).sort();
}

/** 这一批应该在磁盘上的全部文件（入口 + 样式 + 按需分块 + 清单）。 */
function expectedEntries(manifest) {
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  return [manifest.css, manifest.js, `${manifest.js}.map`, 'manifest.json', ...chunks].sort();
}

// 产物可能还没建（干净检出），也允许已经是最新的：先对齐到「构建过一次」的状态。
let state = await webBundleState(webRoot);
if (state.missing || state.stale) {
  const run = buildOnce();
  assert.equal(run.status, 0, `构建失败：${(run.stderr || run.stdout || '').slice(0, 400)}`);
  state = await webBundleState(webRoot);
}
let manifest = await readDistManifest(webRoot);
assert.ok(manifest, '构建后必须能读出 manifest.json');

const server = http.createServer((req, res) => {
  serveStatic(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`gateway error: ${err?.message || err}`);
  });
});
server.unref();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;

try {
  await t('1. manifest 记录的就是 dist 里那一套，且不带固定名残留', async () => {
    manifest = await readDistManifest(webRoot);
    assert.match(manifest.js, /^app\.[0-9a-f]{8}\.js$/, `js 名字形状不对：${manifest.js}`);
    assert.match(manifest.css, /^app\.[0-9a-f]{8}\.css$/, `css 名字形状不对：${manifest.css}`);
    assert.match(manifest.hash, /^[0-9a-f]{8}$/, `总哈希应为 8 位 hex：${manifest.hash}`);
    assert.ok(Number.isFinite(Date.parse(manifest.builtAt)), `builtAt 必须是可解析时间：${manifest.builtAt}`);

    const entries = await distEntries();
    assert.deepEqual(entries, expectedEntries(manifest));
  });

  await t('2. 同一份源码连构两次，名字与总哈希不变', async () => {
    const before = await readDistManifest(webRoot);
    const run = buildOnce();
    assert.equal(run.status, 0, `第二次构建失败：${(run.stderr || run.stdout || '').slice(0, 400)}`);
    const after = await readDistManifest(webRoot);
    assert.equal(after.js, before.js, 'js 文件名变了：内容哈希没有稳定下来');
    assert.equal(after.css, before.css, 'css 文件名变了：内容哈希没有稳定下来');
    assert.equal(after.hash, before.hash, '总哈希变了');
    assert.deepEqual(await distEntries(), expectedEntries(after));
    manifest = after;
  });

  await t('3. 首页按清单注入哈希名，自身仍 no-store', async () => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    const html = res.body.toString('utf8');
    assert.ok(html.includes(`href="/dist/${manifest.css}"`), '样式表引用没换成哈希名');
    assert.ok(html.includes(`src="/dist/${manifest.js}"`), '入口脚本没换成哈希名');
    assert.ok(!html.includes('"/dist/app.js"'), '首页不该再直接引用稳定名 /dist/app.js');
    assert.ok(!html.includes('"/dist/app.css"'), '首页不该再直接引用稳定名 /dist/app.css');
    assert.equal(res.headers['cache-control'], HTML_NO_STORE, '首页必须每次回源');
    assert.equal(Number(res.headers['content-length']), res.body.length, 'content-length 必须是注入后的真实长度');
  });

  await t('4. /index.html 与 SPA 回落也走同一套注入', async () => {
    for (const pathname of ['/index.html', '/some-app-route']) {
      const res = await request(port, pathname);
      assert.equal(res.status, 200, `${pathname} 应 200`);
      const html = res.body.toString('utf8');
      assert.ok(html.includes(`src="/dist/${manifest.js}"`), `${pathname} 没注入入口脚本`);
      assert.ok(html.includes(`href="/dist/${manifest.css}"`), `${pathname} 没注入样式表`);
    }
  });

  await t('5. 首页 HEAD 的 content-length 与 GET 一致', async () => {
    const get = await request(port, '/');
    const head = await request(port, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0, 'HEAD 不应返回正文');
    assert.equal(Number(head.headers['content-length']), get.body.length);
  });

  await t('6. 清单点名的产物发 immutable，字节与文件一致', async () => {
    for (const [name, file] of [['js', manifest.js], ['css', manifest.css]]) {
      const res = await request(port, `/dist/${manifest[name]}`);
      assert.equal(res.status, 200, `${file} 应 200`);
      assert.equal(res.headers['cache-control'], IMMUTABLE, `${file} 必须是可以长期缓存的产物`);
      assert.equal(sha256(res.body), sha256(await fs.readFile(path.join(dist, file))), `${file} 正文与文件不一致`);
    }
  });

  await t('6b. 按需分块（chunk-*）也是内容寻址，发 immutable', async () => {
    const chunks = (manifest.chunks || []).filter((name) => name.endsWith('.js'));
    assert.ok(chunks.length > 0, '有动态 import（pdf 预览）就应该切出至少一个分块');
    for (const name of chunks) {
      assert.match(name, /^chunk-[A-Z0-9]+\.js$/, `分块名形状不对：${name}`);
      const res = await request(port, `/dist/${name}`);
      assert.equal(res.status, 200, `${name} 应 200`);
      assert.equal(res.headers['cache-control'], IMMUTABLE, `${name} 必须是可以长期缓存的产物`);
    }
    // 不在清单里的同形名字：不能因为“看起来像分块”就给内容，也不能给长缓存
    const ghost = await request(port, '/dist/chunk-ZZZZZZZZ.js');
    assert.equal(ghost.status, 404, '未登记的分块名不能拿到任何字节');
    assert.equal(ghost.headers['cache-control'], 'no-store');
  });

  await t('7. 清单本身与 dist 下的其它文件不能进缓存', async () => {    const manifestRes = await request(port, '/dist/manifest.json');
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers['cache-control'], 'no-store');

    const mapRes = await request(port, `/dist/${manifest.js}.map`);
    assert.equal(mapRes.status, 200);
    assert.equal(mapRes.headers['cache-control'], 'no-store', 'sourcemap 名字不带哈希，不能跟着 immutable');
  });

  await t('8. 前端源文件维持原样（no-store, no-cache, must-revalidate）', async () => {
    const res = await request(port, '/style.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], HTML_NO_STORE);
  });

  await t('8b. 文档层不再发 clear-site-data（它会顺手清掉 immutable）', async () => {
    for (const pathname of ['/', '/index.html']) {
      const res = await request(port, pathname);
      assert.equal(res.headers['clear-site-data'], undefined, `${pathname} 仍在发清缓存指令`);
    }
  });

  await t('8c. 旧哈希名与固定名都能拿到当前产物，且只能 no-store', async () => {
    const staleJs = 'app.0123abcd.js';
    const staleCss = 'app.89abcdef.css';
    const cases = [
      { path: `/dist/${staleJs}`, file: manifest.js },
      { path: `/dist/${staleCss}`, file: manifest.css },
      { path: '/dist/app.js', file: manifest.js },
      { path: '/dist/app.css', file: manifest.css },
    ];
    for (const item of cases) {
      const res = await request(port, item.path);
      assert.equal(res.status, 200, `${item.path} 应命中介质兜底`);
      assert.equal(res.headers['cache-control'], 'no-store', `${item.path} 已不是当前版本，不能进缓存`);
      assert.equal(
        sha256(res.body),
        sha256(await fs.readFile(path.join(dist, item.file))),
        `${item.path} 必须返回当前产物字节`,
      );
    }
  });

  await t('8d. 不存在的 /dist/ 路径仍然 404，兜底不会变成任意读', async () => {
    for (const pathname of ['/dist/nope.js', '/dist/nope.css', '/dist/app.0123abcd.js.map', '/dist/secret.json']) {
      const res = await request(port, pathname);
      assert.equal(res.status, 404, `${pathname} 不该命中兜底`);
      assert.equal(res.headers['cache-control'], 'no-store', `${pathname} 的 404 也不能被中间层记住`);
    }
  });

  await t('9. 清单缺失时首页退化成稳定引用，缓存头回落 no-store，不 500', async () => {
    await fs.rename(manifestFile, `${manifestFile}.bak`);
    try {
      const res = await request(port, '/');
      assert.equal(res.status, 200, '没有清单也必须能出页面');
      const html = res.body.toString('utf8');
      assert.ok(html.includes('src="/dist/app.js"'), '没清单时首页应保持稳定引用');
      assert.ok(html.includes('href="/dist/app.css"'));
      assert.equal(res.headers['cache-control'], HTML_NO_STORE);

      // 没有清单就证明不了「这个名字的内容永不变化」，产物也得回落到 no-store。
      const asset = await request(port, `/dist/${manifest.js}`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers['cache-control'], 'no-store');
    } finally {
      await fs.rename(`${manifestFile}.bak`, manifestFile);
    }
  });

  await t('10. 清单被写坏时同样退化，不 500', async () => {
    const original = await fs.readFile(manifestFile);
    await fs.writeFile(manifestFile, '{ this is not json');
    try {
      const res = await request(port, '/');
      assert.equal(res.status, 200);
      assert.ok(res.body.toString('utf8').includes('src="/dist/app.js"'), '坏清单应退化成稳定引用');
    } finally {
      await fs.writeFile(manifestFile, original);
    }
    assert.equal((await request(port, '/dist/manifest.json')).status, 200, '清单必须恢复');
  });

  await t('11. 过期判断用 manifest.builtAt：刚构建完不算过期', async () => {
    const latest = await webBundleState(webRoot);
    assert.equal(latest.missing, false);
    assert.equal(latest.stale, false, '刚构建完就判过期，说明比对基准用错了，网关会每次启动都重建');
  });

  await t('12. 源文件比 builtAt 新才判过期，缺清单算没建过', async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hana-dist-state-'));
    try {
      const builtAt = new Date('2026-01-01T00:00:00.000Z');
      const distScratch = path.join(scratch, 'dist');
      await fs.mkdir(distScratch);
      await fs.writeFile(path.join(distScratch, 'app.aaaaaaaa.js'), 'x');
      await fs.writeFile(path.join(distScratch, 'app.bbbbbbbb.css'), 'y');
      await fs.writeFile(
        path.join(distScratch, 'manifest.json'),
        JSON.stringify({ js: 'app.aaaaaaaa.js', css: 'app.bbbbbbbb.css', builtAt: builtAt.toISOString(), hash: 'deadbeef' }),
      );
      const source = path.join(scratch, 'index.html');
      await fs.writeFile(source, '<html></html>');

      await fs.utimes(source, new Date(builtAt.getTime() - 60_000), new Date(builtAt.getTime() - 60_000));
      const fresh = await webBundleState(scratch);
      assert.equal(fresh.missing, false);
      assert.equal(fresh.stale, false, '源文件比 builtAt 旧时不该判过期');

      await fs.utimes(source, new Date(builtAt.getTime() + 60_000), new Date(builtAt.getTime() + 60_000));
      const stale = await webBundleState(scratch);
      assert.equal(stale.stale, true, '源文件比 builtAt 新时必须判过期');

      await fs.rm(path.join(distScratch, 'manifest.json'));
      const missing = await webBundleState(scratch);
      assert.equal(missing.missing, true, '没有清单就是没建过');
      assert.equal(missing.stale, true);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  await t('13. 条件请求命中 → 304，缓存策略与 200 完全一致', async () => {
    // 304 也是这个 URL 的一份响应：中间层会拿它的头更新这条缓存，缺了 cache-control
    // 就等于让「命中」把原来的策略抹掉（immutable 变回可协商，no-store 也保不住）。
    for (const [pathname, expected] of [
      ['/', HTML_NO_STORE],
      [`/dist/${manifest.js}`, IMMUTABLE],
      [`/dist/${manifest.css}`, IMMUTABLE],
    ]) {
      const first = await request(port, pathname);
      assert.equal(first.status, 200);
      assert.equal(first.headers['cache-control'], expected, `${pathname} 的 200 缓存策略变了`);
      const etag = first.headers.etag;
      assert.match(String(etag), /^W\/"[^"]+"$/, `${pathname} 应发弱 etag`);

      const again = await request(port, pathname, { headers: { 'if-none-match': etag } });
      assert.equal(again.status, 304, `${pathname} etag 完全相等时必须 304`);
      assert.equal(again.body.length, 0, '304 不能带正文');
      assert.equal(again.headers.etag, etag, '304 要回同一条 etag');
      assert.equal(again.headers['cache-control'], expected, `${pathname} 的 304 必须带同一套缓存策略`);
    }
  });

  await t('13b. 首页的 304 仍带 CSP，与 200 一致', async () => {
    const first = await request(port, '/');
    assert.equal(first.headers['content-security-policy'], HTML_CSP, '200 的 CSP 变了就说明这条用例要一起改');
    const again = await request(port, '/', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers['content-security-policy'], HTML_CSP, '304 丢掉 CSP，中间层会按无 CSP 更新这份文档的元数据');
  });

  await t('14. if-none-match 按弱比较解析列表、* 与去掉 W/ 的强形式', async () => {
    const pathname = `/dist/${manifest.css}`;
    const etag = (await request(port, pathname)).headers.etag;
    const strong = etag.replace(/^W\//, '');
    assert.notEqual(strong, etag, '我们要发的必须是弱 etag，才谈得上弱比较');

    const cases = [
      ['列表里的第二项', `"0123456789abcdef", ${etag}`],
      ['列表里的中间项', `"0123456789abcdef", ${etag}, "fedcba9876543210"`],
      ['同值的强形式', strong],
      ['通配符', '*'],
    ];
    for (const [label, value] of cases) {
      const res = await request(port, pathname, { headers: { 'if-none-match': value } });
      assert.equal(res.status, 304, `${label} 应命中 304：${value}`);
      assert.equal(res.headers['cache-control'], IMMUTABLE, `${label} 的 304 也要带缓存策略`);
      assert.equal(res.body.length, 0);
    }
  });

  await t('14b. 条件不命中／空头／坏形态仍老老实实 200 带正文', async () => {
    const pathname = `/dist/${manifest.js}`;
    const etag = (await request(port, pathname)).headers.etag;
    const cases = [
      ['别的 etag', 'W/"0000000000"'],
      ['列表里没有我们', '"0000000000", "1111111111"'],
      ['只有 W/ 前缀', 'W/'],
      ['空串', ''],
    ];
    for (const [label, value] of cases) {
      const res = await request(port, pathname, { headers: { 'if-none-match': value } });
      assert.equal(res.status, 200, `${label} 不该命中 304：${JSON.stringify(value)}`);
      assert.equal(res.headers.etag, etag);
      assert.ok(res.body.length > 0, '200 必须有正文');
      assert.equal(res.headers['cache-control'], IMMUTABLE);
    }
  });

  await t('15. 错误响应统一 no-store（坏 URL 400、越界 403）', async () => {
    // 400 以前什么缓存头都不带，浏览器可能按启发式把「坏 URL」记一段时间。
    const badUrl = await request(port, '/bad%zz.html');
    assert.equal(badUrl.status, 400, '非法百分号编码必须 400');
    assert.equal(badUrl.headers['cache-control'], 'no-store', '400 也要显式 no-store');

    const escape = await request(port, '/..%2f..%2fpackage.json');
    assert.equal(escape.status, 403, '解到 web/ 外面必须 403');
    assert.equal(escape.headers['cache-control'], 'no-store');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (bad > 0) {
  console.error(`\nFAILED: ${bad} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
