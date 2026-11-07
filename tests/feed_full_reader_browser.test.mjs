/*
 * 真实浏览器验收：日报条目点开全屏完整阅读层。
 *
 * - 只用本机随机端口静态假服务 + 独立临时 Edge profile；不上真实网关、不读真实日报。
 * - 真鼠标点击入口、标题按钮、「阅读全文」、阅读层返回与继续聊，不做内部 helper 直调。
 * - 两种正文源：folio（/gw/feed/.../#feed-mode=open）与 automation-digest（无
 *   documentPath，经 mobile-document-chunk 分片拼成 srcdoc）。
 * - 假文档自带 collapsed/expanded 分支与真实滚动，验证「原先隐藏的尾段」确实显示、
 *   可滚到末尾；native 还验证严格 CSP 允许内联脚本、阻断外联与父 DOM 访问。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 阅读层验收全靠真实浏览器：滚动、展开、CSP 都是在 Chromium 里读出来的，
// 没有浏览器就无从验证，所以 CI 上整文件跳过；SKIP 行让 runner 记成跳过而非通过。
if (process.env.HANA_SKIP_BROWSER_TESTS === '1') {
  console.log('SKIP  因 HANA_SKIP_BROWSER_TESTS 跳过浏览器验收');
  process.exit(0);
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const WEB_DIR = path.join(ROOT, 'web');
const RUN_TAG = process.env.FEED_READER_OPEN_TAG
  || `run-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
const ARTIFACT_DIR = path.join(TEST_DIR, 'artifacts', 'feed-reader-open', RUN_TAG);

const ID_FOLIO = 'fi_0123456789ABCDEFGHJKMNPQRS';
const ID_NATIVE = 'fi_ZYXWVTSRQPNMKJHGFEDCBA9876';
const FOLIO_TITLE = '虚构folio长日报';
const NATIVE_TITLE = '虚构原生长日报';
const FOLIO_TAIL = 'FOLIO-TAIL-SENTINEL';
const NATIVE_TAIL = 'NATIVE-TAIL-SENTINEL';
const NATIVE_CARD_ID = `feed-${ID_NATIVE}-r1`;
const FOLIO_URL = `/gw/feed/${ID_FOLIO}/r1/`;
/** 两条真实条目 + 8 条填充：列表要真的能滚，才能验“返回原位”。 */
const TOTAL_ITEMS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function folioFixtureHtml() {
  const filler = Array.from({ length: 70 }, (_unused, index) => (
    `<p class="folio-p">folio 第 ${index} 段正文，用于真实浏览器滚动验证。</p>`
  )).join('');
  // 首屏脚本只做三件事：报高度、按 hash 决定是否展开被隐藏的尾段、回传滚动指标。
  // 展开前的可见性是在真实布局里量出来的，不是字符串判断。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>folio 假卡片</title>
<style>
html,body{margin:0;padding:0;background:#fffdf9;color:#243746;font:16px/1.6 sans-serif}
main{padding:16px}
.folio-p{margin:0 0 10px}
.folio-full{display:none}
</style></head>
<body><main>
<p>folio 折叠摘要</p>
<div class="folio-full" id="folio-full">${filler}<p id="folio-tail">${FOLIO_TAIL}</p></div>
</main>
<script>
(function(){
  var tail = document.getElementById('folio-tail');
  var preExpandVisible = !!(tail && tail.getBoundingClientRect().height > 0);
  var opened = location.hash === '#feed-mode=open';
  if (opened) {
    document.getElementById('folio-full').style.display = 'block';
    document.documentElement.setAttribute('data-feed-mode', 'open');
  }
  function report(){
    var se = document.scrollingElement || document.documentElement;
    var rect = tail ? tail.getBoundingClientRect() : null;
    window.parent.postMessage({
      __fakeReader: {
        kind: 'folio',
        hash: location.hash,
        mode: document.documentElement.getAttribute('data-feed-mode') || '',
        preExpandVisible: preExpandVisible,
        tailVisible: !!(rect && rect.height > 0),
        tailInView: !!(rect && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0),
        scrollTop: se.scrollTop,
        scrollHeight: se.scrollHeight,
        clientHeight: se.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      }
    }, '*');
  }
  window.addEventListener('scroll', report, { passive: true });
  window.addEventListener('message', function(event){ if (event.data === '__probe') report(); });
  report();
  window.parent.postMessage({ __hanaCardHeight: 640 }, '*');
})();
</script>
</body></html>`;
}

function bootstrapScript() {
  return `<script type="module">
import { createFeedFeature } from '/features/feed.js';

const ID_FOLIO = '${ID_FOLIO}';
const ID_NATIVE = '${ID_NATIVE}';
const FOLIO_TITLE = '${FOLIO_TITLE}';
const NATIVE_TITLE = '${NATIVE_TITLE}';
const NATIVE_TAIL = '${NATIVE_TAIL}';
const NATIVE_CARD_ID = '${NATIVE_CARD_ID}';
const FOLIO_URL = '${FOLIO_URL}';

function buildNativeHtml() {
  var filler = '';
  for (var i = 0; i < 70; i += 1) {
    filler += '<p class="digest-p">原生第 ' + i + ' 段正文，用于真实浏览器滚动验证。</p>';
  }
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>原生日报</title>' +
    '<style>html,body{margin:0;padding:0;background:#fffdf9;color:#243746;font:16px/1.6 sans-serif}' +
    'main{padding:16px}.digest-p{margin:0 0 10px}.digest-full{display:none}</style>' +
    '<' + 'script>window.__hostDigestInlineRan = true;<' + '/script>' +
    '</head><body><main><p>原生折叠摘要</p>' +
    '<div class="digest-full" id="digest-full">' + filler +
    '<p id="digest-tail">' + NATIVE_TAIL + '</p></div></main>' +
    '<' + 'script>' +
    '(function(){' +
    'var tail = document.getElementById("digest-tail");' +
    'var preExpandVisible = !!(tail && tail.getBoundingClientRect().height > 0);' +
    'var expanded = location.hash === "#digest-view=expanded";' +
    'if (expanded) { document.getElementById("digest-full").style.display = "block";' +
    ' document.documentElement.setAttribute("data-digest-view", "expanded"); }' +
    'var parentAccess = "allowed";' +
    'try { void window.parent.document.body; } catch (error) { parentAccess = "blocked"; }' +
    'function report(){' +
    ' var se = document.scrollingElement || document.documentElement;' +
    ' var rect = tail ? tail.getBoundingClientRect() : null;' +
    ' var full = document.getElementById("digest-full");' +
    ' window.parent.postMessage({__fakeReader:{kind:"native",hash:location.hash,' +
    '  view:document.documentElement.getAttribute("data-digest-view")||"",' +
    '  inlineRan:window.__hostDigestInlineRan===true,parentAccess:parentAccess,' +
    '  preExpandVisible:preExpandVisible,tailVisible:!!(rect&&rect.height>0),' +
    '  tailInView:!!(rect&&rect.height>0&&rect.top<window.innerHeight&&rect.bottom>0),' +
    '  fullDisplay:full?getComputedStyle(full).display:"missing",' +
    '  bodyDisplay:getComputedStyle(document.body).display,' +
    '  bodyHeight:document.body.getBoundingClientRect().height,' +
    '  firstPHeight:(document.querySelector(".digest-p")||{getBoundingClientRect:function(){return {height:-1}}}).getBoundingClientRect().height,' +
    '  firstPText:((document.querySelector(".digest-p")||{}).textContent||"").slice(0,12),' +
    '  readyState:document.readyState,visibilityState:document.visibilityState,' +
    '  paragraphs:document.querySelectorAll(".digest-p").length,' +
    '  styleSheets:document.styleSheets.length,' +
    '  scrollTop:se.scrollTop,scrollHeight:se.scrollHeight,clientHeight:se.clientHeight,' +
    '  scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth}},"*");' +
    '}' +
    'window.addEventListener("scroll", report, {passive:true});' +
    'window.addEventListener("message", function(event){ if (event.data === "__probe") report(); });' +
    'fetch("/__csp-probe").then(function(){ window.parent.postMessage({__fakeReaderCsp:"allowed"},"*"); },' +
    ' function(){ window.parent.postMessage({__fakeReaderCsp:"blocked"},"*"); });' +
    'report();' +
    '})();' +
    '<' + '/script>' +
    '</body></html>';
}

const NATIVE_HTML = buildNativeHtml();
const CHUNK_CHARS = 500;

const item = (itemId, extra) => Object.assign({
  itemId: itemId,
  revision: 1,
  lane: 'content',
  laneKind: 'content',
  template: 'folio-card',
  title: 'isolated',
  ask: '要跟进这件事吗？',
  topics: ['隔离测试'],
  source: { sourceId: 'fake-source', displayName: '隔离假日报' },
  createdAt: '2026-11-06T08:00:00.000Z',
  unread: true,
  favorite: false,
}, extra || {});

const items = [
  item(ID_FOLIO, { template: 'folio-card', title: FOLIO_TITLE }),
  item(ID_NATIVE, { template: 'automation-digest', title: NATIVE_TITLE }),
];
// 列表需要真实可滚动才能验证“返回原位”。填充条目用不带正文的模板，不参与正文断言。
for (let index = 0; index < 8; index += 1) {
  items.push(item('fi_FAKE' + String(index).padStart(22, '0'), {
    template: 'plain-note',
    title: '虚构填充条目 ' + index,
    ask: '',
  }));
}
const TOTAL_ITEMS = items.length;

window.__feedReader = {
  calls: { slate: 0, card: [], chunk: [], signals: 0, prepare: 0, create: 0, favorites: 0 },
  reports: [],
  csp: [],
  errors: [],
  signalBodies: [],
  items: items,
  slateJson: '',
};
window.__feedReader.slateJson = JSON.stringify({ items: items });

window.addEventListener('error', (event) => window.__feedReader.errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__feedReader.errors.push('rejection:' + String(event.reason)));
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.__fakeReader) window.__feedReader.reports.push(data.__fakeReader);
  if (data.__fakeReaderCsp) window.__feedReader.csp.push(data.__fakeReaderCsp);
});

