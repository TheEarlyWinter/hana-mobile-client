/**
 * 前端静态托管：把 web/ 目录发给浏览器。
 *
 * 顶层 HTML 加最小 CSP（frame-src 'self' 让卡片 iframe 可用）；
 * 其它资源不强套 sandbox，否则前端自己的脚本会被拦住。
 *
 * 缓存的判据是「这个 URL 的内容还会不会变」：构建产物名带内容哈希，可以发 immutable；
 * 页面、清单和源文件的名字都不带哈希，必须每次回源。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { WEB_ROOT } from './config.mjs';
import { MIME, isInsideRoot, pathKey, streamFileResponse } from './file-utils.mjs';
import { ASSET_NAME, DIST_DIRNAME, MANIFEST_NAME, readDistManifest } from './web-build.mjs';

const APP_HTML_CSP = "frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/*
 * 这里不再发 `clear-site-data: "cache"`。
 * 它当年是为了清掉「旧响应带着 30 天 max-age」的历史缓存，代价是每次导航都清一次该源的
 * HTTP 缓存。产物名现在跟着内容走、页面本身 no-store，版本切换不再靠清缓存，
 * 留着它只会把 immutable 白缓存一遍。
 */

/** 改了就必须立刻生效的文本资源：HTML / JS / CSS / JSON。 */
const TEXT_ASSET = /\.(html?|m?js|css|json|webmanifest)$/i;

/** 内容寻址的产物才配得上这个：名字跟着内容走，同一个 URL 永远不会换成别的内容。 */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** 每次都要回源的文本资源（页面与前端源文件）。 */
const NO_STORE = 'no-store, no-cache, must-revalidate';

/** 清单与 dist 下的非哈希文件：连条件请求都别指望，中间层一律别留。 */
const DIST_NO_STORE = 'no-store';

const DIST_ROOT = path.join(WEB_ROOT, DIST_DIRNAME);
const INDEX_HTML = path.join(WEB_ROOT, 'index.html');

/**
 * index.html 里这两个引用是稳定的（源文件不做构建期改写），
 * 真正的哈希文件名只在响应时按清单替换。顺序无关，但两个都得换。
 */
const STABLE_REFERENCES = [
  { stable: '/dist/app.js', resolve: (manifest) => `/dist/${manifest.js}` },
  { stable: '/dist/app.css', resolve: (manifest) => `/dist/${manifest.css}` },
];

/** 打包第一版的固定名 → 当前产物的兜底映射要用的两种。用 Map，别用对象：`in` 会认到原型链上的键。 */
const LEGACY_FIXED = new Map([
  ['app.js', 'js'],
  ['app.css', 'css'],
]);

/**
 * 清单每个请求最多多一次 stat：mtime 和大小都没变就不重新解析。
 * 不能「读一次就一直用」——构建会重写清单，那样新代码要等网关重启才生效。
 */
let manifestCache = { key: '', value: null };

