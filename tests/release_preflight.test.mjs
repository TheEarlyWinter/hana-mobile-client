/* 发布前强校验与版本基线回归（任务 7）。
 *
 * 被测对象：scripts/release.ps1、android/build.ps1。
 * 方法：把两个脚本原样复制到临时项目里，配一个假 SDK（build-tools 下放 .cmd 假工具）
 * 和一个假 JDK（javac / keytool），真的用 pwsh 跑脚本，只看外部可观察结果：
 *   - 退出码、报错原因
 *   - web/download 里 latest.json / index.html / APK 的字节是否被动过
 *   - android/build、android/dist、android/debug.jks 有没有被创建
 *   - 假工具调用日志（谁被调用、从哪个 build-tools 目录被调用）
 *
 * 不跑真实 SDK / 真机 / 真网关，不碰仓库里的 web/download，不生成真签名材料。
 *
 * 子进程一律经 runner.ps1 拉起（见下文）：它只把本进程的输出编码固定成 UTF-8，
 * 再原样转交参数。被测脚本本身不因这套回归而改行为。
 *
 * 红证据：设 HANA_RELEASE_TEST_SOURCE_ROOT 指向一个只放了旧版 scripts/release.ps1 与
 * android/build.ps1 的临时目录（用 `git show HEAD:…` 导出），就能拿同一份用例跑旧脚本，
 * 不需要 git checkout 工作树、不会回退任何人的改动。不设时默认用仓库当前源码。
 *
 * 假工具协议：
 *   aapt2 compile|link|dump badging    link 复制一个预制的 zip；dump 读 HANA_FAKE_BADGING 的 JSON
 *   d8 / zipalign / apksigner          d8 产 classes.dex；zipalign 复制；apksigner sign 复制、verify 看环境变量
 *   javac / keytool                    javac 产一个 .class；keytool 产一个 keystore 文件
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');
const SOURCE_ROOT = process.env.HANA_RELEASE_TEST_SOURCE_ROOT
  ? path.resolve(process.env.HANA_RELEASE_TEST_SOURCE_ROOT)
  : ROOT;
const RELEASE_PS1 = path.join(SOURCE_ROOT, 'scripts', 'release.ps1');
const BUILD_PS1 = path.join(SOURCE_ROOT, 'android', 'build.ps1');

const PACKAGE_NAME = 'com.hanamobile.app';
const MIN_APK_BYTES = 60 * 1024; // 脚本会拒收小于 50KB 的产物

// ---------- pwsh ----------

let PS = null;
let PSHOME = null;
if (process.platform === 'win32') {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSHOME'], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (probe.status === 0) {
    PSHOME = String(probe.stdout || '').trim();
    PS = path.join(PSHOME, 'pwsh.exe');
  }
}

// ---------- 最小 zip（build.ps1 会拿 ZipFile 打开 base.apk 塞 classes.dex） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entries[name]) ? entries[name] : Buffer.from(entries[name], 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------- 假工具 ----------

const FAKE_TOOL = String.raw`
import fs from 'node:fs';
import path from 'node:path';

const [tool, ...args] = process.argv.slice(2);
const logPath = process.env.HANA_FAKE_LOG;
if (logPath) {
  const from = process.env.HANA_FAKE_TOOL_DIR || '';
  fs.appendFileSync(logPath, from + tool + '.cmd ' + args.join(' ') + '\n');
}

function die(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}
function valueOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}
function mkdirp(dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
}

if (tool === 'aapt2') {
  const sub = args[0];
  if (sub === 'compile') {
    const out = valueOf('-o');
    if (!out) die('fake aapt2 compile: 没有 -o');
    fs.writeFileSync(out, 'res');
    process.exit(0);
  }
  if (sub === 'link') {
    const out = valueOf('-o');
    const base = process.env.HANA_FAKE_BASE_APK;
    if (!out || !base) die('fake aapt2 link: 缺少 -o 或 HANA_FAKE_BASE_APK');
    fs.copyFileSync(base, out);
    const javaDir = valueOf('--java');
    if (javaDir) {
      mkdirp(path.join(javaDir, 'fake'));
      fs.writeFileSync(path.join(javaDir, 'fake', 'R.java'), 'public final class R {}\n');
    }
    process.exit(0);
  }
  if (sub === 'dump') {
    const specPath = process.env.HANA_FAKE_BADGING;
    if (!specPath) die('fake aapt2 dump: 缺少 HANA_FAKE_BADGING');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    if (spec.exitCode && spec.exitCode !== 0) die(spec.error || 'ERROR: dump failed', spec.exitCode);
    const lines = [
      "package: name='" + spec.package + "' versionCode='" + spec.versionCode
        + "' versionName='" + spec.versionName + "' platformBuildVersionName='15'"
        + " platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'",
      "sdkVersion:'26'",
      "targetSdkVersion:'36'",
      "application-label:'Hana Mobile'",
      "application: label='Hana Mobile' icon='res/drawable/ic_launcher_bot.xml'",
      "launchable-activity: name='com.hanamobile.app.MainActivity'  label='' icon=''",
    ];
    if (spec.debuggable) lines.push('application-debuggable');
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
  }
  die('fake aapt2: 不认识的参数 ' + args.join(' '));
}

if (tool === 'd8') {
  const outDir = valueOf('--output');
  if (!outDir) die('fake d8: 没有 --output');
  mkdirp(outDir);
  fs.writeFileSync(path.join(outDir, 'classes.dex'), 'dex');
  process.exit(0);
}

if (tool === 'zipalign') {
  const input = args[args.length - 2];
  const output = args[args.length - 1];
  fs.copyFileSync(input, output);
  process.exit(0);
}

if (tool === 'apksigner') {
  const sub = args[0];
  if (sub === 'sign') {
    const out = valueOf('--out');
    const input = args[args.length - 1];
    if (!out) die('fake apksigner sign: 没有 --out');
    fs.copyFileSync(input, out);
    process.exit(0);
  }
  if (sub === 'verify') {
    const code = Number(process.env.HANA_FAKE_VERIFY_EXIT || '0');
    if (code !== 0) die(process.env.HANA_FAKE_VERIFY_ERROR || 'ERROR: signature verify failed', code);
    process.stdout.write('Signer #1 certificate SHA-256 digest: ' + 'ab'.repeat(32) + '\n');
    process.stdout.write('Signer #1 certificate DN: CN=Hana Mobile\n');
    process.exit(0);
  }
  die('fake apksigner: 不认识的参数 ' + args.join(' '));
}

if (tool === 'javac') {
  const classesDir = valueOf('-d');
  if (classesDir) {
    mkdirp(classesDir);
    fs.writeFileSync(path.join(classesDir, 'MainActivity.class'), 'class');
  }
  process.exit(0);
}

if (tool === 'keytool') {
  const ks = valueOf('-keystore');
  if (!ks) die('fake keytool: 没有 -keystore');
  fs.writeFileSync(ks, 'keystore');
  process.exit(0);
}

die('fake tool: 未知工具 ' + tool);
`;

/* 测试自己拉子进程的入口。为什么要多这一层：
 *   pwsh 写 stdout/stderr 时按控制台代码页编码，CI runner 是英文系统（CP 437），
 *   没有中文字形，中文报错就整段变成「?」，断言中文原因的用例永远匹配不到。
 *   编码是「这套回归怎么读子进程文本」的问题，属于测试，不该写进产品脚本：
 *   把 [Console]::OutputEncoding 写进 build.ps1 是进程级的，会顺着
 *   release.ps1 调 build.ps1 那条路污染产品脚本的运行时。
 * 只用 -File 传参，不拼 -Command 字符串，不用操心引号与转义。
 */