const api = async (url, options) => {
  const path = String(url);
  const init = options || {};
  const parsed = new URL(path, location.origin);
  if (parsed.pathname === '/api/feed/slate') {
    window.__feedReader.calls.slate += 1;
    return { slateId: 'fake-slate', items: items, unreadTaskCount: 0, cursor: null, nextPatrolAt: null };
  }
  if (parsed.pathname === '/api/feed/items/' + ID_FOLIO + '/card' && init.method === 'POST') {
    window.__feedReader.calls.card.push('folio');
    return { cardId: 'feed-' + ID_FOLIO + '-r1', revision: 1, documentPath: 'card/index.html' };
  }
  if (parsed.pathname === '/api/feed/items/' + ID_NATIVE + '/card' && init.method === 'POST') {
    window.__feedReader.calls.card.push('native');
    return { cardId: NATIVE_CARD_ID, revision: 1 };
  }
  if (parsed.pathname === '/api/cards/' + NATIVE_CARD_ID + '/mobile-document-chunk') {
    const offset = Number(parsed.searchParams.get('offset'));
    window.__feedReader.calls.chunk.push(offset);
    const data = NATIVE_HTML.slice(offset, offset + CHUNK_CHARS);
    return {
      ok: true,
      offset: offset,
      length: data.length,
      totalChars: NATIVE_HTML.length,
      eof: offset + data.length >= NATIVE_HTML.length,
      data: data,
    };
  }
  if (parsed.pathname === '/api/feed/signals' && init.method === 'POST') {
    window.__feedReader.calls.signals += 1;
    const body = JSON.parse(init.body || '{}');
    window.__feedReader.signalBodies.push(body);
    return { accepted: (body.signals || []).length, unreadTaskCount: 0 };
  }
  if (parsed.pathname === '/api/feed/send/prepare') {
    window.__feedReader.calls.prepare += 1;
    return { ok: false, error: 'isolated_fake_refuses' };
  }
  if (parsed.pathname === '/api/sessions/new') {
    window.__feedReader.calls.create += 1;
    return { path: '/fake/session.jsonl', sessionId: 'isolated-session' };
  }
  if (parsed.pathname === '/api/feed/items/' + ID_FOLIO + '/favorite') {
    window.__feedReader.calls.favorites += 1;
    return { favorite: true };
  }
  throw new Error('unexpected fake api path: ' + path);
};

