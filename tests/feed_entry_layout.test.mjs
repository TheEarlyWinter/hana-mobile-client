/*
 * 真实 Chromium 布局回归：读取实际首页 HTML/CSS 与日报 feature，替代 app 启动脚本，
 * 仅经内存假 API 供数。浏览器独立临时 profile 保留供排查，不连接真实网关/会话。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 这个文件全部成果都来自真实浏览器量出来的布局，没有浏览器就没有任何可验的部分：
// CI 用开关整文件跳过，并打成 SKIP 行让 runner 归入「跳过」而不是「通过」。
if (process.env.HANA_SKIP_BROWSER_TESTS === '1') {
  console.log('SKIP  因 HANA_SKIP_BROWSER_TESTS 跳过浏览器验收');
  process.exit(0);
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..');
const WEB_DIR = path.join(ROOT, 'web');
const RUN_TAG = process.env.FEED_READER_RUN_TAG || `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`;
const ARTIFACT_DIR = path.join(TEST_DIR, 'artifacts', 'feed-reader-bug', `run-${RUN_TAG}`);
const FAKE_ITEM_ID = 'fi_0123456789ABCDEFGHJKMNPQRS';
const FAKE_ITEM_TITLE = '虚构非空日报回归条目';
const FAKE_CARD_MESSAGE = '本地隔离假卡片正文已加载';
const FAKE_CARD_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离假卡片</title><body style="margin:0;padding:16px;font:18px sans-serif;background:#fffdf9;color:#243746"><main>${FAKE_CARD_MESSAGE}</main><script>window.parent.postMessage({__feedReaderFixtureCard:${JSON.stringify(FAKE_CARD_MESSAGE)}}, '*');window.parent.postMessage({__hanaCardHeight:320}, '*');</script></body></html>`;
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

function bootstrapScript() {
  return `<script type="module">
import { createFeedFeature } from '/features/feed.js';
const fakeItem = {
  itemId: '${FAKE_ITEM_ID}', revision: 1, lane: 'content', laneKind: 'content', template: 'folio-card',
  title: '${FAKE_ITEM_TITLE}', ask: '', topics: ['隔离测试'],
  source: { sourceId: 'fake-source', displayName: '隔离假日报' },
  createdAt: '2026-11-06T08:00:00.000Z', unread: true, favorite: false,
};
window.__feedApiCalls = [];
window.__feedUnread = 0;
window.__feedReaderFixtureEnabled = false;
window.__feedReaderErrors = [];
window.__feedRenderedCards = [];
window.addEventListener('error', (event) => window.__feedReaderErrors.push(event.message));
window.addEventListener('message', (event) => {
  if (event.data?.__feedReaderFixtureCard) window.__feedRenderedCards.push(event.data.__feedReaderFixtureCard);
});
const api = async (url, options = {}) => {
  const path = String(url);
  window.__feedApiCalls.push(path);
  if (path.startsWith('/api/feed/slate?')) {
    return {
      slateId: 'fake-slate',
      items: window.__feedReaderFixtureEnabled ? [fakeItem] : [],
      unreadTaskCount: window.__feedUnread, cursor: null, nextPatrolAt: null,
    };
  }
  if (path === '/api/feed/items/${FAKE_ITEM_ID}/card' && options.method === 'POST') {
    return { cardId: 'isolated-fake-card', revision: 1, documentPath: 'index.html' };
  }
  if (path === '/api/feed/signals' && options.method === 'POST') {
    return { accepted: 1, unreadTaskCount: window.__feedUnread };
  }
  throw new Error('unexpected fake API path: ' + path);
};
const feature = createFeedFeature({
  api,
  document,
  window,
  getIdentity: () => ({ id: 'isolated-browser-layout-test' }),
  getNavigationEpoch: () => 0,
  getSession: () => null,
  openSession: async () => {},
  sendPrepared: async () => ({ frameWritten: false, committed: false }),
});
document.getElementById('view-list').hidden = false;
feature.mount();
feature.mount();
window.__feedLayoutTest = {
  feature,
  async setUnread(value, { keepOpen = false } = {}) {
    window.__feedUnread = value;
    await feature.open();
    const badge = document.querySelector('#btnFeed .feed-entry-badge');
    const result = badge ? { hidden: badge.hidden, text: badge.textContent } : null;
    if (!keepOpen) feature.close();
    return result;
  },
};
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
  const replacement = bootstrapScript();
  let html = index
    .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
    .replace(/<link rel="stylesheet" href="([^"]+)"\s*\/>/g, (_tag, href) => (
      ['/dist/app.css'].includes(href)
        ? _tag
        : ''
    ));
  const appScript = /<script src="\/dist\/app\.js" type="module"><\/script>/;
  assert.match(html, appScript, '真实首页必须包含可替换的 app 启动脚本');
  html = html.replace(appScript, replacement);

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
    if (pathname === `/gw/feed/${FAKE_ITEM_ID}/r1/`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FAKE_CARD_HTML);
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
          }, 15_000);
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

async function waitFor(cdp, expression, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(cdp, expression);
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
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

async function inspectLayout(cdp) {
  return evaluate(cdp, `(async () => {
    const rect = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    };
    const overlapArea = (a, b) => (!a || !b ? 0 : Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)));
    const button = document.getElementById('btnFeed');
    const dock = document.getElementById('homeComposerDock');
    const composer = document.getElementById('homeComposer');
    const textarea = document.getElementById('homeInput');
    const send = document.getElementById('btnHomeSend');
    const hint = document.getElementById('homeMemoryHint');
    const hero = document.getElementById('companionHero');
    const carouselWrapper = document.querySelector('.agent-carousel-wrapper');
    const stage = document.getElementById('homeStage');
    if (!button || !dock || !composer || !textarea || !send) return {
      mounted:!!button, dock:!!dock, composer:!!composer, textarea:!!textarea, send:!!send,
      duplicateCount:document.querySelectorAll('#btnFeed').length,
    };
    // 窄高视口允许正常页面滚动让输入器可达；滚动前先记录真实溢出，不隐藏任何内容。
    const beforeScroll = stage ? { scrollTop:stage.scrollTop, scrollHeight:stage.scrollHeight, clientHeight:stage.clientHeight } : null;
    const composerBefore = rect(composer);
    const needsScroll = composerBefore.top < 0 || composerBefore.bottom > innerHeight;
    if (needsScroll) {
      composer.scrollIntoView({ block: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // scrollIntoView 对齐后仍可能有亚像素越界；按实际溢出补齐 1px，不靠断言容差。
      if (stage) {
        const afterFirst = composer.getBoundingClientRect();
        if (afterFirst.bottom > innerHeight) stage.scrollTop += (afterFirst.bottom - innerHeight) + 1;
        else if (afterFirst.top < 0) stage.scrollTop += afterFirst.top - 1;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }
    const b = rect(button);
    const c = rect(composer);
    const t = rect(textarea);
    const sendRect = rect(send);
    const hintRect = rect(hint);
    const wrapperRect = rect(carouselWrapper);
    const exposedY = Math.min(b.bottom, c.top) - 12;
    const exposedX = b.left + b.width / 2;
    const exposedTarget = document.elementFromPoint(exposedX, exposedY);
    const inputTarget = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    const sendTarget = document.elementFromPoint(sendRect.left + sendRect.width / 2, sendRect.top + sendRect.height / 2);
    return {
      mounted:true,
      parentId:button.parentElement?.id || null,
      dockComposerChild:composer.parentElement === dock,
      duplicateCount:document.querySelectorAll('#btnFeed').length,
      viewport:{ width:innerWidth, height:innerHeight },
      button:b,
      dock:rect(dock),
      composer:c,
      textarea:t,
      send:sendRect,
      hint:hintRect,
      hero:rect(hero),
      heroText:hero ? (hero.textContent || '').trim() : '',
      carouselWrapper:wrapperRect,
      overlapHintArea:hintRect ? Number(overlapArea(b, hintRect).toFixed(2)) : null,
      overlapWrapperArea:wrapperRect ? Number(overlapArea(b, wrapperRect).toFixed(2)) : null,
      paperTopInsideDock:b.top >= rect(dock).top - 0.5,
      dockPaddingTop:getComputedStyle(dock).paddingTop,
      scroll:{ needed:needsScroll, before:beforeScroll, after:stage ? stage.scrollTop : null },
      exposedHeight:Math.max(0, Math.min(b.bottom, c.top) - b.top),
      exposedTargetIsButton:button.contains(exposedTarget),
      inputTargetIsTextarea:textarea.contains(inputTarget),
      sendTargetIsButton:send.contains(sendTarget),
      exposedPoint:{ x:exposedX, y:exposedY },
    };
  })()`);
}

async function capture(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await fsp.writeFile(path.join(ARTIFACT_DIR, filename), Buffer.from(result.data, 'base64'));
}

async function dispatchClickAt(cdp, point) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickAt(cdp, point) {
  await dispatchClickAt(cdp, point);
  await waitFor(cdp, 'window.__feedLayoutTest.feature.isOpen()', 'exposed newspaper button click');
  await evaluate(cdp, 'window.__feedLayoutTest.feature.close()');
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
  assert.ok(edgePath, 'Edge/Chrome executable is required for the independent real-layout regression');
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
  await waitFor(cdp, 'window.__feedLayoutTest && document.readyState === "complete"', 'isolated page and real feature mount');

  const initial = await evaluate(cdp, `(() => ({
    dock:!!document.getElementById('homeComposerDock'),
    composerParent:document.getElementById('homeComposer')?.parentElement?.id || null,
    button:!!document.getElementById('btnFeed'),
    duplicateCount:document.querySelectorAll('#btnFeed').length,
    appScript:[...document.scripts].some((script) => script.src.endsWith('/dist/app.js')),
  }))()`);
  assert.equal(initial.appScript, false, '真实 app 启动脚本不得在隔离浏览器中运行');
  assert.equal(initial.dock, true, '真实首页必须提供日报专用输入岛定位容器');
  assert.equal(initial.composerParent, 'homeComposerDock', '输入岛必须是局部定位容器的直接子项');
  assert.equal(initial.button, true, '日报 feature 应在新 dock 中挂载入口');
  assert.equal(initial.duplicateCount, 1, '重复 mount 不得产生多个入口');
  checks += 5;

  for (const [width, height] of [[320, 568], [360, 800], [411, 858], [320, 390]]) {
    await setViewport(cdp, width, height);
    const layout = await inspectLayout(cdp);
    console.log(`GEOMETRY ${width}x${height} ${JSON.stringify({
      paper: layout.button,
      dock: layout.dock,
      composer: layout.composer,
      hint: layout.hint,
      hero: layout.hero,
      wrapper: layout.carouselWrapper,
      exposed: layout.exposedHeight,
      overlapHintArea: layout.overlapHintArea,
      overlapWrapperArea: layout.overlapWrapperArea,
      dockPaddingTop: layout.dockPaddingTop,
      scroll: layout.scroll,
    })}`);
    check(layout.mounted === true, `${width}x${height}: button mounted`);
    check(layout.parentId === 'homeComposerDock', `${width}x${height}: button belongs to local dock`);
    check(layout.dockComposerChild === true, `${width}x${height}: composer remains inside dock`);
    check(layout.duplicateCount === 1, `${width}x${height}: one entry after repeated init`);
    check(layout.button.width >= 44 && layout.button.height >= 44, `${width}x${height}: target is at least 44px`);
    check(layout.exposedHeight >= 44, `${width}x${height}: exposed hit region is at least 44px high (got ${layout.exposedHeight})`);
    check(layout.button.left >= 0 && layout.button.right <= width, `${width}x${height}: entry stays inside horizontal viewport`);
    check(layout.button.top >= 0 && layout.button.bottom <= height, `${width}x${height}: entry stays inside vertical viewport`);
    check(layout.button.top < layout.composer.top, `${width}x${height}: paper is above composer edge`);
    check(Boolean(layout.hint && layout.hint.height > 0), `${width}x${height}: memory hint is visible for overlap check`);
    check(Boolean(layout.hero && layout.hero.height > 0 && layout.heroText), `${width}x${height}: companion hero text is present, not hidden`);
    check(layout.overlapHintArea === 0, `${width}x${height}: paper must not cover memory hint (area ${layout.overlapHintArea}, paper ${JSON.stringify(layout.button)}, hint ${JSON.stringify(layout.hint)})`);
    check(layout.overlapWrapperArea === 0, `${width}x${height}: paper must not cover agent carousel wrapper (area ${layout.overlapWrapperArea}, paper ${JSON.stringify(layout.button)}, wrapper ${JSON.stringify(layout.carouselWrapper)})`);
    check(layout.paperTopInsideDock === true, `${width}x${height}: paper top must stay inside dock (paper ${JSON.stringify(layout.button)}, dock ${JSON.stringify(layout.dock)})`);
    check(layout.exposedTargetIsButton === true, `${width}x${height}: exposed paper point resolves to entry`);
    check(layout.inputTargetIsTextarea === true, `${width}x${height}: textarea retains hit target`);
    check(layout.sendTargetIsButton === true, `${width}x${height}: send retains hit target`);
    check(layout.composer.top >= 0 && layout.composer.bottom <= height, `${width}x${height}: composer stays in viewport (${JSON.stringify(layout.composer)})`);
    if ((width === 360 && height === 800) || (width === 320 && height === 568)) {
      const badge = await evaluate(cdp, 'window.__feedLayoutTest.setUnread(3, { keepOpen:true })');
      check(badge?.hidden === false && badge?.text === '3', 'screenshot badge uses fake slate count 3');
      await evaluate(cdp, `(() => { const view = document.querySelector('.feed-view'); if (view) view.hidden = true; return true; })()`);
      await capture(cdp, width === 360 ? 'feed-entry-360x800-r1.png' : 'feed-entry-320x568-r1.png');
      await evaluate(cdp, 'window.__feedLayoutTest.feature.close()');
    }
    if (layout.exposedTargetIsButton) {
      await clickAt(cdp, layout.exposedPoint);
      check(true, `${width}x${height}: exposed newspaper click opened feed`);
    } else {
      check(false, `${width}x${height}: cannot click exposed newspaper point (not the entry)`);
    }
    console.log(`VIEWPORT ${width}x${height} checks recorded`);
  }

  for (const [count, expected] of [[0, { hidden: true, text: '0' }], [3, { hidden: false, text: '3' }], [137, { hidden: false, text: '99+' }]]) {
    const actual = await evaluate(cdp, `window.__feedLayoutTest.setUnread(${count})`);
    assert.deepEqual(actual, expected, `unread badge for ${count}`);
    checks += 1;
    console.log(`PASS  badge ${count} -> ${expected.hidden ? 'hidden' : expected.text}`);
  }

  const fakeApiCalls = await evaluate(cdp, 'window.__feedApiCalls.slice()');
  assert.ok(fakeApiCalls.length >= 7, 'open and exposed clicks should issue simulated slate requests');
  assert.ok(fakeApiCalls.every((url) => url.startsWith('/api/feed/slate?')), `only fake slate API is allowed: ${fakeApiCalls.join(', ')}`);
  assert.ok(started.requests.includes('/features/feed.js'), 'browser loaded the real feed feature module');
  assert.ok(started.requests.includes('/dist/app.css'), 'browser loaded the bundled stylesheet');
  assert.ok(!started.requests.some((url) => url === '/dist/app.js'), 'static fixture must not load real app bundle');
  checks += 4;

  if (failures.length) {
    throw new assert.AssertionError({
      message: `${failures.length} layout contract failures:\n- ${failures.join('\n- ')}`,
    });
  }
  console.log(`PASS  isolated browser profile retained: ${profile}`);
  console.log(`PASS  home screenshots: ${path.relative(ROOT, ARTIFACT_DIR)}\\feed-entry-360x800-r1.png, feed-entry-320x568-r1.png (r0 images untouched)`);

  await evaluate(cdp, 'window.__feedReaderFixtureEnabled = true; window.__feedUnread = 3; true');
  for (const [width, height] of [[320, 568], [360, 800], [411, 858]]) {
    await setViewport(cdp, width, height);
    await evaluate(cdp, 'window.__feedLayoutTest.feature.close(); window.__feedRenderedCards.length = 0; window.__feedLayoutTest.feature.open()');
    await waitFor(cdp, `document.querySelector('.feed-item-title')?.textContent === ${JSON.stringify(FAKE_ITEM_TITLE)}`, `${width}: non-empty fake slate item`);
    const listFrames = await evaluate(cdp, `({ all: document.querySelectorAll('iframe').length, inItem: document.querySelectorAll('.feed-item iframe').length, cards: document.querySelectorAll('.feed-card').length })`);
    check(listFrames.all === 0 && listFrames.inItem === 0 && listFrames.cards === 0, `${width}: 列表阶段零 iframe / 零卡片 (${JSON.stringify(listFrames)})`);

    const layout = await evaluate(cdp, `(() => {
      const rect = (node) => {
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height };
      };
      const text = (node) => {
        if (!node) return { lines:0, width:0 };
        const range = document.createRange();
        range.selectNodeContents(node);
        const boxes = [...range.getClientRects()];
        return { lines:boxes.length, width:range.getBoundingClientRect().width };
      };
      const panel = document.querySelector('.feed-view');
      const head = document.querySelector('.feed-head');
      const back = document.querySelector('.feed-back');
      const title = document.querySelector('.feed-title');
      const badge = document.querySelector('.feed-head .feed-badge');
      const refresh = document.querySelector('.feed-refresh');
      const itemTitle = document.querySelector('.feed-item-title');
      const h = rect(head), b = rect(back), t = rect(title), n = rect(badge), f = rect(refresh);
      const textRects = [back, refresh].map((button) => {
        const r = rect(button), label = text(button), css = getComputedStyle(button);
        return { rect:r, lines:label.lines, textWidth:label.width,
          contentWidthEnough:r && r.width + 0.5 >= label.width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) };
      });
      return {
        back:textRects[0], refresh:textRects[1],
        title:{ rect:t, text:title?.textContent, width:t?.width || 0, inHeader:!!(t && h && t.left >= h.left && t.right <= h.right) },
        badge:{ rect:n, text:badge?.textContent, hidden:badge?.hidden, inHeader:!!(n && h && n.left >= h.left && n.right <= h.right) },
        titleBadgeSeparate:!!(t && n && (t.right <= n.left || n.right <= t.left)),
        header:{ rect:h, clientWidth:head?.clientWidth || 0, scrollWidth:head?.scrollWidth || 0 },
        horizontalOverflow:document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth || (head?.scrollWidth || 0) > (head?.clientWidth || 0),
        item:{ title:itemTitle?.textContent, visible:!!(itemTitle && rect(itemTitle).width > 0) },
        readButtons:document.querySelectorAll('.feed-read').length,
        fixtureCards:window.__feedRenderedCards.slice(),
      };
    })()`);
    console.log(`FEED_TOPBAR ${width}x${height} ${JSON.stringify(layout)}`);
    check(layout.back.lines === 1, `${width}: 返回文字必须单行（${layout.back.lines} 行）`);
    check(layout.refresh.lines === 1, `${width}: 刷新文字必须单行（${layout.refresh.lines} 行）`);
    check(layout.back.rect.width >= 44 && layout.back.rect.height >= 44, `${width}: 返回触控区至少 44x44 (${JSON.stringify(layout.back.rect)})`);
    check(layout.refresh.rect.width >= 44 && layout.refresh.rect.height >= 44, `${width}: 刷新触控区至少 44x44 (${JSON.stringify(layout.refresh.rect)})`);
    check(layout.back.contentWidthEnough && layout.refresh.contentWidthEnough, `${width}: 文字按钮宽度应容纳标签与内边距`);
    check(layout.title.width >= 32 && layout.title.inHeader, `${width}: 顶栏标题未被挤出 (${JSON.stringify(layout.title)})`);
    check(layout.badge.hidden === false && layout.badge.text === '3' && layout.badge.inHeader, `${width}: 未读角标未被挤出 (${JSON.stringify(layout.badge)})`);
    check(layout.titleBadgeSeparate, `${width}: 标题与未读角标不重叠`);
    check(layout.horizontalOverflow === false, `${width}: 页面/顶栏不得横向溢出 (${JSON.stringify(layout.header)})`);
    check(layout.item.title === FAKE_ITEM_TITLE && layout.item.visible, `${width}: 非空日报标题保持可见`);
    check(layout.readButtons === 1, `${width}: 每条日报都有阅读全文入口`);
    check(layout.fixtureCards.length === 0, `${width}: 列表阶段不真正加载假正文`);
    await capture(cdp, `feed-list-${width}x${height}.png`);

    // 同 revision 刷新：真点顶栏刷新按钮，列表行不重建、也不因此取正文。
    await evaluate(cdp, 'window.__feedInitialRow = document.querySelector(".feed-item"); true');
    const beforeRefresh = await evaluate(cdp, 'window.__feedApiCalls.filter((url) => url.startsWith("/api/feed/slate?")).length');
    const refreshRect = await evaluate(cdp, '(() => { const r = document.querySelector(".feed-refresh").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()');
    await dispatchClickAt(cdp, refreshRect);
    await waitFor(cdp, `window.__feedApiCalls.filter((url) => url.startsWith('/api/feed/slate?')).length > ${beforeRefresh}`, 'actual refresh button slate request');
    await sleep(120);
    const refreshState = await evaluate(cdp, `(() => ({
      sameRow:window.__feedInitialRow === document.querySelector('.feed-item'),
      title:document.querySelector('.feed-item-title')?.textContent || '',
      iframes:document.querySelectorAll('iframe').length,
      fixtureCards:window.__feedRenderedCards.slice(),
    }))()`);
    console.log(`FEED_REFRESH ${width} ${JSON.stringify(refreshState)}`);
    check(refreshState.sameRow, '同 revision 刷新必须保留同一列表行');
    check(refreshState.title === FAKE_ITEM_TITLE && refreshState.iframes === 0 && refreshState.fixtureCards.length === 0, '刷新后列表仍不取正文');

    // 阅读全文：真点按钮进入阅读层，假卡片才真正被加载。
    const readPoint = await evaluate(cdp, '(() => { const r = document.querySelector(".feed-read").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2, width:r.width, height:r.height }; })()');
    check(readPoint.width >= 44 && readPoint.height >= 44, `${width}: 阅读全文触控区至少 44x44 (${JSON.stringify(readPoint)})`);
    await dispatchClickAt(cdp, readPoint);
    await waitFor(cdp, `document.querySelector('.feed-reader')?.hidden === false`, `${width}: 阅读层打开`);
    await waitFor(cdp, `!!document.querySelector('.feed-reader iframe')`, `${width}: 阅读层 iframe 挂载`);
    await waitFor(cdp, `window.__feedRenderedCards.includes(${JSON.stringify(FAKE_CARD_MESSAGE)})`, `${width}: 本地假卡片正文已加载`);
    const readerLayout = await evaluate(cdp, `(() => {
      const frame = document.querySelector('.feed-reader iframe');
      const body = document.querySelector('.feed-reader-body');
      const r = frame.getBoundingClientRect();
      return {
        hidden: document.querySelector('.feed-reader').hidden,
        frameInlineHeight: frame.style.height,
        frameHeight: r.height,
        bodyHeight: body.clientHeight,
        pageIframes: document.querySelectorAll('iframe').length,
        readerIframes: document.querySelectorAll('.feed-reader iframe').length,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        fixtureCards: window.__feedRenderedCards.slice(),
      };
    })()`);
    console.log(`FEED_READER ${width}x${height} ${JSON.stringify(readerLayout)}`);
    check(readerLayout.hidden === false, `${width}: 阅读层可见`);
    check(readerLayout.pageIframes === 1 && readerLayout.readerIframes === 1, `${width}: 全页只有阅读层一个 iframe (${readerLayout.pageIframes})`);
    check(readerLayout.frameInlineHeight === '100%', `${width}: 阅读 iframe 走 100% 高度链（${readerLayout.frameInlineHeight}）`);
    check(readerLayout.frameHeight >= 200 && Math.abs(readerLayout.frameHeight - readerLayout.bodyHeight) <= 2, `${width}: 阅读 iframe 撑满可用高度 (${readerLayout.frameHeight} vs ${readerLayout.bodyHeight})`);
    check(readerLayout.horizontalOverflow === false, `${width}: 阅读层无横向溢出`);
    check(readerLayout.fixtureCards.includes(FAKE_CARD_MESSAGE), `${width}: 仅阅读层加载了假正文`);
    await capture(cdp, `feed-reader-${width}x${height}-before-back.png`);

    if (width === 320) {
      // 同 revision 刷新：阅读 iframe 节点保留，不重建。
      await evaluate(cdp, 'window.__feedInitialFrame = document.querySelector(".feed-reader iframe"); true');
      const beforeReaderRefresh = await evaluate(cdp, 'window.__feedApiCalls.filter((url) => url.startsWith("/api/feed/slate?")).length');
      await evaluate(cdp, 'window.__feedLayoutTest.feature.refresh(); true');
      await waitFor(cdp, `window.__feedApiCalls.filter((url) => url.startsWith('/api/feed/slate?')).length > ${beforeReaderRefresh}`, 'reader open refresh slate request');
      await sleep(150);
      const kept = await evaluate(cdp, `(() => ({
        sameFrame:window.__feedInitialFrame === document.querySelector('.feed-reader iframe'),
        readerHidden:document.querySelector('.feed-reader').hidden,
        iframes:document.querySelectorAll('iframe').length,
      }))()`);
      console.log(`FEED_READER_REFRESH ${width} ${JSON.stringify(kept)}`);
      check(kept.sameFrame, '同 revision 刷新必须保留同一阅读 iframe 节点');
      check(kept.readerHidden === false && kept.iframes === 1, '刷新后阅读层仍在且仍只有一个 iframe');

      // 重开：先退出阅读层、关日报，再重新进入阅读层。
      await dispatchClickAt(cdp, await evaluate(cdp, '(() => { const r = document.querySelector(".feed-reader-back").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()'));
      await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, 'reader back hides reader');
      const afterReaderBack = await evaluate(cdp, `({ items:document.querySelectorAll('.feed-item').length, iframes:document.querySelectorAll('iframe').length, open:window.__feedLayoutTest.feature.isOpen() })`);
      check(afterReaderBack.items === 1 && afterReaderBack.iframes === 0 && afterReaderBack.open === true, `阅读层返回释放 iframe 并保留列表 (${JSON.stringify(afterReaderBack)})`);

      await evaluate(cdp, 'window.__feedLayoutTest.feature.close(); window.__feedRenderedCards.length = 0; window.__feedLayoutTest.feature.open()');
      await waitFor(cdp, `document.querySelector('.feed-item-title')?.textContent === ${JSON.stringify(FAKE_ITEM_TITLE)}`, 'reopen: non-empty fake slate item');
      await dispatchClickAt(cdp, await evaluate(cdp, '(() => { const r = document.querySelector(".feed-read").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()'));
      await waitFor(cdp, `!!document.querySelector('.feed-reader iframe')`, 'reopen: reader iframe');
      await waitFor(cdp, `window.__feedRenderedCards.includes(${JSON.stringify(FAKE_CARD_MESSAGE)})`, 'reopen: fake card reloaded');
      const reopened = await evaluate(cdp, `(() => ({
        title:document.querySelector('.feed-item-title')?.textContent || '',
        readerHidden:document.querySelector('.feed-reader').hidden,
        iframes:document.querySelectorAll('iframe').length,
        fixtureCards:window.__feedRenderedCards.slice(),
      }))()`);
      console.log(`FEED_REOPEN ${width} ${JSON.stringify(reopened)}`);
      check(reopened.title === FAKE_ITEM_TITLE && reopened.readerHidden === false && reopened.iframes === 1 && reopened.fixtureCards.includes(FAKE_CARD_MESSAGE), '重开后阅读层仍能加载正文');
      await dispatchClickAt(cdp, await evaluate(cdp, '(() => { const r = document.querySelector(".feed-reader-back").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()'));
      await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, 'reopen: reader closed before topbar back');
    }

    // 阅读层会遮住顶栏：先用阅读层自己的返回退出，再测顶栏返回。
    const readerStillOpen = await evaluate(cdp, `document.querySelector('.feed-reader')?.hidden === false`);
    if (readerStillOpen) {
      await dispatchClickAt(cdp, await evaluate(cdp, '(() => { const r = document.querySelector(".feed-reader-back").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()'));
      await waitFor(cdp, `document.querySelector('.feed-reader').hidden === true`, `${width}: 退出阅读层`);
    }

    await evaluate(cdp, 'window.__feedReaderErrors.length = 0');
    const backPoint = await evaluate(cdp, '(() => { const r = document.querySelector(".feed-back").getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 }; })()');
    await dispatchClickAt(cdp, backPoint);
    await waitFor(cdp, 'document.querySelector(".feed-view")?.hidden === true || window.__feedReaderErrors.some((message) => message.includes("TypeError"))', `${width}: topbar return click dispatch`, 2000);
    const afterBack = await evaluate(cdp, `({ closed:document.querySelector('.feed-view')?.hidden === true, errors:window.__feedReaderErrors.slice() })`);
    console.log(`FEED_BACK ${width} ${JSON.stringify(afterBack)}`);
    check(afterBack.closed, `${width}: 实际点击返回应关闭日报（捕获错误：${JSON.stringify(afterBack.errors)}）`);
    check(!afterBack.errors.some((message) => message.includes('TypeError')), `${width}: 顶栏返回 click 不应报 TypeError（${JSON.stringify(afterBack.errors)}）`);
    await evaluate(cdp, 'window.__feedLayoutTest.feature.close()');
  }

  assert.ok(started.requests.includes(`/gw/feed/${FAKE_ITEM_ID}/r1/`), '本地 fake card webpage must be requested by the real iframe');
  assert.ok((await evaluate(cdp, `window.__feedApiCalls.some((url) => url === "/api/feed/items/${FAKE_ITEM_ID}/card")`)), 'reading full text must request the fake card API');
  checks += 2;
  if (failures.length) {
    throw new assert.AssertionError({
      message: `${failures.length} topbar contract failures:\n- ${failures.join('\n- ')}`,
    });
  }
  console.log(`PASS  isolated fake card webpage and artifacts: ${path.relative(ROOT, ARTIFACT_DIR)}`);
  console.log(`\n${checks}/${checks} assertions passed`);
} catch (error) {
  console.error(`FAIL  real browser entry layout\n      ${error.stack || error.message}`);
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
