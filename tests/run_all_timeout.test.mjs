import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hana-runner-timeout-'));
const testsDir = path.join(tempRoot, 'tests');
const scriptsDir = path.join(tempRoot, 'scripts');
const runnerPath = path.join(scriptsDir, 'run-all-tests.mjs');
const parentPidPath = path.join(tempRoot, 'parent.pid');
const grandchildPidPath = path.join(tempRoot, 'grandchild.pid');
const grandchildBeatPath = path.join(tempRoot, 'grandchild.beat');
const outsidePidPath = path.join(tempRoot, 'outside.pid');
const outsideBeatPath = path.join(tempRoot, 'outside.beat');
const afterPath = path.join(tempRoot, 'after.marker');
const slowPath = path.join(tempRoot, 'slow.marker');
const rssPidPath = path.join(tempRoot, 'rss-grandchild.pid');
const rssBeatPath = path.join(tempRoot, 'rss-grandchild.beat');
const earlyExitParentPidPath = path.join(tempRoot, 'early-exit-parent.pid');
const earlyExitGrandchildPidPath = path.join(tempRoot, 'early-exit-grandchild.pid');
const earlyExitBeatPath = path.join(tempRoot, 'early-exit-grandchild.beat');
const earlyExitAfterPath = path.join(tempRoot, 'early-exit-after.marker');
const taskkillFailDir = path.join(tempRoot, 'no-taskkill');
const hungName = '01_timeoutfixture_hang.test.mjs';
const hungPath = path.join(testsDir, hungName);
const fixtureFiles = [
  hungPath,
  path.join(testsDir, '02_timeoutfixture_after.test.mjs'),
  path.join(testsDir, '03_timeoutfixture_slow.slow.test.mjs'),
  path.join(testsDir, '04_rss.test.mjs'),
  path.join(testsDir, '05_parentexit.test.mjs'),
  path.join(testsDir, '06_parentexit_after.test.mjs'),
];
const inheritedOsKeys = [
  'PATH', 'JAVA_HOME', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
];
const fixtureEnv = Object.fromEntries(
  inheritedOsKeys
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]),
);
let outsideProcess = null;

function readPid(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 清理失败不改变测试结论。
  }
}

function killFixtureProcesses() {
  for (const file of [
    parentPidPath, grandchildPidPath, rssPidPath,
    earlyExitParentPidPath, earlyExitGrandchildPidPath,
  ]) killPid(readPid(file));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pid && processExists(pid) && Date.now() < deadline) await sleep(25);
  return !pid || !processExists(pid);
}

function waitForChildClose(child, timeoutMs = 5000) {
  if (!child || child.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await sleep(20);
  }
  assert.fail(`fixture did not create ${path.basename(file)}`);
}