const feature = createFeedFeature({
  api: api,
  document: document,
  window: window,
  getIdentity: () => ({ id: 'isolated-reader-browser-test' }),
  getNavigationEpoch: () => 0,
  getSession: () => null,
  openSession: async () => { window.__feedReader.calls.create += 1; },
  sendPrepared: async () => ({ frameWritten: false, committed: false }),
});
document.getElementById('view-list').hidden = false;
feature.mount();
window.__feedReader.feature = feature;
window.__feedReader.probe = (frame) => {
  try { frame.contentWindow.postMessage('__probe', '*'); } catch (error) { /* isolated frame gone */ }
};
window.__feedReader.bodyScrollTop = () => document.querySelector('.feed-body').scrollTop;
</script>`;
}

async function startStaticServer() {
  const index = await fsp.readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
  // 产物名带内容哈希：页面里写的仍是稳定引用（网关也靠它做注入），
  // 夹具按 dist/manifest.json 映射到真实文件，不去猜文件名，也不在这里重新构建。
  const distManifest = JSON.parse(await fsp.readFile(path.join(WEB_DIR, 'dist', 'manifest.json'), 'utf8'));
  const distFile = new Map([
    ['dist/app.js', `dist/${distManifest.js}`],
    ['dist/app.css', `dist/${distManifest.css}`],
  ]);
  let html = index
    .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
    .replace(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g, (tag, href) => (
      ['/dist/app.css'].includes(href) ? tag : ''
    ));
  const appScript = /<script src="\/dist\/app\.js" type="module"><\/script>/;
  assert.match(html, appScript, '真实首页必须包含可替换的 app 启动脚本');
  html = html.replace(appScript, bootstrapScript());

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (pathname === FOLIO_URL) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(folioFixtureHtml());
      return;
    }
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    const absolute = path.resolve(WEB_DIR, distFile.get(relative) || relative);
    if (!absolute.startsWith(`${WEB_DIR}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fsp.readFile(absolute);
      const extension = path.extname(absolute).toLowerCase();
      const contentType = extension === '.css'
        ? 'text/css; charset=utf-8'
        : extension === '.js' || extension === '.mjs'
          ? 'text/javascript; charset=utf-8'
          : extension === '.svg'
            ? 'image/svg+xml'
            : 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port, requests };
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed'));
      else waiter.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('Edge CDP websocket connection failed')));
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((done, fail) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            pending.delete(id);
            fail(new Error(`CDP ${method} timeout`));
          }, 20_000);
          pending.set(id, { resolve: done, reject: fail, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { socket.close(); } catch { /* already closed */ } },
    }));
  });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const page = (await response.json()).find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch { /* isolated Edge is still starting */ }
    await sleep(100);
  }
  throw new Error('isolated Edge page target did not become ready');
}

async function startEdge(executable, profile) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const actual = Object.keys(process.env).find((key) => key.toUpperCase() === name.toUpperCase());
    if (actual && process.env[actual]) env[name] = process.env[actual];
  }
  const child = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  const activePort = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Edge exited ${child.exitCode}: ${stderr}`);
    try {
      const port = Number((await fsp.readFile(activePort, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return { child, port };
    } catch { /* DevToolsActivePort has not been written yet */ }
    await sleep(100);
  }
  throw new Error(`Edge DevToolsActivePort not ready: ${stderr}`);
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function waitFor(cdp, expression, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** 失败时把现场留下来：比只看“等了 12s”有用得多。 */
async function dumpDiagnostics(cdp, reason) {
  const state = await evaluate(cdp, `(() => {
    const reader = document.querySelector('.feed-reader');
    const frame = document.querySelector('.feed-reader iframe');
    return {
      reason: ${JSON.stringify(reason)},
      reader: reader ? { hidden: reader.hidden, title: document.querySelector('.feed-reader-title')?.textContent || '' } : null,
      readerBody: document.querySelector('.feed-reader-body')?.innerHTML?.slice(0, 400) || '',
      frame: frame ? { src: frame.getAttribute('src'), srcdocLength: (frame.getAttribute('srcdoc') || '').length, height: frame.style.height, visibility: frame.style.visibility } : null,
      cardErrors: [...document.querySelectorAll('.feed-card-error, .feed-reader-error')].map((node) => node.textContent),
      calls: window.__feedReader?.calls,
      reports: window.__feedReader?.reports?.slice(-5),
      csp: window.__feedReader?.csp,
      errors: window.__feedReader?.errors,
    };
  })()`).catch((error) => ({ dumpFailed: String(error) }));
  await fsp.writeFile(path.join(ARTIFACT_DIR, 'failure-state.json'), JSON.stringify(state, null, 2));
  const srcdoc = await evaluate(cdp, `(() => document.querySelector('.feed-reader iframe')?.getAttribute('srcdoc') || '')()`).catch(() => '');
  if (srcdoc) await fsp.writeFile(path.join(ARTIFACT_DIR, 'failure-srcdoc.html'), srcdoc, 'utf8');
  console.error(`DIAG ${JSON.stringify(state)}`);
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await waitFor(cdp, `window.innerWidth === ${width} && window.innerHeight === ${height}`, `${width}x${height} viewport`);
  await sleep(80);
}

/** 等 iframe 内部文档完成布局：反复发 __probe 探针，直到拿到“内容比视口高”的真布局指标。 */
async function ensureLaidOut(cdp, kind, label) {
  const deadline = Date.now() + 12_000;
  let last = null;
  while (Date.now() < deadline) {
    await evaluate(cdp, `window.__feedReader.probe(document.querySelector('.feed-reader iframe')); true`);
    await sleep(120);
    last = await evaluate(cdp, `(() => window.__feedReader.reports.filter((entry) => entry.kind === '${kind}').slice(-1)[0] || null)()`);
    if (last && last.clientHeight > 0 && last.scrollHeight > last.clientHeight) return last;
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function capture(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fsp.writeFile(path.join(ARTIFACT_DIR, filename), Buffer.from(result.data, 'base64'));
}

async function dispatchClickAt(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(40);
}

async function centerOf(cdp, selector) {
  return evaluate(cdp, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
  })()`);
}

