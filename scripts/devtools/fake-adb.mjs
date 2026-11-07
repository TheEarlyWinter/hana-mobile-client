// fake-adb —— 假 adb，只给离线自检用（通过 HANA_ADB_BIN 塞给 ui-probe / js-eval）。
//
// 只回答这两个工具真正会问的几条命令，其余一律报错退出，这样自检能顺带发现
// 「工具偷偷多跑了一条 adb」这种意外行为。
//
// 行为开关（环境变量）：
//   FAKE_ADB_LOG        每一行命令追加写到这个文件（自检用来断言真的发了 input tap）
//   FAKE_ADB_SERIAL     伪设备序列号，默认 FAKE0000
//   FAKE_ADB_NO_DEVICES=1   adb devices 里一台设备都没有
//   FAKE_ADB_NO_APP=1       pidof 与 ps 都查不到应用
//   FAKE_ADB_NO_SOCKET=1    没有 webview_devtools_remote_<pid> 套接字（调试没开）
//   FAKE_ADB_BOUNDS     WebView 的 XML bounds（左,上,右,下），默认 "0,0,1080,2400"
//   FAKE_ADB_UPSTREAM_PORT  设定后，forward 会真的在本机端口上起代理指向它（见 fake-adb-proxy.mjs）

import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const serial = process.env.FAKE_ADB_SERIAL || 'FAKE0000';

/** 等一个文件出现（代理 listen 完成后写的就绪标记）。 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

if (process.env.FAKE_ADB_LOG) {
  try {
    appendFileSync(process.env.FAKE_ADB_LOG, `${args.join(' ')}\n`);
  } catch {
    /* 日志写不下不算错 */
  }
}

// 去掉 -s <serial>
const rest = args[0] === '-s' ? args.slice(2) : args.slice();
const joined = rest.join(' ');

function ok(text = '') {
  process.stdout.write(text ? `${text}\n` : '');
  process.exit(0);
}

function fail(message) {
  process.stderr.write(`fake-adb: ${message}\n`);
  process.exit(1);
}

function dumpXml() {
  const bounds = process.env.FAKE_ADB_BOUNDS || '0,0,1080,2400';
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.hanamobile.app" bounds="[0,0][1080,2400]">
    <node index="1" text="" resource-id="" class="android.webkit.WebView" package="com.hanamobile.app" bounds="[${bounds.split(',').slice(0, 2).join(',')}][${bounds.split(',').slice(2).join(',')}]" />
  </node>
</hierarchy>`;
}

if (joined === 'devices -l') {
  if (process.env.FAKE_ADB_NO_DEVICES === '1') ok('List of devices attached');
  ok([
    'List of devices attached',
    `${serial}\tdevice product:fake model:FAKE_PHONE device:fake transport_id:1`,
    '',
  ].join('\n'));
}

if (rest[0] === 'forward') {
  // --list 返回空（没有历史转发），add / --remove 都当成功
  if (rest[1] !== '--list' && rest[1] !== '--remove' && process.env.FAKE_ADB_UPSTREAM_PORT) {
    // 假装真的开了转发：起一个单次 TCP 代理指向假 CDP 端点，路径和真机一致
    const localPort = Number(String(rest[1] || '').replace('tcp:', ''));
    if (Number.isInteger(localPort) && localPort > 0) {
      const readyFile = join(tmpdir(), `hana-fake-adb-${process.pid}-${localPort}.ready`);
      try { rmSync(readyFile, { force: true }); } catch { /* 没就没 */ }
      const child = spawn(
        process.execPath,
        [join(here, 'fake-adb-proxy.mjs'), String(localPort), process.env.FAKE_ADB_UPSTREAM_PORT, readyFile],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.unref();
      // 等代理真的 listen 了再返回，否则调用方马上连过去会砸在「连接被拒」上
      await waitForFile(readyFile, 5000);
      try { rmSync(readyFile, { force: true }); } catch { /* 没就没 */ }
    }
  }
  ok('');
}

if (rest[0] === 'shell') {
  const sub = rest[1];
  if (sub === 'pidof') {
    if (process.env.FAKE_ADB_NO_APP === '1') ok('');
    ok('4242');
  }
  if (sub === 'ps') {
    if (process.env.FAKE_ADB_NO_APP === '1') ok('');
    ok('USER PID PPID VSZ RSS WCHAN ADDR S NAME\nroot 1 0 1 1 0 0 S init\nu0_a42 4242 512 3000000 200000 0 0 S com.hanamobile.app');
  }
  if (sub === 'cat') {
    const target = rest[2] || '';
    if (target === '/proc/net/unix') {
      const lines = ['Num RefCount Protocol Flags Type St Inode Path'];
      // NO_SOCKET 时也不留空：列上别的进程的套接字，工具应该能读出「有调试口、但不是这个 pid」
      lines.push(process.env.FAKE_ADB_NO_SOCKET === '1'
        ? '0000000000000000: 00000002 00000000 00010000 0001 01 123456 @webview_devtools_remote_9999'
        : '0000000000000000: 00000002 00000000 00010000 0001 01 123456 @webview_devtools_remote_4242');
      lines.push('0000000000000000: 00000002 00000000 00010000 0001 01 123457 /dev/socket/logdw');
      ok(lines.join('\n'));
    }
    if (target.endsWith('.xml')) ok(dumpXml());
    ok('');
  }
  if (sub === 'uiautomator') {
    ok('UI hierchary dumped to: /sdcard/hana-ui-probe.xml');
  }
  if (sub === 'rm' || sub === 'input') {
    ok('');
  }
  if (sub === 'wm' && rest[2] === 'size') {
    ok('Physical size: 1080x2400');
  }
  fail(`不认识的命令：${joined}`);
}

fail(`不认识的命令：${joined}`);
