/* A2 回归：Activity 销毁时必须释放 WebView、原生对话框与等待中的文件选择回调。
 *
 * 抽取 MainActivity.java 真实的 onDestroy / resetNativeBridge / closeBridgePort /
 * finishFileChooser / filterAcceptedFiles / FileChooserState 等方法，放进 JVM 上的
 * 轻量 Android 边界替身（AlertDialog、WebView、ViewGroup、Handler、WebMessagePort），
 * 观察真实方法产生的副作用，而不是 grep 方法名。
 * 临时源码与 class 保留在 tests/artifacts/audit-android-a2-*。
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const JAVA_SRC = fileURLToPath(new URL('../android/src/com/hanamobile/app/MainActivity.java', import.meta.url));
const ARTIFACTS = fileURLToPath(new URL('./artifacts/', import.meta.url));

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

const java = stripComments(fs.readFileSync(JAVA_SRC, 'utf8'));
const signatures = [
  ['onDestroy', 'protected void onDestroy()'],
  ['resetNativeBridge', 'private void resetNativeBridge()'],
  ['closeBridgePort', 'private void closeBridgePort()'],
  ['finishFileChooser', 'private void finishFileChooser(Uri[] result)'],
  ['filterAcceptedFiles', 'private Uri[] filterAcceptedFiles(Uri[] result, ArrayList<String> acceptedTypes)'],
  ['FileChooserState', 'static final class FileChooserState'],
  ['isAllowedContentUri', 'static boolean isAllowedContentUri(String scheme, String authority)'],
  ['acceptsFileMimeType', 'static boolean acceptsFileMimeType(String actualMimeType, ArrayList<String> acceptedTypes)'],
  ['matchesAcceptedMimeType', 'static boolean matchesAcceptedMimeType(String actualMimeType, String acceptedType)'],
  ['isSafeHttpUrl', 'static boolean isSafeHttpUrl(String raw)'],
  ['sameOrigin', 'static boolean sameOrigin(String candidate, String configuredUrl)'],
];
const methods = Object.fromEntries(signatures.map(([name, signature]) => [name, extractMethod(java, signature)]));
const missing = signatures.filter(([name]) => !methods[name]).map(([name]) => name);
if (missing.length > 0) {
  console.log(`FAIL  A2 缺少可抽取的方法：${missing.join(', ')}`);
  process.exit(1);
}

const outDir = path.join(ARTIFACTS, `audit-android-a2-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(outDir, { recursive: true });

const stubs = {
  'android/content/Context.java': `package android.content;
public class Context {
    public ContentResolver getContentResolver() { return null; }
}
`,
  'android/content/ContentResolver.java': `package android.content;
public class ContentResolver {
    public String getType(android.net.Uri uri) { return null; }
}
`,
  'android/app/Activity.java': `package android.app;
public class Activity extends android.content.Context {
    protected void onDestroy() {}
}
`,
  'android/app/AlertDialog.java': `package android.app;
public class AlertDialog {
    public boolean showing;
    public int dismissCalls;
    public boolean isShowing() { return showing; }
    public void dismiss() { dismissCalls += 1; showing = false; }
}
`,
  'android/net/Uri.java': `package android.net;
public class Uri {
    public String getScheme() { return null; }
    public String getAuthority() { return null; }
}
`,
  'android/os/Handler.java': `package android.os;
public class Handler {
    public boolean callbacksCleared;
    public void removeCallbacksAndMessages(Object token) { callbacksCleared = true; }
}
`,
  'android/view/ViewParent.java': `package android.view;
public interface ViewParent {}
`,
  'android/view/View.java': `package android.view;
public class View {
    private ViewParent parent;
    public ViewParent getParent() { return parent; }
    public void setParent(ViewParent value) { parent = value; }
}
`,
  'android/view/ViewGroup.java': `package android.view;
public class ViewGroup extends View implements ViewParent {
    public View removed;
    public int removeCalls;
    public void removeView(View view) { removeCalls += 1; removed = view; }
}
`,
  'android/webkit/WebView.java': `package android.webkit;
public class WebView extends android.view.View {
    public boolean stopped;
    public boolean destroyed;
    public void stopLoading() { stopped = true; }
    public void destroy() { destroyed = true; }
}
`,
  'android/webkit/WebMessagePort.java': `package android.webkit;
public interface WebMessagePort {
    void close();
}
`,
  'android/webkit/ValueCallback.java': `package android.webkit;
public interface ValueCallback<T> {
    void onReceiveValue(T value);
}
`,
  'android/widget/Toast.java': `package android.widget;
public class Toast {
    public static final int LENGTH_LONG = 1;
    public static Toast makeText(android.content.Context context, CharSequence text, int duration) {
        return new Toast();
    }
    public void show() {}
}
`,
};
const stubFiles = [];
for (const [rel, source] of Object.entries(stubs)) {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
  stubFiles.push(file);
}

const fields = [
  '    private WebView web;',
  '    private AlertDialog urlDialog;',
  '    private AlertDialog foreignPageDialog;',
  '    private AlertDialog fileChoiceDialog;',
  '    private ValueCallback<Uri[]> fileCallback;',
  '    private final FileChooserState fileChooserState = new FileChooserState();',
  '    private ArrayList<String> pendingAcceptTypes;',
  '    private Uri cameraUri;',
  '    private WebMessagePort bridgePort;',
  '    private WebMessagePort permissionPort;',
  '    private String permissionRequestId;',
  '    private boolean bridgeAcked;',
  '    private int bridgeRound;',
  '    private Handler bridgeHandler;',
].join('\n');

const probe = [
  'import android.app.Activity;',
  'import android.app.AlertDialog;',
  'import android.net.Uri;',
  'import android.os.Handler;',
  'import android.webkit.ValueCallback;',
  'import android.webkit.WebMessagePort;',
  'import android.webkit.WebView;',
  'import android.view.ViewGroup;',
  'import android.view.ViewParent;',
  'import android.widget.Toast;',
  'import java.net.URI;',
  'import java.util.ArrayList;',
  'import java.util.Locale;',
  '',
  'public final class AndroidDestroyProbe extends Activity {',
  fields,
  '',
  ...signatures.map(([name]) => methods[name]),
  '',
  '    static final class ProbePort implements WebMessagePort {',
  '        int closeCalls;',
  '        public void close() { closeCalls += 1; }',
  '    }',
  '',
  '    static final class ProbeCallback implements ValueCallback<Uri[]> {',
  '        int calls;',
  '        Uri[] value;',
  '        public void onReceiveValue(Uri[] result) { calls += 1; value = result; }',
  '    }',
  '',
  '    void destroy() { onDestroy(); }',
  '',
  '    private static String lifecycle() {',
  '        AndroidDestroyProbe p = new AndroidDestroyProbe();',
  '        AlertDialog url = new AlertDialog();',
  '        AlertDialog foreign = new AlertDialog();',
  '        AlertDialog choice = new AlertDialog();',
  '        url.showing = true;',
  '        foreign.showing = true;',
  '        choice.showing = true;',
  '        p.urlDialog = url;',
  '        p.foreignPageDialog = foreign;',
  '        p.fileChoiceDialog = choice;',
  '        ProbePort bridge = new ProbePort();',
  '        ProbePort permission = new ProbePort();',
  '        p.bridgePort = bridge;',
  '        p.permissionPort = permission;',
  '        p.permissionRequestId = "req-1";',
  '        p.bridgeAcked = true;',
  '        p.bridgeRound = 7;',
  '        Handler handler = new Handler();',
  '        p.bridgeHandler = handler;',
  '        WebView view = new WebView();',
  '        ViewGroup container = new ViewGroup();',
  '        view.setParent(container);',
  '        p.web = view;',
  '        ProbeCallback callback = new ProbeCallback();',
  '        p.fileCallback = callback;',
  '        p.pendingAcceptTypes = new ArrayList<>();',
  '        p.pendingAcceptTypes.add("image/*");',
  '        p.cameraUri = new Uri();',
  '        boolean busyBefore = p.fileChooserState.begin("http://app.test:24000/")',
  '                && p.fileChooserState.markPickerInFlight(',
  '                        "http://app.test:24000/chat", "http://app.test:24000/");',
  '        p.destroy();',
  '        return "busyBefore=" + busyBefore',
  '                + ";urlDismiss=" + url.dismissCalls',
  '                + ";foreignDismiss=" + foreign.dismissCalls',
  '                + ";choiceDismiss=" + choice.dismissCalls',
  '                + ";urlNull=" + (p.urlDialog == null)',
  '                + ";foreignNull=" + (p.foreignPageDialog == null)',
  '                + ";choiceNull=" + (p.fileChoiceDialog == null)',
  '                + ";webStopped=" + view.stopped',
  '                + ";webRemoveCalls=" + container.removeCalls',
  '                + ";webDestroyed=" + view.destroyed',
  '                + ";webNull=" + (p.web == null)',
  '                + ";bridgeCloseCalls=" + bridge.closeCalls',
  '                + ";bridgeNull=" + (p.bridgePort == null)',
  '                + ";permissionNull=" + (p.permissionPort == null)',
  '                + ";requestIdNull=" + (p.permissionRequestId == null)',
  '                + ";acked=" + p.bridgeAcked',
  '                + ";round=" + p.bridgeRound',
  '                + ";handlerCleared=" + handler.callbacksCleared',
  '                + ";handlerNull=" + (p.bridgeHandler == null)',
  '                + ";callbackCalls=" + callback.calls',
  '                + ";callbackNullValue=" + (callback.value == null)',
  '                + ";fileCallbackNull=" + (p.fileCallback == null)',
  '                + ";pendingNull=" + (p.pendingAcceptTypes == null)',
  '                + ";cameraNull=" + (p.cameraUri == null)',
  '                + ";busyAfter=" + p.fileChooserState.isBusy();',
  '    }',
  '',
  '    private static String nullWeb() {',
  '        AndroidDestroyProbe p = new AndroidDestroyProbe();',
  '        AlertDialog idle = new AlertDialog();',
  '        idle.showing = false;',
  '        p.urlDialog = idle;',
  '        Handler handler = new Handler();',
  '        p.bridgeHandler = handler;',
  '        try {',
  '            p.destroy();',
  '            p.destroy();',
  '            return "noThrow=true;idleDismiss=" + idle.dismissCalls',
  '                    + ";handlerCleared=" + handler.callbacksCleared',
  '                    + ";secondDestroy=true";',
  '        } catch (Throwable t) {',
  '            return "noThrow=false;error=" + t.getClass().getName() + ": " + t.getMessage();',
  '        }',
  '    }',
  '',
  '    public static void main(String[] args) {',
  '        System.out.println("LIFE|" + lifecycle());',
  '        System.out.println("NULL|" + nullWeb());',
  '    }',
  '}',
  '',
].join('\n');

const srcFile = path.join(outDir, 'AndroidDestroyProbe.java');
fs.writeFileSync(srcFile, probe, 'utf8');

let lines = new Map();
try {
  execFileSync('javac', ['--release', '17', '-encoding', 'UTF-8', '-d', outDir, srcFile, ...stubFiles], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const stdout = execFileSync('java', ['-cp', outDir, 'AndroidDestroyProbe'], {
    encoding: 'utf8',
    timeout: 120000,
  });
  lines = new Map(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, payload] = line.split('|');
    const values = Object.fromEntries(payload.split(';').map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }));
    return [name, values];
  }));
  console.log(`JVM 探针产物保留在：${outDir}`);
} catch (err) {
  failures += 1;
  const detail = String(err.stderr || err.stdout || err.message || err);
  console.log(`FAIL  javac/java 销毁探针\n      ${detail.split('\n').slice(0, 20).join('\n      ')}`);
}

const life = lines.get('LIFE');
const nulls = lines.get('NULL');

test('A2 销毁后三类对话框已 dismiss 并解除引用', () => {
  assert.ok(life, '缺少 LIFE 结果');
  assert.equal(life.urlDismiss, '1');
  assert.equal(life.foreignDismiss, '1');
  assert.equal(life.choiceDismiss, '1');
  assert.equal(life.urlNull, 'true');
  assert.equal(life.foreignNull, 'true');
  assert.equal(life.choiceNull, 'true');
});

test('A2 销毁后 WebView 已停止、从父容器移除、销毁并置空', () => {
  assert.ok(life, '缺少 LIFE 结果');
  assert.equal(life.webStopped, 'true');
  assert.equal(life.webRemoveCalls, '1');
  assert.equal(life.webDestroyed, 'true');
  assert.equal(life.webNull, 'true');
});

test('A2 销毁后文件选择回调收到 null 且状态清理', () => {
  assert.ok(life, '缺少 LIFE 结果');
  assert.equal(life.busyBefore, 'true');
  assert.equal(life.callbackCalls, '1');
  assert.equal(life.callbackNullValue, 'true');
  assert.equal(life.fileCallbackNull, 'true');
  assert.equal(life.pendingNull, 'true');
  assert.equal(life.cameraNull, 'true');
  assert.equal(life.busyAfter, 'false');
});

test('A2 销毁后 native bridge 与 handler 已清理', () => {
  assert.ok(life, '缺少 LIFE 结果');
  assert.equal(life.bridgeCloseCalls, '1');
  assert.equal(life.bridgeNull, 'true');
  assert.equal(life.permissionNull, 'true');
  assert.equal(life.requestIdNull, 'true');
  assert.equal(life.acked, 'false');
  assert.equal(life.round, '8');
  assert.equal(life.handlerCleared, 'true');
  assert.equal(life.handlerNull, 'true');
});

test('A2 web=null 时销毁不抛异常（可重复销毁）', () => {
  assert.ok(nulls, '缺少 NULL 结果');
  assert.equal(nulls.noThrow, 'true', nulls.error || '');
  assert.equal(nulls.idleDismiss, '0');
  assert.equal(nulls.handlerCleared, 'true');
  assert.equal(nulls.secondDestroy, 'true');
});

if (failures > 0) {
  console.log(`\n${failures} TESTS FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
