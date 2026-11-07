#!/usr/bin/env node
// ui-probe —— 真机 WebView 里有哪些可点元素，以及「点这个选择器」到底该点屏幕哪个像素。
//
// 为什么要有这个：截图是 1080×2400，屏幕上显示成 900 宽，人眼量一遍再换算，
// 一错就点到隔壁。这里让页面自己报 getBoundingClientRect()（CSS 像素），
// 再用 WebView 在屏幕上的真实矩形把 CSS 换算成物理像素，最后 adb shell input tap。
//
// 调试通道是 CDP（webview_devtools_remote_<pid>），需要 debuggable 构建：
//   pwsh android/build.ps1 -Debuggable
// 没开调试端口时本工具会直接说明，而不是让你对着一张不动的截图猜。
//
// 零第三方依赖：Node 自带 fetch / WebSocket（Node 22+）+ child_process 调 adb。

import { DevtoolsError, renderError } from './lib/errors.mjs';
import { inputTap, readScreenSize, readWebViewFrame, removeForward } from './lib/adb.mjs';
import { CdpSession } from './lib/cdp.mjs';
import { assertWebView, openEndpoint } from './lib/attach.mjs';

const DEFAULT_SELECTOR = '[id],button,.icon-btn';
const DEFAULT_LIMIT = 200;

/* ------------------------------------------------------------------ */
/* 页面侧脚本：返回的都是纯 JSON（returnByValue），坐标是 CSS 像素      */
/* ------------------------------------------------------------------ */

const JS_HELPERS = `
  const pRect = (r) => ({
    x: Math.round(r.x * 100) / 100,
    y: Math.round(r.y * 100) / 100,
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
  });
  const pDesc = (el) => {
    if (!el) return null;
    const cls = typeof el.className === 'string' ? el.className : '';
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      id: el.id || '',
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      cls: cls,
      label: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '',
      text: text.slice(0, 60),
    };
  };
  const pViewport = () => ({
    w: innerWidth,
    h: innerHeight,
    dpr: devicePixelRatio,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    ua: navigator.userAgent,
  });
`;

/** 遍历候选元素，给出 id/文本/矩形/是否可见/该点最上层是谁。 */
function probeExpression(selector, limit) {
  return `(() => {${JS_HELPERS}
  const SEL = ${JSON.stringify(selector)};
  const LIMIT = ${Number(limit)};
  const nodes = Array.from(document.querySelectorAll(SEL));
  const items = [];
  let hidden = 0;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    if (!visible) hidden += 1;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    const d = pDesc(el) || { id: '', tag: '', cls: '', label: '', text: '' };
    items.push({
      id: d.id,
      tag: d.tag,
      cls: d.cls,
      label: d.label,
      text: d.text || d.label,
      rect: pRect(r),
      visible: visible,
      inView: inView,
      hitId: hit ? (hit.id || '') : '',
      hitTag: hit && hit.tagName ? hit.tagName.toLowerCase() : '',
      hitMatch: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
    });
    if (items.length >= LIMIT) break;
  }
  return {
    url: location.href,
    title: document.title,
    hanaShell: !!document.querySelector('meta[name="hana-shell"]'),
    viewport: pViewport(),
    total: nodes.length,
    hidden: hidden,
    shown: items.length,
    items: items,
  };
})()`;
}

/**
 * 找到选择器对应的元素，必要时滚进视口，给出中心点与该点最上层元素。
 *
 * scroll=false（--dry-run / --no-scroll）时表达式里的 SCROLL 编译成 false，运行时不会调用
 * scrollIntoView：dry-run 只看坐标，不改页面状态。分支文本保留在表达式里（离线假 CDP 靠它
 * 识别这是点击定位脚本），但那个分支永远进不去。
 */
