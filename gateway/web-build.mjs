/**
 * 前端产物的「清单契约」与启动自检。
 *
 * 为什么要有清单：产物名现在跟着内容走（app.<hash>.js / app.<hash>.css），
 * 页面里写的仍是稳定引用 `/dist/app.js`，响应时才按清单换成哈希名。
 * 清单是「当前这批产物叫什么」的唯一来源，构建端写、网关读，
 * 所以这份形状约定放在网关侧（运行期不依赖 esbuild），构建脚本反过来 import 它。
 *
 * 为什么判断过期要换成 manifest.builtAt：产物名带哈希以后，产物文件的 mtime
 * 每次构建都会变，拿它当基准会永远判过期、每次启动都重建；清单里的 builtAt
 * 是构建开始时的时间戳，比它新的源文件才算过期。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DIST_DIRNAME = 'dist';
export const MANIFEST_NAME = 'manifest.json';

/**
 * 只认构建脚本产出的形状。清单被手工改坏或被写进奇怪路径时，
 * 宁可不注入、退化成原样输出，也不把任意字符串拼进 HTML。
 */
export const ASSET_NAME = {
  js: /^app\.[0-9a-f]{8}\.js$/,
  css: /^app\.[0-9a-f]{8}\.css$/,
};

export function distDir(webRoot) {
  return path.join(webRoot, DIST_DIRNAME);
}

/**
 * 读清单；任何一步不对就返回 null（缺失、不是合法 JSON、名字形状不对）。
 * 调用方把它当作「没构建」处理，而不是当异常。
 * @returns {Promise<{js: string, css: string, builtAt: string, hash: string}|null>}
 */
export async function readDistManifest(webRoot) {
  let text;
  try {
    text = await fsp.readFile(path.join(distDir(webRoot), MANIFEST_NAME), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const js = typeof parsed.js === 'string' ? parsed.js : '';
  const css = typeof parsed.css === 'string' ? parsed.css : '';
  if (!ASSET_NAME.js.test(js) || !ASSET_NAME.css.test(css)) return null;
  return {
    js,
    css,
    builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : '',
    hash: typeof parsed.hash === 'string' ? parsed.hash : '',
  };
}

/** web/ 下最新的源文件时间；dist 与 node_modules 不算。 */
export async function newestSourceMtime(webRoot) {
  let newest = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === DIST_DIRNAME || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // 文件刚好被删：跳过，别让一次竞态把启动拦住
      }
    }
  }
  await walk(webRoot);
  return newest;
}

/**
 * @returns {Promise<{missing: boolean, stale: boolean, newestSource: number, builtAt: number, manifest: object|null}>}
 * missing = 清单缺失/不合法/清单点名的文件不在；
 * stale   = 有源文件比清单的 builtAt 新。
 */
export async function webBundleState(webRoot) {
  const manifest = await readDistManifest(webRoot);
  if (!manifest) return { missing: true, stale: true, newestSource: 0, builtAt: 0, manifest: null };

  for (const name of [manifest.js, manifest.css]) {
    try {
      const st = await fsp.stat(path.join(distDir(webRoot), name));
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return { missing: true, stale: true, newestSource: 0, builtAt: 0, manifest };
    }
  }

  const newestSource = await newestSourceMtime(webRoot);
  const builtAt = Date.parse(manifest.builtAt);
  // builtAt 缺失或不可解析时当作过期：手上这批产物不知道新旧，就不能让它被发成 immutable。
  const stale = !Number.isFinite(builtAt) || newestSource > builtAt;
  return { missing: false, stale, newestSource, builtAt: Number.isFinite(builtAt) ? builtAt : 0, manifest };
}

/**
 * 需要时重建。失败不抛：网关照常起，日志里留下原因（页面会 404，比整站起不来更好排查）。
 * @returns {Promise<{built: boolean, ok: boolean, ms?: number, error?: string}>}
 */
export async function ensureWebBundle({ webRoot, repoRoot, log = () => {} }) {
  const state = await webBundleState(webRoot);
  if (!state.missing && !state.stale) return { built: false, ok: true };

  const script = path.join(repoRoot, 'scripts', 'build-web.mjs');
  const started = Date.now();
  try {
    await run(process.execPath, [script, '--silent'], { cwd: repoRoot, timeout: 180000 });
    const ms = Date.now() - started;
    log(`[web] 重建前端产物 (${state.missing ? '缺失' : '过期'})，用时 ${ms}ms`);
    return { built: true, ok: true, ms };
  } catch (err) {
    const detail = (err?.stderr || err?.message || String(err)).toString().trim().slice(0, 500);
    log(`[web] 前端产物重建失败：${detail}`);
    return { built: true, ok: false, error: detail };
  }
}
