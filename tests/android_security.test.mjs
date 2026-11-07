/* Android WebView 安全边界：纯 Java URL/文件名探针 + 原生壳源码约束。
 *
 * URL 与文件名用例抽取 MainActivity.java 的真实方法，再用 javac/java 执行。
 * Android API 行为无法在裸 JVM 复现；相关边界用源码断言钉住，设备验收另做。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JAVA_SRC = fileURLToPath(new URL('../android/src/com/hanamobile/app/MainActivity.java', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('../android/build-artifacts/', import.meta.url));

function stripComments(code) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function extractMethod(java, signature) {
  const at = java.indexOf(signature);
  if (at < 0) return null;
  const braceAt = java.indexOf('{', at);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < java.length; i += 1) {
    if (java[i] === '{') depth += 1;
    else if (java[i] === '}') {
      depth -= 1;
      if (depth === 0) return java.slice(at, i + 1);
    }
  }
  return null;
}

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    const detail = String(err.message || err).split('\n').slice(0, 3).join(' ').slice(0, 500);
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

const rawJava = fs.readFileSync(JAVA_SRC, 'utf8');
const java = stripComments(rawJava);
const signatures = [
  ['isSafeHttpUrl', 'static boolean isSafeHttpUrl(String raw)'],
  ['sameOrigin', 'static boolean sameOrigin(String candidate, String configuredUrl)'],
  ['isWorkspaceContentUrl', 'static boolean isWorkspaceContentUrl(String candidate, String configuredUrl)'],
  ['sanitizeDownloadFileName', 'static String sanitizeDownloadFileName(String raw)'],
  ['uniqueDownloadFileName', 'static String uniqueDownloadFileName(String raw, File dir)'],
  ['matchesAcceptedMimeType', 'static boolean matchesAcceptedMimeType(String actualMimeType, String acceptedType)'],
  ['acceptsFileMimeType', 'static boolean acceptsFileMimeType(String actualMimeType, ArrayList<String> acceptedTypes)'],
  ['isAllowedContentUri', 'static boolean isAllowedContentUri(String scheme, String authority)'],
  ['FileChooserState', 'static final class FileChooserState'],
];
const methods = Object.fromEntries(signatures.map(([name, signature]) => [name, extractMethod(rawJava, signature)]));
const hasPureHelpers = Object.values(methods).every(Boolean);

const nav = extractMethod(java, 'public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request)');
const chooser = extractMethod(java, 'public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params)');
const filePicker = extractMethod(java, 'private void launchFileChooser(WebChromeClient.FileChooserParams params, ArrayList<String> acceptedTypes)');
const download = extractMethod(java, 'private void handleDownloadStart(String url, String userAgent, String contentDisposition, String mimeType)');
const enqueueDownload = extractMethod(java, 'private void enqueueWorkspaceDownload(Uri target, String userAgent, String mimeType, String fileName)');
const activityResult = extractMethod(java, 'protected void onActivityResult(int requestCode, int resultCode, Intent data)');
const finishFileChooser = extractMethod(java, 'private void finishFileChooser(Uri[] result)');
const filterAcceptedFiles = extractMethod(java, 'private Uri[] filterAcceptedFiles(Uri[] result, ArrayList<String> acceptedTypes)');

test('纯 Java URL 与文件名安全函数存在', () => {
  assert.ok(hasPureHelpers, `缺少方法：${signatures.filter(([name]) => !methods[name]).map(([name]) => name).join(', ')}`);
});

test('WebView 禁止混合内容、第三方 Cookie 和本地文件读取', () => {
  assert.match(java, /setMixedContentMode\s*\(\s*WebSettings\.MIXED_CONTENT_NEVER_ALLOW\s*\)/);
  assert.match(java, /setAcceptThirdPartyCookies\s*\(\s*web\s*,\s*false\s*\)/);
  assert.match(java, /setAllowFileAccess\s*\(\s*false\s*\)/);
  assert.match(java, /setAllowContentAccess\s*\(\s*false\s*\)/);
  assert.match(java, /setAllowFileAccessFromFileURLs\s*\(\s*false\s*\)/);
  assert.match(java, /setAllowUniversalAccessFromFileURLs\s*\(\s*false\s*\)/);
});

test('导航只放行严格同源；拒绝跨源子帧和无手势外链', () => {
  assert.ok(nav, '找不到 WebViewClient.shouldOverrideUrlLoading');
  assert.match(nav, /sameOrigin\s*\(\s*uri\.toString\(\)\s*,\s*startUrl\s*\)/);
  assert.match(nav, /request\.isForMainFrame\s*\(\s*\)/);
  assert.match(nav, /request\.hasGesture\s*\(\s*\)/);
  assert.match(nav, /isSafeHttpUrl\s*\(\s*uri\.toString\(\)\s*\)/);
  assert.match(nav, /Intent\.ACTION_VIEW/);
  assert.doesNotMatch(nav, /host\.equals\s*\(\s*"localhost"\s*\)/);
  assert.doesNotMatch(nav, /startsWith\s*\(\s*"file:\/\/"\s*\)/);
});

test('setup 协议只在错误页主帧生效', () => {
  assert.ok(nav, '找不到 shouldOverrideUrlLoading');
  const setupAt = nav.indexOf('SCHEME_SETUP.equals(scheme)');
  assert.ok(setupAt >= 0, '缺少 setup 协议拦截');
  const setupBlock = nav.slice(setupAt, setupAt + 360);
  assert.match(setupBlock, /request\.isForMainFrame\s*\(\s*\)/);
  assert.match(setupBlock, /errorPageShown/);
});

test('文件选择校验当前顶层同源，并保留 accept、capture、多选', () => {
  assert.ok(chooser, '找不到 onShowFileChooser');
  assert.match(chooser, /sameOrigin\s*\(\s*view\.getUrl\(\)\s*,\s*startUrl\s*\)/);
  assert.match(chooser, /getAcceptTypes\s*\(\s*\)/);
  assert.ok(filePicker, '找不到原生文件选择器构建方法');
  assert.match(filePicker, /MODE_OPEN_MULTIPLE/);
  assert.match(filePicker, /isCaptureEnabled\s*\(\s*\)/);
  assert.match(filePicker, /acceptsImage\s*\(/);
  assert.match(java, /EXTRA_MIME_TYPES/);
  assert.match(java, /getContentResolver\(\)\.getType\s*\(/);
  assert.match(java, /acceptsFileMimeType\s*\(/);
  assert.ok(filterAcceptedFiles, '找不到选中文件验证方法');
  assert.match(filterAcceptedFiles, /isAllowedContentUri\s*\(/);
  assert.match(rawJava, /无法可靠识别[^\"]*(发起|来源)/);
});

test('选择器单飞、拒绝串用，并在确认和结果交付前重验 origin', () => {
  assert.ok(chooser, '找不到 onShowFileChooser');
  const busyAt = chooser.indexOf('fileCallback != null || fileChooserState.isBusy()');
  assert.ok(busyAt >= 0, '新 callback 必须先检查旧回调或在途选择器');
  assert.doesNotMatch(chooser.slice(0, busyAt), /fileChoiceDialog[.]dismiss|finishFileChooser|cameraUri\s*=/);
  const busyBlock = chooser.slice(busyAt, busyAt + 220);
  assert.match(busyBlock, /callback\.onReceiveValue\(null\)/);
  assert.match(busyBlock, /return true/);
  assert.match(chooser, /fileChooserState\.begin\(startUrl\)/);
  assert.ok(filePicker, '找不到原生文件选择器构建方法');
  assert.match(filePicker, /fileChooserState\.isAuthorized\s*\(/);
  assert.equal((filePicker.match(/markPickerInFlight\s*\(/g) || []).length, 2, '相机与文档选择器启动前都要登记在途状态');
  assert.equal((filePicker.match(/markPickerInFlight\(web == null \? null : web\.getUrl\(\), startUrl\)/g) || []).length, 2, '启动 picker 前必须读取最新顶层 URL 并复核配置 origin');
  assert.ok(activityResult, '找不到 onActivityResult');
  assert.match(activityResult, /fileChooserState\.isPickerInFlight\s*\(/);
  assert.match(activityResult, /fileChooserState\.complete\s*\(/);
  assert.match(activityResult, /if\s*\(!sameOriginAtDelivery\)\s*result\s*=\s*null/);
  assert.match(finishFileChooser, /fileChooserState\.cancel\s*\(/);
});

test('下载仅经 DownloadManager；精确校验接口并先确认，不打开外部应用', () => {
  assert.match(java, /setDownloadListener\s*\(/);
  assert.ok(download, '找不到 handleDownloadStart');
  assert.match(download, /isWorkspaceContentUrl\s*\(\s*url\s*,\s*startUrl\s*\)/);
  assert.match(download, /new\s+AlertDialog\.Builder/);
  assert.match(java, /DownloadManager/);
  assert.match(download, /enqueueWorkspaceDownload/);
  assert.match(download, /sanitizeDownloadFileName/);
  assert.match(download, /uniqueDownloadFileName/);
  assert.doesNotMatch(download, /Intent\.ACTION_VIEW|startActivity\s*\(/);
  assert.ok(enqueueDownload, '找不到 DownloadManager 入队方法');
  assert.doesNotMatch(enqueueDownload, /Intent\.ACTION_VIEW|startActivity\s*\(/);
  assert.match(java, /getCookie\s*\(/);
  assert.match(java, /addRequestHeader\s*\(\s*"Cookie"/);
  assert.match(java, /setDestinationInExternalPublicDir\s*\(\s*Environment\.DIRECTORY_DOWNLOADS/);
  assert.match(rawJava, /HTTP[^\"]*(未加密|风险)/);
});

if (!hasPureHelpers) {
  console.log('\n纯 Java 探针未运行：安全 helper 尚不存在。');
} else {
  const outDir = path.join(ARTIFACTS, `android-security-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const methodSource = signatures.map(([name]) => methods[name]).join('\n\n');
  const probe = [
    'import java.net.URI;',
    'import java.io.File;',
    'import java.util.UUID;',
    'import java.util.Locale;',
    'import java.util.ArrayList;',
    '',
    'public final class AndroidSecurityProbe {',
    methodSource,
    '    private static final class ProbeCallback {',
    '        String result = "unset";',
    '        void onReceiveValue(String value) { result = value; }',
    '    }',
    '    private static String simulateChooserFlow(String topUrl, String configuredUrl) {',
    '        FileChooserState state = new FileChooserState();',
    '        ProbeCallback callbackA = new ProbeCallback();',
    '        ProbeCallback callbackB = new ProbeCallback();',
    '        String original = "http://app.test:24000/chat";',
    '        boolean acceptedA = state.begin(original);',
    '        if (!acceptedA) callbackA.onReceiveValue(null);',
    '        if (!state.begin(original)) callbackB.onReceiveValue(null);',
    '        boolean started = state.markPickerInFlight(original, original);',
    '        boolean mayDeliver = started && state.complete(topUrl, configuredUrl);',
    '        callbackA.onReceiveValue(mayDeliver ? "file-A" : null);',
    '        return "A:" + callbackA.result + "|B:" + callbackB.result;',
    '    }',
    '    private static String decode(String value) {',
    '        return "~".equals(value) ? null : new String(java.util.Base64.getDecoder().decode(value), java.nio.charset.StandardCharsets.UTF_8);',
    '    }',
    '    public static void main(String[] args) {',
    '        for (int i = 0; i < args.length; i += 3) {',
    '            String op = args[i];',
    '            String a = decode(args[i + 1]);',
    '            String b = decode(args[i + 2]);',
    '            String out;',
    '            if ("safe".equals(op)) out = String.valueOf(isSafeHttpUrl(a));',
    '            else if ("origin".equals(op)) out = String.valueOf(sameOrigin(a, b));',
    '            else if ("download".equals(op)) out = String.valueOf(isWorkspaceContentUrl(a, b));',
    '            else if ("name".equals(op)) out = sanitizeDownloadFileName(a);',
    '            else if ("unique".equals(op)) out = uniqueDownloadFileName(a, b == null ? null : new File(b));',
    '            else if ("mime".equals(op)) out = String.valueOf(matchesAcceptedMimeType(a, b));',
    '            else if ("uri".equals(op)) out = String.valueOf(isAllowedContentUri(a, b));',
    '            else if ("accept-mime".equals(op)) {',
    '                ArrayList<String> accepted = new ArrayList<>();',
    '                if (b != null) for (String item : b.split(",", -1)) accepted.add(item);',
    '                out = String.valueOf(acceptsFileMimeType(a, accepted));',
    '            }',
    '            else if ("flow".equals(op)) out = simulateChooserFlow(a, b);',
    '            else throw new IllegalArgumentException(op);',
    '            System.out.println(i / 3 + "\\t" + (out == null ? "N" : "V" + java.util.Base64.getEncoder().encodeToString(out.getBytes(java.nio.charset.StandardCharsets.UTF_8))));',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  const srcFile = path.join(outDir, 'AndroidSecurityProbe.java');
  fs.writeFileSync(srcFile, probe, 'utf8');

  // 下载目录样本：空目录、已有同名、已有同名且占用了 -2、无扩展名/隐藏文件混合目录
  const dlEmpty = path.join(outDir, 'dl-empty');
  const dlOne = path.join(outDir, 'dl-one');
  const dlTwo = path.join(outDir, 'dl-two');
  const dlMixed = path.join(outDir, 'dl-mixed');
  const dlMissing = path.join(outDir, 'dl-not-created');
  fs.mkdirSync(dlEmpty, { recursive: true });
  fs.mkdirSync(dlOne, { recursive: true });
  fs.mkdirSync(dlTwo, { recursive: true });
  fs.mkdirSync(dlMixed, { recursive: true });
  fs.writeFileSync(path.join(dlOne, 'photo.jpg'), 'x');
  fs.writeFileSync(path.join(dlTwo, 'photo.jpg'), 'x');
  fs.writeFileSync(path.join(dlTwo, 'photo-2.jpg'), 'x');
  fs.writeFileSync(path.join(dlMixed, 'README'), 'x');
  fs.writeFileSync(path.join(dlMixed, 'README.md'), 'x');
  fs.writeFileSync(path.join(dlMixed, '.env'), 'x');

  const cases = [
    ['safe', 'http://example.com/path', null, 'true'],
    ['safe', 'HTTPS://example.com:443/', null, 'true'],
    ['safe', 'ftp://example.com/', null, 'false'],
    ['safe', 'http://user:pw@example.com/', null, 'false'],
    ['safe', 'http://example.com:0/', null, 'false'],
    ['safe', 'file:///tmp/a', null, 'false'],
    ['origin', 'http://example.com/a', 'http://EXAMPLE.com:80/b', 'true'],
    ['origin', 'https://example.com/a', 'https://example.com:443/b', 'true'],
    ['origin', 'http://example.com/', 'https://example.com/', 'false'],
    ['origin', 'http://example.com:8080/', 'http://example.com:8081/', 'false'],
    ['origin', 'http://user@same.example/', 'http://same.example/', 'false'],
    ['origin', 'http://[::1]:24000/a', 'http://[::1]:24000/b', 'true'],
    ['download', 'http://host:24000/api/mobile/workspace/content?path=a', 'http://host:24000/', 'true'],
    ['download', 'http://host/api/mobile/workspace/content', 'http://host:80/', 'true'],
    ['download', 'http://host/api/mobile/workspace/content/', 'http://host/', 'false'],
    ['download', 'http://host/api/mobile/workspace/content-old', 'http://host/', 'false'],
    ['download', 'http://host:24001/api/mobile/workspace/content', 'http://host:24000/', 'false'],
    ['download', 'https://host/api/mobile/workspace/content', 'http://host/', 'false'],
    ['download', 'http://host/api/mobile/workspace%2fcontent', 'http://host/', 'false'],
    ['download', 'http://host/api/mobile/workspace/content#fragment', 'http://host/', 'false'],
    ['download', 'http://user@host/api/mobile/workspace/content', 'http://host/', 'false'],
    ['download', 'file:///api/mobile/workspace/content', 'http://host/', 'false'],
    ['name', 'C:\\Users\\alice\\photo.jpg', null, 'photo.jpg'],
    ['name', '/../../secret.txt', null, 'secret.txt'],
    // 先取 basename 再清洗：只剩 passwd，没有分隔符也没有 ..，所以清洗通过而不是 null
    ['name', '../../etc/passwd', null, 'passwd'],
    ['name', '..', null, null],
    ['name', '   ', null, null],
    ['name', 'bad\r\nname.txt', null, 'badname.txt'],
    ['name', null, null, null],
    ['unique', 'photo.jpg', dlEmpty, 'photo.jpg'],
    ['unique', 'photo.jpg', dlOne, 'photo-2.jpg'],
    ['unique', 'photo.jpg', dlTwo, 'photo-3.jpg'],
    ['unique', 'photo.jpg', '~', 'photo.jpg'],
    ['unique', '.profile', '~', '.profile'],
    // 路径片段在清洗阶段就被截成 basename：落盘的是 passwd，不是 null；
    // 目录里真有一个 passwd 时同样按 -2 规则让位，这里目录为 null 所以保持原名
    ['unique', '../../etc/passwd', '~', 'passwd'],
    ['unique', '../../etc/passwd', dlOne, 'passwd'],
    // 无扩展名：dot 为 -1，不能让 substring 抛异常，也不能把扩展名当后缀拼
    ['unique', 'README', dlMixed, 'README-2'],
    ['unique', 'README', dlEmpty, 'README'],
    // 有扩展名：序号插在扩展名之前，而不是追加到末尾
    ['unique', 'README.md', dlMixed, 'README-2.md'],
    ['unique', 'README.md', dlEmpty, 'README.md'],
    // 隐藏文件：dot 落在 0，必须当作无扩展名处理，否则会变成 -2.env
    ['unique', '.env', dlMixed, '.env-2'],
    ['unique', '.env', dlEmpty, '.env'],
    // 目录不存在时退化成原名，交给 DownloadManager 自己处理重名
    ['unique', 'photo.jpg', dlMissing, 'photo.jpg'],
    // 超长名：清洗把名字压到 180 字节，留出的余量足够再加 -2（182）或 8 位随机（189），都不会撞 255 字节上限
    ['unique', 'a'.repeat(200) + '.docx', dlEmpty, 'a'.repeat(175) + '.docx'],
    ['mime', 'image/jpeg', 'image/*', 'true'],
    ['mime', 'image/jpeg', 'image/jpeg', 'true'],
    ['mime', 'application/pdf', 'image/*', 'false'],
    ['mime', 'application/pdf', '*/*', 'true'],
    ['mime', 'image/jpeg; charset=utf-8', 'image/*', 'true'],
    ['mime', null, 'image/*', 'false'],
    ['accept-mime', null, '*/*', 'true'],
    ['accept-mime', null, 'image/*', 'false'],
    ['accept-mime', 'image/jpeg', 'image/*', 'true'],
    ['accept-mime', 'application/pdf', 'image/*', 'false'],
    ['uri', 'content', 'provider.example', 'true'],
    ['uri', 'content', null, 'false'],
    ['uri', 'http', 'provider.example', 'false'],
    ['uri', 'https', 'provider.example', 'false'],
    ['uri', 'file', '', 'false'],
    ['uri', 'data', '', 'false'],
    ['uri', 'javascript', '', 'false'],
    ['flow', 'http://app.test:24000/chat', 'http://app.test:24000/', 'A:file-A|B:null'],
    ['flow', 'http://evil.test/', 'http://app.test:24000/', 'A:null|B:null'],
    ['flow', 'http://app.test:24000/chat', 'http://evil.test/', 'A:null|B:null'],
  ];

  try {
    execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', outDir, srcFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    const enc = (value) => value === null ? '~' : Buffer.from(value, 'utf8').toString('base64');
    const args = cases.flatMap(([op, a, b]) => [op, enc(a), enc(b)]);
    const stdout = execFileSync('java', ['-cp', outDir, 'AndroidSecurityProbe', ...args], {
      encoding: 'utf8',
      timeout: 120000,
    });
    const got = new Map(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [index, payload] = line.split('\t');
      return [Number(index), payload === 'N' ? null : Buffer.from(payload.slice(1), 'base64').toString('utf8')];
    }));
    for (let i = 0; i < cases.length; i += 1) {
      const [op, a, b, expected] = cases[i];
      test(`JVM ${op}: ${JSON.stringify(a)}`, () => {
        assert.equal(got.get(i), expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got.get(i))}`);
      });
    }
    console.log(`JVM 探针产物保留在：${outDir}`);
  } catch (err) {
    failures += 1;
    const detail = String(err.stderr || err.stdout || err.message || err);
    console.log(`FAIL  javac/java 安全探针\n      ${detail.split('\n').slice(0, 16).join('\n      ')}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