function tapExpression(selector, { scroll = true } = {}) {
  return `(async () => {${JS_HELPERS}
  const SEL = ${JSON.stringify(selector)};
  const SCROLL = ${scroll ? 'true' : 'false'};
  let el = null;
  try {
    el = document.querySelector(SEL);
  } catch (e) {
    return { ok: false, reason: 'invalid-selector', message: String((e && e.message) || e), viewport: pViewport() };
  }
  if (!el) {
    const candidates = Array.from(document.querySelectorAll('[id],button,.icon-btn'))
      .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, 12)
      .map((n) => { const d = pDesc(n) || {}; return { id: d.id || '', text: (d.label || d.text || '').slice(0, 24) }; });
    return { ok: false, reason: 'not-found', viewport: pViewport(), candidates: candidates };
  }
  const cs = getComputedStyle(el);
  let r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden')) {
    return { ok: false, reason: 'not-visible', element: pDesc(el), rect: pRect(r), viewport: pViewport() };
  }
  const fullyInView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  let scrolled = false;
  if (!fullyInView && SCROLL) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    scrolled = true;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    r = el.getBoundingClientRect();
  }
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const inView = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
  const hit = inView ? document.elementFromPoint(cx, cy) : null;
  return {
    ok: true,
    element: pDesc(el),
    rect: pRect(r),
    cx: Math.round(cx * 100) / 100,
    cy: Math.round(cy * 100) / 100,
    inView: inView,
    scrolled: scrolled,
    hit: pDesc(hit),
    hitMatch: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
    viewport: pViewport(),
  };
})()`;
}

/* ------------------------------------------------------------------ */
/* 坐标换算：CSS 像素 → 屏幕物理像素                                    */
/* ------------------------------------------------------------------ */

/**
 * 换算需要三个数：WebView 在屏幕上的左上角（原点）、以及 CSS → 物理的缩放。
 *
 * 缩放不能直接拿 devicePixelRatio 当唯一依据：手机上它们通常相等（2.75 / 3），
 * 但 WebView 只占屏幕一部分（分屏、悬浮窗、平板）时就会差，点出来就偏。
 * 所以优先用 uiautomator 报的 WebView 矩形：宽高比就是各轴的缩放，左上角就是原点。
 * 拿不到时退回 dpr + 原点 0，并在输出里明确标成「估算」。
 */
function buildMapping({ viewport, frame, cli }) {
  let originX = 0;
  let originY = 0;
  let scaleX = viewport.dpr || 1;
  let scaleY = viewport.dpr || 1;
  const sources = [frame ? (frame.source || 'frame') : 'dpr'];

  if (frame && viewport.w > 0 && viewport.h > 0) {
    originX = frame.left;
    originY = frame.top;
    scaleX = frame.width / viewport.w;
    scaleY = frame.height / viewport.h;
  }
  if (typeof cli.scale === 'number' && cli.scale > 0) {
    scaleX = cli.scale;
    scaleY = cli.scale;
    sources.push('--scale');
  }
  if (typeof cli.offsetX === 'number') {
    originX = cli.offsetX;
    sources.push('--offset-x');
  }
  if (typeof cli.offsetY === 'number') {
    originY = cli.offsetY;
    sources.push('--offset-y');
  }
  return { originX, originY, scaleX, scaleY, source: sources.join('+'), estimated: !frame };
}

function mapPoint(cssX, cssY, mapping) {
  return {
    x: Math.round(mapping.originX + cssX * mapping.scaleX),
    y: Math.round(mapping.originY + cssY * mapping.scaleY),
  };
}

