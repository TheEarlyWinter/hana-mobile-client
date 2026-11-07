/**
 * 卡片托管：把卡片目录当静态资源发给前端。
 *
 * 职责范围：
 *   - 两条路由共用一份托管内核：/gw/card（session-files）与 /gw/feed（宿主日报烘焙卡片）
 *   - 卡片目录白名单与越界判定（realpath 之后再比）
 *   - 卡片 CSP、runtime 注入、高度上报脚本
 *   - 短时令牌（sandbox iframe 的子资源带不上 SameSite=Strict Cookie）
 *
 * 令牌 Map 与 logout 撒销都在这里；HTTP 反代只调 revokeCardTokens()。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_SCHEME, GATEWAY_SCHEME, HANA_HOME } from './config.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';
import { MIME, isInsideRoot, realpathOrNull, resolveInsideRoots, streamFileResponse } from './file-utils.mjs';

/** 只允许从这些目录下读卡片，别的一概拒绝。 */
const CARD_ALLOWED_ROOTS = [path.join(HANA_HOME, 'session-files')];

/**
 * 卡片 CSP 里允许的 scheme：对外 scheme 在前。
 * 只有一种情况会多列一项：公网 TLS 在网关外终止（tunnel 模式），此时对外是 https，
 * 而本机监听仍是 http，两种入口都可能被真正打开。
 */
const CARD_CSP_SCHEMES =
  EXTERNAL_SCHEME === GATEWAY_SCHEME ? [EXTERNAL_SCHEME] : [EXTERNAL_SCHEME, GATEWAY_SCHEME];

/** 唯一的公开卡片 runtime 模块；不开放 shared 目录或仓库其它文件。 */
const CARD_RUNTIME_URL = new URL('../shared/card-runtime.mjs', import.meta.url);
const CARD_RUNTIME_FILE = fileURLToPath(CARD_RUNTIME_URL);
export const CARD_RUNTIME_PATH = '/shared/card-runtime.mjs';
let cardRuntimePromise = null;

/**
 * 卡片 iframe 是 sandbox（opaque origin），子资源带不上 SameSite=Strict Cookie。
 * HTML 导航鉴权通过后发一张只绑定该卡片目录的短时令牌，子资源靠它读取；
 * 令牌不可预测、进程内有界，过期/跨目录/越界一律拒绝。
 */
const CARD_TOKEN_PREFIX = 't_';
const CARD_TOKEN_RE = /^t_[A-Za-z0-9_-]{43}$/;
const CARD_TOKEN_TTL_MS = (() => {
  const raw = Number(process.env.HANA_GW_CARD_TOKEN_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 5 * 60_000;
  return Math.min(raw, 30 * 60_000);
})();
const CARD_TOKEN_MAX = Math.max(1, Number(process.env.HANA_GW_CARD_TOKEN_MAX) || 1000);

const CARD_RESIZE = `<script>
(function(){
  var last=-1,tick=0;
  function post(){
    var h=Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0);
    if(h===last)return;
    last=h;
    parent.postMessage({__hanaCardHeight:h},'*');
  }
  window.addEventListener('load',post);
  if(window.ResizeObserver){new ResizeObserver(post).observe(document.documentElement);}
  // 兜底复查只跑前 10 秒（图表、字体加载完会变高），之后停掉。
  // 常驻定时器在长会话里会堆成几十个，白耗电。
  var timer=setInterval(function(){post();if(++tick>=12){clearInterval(timer);}},800);
  post();
})();
<\/script>`;

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

/** 唯一公开的 shared runtime 文件；不做目录托管，不做仓库静态根。 */
export async function serveSharedCardRuntime(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end('method not allowed');
    return;
  }

  let buf;
  try {
    buf = await fsp.readFile(CARD_RUNTIME_FILE);
  } catch {
    denyCardRuntime(res);
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(buf);
}

/** 懒加载 shared runtime：缺失时只在真正要渲染卡片时 503，不拖垮网关启动。 */
async function loadCardRuntimeScript() {
  if (!cardRuntimePromise) {
    cardRuntimePromise = import(CARD_RUNTIME_URL.href).then((mod) => {
      if (typeof mod.CARD_RUNTIME_SCRIPT !== 'string' || !mod.CARD_RUNTIME_SCRIPT.trim()) {
        throw new Error('CARD_RUNTIME_SCRIPT missing');
      }
      return mod.CARD_RUNTIME_SCRIPT;
    });
  }
  return cardRuntimePromise;
}

export function denyCardRuntime(res) {
  res
    .writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    .end('card runtime unavailable');
}

/** 只接受可解析、无 userinfo/路径/查询/fragment 的 Host；避免把 Host 拼进 CSP 时注入。 */
function validatedCardHost(req) {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || !raw || raw.length > 255) return '';
  if (!/^[A-Za-z0-9._:\[\]-]+$/.test(raw)) return '';
  try {
    // 按对外 scheme 解析：Host 带 ":443" 时归一成默认端口，拼进 CSP 的地址与浏览器真实请求一致。
    const parsed = new URL(`${EXTERNAL_SCHEME}://${raw}/`);
    if (parsed.username || parsed.password) return '';
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.host;
  } catch {
    return '';
  }
}

