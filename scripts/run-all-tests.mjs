#!/usr/bin/env node
/*
 * scripts/run-all-tests.mjs — 全量测试跑一遍，按文件给结论
 *
 * 为什么不用一行 PowerShell 循环：
 *   之后有人写了个测试用例，断言全过但没有调用 process.exit()，
 *   又恰好留了个定时器或 socket，那个进程就永远不退。
 *   在外面等的人分不清「还在跑」和「已经卡死」。
 *   所以每个文件都单独起进程，并给一个硬超时；超时算失败。
 *
 * 用法：node scripts/run-all-tests.mjs [--timeout 60] [--filter 关键字] [--shard 1/4] [--slow] [--list]
 *                     [--mem 512] [--max-rss 1024]
 *
 * --shard 给 CI 用：把文件切成 n 片，只跑第 k 片。按文件名排序后取下标取模，
 * 保证同一份代码每次分片结果一致，不会出现“这次没跑到”的文件。
 *
 * --mem：每个子进程的 V8 堆上限（MB，默认 512）。测试要的内存超过这个数就是测试
 *   自己有 bug，让它当场 OOM 报错，而不是把整机内存吃光（实测有过一个进程峰值 10.9GB，
 *   把系统可用内存压到 0.7GB，连带把宿主拖崩）。
 * --max-rss：直接测试进程的 RSS（MB，默认 1024）超过就杀掉并记 RUNAWAY；0 关闭该限制。
 *   仅 Windows 用 tasklist 采样直接 PID，非 Windows 不采样。这不是进程树硬上限。
 *   超时或 RSS 超限只终止本 runner 启动的进程树，不按名称或端口搜索进程。
 */