/** --frame "left,top,width,height"（物理像素）。 */
function parseFrameSpec(spec) {
  const parts = String(spec).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) {
    throw new DevtoolsError(
      `--frame 要四个数字：left,top,width,height，收到的是「${spec}」`,
      '例：--frame 0,63,1080,2202（左上角 x=0 y=63，宽 1080 高 2202）',
    );
  }
  return { left: parts[0], top: parts[1], width: parts[2], height: parts[3], source: '--frame' };
}

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    device: '',
    tap: '',
    selector: DEFAULT_SELECTOR,
    limit: DEFAULT_LIMIT,
    json: false,
    dryRun: false,
    port: 9222,
    cdpUrl: '',
    frame: '',
    offsetX: null,
    offsetY: null,
    scale: null,
    match: '',
    keepForward: false,
    timeout: 10000,
    noScroll: false,
    all: false,
    noFrame: false,
    noWebviewCheck: false,
    verbose: false,
    help: false,
  };
  const readValue = (name, i) => {
    if (i + 1 >= argv.length) throw new DevtoolsError(`参数 ${name} 后面缺一个值`, '--help 看用法');
    return argv[i + 1];
  };
  const readNumber = (name, i) => {
    const raw = readValue(name, i);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new DevtoolsError(`参数 ${name} 需要数字，收到「${raw}」`, '--help 看用法');
    return n;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--device':
      case '-s':
        opts.device = readValue(arg, i); i += 1; break;
      case '--tap':
        opts.tap = readValue(arg, i); i += 1; break;
      case '--selector':
        opts.selector = readValue(arg, i); i += 1; break;
      case '--limit':
        opts.limit = Math.max(1, Math.min(2000, Math.round(readNumber(arg, i)))); i += 1; break;
      case '--json':
        opts.json = true; break;
      case '--dry-run':
        opts.dryRun = true; break;
      case '--port':
        opts.port = Math.round(readNumber(arg, i)); i += 1; break;
      case '--cdp-url':
        opts.cdpUrl = readValue(arg, i); i += 1; break;
      case '--frame':
        opts.frame = readValue(arg, i); i += 1; break;
      case '--offset-x':
        opts.offsetX = readNumber(arg, i); i += 1; break;
      case '--offset-y':
        opts.offsetY = readNumber(arg, i); i += 1; break;
      case '--scale':
        opts.scale = readNumber(arg, i); i += 1; break;
      case '--match':
        opts.match = readValue(arg, i); i += 1; break;
      case '--keep-forward':
        opts.keepForward = true; break;
      case '--timeout':
        opts.timeout = Math.max(1000, Math.round(readNumber(arg, i))); i += 1; break;
      case '--no-scroll':
        opts.noScroll = true; break;
      case '--all':
        opts.all = true; break;
      case '--no-frame':
        opts.noFrame = true; break;
      case '--no-webview-check':
        opts.noWebviewCheck = true; break;
      case '--verbose':
        opts.verbose = true; break;
      case '-h':
      case '--help':
        opts.help = true; break;
      default:
        throw new DevtoolsError(`不认识的参数：${arg}`, '--help 看完整用法');
    }
  }
  return opts;
}


/* ------------------------------------------------------------------ */
/* 换算的输入：WebView 在屏幕上的矩形                                    */
/* ------------------------------------------------------------------ */

async function resolveFrame(opts, serial, log) {
  if (opts.frame) return parseFrameSpec(opts.frame);
  if (!serial || opts.noFrame) return null;
  if (opts.dryRun) {
    // dry-run 不探测设备：uiautomator dump 会往设备上写文件，还得再读一遍——预览坐标不该有这种副作用。
    log('提示：--dry-run 不跑 uiautomator（不落盘、不读默认 dump），坐标按 dpr + 原点 0 估算；要精确换算用 --frame 或 --offset-x/--offset-y');
    return null;
  }
  const frame = await readWebViewFrame(serial);
  if (!frame) {
    log('提示：拿不到 WebView 在屏幕上的矩形（uiautomator dump 失败），坐标按 dpr + 原点 0 估算；点偏了用 --frame 或 --offset-y 修正');
  }
  return frame;
}