/** 卡片 CSP：只允许本卡 token/目录前缀、data/blob 与 inline，禁止外网和嵌套。 */
function cardCsp(req, routeBase, token) {
  if (token && !CARD_TOKEN_RE.test(token)) return '';
  const host = validatedCardHost(req);
  if (!host) return '';
  const suffix = token ? `${token}/` : '';
  // 对外 scheme 在前：公网可能在网关外终止 TLS，那时必须是 https。
  // 网关自己还在本机用另一种 scheme 监听时（tunnel 模式：本机 http + 公网 https），也列出
  // 本机 scheme，否则直接打开 http://127.0.0.1:24000 的本地页会取不到卡片脚本。两种都钉死
  // 同一个 Host 与同一个令牌路径；https 页面不会被 http 源降级（混合内容本来就被拦）。
  const prefixes = CARD_CSP_SCHEMES.map((scheme) => `${scheme}://${host}${routeBase}${suffix}`).join(' ');
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${prefixes}`,
    `style-src 'unsafe-inline' ${prefixes}`,
    `img-src data: blob: ${prefixes}`,
    `font-src data: blob: ${prefixes}`,
    `media-src data: blob: ${prefixes}`,
    `connect-src ${prefixes}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** 在 <head> 开头（无 head 则 doctype/html 后）注入 runtime，保证早于所有业务脚本。 */
function injectCardRuntime(html, runtimeScript) {
  const script = String(runtimeScript).replace(/<\/script/gi, '<\\/script');
  const tag = `<script>\n${script}\n</script>`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${tag}`);
  }
  if (/<!doctype\b[^>]*>/i.test(html)) {
    return html.replace(/<!doctype\b[^>]*>/i, (match) => `${match}\n${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n${tag}`);
  }
  return `${tag}\n${html}`;
}

/* ------------------------------------------------------------------ */
/* 卡片资源短时令牌                                                     */
/* ------------------------------------------------------------------ */

/** token -> { dirKey, expiresAt }；只存内存，进程重启即全部失效。 */
const cardTokens = new Map();
/** logout 后递增；无 token 的在途请求若跨越 logout，不得再 mint 新 token。 */
let cardAuthEpoch = 0;

function pruneExpiredCardTokens(now) {
  for (const [token, entry] of cardTokens) {
    if (entry.expiresAt <= now) cardTokens.delete(token);
  }
}

function mintCardToken(dirKey) {
  const now = Date.now();
  pruneExpiredCardTokens(now);
  // 有界：超过上限就丢最旧的（Map 保持插入顺序）
  while (cardTokens.size >= CARD_TOKEN_MAX) {
    const oldest = cardTokens.keys().next().value;
    cardTokens.delete(oldest);
  }
  const token = `${CARD_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  cardTokens.set(token, { dirKey, expiresAt: now + CARD_TOKEN_TTL_MS });
  return token;
}

function lookupCardToken(token, dirKey) {
  const entry = cardTokens.get(token);
  if (!entry) return { ok: false };
  if (entry.expiresAt <= Date.now()) {
    cardTokens.delete(token);
    return { ok: false, expired: true };
  }
  if (entry.dirKey !== dirKey) return { ok: false, mismatch: true };
  return { ok: true };
}

/** 服务端明确 logout 成功后调用：所有已发出的卡片令牌立即失效。 */
export function revokeCardTokens() {
  cardTokens.clear();
  cardAuthEpoch += 1;
}

/* ------------------------------------------------------------------ */
/* 共享卡片托管内核                                                     */
/* ------------------------------------------------------------------ */

/** 目录 URL 只由服务器拼；内核再挡一道，避免奇怪字符混进 Location 与 CSP。 */
const CARD_ROUTE_BASE_RE = /^\/(?:[A-Za-z0-9._~-]+\/)+$/;

function validRouteBase(routeBase) {
  if (typeof routeBase !== 'string' || !CARD_ROUTE_BASE_RE.test(routeBase)) return '';
  for (const segment of routeBase.slice(1, -1).split('/')) {
    if (segment === '.' || segment === '..') return '';
  }
  return routeBase;
}

/**
 * 令牌绑定到目录 URL（同一条目同一版本）。比较区分大小写：base64 目录名里的大小写
 * 就是不同目录，不能借大小写把令牌用到另一张卡上。
 */
function routeBaseTokenKey(routeBase) {
  return routeBase.slice(0, -1);
}

function plain(res, status, message, extraHeaders) {
  res
    .writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...(extraHeaders || {}) })
    .end(message);
}

/**
 * 卡片目录托管内核：旧 /gw/card 与日报 /gw/feed 共用这一份鉴权、令牌、CSP 与流式实现。
 *
 * routeBase 是服务器拼好的目录 URL（必带末尾斜线），resourcePath 是该目录下的相对资源
 * 路径（可以带令牌段）。resolveDirectory 返回经过边界检查的真实目录，或给出拒绝结果；
 * 两条路由的差异只在怎么解析入口、怎么解析目录。
 * 调用方必须先同步解析路径再调用这里；logout epoch 在任何 await 之前捕获。
 */
export async function serveCardDirectory(req, res, { routeBase, resourcePath, resolveDirectory } = {}) {
  // 认证前捕获 epoch；logout 成功后递增，让跨越 logout 的旧 auth 请求不能 mint。
  const authEpoch = cardAuthEpoch;
  const base = validRouteBase(routeBase);
  if (!base) {
    plain(res, 400, 'bad card route');
    return;
  }
  if (typeof resourcePath !== 'string') {
    plain(res, 400, 'bad card path');
    return;
  }

  // 令牌固定是路径里的第一段；没有它就走 Cookie（老链接、直接访问、首次导航）
  let tail = resourcePath;
  let token = null;
  const firstSegment = tail.split('/')[0];
  if (CARD_TOKEN_RE.test(firstSegment)) {
    token = firstSegment;
    tail = tail.slice(firstSegment.length);
    if (tail.startsWith('/')) tail = tail.slice(1);
  }

  if (token) {
    const tokenState = lookupCardToken(token, routeBaseTokenKey(base));
    if (!tokenState.ok) {
      const status = tokenState.mismatch ? 403 : 401;
      plain(res, status, status === 403 ? 'forbidden' : 'unauthorized', {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return;
    }
  } else {
    const auth = await checkReadAuth(req);
    if (!auth.ok) return denyRead(res, auth);
  }

  const dirCheck = await resolveDirectory();
  if (!dirCheck || dirCheck.ok !== true) {
    const status = Number.isInteger(dirCheck?.status) ? dirCheck.status : 403;
    const message =
      typeof dirCheck?.message === 'string' && dirCheck.message ? dirCheck.message : 'card root not allowed';
    plain(res, status, message);
    return;
  }
  const realDir = dirCheck.dirReal;
  if (typeof realDir !== 'string' || !realDir) {
    throw new Error('card directory resolver returned no directory');
  }

  let rel;
  try {
    rel = tail ? decodeURIComponent(tail) : '';
  } catch {
    plain(res, 400, 'bad card path');
    return;
  }
  if (!rel) rel = 'index.html';

  // 相对路径 / ../ 都不允许离开卡片目录；软链接文件同样按 realpath 结果判定
  const realTarget = await realpathOrNull(path.resolve(realDir, rel));
  if (!realTarget) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }
  if (!isInsideRoot(realTarget, realDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('path escapes card');
    return;
  }

  const ext = path.extname(realTarget).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';

  if (isHtml && !validatedCardHost(req)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad card host');
    return;
  }

  // HTML 卡片必须带有统一 runtime；模块缺失时明确 503，绝不静默退回无桥页面。
  let cardRuntimeScript = null;
  if (isHtml) {
    try {
      cardRuntimeScript = await loadCardRuntimeScript();
    } catch {
      denyCardRuntime(res);
      return;
    }
  }

  // 首次导航：发一张只属于这个目录的短时令牌，重定向到令牌路径，
  // sandbox iframe 里的相对资源（CSS/图片/fetch）就都落在令牌范围内。
  if (isHtml && !token) {
    if (authEpoch !== cardAuthEpoch) {
      res
        .writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        .end('unauthorized');
      return;
    }
    const minted = mintCardToken(routeBaseTokenKey(base));
    res.writeHead(302, {
      location: `${base}${minted}/${tail}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-length': 0,
    });
    res.end();
    return;
  }

  const type = MIME[ext] || 'application/octet-stream';
  const csp = cardCsp(req, base, token);
  if (!csp) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad card host');
    return;
  }

  // 所有成功卡片资源都带同卡 CSP；SVG 被导航为文档时也受网络限制。
  // 只加响应头，不强制 attachment，也不改变 MIME/脚本执行方式。
  const headers = {
    'content-type': type,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': csp,
  };
  // 只有令牌响应需要跨源可读：sandbox iframe 的 origin 是 opaque，fetch/XHR 按跨源
  // 处理。令牌仍是必需的；不带令牌的 Cookie 路径不需要这个头。
  if (token) headers['access-control-allow-origin'] = '*';

  // 非 HTML 资源不需要注入：GET 直接流式发出，HEAD 只回元数据。
  // 大图/大附件不再整文件进内存；stat 之后文件消失时由流式助手回 404。
  if (!isHtml) {
    let stat;
    try {
      stat = await fsp.stat(realTarget);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    headers['content-length'] = stat.size;
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    await streamFileResponse(res, realTarget, headers, stat.size);
    return;
  }

  // HTML 卡片必须完整读取：runtime 注入与源版本都依赖原始正文，不能流式直发。
  let buf;
  try {
    buf = await fsp.readFile(realTarget);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  // 源版本必须对原始 index.html 的 UTF8 字符串计算；runtime/resize 注入发生在之后。
  const source = buf.toString('utf8');
  const sourceVersion = `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;

  let html = source;
  html = injectCardRuntime(html, cardRuntimeScript);
  html = html.includes('</body>')
    ? html.replace('</body>', `${CARD_RESIZE}</body>`)
    : html + CARD_RESIZE;
  buf = Buffer.from(html, 'utf8');

  headers['content-length'] = buf.length;
  headers['x-hana-card-source-version'] = sourceVersion;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(buf);
}

/**
 * 旧路由：/gw/card/<base64url 目录>/...
 * 目录仍只认 CARD_ALLOWED_ROOTS（session-files）；日报的 feed 目录不借旧路由放出。
 */
export async function serveCard(req, res, pathname) {
  const rest = pathname.slice('/gw/card/'.length);
  const slash = rest.indexOf('/');
  const encoded = slash === -1 ? rest : rest.slice(0, slash);
  const resourcePath = slash === -1 ? '' : rest.slice(slash + 1);

  let dir;
  try {
    dir = b64urlDecode(decodeURIComponent(encoded));
  } catch {
    plain(res, 400, 'bad card id');
    return;
  }
  const dirPath = path.resolve(dir);

  return serveCardDirectory(req, res, {
    routeBase: `/gw/card/${encoded}/`,
    resourcePath,
    resolveDirectory: async () => {
      const dirCheck = await resolveInsideRoots(dirPath, CARD_ALLOWED_ROOTS, 'card root not allowed');
      if (!dirCheck.realPath) return { ok: false, status: dirCheck.status, message: dirCheck.message };
      return { ok: true, dirReal: dirCheck.realPath };
    },
  });
}
