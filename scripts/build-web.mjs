#!/usr/bin/env node
/**
 * 前端打包：把 web/ 的模块图与样式表各合成一份，产物落在 web/dist/。
 *
 * 为什么要有这一步：前端原本是「几十个 ES 模块 + 20 份样式表」直接裸跑，
 * 网关对文本资源发 no-store（改完必须立刻生效），于是每次冷启动都要重走
 * 几十个往返。在 200ms 级别的移动链路上，这笔开销比传输字节本身贵得多。
 *
 * 约定：
 *  - 入口固定 web/app.js，产物名带内容哈希：app.<8位hex>.js / app.<8位hex>.css
 *    （带哈希才敢让浏览器长期缓存；同一个 URL 的内容必须永不变化）
 *  - 每次构建写 web/dist/manifest.json 记录「这一批产物叫什么」，网关据此
 *    在响应首页时把 `/dist/app.js`、`/dist/app.css` 换成哈希名
 *  - 产物是构建物，不进仓库；网关启动时会按 manifest.builtAt 自动重建
 *  - 样式表顺序 = 层叠顺序，见 STYLES；新增样式表必须登记在这里（有测试兜底）
 *
 * 用法：
 *   node scripts/build-web.mjs            构建一次
 *   node scripts/build-web.mjs --watch    监听改动重建
 *   node scripts/build-web.mjs --silent   只在出错时出声（网关自动构建用）
 */

import { build, context } from 'esbuild';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ASSET_NAME, DIST_DIRNAME, MANIFEST_NAME, webBundleState } from '../gateway/web-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..');
export const webRoot = path.join(repoRoot, 'web');
export const outDir = path.join(webRoot, DIST_DIRNAME);

/**
 * 样式表的层叠顺序。改成别的顺序会改到真实渲染结果，
 * 尤其 themes/dark.css 必须在最后（它靠顺序 + 特异性双重覆盖）。
 */
export const STYLES = [
  'themes/warm-paper.css',
  'style.css',
  'workspace.css',
  'action-confirmation.css',
  'settings.css',
  'session-actions.css',
  'message-actions.css',
  'casual.css',
  'casual-stickers.css',
  'card-height.css',
  'code-copy.css',
  'lightbox.css',
  'code-folder-picker.css',
  'code-panel.css',
  'connection-banner.css',
  'pending-state.css',
  'feed/feed.css',
  'subagent-sheet.css',
  // 文件预览：docx 用 file-preview 自带样式；xlsx / pptx / pdf 各自一份，
  // 只在打开对应文件时才用得上，但样式表不切分（总量小于 10KB，合并比多一次请求划算）。
  'xlsx-preview.css',
  'pptx-preview.css',
  'pdf-preview.css',
  'toast.css',
  'themes/dark.css',
];

export const JS_ENTRY = 'app.js';

/** 构建期先写固定名，产物出来才知道哈希；这两个名字不会留在 dist 里。 */
const TMP_JS = 'app.js';
const TMP_MAP = 'app.js.map';
const TMP_CSS = 'app.css';

const SOURCE_MAP_COMMENT = /^\/\/# sourceMappingURL=.*$/m;

/** 样式入口用 stdin 喂给 esbuild：@import 会被内联，顺序即数组顺序。 */
function styleEntrySource() {
  return STYLES.map((rel) => `@import ${JSON.stringify(`./${rel.replace(/\\/g, '/')}`)};`).join('\n');
}

/**
 * 清单更新失败要吵：静默失败的意思是「页面还指着旧产物」，
 * 而旧产物可能已经被下一次构建删掉了。
 */
function manifestPlugin() {
  return {
    name: 'dist-manifest',
    setup(buildApi) {
      buildApi.onEnd((result) => {
        if (result.errors.length) return;
        scheduleFinalize();
      });
    },
  };
}