async function clickSelector(cdp, selector, label) {
  // 先把目标滚到可见区（列表是内部滚动容器），再算命中点；不做任何内部直调。
  await evaluate(cdp, `(async () => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node) { node.scrollIntoView({ block: 'center', inline: 'nearest' }); }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  const info = await evaluate(cdp, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { missing: true };
    const rect = node.getBoundingClientRect();
    const viewport = { width: innerWidth, height: innerHeight };
    if (!(rect.width > 0 && rect.height > 0)) {
      return { invisible: true, rect: { width: rect.width, height: rect.height }, viewport };
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x: x, y: y, viewport,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      hitTag: hit ? hit.tagName : null,
      hitClass: hit ? String(hit.className || '') : null,
      hitInside: !!(hit && (hit === node || node.contains(hit))),
    };
  })()`);
  assert.ok(!info.missing, `${label}: 找不到 ${selector}`);
  assert.ok(!info.invisible, `${label}: ${selector} 不可见 (${JSON.stringify(info.rect)})`);
  assert.ok(
    info.hitInside,
    `${label}: ${selector} 中心被 ${info.hitTag}.${info.hitClass} 遮挡 (rect ${JSON.stringify(info.rect)}, viewport ${JSON.stringify(info.viewport)})`,
  );
  await dispatchClickAt(cdp, { x: info.x, y: info.y });
  return info;
}

/** 直接点元素当前所在位置：不做任何 scrollIntoView，用来证明滚动位置没被重置。 */
async function clickAtCurrent(cdp, selector, label) {
  const info = await evaluate(cdp, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { missing: true };
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x: x, y: y,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      visible: rect.width > 0 && rect.height > 0 && rect.top >= -0.5 && rect.bottom <= innerHeight + 0.5,
      hitInside: !!(hit && (hit === node || node.contains(hit))),
      hitTag: hit ? hit.tagName : null,
      hitClass: hit ? String(hit.className || '') : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  assert.ok(!info.missing, `${label}: 找不到 ${selector}`);
  assert.ok(info.visible, `${label}: ${selector} 当前不在视口内 (${JSON.stringify(info.rect)})`);
  assert.ok(info.hitInside, `${label}: ${selector} 中心被 ${info.hitTag}.${info.hitClass} 遮挡 (viewport ${JSON.stringify(info.viewport)})`);
  await dispatchClickAt(cdp, { x: info.x, y: info.y });
  return info;
}

async function wheelScroll(cdp, point, { times = 6, deltaY = 320 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  for (let index = 0; index < times; index += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY,
      button: 'none',
      modifiers: 0,
      pointerType: 'mouse',
    });
    await sleep(40);
  }
}

let server;
let browser;
let cdp;
let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
  return condition;
}

