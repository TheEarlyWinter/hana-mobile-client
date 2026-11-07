/* tests/module_preload.test.mjs
 *
 * 启动入口契约测试（打包版）。
 *
 * 背景：前端原本是「几十个 ES 模块 + 20 份样式表」裸跑，网关对文本资源发 no-store，
 * 冷启动等于几十次往返。现在 web/ 由 scripts/build-web.mjs 打成
 * web/dist/app.<hash>.js + web/dist/app.<hash>.css，index.html 仍只写稳定引用
 * /dist/app.js 与 /dist/app.css，网关响应时按 manifest.json 换成哈希名。
 *
 * 这份测试锁住：
 * 1. head 里不再有 modulepreload（模块已合并，预载没有对象）；
 * 2. 样式表只剩一份稳定引用 /dist/app.css（注入前的源文件必须这么写）；
 * 3. 入口是 <script src="/dist/app.js" type="module">；
 * 4. 产物存在、非空，且不比 web/ 的源文件旧；清单点名的文件真的在 dist 里；
 * 5. 没有敏感信息注入，也没人偷偷改缓存策略。
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webBundleState, readDistManifest, distDir } from '../gateway/web-build.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webRoot = path.join(repoRoot, 'web');
const htmlPath = path.join(webRoot, 'index.html');
const html = readFileSync(htmlPath, 'utf8');

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

function parseHead(source) {
  const headMatch = source.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch, 'HTML 必须包含合法的 <head> 区域');
  return headMatch[1];
}

function extractLinkTags(headContent) {
  const links = [];
  const linkRegex = /<link\b([^>]*?)\/?>/gi;
  let match;
  while ((match = linkRegex.exec(headContent)) !== null) {
    const attrs = {};
    const attrRegex = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(match[1])) !== null) {
      attrs[attrMatch[1].toLowerCase()] = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    }
    links.push(attrs);
  }
  return links;
}

const head = parseHead(html);
const links = extractLinkTags(head);

await t('1. head 里不再有 modulepreload（模块已合并成一份入口）', async () => {
  const preloads = links.filter((l) => l.rel === 'modulepreload');
  assert.equal(preloads.length, 0, `打包后不该再有 modulepreload，当前有 ${preloads.length} 条`);
});

await t('2. 样式表只有一份，且指向 /dist/app.css', async () => {
  const stylesheets = links.filter((l) => l.rel === 'stylesheet').map((l) => l.href);
  assert.deepEqual(stylesheets, ['/dist/app.css'], `样式表引用应只有 /dist/app.css，当前是 ${JSON.stringify(stylesheets)}`);
});

await t('3. 入口是打包产物 /dist/app.js（type=module）', async () => {
  const entryRegex = /<script\s+src="\/dist\/app\.js"\s+type="module"\s*><\/script>|<script\s+type="module"\s+src="\/dist\/app\.js"\s*><\/script>/;
  assert.ok(entryRegex.test(html), '主入口应为 <script src="/dist/app.js" type="module"></script>');
  assert.ok(!/<script\b[^>]*src="\/app\.js"/.test(html), '不该再直接引用源文件 /app.js');
});

await t('4. 产物存在、非空，且不比源文件旧（旧了就现场重建一次）', async () => {
  let state = await webBundleState(webRoot);
  if (state.missing || state.stale) {
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-web.mjs'), '--silent'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `重建失败：${(run.stderr || run.stdout || '').slice(0, 400)}`);
    state = await webBundleState(webRoot);
  }
  assert.equal(state.missing, false, 'web/dist 产物缺失');
  assert.equal(state.stale, false, '产物比源文件旧，说明打包没跟上');
  const manifest = await readDistManifest(webRoot);
  assert.ok(manifest, '构建后必须能读出 dist/manifest.json');
  for (const name of [manifest.js, manifest.css]) {
    const st = statSync(path.join(distDir(webRoot), name));
    assert.ok(st.size > 1024, `${name} 体积异常：${st.size} 字节`);
  }
});

await t('5. 没有敏感信息注入，也不篡改缓存策略', async () => {
  const lowerHtml = html.toLowerCase();
  const bannedKeywords = ['token=', 'cookie=', 'password', 'private_key', 'secret', 'hana_home'];
  for (const banned of bannedKeywords) {
    if (banned === 'password') {
      const stripped = html.replace(/type="password"/g, '').replace(/autocomplete="current-password"/g, '');
      assert.ok(!stripped.toLowerCase().includes('password'), '检测到敏感关键字 password');
      continue;
    }
    assert.ok(!lowerHtml.includes(banned), `检测到敏感关键字: ${banned}`);
  }
  assert.ok(!head.includes('http-equiv="Cache-Control"'), '不应在 head 中添加 meta Cache-Control 篡改缓存策略');
  assert.ok(!head.includes('Clear-Site-Data'), '不应在 head 中引入 Clear-Site-Data');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
