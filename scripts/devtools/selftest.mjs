#!/usr/bin/env node
// selftest —— ui-probe / js-eval 的离线自检：不需要真机、不需要网关、不需要 adb。
//
// 做法：起一个假的 WebView 调试端点（fake-cdp.mjs，真的 HTTP + 真 WebSocket 握手），
// 再塞一个假 adb（fake-adb.mjs，带一个真监听端口的转发代理），把两条命令从
// 「设备 → pid → 套接字 → 转发 → /json/list → WebSocket → Runtime.evaluate → 坐标换算 → input tap」
// 整条链路跑一遍，然后断言输出和退出码。
//
// 跑：node scripts/devtools/selftest.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeCdp, DEFAULT_ITEMS, DEFAULT_VIEWPORT } from './fake-cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FAKE_ADB = path.join(HERE, 'fake-adb.mjs');
const SERIAL = 'FAKE0000';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'hana-devtools-selftest-'));

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    process.stdout.write(`  ✗ ${name}\n     ${String(err && err.message ? err.message : err).split('\n').join('\n     ')}\n`);
  }
}

function runTool(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        // 把宿主环境里的设备选择清掉，自检只认自己给的那台
        HANA_ANDROID_SERIAL: '',
        ANDROID_SERIAL: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let logSeq = 0;
function newAdbLog() {
  logSeq += 1;
  return path.join(TMP, `adb-${logSeq}.log`);
}

/**
 * 设备模式跑一次：假 adb 说设备在、应用在、套接字在；假 CDP 当页面。
 * 返回 { code, stdout, stderr, adbLog }。
 */
async function runDeviceMode(script, args, { bounds = '0,0,1080,2400', env = {}, items = null } = {}) {
  const upstream = await freePort();   // 假 CDP 端点
  const local = await freePort();      // 给 adb forward 的本地端口
  const log = newAdbLog();
  const fake = await startFakeCdp(items ? { port: upstream, items } : { port: upstream });
  try {
    const res = await runTool(script, ['--port', String(local), '--device', SERIAL, ...args], {
      HANA_ADB_BIN: FAKE_ADB,
      FAKE_ADB_LOG: log,
      FAKE_ADB_BOUNDS: bounds,
      FAKE_ADB_UPSTREAM_PORT: String(upstream),
      ...env,
    });
    return { ...res, adbLog: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  } finally {
    await fake.close();
  }
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`输出里没有 JSON：${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

/** 假 adb 的日志去掉 `-s <serial>` 前缀，方便逐条比对真实命令。 */
function adbLines(log) {
  return String(log)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^-s\s+\S+\s+/, ''));
}

process.stdout.write('离线自检（假 CDP 端点 + 假 adb，不需要真机）\n\n');

await check('ui-probe --help 可用且写明未在真机验证', async () => {
  const res = await runTool('ui-probe.mjs', ['--help']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.match(res.stdout, /--tap/);
  assert.match(res.stdout, /未在真机验证/);
});

await check('js-eval --help 可用', async () => {
  const res = await runTool('js-eval.mjs', ['--help']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.match(res.stdout, /--expect/);
});

await check('设备模式列出元素：pid / 套接字 / uiautomator 矩形 / 坐标换算', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--json']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  const data = parseJson(res.stdout);
  assert.equal(data.device, SERIAL);
  assert.equal(data.pid, 4242);
  assert.equal(data.socket, 'webview_devtools_remote_4242');
  assert.deepEqual(
    { left: data.frame.left, top: data.frame.top, width: data.frame.width, height: data.frame.height },
    { left: 0, top: 0, width: 1080, height: 2400 },
  );
  assert.equal(data.mapping.estimated, false);
  assert.equal(data.mapping.scaleX, 3);
  assert.equal(data.mapping.scaleY, 3);
  const casual = data.items.find((it) => it.id === 'btnCasual');
  assert.ok(casual, '列表里应该有 btnCasual');
  assert.deepEqual(casual.tap, { x: 540, y: 624 });   // CSS 中心 (180,208) × 3
  assert.equal(casual.status, '✓');
  // 隐藏元素默认不出现
  assert.equal(data.items.some((it) => it.id === 'hiddenPanel'), false);
  // adb 侧：dump 写到本次唯一的远端文件，只读/删这一份；forward 最后真的拆了
  const lines = adbLines(res.adbLog);
  const dumps = lines.filter((line) => line.startsWith('shell uiautomator dump '));
  assert.equal(dumps.length, 1, `应只 dump 一次：${lines.join(' | ')}`);
  const dumpPath = dumps[0].slice('shell uiautomator dump '.length).trim();
  assert.match(dumpPath, /^\/sdcard\/hana-ui-probe-[A-Za-z0-9._-]+\.xml$/, `dump 应写到本次唯一文件：${dumpPath}`);
  assert.notEqual(dumpPath, '/sdcard/hana-ui-probe.xml', '不得复用固定的旧文件名');
  assert.equal(lines.filter((line) => line === `shell cat ${dumpPath}`).length, 1, `只读自己那份：${lines.join(' | ')}`);
  assert.equal(lines.filter((line) => line === `shell rm -f ${dumpPath}`).length, 1, `只删自己那份：${lines.join(' | ')}`);
  assert.equal(lines.some((line) => line.includes('window_dump.xml')), false, '不得读写删默认 window_dump.xml');
  assert.equal(lines.some((line) => line === 'shell uiautomator dump'), false, '不得退回不带路径的 dump');
  assert.match(res.adbLog, /forward tcp:\d+ localabstract:webview_devtools_remote_4242/);
  assert.match(res.adbLog, /forward --remove tcp:\d+/);
});

await check('--tap 真的发出 input tap（无状态栏：540,624）', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#btnCasual']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.match(res.stdout, /input tap 540 624/);
  assert.match(res.stdout, /已点击/);
  assert.match(res.adbLog, /shell input tap 540 624/);
});

await check('--tap 补状态栏偏移（WebView 矩形 [0,63][1080,2265] → 540,636）', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#btnCasual'], { bounds: '0,63,1080,2265' });
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  // 缩放 x = 1080/360 = 3，y = (2265-63)/800 = 2.7525；208 × 2.7525 + 63 = 635.52 → 636
  assert.match(res.stdout, /input tap 540 636/);
  assert.match(res.adbLog, /shell input tap 540 636/);
});

await check('--tap 找不到元素：中文报错 + 列候选', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#nope']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /没有匹配/);
  assert.match(res.stderr, /btnCasual/);
});

await check('--tap 元素不可见：直接说不可见，不去瞎点', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#hiddenPanel']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /不可见/);
});

await check('元素被遮挡：点之前先警告点到了谁', async () => {
  // 把 btnCasual 的「该点最上层元素」改成另一个 div
  const items = DEFAULT_ITEMS.map((it) => (it.id === 'btnCasual'
    ? { ...it, hitId: 'someOverlay', hitTag: 'div', hitMatch: false }
    : it));
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#btnCasual'], { items });
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.match(res.stderr, /警告：该点最上层是 div#someOverlay/);
  assert.match(res.stdout, /已点击/);
});

await check('js-eval 走设备模式（转发 → WebSocket）也能执行', async () => {
  const res = await runDeviceMode('js-eval.mjs', ['document.title']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.equal(res.stdout.trim(), 'ECHO: document.title');
});

await check('js-eval 在页面上下文执行并打印结果', async () => {
  const fake = await startFakeCdp();
  try {
    const res = await runTool('js-eval.mjs', ['1+1', '--cdp-url', fake.wsUrl]);
    assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
    assert.equal(res.stdout.trim(), 'ECHO: 1+1');
  } finally {
    await fake.close();
  }
});

await check('js-eval --expect 不符：退出码 1 + 断言失败', async () => {
  const fake = await startFakeCdp();
  try {
    const res = await runTool('js-eval.mjs', ['document.title', '--cdp-url', fake.wsUrl, '--expect', '不是这个']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /断言失败/);
  } finally {
    await fake.close();
  }
});

await check('js-eval 页面里抛错：中文报错，不出原始栈', async () => {
  const fake = await startFakeCdp();
  try {
    const res = await runTool('js-eval.mjs', ['throw-me', '--cdp-url', fake.wsUrl]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /页面内执行抛错/);
  } finally {
    await fake.close();
  }
});

await check('没有设备：中文说明并提示怎么办', async () => {
  const res = await runTool('ui-probe.mjs', ['--device', SERIAL], {
    HANA_ADB_BIN: FAKE_ADB,
    FAKE_ADB_NO_DEVICES: '1',
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /没有找到设备/);
});

await check('调试端口没开：说清楚是 WebView 调试没开', async () => {
  const res = await runTool('ui-probe.mjs', ['--device', SERIAL], {
    HANA_ADB_BIN: FAKE_ADB,
    FAKE_ADB_NO_SOCKET: '1',
  });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /WebView 调试没开/);
  assert.match(res.stderr, /-Debuggable/);
});

await check('转发端口后面没人：提示调试端口没开而不是「未知错误」', async () => {
  const dead = await freePort();
  const res = await runTool('ui-probe.mjs', ['--cdp-url', `ws://127.0.0.1:${dead}/devtools/page/X`]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /连不上调试 WebSocket/);
});

await check('target 只有 worker 没有 page：说清楚没有可调试页面', async () => {
  const fake = await startFakeCdp({ mode: 'no-page' });
  try {
    const res = await runTool('ui-probe.mjs', ['--cdp-url', fake.httpBase]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /没有可调试的 WebView 页面/);
  } finally {
    await fake.close();
  }
});

await check('端口后面不是调试器（返回 HTML）：说清楚不是 JSON', async () => {
  const fake = await startFakeCdp({ mode: 'html' });
  try {
    const res = await runTool('ui-probe.mjs', ['--cdp-url', fake.httpBase]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /不是调试器 JSON/);
  } finally {
    await fake.close();
  }
});

await check('target 不是 WebView（UA 没有 ; wv）：拦住', async () => {
  const fake = await startFakeCdp({
    viewport: {
      ...DEFAULT_VIEWPORT,
      ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    },
  });
  try {
    const res = await runTool('ui-probe.mjs', ['--cdp-url', fake.wsUrl, '--dry-run']);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /不是 Android WebView/);
  } finally {
    await fake.close();
  }
});

