// adb 封装：设备发现、应用 pid、WebView 调试套接字、端口转发、输入点击、界面尺寸。
//
// 只走 child_process，零第三方依赖。能预见的失败一律抛 DevtoolsError（中文 + 下一步），
// 原始 stderr 只留在 details 里，不往用户脸上糊栈。
//
// 设备序列号一律从参数或环境变量（HANA_ANDROID_SERIAL / ANDROID_SERIAL）来，
// adb 可执行文件可以用 HANA_ADB_BIN 覆盖（离线自检就是靠这个塞一个假 adb）。

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { DevtoolsError } from './errors.mjs';

export const APP_ID = 'com.hanamobile.app';
export const APP_ACTIVITY = 'com.hanamobile.app/.MainActivity';
const DEFAULT_TIMEOUT_MS = 15000;
const DUMP_DIR = '/sdcard';

/** 本次探测专属的远端 dump 文件：带 pid + 随机串，避免多次调用/多台工具互相覆盖。 */
function newDumpPath() {
  return `${DUMP_DIR}/hana-ui-probe-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.xml`;
}

/** adb 怎么调：默认 PATH 里的 adb；HANA_ADB_BIN 指向 .mjs/.js 时用当前 node 跑它（自检用）。 */
function adbTarget() {
  const custom = process.env.HANA_ADB_BIN;
  if (custom && custom.trim()) {
    const bin = custom.trim();
    if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, prefix: [bin] };
    return { cmd: bin, prefix: [] };
  }
  if (process.env.ADB && process.env.ADB.trim()) return { cmd: process.env.ADB.trim(), prefix: [] };
  return { cmd: process.platform === 'win32' ? 'adb.exe' : 'adb', prefix: [] };
}

function exec(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          killed: !!(err && err.killed),
          spawnError: err && err.code === 'ENOENT' ? err : null,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

/**
 * 跑一条 adb 命令。serial 为 null 时不带 -s（只有 `adb devices` 这类全局命令这样用）。
 * allowFail 为 true 时返回结果而不抛错，交给调用方判断。
 */
export async function runAdb(args, { serial = null, timeout = DEFAULT_TIMEOUT_MS, allowFail = false } = {}) {
  const full = serial ? ['-s', serial, ...args] : args.slice();
  const { cmd, prefix } = adbTarget();
  const res = await exec(cmd, [...prefix, ...full], timeout);

  if (res.spawnError) {
    throw new DevtoolsError(
      `找不到 adb 可执行文件（${cmd}）`,
      '把 Android platform-tools 加进 PATH，或用 HANA_ADB_BIN 指定 adb 的绝对路径',
      res.stderr.trim(),
    );
  }
  if (res.killed) {
    throw new DevtoolsError(
      `adb 超时（${Math.round(timeout / 1000)} 秒）：adb ${full.join(' ')}`,
      '设备可能卡住了；重插 USB 或跑 adb kill-server 再试，也可以加大 --timeout',
      res.stderr.trim(),
    );
  }
  const ok = res.code === 0;
  if (!ok && !allowFail) {
    throw new DevtoolsError(
      `adb 命令失败（退出码 ${res.code}）：adb ${full.join(' ')}`,
      '先单独跑一遍这条命令看设备怎么说',
      (res.stderr || res.stdout).trim(),
    );
  }
  return { ok, code: res.code, out: res.stdout.trim(), err: res.stderr.trim() };
}

/** `adb devices -l` 的解析结果：[{serial, state, model, device}]。 */
export async function listDevices() {
  const res = await runAdb(['devices', '-l'], { allowFail: true });
  if (!res.ok && !res.out) {
    throw new DevtoolsError('adb devices 跑不起来', '确认 adb 可用：adb version', res.err);
  }
  const devices = [];
  for (const raw of res.out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices')) continue;
    const parts = line.split(/\s+/);
    // `* daemon not running; starting now ...` 这类杂音也会出现在 stdout 里
    if (/^(device|offline|unauthorized|recovery|sideload|bootloader|no)$/.test(parts[1] || '') === false) continue;
    const pick = (prefix) => {
      const hit = parts.find((t) => t.startsWith(prefix));
      return hit ? hit.slice(prefix.length) : '';
    };
    devices.push({ serial: parts[0], state: parts[1], model: pick('model:'), device: pick('device:') });
  }
  return devices;
}

/**
 * 决定用哪台设备：显式参数 > 环境变量 > 唯一在线设备。
 * 一台都没有、或有多台而没指定，都直接说清楚，不猜。
 */
export async function resolveSerial(explicit) {
  const fromEnv = process.env.HANA_ANDROID_SERIAL || process.env.ANDROID_SERIAL || '';
  const wanted = (explicit || fromEnv || '').trim();
  const devices = await listDevices();

  if (wanted) {
    const hit = devices.find((d) => d.serial === wanted);
    if (!hit) {
      const known = devices.length ? devices.map((d) => `${d.serial}(${d.state})`).join('、') : '（一台都没有）';
      throw new DevtoolsError(
        `没有找到设备 ${wanted}`,
        `adb devices -l 现在看到的是：${known}；确认 USB 线插好、USB 调试已开`,
      );
    }
    if (hit.state !== 'device') {
      throw new DevtoolsError(
        `设备 ${wanted} 现在的状态是 ${hit.state}，不是可用的 device`,
        hit.state === 'unauthorized'
          ? '看手机屏幕，点「允许 USB 调试」；勾上「一律允许」下次就不用再点'
          : '拔插一次 USB、确认没被别的 adb 进程占用（adb kill-server 后重试）',
      );
    }
    return wanted;
  }

  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length === 0) {
    const others = devices.length ? `（另有 ${devices.map((d) => `${d.serial}:${d.state}`).join('、')}）` : '';
    throw new DevtoolsError(
      `没有可用的设备：adb devices 里没有 state=device 的设备${others}`,
      '手机用 USB 连上电脑、打开「USB 调试」（开发者选项里），然后确认 adb devices 能看到它',
    );
  }
  if (ready.length > 1) {
    throw new DevtoolsError(
      `连着 ${ready.length} 台设备，不知道该用哪台：${ready.map((d) => d.serial).join('、')}`,
      '加 --device <序列号> 指定（也可以用环境变量 HANA_ANDROID_SERIAL）',
    );
  }
  return ready[0].serial;
}