async function distManifest() {
  let stat;
  try {
    stat = await fsp.stat(path.join(DIST_ROOT, MANIFEST_NAME));
  } catch {
    manifestCache = { key: '', value: null };
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (key === manifestCache.key) return manifestCache.value;
  const value = await readDistManifest(WEB_ROOT);
  manifestCache = { key, value };
  return value;
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

/**
 * 错误响应也要 no-store。哈希名被中间层（浏览器启发式缓存 / CDN）记成 404 之后，
 * 就算文件回来了客户端也拿不到——而哈希名恰好是「一定会被重新请求」的那种 URL。
 */
function sendPlain(res, status, body) {
  res
    .writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    .end(body);
}

export async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const target = path.resolve(WEB_ROOT, `.${pathname}`);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) {
    sendPlain(res, 403, 'forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    // 产物名已经换版：旧 HTML、旧标签页还会按旧名字来拿，用当前产物兜一下。
    if (await sendDistFallback(pathname, res, req)) return;
    if (!path.extname(pathname)) {
      return sendFile(path.join(WEB_ROOT, 'index.html'), res, req);
    }
    sendPlain(res, 404, '404');
    return;
  }

  if (stat.isDirectory()) {
    return sendFile(path.join(target, 'index.html'), res, req);
  }

  return sendFile(target, res, req, stat);
}

/**
 * 首页的正文按清单改写，所以只能整读一次；HEAD 也照读，
 * 否则 content-length 会和 GET 的实际正文对不上。
 * 清单缺失时原样发出：页面会按稳定名去取产物，多半 404，但绝不该变成 500。
 */
async function indexBody(filePath, manifest) {
  let html;
  try {
    html = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  if (manifest) {
    for (const ref of STABLE_REFERENCES) html = html.replaceAll(ref.stable, ref.resolve(manifest));
  }
  return Buffer.from(html, 'utf8');
}

function cacheControlFor({ isDist, ext, base, manifest }) {
  if (isDist) {
    // 清单里的 js / css / 分块都是内容寻址的（名字里带内容哈希），可以发 immutable。
    const contentAddressed = Boolean(manifest)
      && (base === manifest.js || base === manifest.css
        || (Array.isArray(manifest.chunks) && manifest.chunks.includes(base)));
    return contentAddressed ? IMMUTABLE : DIST_NO_STORE;
  }
  return TEXT_ASSET.test(ext) ? NO_STORE : 'no-cache';
}

/**
 * 这个路径问的是不是「构建产物本身」：固定名，或者哈希名形状。
 * 范围必须写死，否则一个不存在的 /dist/foo.js 也能拿到包，等于把兜底开成任意读。
 */
function fallbackKind(base) {
  const legacy = LEGACY_FIXED.get(base);
  if (legacy) return legacy;
  if (ASSET_NAME.js.test(base)) return 'js';
  if (ASSET_NAME.css.test(base)) return 'css';
  return null;
}

/**
 * 上一版产物的兜底：名字已不在磁盘上，用当前清单的产物回答。
 * 目的是「手机还挂着旧 HTML」时不白屏；代价是这个 URL 不再是内容寻址的，
 * 所以只能发 no-store，不能跟着 immutable。
 * @returns {Promise<boolean>} 是否已经回答过（false 交给调用方 404）
 */
async function sendDistFallback(pathname, res, req) {
  const target = path.resolve(WEB_ROOT, `.${pathname}`);
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) return false;
  if (!isInsideRoot(target, DIST_ROOT)) return false;

  const name = fallbackKind(path.basename(pathname));
  if (!name) return false;
  const manifest = await distManifest();
  if (!manifest) return false;

  const file = path.join(DIST_ROOT, manifest[name]);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': DIST_NO_STORE,
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return true;
  }
  await streamFileResponse(res, file, headers, stat.size);
  return true;
}

async function sendFile(filePath, res, req, knownStat) {
  let stat = knownStat;
  if (!stat) {
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendPlain(res, 404, '404');
      return;
    }
  }
  if (!stat.isFile()) {
    sendPlain(res, 404, '404');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const isHtml = ext === '.html' || ext === '.htm';
  const isDist = isInsideRoot(filePath, DIST_ROOT);
  const isIndex = samePath(filePath, INDEX_HTML);
  // 首页要靠清单改引用；dist 下要靠清单判断谁是内容寻址的。其它路径不碰清单。
  const manifest = isIndex || isDist ? await distManifest() : null;

  // ETag 只用元数据：条件请求在读正文之前就能判 304，不用为了算长度先读整个文件，
  // 也不再额外做一次同步 stat。首页额外带上清单哈希——清单换了就等于页面换了，
  // 不能让「源文件字节没变」把一个指向已删除产物的 304 发回去。
  const meta = `${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}`;
  const etag = `W/"${isIndex && manifest ? `${meta}-${manifest.hash}` : meta}"`;
  if (req.headers['if-none-match'] === etag) {
    const headers = { etag };
    if (isHtml) headers['content-security-policy'] = APP_HTML_CSP;
    res.writeHead(304, headers).end();
    return;
  }

  const body = isIndex ? await indexBody(filePath, manifest) : null;
  if (isIndex && !body) {
    sendPlain(res, 404, '404');
    return;
  }

  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body ? body.length : stat.size,
    'cache-control': cacheControlFor({ isDist, ext, base: path.basename(filePath), manifest }),
    etag,
  };
  if (isHtml) headers['content-security-policy'] = APP_HTML_CSP;
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  if (body) {
    res.writeHead(200, headers).end(body);
    return;
  }
  await streamFileResponse(res, filePath, headers, stat.size);
}
