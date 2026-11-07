/* Android 壳的安全与返回键契约（静态检查）
 *
 * 这里断言的是「结构」而不是行为，因为真机上的 WebView/JavascriptInterface 行为
 * 没法在无设备环境复现。三件事必须钉死：
 *
 * 1. 壳里不再有任何注入给网页的 JS 特权桥 —— 之前 addJavascriptInterface 对
 *    所有 frame 生效（包括卡片 iframe），任何卡片都能持久篡改开始地址；
 * 2. 改地址走原生 AlertDialog（现在是「接入方式」：三个预设 + 自定义，各自记忆地址、
 *    各带一个「测试」按钮），且必须能取消、必须做基本校验；地址只能从这个对话框写进去；
 * 3. 返回键必须先问网页，网页不肯退时再退历史；历史也没了就靠页面标记
 *    （<meta name="hana-shell">）分三态：true 退出，false / null 只给可取消的对话框；
 *    targetSdk 36 在 Android 16 上不再派发 KEYCODE_BACK，所以还得注册
 *    OnBackInvokedCallback，否则新机型上返回键直接失效；
 * 4. 下载文件名优先取 URL 的 name 参数，其余同源白名单与确认流程不变；
 * 5. 日志里只出现 scheme://host[:port] 和路径标志，完整地址（可能带 token）不进 logcat；
 * 6. 归一化阶段就拒绝 :0（它与 isSafeHttpUrl 不一致），默认接入方式是「本机 / USB」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 去掉 // 与 注释块，避免注释里的字样干扰「代码里不许出现」这类断言。 */
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

const rawJava = read('../android/src/com/hanamobile/app/MainActivity.java');
const rawApp = read('../web/app.js');
const java = stripComments(rawJava);
const app = stripComments(rawApp);

/** 从 `签名` 起按大括号配对切出整个方法体，用来只在一个方法里做断言。 */
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
/* 1. 桥必须彻底消失                                                    */
/* ------------------------------------------------------------------ */