function jsOptions({ watch = false } = {}) {
  return {
    absWorkingDir: webRoot,
    entryPoints: [{ in: JS_ENTRY, out: 'app' }],
    bundle: true,
    format: 'esm',
    target: ['chrome100', 'safari15'],
    platform: 'browser',
    outdir: outDir,
    // 按需加载的分块：PDF 预览要引 pdf.js（1MB 级），不能塞进主包拖慢每次冷启动。
    // 开切分后，`await import()` 的模块会单独出一个包；包名自带内容哈希（chunk-XXXXXXXX.js），
    // 所以它们也能按 immutable 缓存——前提是清单里登记（网关靠清单认「内容寻址」）。
    splitting: true,
    chunkNames: 'chunk-[hash]',
    // 弱网下字节数也算钱：网关不做 gzip，就靠这里压掉空白与注释
    minify: true,
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    plugins: [outputsPlugin(), ...(watch ? [manifestPlugin()] : [])],
  };
}

function cssOptions({ watch = false } = {}) {
  return {
    absWorkingDir: webRoot,
    stdin: {
      contents: styleEntrySource(),
      resolveDir: webRoot,
      sourcefile: 'styles.entry.css',
      loader: 'css',
    },
    outfile: path.join(outDir, TMP_CSS),
    bundle: true,
    minify: true,
    target: ['chrome100', 'safari15'],
    logLevel: 'warning',
    plugins: watch ? [manifestPlugin()] : [],
  };
}

/** 产物是否比源文件旧（网关启动时据此决定要不要重建）。 */
export async function isStale() {
  const state = await webBundleState(webRoot);
  return state.missing || state.stale;
}

