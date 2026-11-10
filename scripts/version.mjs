#!/usr/bin/env node
/**
 * 版本单一来源：`package.json` 的 `version`。
 *
 * 以前版本号散在好几处，而且互相之间没有关系：
 *   - `package.json` 的 `version`（0.1.0，早就没跟着发版走）
 *   - `android/AndroidManifest.xml` 的 `versionName` / `versionCode`（0.4 / 4，更落后）
 *   - `package-lock.json` 的根 `version`（两份：顶层和 `packages[""]`，谁都不改就永远是旧值）
 *   - 每次打包时在命令行上现敲的 `-VersionName` / `-VersionCode`（抄错就是产出一个
 *     versionCode 倒退、装不上的包，或者版本名和内容对不上的包）
 * 现在只有 `package.json` 的 `version` 是人改的，其余位置都是它的镜像，由 `setVersion()` 写。
 * 依赖自己的版本号不在镜子之列：`rewriteLockVersion()` 只动根版本那两处。
 *
 * 约定：
 *  - `versionCode` 不再手写：`major * 10000 + minor * 100 + patch`（0.9.10 → 910）。
 *    所以 minor / patch 必须 ≤ 99，否则 0.100.0 会和 1.0.0 撞成同一个码。
 *  - 不碰 `web/download/latest.json`：那是「已经发布出去的事实」，由 `scripts/release.ps1` 写。
 *    在这里改它等于篡改线上版本基线。
 *  - `MainActivity.java` 里没有应用版本常量（只有 `BRIDGE_PROTOCOL_VERSION`，那是网页与原生
 *    报文的协议版本，和发版无关），所以没有第三处要同步。
 *
 * 用法：
 *   node scripts/version.mjs                            打印当前版本、versionCode、镜像是否落后
 *   node scripts/version.mjs --json                     给脚本用：{"version":"0.9.10","versionCode":910}
 *   node scripts/version.mjs --json --version 0.9.11    只算另一个版本的 versionCode，不读文件
 *   node scripts/version.mjs set 0.9.11                 改版本：package.json + AndroidManifest.xml + lockfile
 *   npm run version:set -- 0.9.11                       同上
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '..');
export const packageJsonPath = path.join(repoRoot, 'package.json');
export const manifestPath = path.join(repoRoot, 'android', 'AndroidManifest.xml');
export const lockPath = path.join(repoRoot, 'package-lock.json');

// 只认 1~3 段数字：0.9 / 0.9.10 / 1.0.0。带后缀的版本名（0.9.10-share）由打包脚本自己拼，
// 不写进 package.json——那是同一个版本的两种产物，不是两个版本。
const VERSION_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?$/;

/**
 * 解析并规范化版本号。`0.9` → `0.9.0`。
 * @param {string} input
 * @returns {{ version: string, major: number, minor: number, patch: number }}
 */
export function parseVersion(input) {
  const text = String(input ?? '').trim();
  const match = VERSION_PATTERN.exec(text);
  if (!match) {
    throw new Error(`版本号要写成 0.9.10 这种形式（1~3 段数字），收到的是：${JSON.stringify(input)}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (minor > 99) {
    throw new Error(`minor 不能超过 99：${text} 会和 ${major + 1}.0.0 算成同一个 versionCode`);
  }
  if (patch > 99) {
    throw new Error(`patch 不能超过 99：${text} 会和 ${major}.${minor + 1}.0 算成同一个 versionCode`);
  }
  return { version: `${major}.${minor}.${patch}`, major, minor, patch };
}

function codeFrom(parsed) {
  return parsed.major * 10000 + parsed.minor * 100 + parsed.patch;
}

/**
 * @param {string} input
 * @returns {number}
 */
export function computeVersionCode(input) {
  return codeFrom(parseVersion(input));
}

function readPackageJsonText() {
  try {
    return fs.readFileSync(packageJsonPath, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${packageJsonPath}：${err.message}`);
  }
}

function readDeclaredVersion() {
  const text = readPackageJsonText();
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (err) {
    throw new Error(`package.json 不是合法 JSON：${err.message}`);
  }
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error(`package.json 里没有 version 字段：${packageJsonPath}`);
  }
  return pkg.version;
}

/** @returns {string} 规范化后的当前版本，例如 `0.9.10` */
export function getVersion() {
  return parseVersion(readDeclaredVersion()).version;
}

/**
 * @param {string} [version] 不传就读 package.json
 * @returns {{ version: string, versionCode: number }}
 */
export function getVersionInfo(version) {
  const parsed = parseVersion(version ? version : readDeclaredVersion());
  return { version: parsed.version, versionCode: codeFrom(parsed) };
}

/**
 * 把 `package-lock.json` 里的根版本改成 `version`：只动顶层的 `version` 与
 * `packages[""].version` 两处，依赖的版本号和 integrity 一律不碰。
 *
 * 为什么是文本替换而不是 `JSON.parse` 后整份重写：npm 自己的格式（缩进、键顺序）
 * 不该因为改一个版本号就整体重排，否则每次发版的 diff 都是几千行。
 * 改完再 `JSON.parse` 一次核对：写的必须还是合法 JSON，且两处都真的是新值。
 *
 * @param {string} lockText
 * @param {string} version
 * @returns {string} 新的 lockfile 文本
 */