t('壳里没有任何 JS 桥注入', () => {
  assert.ok(!/addJavascriptInterface\s*\(/.test(java), 'MainActivity 不得再调用 addJavascriptInterface');
  assert.ok(!/@JavascriptInterface/.test(java), 'MainActivity 不得再声明 @JavascriptInterface 方法');
  assert.ok(!/"HanaBridge"/.test(java), 'MainActivity 不得再注册名为 HanaBridge 的接口');
});

t('网页侧不再依赖那个桥', () => {
  assert.ok(!/HanaBridge/.test(app), 'web/app.js 不得再引用 HanaBridge');
});

t('不再加载依赖桥的设置页', () => {
  assert.ok(!/setup\.html/.test(java), '连不上时应走原生对话框与原生错误页，不再加载 assets/setup.html');
  assert.ok(!/showSetup\s*\(/.test(java), '旧的 showSetup() 应已移除');
});

/* ------------------------------------------------------------------ */
/* 2. 原生改地址对话框                                                  */
/* ------------------------------------------------------------------ */

t('改地址走原生 AlertDialog + 输入框', () => {
  assert.ok(/new\s+AlertDialog\.Builder/.test(java), '应使用原生 AlertDialog 设置地址');
  assert.ok(/new\s+EditText\s*\(/.test(java), '对话框里应有 EditText 输入地址');
  assert.ok(/setInputType\s*\(/.test(java), '输入框应设置 URI 键盘类型');
  assert.ok(/setPositiveButton\s*\(/.test(java), '对话框需要有确认按钮');
});

t('对话框可以取消', () => {
  assert.ok(/setNegativeButton\s*\(/.test(java), '必须提供取消按钮');
  assert.ok(/取消/.test(java), '取消按钮应当明说是「取消」');
  assert.ok(/setCancelable\s*\(\s*true\s*\)/.test(rawJava), '返回键/点外部也要能取消，不能把用户锁死在对话框里');
});

t('输入不合法时对话框不关，让用户继续改', () => {
  assert.ok(
    /BUTTON_POSITIVE/.test(java) && /setOnShowListener/.test(java),
    '正按钮需要接管点击（setOnShowListener + getButton(BUTTON_POSITIVE)），否则默认点一下就关、校验失败无处可改',
  );
});

t('地址校验存在且拒绝非 http(s)', () => {
  assert.ok(/normalizeStartUrl/.test(java), '需要 normalizeStartUrl() 做基本校验');
  assert.ok(/https?/.test(java), '校验里应只认 http/https');
});

t('接入方式是三个预设 + 自定义，本机走回环', () => {
  for (const label of ['本机 / USB', 'Tailscale', '公网隧道', '自定义']) {
    assert.ok(rawJava.includes(`"${label}"`), `缺少接入方式：${label}`);
  }
  assert.ok(/"http:\/\/127\.0\.0\.1:24000\/"/.test(java), '本机 / USB 的默认地址应是 http://127.0.0.1:24000/');
});

t('每种接入方式各记一个地址，并记住上次用的那种', () => {
  const remember = method(java, 'private void rememberMode(String mode, String normalized)');
  assert.ok(remember, '找不到 rememberMode()');
  assert.match(remember, /putString\s*\(\s*keyForMode\s*\(\s*mode\s*\)/, '地址要按接入方式分开存');
  assert.match(remember, /putString\s*\(\s*KEY_LAST_MODE\s*,\s*mode\s*\)/, '要记住上次使用的接入方式');
  assert.match(java, /normalizeMode\s*\(\s*prefs\.getString\s*\(\s*KEY_LAST_MODE/, '启动地址要按上次的接入方式取');
  // 地址只能从原生对话框写进去：全文里 rememberMode 只应有「定义 + 对话框那一次调用」
  assert.equal((java.match(/rememberMode\s*\(/g) || []).length, 2, 'rememberMode 只能被原生对话框调用一次');
});

t('保存后立刻加载并持久化', () => {
  assert.match(java, /putString\s*\(\s*keyForMode\s*\(\s*mode\s*\)/, '改完地址要按接入方式写回 SharedPreferences');
  assert.ok(/loadUrl\s*\(/.test(java), '改完地址要直接加载');
});

t('每种接入方式旁边都有「测试」，只探测 bootstrap 且不带凭据', () => {
  const probe = method(java, 'private void probeBootstrap(String address, ProbeCallback callback)');
  assert.ok(probe, '找不到 probeBootstrap()');
  assert.ok(/PROBE_PATH\s*=\s*"\/api\/mobile\/bootstrap"/.test(java), '探测地址应是 /api/mobile/bootstrap');
  assert.match(probe, /bootstrapProbeUrl\s*\(/, '探测地址要经 bootstrapProbeUrl() 拼');
  assert.match(probe, /setInstanceFollowRedirects\s*\(\s*false\s*\)/, '探测不跟随重定向');
  assert.match(probe, /setConnectTimeout\s*\(\s*PROBE_TIMEOUT_MS\s*\)/, '连接超时用统一的 4 秒');
  assert.match(probe, /setReadTimeout\s*\(\s*PROBE_TIMEOUT_MS\s*\)/, '读取超时用统一的 4 秒');
  assert.ok(/PROBE_TIMEOUT_MS\s*=\s*4000\s*;/.test(java), '超时就是 4 秒');
  assert.doesNotMatch(probe, /getCookie|CookieManager|setRequestProperty\s*\(\s*"(Cookie|Authorization)"/i, '探测不得发送任何凭据');
  assert.equal((probe.match(/Log\./g) || []).length, 1, '探测只允许一行日志');
  assert.match(probe, /Log\.i\(TAG, "probe " \+ probeUrl\)/, '日志里只出现地址本身');
  assert.match(probe, /可达/, '成功时要给出毫秒数');
  assert.match(probe, /超时/, '失败要说明简短原因');
  assert.match(java, /test\.setText\("测试"\)/, '每个预设旁边要有「测试」按钮');
});

t('下载文件名优先取 URL 的 name 参数', () => {
  const dl = method(java, 'private void handleDownloadStart(String url, String userAgent, String contentDisposition, String mimeType)');
  assert.ok(dl, '找不到 handleDownloadStart');
  const queryAt = dl.indexOf('downloadFileNameFromQuery(url)');
  const guessAt = dl.indexOf('guessFileName');
  assert.ok(queryAt >= 0, '要先从 name 参数取文件名');
  assert.ok(guessAt > queryAt, '取不到才退回 guessFileName');
  assert.match(dl, /sanitizeDownloadFileName\s*\(/, 'name 参数也要过同一个清洗');
  assert.match(dl, /isWorkspaceContentUrl\s*\(\s*url\s*,\s*startUrl\s*\)/, '同源白名单不能因为改文件名而放松');
  assert.match(dl, /new\s+AlertDialog\.Builder/, '下载前仍要原生确认');
});

t('Android 11+ 内容区避开系统栏后再挂载 WebView', () => {
  assert.ok(/Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.R/.test(java), '需对 API 30+ 显式设置窗口 Insets 行为');
  const insetCall = java.indexOf('getWindow().setDecorFitsSystemWindows(true)');
  const contentCall = java.indexOf('setContentView(web)');
  assert.ok(insetCall >= 0, '需调用 Window.setDecorFitsSystemWindows(true)');
  assert.ok(contentCall > insetCall, '系统 Insets 策略必须在 setContentView(web) 前设置');
});

/* ------------------------------------------------------------------ */
/* 3. 返回键                                                            */
/* ------------------------------------------------------------------ */

t('返回键先问网页', () => {
  assert.ok(/evaluateJavascript\s*\(/.test(java), '返回键必须用 evaluateJavascript 异步问网页');
  assert.ok(/HanaMobile\.back/.test(java), '要调用网页暴露的 HanaMobile.back()');
});

t('网页不肯退时保留原退出策略', () => {
  assert.ok(/canGoBack\s*\(\s*\)/.test(java), '网页不消费返回时仍走 canGoBack()');
  assert.ok(/finish\s*\(\s*\)/.test(java), '退无可退时仍 finish() 退出');
});

t('targetSdk 36 也要能收到返回（OnBackInvokedCallback）', () => {
  assert.ok(/OnBackInvokedDispatcher/.test(java), 'API 33+ 必须注册 OnBackInvokedCallback，否则 Android 16 上 KEYCODE_BACK 不再派发');
  assert.ok(/registerOnBackInvokedCallback/.test(java), '缺少注册调用');
  assert.ok(/VERSION_CODES\.TIRAMISU/.test(java), '注册前要判 API 级别，低版本走 onKeyDown');
});

t('连不上时页面里能改地址（不靠 JS 桥）', () => {
  assert.ok(/loadDataWithBaseURL/.test(java), '加载失败要给一张原生错误页，而不是白屏');
  assert.ok(/SCHEME_SETUP/.test(java), '错误页需要自带一个自定义协议入口');
  assert.ok(
    /SCHEME_SETUP\.equals\s*\(\s*scheme\s*\)/.test(java),
    'shouldOverrideUrlLoading 里要拦截自定义协议，转去弹原生对话框',
  );
  const at = java.indexOf('SCHEME_SETUP.equals(scheme)');
  assert.ok(at >= 0 && /errorPageShown/.test(java.slice(at, at + 240)), '自定义协议只在自己的错误页上生效，页面（卡片 iframe）往里跳一律吞掉');
});

/* ------------------------------------------------------------------ */
/* 4. 页面标记：返回键的第三态                                          */
/* ------------------------------------------------------------------ */

t('网页侧带 hana-shell 标记，壳按同一个名字查', () => {
  const html = read('../web/index.html');
  assert.match(
    html,
    /<meta\s+name="hana-shell"\s+content="1"\s*\/?>/,
    'web/index.html 的 <head> 里必须有 <meta name="hana-shell" content="1">',
  );
  assert.match(java, /JS_HANA_MARKER\s*=/, '壳里应有页面标记查询脚本常量');
  assert.match(java, /meta\[name=\\"hana-shell\\"\]/, '查询脚本要按 meta[name="hana-shell"] 找');
  assert.match(java, /!!document\.querySelector/, '要用 !! 收成布尔，否则 evaluateJavascript 拿到的是 "null"');
});

t('主帧开始把标记置为未知，主帧结束带导航序号回填三态', () => {
  const started = method(java, 'public void onPageStarted(WebView view, String url, Bitmap favicon)');
  assert.ok(started, '找不到 onPageStarted（主帧开始时标记必须回到未知）');
  assert.match(started, /pageIsHana\s*=\s*null/, 'onPageStarted 必须把 pageIsHana 置回 null');
  assert.match(started, /pageMarkSeq\s*(\+=\s*1|\+\+)/, 'onPageStarted 要推进导航序号');

  const finished = method(java, 'public void onPageFinished(WebView view, String url)');
  assert.ok(finished, '找不到 onPageFinished（主帧结束时要查标记）');
  assert.match(finished, /evaluateJavascript\s*\(\s*JS_HANA_MARKER/, 'onPageFinished 要用 evaluateJavascript 查页面标记');
  assert.match(finished, /seq\s*!=\s*pageMarkSeq\)\s*return/, '过期回调（导航序号已变）必须丢弃');
  assert.match(finished, /pageIsHana\s*=\s*Boolean\.TRUE/, '查到 true 要存成 Boolean.TRUE');
  assert.match(finished, /pageIsHana\s*=\s*Boolean\.FALSE/, '查到 false 要存成 Boolean.FALSE');
});

t('返回键分支顺序：网页后退 → 历史 → 页面标记 → 可取消对话框', () => {
  const table = method(java, 'static String backAction(');
  assert.ok(table, '找不到 backAction()');
  const webAt = table.indexOf('webHandled');
  const historyAt = table.indexOf('canGoBack');
  const markerAt = table.indexOf('pageIsHana');
  const askAt = table.indexOf('BACK_ASK');
  assert.ok(webAt >= 0, '第一支必须是「网页自己退了」');
  assert.ok(historyAt > webAt, '历史排在网页之后');
  assert.ok(markerAt > historyAt, '页面标记排在历史之后');
  assert.ok(askAt > markerAt, '对话框是最后的兜底');
  assert.match(table, /if\s*\(webHandled\)\s*return BACK_NONE;/, '网页自己退了就什么都不做');
});

t('null（还没查到）不会被当成别人的页面直接处理掉', () => {
  const table = method(java, 'static String backAction(');
  assert.match(
    table,
    /if\s*\(Boolean\.TRUE\.equals\(pageIsHana\)\)\s*return BACK_FINISH;/,
    '只有确认是 Hana 的页面（true）才允许退出',
  );
  assert.doesNotMatch(table, /Boolean\.FALSE\.equals\(pageIsHana\)/, 'false 不能与 true 同等处理');
  assert.doesNotMatch(
    table,
    /!\s*Boolean\.FALSE\.equals\(pageIsHana\)/,
    '不能写成「不是 false 就退出」：那样 null 也一并退出了',
  );
  assert.match(table, /return BACK_ASK;\s*\}/, '兜底是问用户，而不是退出');
  assert.doesNotMatch(table, /sameOrigin/, '不能再用同源判断「别人的页面」：配置地址本来就在那个域上');
});

t('leaveOrFinish 只按决策表执行副作用', () => {
  const leave = method(java, 'private void leaveOrFinish(boolean webHandled)');
  assert.ok(leave, '找不到 leaveOrFinish(boolean webHandled)');
  assert.match(leave, /backAction\(webHandled, errorPageShown,/, '判断交给纯方法 backAction');
  assert.match(leave, /BACK_GO_BACK\.equals\(action\)[\s\S]*web\.goBack\(\)/, 'go_back → goBack()');
  assert.match(leave, /BACK_FINISH\.equals\(action\)[\s\S]*finish\(\)/, 'finish → finish()');
  assert.match(leave, /BACK_ASK\.equals\(action\)[\s\S]*promptForForeignPage\(\)/, 'ask → 对话框');
  assert.match(java, /leaveOrFinish\("true"\.equals\(value\)\)/, '网页的答复直接进决策表');
});

t('外页面对话框：标题 + 三选项，可取消，且不换页', () => {
  const dialog = method(java, 'private void promptForForeignPage()');
  assert.ok(dialog, '找不到 promptForForeignPage()');
  assert.match(dialog, /"这个页面不是 Hana 的页面"/, '标题要说明这不是 Hana 的页面');
  assert.match(
    dialog,
    /setPositiveButton\("改接入方式",\s*\([^)]*\)\s*->\s*promptForStartUrl\(/,
    '「改接入方式」直接走 promptForStartUrl',
  );
  assert.match(dialog, /setNeutralButton\("退出",\s*\([^)]*\)\s*->\s*finish\(\)\)/, '「退出」就是 finish()');
  assert.match(dialog, /setNegativeButton\("取消",\s*null\)/, '「取消」什么都不做');
  assert.match(dialog, /setCancelable\(true\)/, '点外面 / 返回键也等于取消');
  assert.doesNotMatch(dialog, /loadUrl|loadDataWithBaseURL/, '按返回不能顺手把页面换掉');
});

/* ------------------------------------------------------------------ */
/* 5. 日志脱敏                                                          */
/* ------------------------------------------------------------------ */

t('日志不写完整开始地址，只过 redactUrlForLog', () => {
  assert.doesNotMatch(java, /"started with "\s*\+\s*startUrl/, '启动日志不得拼完整 startUrl（token 可能就在 query / fragment 里）');
  assert.doesNotMatch(java, /"start url -> "\s*\+\s*normalized/, '改地址日志不得拼完整地址');
  assert.doesNotMatch(java, /"main frame failed: "\s*\+\s*url/, '失败日志不得拼完整地址');
  assert.match(java, /"started with "\s*\+\s*redactUrlForLog\(startUrl\)/, '启动日志要过 redactUrlForLog');
  assert.match(java, /"start url -> "\s*\+\s*redactUrlForLog\(normalized\)/, '改地址日志要过 redactUrlForLog');
  assert.match(java, /"main frame failed: "\s*\+\s*redactUrlForLog\(url\)/, '失败日志要过 redactUrlForLog');
});

t('redactUrlForLog 只留 scheme://host[:port] 与路径标志', () => {
  const redact = method(java, 'static String redactUrlForLog(String raw)');
  assert.ok(redact, '缺少 redactUrlForLog()');
  assert.match(redact, /getRawPath/, '要判断是不是根路径');
  assert.doesNotMatch(redact, /getRawQuery|getRawFragment|getQuery|getFragment/, '不得把查询串或 fragment 写进日志');
});

/* ------------------------------------------------------------------ */
/* 6. 归一化端口、默认接入方式、探测文案                                */
/* ------------------------------------------------------------------ */

t('归一化入口就拒绝端口 0（不能存进配置）', () => {
  const normalize = method(java, 'static String normalizeStartUrl(String raw)');
  assert.ok(normalize, '找不到 normalizeStartUrl');
  assert.match(normalize, /getPort\s*\(\s*\)/, '要读 URI 的端口');
  assert.match(normalize, /port\s*<\s*1/, ':0 不是默认端口，归一化阶段必须拒绝');
  assert.match(normalize, /port\s*>\s*65535/, '上限照旧拒绝');
});

t('无效 / 缺失模式默认「本机 / USB」，注释同步', () => {
  assert.match(java, /MODE_LOCAL\s*=\s*"local_usb"/, 'MODE_LOCAL 常量值应为 local_usb');
  const mode = method(java, 'private static String normalizeMode(String raw)');
  assert.ok(mode, '找不到 normalizeMode');
  assert.match(mode, /for\s*\(String mode : MODES\)/, '仍然先认可已存的值');
  assert.match(mode, /return\s+MODE_LOCAL\s*;/, '兜底必须是 MODE_LOCAL');
  assert.ok(!rawJava.includes('当「自定义」'), 'normalizeMode 的过时注释（默认自定义）要改掉');
});

t('401/403 用中性文案，不把 WAF 拦截说成「需要登录」', () => {
  const probe = method(java, 'private void probeBootstrap(String address, ProbeCallback callback)');
  assert.ok(probe, '找不到 probeBootstrap');
  assert.match(
    probe,
    /"服务端返回 HTTP "\s*\+\s*code\s*\+\s*"（未带登录）"/,
    '401/403 应说「服务端返回 HTTP xxx（未带登录）」',
  );
  assert.doesNotMatch(probe, /可达（未带登录/, '旧的「可达（未带登录…」措辞要去掉');
});

t('超时文案与实测行为一致（连接、读取各 4 秒）', () => {
  const probe = method(java, 'private void probeBootstrap(String address, ProbeCallback callback)');
  assert.match(probe, /"超时（连接或读取超过 4 秒）"/, '文案要说明是连接或读取超过 4 秒，而不是硬说 4 秒整');
  assert.doesNotMatch(probe, /"超时（4 秒）"/, '旧的「超时（4 秒）」与实际不符');
  assert.match(java, /PROBE_TIMEOUT_MS\s*=\s*4000;/, '常量还是 4 秒');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}