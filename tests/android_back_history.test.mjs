/* 原生返回键的「可回退历史」契约 —— 真方法行为测试，不是正则检查
 *
 * 背景（已证代码路径，不是猜的根因）：
 *   - renderSetupPage() 用 loadDataWithBaseURL(null, html, ...) 把错误页塞进同一个 WebView，
 *     历史可能包含设置页或空白记录；真实形态留待设备复验；
 *   - startWithUrl() 换地址时直接 loadUrl()，不清历史，旧接入地址的记录也留着；
 *   - 于是 web.canGoBack() 可能为 true，但「上一条」是 about:blank / data: / 旧端口 / 别人的页面。
 *     原来 leaveOrFinish() 直接信 canGoBack()，返回键就会退到那种页面上去。
 *
 * 本轮把 canGoBack 收紧成 canGoBackWithinOrigin()：只有当前配置 startUrl 同源的
 * 有效 HTTP(S) 上一条历史才算「有得退」。backAction() 的决策表和优先级一个字不动。
 *
 * 做法：把 MainActivity.java 里的真实方法原文抽出来，和三个 android.webkit 假类一起
 * 编到裸 JVM 上跑。不碰设备、不连网、不调 Android API。
 * 产物只写 tests/artifacts/android-back-history/run-<唯一目录>/，不清理。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// 默认就读仓库里那份源码；环境变量只给「旧版红证据」用（见 artifacts/red-evidence），正常跑不设它。
const javaPath = process.env.HANA_MAINACTIVITY_SRC
  ? path.resolve(process.env.HANA_MAINACTIVITY_SRC)
  : path.join(repo, 'android', 'src', 'com', 'hanamobile', 'app', 'MainActivity.java');
const artifactRoot = path.join(repo, 'tests', 'artifacts', 'android-back-history');

const javaSrc = fs.readFileSync(javaPath, 'utf8');

/** 从 `签名` 起按大括号配对切出整个方法体（与 android_shell.test.mjs 同一套做法）。 */
function method(code, signature) {
  const at = code.indexOf(signature);
  if (at < 0) return null;
  const braceAt = code.indexOf('{', at);
  if (braceAt < 0) return null;
  let depth = 0;
  for (let i = braceAt; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(at, i + 1);
    }
  }
  return null;
}

const SIG = {
  sameOrigin: 'static boolean sameOrigin(String candidate, String configuredUrl)',
  safeUrl: 'static boolean isSafeHttpUrl(String raw)',
  withinOrigin: 'private boolean canGoBackWithinOrigin()',
  backAction: 'static String backAction(',
  leaveOrFinish: 'private void leaveOrFinish(boolean webHandled)',
};

const picked = Object.fromEntries(Object.entries(SIG).map(([k, sig]) => [k, method(javaSrc, sig)]));

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. 结构前提：方法确实存在，且收紧点只有一个                          */
/* ------------------------------------------------------------------ */