/* ------------------------------------------------------------------ */
/* 输出：中文对齐的表（CJK 按两格算）                                    */
/* ------------------------------------------------------------------ */

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    // 全角/中日韩/emoji 近似按两格算，够用了
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncateDisplay(text, max) {
  const s = String(text == null ? '' : text);
  if (displayWidth(s) <= max) return s;
  let out = '';
  let width = 0;
  for (const ch of s) {
    const w = displayWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function padDisplay(text, max) {
  const s = truncateDisplay(text, max);
  return s + ' '.repeat(Math.max(0, max - displayWidth(s)));
}

function renderTable(rows) {
  const header = ['#', 'ID', '文本', 'CSS 中心', '物理点', '状态'];
  const body = rows.map((r, i) => [
    String(i + 1),
    r.id || '-',
    r.text || '-',
    `(${r.cssX}, ${r.cssY})`,
    r.tap ? `(${r.tap.x}, ${r.tap.y})` : '-',
    r.status,
  ]);
  const widths = [3, 22, 18, 18, 16, 6];
  const line = (cells) => cells.map((c, i) => padDisplay(c, widths[i])).join('  ').replace(/\s+$/, '');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

/* ------------------------------------------------------------------ */
/* 两条主流程                                                          */
/* ------------------------------------------------------------------ */

async function runList(session, opts, ep, log) {
  const probe = await session.evaluate(probeExpression(opts.selector, opts.limit), { timeout: opts.timeout });
  if (!probe.ok) {
    throw new DevtoolsError('页面里执行探测脚本抛错', '页面可能刚导航/刷新，重跑一次', probe.error);
  }
  const data = probe.value;
  if (!data || !Array.isArray(data.items)) {
    throw new DevtoolsError(
      '探测脚本没有返回预期结构（items 不是数组）',
      '页面可能不是 Hana 的页面；用 js-eval.mjs "document.title" 看一眼',
      JSON.stringify(data).slice(0, 300),
    );
  }
  assertWebView(data.viewport, opts);

  const frame = await resolveFrame(opts, ep.serial, log);
  const mapping = buildMapping({ viewport: data.viewport, frame, cli: opts });

  const visibleItems = opts.all ? data.items : data.items.filter((it) => it.visible);
  const rows = visibleItems.map((it) => {
    const cssX = Math.round((it.rect.x + it.rect.w / 2) * 10) / 10;
    const cssY = Math.round((it.rect.y + it.rect.h / 2) * 10) / 10;
    const status = !it.visible ? '隐藏' : (!it.inView ? '视口外' : (it.hitMatch ? '✓' : '遮挡'));
    return {
      id: it.id,
      text: it.label || it.text,
      cssX,
      cssY,
      tap: it.visible ? mapPoint(cssX, cssY, mapping) : null,
      status,
      hitId: it.hitId,
      hitTag: it.hitTag,
      rect: it.rect,
      inView: it.inView,
    };
  });

  const result = {
    device: ep.serial,
    pid: ep.pid,
    socket: ep.socketName,
    forwardPort: ep.forward ? ep.forward.port : null,
    target: { id: ep.target.id || '', title: ep.target.title || data.title, url: ep.target.url || data.url, type: ep.target.type || 'page' },
    page: { url: data.url, title: data.title, hanaShell: data.hanaShell },
    viewport: data.viewport,
    frame: frame
      ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height, source: frame.source }
      : null,
    mapping: {
      originX: mapping.originX,
      originY: mapping.originY,
      scaleX: Math.round(mapping.scaleX * 1000) / 1000,
      scaleY: Math.round(mapping.scaleY * 1000) / 1000,
      source: mapping.source,
      estimated: mapping.estimated,
    },
    selector: opts.selector,
    total: data.total,
    hidden: data.hidden,
    shown: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      text: r.text,
      rect: r.rect,
      center: { x: r.cssX, y: r.cssY },
      tap: r.tap,
      status: r.status,
      hitId: r.hitId,
      hitTag: r.hitTag,
    })),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const headerLines = [];
  headerLines.push(ep.serial
    ? `设备  ${ep.serial} · pid ${ep.pid} · ${ep.socketName} → 本机 tcp:${ep.forward ? ep.forward.port : '?'}`
    : `设备  （直连 CDP）${ep.wsUrl}`);
  headerLines.push(`页面  ${result.page.url}${result.page.hanaShell ? '  «Hana»' : '  «不是 Hana 的页面»'} · 标题「${result.page.title || ''}」`);
  headerLines.push(
    `视口  ${data.viewport.w}×${data.viewport.h} CSS · dpr ${data.viewport.dpr}`
      + ` · 滚动 (${data.viewport.scrollX}, ${data.viewport.scrollY})`,
  );
  headerLines.push(
    frame
      ? `换算  缩放 ${mapping.scaleX.toFixed(3)}×${mapping.scaleY.toFixed(3)} · 原点 (${mapping.originX}, ${mapping.originY}) · 来自 ${mapping.source}`
      : `换算  缩放 ${mapping.scaleX.toFixed(3)}×${mapping.scaleY.toFixed(3)} · 原点 (${mapping.originX}, ${mapping.originY}) · 估算（未拿到 WebView 屏幕矩形）`,
  );
  const hiddenNote = opts.all ? '' : `（另有 ${data.hidden} 个不可见已省略，加 --all 看到它们）`;
  headerLines.push(`候选  ${data.total} 个（${opts.selector}），显示 ${rows.length} 个${hiddenNote}`);

  process.stdout.write(`${headerLines.join('\n')}\n\n`);
  process.stdout.write(`${renderTable(rows)}\n`);
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runTap(session, opts, ep, log) {
  // dry-run 只看坐标：不滚动，避免为了算一个不点的位置而改变页面状态（懒加载、动画、滚动容器位置）。
  const res = await session.evaluate(tapExpression(opts.tap, { scroll: !opts.noScroll && !opts.dryRun }), { timeout: opts.timeout });
  if (!res.ok) {
    throw new DevtoolsError('页面里执行点击定位脚本抛错', '页面可能刚导航/刷新，重跑一次', res.error);
  }
  const found = res.value || {};
  if (!found.ok) {
    if (found.reason === 'not-found') {
      const list = (found.candidates || []).map((c) => `${c.id || '(无 id)'}${c.text ? `「${c.text}」` : ''}`).join('、');
      throw new DevtoolsError(
        `页面上没有匹配「${opts.tap}」的元素`,
        `当前可见候选（前 12 个）：${list || '（一个都没有）'}；也可以先跑不带 --tap 的 ui-probe 看全表`,
      );
    }
    if (found.reason === 'invalid-selector') {
      throw new DevtoolsError(
        `「${opts.tap}」不是合法的 CSS 选择器：${found.message}`,
        'id 用 #btnSend，类用 .icon-btn，属性用 [aria-label="发送"]',
      );
    }
    if (found.reason === 'not-visible') {
      throw new DevtoolsError(
        `元素「${opts.tap}」在 DOM 里但不可见（display:none / visibility:hidden / 尺寸 0）`,
        '多半是所在面板没打开；用 js-eval.mjs 确认状态（例如 document.querySelector("#panel").hidden）',
      );
    }
    throw new DevtoolsError(`点击定位失败：${found.reason || '未知原因'}`, '重跑一次，或先不带 --tap 看候选列表');
  }

  assertWebView(found.viewport, opts);
  // 非 dry-run 才把「不在视口」当错误：dry-run 不滚动，元素留在原地是预期结果，
  // 下面如实回报「视口外、未点击」，而不是替用户改页面状态或硬说点不了。
  if (!found.inView && !opts.dryRun) {
    throw new DevtoolsError(
      `元素「${opts.tap}」的中心点 (${found.cx}, ${found.cy}) 不在视口里`,
      '它可能被滚动容器裁掉了；先手动滚到可见区域，或用 --frame 校准后重试',
    );
  }

  const frame = await resolveFrame(opts, ep.serial, log);
  const mapping = buildMapping({ viewport: found.viewport, frame, cli: opts });
  const point = mapPoint(found.cx, found.cy, mapping);

  const screen = ep.serial ? await readScreenSize(ep.serial) : null;
  // 视口外是 dry-run 的预期结果，坐标只是「当前滚动位置下算出来的值」，不做屏幕边界裁决。
  if (found.inView && screen && (point.x < 0 || point.y < 0 || point.x >= screen.width || point.y >= screen.height)) {
    throw new DevtoolsError(
      `算出来的点在屏幕外：(${point.x}, ${point.y})，屏幕是 ${screen.width}×${screen.height}`,
      '换算参数不对：用 --frame "left,top,width,height" 直接给 WebView 矩形，或 --offset-y 补状态栏高度',
    );
  }

  if (!found.hitMatch && found.hit) {
    log(`警告：该点最上层是 ${found.hit.tag || '?'}#${found.hit.id || ''}「${found.hit.text || ''}」，不是目标元素本身；点击可能落在它上面`);
  }

  const el = found.element || {};
  const summary = {
    device: ep.serial,
    selector: opts.tap,
    element: { id: el.id || '', tag: el.tag || '', text: el.label || el.text || '' },
    css: { center: { x: found.cx, y: found.cy }, rect: found.rect, viewport: { w: found.viewport.w, h: found.viewport.h, dpr: found.viewport.dpr } },
    frame: frame
      ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height, source: frame.source }
      : null,
    mapping,
    tap: point,
    screen,
    inView: found.inView,
    scrolled: found.scrolled,
    hitMatch: found.hitMatch,
    dryRun: opts.dryRun,
    command: `adb${ep.serial ? ` -s ${ep.serial}` : ''} shell input tap ${point.x} ${point.y}`,
  };

  if (opts.dryRun) {
    const outOfView = !found.inView;
    const drySummary = {
      ...summary,
      tapped: false,
      ...(outOfView ? { note: '元素中心不在视口内；--dry-run 不滚动，未点击' } : {}),
    };
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(drySummary, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`目标  ${el.tag || '?'}#${el.id || ''}${(el.label || el.text) ? `「${el.label || el.text}」` : ''}\n`);
    process.stdout.write(`CSS   中心 (${found.cx}, ${found.cy}) · 矩形 ${found.rect.x},${found.rect.y} ${found.rect.w}×${found.rect.h} · 视口 ${found.viewport.w}×${found.viewport.h} dpr ${found.viewport.dpr}\n`);
    process.stdout.write(`换算  缩放 ${mapping.scaleX.toFixed(3)}×${mapping.scaleY.toFixed(3)} · 原点 (${mapping.originX}, ${mapping.originY}) · 来自 ${mapping.source}${mapping.estimated ? '（估算）' : ''}\n`);
    if (outOfView) {
      process.stdout.write(`视口外  元素中心 (${found.cx}, ${found.cy}) 不在视口内；--dry-run 不滚动，未点击\n`);
    }
    process.stdout.write(`试算  ${summary.command}（--dry-run，没有真的点）\n`);
    return 0;
  }

  if (!ep.serial) {
    throw new DevtoolsError(
      '没有设备，点不了：--tap 走的是 adb shell input tap',
      '加 --device <序列号>，或者加 --dry-run 只看坐标',
    );
  }

  await inputTap(ep.serial, point.x, point.y);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, tapped: true }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`目标  ${el.tag || '?'}#${el.id || ''}${(el.label || el.text) ? `「${el.label || el.text}」` : ''}\n`);
  process.stdout.write(`CSS   中心 (${found.cx}, ${found.cy}) · 矩形 ${found.rect.x},${found.rect.y} ${found.rect.w}×${found.rect.h} · 视口 ${found.viewport.w}×${found.viewport.h} dpr ${found.viewport.dpr}\n`);
  process.stdout.write(`换算  缩放 ${mapping.scaleX.toFixed(3)}×${mapping.scaleY.toFixed(3)} · 原点 (${mapping.originX}, ${mapping.originY}) · 来自 ${mapping.source}${mapping.estimated ? '（估算）' : ''}\n`);
  process.stdout.write(`点击  ${summary.command}\n`);
  process.stdout.write('已点击\n');
  return 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