await check('--dry-run 没有设备也能算坐标（不点）', async () => {
  const fake = await startFakeCdp();
  try {
    const res = await runTool('ui-probe.mjs', ['--cdp-url', fake.wsUrl, '--tap', '#btnCasual', '--dry-run']);
    assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
    assert.match(res.stdout, /试算/);
    assert.match(res.stdout, /input tap 540 624/);
  } finally {
    await fake.close();
  }
});

await check('--dry-run + 设备：不跑 uiautomator、不落盘、不点，坐标标成估算', async () => {
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#btnCasual', '--dry-run', '--json']);
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  const data = parseJson(res.stdout);
  assert.equal(data.tapped, false);
  assert.equal(data.frame, null);
  assert.equal(data.mapping.estimated, true);
  assert.equal(data.scrolled, false);
  const lines = adbLines(res.adbLog);
  assert.equal(lines.some((line) => line.includes('uiautomator')), false, `dry-run 不得跑 uiautomator：${lines.join(' | ')}`);
  assert.equal(lines.some((line) => line.includes('.xml')), false, `dry-run 不得读写远端 dump：${lines.join(' | ')}`);
  assert.equal(lines.some((line) => line.includes('shell input tap')), false, 'dry-run 不得真的点');
  assert.match(res.stderr, /--dry-run 不跑 uiautomator/);
});