t('leaveOrFinish 用 canGoBackWithinOrigin() 取代裸 web.canGoBack()', () => {
  assert.ok(picked.leaveOrFinish, '找不到 leaveOrFinish(boolean webHandled)');
  assert.ok(picked.withinOrigin, '找不到 canGoBackWithinOrigin()：本轮收紧还没落地');
  assert.match(picked.leaveOrFinish, /backAction\(webHandled, errorPageShown,/, 'backAction 调用形状不能变');
  assert.match(picked.leaveOrFinish, /canGoBackWithinOrigin\(\)/, 'leaveOrFinish 必须把收紧后的结果传给 backAction');
  assert.doesNotMatch(picked.leaveOrFinish, /web\.canGoBack\(\)/, 'leaveOrFinish 里不能再直接信 web.canGoBack()');
});

t('canGoBackWithinOrigin 只用 canGoBack + 上一条 item + sameOrigin', () => {
  const m = picked.withinOrigin;
  assert.match(m, /web\.canGoBack\(\)/, 'canGoBack() 仍要当粗筛');
  assert.match(m, /copyBackForwardList\(\)/, '要读回退历史列表');
  assert.match(m, /getCurrentIndex\(\)/, '要判当前索引 > 0');
  assert.match(m, /getItemAtIndex\(/, '要取上一条 item');
  assert.match(m, /sameOrigin\s*\(\s*previous\.getUrl\(\)\s*,\s*startUrl\s*\)/, '判定必须复用 sameOrigin(previous, startUrl)');
  assert.doesNotMatch(m, /new URI\(/, '不得另写一套 URL 规则：同源判定只走 sameOrigin/isSafeHttpUrl');
  assert.doesNotMatch(m, /http:\/\/|https:\/\//, '不得把地址写死在方法里');
});

t('backAction 决策表与优先级未变', () => {
  const table = picked.backAction;
  assert.ok(table, '找不到 backAction(');
  const body = table.slice(table.indexOf('{') + 1);
  const order = ['webHandled', 'errorPageShown', 'canGoBack', 'pageIsHana', 'BACK_ASK']
    .map((k) => body.indexOf(k));
  assert.ok(order.every((v) => v >= 0), 'backAction 里少了分支');
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], '决策表顺序被改动了：' + order.join(','));
  }
  assert.match(table, /if\s*\(Boolean\.TRUE\.equals\(pageIsHana\)\)\s*return BACK_FINISH;/, 'true 才直接退出');
  assert.match(table, /return BACK_ASK;/, '兜底仍是询问');
});

/* ------------------------------------------------------------------ */
/* 2. 真行为：把真方法编到裸 JVM 上跑                                   */
/* ------------------------------------------------------------------ */

const STUB_WEBVIEW = `package android.webkit;

import java.util.ArrayList;
import java.util.List;

/** 夹具用的假 WebView：只保留壳真正用到的那几个方法。 */
public class WebView {
    private boolean canGoBack;
    private WebBackForwardList history;
    public final List<String> calls = new ArrayList<String>();

    public void fixtureSetCanGoBack(boolean value) { this.canGoBack = value; }
    public void fixtureSetHistory(WebBackForwardList value) { this.history = value; }

    public boolean canGoBack() { return canGoBack; }
    public WebBackForwardList copyBackForwardList() { return history; }
    public void goBack() { calls.add("goBack"); }
}
`;

const STUB_LIST = `package android.webkit;

/** 夹具用的假历史列表。 */
public class WebBackForwardList {
    private final int currentIndex;
    private final WebHistoryItem[] items;

    public WebBackForwardList(int currentIndex, WebHistoryItem[] items) {
        this.currentIndex = currentIndex;
        this.items = items;
    }

    public int getCurrentIndex() { return currentIndex; }

    public WebHistoryItem getItemAtIndex(int index) {
        if (index < 0 || items == null || index >= items.length) return null;
        return items[index];
    }
}
`;

const STUB_ITEM = `package android.webkit;

/** 夹具用的假历史条目；url 允许为 null，用来模拟取不到地址的情况。 */
public class WebHistoryItem {
    private final String url;
    public WebHistoryItem(String url) { this.url = url; }
    public String getUrl() { return url; }
}
`;

function buildFixture() {
  // 四个方法是行为夹具的必需件；canGoBackWithinOrigin() 是本次收紧的产物：
  // 旧源码里没有它也能编译（旧 leaveOrFinish 直接信 canGoBack），
  // 那时夹具会跑出真行为红（about:blank 等用例会退回到错误页）。
  const required = {
    safeUrl: picked.safeUrl,
    sameOrigin: picked.sameOrigin,
    backAction: picked.backAction,
    leaveOrFinish: picked.leaveOrFinish,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { source: null, missing, tightened: Boolean(picked.withinOrigin) };

  return {
    missing: [],
    tightened: Boolean(picked.withinOrigin),
    source: `import android.webkit.WebBackForwardList;
import android.webkit.WebHistoryItem;
import android.webkit.WebView;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * 由 tests/android_back_history.test.mjs 生成：方法原文抽自 MainActivity.java，
 * 其余是夹具（假 WebView/历史 + 调用记录）。不是产品代码。
 */
public class BackHistoryFixture {

    private static final String BACK_NONE = "none";
    private static final String BACK_GO_BACK = "go_back";
    private static final String BACK_FINISH = "finish";
    private static final String BACK_ASK = "ask";

    private WebView web;
    private String startUrl;
    private boolean errorPageShown;
    private Boolean pageIsHana;
    private final List<String> calls = new ArrayList<String>();

    /* ---------------- 以下为用户代码原文（MainActivity.java） ---------------- */

${picked.safeUrl}

${picked.sameOrigin}

${picked.withinOrigin || ''}

${picked.backAction}

${picked.leaveOrFinish}

    /* ---------------- 以下是夹具 ---------------- */

    private void finish() { calls.add("finish"); }

    private void promptForForeignPage() { calls.add("ask"); }

    private static String join(List<String> parts) {
        if (parts.isEmpty()) return "[]";
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < parts.size(); i += 1) {
            if (i > 0) b.append(", ");
            b.append(parts.get(i));
        }
        return b.append("]").toString();
    }

    /**
     * @param items 历史条目；null 数组 = 无历史快照，null 元素 = item 的 url 为 null
     */
    private static String run(String name, boolean canGoBack, int currentIndex, String[] items,
                              String startUrl, Boolean pageIsHana, boolean errorPageShown,
                              boolean webHandled, List<String> expected) {
        BackHistoryFixture f = new BackHistoryFixture();
        f.web = new WebView();
        f.web.fixtureSetCanGoBack(canGoBack);
        if (items != null) {
            WebHistoryItem[] arr = new WebHistoryItem[items.length];
            for (int i = 0; i < items.length; i += 1) {
                arr[i] = new WebHistoryItem(items[i]);
            }
            f.web.fixtureSetHistory(new WebBackForwardList(currentIndex, arr));
        }
        f.startUrl = startUrl;
        f.pageIsHana = pageIsHana;
        f.errorPageShown = errorPageShown;

        f.leaveOrFinish(webHandled);

        List<String> actual = new ArrayList<String>(f.calls);
        actual.addAll(f.web.calls);
        if (!actual.equals(expected)) {
            return "FAIL  " + name + "  expected=" + join(expected) + " actual=" + join(actual);
        }
        return "PASS  " + name;
    }

    public static void main(String[] args) {
        String home = "http://127.0.0.1:24000/";
        List<String> results = new ArrayList<String>();

        // —— 没有可退历史 ——
        results.add(run("canGoBack=false → 退出", false, 0,
                new String[]{home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("canGoBack=true 但索引为 0 → 退出", true, 0,
                new String[]{home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("历史快照为空 → 退出", true, 1,
                null, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条 item 取不到 → 退出", true, 2,
                new String[]{home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条 url 为 null → 退出", true, 1,
                new String[]{null, home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条是 about:blank 历史 → 退出", true, 1,
                new String[]{"about:blank", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条是 data: → 退出", true, 1,
                new String[]{"data:text/html,hi", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条是 file: → 退出", true, 1,
                new String[]{"file:///sdcard/x.html", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条异源（别的域名）→ 退出", true, 1,
                new String[]{"http://evil.example/x", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条旧端口（23917）→ 退出", true, 1,
                new String[]{"http://127.0.0.1:23917/", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("上一条带 userinfo → 退出", true, 1,
                new String[]{"http://u:p@127.0.0.1:24000/", home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("startUrl 缺失 → 退出", true, 1,
                new String[]{home, home}, null, Boolean.TRUE, false, false, Arrays.asList("finish")));

        // —— 同源合法历史仍然照退 ——
        results.add(run("同源合法上一条 → goBack", true, 1,
                new String[]{"http://127.0.0.1:24000/index.html", home}, home, Boolean.TRUE, false, false, Arrays.asList("goBack")));
        results.add(run("同源带查询串 → goBack", true, 1,
                new String[]{"http://127.0.0.1:24000/app.js?v=1", home}, home, Boolean.TRUE, false, false, Arrays.asList("goBack")));
        results.add(run("同源但更早一条才是垃圾，只看上一条 → goBack", true, 2,
                new String[]{"about:blank", "http://127.0.0.1:24000/a", home}, home, Boolean.TRUE, false, false, Arrays.asList("goBack")));

        // —— 既有优先级不变 ——
        results.add(run("网页已处理 → 什么都不做（同源历史也不退）", true, 1,
                new String[]{"http://127.0.0.1:24000/index.html", home}, home, Boolean.TRUE, false, true, Arrays.asList()));
        results.add(run("错误页优先于同源历史 → 退出", true, 1,
                new String[]{"http://127.0.0.1:24000/index.html", home}, home, Boolean.TRUE, true, false, Arrays.asList("finish")));
        results.add(run("Hana 页面、无历史 → 退出（保持原行为）", false, 0,
                new String[]{home}, home, Boolean.TRUE, false, false, Arrays.asList("finish")));
        results.add(run("非 Hana 页面、无历史 → 询问", false, 0,
                new String[]{"about:blank"}, home, Boolean.FALSE, false, false, Arrays.asList("ask")));
        results.add(run("未知页面（null）、无历史 → 询问", false, 0,
                new String[]{"about:blank"}, home, null, false, false, Arrays.asList("ask")));

        int failed = 0;
        for (String line : results) {
            System.out.println(line);
            if (line.startsWith("FAIL")) failed += 1;
        }
        System.out.println(failed == 0 ? "ALL PASS (" + results.size() + ")" : failed + " CASES FAILED");
        if (failed != 0) System.exit(1);
    }
}
`,
  };
}

t('真方法在裸 JVM 上的行为（canGoBackWithinOrigin/leaveOrFinish/backAction）', () => {
  const fixture = buildFixture();
  assert.deepEqual(fixture.missing, [], '缺少方法原文：' + fixture.missing.join(', '));
  if (!fixture.tightened) {
    console.log('      注意：源码里没有 canGoBackWithinOrigin()，本次跑的是旧行为');
  }

  fs.mkdirSync(artifactRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(artifactRoot, 'run-'));
  const stubDir = path.join(runDir, 'stub');
  const srcDir = path.join(runDir, 'src');
  const classDir = path.join(runDir, 'classes');
  fs.mkdirSync(path.join(stubDir, 'android', 'webkit'), { recursive: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(classDir, { recursive: true });

  const files = [
    path.join(stubDir, 'android', 'webkit', 'WebView.java'),
    path.join(stubDir, 'android', 'webkit', 'WebBackForwardList.java'),
    path.join(stubDir, 'android', 'webkit', 'WebHistoryItem.java'),
    path.join(srcDir, 'BackHistoryFixture.java'),
  ];
  fs.writeFileSync(files[0], STUB_WEBVIEW, 'utf8');
  fs.writeFileSync(files[1], STUB_LIST, 'utf8');
  fs.writeFileSync(files[2], STUB_ITEM, 'utf8');
  fs.writeFileSync(files[3], fixture.source, 'utf8');

  const javac = spawnSync('javac', ['-J-Duser.language=en', '-J-Duser.country=US', '-encoding', 'UTF-8', '-nowarn', '-d', classDir, ...files], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(javac.status, 0, `javac 失败：\n${javac.stdout || ''}${javac.stderr || ''}`);

  const java = spawnSync('java', ['-cp', classDir, 'BackHistoryFixture'], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  const out = `${java.stdout || ''}${java.stderr || ''}`.trim();
  console.log(out.split('\n').map((l) => '      ' + l).join('\n'));
  const failed = out.split('\n').filter((l) => l.startsWith('FAIL'));
  assert.equal(java.status, 0, `夹具用例失败：\n${failed.join('\n') || out}`);
  assert.equal(failed.length, 0, `夹具用例失败：\n${failed.join('\n')}`);
  assert.match(out, /ALL PASS \(20\)/, '必须跑满现有 20 个行为用例');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED (artifacts: ${artifactRoot})`);
  process.exit(1);
} else {
  console.log(`\nALL PASS (artifacts: ${artifactRoot})`);
}
