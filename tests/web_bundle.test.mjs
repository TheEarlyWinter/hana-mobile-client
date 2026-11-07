/* tests/web_bundle.test.mjs
 *
 * 打包清单守卫：防止「加了文件忘了登记，于是在页面上静默缺失」。
 *
 * 两条规则：
 * 1. web/ 下每个 .css 都必须在 scripts/build-web.mjs 的 STYLES 里登记（顺序即层叠顺序）；
 * 2. web/ 下每个 .js 都必须从 app.js 的 import 图可达，找不到的要么接线，要么显式登记。
 *
 * 刻意不依赖 esbuild：这里只用正则读 import 语句建图，跑测试不需要 node_modules。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLES, JS_ENTRY } from '../scripts/build-web.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webRoot = path.join(repoRoot, 'web');

/** 明确不参与打包的模块：键是相对 web/ 的路径，值是原因。 */
const ALLOWED_UNBUNDLED = new Map([
  [
    'outbox.js',
    'B2 待接线：自动重试与「失败留在输入框」语义互斥，模块与测试先留着（见文件头）',
  ],
]);

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

/** web/ 下所有指定后缀的文件（跳过构建产物与依赖目录）。 */
async function listFiles(ext) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name.endsWith(ext)) out.push(path.relative(webRoot, full).replace(/\\/g, '/'));
    }
  }
  await walk(webRoot);
  return out.sort();
}

/** 从源码里抓静态 import / export ... from 的相对说明符。 */
function staticImports(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^'"()]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"()]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      if (m[1].startsWith('.')) specs.push(m[1]);
    }
  }
  return specs;
}

/** 从 JS_ENTRY 出发做可达集。 */
async function reachableFromEntry() {
  const seen = new Set();
  const queue = [JS_ENTRY];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let source;
    try {
      source = await fs.readFile(path.join(webRoot, rel), 'utf8');
    } catch {
      continue;
    }
    for (const spec of staticImports(source)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (resolved.startsWith('..')) continue;
      queue.push(resolved);
    }
  }
  return seen;
}

const jsFiles = await listFiles('.js');
const reachable = await reachableFromEntry();

await t('1. web/ 下每个 .js 都在 app.js 的 import 图里（或显式登记为待接线）', async () => {
  const orphans = jsFiles.filter((file) => !reachable.has(file) && !ALLOWED_UNBUNDLED.has(file));
  assert.deepEqual(orphans, [], `以下模块没有被任何地方 import，请接线或登记：\n      ${orphans.join('\n      ')}`);
});

await t('2. 登记过的待接线模块，注释里说得出原因', async () => {
  for (const [file, reason] of ALLOWED_UNBUNDLED) {
    assert.ok(reason && reason.length >= 8, `${file} 的豁免理由太短，等于没写`);
  }
});

await t('3. web/ 下每个 .css 都登记在 STYLES 里', async () => {
  const cssFiles = await listFiles('.css');
  const missing = cssFiles.filter((file) => !STYLES.includes(file));
  assert.deepEqual(missing, [], `以下样式表没有登记进 scripts/build-web.mjs 的 STYLES：\n      ${missing.join('\n      ')}`);
});

await t('4. STYLES 里每一项都真实存在，且没有重复', async () => {
  assert.equal(new Set(STYLES).size, STYLES.length, 'STYLES 里有重复项');
  for (const rel of STYLES) {
    const st = await fs.stat(path.join(webRoot, rel)).catch(() => null);
    assert.ok(st && st.isFile(), `STYLES 登记的 ${rel} 不存在`);
  }
});

await t('5. 深色主题排在样式表最后（它靠源顺序覆盖前面的组件规则）', async () => {
  assert.equal(STYLES[STYLES.length - 1], 'themes/dark.css', 'themes/dark.css 必须是最后一项');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