export function rewriteLockVersion(lockText, version) {
  const next = parseVersion(version).version;
  const text = String(lockText);

  let nextText = text.replace(/^( {2}"version"\s*:\s*")[^"]*(")/m, `$1${next}$2`);

  // packages[""] 是根包的镜像；node_modules 里的条目缩进相同，所以先框住根块再改，
  // 不全局替换（否则会把某个依赖自己的 version 改成本项目的版本）。
  let rootPatched = false;
  nextText = nextText.replace(/(\n {4}"":\s*\{\n)([\s\S]*?)(\n {4}\})/, (whole, head, body, tail) => {
    let done = 0;
    const patched = body.replace(/("version"\s*:\s*")[^"]*(")/, (match, before, after) => {
      done += 1;
      return `${before}${next}${after}`;
    });
    rootPatched = done === 1;
    return `${head}${patched}${tail}`;
  });
  if (!rootPatched) {
    throw new Error('package-lock.json 里找不到 packages[""].version（没写入任何文件）');
  }

  let parsed;
  try {
    parsed = JSON.parse(nextText);
  } catch (err) {
    throw new Error(`改 lockfile 之后不是合法 JSON 了（没写入）：${err.message}`);
  }
  const rootMirror = parsed.packages && parsed.packages[''] ? parsed.packages[''].version : undefined;
  if (parsed.version !== next || rootMirror !== next) {
    throw new Error(
      `package-lock.json 改写后根版本还是 ${JSON.stringify(parsed.version)} / ${JSON.stringify(rootMirror)}，不是 ${next}（没写入）`,
    );
  }
  return nextText;
}

/**
 * 改版本：写 `package.json` 的 version，再镜像到 `android/AndroidManifest.xml` 与 `package-lock.json`。
 *
 * 先把三份文件都读出来、把要替换的地方全找齐，再动笔——找不到 versionCode / versionName /
 * 根版本就整件事失败，不写半份。三份文件之间不是事务：中途崩了会留下不一致，重跑一次即可修好。
 *
 * @param {string} version
 * @returns {{ version: string, versionCode: number, changed: string[] }}
 */
export function setVersion(version) {
  const info = getVersionInfo(version);
  const { version: nextVersion, versionCode: nextCode } = info;

  // ---- 1. package.json：只替换顶层那一行 version，文件其余字节原样保留 ----
  const pkgText = readPackageJsonText();
  const pkgPattern = /^(\s*"version"\s*:\s*")[^"]*(")/m;
  if (!pkgPattern.test(pkgText)) {
    throw new Error(`package.json 里找不到顶层的 "version" 行：${packageJsonPath}`);
  }
  const nextPkgText = pkgText.replace(pkgPattern, `$1${nextVersion}$2`);
  // 改完再解析一次：写回去的东西必须还是合法 JSON，且 version 确实是新值。
  let nextPkg;
  try {
    nextPkg = JSON.parse(nextPkgText);
  } catch (err) {
    throw new Error(`改 version 之后 package.json 不是合法 JSON 了（没写入）：${err.message}`);
  }
  if (nextPkg.version !== nextVersion) {
    throw new Error(`package.json 改写后 version 是 ${JSON.stringify(nextPkg.version)}，不是 ${nextVersion}（没写入）`);
  }

  // ---- 2. AndroidManifest.xml：versionName / versionCode 两个属性 ----
  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${manifestPath}：${err.message}`);
  }
  if (!/android:versionCode="\d+"/.test(manifestText)) {
    throw new Error(`${manifestPath} 里没有 android:versionCode="N"（没写入任何文件）`);
  }
  if (!/android:versionName="[^"]*"/.test(manifestText)) {
    throw new Error(`${manifestPath} 里没有 android:versionName="..."（没写入任何文件）`);
  }
  const nextManifestText = manifestText
    .replace(/android:versionCode="\d+"/, `android:versionCode="${nextCode}"`)
    .replace(/android:versionName="[^"]*"/, `android:versionName="${nextVersion}"`);

  // ---- 3. package-lock.json：只跟根版本，依赖版本不动 ----
  let lockText;
  try {
    lockText = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${lockPath}：${err.message}`);
  }
  const nextLockText = rewriteLockVersion(lockText, nextVersion);

  // ---- 4. 三份都备好了才写 ----
  const changed = [];
  if (nextPkgText !== pkgText) {
    fs.writeFileSync(packageJsonPath, nextPkgText, 'utf8');
    changed.push(packageJsonPath);
  }
  if (nextManifestText !== manifestText) {
    fs.writeFileSync(manifestPath, nextManifestText, 'utf8');
    changed.push(manifestPath);
  }
  if (nextLockText !== lockText) {
    fs.writeFileSync(lockPath, nextLockText, 'utf8');
    changed.push(lockPath);
  }

  return { version: nextVersion, versionCode: nextCode, changed };
}

function readManifestMirror() {
  try {
    const text = fs.readFileSync(manifestPath, 'utf8');
    const codeMatch = /android:versionCode="(\d+)"/.exec(text);
    const nameMatch = /android:versionName="([^"]*)"/.exec(text);
    return {
      version: nameMatch ? nameMatch[1] : null,
      versionCode: codeMatch ? Number(codeMatch[1]) : null,
    };
  } catch {
    return null;
  }
}