function printHelp() {
  const lines = [
    'ui-probe —— 看真机 WebView 里有什么可点的，并按 CSS 选择器直接点它',
    '',
    '用法：',
    '  node scripts/devtools/ui-probe.mjs [选项]            # 列出可点元素（表格 + JSON）',
    '  node scripts/devtools/ui-probe.mjs --tap "#btnCasual" [选项]   # 找到它、点它的中心',
    '',
    '选项：',
    '  -s, --device <序列号>   目标设备；不写就用环境变量 HANA_ANDROID_SERIAL / ANDROID_SERIAL，',
    '                          再不行用唯一在线的设备（多台必须指定）',
    '      --tap <选择器>      按 CSS 选择器找元素中心并 adb shell input tap 它',
    '      --selector <css>    列出哪些元素，默认 "[id],button,.icon-btn"',
    '      --limit <n>         列表最多显示多少个，默认 200',
    '      --json              只输出 JSON（给脚本用）；默认是表头 + 表格 + JSON',
    '      --dry-run           只算坐标、不真点；不滚页面、不跑 uiautomator（坐标按 dpr 估算，',
    '                          给了 --frame 就用它；没有设备时也能看坐标）',
    '      --port <n>          adb forward 的本地端口，默认 9222，被占就往后找',
    '      --cdp-url <url>     跳过设备发现/转发，直连一个 CDP 端点（ws:// 或 http://）',
    '      --match <子串>      有多个可调试页面时，按 url/title 选一个',
    '      --frame <l,t,w,h>   直接给 WebView 在屏幕上的物理矩形，跳过 uiautomator',
    '      --offset-x/--offset-y <n>  只修正原点（补状态栏高度之类）',
    '      --scale <n>         强制指定 CSS→物理的缩放',
    '      --no-frame          不做 uiautomator，直接按 dpr 估算',
    '      --no-scroll         元素不在视口内时不自动滚进来',
    '      --all               连不可见元素一起列出',
    '      --keep-forward      跑完不删 adb forward（想留着用 chrome://inspect 时）',
    '      --timeout <ms>      单条 CDP/adb 的超时，默认 10000',
    '      --no-webview-check  跳过「这是不是 WebView」的 UA 检查',
    '      --verbose           出错时多打一层原始细节',
    '  -h, --help              这张说明',
    '',
    '坐标是怎么算的：',
    '  页面里 getBoundingClientRect() 给的是 CSS 像素，adb shell input tap 要的是屏幕物理像素。',
    '  本工具用 uiautomator dump 拿到 WebView 在屏幕上的矩形，缩放 = 矩形宽 / innerWidth，',
    '  原点 = 矩形左上角；拿不到矩形时才退回 devicePixelRatio + 原点 0（输出里会标「估算」）。',
    '  所以 1080×2400 的截图显示成 900 宽这种换算错误，在这里不会发生。',
    '',
    '前提：',
    '  App 必须是 debuggable 构建（壳里的 WebView 调试端口只在 FLAG_DEBUGGABLE 时打开）：',
    '    pwsh android/build.ps1 -Debuggable -VersionName "0.9.8-devtools" -VersionCode "11"',
    '  没开的话本工具会直接说「WebView 调试没开」，不会让你对着一张不动的截图猜坐标。',
    '',
    '例子：',
    '  node scripts/devtools/ui-probe.mjs',
    '  node scripts/devtools/ui-probe.mjs --device <序列号> --json',
    '  node scripts/devtools/ui-probe.mjs --tap "#btnCasual"',
    '  node scripts/devtools/ui-probe.mjs --tap "#btnSend" --dry-run',
    '  node scripts/devtools/ui-probe.mjs --tap ".icon-btn" --offset-y 63',
    '',
    '离线自检（不需要真机）：',
    '  node scripts/devtools/selftest.mjs',
    '',
    '状态（0.9.8-devtools 交付时写的，真机验证后可以删掉这行）：',
    '  交付时 adb devices 里没有任何设备，所以只做了离线自检（假 CDP 端点 + 假 adb），未在真机验证。',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${renderError(err, { verbose: true })}\n`);
    return 2;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }

  const log = (message) => process.stderr.write(`${message}\n`);
  let ep = null;
  let session = null;
  let forwardRemoved = false;

  // 退出前一定要把 forward 拆掉：留着一条 tcp:9222 指向已死 pid 的转发，下次就轮到别人踩坑
  const cleanup = async () => {
    if (session) session.close();
    if (ep && ep.forward && ep.forward.owned && !opts.keepForward && !forwardRemoved) {
      forwardRemoved = true;
      await removeForward(ep.serial, ep.forward.port);
    }
  };
  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(130));
  });

  try {
    ep = await openEndpoint(opts, log);
    session = await CdpSession.connect(ep.wsUrl, { timeout: opts.timeout });
    if (ep.forward && ep.forward.owned && opts.keepForward) {
      log(`提示：--keep-forward，跑完不会删 tcp:${ep.forward.port}（不用了记得 adb forward --remove tcp:${ep.forward.port}）`);
    }
    const code = opts.tap ? await runTap(session, opts, ep, log) : await runList(session, opts, ep, log);
    return code;
  } catch (err) {
    process.stderr.write(`${renderError(err, { verbose: opts.verbose })}\n`);
    return 1;
  } finally {
    await cleanup();
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((err) => {
  process.stderr.write(`${renderError(err, { verbose: true })}\n`);
  process.exitCode = 1;
});