await check('--dry-run 元素在视口外：回报视口外、未点击，不滚动不探测', async () => {
  const items = DEFAULT_ITEMS.map((it) => (it.id === 'btnCasual'
    ? { ...it, rect: { x: 40, y: 1200, w: 280, h: 56 }, inView: false }
    : it));
  const res = await runDeviceMode('ui-probe.mjs', ['--tap', '#btnCasual', '--dry-run'], { items });
  assert.equal(res.code, 0, `退出码 ${res.code}：${res.stderr}`);
  assert.match(res.stdout, /视口外/);
  assert.match(res.stdout, /没有真的点/);
  const lines = adbLines(res.adbLog);
  assert.equal(lines.some((line) => line.includes('shell input tap')), false, '视口外不得真的点');
  assert.equal(lines.some((line) => line.includes('uiautomator')), false, 'dry-run 不得跑 uiautomator');
});

rmSync(TMP, { recursive: true, force: true });

const total = passed + failures.length;
process.stdout.write(`\n${passed}/${total} 项通过`);
if (failures.length > 0) {
  process.stdout.write(`，${failures.length} 项失败\n`);
  for (const f of failures) process.stdout.write(`  - ${f.name}：${f.message.split('\n')[0]}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('（未在真机验证：本机 adb devices 里没有设备）\n');
  process.exitCode = 0;
}
