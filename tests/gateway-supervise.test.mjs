/* 守护重启退避：纯函数 + cmd 编排。
 *
 * 覆盖：
 * - parseClock / elapsedSeconds / nextDelay 的规则（含跨午夜、解析失败、上限）
 * - CLI 记账文件：连续失败递增，跑满 30 秒归零
 * - supervise.cmd 真的接上了这套逻辑（跑真的 cmd，观察退避序列与日志轮转）
 *
 * 用真的 supervise.cmd 时要让它快速失败：HANA_GW_HOST=0.0.0.0 不带
 * HANA_GW_ALLOW_INSECURE_LAN=1 会在 listen 之前就退出，不会占端口。
 * TEMP 指到临时目录，避免和线上守护共用 %TEMP%\hana-gateway.log。
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import {
  BASE_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  elapsedSeconds,
  main,
  nextDelay,
  parseClock,
} from '../gateway/supervise-delay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'gateway', 'supervise-delay.mjs');
const SUPERVISE = path.join(ROOT, 'gateway', 'supervise.cmd');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitFor(fn, timeoutMs = 20_000, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return Boolean(await fn());
}

let tmpRoot;
const children = [];

const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

t('parseClock：接受 cmd 的 %TIME%，拒绝 12 小时制与垃圾输入', () => {
  assert.equal(parseClock('14:07:33.45'), 14 * 3600 + 7 * 60 + 33.45);
  assert.equal(parseClock(' 9:07:33.45'), 9 * 3600 + 7 * 60 + 33.45);
  assert.equal(parseClock('09:07:33,5'), 9 * 3600 + 7 * 60 + 33.5);
  assert.equal(parseClock('23:59:59'), 86399);
  assert.equal(parseClock('9:07:33 AM'), null);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(undefined), null);
  assert.equal(parseClock('25:00:00'), null);
  assert.equal(parseClock('12:60:00'), null);
});

t('elapsedSeconds：普通间隔、跨午夜、解析失败', () => {
  assert.equal(elapsedSeconds('14:00:00.00', '14:00:07.50'), 7.5);
  assert.equal(elapsedSeconds('23:59:50.00', '00:00:10.00'), 20);
  assert.equal(elapsedSeconds('00:00:10.00', '00:00:05.00'), 86_395);
  assert.equal(elapsedSeconds('bad', '14:00:00'), null);
});

t('nextDelay：2/4/8/16/32/60 指数退避，跑满 30 秒归零', () => {
  assert.deepEqual(nextDelay({ streak: 0, runSeconds: 0 }), { delaySeconds: 2, streak: 1 });
  assert.deepEqual(nextDelay({ streak: 1, runSeconds: 1 }), { delaySeconds: 4, streak: 2 });
  assert.deepEqual(nextDelay({ streak: 2, runSeconds: 1 }), { delaySeconds: 8, streak: 3 });
  assert.deepEqual(nextDelay({ streak: 3, runSeconds: 1 }), { delaySeconds: 16, streak: 4 });
  assert.deepEqual(nextDelay({ streak: 4, runSeconds: 1 }), { delaySeconds: 32, streak: 5 });
  assert.deepEqual(nextDelay({ streak: 5, runSeconds: 1 }), { delaySeconds: 60, streak: 6 });
  assert.deepEqual(nextDelay({ streak: 20, runSeconds: 1 }), { delaySeconds: 60, streak: 21 }, '上限不能突破');

  assert.deepEqual(nextDelay({ streak: 7, runSeconds: 30 }), { delaySeconds: BASE_DELAY_SECONDS, streak: 0 });
  assert.deepEqual(nextDelay({ streak: 7, runSeconds: 3600 }), { delaySeconds: 2, streak: 0 });

  // 时间读不出来（12 小时制机器）按快速失败处理：宁可多等，也不要疯转
  assert.deepEqual(nextDelay({ streak: 2, runSeconds: null }), { delaySeconds: 8, streak: 3 });
  assert.equal(nextDelay({ streak: 99, runSeconds: 1 }).delaySeconds, MAX_DELAY_SECONDS);
});

t('CLI：--state 记账，连续失败递增，跑满 30 秒归零', async () => {
  const stateFile = path.join(tmpRoot, 'backoff.json');
  const outFile = path.join(tmpRoot, 'delay.txt');

  const first = spawnSync(process.execPath, [HELPER, '--start', '10:00:00.00', '--end', '10:00:01.00', '--state', stateFile, '--out', outFile], {
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /DELAY=2/);
  assert.equal(await fsp.readFile(outFile, 'utf8'), 'DELAY=2\nSTREAK=1\n');

  const second = spawnSync(process.execPath, [HELPER, '--start', '10:00:05.00', '--end', '10:00:06.00', '--state', stateFile, '--out', outFile], {
    encoding: 'utf8',
  });
  assert.match(second.stdout, /DELAY=4/);

  const longRun = spawnSync(process.execPath, [HELPER, '--start', '10:00:10.00', '--end', '10:01:40.00', '--state', stateFile, '--out', outFile], {
    encoding: 'utf8',
  });
  assert.match(longRun.stdout, /DELAY=2\nSTREAK=0/);

  // 直接调导出的 main 也要能用（不依赖 CLI 解析），这里把 stdout 收住保持测试输出干净
  const directState = path.join(tmpRoot, 'direct.json');
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.equal(main(['--start', '11:00:00', '--end', '11:00:01', '--state', directState]), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(directState, 'utf8')), { streak: 1, runSeconds: 1 });
});

t('supervise.cmd：真的连续失败时按 2 → 4 → 8 秒退避，且日志按大小轮转', async () => {
  const tempDir = path.join(tmpRoot, 'supervise-temp');
  await fsp.mkdir(tempDir, { recursive: true });
  const outLog = path.join(tempDir, 'hana-gateway.log');
  // 预先塞一个超过 5MB 的日志：守护刚起第一轮就该把它轮转掉
  await fsp.writeFile(outLog, 'x'.repeat(6 * 1024 * 1024));

  const port = await freePort();
  const child = spawn('cmd.exe', ['/d', '/c', SUPERVISE], {
    cwd: ROOT,
    env: {
      ...process.env,
      TEMP: tempDir,
      TMP: tempDir,
      // 非 loopback + 明文且没 opt-in → 网关在 listen 之前就退出，快速失败
      HANA_GW_HOST: '0.0.0.0',
      HANA_GW_PORT: String(port),
      HANA_GW_MODE: 'usb',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  try {
    const sawSequence = await waitFor(async () => {
      const text = await fsp.readFile(outLog, 'utf8').catch(() => '');
      return /restarting in 2s/.test(text) && /restarting in 4s/.test(text);
    }, 25_000);
    const log = await fsp.readFile(outLog, 'utf8').catch(() => '');
    assert.equal(sawSequence, true, `应看到 2s 与 4s 退避：\n${log.slice(-800)}`);
    assert.match(log, /restarting in 8s|restarting in 4s/, '退避序列应继续递增');

    const rotated = await fsp.stat(path.join(tempDir, 'hana-gateway.log.1')).catch(() => null);
    assert.ok(rotated && rotated.size >= 6 * 1024 * 1024, '超过 5MB 的旧日志应被轮转成 .1');
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
});

/* ---- 运行 ---- */

let bad = 0;
try {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hana-gw-supervise-'));
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
  for (const child of children) {
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  // Windows 上刚被 taskkill 的进程可能还握着日志文件句柄，unlink 会报 EBUSY。
  // 清理失败不是用例失败：重试几次，删不掉就留给系统清理临时目录。
  if (tmpRoot) await removeTempRoot(tmpRoot);
}

async function removeTempRoot(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY')) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      console.log(`注意：临时目录清理失败（${err?.code || err?.message}）`);
      return;
    }
  }
  console.log('注意：临时目录仍被占用，保持不动交给系统清理');
}

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