/** lockfile 的根版本（两处：顶层与 packages[""]）；读不到就是 null。 */
function readLockMirror() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      root: parsed.packages && parsed.packages[''] ? parsed.packages[''].version ?? null : null,
    };
  } catch {
    return null;
  }
}

const USAGE = `版本单一来源：package.json 的 version

  node scripts/version.mjs                            打印当前版本、versionCode、镜像是否落后
  node scripts/version.mjs --json                     机器可读：{"version":"0.9.10","versionCode":910}
  node scripts/version.mjs --json --version 0.9.11    只算另一个版本的 versionCode，不读文件
  node scripts/version.mjs set 0.9.11                 改版本：package.json + AndroidManifest.xml + lockfile
  npm run version:set -- 0.9.11                       同上

versionCode = major * 10000 + minor * 100 + patch（minor / patch 必须 ≤ 99）。
不碰 web/download/latest.json——那是已发布的线上基线，由 scripts/release.ps1 写。`;

function printReadable(info) {
  const mirror = readManifestMirror();
  const lines = [
    `版本         ${info.version}`,
    `versionCode  ${info.versionCode}`,
    `来源         ${path.relative(repoRoot, packageJsonPath)}`,
  ];
  if (!mirror) {
    lines.push(`镜像         找不到 ${path.relative(repoRoot, manifestPath)}`);
  } else {
    const same = mirror.version === info.version && mirror.versionCode === info.versionCode;
    const mirrorLabel = `${path.relative(repoRoot, manifestPath)} versionName=${mirror.version} versionCode=${mirror.versionCode}`;
    lines.push(
      same
        ? `镜像         ${mirrorLabel}（一致）`
        : `镜像         ${mirrorLabel}（落后，跑 npm run version:set -- ${info.version} 同步）`,
    );
  }
  const lock = readLockMirror();
  if (!lock) {
    lines.push(`镜像         找不到或读不动 ${path.relative(repoRoot, lockPath)}`);
  } else {
    // 两处必须都是有值的同一个版本号：只改了一处也是漂。
    const same = lock.version === info.version && lock.root === info.version;
    lines.push(
      same
        ? `镜像         ${path.relative(repoRoot, lockPath)} 根版本 ${lock.version}（一致）`
        : `镜像         ${path.relative(repoRoot, lockPath)} 顶层 ${lock.version} / packages[""] ${lock.root}（落后，跑 npm run version:set -- ${info.version} 同步）`,
    );
  }
  console.log(lines.join('\n'));
}

/**
 * @param {string[]} argv 不含 node 与脚本路径
 * @returns {number} 进程退出码
 */
export function main(argv) {
  const args = [...argv];
  let versionOverride = null;
  const versionFlagIndex = args.indexOf('--version');
  if (versionFlagIndex !== -1) {
    versionOverride = args[versionFlagIndex + 1];
    if (versionOverride === undefined) throw new Error('--version 后面要跟版本号');
    args.splice(versionFlagIndex, 2);
  }
  const json = args.includes('--json');
  if (args.includes('-h') || args.includes('--help') || args.includes('help')) {
    console.log(USAGE);
    return 0;
  }

  const positional = args.filter((arg) => !arg.startsWith('-'));
  const command = positional[0] ?? '';

  if (command === 'set') {
    const target = positional[1] ?? versionOverride;
    if (!target) throw new Error('set 需要版本号：node scripts/version.mjs set 0.9.11');
    const result = setVersion(target);
    if (json) {
      console.log(JSON.stringify(result));
      return 0;
    }
    console.log(`版本改为 ${result.version}（versionCode ${result.versionCode}）`);
    if (result.changed.length === 0) {
      console.log('  三份文件本来就是这个版本，没有改动。');
    } else {
      for (const file of result.changed) console.log(`  已写 ${path.relative(repoRoot, file)}`);
    }
    console.log('  提醒：android/dist 里已有的包不会变；下次打包才会用新版本号。');
    return 0;
  }

  if (command !== '') {
    throw new Error(`不认识的子命令：${command}\n\n${USAGE}`);
  }

  const info = getVersionInfo(versionOverride ?? undefined);
  if (json) {
    console.log(JSON.stringify(info));
    return 0;
  }
  printReadable(info);
  return 0;
}

// 只有直接跑这个文件时才执行 CLI；被 import 时只暴露上面的函数。
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(entry) === normalize(selfPath);
}

if (isDirectRun()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`错误：${err.message}`);
    process.exitCode = 1;
  }
}