/**
 * 应用主进程 pid。WebView 的调试套接字名里带的就是这个 pid。
 * pidof 在部分机型/壳上不可靠（Android 8 以前没有），退回 ps -A。
 */
export async function findPid(serial) {
  const pidof = await runAdb(['shell', 'pidof', APP_ID], { serial, allowFail: true });
  const direct = pidof.out.split(/\s+/).find((t) => /^\d+$/.test(t));
  if (direct) return Number(direct);

  const ps = await runAdb(['shell', 'ps', '-A'], { serial, allowFail: true });
  for (const line of ps.out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    // 只认主进程；com.hanamobile.app:xxx 这类子进程的套接字不带 devtools
    if (parts[parts.length - 1] === APP_ID && /^\d+$/.test(parts[1])) return Number(parts[1]);
  }

  throw new DevtoolsError(
    `应用没在运行：设备上没有 ${APP_ID} 的进程`,
    `先在手机上把 Hana 打开（或 adb shell am start -n ${APP_ACTIVITY}），再跑本工具`,
  );
}

/**
 * 看设备上有哪些 devtools 套接字。
 * 返回 { readable, names }：readable=false 表示 /proc/net/unix 读不到（不当作「没有」）。
 */
export async function readDevtoolsSockets(serial) {
  const res = await runAdb(['shell', 'cat', '/proc/net/unix'], { serial, allowFail: true });
  if (!res.ok || res.out.indexOf('@') < 0) return { readable: false, names: [] };
  const names = new Set();
  const re = /@([A-Za-z0-9_.:-]*devtools_remote[A-Za-z0-9_.:-]*)/g;
  let m;
  while ((m = re.exec(res.out))) names.add(m[1]);
  return { readable: true, names: [...names] };
}