function hash8(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * 哈希只算代码本体，不算 sourceMappingURL 那一行：
 * 那行要跟着哈希名改写，把它算进去就成了「名字决定内容、内容决定名字」的循环。
 * 剩下的映射是一一对应的，改了代码一定换名。
 */
async function publishScript() {
  const code = await fsp.readFile(path.join(outDir, TMP_JS), 'utf8');
  const name = `app.${hash8(code.replace(SOURCE_MAP_COMMENT, ''))}.js`;
  const mapName = `${name}.map`;
  const body = code.replace(SOURCE_MAP_COMMENT, `//# sourceMappingURL=${mapName}`);
  await fsp.writeFile(path.join(outDir, name), body);
  await fsp.rename(path.join(outDir, TMP_MAP), path.join(outDir, mapName));
  await fsp.rm(path.join(outDir, TMP_JS), { force: true });
  return { name, mapName, bytes: Buffer.byteLength(body) };
}

async function publishStyles() {
  const css = await fsp.readFile(path.join(outDir, TMP_CSS));
  const name = `app.${hash8(css)}.css`;
  await fsp.writeFile(path.join(outDir, name), css);
  await fsp.rm(path.join(outDir, TMP_CSS), { force: true });
  return { name, bytes: css.length };
}

/**
 * 名字形状是网关注入时的信任边界：构建端先自己挡一道，
 * 免得写出一个网关拒认的名字（那时页面会一直指着稳定名，静默跑旧代码）。
 */
function assertName(kind, name) {
  if (!ASSET_NAME[kind].test(name)) throw new Error(`产物名不符合约定（${kind}）：${name}`);
}

async function writeManifest({ js, css, chunks, builtAt }) {
  assertName('js', js);
  assertName('css', css);
  const manifest = {
    js,
    css,
    // 动态 import 切出来的分块（当前只有 pdf.js 那一份）。没有就是空数组。
    chunks: Array.isArray(chunks) ? chunks : [],
    builtAt: builtAt.toISOString(),
    hash: hash8(`${js}:${css}:${(chunks || []).join(',')}`),
  };
  await fsp.writeFile(path.join(outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * 记下这次构建到底产了哪些文件（以 esbuild 的 metafile 为准）。
 * 不能用「扫 outdir」的写法：上一版的分块还在目录里，会被当成本次产物保留下来，
 * 跨构建越积越多（实测积到 2.5MB 且全进了清单）。
 */
let lastOutputs = [];

function recordBuildOutputs(result) {
  const outputs = result?.metafile?.outputs;
  if (!outputs) return;
  lastOutputs = Object.keys(outputs).map((abs) => path.basename(abs));
}

function outputsPlugin() {
  return {
    name: 'capture-outputs',
    setup(buildApi) {
      buildApi.onEnd((result) => {
        if (result?.errors?.length) return;
        recordBuildOutputs(result);
      });
    },
  };
}

/**
 * esbuild 切出来的分块：除入口与样式之外，本次构建真正产出的 js / map。
 * 名字已经带内容哈希，不再改名——改一次就要连带改写入口里的引用，得不偿失。
 */
async function collectChunks() {
  const names = new Set();
  for (const entry of lastOutputs) {
    if (!entry.endsWith('.js') && !entry.endsWith('.js.map')) continue;
    if (entry === TMP_JS || entry === TMP_MAP) continue;
    // 入口已经发布成哈希名，不是分块。
    if (/^app\.[0-9a-f]{8}\.js(\.map)?$/.test(entry)) continue;
    names.add(entry);
  }
  return Array.from(names).sort();
}

/** 只留这一批：固定名的旧产物、上一版的哈希文件都清掉，不留垃圾。 */
async function pruneOutDir(keep) {
  const keepSet = new Set([MANIFEST_NAME, ...keep]);
  for (const entry of await fsp.readdir(outDir)) {
    if (keepSet.has(entry)) continue;
    await fsp.rm(path.join(outDir, entry), { recursive: true, force: true });
  }
}

/**
 * 把固定名产物换成内容哈希名、写清单、清旧文件。
 * 清单最后写：读的人要么看到完整的一套旧的，要么看到完整的一套新的。
 */
async function finalizeDist({ builtAt = new Date() } = {}) {
  const script = await publishScript();
  const styles = await publishStyles();
  const chunks = await collectChunks();
  const manifest = await writeManifest({ js: script.name, css: styles.name, chunks, builtAt });
  await pruneOutDir([script.name, script.mapName, styles.name, ...chunks]);
  const sizes = { [script.name]: script.bytes, [styles.name]: styles.bytes };
  return { manifest, sizes };
}

/** watch 模式下两个 esbuild 上下文各自触发；串起来跑，避免同时改名/删文件。 */
let finalizeChain = Promise.resolve();
function scheduleFinalize() {
  finalizeChain = finalizeChain
    .then(() => finalizeDist({ builtAt: new Date() }))
    .catch((err) => console.error('[build-web] 产物清单更新失败：', err?.message || err));
  return finalizeChain;
}

export async function buildOnce({ silent = false } = {}) {
  const builtAt = new Date();
  const started = Date.now();
  await fsp.mkdir(outDir, { recursive: true });

  await build(jsOptions());
  await build(cssOptions());
  const { manifest, sizes } = await finalizeDist({ builtAt });

  const ms = Date.now() - started;
  if (!silent) {
    const parts = Object.entries(sizes).map(([name, bytes]) => `${name} ${(bytes / 1024).toFixed(0)}KB`);
    console.log(`[build-web] ${parts.join('  ')}  (${ms}ms)`);
  }
  return { ms, sizes, manifest };
}

export async function watch() {
  await fsp.mkdir(outDir, { recursive: true });
  const jsCtx = await context(jsOptions({ watch: true }));
  await jsCtx.watch();
  const cssCtx = await context(cssOptions({ watch: true }));
  await cssCtx.watch();
  console.log('[build-web] watching web/ …');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--watch')) {
    await watch();
  } else {
    try {
      await buildOnce({ silent: args.has('--silent') });
    } catch (err) {
      console.error('[build-web] 打包失败：', err?.message || err);
      process.exit(1);
    }
  }
}