const RUNNER_PS1 = String.raw`# 由 tests/release_preflight.test.mjs 生成：先把本进程的输出编码固定成 UTF-8，
# 再原样转交给真正的被测脚本。没有这一层，英文 runner（CP 437）上的中文会变成「?」。
$forced = $env:HANA_TEST_RUNNER_CODEPAGE
if ($forced) {
  # 只用于在中文开发机上复现 runner 的英文代码页（如 437），验证编码真的有影响。
  [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding([int]$forced)
} else {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
}

$target = $args[0]
$rest = @($args | Select-Object -Skip 1)
& $target @rest
# 被测脚本自己 exit 会直接结束本进程；走到这里说明它没抛错也没 exit。
exit 0
`;

function writeCmd(dir, tool, toolkitDir) {
  const body = [
    '@echo off',
    'set HANA_FAKE_TOOL_DIR=%~dp0',
    `"${process.execPath}" "${path.join(toolkitDir, 'fake-tool.mjs')}" ${tool} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, `${tool}.cmd`), body, 'utf8');
}

function prepareToolkit() {
  const toolkitDir = path.join(ARTIFACTS, 'release-preflight-toolkit');
  fs.mkdirSync(toolkitDir, { recursive: true });
  fs.writeFileSync(path.join(toolkitDir, 'fake-tool.mjs'), FAKE_TOOL, 'utf8');
  fs.writeFileSync(path.join(toolkitDir, 'runner.ps1'), RUNNER_PS1, 'utf8');
  for (const tool of ['aapt2', 'd8', 'zipalign', 'apksigner', 'javac', 'keytool']) {
    writeCmd(toolkitDir, tool, toolkitDir);
  }
  return toolkitDir;
}

/** 跑被测脚本的固定入口（编码固定发生在这一层，不在产品脚本里）。 */
function runnerPath() {
  return path.join(TOOLKIT, 'runner.ps1');
}

// ---------- 临时项目 ----------

function manifestXml(code, name) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${PACKAGE_NAME}"
    android:versionCode="${code}"
    android:versionName="${name}">

    <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36" />
    <application android:label="Hana Mobile">
        <activity android:name=".MainActivity" android:exported="true" />
    </application>
</manifest>
`;
}

function apkBytes(tag) {
  const buf = Buffer.alloc(MIN_APK_BYTES, 0);
  buf.write(`fake-apk:${tag}`, 0, 'utf8');
  return buf;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeDownloadFixture(proj, { code, name, bytes }) {
  const dir = path.join(proj, 'web', 'download');
  fs.mkdirSync(dir, { recursive: true });
  const file = `hana-mobile-${name}.apk`;
  fs.writeFileSync(path.join(dir, file), bytes);
  fs.writeFileSync(
    path.join(dir, 'latest.json'),
    JSON.stringify(
      {
        versionName: name,
        versionCode: code,
        file,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
        builtAt: '2026-11-04T22:07:32.6232484+08:00',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>旧下载页</title>\n', 'utf8');
}

/**
 * 造一个临时项目 + 假 SDK。
 * opts.manifest      { code, name }
 * opts.published     null | { code, name, bytes }
 * opts.distApk       null | { name, bytes }
 * opts.keystore      bool
 * opts.sdk           { buildToolsName, missing: [], legacyPlaceholders, extraBuildTools: [] }
 */
function makeProject(caseName, opts = {}) {
  const runDir = fs.mkdtempSync(path.join(ARTIFACTS, `release-preflight-${caseName}-`));
  const proj = path.join(runDir, 'proj');

  fs.mkdirSync(path.join(proj, 'scripts'), { recursive: true });
  fs.copyFileSync(RELEASE_PS1, path.join(proj, 'scripts', 'release.ps1'));

  const androidDir = path.join(proj, 'android');
  fs.mkdirSync(path.join(androidDir, 'src', 'com', 'hanamobile', 'app'), { recursive: true });
  fs.copyFileSync(BUILD_PS1, path.join(androidDir, 'build.ps1'));
  fs.writeFileSync(path.join(androidDir, 'src', 'com', 'hanamobile', 'app', 'MainActivity.java'), 'class MainActivity {}\n');
  fs.mkdirSync(path.join(androidDir, 'res'), { recursive: true });
  fs.mkdirSync(path.join(androidDir, 'assets'), { recursive: true });

  const manifest = opts.manifest || { code: 4, name: '0.4' };
  fs.writeFileSync(path.join(androidDir, 'AndroidManifest.xml'), manifestXml(manifest.code, manifest.name), 'utf8');

  if (opts.keystore) fs.writeFileSync(path.join(androidDir, 'debug.jks'), 'keystore');

  if (opts.distApk) {
    fs.mkdirSync(path.join(androidDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(androidDir, 'dist', `hana-mobile-${opts.distApk.name}.apk`), opts.distApk.bytes);
  }

  if (opts.published) writeDownloadFixture(proj, opts.published);
  else fs.mkdirSync(path.join(proj, 'web', 'download'), { recursive: true });

  // 假 SDK
  const sdkDir = path.join(runDir, 'sdk');
  const sdkOpts = opts.sdk || {};
  const buildToolsName = sdkOpts.buildToolsName || '35.0.0';
  const btDir = path.join(sdkDir, 'build-tools', buildToolsName);
  fs.mkdirSync(btDir, { recursive: true });
  const missing = sdkOpts.missing || [];
  for (const tool of ['aapt2', 'd8', 'zipalign', 'apksigner']) {
    if (!missing.includes(tool)) fs.copyFileSync(path.join(TOOLKIT, `${tool}.cmd`), path.join(btDir, `${tool}.cmd`));
  }
  if (sdkOpts.legacyPlaceholders) {
    // 旧 build.ps1 只认 aapt2.exe / d8.bat / zipalign.exe / apksigner.bat。
    // 放同名空文件只为让它通过「工具存在」检查，好观察它在失败前到底做了什么。
    fs.writeFileSync(path.join(btDir, 'aapt2.exe'), '');
    fs.writeFileSync(path.join(btDir, 'd8.bat'), '');
    fs.writeFileSync(path.join(btDir, 'zipalign.exe'), '');
    fs.writeFileSync(path.join(btDir, 'apksigner.bat'), '');
  }
  for (const extra of sdkOpts.extraBuildTools || []) {
    const extraDir = path.join(sdkDir, 'build-tools', extra);
    fs.mkdirSync(extraDir, { recursive: true });
    for (const tool of ['aapt2', 'd8', 'zipalign', 'apksigner']) {
      fs.copyFileSync(path.join(TOOLKIT, `${tool}.cmd`), path.join(extraDir, `${tool}.cmd`));
    }
  }
  fs.mkdirSync(path.join(sdkDir, 'platforms', 'android-36'), { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'platforms', 'android-36', 'android.jar'), '');

  // 假 JDK 放 PATH 最前
  const binDir = path.join(runDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(TOOLKIT, 'javac.cmd'), path.join(binDir, 'javac.cmd'));
  fs.copyFileSync(path.join(TOOLKIT, 'keytool.cmd'), path.join(binDir, 'keytool.cmd'));

  const baseApkPath = path.join(runDir, 'base.apk');
  // 资源块得撑到 50KB 以上：release.ps1 会拒收明显不对的小包。
  fs.writeFileSync(
    baseApkPath,
    makeZip({
      'AndroidManifest.xml': 'binary-manifest',
      'resources.arsc': Buffer.alloc(MIN_APK_BYTES, 7),
      'res/layout/main.xml': '<x/>',
    }),
  );

  const badgingPath = path.join(runDir, 'badging.json');
  const logPath = path.join(runDir, 'tools.log');
  fs.writeFileSync(logPath, '');

  const env = {
    ...process.env,
    NO_COLOR: '1',
    ANDROID_HOME: sdkDir,
    PATH: [binDir, PSHOME, path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter),
    HANA_FAKE_LOG: logPath,
    HANA_FAKE_BADGING: badgingPath,
    HANA_FAKE_BASE_APK: baseApkPath,
    HANA_FAKE_VERIFY_EXIT: '0',
  };

  return {
    runDir,
    proj,
    sdkDir,
    btDir,
    logPath,
    badgingPath,
    env,
    setBadging(spec) {
      fs.writeFileSync(badgingPath, JSON.stringify({ package: PACKAGE_NAME, versionCode: 14, versionName: '0.9.11', debuggable: false, ...spec }), 'utf8');
    },
    run(script, args, envExtra = {}) {
      const r = spawnSync(
        PS,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          runnerPath(),
          script,
          ...args,
        ],
        { cwd: proj, env: { ...env, ...envExtra }, timeout: 180000, windowsHide: true },
      );
      const stdout = decodeOutput(r.stdout || Buffer.alloc(0));
      const stderr = decodeOutput(r.stderr || Buffer.alloc(0));
      return {
        status: r.status,
        stdout,
        stderr,
        output: `${stdout}\n${stderr}`,
        toolLog: fs.readFileSync(logPath, 'utf8'),
      };
    },
    runRelease(args, envExtra = {}) {
      return this.run(path.join(proj, 'scripts', 'release.ps1'), args, envExtra);
    },
    runBuild(args, envExtra = {}) {
      return this.run(path.join(proj, 'android', 'build.ps1'), args, envExtra);
    },
    downloadState() {
      const dir = path.join(proj, 'web', 'download');
      const out = {};
      for (const name of fs.readdirSync(dir).sort()) {
        out[name] = sha256(fs.readFileSync(path.join(dir, name)));
      }
      return out;
    },
    readLatest() {
      return JSON.parse(fs.readFileSync(path.join(proj, 'web', 'download', 'latest.json'), 'utf8'));
    },
    readLatestRaw() {
      return fs.readFileSync(path.join(proj, 'web', 'download', 'latest.json'), 'utf8');
    },
    has(p) {
      return fs.existsSync(path.join(proj, p));
    },
  };
}

// ---------- 断言小工具 ----------

function tail(text, lines = 25) {
  return String(text).trim().split('\n').slice(-lines).join('\n');
}

// pwsh 在 Windows 上把重定向输出写成控制台代码页（GBK），不是 UTF-8。
// 先按 UTF-8 严格解码，失败再按 GBK 解；顺手去掉 ANSI 颜色码。
const ANSI = /\u001b\[[0-9;]*m/g;
function decodeOutput(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('gbk').decode(buf);
  }
  return text.replace(ANSI, '');
}

function expectSuccess(res) {
  assert.equal(res.status, 0, `应当成功，实际退出码 ${res.status}\n${tail(res.output)}`);
}

function expectFailure(res, reason) {
  assert.notEqual(res.status, 0, `应当失败，实际退出码 ${res.status}\n${tail(res.output)}`);
  if (reason) {
    assert.match(
      res.output,
      reason,
      `失败原因不对：${encodingHint(res.output)}\n${tail(res.output)}`,
    );
  }
}

/* 子进程把中文写丢了（控制台代码页不是 UTF-8，如 runner 的 CP 437）时，整段中文会变成「?」，
 * 任何中文断言都永远匹配不到。这种时候不能说成「文案变了」：失败信息里直接点名编码丢了。 */
function encodingHint(output) {
  const runs = String(output).match(/\?{2,}/g);
  return runs && runs.length >= 2
    ? '（输出里出现连续问号：子进程的中文在写出时已丢，先查控制台代码页与输出编码，不是文案变了）'
    : '';
}

function expectDownloadUntouched(before, after, label) {
  assert.deepEqual(after, before, `${label}：失败时不该动 web/download（latest.json / index.html / APK 必须原样）`);
}

// ---------- 用例 ----------

let TOOLKIT = null;
const tests = [];
function t(name, fn) {
  tests.push([name, fn]);
}

const PUBLISHED = { code: 13, name: '0.9.10', bytes: apkBytes('published-0.9.10') };

t('release：请求 code 12（低于 latest 13）在构建/复制前就被拒绝', () => {
  const p = makeProject('baseline', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v12') },
    keystore: true,
  });
  p.setBadging({ versionCode: 12, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '12', '-SkipBuild']);
  expectFailure(res, /12|13/);
  expectDownloadUntouched(before, p.downloadState(), 'code 12');
  assert.equal(p.has('android/build'), false, '基线不过时不该开始构建');
});

t('release：正常发新版本 14 会写 latest.json / 下载页，并且真的验过包', () => {
  const p = makeProject('new-version', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    keystore: true,
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14']);
  expectSuccess(res);

  const latest = p.readLatest();
  assert.equal(latest.versionCode, 14);
  assert.equal(latest.versionName, '0.9.11');
  assert.equal(latest.file, 'hana-mobile-0.9.11.apk');
  assert.ok(p.has(path.join('web', 'download', 'hana-mobile-0.9.11.apk')), 'APK 应落到下载目录');
  const index = fs.readFileSync(path.join(p.proj, 'web', 'download', 'index.html'), 'utf8');
  assert.match(index, /hana-mobile-0\.9\.11\.apk/);
  assert.match(res.toolLog, /aapt2\.cmd dump badging/, '发布前必须真的解析过包');
  assert.match(res.toolLog, /apksigner\.cmd verify/, '发布前必须真的验过签名');
});

t('release：重复发同一版本且 APK 字节一致，幂等通过且不动下载页/latest.json', () => {
  const p = makeProject('idempotent', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.10', bytes: PUBLISHED.bytes },
    keystore: true,
  });
  p.setBadging({ versionCode: 13, versionName: '0.9.10' });
  const latestBefore = p.readLatestRaw();
  const indexBefore = fs.readFileSync(path.join(p.proj, 'web', 'download', 'index.html'), 'utf8');
  const res = p.runRelease(['-VersionName', '0.9.10', '-VersionCode', '13', '-SkipBuild']);
  expectSuccess(res);
  assert.equal(p.readLatestRaw(), latestBefore, '幂等重发不该重写 latest.json（builtAt 都不该变）');
  assert.equal(
    fs.readFileSync(path.join(p.proj, 'web', 'download', 'index.html'), 'utf8'),
    indexBefore,
    '幂等重发不该重写下载页',
  );
  assert.match(res.output, /幂等|已发布/);
});

t('release：同版本码但 APK 不是同一份（同码异包）必须拒绝', () => {
  const p = makeProject('same-code-diff-apk', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.10', bytes: apkBytes('evil-0.9.10') },
    keystore: true,
  });
  p.setBadging({ versionCode: 13, versionName: '0.9.10' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.10', '-VersionCode', '13', '-SkipBuild']);
  expectFailure(res, /同码异包|不是同一份|sha256/i);
  expectDownloadUntouched(before, p.downloadState(), '同码异包');
});

t('release：SDK 里没有 aapt2 时 fail-closed，不发布', () => {
  const p = makeProject('missing-aapt2', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
    sdk: { missing: ['aapt2'] },
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /aapt2/);
  expectDownloadUntouched(before, p.downloadState(), '缺 aapt2');
});

t('release：aapt2 dump badging 失败时 fail-closed', () => {
  const p = makeProject('badging-fails', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ exitCode: 1, error: 'ERROR: dump failed' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /badging/i);
  expectDownloadUntouched(before, p.downloadState(), 'badging 失败');
});

t('release：包名不是 com.hanamobile.app 时拒绝', () => {
  const p = makeProject('wrong-package', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ package: 'com.evil.app', versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /com\.evil\.app|包名/);
  expectDownloadUntouched(before, p.downloadState(), '包名不对');
});

t('release：包内 versionCode 与请求不一致时拒绝', () => {
  const p = makeProject('wrong-code', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ versionCode: 12, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /versionCode|版本码/);
  expectDownloadUntouched(before, p.downloadState(), 'code 不符');
});

t('release：包是 debuggable 时拒绝', () => {
  const p = makeProject('debuggable-apk', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11', debuggable: true });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /debuggable/i);
  expectDownloadUntouched(before, p.downloadState(), 'debuggable');
});

t('release：apksigner verify 失败时拒绝', () => {
  const p = makeProject('verify-fails', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild'], {
    HANA_FAKE_VERIFY_EXIT: '1',
  });
  expectFailure(res, /apksigner|签名/);
  expectDownloadUntouched(before, p.downloadState(), '签名验证失败');
});

t('release：-Debuggable 发布请求被拒绝（debuggable 包不许外发）', () => {
  const p = makeProject('release-debuggable', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild', '-Debuggable']);
  expectFailure(res, /debuggable/i);
  expectDownloadUntouched(before, p.downloadState(), '-Debuggable');
});

t('release：包名只是大小写不同（com.Hanamobile.app）也必须拒绝', () => {
  const p = makeProject('package-case', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
  });
  // PowerShell 的 -ne 默认忽略大小写，不改成 -cne 就会把这个包当成本应用的包。
  p.setBadging({ package: 'com.Hanamobile.app', versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /com\.Hanamobile\.app|包名/);
  expectDownloadUntouched(before, p.downloadState(), '包名大小写不同');
});

t('release：-AllowDowngrade 允许低于基线的版本码正常发布', () => {
  const p = makeProject('allow-downgrade', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.9', bytes: apkBytes('v12') },
    keystore: true,
  });
  p.setBadging({ versionCode: 12, versionName: '0.9.9' });
  const res = p.runRelease(['-VersionName', '0.9.9', '-VersionCode', '12', '-SkipBuild', '-AllowDowngrade']);
  expectSuccess(res);
  const latest = p.readLatest();
  assert.equal(latest.versionCode, 12, '显式降级开关应允许发布低于基线的版本码');
  assert.equal(latest.file, 'hana-mobile-0.9.9.apk');
});

t('release：-AllowDowngrade 不能绕过包身份校验（错包名仍拒绝）', () => {
  const p = makeProject('allow-downgrade-bad-package', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.9', bytes: apkBytes('v12') },
    keystore: true,
  });
  p.setBadging({ package: 'com.evil.app', versionCode: 12, versionName: '0.9.9' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.9', '-VersionCode', '12', '-SkipBuild', '-AllowDowngrade']);
  expectFailure(res, /com\.evil\.app|包名/);
  expectDownloadUntouched(before, p.downloadState(), '降级 + 错包名');
});

t('release：build-tools 里混着 rc 预览目录时，按数值选稳定目录（不是字典序）', () => {
  const p = makeProject('preview-build-tools', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
    // 字典序：35.0.0 < 35.0.10 < 36.0.0-rc1；按数值最大的是 35.0.10，rc 必须被跳过。
    sdk: { buildToolsName: '35.0.0', extraBuildTools: ['35.0.10', '36.0.0-rc1'] },
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectSuccess(res);
  assert.match(res.toolLog, /35\.0\.10[\\/]aapt2\.cmd/, '必须选数值最大的稳定目录 35.0.10 的 aapt2');
  assert.doesNotMatch(res.toolLog, /36\.0\.0-rc1/, '预览目录不该被选中');
  assert.doesNotMatch(res.toolLog, /35\.0\.0[\\/]aapt2\.cmd/, '不能退回字典序第一个 35.0.0');
});

t('release：只有预览 build-tools 时明确失败，不去猜', () => {
  const p = makeProject('preview-only', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    distApk: { name: '0.9.11', bytes: apkBytes('v14') },
    keystore: true,
    sdk: { buildToolsName: '36.0.0-rc1' },
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14', '-SkipBuild']);
  expectFailure(res, /build-tools/);
  expectDownloadUntouched(before, p.downloadState(), '只有预览目录');
});

t('release：缺现有签名 key 时在构建前失败，不生成新 key', () => {
  const p = makeProject('release-no-signing-material', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    sdk: { legacyPlaceholders: true },
  });
  p.setBadging({ versionCode: 14, versionName: '0.9.11' });
  const before = p.downloadState();
  const res = p.runRelease(['-VersionName', '0.9.11', '-VersionCode', '14']);
  // 断言具体报错，不用 /key/ 这种宽泛词：临时目录名里带 key 会让旧代码的无关报错蒙混过关。
  expectFailure(res, /debug\.jks/);
  expectDownloadUntouched(before, p.downloadState(), '缺 key');
  assert.equal(p.has(path.join('android', 'debug.jks')), false, '发布路径不能静默生成新签名材料');
  assert.equal(p.has(path.join('android', 'build')), false, '缺 key 必须在构建动作之前就失败');
  assert.equal(p.has(path.join('android', 'dist')), false, '缺 key 不该产出 dist 目录');
});

t('build：开发构建仍可自动生成调试 key 并产出 APK', () => {
  const p = makeProject('dev-build', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
  });
  const res = p.runBuild(['-VersionName', '0.9.11', '-VersionCode', '14']);
  expectSuccess(res);
  assert.ok(p.has(path.join('android', 'debug.jks')), '开发构建应生成调试 key');
  assert.ok(p.has(path.join('android', 'dist', 'hana-mobile-0.9.11.apk')), '开发构建应产出 APK');
});

t('build：不带版本参数且 manifest 落后于 latest 时拒绝，不用旧默认值', () => {
  const p = makeProject('build-stale-default', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    sdk: { legacyPlaceholders: true },
  });
  const res = p.runBuild([]);
  expectFailure(res, /比已发布的/);
  assert.equal(p.has(path.join('android', 'build')), false, '版本默认值过旧应在动手前失败');
  assert.equal(p.has(path.join('android', 'dist')), false, '不该产出 dist');
});

t('build：非法版本码参数在动手前拒绝', () => {
  const p = makeProject('build-bad-code', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    sdk: { legacyPlaceholders: true },
  });
  const res = p.runBuild(['-VersionName', '0.9.11', '-VersionCode', '12abc']);
  expectFailure(res, /版本码/);
  assert.equal(p.has(path.join('android', 'build')), false);
});

t('build：非法版本名参数在动手前拒绝（不能拼出越界路径）', () => {
  const p = makeProject('build-bad-name', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    sdk: { legacyPlaceholders: true },
  });
  const res = p.runBuild(['-VersionName', '..\\..\\evil', '-VersionCode', '14']);
  expectFailure(res, /版本名/);
  assert.equal(p.has(path.join('android', 'build')), false);
});

t('build：debug.jks 是目录时 -Release 在清理 build 前拒绝', () => {
  const p = makeProject('release-signing-path', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    sdk: { legacyPlaceholders: true },
  });
  // 目录冒充 keystore：Test-Path 不带 -PathType Leaf 时会当成“key 已存在”。
  fs.mkdirSync(path.join(p.proj, 'android', 'debug.jks'));
  // 上一轮构建的产物：正确行为是在清理之前就失败，标记文件必须还在。
  fs.mkdirSync(path.join(p.proj, 'android', 'build'), { recursive: true });
  fs.writeFileSync(path.join(p.proj, 'android', 'build', 'marker.txt'), '上一轮产物');
  const res = p.runBuild(['-VersionName', '0.9.11', '-VersionCode', '14', '-Release']);
  expectFailure(res, /debug\.jks/);
  assert.equal(
    fs.existsSync(path.join(p.proj, 'android', 'build', 'marker.txt')),
    true,
    '目录冒充 key 时不该开始清理 build/',
  );
  assert.equal(p.has(path.join('android', 'dist')), false);
});

t('build：-Release 与 -Debuggable 互斥，发布构建不产 debuggable 包', () => {
  const p = makeProject('build-release-debuggable', {
    manifest: { code: 4, name: '0.4' },
    published: PUBLISHED,
    keystore: true,
    sdk: { legacyPlaceholders: true },
  });
  const res = p.runBuild(['-VersionName', '0.9.11', '-VersionCode', '14', '-Release', '-Debuggable']);
  expectFailure(res, /不能加 -Debuggable/);
  assert.equal(p.has(path.join('android', 'build')), false);
});

// ---------- 跑 ----------

if (!PS) {
  console.log('SKIP  release_preflight：本回归需要 Windows + pwsh');
  process.exit(0);
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
TOOLKIT = prepareToolkit();

let bad = 0;
for (const [name, fn] of tests) {
  const started = Date.now();
  try {
    fn();
    console.log(`PASS  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${String(err && err.message ? err.message : err).split('\n').join('\n      ')}`);
  }
}

console.log(`\n${tests.length - bad}/${tests.length} 通过`);
if (bad) process.exitCode = 1;