try {
  const edgePath = findEdge();
  assert.ok(edgePath, '需要 Edge/Chrome 才跑真实浏览器阅读层验收');
  await fsp.mkdir(ARTIFACT_DIR, { recursive: true });
  const profile = await fsp.mkdtemp(path.join(ARTIFACT_DIR, 'browser-profile-'));
  const started = await startStaticServer();
  server = started.server;
  browser = await startEdge(edgePath, profile);
  const wsUrl = await waitForPageTarget(browser.port);
  cdp = await connectCdp(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${started.port}/` });
  await waitFor(cdp, 'window.__feedReader && document.readyState === "complete"', '隔离页面与真实 feature 挂载');

  const boot = await evaluate(cdp, `(() => ({
    appScript: [...document.scripts].some((script) => script.src.endsWith('/dist/app.js')),
    entry: !!document.getElementById('btnFeed'),
    slateHasSentinel: window.__feedReader.slateJson.includes('SENTINEL'),
  }))()`);
  assert.equal(boot.appScript, false, '隔离浏览器不得运行真实 app.js');
  assert.equal(boot.entry, true, '真实日报入口必须挂载');
  assert.equal(boot.slateHasSentinel, false, '尾哨兵不得出现在 wire 列表数据里');
  checks += 3;

  for (const [width, height] of [[320, 568], [360, 800], [411, 858]]) {
    await setViewport(cdp, width, height);
    // 真实点击首页入口打开日报。
    await evaluate(cdp, 'window.__feedReader.feature.close(); true');
    const baseline = await evaluate(cdp, `({
      chunk: window.__feedReader.calls.chunk.length,
      cards: window.__feedReader.calls.card.length,
      nativeCards: window.__feedReader.calls.card.filter((kind) => kind === 'native').length,
      folioCards: window.__feedReader.calls.card.filter((kind) => kind === 'folio').length,
      pageFrames: document.querySelectorAll('iframe').length,
    })`);
    await clickSelector(cdp, '#btnFeed', 'feed entry');
    await waitFor(cdp, 'window.__feedReader.feature.isOpen() === true', `${width}: 入口点击打开日报`);
    await waitFor(cdp, `document.querySelectorAll('.feed-item').length === ${TOTAL_ITEMS}`, `${width}: 两条日报 + 填充条目`);
    await waitFor(cdp, `!!document.querySelector('.feed-item-title-btn')`, `${width}: 标题按钮存在`);
    await sleep(200);

    const listState = await evaluate(cdp, `(() => {
      const body = document.querySelector('.feed-body');
      return {
        titles: [...document.querySelectorAll('.feed-item-title')].map((node) => node.textContent),
        buttons: document.querySelectorAll('.feed-item-title-btn').length,
        readButtons: document.querySelectorAll('.feed-read').length,
        pageFrames: document.querySelectorAll('iframe').length,
        listFrames: document.querySelectorAll('.feed-item iframe').length,
        chunkCalls: window.__feedReader.calls.chunk.length,
        cardMints: window.__feedReader.calls.card.length,
        folioMints: window.__feedReader.calls.card.filter((kind) => kind === 'folio').length,
        scrollTop: body.scrollTop,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    check(listState.titles.slice(0, 2).join('|') === `${FOLIO_TITLE}|${NATIVE_TITLE}`, `${width}: 列表标题正确 (${listState.titles.slice(0, 2).join('|')})`);
    check(listState.buttons === TOTAL_ITEMS, `${width}: 每个标题都是可点击按钮 (${listState.buttons})`);
    check(listState.readButtons === TOTAL_ITEMS, `${width}: 每条都有阅读全文按钮 (${listState.readButtons})`);
    check(listState.pageFrames === baseline.pageFrames, `${width}: 列表阶段全页零 iframe (${listState.pageFrames} vs ${baseline.pageFrames})`);
    check(listState.listFrames === 0, `${width}: 列表条目内零 iframe`);
    check(listState.chunkCalls === baseline.chunk, `${width}: 列表阶段零正文分片请求 (${listState.chunkCalls} vs ${baseline.chunk})`);
    check(listState.cardMints === baseline.cards, `${width}: 列表阶段不铸造任何卡片（含 folio） (${listState.cardMints} vs ${baseline.cards})`);
    check(listState.folioMints === baseline.folioCards, `${width}: 列表阶段 folio 卡片零 POST (${listState.folioMints} vs ${baseline.folioCards})`);    check(listState.horizontalOverflow === false, `${width}: 列表无横向溢出`);

    // 列表先滚到非零位置（之后再滚回标题），稍后验证返回原位。
    const listPoint = await centerOf(cdp, '.feed-body');
    await wheelScroll(cdp, { x: listPoint.x, y: listPoint.y }, { times: 2, deltaY: 200 });
    const scrolledOnce = await evaluate(cdp, 'window.__feedReader.bodyScrollTop()');
    check(scrolledOnce > 0, `${width}: 列表先滚到 ${scrolledOnce}`);

    /* ---- folio：点标题进阅读层 ---- */
    const titleSelector = `.feed-item[data-item-id="${ID_FOLIO}"] .feed-item-title-btn`;
    await clickSelector(cdp, titleSelector, `${width}: folio 标题按钮`);
    const listScrollBefore = await evaluate(cdp, 'window.__feedReader.bodyScrollTop()');
    await waitFor(cdp, `!!document.querySelector('.feed-reader iframe')`, `${width}: folio 阅读层 iframe`);
    await waitFor(
      cdp,
      `(() => { const frame = document.querySelector('.feed-reader iframe'); return typeof frame.getAttribute('src') === 'string' && frame.getAttribute('src').includes('#feed-mode=open'); })()`,
      `${width}: folio 阅读层带 #feed-mode=open`,
    );
    await waitFor(cdp, `window.__feedReader.reports.some((entry) => entry.kind === 'folio')`, `${width}: folio 假文档上报`);
    // 文档自身的解析期布局还没完成，指标要用真布局后的探针重新取一次。
    await ensureLaidOut(cdp, 'folio', `${width}: folio 正文完成布局`);
    const folioLayout = await evaluate(cdp, `(() => {
      const frame = document.querySelector('.feed-reader iframe');
      const body = document.querySelector('.feed-reader-body');
      const head = document.querySelector('.feed-reader-head');
      const foot = document.querySelector('.feed-reader-foot');
      const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      return {
        frameHeight: frame.getBoundingClientRect().height,
        frameInlineHeight: frame.style.height,
        bodyHeight: body.clientHeight,
        head: rect(head), foot: rect(foot), body: rect(body),
        readerHidden: document.querySelector('.feed-reader').hidden,
        frames: document.querySelectorAll('.feed-reader iframe').length,
        listScrollTop: document.querySelector('.feed-body').scrollTop,
        itemNodes: document.querySelectorAll('.feed-item').length,
        folioMints: window.__feedReader.calls.card.filter((kind) => kind === 'folio').length,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        reports: window.__feedReader.reports.filter((entry) => entry.kind === 'folio').slice(-1),
      };
    })()`);
    const folioReport = folioLayout.reports[0] || {};
    check(folioLayout.readerHidden === false, `${width}: folio 阅读层可见`);
    check(folioLayout.frames === 1, `${width}: 只有一个阅读 iframe`);
    check(folioLayout.folioMints === baseline.folioCards + 1, `${width}: 打开阅读层才铸造 folio 卡片（${folioLayout.folioMints} vs ${baseline.folioCards}）`);
    check(folioLayout.frameInlineHeight === '100%', `${width}: iframe 走 100% 高度链（${folioLayout.frameInlineHeight}）`);
    check(Math.abs(folioLayout.frameHeight - folioLayout.bodyHeight) <= 2, `${width}: folio iframe 高度=可用视口 (${folioLayout.frameHeight} vs ${folioLayout.bodyHeight})`);
    check(folioLayout.frameHeight >= 200, `${width}: folio iframe 起始不是 0 高 (${folioLayout.frameHeight})`);
    check(folioLayout.head.height >= 44, `${width}: 阅读层顶栏可用`);
    check(folioLayout.horizontalOverflow === false, `${width}: 阅读层无横向溢出`);
    check(folioReport.hash === '#feed-mode=open', `${width}: folio 实际 hash 是 #feed-mode=open (${folioReport.hash})`);
    check(folioReport.preExpandVisible === false, `${width}: folio 尾段展开前确实被隐藏`);
    check(folioReport.tailVisible === true, `${width}: folio 尾段已按 open 模式显示`);
    check(Number(folioReport.scrollHeight) > Number(folioReport.clientHeight) + 100, `${width}: folio 正文足够长可滚动 (${folioReport.scrollHeight}/${folioReport.clientHeight})`);

    await wheelScroll(cdp, { x: folioLayout.body.left + folioLayout.body.width / 2, y: folioLayout.body.top + folioLayout.body.height / 2 }, { times: 14, deltaY: 360 });
    const folioScrolled = await waitFor(
      cdp,
      `(() => { const last = window.__feedReader.reports.filter((entry) => entry.kind === 'folio').slice(-1)[0]; return last && last.scrollTop + last.clientHeight >= last.scrollHeight - 4 ? last : null; })()`,
      `${width}: folio 滚到正文末尾`,
    );
    check(folioScrolled.tailInView === true, `${width}: folio 尾哨兵滚到可视区`);
    await capture(cdp, `reader-folio-${width}x${height}.png`);

    // 方向/尺寸变化：100% 高度链自动跟随，不需要重算像素。
    if (width === 320) {
      const measure = () => evaluate(cdp, `(() => {
        const frame = document.querySelector('.feed-reader iframe');
        const body = document.querySelector('.feed-reader-body');
        const rect = frame.getBoundingClientRect();
        return {
          frameHeight: rect.height,
          frameInlineHeight: frame.style.height,
          bodyHeight: body.clientHeight,
          viewportHeight: window.innerHeight,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      })()`);
      const landscape = (async () => {
        await setViewport(cdp, 568, 320);
        await sleep(150);
        return measure();
      })();
      const rotated = await landscape;
      console.log(`READER_ROTATE landscape ${JSON.stringify(rotated)}`);
      check(rotated.frameInlineHeight === '100%', '旋转后 iframe 仍是 100% 高度链');
      check(rotated.frameHeight > 0 && Math.abs(rotated.frameHeight - rotated.bodyHeight) <= 2, `旋转后 iframe 高度=可用视口 (${rotated.frameHeight} vs ${rotated.bodyHeight})`);
      check(rotated.overflowX === false, '旋转后阅读层无横向溢出');

      await setViewport(cdp, 320, 568);
      await sleep(150);
      const restored = await measure();
      console.log(`READER_ROTATE portrait ${JSON.stringify(restored)}`);
      check(restored.frameInlineHeight === '100%' && restored.frameHeight > 0 && Math.abs(restored.frameHeight - restored.bodyHeight) <= 2, `竖回后 iframe 高度仍=可用视口 (${restored.frameHeight} vs ${restored.bodyHeight})`);
      await capture(cdp, 'reader-folio-320x568-restored.png');
    }

    // 阅读层返回：真实点击，列表原位。
    await clickSelector(cdp, '.feed-reader-back', `${width}: 阅读层返回`);
    await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, `${width}: 阅读层关闭`);
    const afterBack = await evaluate(cdp, `({
      items: document.querySelectorAll('.feed-item').length,
      scrollTop: window.__feedReader.bodyScrollTop(),
      readerFrames: document.querySelectorAll('.feed-reader iframe').length,
      feedOpen: window.__feedReader.feature.isOpen(),
    })`);
    check(afterBack.items === TOTAL_ITEMS, `${width}: 返回后列表条目仍在 (${afterBack.items})`);
    check(Math.abs(afterBack.scrollTop - listScrollBefore) <= 1, `${width}: 列表滚动位置原位 (${afterBack.scrollTop} vs ${listScrollBefore})`);
    check(afterBack.feedOpen === true, `${width}: 返回只退阅读层，日报仍打开`);
    await capture(cdp, `list-back-${width}x${height}.png`);

    /* ---- automation-digest：标题已卷出可视顶边、入口仍在可视区，真实鼠标点开 ---- */
    const readSelector = `.feed-item[data-item-id="${ID_NATIVE}"] .feed-read`;
    const scrolledEntry = await evaluate(cdp, `(async () => {
      const body = document.querySelector('.feed-body');
      const row = document.querySelector('.feed-item[data-item-id="${ID_NATIVE}"]');
      const title = row.querySelector('.feed-item-title-btn');
      const button = row.querySelector('.feed-read');
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // 先把条目摆到可视区上部，再精确滚到“标题底边完全越过 body 顶边、按钮仍在内”。
      body.scrollTop += Math.round(row.getBoundingClientRect().top - body.getBoundingClientRect().top) - 8;
      await frame();
      const bodyRect = body.getBoundingClientRect();
      const titleRect0 = title.getBoundingClientRect();
      body.scrollTop += Math.ceil(titleRect0.bottom - bodyRect.top) + 8;
      await frame();
      const top = body.getBoundingClientRect().top;
      const bottom = body.getBoundingClientRect().bottom;
      const titleRect = title.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
      return {
        scrollTop: body.scrollTop,
        titleBottom: titleRect.bottom,
        bodyTop: top,
        buttonRect: { left: buttonRect.left, top: buttonRect.top, bottom: buttonRect.bottom, width: buttonRect.width, height: buttonRect.height },
        titleOutOfView: titleRect.bottom <= top + 1,
        buttonInView: buttonRect.top >= top + 1 && buttonRect.bottom <= bottom - 1,
        hitInside: !!(hit && (hit === button || button.contains(hit))),
      };
    })()`);
    console.log(`READER_ENTRY_SCROLL ${width} ${JSON.stringify(scrolledEntry)}`);
    check(scrolledEntry.scrollTop > 0, `${width}: 列表先滚到非零位置 (${scrolledEntry.scrollTop})`);
    check(scrolledEntry.titleOutOfView === true, `${width}: 该条标题已卷出可视顶边 (titleBottom=${scrolledEntry.titleBottom} bodyTop=${scrolledEntry.bodyTop})`);
    check(scrolledEntry.buttonInView === true, `${width}: 下方阅读全文按钮仍在可视区 (${JSON.stringify(scrolledEntry.buttonRect)})`);
    check(scrolledEntry.hitInside === true, `${width}: 鼠标命中点就是阅读全文按钮`);
    await dispatchClickAt(cdp, {
      x: scrolledEntry.buttonRect.left + scrolledEntry.buttonRect.width / 2,
      y: scrolledEntry.buttonRect.top + scrolledEntry.buttonRect.height / 2,
    });
    await waitFor(cdp, `!!document.querySelector('.feed-reader iframe')`, `${width}: native 阅读层 iframe`);
    await waitFor(cdp, `window.__feedReader.calls.chunk.length > 0`, `${width}: native 走分片接口`);
    await waitFor(cdp, `window.__feedReader.reports.some((entry) => entry.kind === 'native')`, `${width}: native 假文档上报`);
    await waitFor(cdp, `window.__feedReader.csp.length > 0`, `${width}: native CSP 探针回报`);
    await ensureLaidOut(cdp, 'native', `${width}: native 正文完成布局`);
    const nativeSrcdoc = await evaluate(cdp, `(() => document.querySelector('.feed-reader iframe')?.getAttribute('srcdoc') || '')()`);
    await fsp.writeFile(path.join(ARTIFACT_DIR, `native-srcdoc-${width}.html`), nativeSrcdoc, 'utf8');
    const nativeState = await evaluate(cdp, `(() => {
      const frame = document.querySelector('.feed-reader iframe');
      const body = document.querySelector('.feed-reader-body');
      const last = window.__feedReader.reports.filter((entry) => entry.kind === 'native').slice(-1)[0] || {};
      const srcdoc = frame.getAttribute('srcdoc') || '';
      return {
        src: frame.getAttribute('src'),
        hasSrcdoc: srcdoc.length > 0,
        srcdocHasCsp: srcdoc.includes('Content-Security-Policy'),
        srcdocHasSentinel: srcdoc.includes(${JSON.stringify(NATIVE_TAIL)}),
        cspHeadFirst: srcdoc.toLowerCase().indexOf('<head') < srcdoc.indexOf('Content-Security-Policy'),
        hashBeforeHostScript: srcdoc.indexOf("location.hash='digest-view=expanded'") < srcdoc.indexOf('__hostDigestInlineRan'),
        frameHeight: frame.getBoundingClientRect().height,
        frameInlineHeight: frame.style.height,
        bodyHeight: body.clientHeight,
        frames: document.querySelectorAll('.feed-reader iframe').length,
        nativeMints: window.__feedReader.calls.card.filter((kind) => kind === 'native').length,
        cardErrors: document.querySelectorAll('.feed-card-error').length,
        report: last,
        csp: window.__feedReader.csp.slice(),
        errors: window.__feedReader.errors.slice(),
      };
    })()`);
    check(nativeState.hasSrcdoc === true, `${width}: native 用 srcdoc`);
    check((nativeState.src || '') === '', `${width}: native 不设置可导航 src (${nativeState.src})`);
    check(nativeState.srcdocHasCsp === true && nativeState.cspHeadFirst === true, `${width}: 严格 CSP 必须在 head 最先`);
    check(nativeState.hashBeforeHostScript === true, `${width}: expanded hash 初始化先于宿主脚本`);
    check(nativeState.srcdocHasSentinel === true, `${width}: 拼出的 srcdoc 含完整尾段`);
    check(nativeState.frames === 1, `${width}: 阅读层始终只有一个 iframe`);
    check(nativeState.nativeMints === baseline.nativeCards + 1, `${width}: 打开阅读层才铸造 native 卡片（${nativeState.nativeMints} vs ${baseline.nativeCards}）`);
    check(nativeState.cardErrors === 0, `${width}: native 就绪后没有错误卡`);
    check(nativeState.frameInlineHeight === '100%', `${width}: native iframe 走 100% 高度链（${nativeState.frameInlineHeight}）`);
    check(Math.abs(nativeState.frameHeight - nativeState.bodyHeight) <= 2, `${width}: native iframe 高度=可用视口 (${nativeState.frameHeight} vs ${nativeState.bodyHeight})`);
    check(nativeState.report.hash === '#digest-view=expanded', `${width}: native 实际 hash 是 digest-view=expanded (${nativeState.report.hash})`);
    check(nativeState.report.view === 'expanded', `${width}: 宿主按 expanded 分支渲染`);
    check(nativeState.report.inlineRan === true, `${width}: 严格 CSP 仍允许内联脚本`);
    check(nativeState.report.parentAccess === 'blocked', `${width}: native 文档不能访问父 DOM (${nativeState.report.parentAccess})`);
    check(nativeState.csp.includes('blocked'), `${width}: 严格 CSP 阻断外联 (${JSON.stringify(nativeState.csp)})`);
    check(!started.requests.includes('/__csp-probe'), `${width}: 被 CSP 阻断的请求没有真的发出`);
    check(nativeState.report.preExpandVisible === false, `${width}: native 尾段展开前确实被隐藏`);
    check(nativeState.report.tailVisible === true, `${width}: native 尾段已按 expanded 显示`);
    check(nativeState.report.scrollWidth <= nativeState.report.innerWidth, `${width}: native 正文无横向溢出 (${nativeState.report.scrollWidth}/${nativeState.report.innerWidth})`);
    check(Number(nativeState.report.scrollHeight) > Number(nativeState.report.clientHeight) + 100, `${width}: native 正文足够长可滚动`);

    const nativeBody = await centerOf(cdp, '.feed-reader-body');
    await wheelScroll(cdp, { x: nativeBody.x, y: nativeBody.y }, { times: 16, deltaY: 380 });
    const nativeScrolled = await waitFor(
      cdp,
      `(() => { const last = window.__feedReader.reports.filter((entry) => entry.kind === 'native').slice(-1)[0]; return last && last.scrollTop + last.clientHeight >= last.scrollHeight - 4 ? last : null; })()`,
      `${width}: native 滚到正文末尾`,
    );
    check(nativeScrolled.tailInView === true, `${width}: native 尾哨兵滚到可视区`);
    await capture(cdp, `reader-native-${width}x${height}.png`);

    /* ---- 父层接受 token：真实 createFeedFeature/read-tracker 满 600ms 后按同 itemId 结算 ----
     * 不手动调 markReady、不直接发信号；只看假 /api/feed/signals 实际收到的内容。
     * read-tracker 对同一 itemId+revision 在一个页面生命周期内只结算一次，
     * 所以首个视口有界等待它到达，后续视口验证没有重复结算。 */
    const signalQuery = `(() => {
      const mine = window.__feedReader.signalBodies
        .flatMap((body) => (Array.isArray(body && body.signals) ? body.signals : []))
        .filter((signal) => signal && signal.itemId === ${JSON.stringify(ID_NATIVE)});
      const impression = mine.filter((signal) => signal.type === 'impression').length;
      const dwell = mine.filter((signal) => signal.type === 'dwell');
      return {
        impression: impression,
        dwell: dwell.length,
        value: dwell.length ? dwell[dwell.length - 1].value : 0,
        types: mine.map((signal) => signal.type),
        posts: window.__feedReader.calls.signals,
      };
    })()`;
    const nativeSignals = width === 320
      ? await waitFor(cdp, `(() => { const state = ${signalQuery}; return state.impression && state.dwell ? state : null; })()`, `${width}: native 阅读记账结算`, 15000)
      : await evaluate(cdp, signalQuery);
    console.log(`READER_SIGNALS ${width} ${JSON.stringify(nativeSignals)}`);
    check(nativeSignals.impression === 1, `${width}: 同一条目只报一次 impression (${nativeSignals.impression})`);
    check(nativeSignals.dwell === 1, `${width}: 同一条目只报一次 dwell (${nativeSignals.dwell})`);
    check(nativeSignals.types.join(',') === 'impression,dwell', `${width}: 成对 impression+dwell (${nativeSignals.types.join(',')})`);
    check(nativeSignals.value >= 600, `${width}: dwell 值达到 600ms（${nativeSignals.value}）`);

    /* ---- 阅读层返回：标题在可视区外，scrollTop 必须完全不变（preventScroll） ---- */
    await clickAtCurrent(cdp, '.feed-reader-back', `${width}: 阅读层返回`);
    await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, `${width}: 阅读层关闭`);
    const scrollBack = await evaluate(cdp, `(() => {
      const body = document.querySelector('.feed-body');
      const title = document.querySelector('.feed-item[data-item-id="${ID_NATIVE}"] .feed-item-title-btn');
      const bodyTop = body.getBoundingClientRect().top;
      return {
        scrollTop: body.scrollTop,
        titleStillOutOfView: title.getBoundingClientRect().bottom <= bodyTop + 1,
        focused: document.activeElement === title,
        readerFrames: document.querySelectorAll('.feed-reader iframe').length,
      };
    })()`);
    console.log(`READER_BACK_SCROLL ${width} ${JSON.stringify(Object.assign({ before: scrolledEntry.scrollTop }, scrollBack))}`);
    check(scrollBack.scrollTop === scrolledEntry.scrollTop, `${width}: 返回后 scrollTop 完全一致 (${scrollBack.scrollTop} vs ${scrolledEntry.scrollTop})`);
    check(scrollBack.titleStillOutOfView === true, `${width}: 标题仍在可视顶边之上，没被 focus 拉回`);
    check(scrollBack.focused === true, `${width}: 返回后焦点回到标题按钮`);
    check(scrollBack.readerFrames === 0, `${width}: 返回后阅读 iframe 已释放`);

    /* ---- 继续聊：重开阅读层后回到同一条目的编辑器，不建会话不发送 ---- */
    const nativeReportsBefore = await evaluate(cdp, `window.__feedReader.reports.filter((entry) => entry.kind === 'native').length`);
    await clickAtCurrent(cdp, readSelector, `${width}: 重开 native 阅读层`);
    await waitFor(cdp, `!!document.querySelector('.feed-reader iframe')`, `${width}: 重开阅读层 iframe`);
    await waitFor(cdp, `window.__feedReader.reports.filter((entry) => entry.kind === 'native').length > ${nativeReportsBefore}`, `${width}: 重开 native 假文档上报`);
    const prepareBefore = await evaluate(cdp, 'window.__feedReader.calls.prepare');
    await clickAtCurrent(cdp, '.feed-reader-ask', `${width}: 阅读层继续聊`);
    await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, `${width}: 继续聊先回列表`);
    const chatState = await evaluate(cdp, `(() => {
      const row = document.querySelector('.feed-item[data-item-id="${ID_NATIVE}"]');
      const question = row.querySelector('.feed-question');
      return {
        editorOpen: question.hidden === false,
        draft: row.querySelector('.feed-question-input').value,
        items: document.querySelectorAll('.feed-item').length,
        prepare: window.__feedReader.calls.prepare,
        create: window.__feedReader.calls.create,
        readerFrames: document.querySelectorAll('.feed-reader iframe').length,
      };
    })()`);
    check(chatState.editorOpen === true, `${width}: 继续聊打开原条目编辑器`);
    check(chatState.draft === '要跟进这件事吗？', `${width}: 编辑器沿用原有问题草稿`);
    check(chatState.create === 0, `${width}: 继续聊不自动创建会话`);
    check(chatState.prepare === prepareBefore, `${width}: 继续聊不自动发送/冻结`);
    check(chatState.readerFrames === 0, `${width}: 继续聊后阅读 iframe 已释放`);

    /* ---- 返回顺序：编辑器 → 日报 ---- */
    await clickSelector(cdp, '.feed-back', `${width}: 第一次返回`);
    const afterFirstBack = await evaluate(cdp, `({
      editorOpen: document.querySelector('.feed-item[data-item-id="${ID_NATIVE}"] .feed-question').hidden === false,
      feedOpen: window.__feedReader.feature.isOpen(),
    })`);
    check(afterFirstBack.editorOpen === false, `${width}: 第一次返回退出编辑器`);
    check(afterFirstBack.feedOpen === true, `${width}: 第一次返回不关日报`);

    // 收藏不误开阅读层。
    await clickSelector(cdp, `.feed-item[data-item-id="${ID_FOLIO}"] .feed-favorite`, `${width}: 收藏按钮`);
    await sleep(150);
    const afterFavorite = await evaluate(cdp, `({
      favorites: window.__feedReader.calls.favorites,
      readerHidden: document.querySelector('.feed-reader').hidden,
      readerFrames: document.querySelectorAll('.feed-reader iframe').length,
    })`);
    check(afterFavorite.favorites >= 1, `${width}: 收藏请求已发出`);
    check(afterFavorite.readerHidden === true && afterFavorite.readerFrames === 0, `${width}: 收藏不误开阅读层`);

    await clickSelector(cdp, '.feed-back', `${width}: 第二次返回`);
    await waitFor(cdp, 'window.__feedReader.feature.isOpen() === false', `${width}: 第二次返回关闭日报`);

    const chunkOffsets = await evaluate(cdp, 'window.__feedReader.calls.chunk.slice()');
    check(chunkOffsets.length >= 2, `${width}: native 多片拼接（${chunkOffsets.length} 片）`);
    check(await evaluate(cdp, 'window.__feedReader.errors.length === 0'), `${width}: 页面无脚本错误 (${JSON.stringify(await evaluate(cdp, 'window.__feedReader.errors.slice()'))})`);
    console.log(`VIEWPORT ${width}x${height} done; checks=${checks}`);
  }

  assert.ok(started.requests.includes('/features/feed.js'), '浏览器加载了真实 feature');
  assert.ok(started.requests.includes('/dist/app.css'), '浏览器加载了打包样式');
  assert.ok(started.requests.includes(FOLIO_URL), 'folio 假卡片网页被真实 iframe 请求');
  assert.ok(!started.requests.some((url) => url === '/dist/app.js'), '静态夹具不得加载真实 app 包');
  checks += 4;

  if (failures.length) {
    throw new assert.AssertionError({
      message: `${failures.length} 条阅读层契约失败:\n- ${failures.join('\n- ')}`,
    });
  }
  console.log(`PASS  真实浏览器阅读层验收：${checks} 项断言`);
  console.log(`PASS  证据目录：${path.relative(ROOT, ARTIFACT_DIR)}`);
} catch (error) {
  if (cdp) await dumpDiagnostics(cdp, error.message);
  console.error(`FAIL  真实浏览器阅读层验收\n      ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  if (browser?.child && browser.child.exitCode === null) {
    browser.child.kill();
    await Promise.race([
      new Promise((resolve) => browser.child.once('exit', resolve)),
      sleep(2000),
    ]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
}