function portIsFree(port) {
  return new Promise((resolve) => {
    // 只做一次 bind 探测：能绑上就说明没人占（用完立刻关）
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 找一个空闲的本地端口：先试 preferredPort，被占就往后找 20 个，全占就让系统给。 */
export async function pickFreePort(preferred) {
  const start = Number(preferred) || 9222;
  for (let p = start; p < start + 20; p += 1) {
    if (await portIsFree(p)) return p;
  }
  return ephemeralPort();
}

/** `adb forward --list` 里这个套接字已经转发到哪个本地端口（没有就 null）。 */
async function findExistingForward(serial, socketName) {
  const res = await runAdb(['forward', '--list'], { serial, allowFail: true });
  for (const line of res.out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+tcp:(\d+)\s+localabstract:(\S+)$/);
    if (m && m[3] === socketName) return Number(m[2]);
  }
  return null;
}

/**
 * 把 `localabstract:webview_devtools_remote_<pid>` 转发到本机一个端口。
 * 同一套接字（同一个 pid）已经有转发就直接复用，避免反复跑把 forward 表堆满。
 * 返回 { port, owned }：owned=true 时退出前要 removeForward。
 */
export async function ensureForward(serial, socketName, preferredPort) {
  const existing = await findExistingForward(serial, socketName);
  if (existing) return { port: existing, owned: false };

  const port = await pickFreePort(preferredPort);
  const res = await runAdb(['forward', `tcp:${port}`, `localabstract:${socketName}`], { serial, allowFail: true });
  if (!res.ok) {
    throw new DevtoolsError(
      `adb forward 失败：tcp:${port} → localabstract:${socketName}`,
      '端口可能刚被别人占了，换一个 --port；也可以先 adb forward --remove-all 清一下',
      (res.err || res.out).trim(),
    );
  }
  return { port, owned: true };
}

export async function removeForward(serial, port) {
  await runAdb(['forward', '--remove', `tcp:${port}`], { serial, allowFail: true, timeout: 5000 });
}

/** 解析 uiautomator dump 的 XML：取包内最大的那个 WebView 节点的屏幕矩形（物理像素）。 */
function pickWebViewBounds(xml) {
  const nodes = [];
  const nodeRe = /<node\b([^>]*)>/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const attrs = {};
    const attrRe = /([\w:-]+)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = a[2];
    nodes.push(attrs);
  }
  let best = null;
  for (const n of nodes) {
    const cls = n.class || '';
    if (!/WebView$/.test(cls)) continue;
    const b = (n.bounds || '').match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
    if (x2 <= x1 || y2 <= y1) continue;
    const area = (x2 - x1) * (y2 - y1);
    // 优先自家的 WebView；不是自家的也留着当兜底（用户可能换了包名/在看别的页面）
    const own = (n.package || '') === APP_ID;
    const score = (own ? 1e15 : 0) + area;
    if (!best || score > best.score) {
      best = {
        score,
        bounds: { left: x1, top: y1, width: x2 - x1, height: y2 - y1, source: 'uiautomator', package: n.package || '' },
      };
    }
  }
  return best ? best.bounds : null;
}

/**
 * WebView 在屏幕上的物理矩形。CDP 给的是 CSS 像素，`input tap` 要的是屏幕物理像素，
 * 两者之间就差这一块：原点偏移 + 缩放。
 *
 * dump 只写本次随机唯一的远端文件，也只读/删这一份：默认的 /sdcard/window_dump.xml
 * 可能是别人（或上一次工具）留下的，不碰它，避免读到旧界面坐标、也避免覆盖别人的文件。
 * 老机型不认「dump 到指定路径」时直接返回 null，让调用方退回 dpr 估算——不为了兜底去
 * 跑不带路径的 dump（那正好会写默认文件）。
 *
 * 拿不到返回 null（调用方退回 devicePixelRatio + 原点 0，并明确告诉用户这是估算）。
 * 拿不到很常见：uiautomator dump 在页面一直动画时会报 "could not get idle state"。
 */
export async function readWebViewFrame(serial) {
  const dumpPath = newDumpPath();
  let xml = '';
  try {
    const dump = await runAdb(['shell', 'uiautomator', 'dump', dumpPath], { serial, allowFail: true, timeout: 25000 });
    if (dump.ok) {
      const cat = await runAdb(['shell', 'cat', dumpPath], { serial, allowFail: true });
      if (cat.ok && cat.out.indexOf('<hierarchy') >= 0) xml = cat.out;
    }
  } finally {
    // 只清理本次拥有的路径；清理失败不改变「有没有拿到矩形」的结论，也不碰默认 dump。
    try {
      await runAdb(['shell', 'rm', '-f', dumpPath], { serial, allowFail: true, timeout: 5000 });
    } catch {
      /* adb 自己都起不来时，清理也只能放弃 */
    }
  }
  if (!xml) return null;
  return pickWebViewBounds(xml);
}

/** 屏幕物理尺寸（有 override 用 override，`input tap` 认的就是它）。拿不到返回 null。 */
export async function readScreenSize(serial) {
  const res = await runAdb(['shell', 'wm', 'size'], { serial, allowFail: true });
  if (!res.ok) return null;
  const override = res.out.match(/Override size:\s*(\d+)\s*x\s*(\d+)/);
  const physical = res.out.match(/Physical size:\s*(\d+)\s*x\s*(\d+)/);
  const m = override || physical;
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 真点一下。坐标是屏幕物理像素，和 `adb shell input tap` 一致。 */
export async function inputTap(serial, x, y) {
  const res = await runAdb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], { serial, allowFail: true });
  if (!res.ok) {
    throw new DevtoolsError(
      `点击失败：input tap ${x} ${y}`,
      '确认设备没锁屏（锁屏时 input 事件会被丢掉），必要时 adb shell input keyevent 82 解锁',
      (res.err || res.out).trim(),
    );
  }
  return { x: Math.round(x), y: Math.round(y) };
}