function runRunnerAndWaitClose(args, { env = fixtureEnv, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerPath, ...args], {
      cwd: tempRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        error: spawnError || (timedOut ? { code: 'ETIMEDOUT' } : undefined),
        status: timedOut ? null : code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function removeKnownFiles() {
  for (const file of [
    runnerPath,
    ...fixtureFiles,
    parentPidPath,
    grandchildPidPath,
    grandchildBeatPath,
    outsidePidPath,
    outsideBeatPath,
    afterPath,
    slowPath,
    rssPidPath,
    rssBeatPath,
    earlyExitParentPidPath,
    earlyExitGrandchildPidPath,
    earlyExitBeatPath,
    earlyExitAfterPath,
  ]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of [testsDir, scriptsDir, taskkillFailDir, tempRoot]) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

try {
  mkdirSync(testsDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(
    runnerPath,
    readFileSync(path.join(repoRoot, 'scripts', 'run-all-tests.mjs'), 'utf8'),
  );

  const grandchildSource = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
    'let beat = 0;',
    `setInterval(() => writeFileSync(${JSON.stringify(grandchildBeatPath)}, String(++beat)), 50);`,
  ].join('\n');
  const grandchildSpawnOptions = process.platform === 'win32'
    ? "{ stdio: 'inherit', detached: true }"
    : "{ stdio: 'inherit' }";
  writeFileSync(
    hungPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], ${grandchildSpawnOptions});`,
      'while (true) {}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    fixtureFiles[1],
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(afterPath)}, 'ran');\n`,
  );
  writeFileSync(
    fixtureFiles[2],
    `// @slow 假测试：默认跳过；用 node scripts/run-all-tests.mjs --slow 执行\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(slowPath)}, 'ran');\n`,
  );

  const outsideSource = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(outsidePidPath)}, String(process.pid));`,
    'let beat = 0;',
    `setInterval(() => writeFileSync(${JSON.stringify(outsideBeatPath)}, String(++beat)), 50);`,
  ].join('\n');
  outsideProcess = spawn(process.execPath, ['-e', outsideSource], {
    cwd: tempRoot,
    env: fixtureEnv,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForFile(outsidePidPath);

  writeFileSync(
    fixtureFiles[4],
    [
      "import { spawn } from 'node:child_process';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      `const grandchildSource = ${JSON.stringify([
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(earlyExitGrandchildPidPath)}, String(process.pid));`,
        'let beat = 0;',
        `setInterval(() => writeFileSync(${JSON.stringify(earlyExitBeatPath)}, String(++beat)), 50);`,
      ].join('\n'))};`,
      `const child = spawn(process.execPath, ['-e', grandchildSource], ${grandchildSpawnOptions});`,
      'child.unref();',
      `const deadline = Date.now() + 2000; while (!existsSync(${JSON.stringify(earlyExitGrandchildPidPath)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));`,
      `if (!existsSync(${JSON.stringify(earlyExitGrandchildPidPath)})) process.exit(3);`,
      `writeFileSync(${JSON.stringify(earlyExitParentPidPath)}, String(process.pid));`,
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    fixtureFiles[5],
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(earlyExitAfterPath)}, 'ran');\n`,
  );

  const timedRun = spawnSync(process.execPath, [runnerPath, '--timeout', '1', '--filter', 'timeoutfixture'], {
    cwd: tempRoot,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 6000,
  });
  const timedOutput = `${timedRun.stdout || ''}\n${timedRun.stderr || ''}`;
  if (timedRun.error?.code === 'ETIMEDOUT') killFixtureProcesses();

  assert.equal(timedRun.error, undefined, '超时杀掉父进程时也必须关闭继承 stdout 的孙进程，不能挂住 runner');
  assert.equal(timedRun.status, 1, timedOutput);
  const hungPid = readPid(parentPidPath);
  const grandchildPid = readPid(grandchildPidPath);
  assert.ok(hungPid, '假测试必须先记录自己的 PID');
  assert.ok(grandchildPid, '假测试必须启动并记录持有 stdout 的孙进程');
  assert.equal(processExists(hungPid), false, '超时后挂起的直接测试进程必须退出');
  assert.equal(processExists(grandchildPid), false, '超时后 runner 自有的孙进程必须退出');
  assert.ok(timedOutput.includes('TIMEOUT'), timedOutput);
  assert.ok(timedOutput.includes(hungPath), `TIMEOUT 必须点名文件路径：${timedOutput}`);
  assert.match(timedOutput, /超时\s+1/, `汇总必须统计超时文件：${timedOutput}`);
  assert.match(timedOutput, /慢测试跳过\s+1/, timedOutput);
  assert.equal(readFileSync(afterPath, 'utf8'), 'ran', '超时后必须继续跑后续文件');
  assert.equal(existsSync(slowPath), false, '默认必须跳过 .slow.test.mjs');
  assert.ok(processExists(outsideProcess.pid), 'runner 不得杀掉由测试 harness 独立启动的同名进程');

  const onlySlowRun = spawnSync(process.execPath, [runnerPath, '--filter', 'slow'], {
    cwd: tempRoot,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(onlySlowRun.status, 1, `${onlySlowRun.stdout || ''}\n${onlySlowRun.stderr || ''}`);
  assert.match(onlySlowRun.stdout, /跳过\s+1\s+个慢测试/);

  const slowRun = spawnSync(process.execPath, [runnerPath, '--slow', '--filter', 'timeoutfixture_slow'], {
    cwd: tempRoot,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(slowRun.error, undefined, `${slowRun.stdout || ''}\n${slowRun.stderr || ''}`);
  assert.equal(slowRun.status, 0, `${slowRun.stdout || ''}\n${slowRun.stderr || ''}`);
  assert.equal(readFileSync(slowPath, 'utf8'), 'ran', '--slow 必须执行慢测试');
  assert.match(slowRun.stdout, /慢测试跳过\s+0/);

  mkdirSync(taskkillFailDir);
  const parentExitEnv = process.platform === 'win32'
    ? { ...fixtureEnv, PATH: taskkillFailDir }
    : fixtureEnv;
  const parentExitRun = await runRunnerAndWaitClose(
    ['--timeout', '1', '--filter', 'parentexit'],
    { env: parentExitEnv, timeoutMs: 5000 },
  );
  const parentExitOutput = `${parentExitRun.stdout || ''}\n${parentExitRun.stderr || ''}`;
  if (parentExitRun.error?.code === 'ETIMEDOUT') {
    killPid(readPid(earlyExitGrandchildPidPath));
  }
  assert.equal(parentExitRun.error, undefined, '父测试先退出、后代持有管道时 runner 必须在有限时间内close');
  assert.equal(parentExitRun.status, 1, parentExitOutput);
  assert.match(parentExitOutput, /TIMEOUT/, parentExitOutput);
  const earlyExitParentPid = readPid(earlyExitParentPidPath);
  const earlyExitGrandchildPid = readPid(earlyExitGrandchildPidPath);
  assert.ok(earlyExitParentPid, '父测试必须记录自己的 PID');
  assert.ok(earlyExitGrandchildPid, '父测试必须记录自己启动的后代 PID');
  assert.equal(processExists(earlyExitParentPid), false, '直接测试父进程必须先于超时退出');
  assert.equal(readFileSync(earlyExitAfterPath, 'utf8'), 'ran', '不完整清理仍须结算并继续后续文件');
  assert.ok(processExists(outsideProcess.pid), '父进程先退出的清理也不得误杀外部哨兵');
  if (process.platform === 'win32') {
    assert.match(parentExitOutput, /CLEANUP/, parentExitOutput);
    assert.match(parentExitOutput, /后代是否退出未确认/, parentExitOutput);
    assert.ok(processExists(earlyExitGrandchildPid), 'CLEANUP 不完整时测试应观察到仍存活的指定后代');
    assert.doesNotMatch(parentExitOutput, /^ok\s+05_parentexit\.test\.mjs/m, '不完整清理不能报成 PASS');
  } else {
    assert.doesNotMatch(parentExitOutput, /CLEANUP/, parentExitOutput);
    assert.equal(processExists(earlyExitGrandchildPid), false, 'POSIX 进程组应清理同组后代');
  }

  if (process.platform === 'win32') {
    const rssSource = [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(rssPidPath)}, String(process.pid));`,
      'let beat = 0;',
      `setInterval(() => writeFileSync(${JSON.stringify(rssBeatPath)}, String(++beat)), 50);`,
    ].join('\n');
    writeFileSync(
      fixtureFiles[3],
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        'const memory = Buffer.alloc(128 * 1024 * 1024, 1);',
        `writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));`,
        `spawn(process.execPath, ['-e', ${JSON.stringify(rssSource)}], { stdio: 'inherit', detached: true });`,
        'if (memory.length === 0) process.exit(3);',
        'while (true) {}',
        '',
      ].join('\n'),
    );
    const rssRun = spawnSync(process.execPath, [runnerPath, '--timeout', '15', '--max-rss', '80', '--filter', '04_rss'], {
      cwd: tempRoot,
      env: fixtureEnv,
      encoding: 'utf8',
      timeout: 12_000,
    });
    const rssOutput = `${rssRun.stdout || ''}\n${rssRun.stderr || ''}`;
    if (rssRun.error?.code === 'ETIMEDOUT') killFixtureProcesses();
    assert.equal(rssRun.error, undefined, `RSS 超限必须终止自有进程树，不能留下继承管道：${rssOutput}`);
    assert.equal(rssRun.status, 1, rssOutput);
    assert.match(rssOutput, /RUNAWAY/, rssOutput);
    assert.equal(processExists(readPid(parentPidPath)), false, 'RSS 超限后直接测试进程必须退出');
    assert.equal(processExists(readPid(rssPidPath)), false, 'RSS 超限后 runner 自有孙进程必须退出');
  }

  console.log('PASS  超时/RSS 清理自有进程树、runner 不误杀外部进程、继续执行后续文件，并按 --slow 选择慢测试');
} finally {
  const fixturePids = [
    parentPidPath, grandchildPidPath, rssPidPath,
    earlyExitParentPidPath, earlyExitGrandchildPidPath,
  ].map(readPid).filter(Boolean);
  killFixtureProcesses();
  const fixtureStopped = await Promise.all(fixturePids.map((pid) => waitForPidExit(pid)));
  assert.ok(fixtureStopped.every(Boolean), '测试夹具只按记录的后代 PID 收尾，并等待这些 PID 退出');
  if (outsideProcess) {
    killPid(outsideProcess.pid);
    assert.ok(await waitForChildClose(outsideProcess), '测试哨兵必须等待自身 close 后再清理临时目录');
  }
  removeKnownFiles();
}