import { spawn, spawnSync, execFile } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const testsDir = join(root, 'tests');
// Tree-kill tooling and inherited-pipe drain must not make the runner wait without a bound.
const PROCESS_COMMAND_TIMEOUT_MS = 1000;
const CLEANUP_GRACE_MS = 1500;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} 必须提供参数值`);
  }
  return value;
}

function parseFiniteNumber(name, raw, valid) {
  if (String(raw).trim() === '') throw new Error(`--${name} 参数不合法`);
  const value = Number(raw);
  if (!Number.isFinite(value) || !valid(value)) {
    throw new Error(`--${name} 参数不合法`);
  }
  return value;
}

function parseShard(raw) {
  if (raw === null) return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (!match) throw new Error('--shard 要写成 k/n，例如 1/4');
  const k = Number(match[1]);
  const n = Number(match[2]);
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 1 || n < 1 || k > n) {
    throw new Error('--shard 参数不合法');
  }
  return { k, n };
}

let timeoutSec;
let filter;
let shard;
let includeSlow;
let heapMb;
let maxRssMb;
let shardSpec;
try {
  timeoutSec = parseFiniteNumber('timeout', arg('timeout', 60), (value) => (
    value > 0 && value * 1000 <= 2_147_483_647
  ));
  filter = arg('filter', '');
  shard = arg('shard', null);
  includeSlow = process.argv.includes('--slow');
  heapMb = parseFiniteNumber('mem', arg('mem', 512), (value) => (
    Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
  ));
  maxRssMb = parseFiniteNumber('max-rss', arg('max-rss', 1024), (value) => (
    value >= 0 && value <= Number.MAX_SAFE_INTEGER
  ));
  shardSpec = parseShard(shard);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

let candidates = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !filter || name.includes(filter))
  .sort();

const skippedSlow = includeSlow ? 0 : candidates.filter((name) => name.endsWith('.slow.test.mjs')).length;
if (!includeSlow) candidates = candidates.filter((name) => !name.endsWith('.slow.test.mjs'));

let files = candidates;
if (shardSpec) {
  files = files.filter((_, index) => index % shardSpec.n === shardSpec.k - 1);
}

if (process.argv.includes('--list')) {
  for (const file of files) console.log(file);
  console.log(`共 ${files.length} 个${shardSpec ? `（分片 ${shardSpec.k}/${shardSpec.n}）` : ''}；跳过 ${skippedSlow} 个慢测试`);
  process.exit(0);
}

/*
 * 跑测试前先把前端产物建一次：有几条浏览器夹具会加载 /dist/app.css 与 dist/app.js，
 * 它们在干净检出的 CI 上是没有 dist 的。构建只要几十毫秒，失败就让本轮直接红——
 * 否则那几条测试会以「找不到样式表」的形式报错，看不出根因。
 *
 * 构建脚本不存在时跳过：runner 自己的契约测试会在临时目录里造一个假仓库跑它，
 * 那里面只有 tests/ 和 scripts/run-all-tests.mjs，没有前端构建。
 */
{
  const buildScript = join(root, 'scripts', 'build-web.mjs');
  if (existsSync(buildScript)) {
    const built = spawnSync(process.execPath, [buildScript, '--silent'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
    });
    if (built.status !== 0) {
      console.error('[runner] 前端产物构建失败，先修它再跑测试：');
      console.error((built.stderr || built.stdout || '').slice(0, 800));
      process.exit(2);
    }
  }
}

if (files.length === 0) {
  console.log(`没有匹配的测试文件；跳过 ${skippedSlow} 个慢测试`);
  process.exit(1);
}

// 只给测试进程提供运行时所需的系统路径和少数明确测试开关。凭据、HANA_HOME、
// NODE_OPTIONS 及其它未列出的环境变量一律不向用例传递。
const TEST_ENV_KEYS = [
  'PATH', 'JAVA_HOME', 'ANDROID_HOME', 'CHROME_PATH', 'HANA_SKIP_BROWSER_TESTS',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
];
const inheritedEnvKeys = Object.keys(process.env);
const testEnv = {};
for (const key of TEST_ENV_KEYS) {
  const actualKey = inheritedEnvKeys.find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  if (actualKey !== undefined && typeof process.env[actualKey] === 'string') {
    testEnv[key] = process.env[actualKey];
  }
}
testEnv.HANA_GATEWAY_LOG = 'off';

/** 采样一个直接测试进程的 RSS（MB）；拿不到就返回 0。只用 Windows 的 tasklist。 */
function rssMbOf(pid) {
  return new Promise((done) => {
    if (process.platform !== 'win32' || !pid) return done(0);
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      env: testEnv,
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }, (err, stdout) => {
      if (err || !stdout) return done(0);
      // "node.exe","14040","Console","1","1,196 K" —— 最后一列是内存，千分位加 K 后缀
      const match = /"([0-9.,]+\s*K)"/.exec(stdout);
      if (!match) return done(0);
      const kb = Number(match[1].replace(/[,\s]*K$/i, '').replace(/,/g, ''));
      return done(Number.isFinite(kb) ? kb / 1024 : 0);
    });
  });
}

/** 只终止本次启动的测试进程树：PID 子树（Windows）或独立进程组（POSIX）。 */
function terminateProcessTree(child, onFailure) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      env: testEnv,
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }, (error) => {
      if (error) onFailure();
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') onFailure();
  }
}

/** 跑一个文件；正常退出等 close，超时清理失败时有界结算。 */
function runOne(file) {
  return new Promise((done) => {
    const full = join(testsDir, file);
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, full], {
      cwd: root,
      env: testEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killedForRss = false;
    let cleanupIncomplete = false;
    let peakRssMb = 0;
    let rssCheckRunning = false;
    let settled = false;
    let timeoutTimer = null;
    let cleanupTimer = null;
    let rssTimer = null;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    function finish(code) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (rssTimer) clearInterval(rssTimer);
      done({
        file,
        timedOut,
        killedForRss,
        cleanupIncomplete,
        peakRssMb: Math.round(peakRssMb),
        code,
        output: `${stdout}\n${stderr}`.trim()
      });
    }

    function terminate(reason) {
      if (settled || timedOut || killedForRss) return;
      if (reason === 'timeout') timedOut = true;
      else killedForRss = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (rssTimer) clearInterval(rssTimer);
      terminateProcessTree(child, () => {
        if (!settled) child.kill('SIGKILL');
      });
      cleanupTimer = setTimeout(() => {
        if (settled) return;
        cleanupIncomplete = true;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, CLEANUP_GRACE_MS);
    }

    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutSec * 1000);

    // 内存看门狗：只在 Windows 采样直接测试 PID，不是整棵进程树的硬上限。
    if (maxRssMb > 0 && process.platform === 'win32') {
      rssTimer = setInterval(async () => {
        if (settled || child.exitCode !== null || timedOut || killedForRss || rssCheckRunning) return;
        rssCheckRunning = true;
        try {
          const mb = await rssMbOf(child.pid);
          if (settled || timedOut || killedForRss) return;
          if (mb > peakRssMb) peakRssMb = mb;
          if (child.exitCode === null && mb > maxRssMb) terminate('rss');
        } finally {
          rssCheckRunning = false;
        }
      }, 1000);
      rssTimer.unref?.();
    }

    child.on('close', finish);
  });
}

const failures = [];
const slow = [];
const wholeFileSkips = [];
const partialSkips = [];
const started = Date.now();

for (let i = 0; i < files.length; i += 1) {
  const file = files[i];
  const at = Date.now();
  const result = await runOne(file);
  const cost = Date.now() - at;
  const cleanupReason = result.cleanupIncomplete
    ? '；runner已销毁自有stdout/stderr管道，后代是否退出未确认'
    : '';

  if (result.cleanupIncomplete) {
    console.log(`CLEANUP  ${file}  ${CLEANUP_GRACE_MS}ms内未收到close${cleanupReason}`);
  }
  if (result.killedForRss) {
    failures.push({ ...result, reason: `内存超限 ${maxRssMb}MB（峰值 ${result.peakRssMb}MB）${cleanupReason}` });
    console.log(`RUNAWAY  ${join(testsDir, file)}  峰值 ${result.peakRssMb}MB > ${maxRssMb}MB`);
    continue;
  }
  if (result.timedOut) {
    failures.push({ ...result, reason: `超时 ${timeoutSec}s${cleanupReason}` });
    console.log(`TIMEOUT  ${join(testsDir, file)}  (${timeoutSec}s)`);
    continue;
  }
  if (result.code !== 0 || result.cleanupIncomplete) {
    const reason = result.cleanupIncomplete
      ? `退出码 ${result.code}；清理不完整，后代是否退出未确认`
      : `退出码 ${result.code}`;
    failures.push({ ...result, reason });
    console.log(`FAIL     ${file}`);
    continue;
  }
  const skipLines = result.output.split('\n').filter((line) => /^\s*SKIP\s+/i.test(line));
  if (skipLines.length) {
    const ranAssertions = /(?:^|\n)\s*PASS\s+/m.test(result.output);
    if (ranAssertions) {
      partialSkips.push({ file, lines: skipLines });
      console.log(`PARTIAL  ${file}  部分跳过 ${skipLines.length} 项；这些场景未执行`);
    } else {
      wholeFileSkips.push({ file, lines: skipLines });
      console.log(`SKIP     ${file}  整文件跳过`);
    }
    for (const line of skipLines) console.log(`  ${line.trim()}`);
    continue;
  }
  if (cost > 20000) slow.push({ file, cost });
  console.log(`ok       ${file}  (${(cost / 1000).toFixed(1)}s)  [${i + 1}/${files.length}]`);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
const timeouts = failures.filter((failure) => failure.timedOut && !failure.killedForRss);
const runaways = failures.filter((failure) => failure.killedForRss);
const incompleteCleanups = failures.filter((failure) => failure.cleanupIncomplete);
console.log(
  `\n文件 ${files.length}  失败 ${failures.length}  超时 ${timeouts.length}  内存失控 ${runaways.length}  清理不完整 ${incompleteCleanups.length}`
  + `  慢测试跳过 ${skippedSlow}  整文件SKIP ${wholeFileSkips.length}  部分SKIP ${partialSkips.length}  用时 ${total}s`
);
if (timeouts.length) {
  console.log('超时文件：');
  for (const failure of timeouts) console.log(`  ${failure.file}`);
}
if (runaways.length) {
  console.log('内存失控文件：');
  for (const failure of runaways) console.log(`  ${failure.file}  峰值 ${failure.peakRssMb}MB`);
}
if (wholeFileSkips.length) {
  console.log('整文件跳过；没有执行文件内测试：');
  for (const item of wholeFileSkips) console.log(`  ${item.file}`);
}
if (partialSkips.length) {
  console.log('部分跳过；列出的场景未执行，相关覆盖未验证：');
  for (const item of partialSkips) console.log(`  ${item.file}  ${item.lines.length} 项`);
}
if (slow.length) {
  console.log('慢文件：');
  for (const item of slow) console.log(`  ${item.file}  ${(item.cost / 1000).toFixed(1)}s`);
}

for (const failure of failures) {
  console.log(`\n===== ${failure.file}  (${failure.reason}) =====`);
  const lines = failure.output.split('\n');
  console.log(lines.slice(-25).join('\n'));
}

process.exit(failures.length === 0 ? 0 : 1);
