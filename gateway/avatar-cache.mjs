/**
 * 头像缩放缓存：把上游的原图（1024×1024 PNG，单张 1.4~2.3MB）缩成本机缓存的 WebP
 * 再发给手机，省掉冷启动里最大的一笔流量。
 *
 * 为什么放在网关而不是客户端：手机上的显示尺寸只有几十到一百多 px，
 * 98% 的字节是纯浪费；而 `gateway/avatar-pack.mjs` 的聚合端点对 >128KB 的图直接
 * `skipped: ["too-big"]`，所以这些头像会退化成逐张下载原图。缩放只能在**能读到原图**
 * 的那一侧做，也就是和 hana-server 同机的网关。
 *
 * 三条边界，顺序不能换：
 *   1. 命中磁盘缓存 → 直接回，**不回源**（冷启动 5 张头像 = 5 次回环 + 0 次隧道字节）；
 *   2. 未命中 → 回环取原图（不占隧道带宽）→ sharp 缩放 → 写盘 → 回；
 *   3. **任何一步出问题都返回 false**，交回 server.mjs 的普通反代按原样处理。
 *      缩放是优化，不是功能：sharp 装坏了、图坏了、盘满了，头像也必须能显示，
 *      只是慢一点、大一点。同理 `sharp` 是惰性 import —— 顶层 import 会让
 *      「sharp 的二进制没装好」直接变成「网关起不来」。
 *
 * 缓存键与文件名：
 *   - 文件名 `<id>-<原图 sha256 前 16 位>.webp`：内容寻址，同一张原图永远同名，
 *     换图自然换名；`<id>` 已经过 `parseAvatarIds` 的字符集校验（`[A-Za-z0-9._:-]{1,64}`，
 *     且拒 `.` / `..`），拼不出目录外的路径。
 *   - 进程内索引 `scope → { file, etag, ts }`：让「二次请求不回源」成立。
 *     网关重启后索引为空，第一次请求会回源一次（回环）算内容哈希，但命中已有文件时
 *     直接复用、不重编码，所以重启的代价只有一次几毫秒的回环请求。
 *   - `scope` 对 agent 头像是 id 本身（内容全局一致）；对 `/api/avatar/user` 额外带
 *     Cookie 身份哈希 —— **用户头像按账号不同**，共用一份磁盘文件会把 A 的头像发给 B，
 *     所以 user 作用域只认进程内索引，重启后第一次请求必然回源（只回环，不花隧道流量）。
 *
 * 响应头现在给 `public, max-age=300`（5 分钟）而不是一年 immutable。
 *
 * 之前的写法是错的：URL `/api/agents/<id>/avatar` 是稳定的，但内容会变（用户换头像）。
 * 发 `immutable` 等于告诉浏览器「这个地址永远不用再问」，换了头像客户端就一直看旧图，
 * 服务端无法纠正——只能等浏览器自己淘汰缓存。缩略图已经只有十几 KB，5 分钟后重新问一次、
 * 内容没变就回 304（几百字节），代价远小于「头像改了看不见」。
 *
 * 要彻底隐蔽这一跳，得让前端给 `<img src>` 带版本键（例如按宿主给的更新时间拼 `?v=`）：
 * URL 一变就是新资源，缓存可以重新给长周期。那需要前端能拿到版本号，不在本模块范围内。
 *
 * etag 用**实际发出的 WebP 字节**的 sha256 前 16 位，而不是文件名里那个原图哈希，
 * 所以换缩放参数（maxPx / quality）或换原图都会让 etag 变化，不会把旧图 304 出去。
 *
 * 只有 `/api/avatar/user` 额外带 `vary: cookie`：那份内容是按账号变的，不能声明成
 * 与 Cookie 无关的公共资源。
 *
 * 进程内索引还带一个 `revalidateMs`（默认 10 分钟）：过期后下一次请求会重新回源比一次哈希
 * （回环，几毫秒），内容没变就只续期、不重编码。这是网关自己的缓存层，与浏览器策略无关。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseAvatarIds, USER_AVATAR_ID } from './avatar-pack.mjs';
import { etagMatches } from './etag.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认缓存目录：`gateway/cache/avatars/`（已进 .gitignore）。 */
export const DEFAULT_AVATAR_CACHE_DIR = path.join(HERE, 'cache', 'avatars');

/** 长边上限。手机上的头像最大也就 100 多 px，256 已是 2x/3x 屏的余量。 */
export const AVATAR_MAX_PX = 256;
export const AVATAR_WEBP_QUALITY = 80;

/** 同一 id 最多留几份（新的一份 + 1 份旧的）：留给并发读取时还没换过来的读者。 */
export const AVATAR_CACHE_FILES_PER_ID = 2;
/** 进程内索引条数上限：一次最多十几个 agent，给足余量即可，超了按插入顺序淘汰。 */
export const AVATAR_INDEX_MAX_ENTRIES = 256;
/**
 * 浏览器缓存策略。
 *
 * 不能给 `immutable`：URL 稳定、内容会变（换头像），immutable 会让浏览器再也不来问。
 * 5 分钟足够吸掉首屏并发，又不会让换头像后干等；命中期问只会多一次 304（几百字节）。
 */
export const AVATAR_CACHE_CONTROL = 'public, max-age=300';

/** 索引有效期：过期后回源比一次内容哈希（回环），与上面的浏览器策略是两层，互不影响。 */
export const AVATAR_REVALIDATE_MS = 10 * 60_000;
/** 单张原图解码后的像素上限：防解压炸弹（正常源图 1024×1024）。 */
export const AVATAR_MAX_INPUT_PIXELS = 64_000_000;

export const AGENT_AVATAR_PREFIX = '/api/agents/';
export const AGENT_AVATAR_SUFFIX = '/avatar';
export const USER_AVATAR_PATH = '/api/avatar/user';

/** 内容哈希：16 位 hex 足够区分（同一 id 的历任头像不可能撞）。 */
function contentHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Cookie 身份哈希，只用于进程内作用域，不落盘、不进文件名。 */
function identityOf(cookie) {
  return createHash('sha256').update(String(cookie || ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 路由判定：命中返回 `{ id, kind }`，否则 null。
 *
 * 只认两种**精确**路径形态（请求方法由 handle 限定为 GET/HEAD）：
 *   - `/api/agents/<id>/avatar`（id 规则完全复用 avatar-pack 的 parseAvatarIds）
 *   - `/api/avatar/user`
 * 带查询串/片段、大小写不符、多一层路径、百分号编码别名（`%2F`）、
 * 非法 id（空、超长、`.` / `..`、字符集外）一律不碰 —— 交回反代，
 * 让上游按它自己的规则决定 404 还是 302，网关不在这里发明语义。
 *
 * `/api/agents/user/avatar` 也拒绝：文件名是 `<id>-<hash>.webp`，agent 版 `user`
 * 会和用户头像 `/api/avatar/user` 撞同一个前缀，宁可这一条不加速。
 */
export function matchAvatarPath(rawUrl) {
  // 非 origin-form（绝对形式等）不认：网关路由只会收到 origin-form。
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;

  let url;
  try {
    url = new URL(rawUrl, 'http://localhost');
  } catch {
    return null;
  }
  // 带查询串/片段就不认：缓存按路径内容寻址，查询串可能改变上游语义（如 ?fresh=1）。
  if (url.search || url.hash) return null;

  const pathname = url.pathname;
  if (pathname === USER_AVATAR_PATH) return { id: USER_AVATAR_ID, kind: 'user' };

  if (!pathname.startsWith(AGENT_AVATAR_PREFIX)) return null;
  const rest = pathname.slice(AGENT_AVATAR_PREFIX.length);
  if (!rest.endsWith(AGENT_AVATAR_SUFFIX)) return null;
  const rawId = rest.slice(0, rest.length - AGENT_AVATAR_SUFFIX.length);

  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  // 与 avatar-pack 同一套 id 规则（字符集 / 长度 / `.` 与 `..` / `user` 特例）。
  const parsed = parseAvatarIds(id);
  if (!parsed.ok || parsed.ids.length !== 1) return null;
  // parseAvatarIds 会 trim：`%20x` 变成 `x` 就不算「同一个 id」了，按不命中处理。
  if (parsed.ids[0] !== id) return null;
  // 见函数头：避开与用户头像的文件名冲突。
  if (id === USER_AVATAR_ID) return null;
  return { id, kind: 'agent' };
}

/* ------------------------------------------------------------------ */
/* sharp：惰性加载                                                     */
/* ------------------------------------------------------------------ */

let sharpPromise = null;

/**
 * 只在真正要缩图时加载。加载失败**不缓存失败结果**（下次再试，用户可能刚装好），
 * 但本次一律当作「不可用」→ 退回原代理，绝不让网关因为头像缩放而起不来。
 */
function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => mod.default ?? mod)
      .catch((err) => {
        sharpPromise = null;
        throw err;
      });
  }
  return sharpPromise;
}

/* ------------------------------------------------------------------ */
/* 端点                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} [options.cacheDir]        缓存目录，默认 gateway/cache/avatars
 * @param {Function} options.fetchUpstream   `(id, ctx) => Promise<{ ok: true, bytes: Buffer } | null>`
 *                                           ctx 是 `{ cookie, userAgent }`，供注入方带上与普通反代
 *                                           同一套鉴权头。非 ok / 抛错 / 非 Buffer 都按「不处理」。
 * @param {number} [options.maxPx]           长边上限，默认 256
 * @param {number} [options.quality]         WebP quality，默认 80
 * @param {number} [options.revalidateMs]    索引有效期，默认 10 分钟；0 表示每次都回源比对
 * @param {number} [options.filesPerId]      同一 id 最多保留几份文件，默认 2
 * @param {Function} [options.checkAuth]     鉴权实现，默认 checkReadAuth（与 avatar-pack 同一条路）
 * @param {Function} [options.deny]          拒绝实现，默认 denyRead
 * @param {Function} [options.log]           诊断日志 `(line: string) => void`
 * @param {Function} [options.now]           时间源，测试可注入
 */
export function createAvatarCache({
  cacheDir = DEFAULT_AVATAR_CACHE_DIR,
  fetchUpstream,
  maxPx = AVATAR_MAX_PX,
  quality = AVATAR_WEBP_QUALITY,
  revalidateMs = AVATAR_REVALIDATE_MS,
  filesPerId = AVATAR_CACHE_FILES_PER_ID,
  checkAuth = checkReadAuth,
  deny = denyRead,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  if (typeof fetchUpstream !== 'function') {
    throw new TypeError('createAvatarCache 需要注入 fetchUpstream(id, ctx)');
  }
  const safeMaxPx = Number.isFinite(maxPx) && maxPx > 0 ? Math.floor(maxPx) : AVATAR_MAX_PX;
  const safeQuality = Number.isFinite(quality) && quality >= 0 && quality <= 100
    ? Math.floor(quality)
    : AVATAR_WEBP_QUALITY;
  const safeFilesPerId = Number.isFinite(filesPerId) && filesPerId >= 1
    ? Math.floor(filesPerId)
    : AVATAR_CACHE_FILES_PER_ID;
  const revalidate = revalidateMs === Infinity
    ? Infinity
    : Number.isFinite(revalidateMs) && revalidateMs >= 0
      ? revalidateMs
      : AVATAR_REVALIDATE_MS;

  /** `scope → { file, etag, ts }`；只存元数据，字节永远以磁盘文件为准。 */
  const index = new Map();
  /** `scope → Promise`：同一 id 的并发首次请求只回源一次。 */
  const inflight = new Map();
  /** 同一句话只记一次：sharp 装坏时每个头像请求都会失败，不节流就会把网关日志写爆。 */
  const warned = new Set();

  function warn(line) {
    try {
      if (warned.has(line) || warned.size >= 32) return;
      warned.add(line);
      log(line);
    } catch {
      // 日志实现自己挂了也不能影响响应
    }
  }

  function indexGet(scope) {
    const entry = index.get(scope);
    if (!entry) return null;
    // `>=`：`revalidateMs: 0` 就是「索引一概不信，每次都回源比一次哈希」（测试与排障用）。
    if (now() - entry.ts >= revalidate) {
      index.delete(scope);
      return null;
    }
    // 命中即「触碰」：Map 的插入顺序就是新旧顺序。
    index.delete(scope);
    index.set(scope, entry);
    return entry;
  }

  function indexSet(scope, entry) {
    index.delete(scope);
    index.set(scope, entry);
    while (index.size > AVATAR_INDEX_MAX_ENTRIES) {
      const oldest = index.keys().next();
      if (oldest.done) break;
      index.delete(oldest.value);
    }
  }

  function scopeOf(target, cookie) {
    // 用户头像按账号区分；agent 头像是全局内容，与 Cookie 无关。
    return target.kind === 'user' ? `user\n${identityOf(cookie)}` : `agent\n${target.id}`;
  }

  function fileNameFor(id, hash) {
    return path.join(cacheDir, `${id}-${hash}.webp`);
  }

  async function readFileOrNull(file) {
    try {
      return await fsp.readFile(file);
    } catch {
      return null;
    }
  }

  /** 写盘：先写同目录临时文件再 rename（原子替换，读者不会读到半个文件）。 */
  async function storeFile(file, bytes) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, file);
      return true;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      // Windows 上 rename 可能因为目标被占用而失败：退一步直写，再不行就只回这次响应。
      try {
        await fsp.mkdir(cacheDir, { recursive: true });
        await fsp.writeFile(file, bytes);
        return true;
      } catch (err2) {
        warn(`avatar-cache: 写缓存失败（只影响下次回源）：${err?.message || err} / ${err2?.message || err2}`);
        return false;
      }
    }
  }

  /** 清理同 id 的旧文件，最多留 `filesPerId` 份（含刚写的这份）。永不抛出。 */
  async function pruneSiblings(id, keepFile) {
    try {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const own = new RegExp(`^${escaped}-[0-9a-f]{16}\\.webp$`);
      const names = await fsp.readdir(cacheDir);
      const extras = [];
      for (const name of names) {
        if (!own.test(name)) continue;
        const full = path.join(cacheDir, name);
        if (full === keepFile) continue;
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat?.isFile()) continue;
        extras.push({ full, mtimeMs: stat.mtimeMs });
      }
      extras.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const extra of extras.slice(safeFilesPerId - 1)) {
        await fsp.rm(extra.full, { force: true }).catch(() => {});
      }
    } catch {
      // 清理失败只影响磁盘占用，不影响响应
    }
  }

  /** sharp 缩放。任何失败都只返回 null —— 调用方据此退回原代理。 */
  async function renderWebp(raw) {
    let sharp;
    try {
      sharp = await loadSharp();
    } catch (err) {
      warn(`avatar-cache: sharp 不可用（回退原代理）：${err?.message || err}`);
      return null;
    }
    try {
      return await sharp(raw, { limitInputPixels: AVATAR_MAX_INPUT_PIXELS, failOn: 'none' })
        // autoOrient：手机端不认 EXIF，PNG 之外的上游图先摆正再缩。
        .rotate()
        .resize({ width: safeMaxPx, height: safeMaxPx, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: safeQuality })
        .toBuffer();
    } catch (err) {
      warn(`avatar-cache: 缩放失败（回退原代理）：${err?.message || err}`);
      return null;
    }
  }

  /** 回源 → 内容寻址 → 命中文件就直接用，否则缩放写盘。失败返回 null。 */
  async function buildFromUpstream(target, ctx, scope) {
    let upstream;
    try {
      upstream = await fetchUpstream(target.id, ctx);
    } catch (err) {
      warn(`avatar-cache: 回源失败（回退原代理）：${err?.message || err}`);
      return null;
    }
    const raw = upstream && upstream.ok === true ? upstream.bytes : null;
    if (!Buffer.isBuffer(raw) || raw.length === 0) return null;

    const file = fileNameFor(target.id, contentHash(raw));
    const cached = await readFileOrNull(file);
    if (cached) {
      // 上游内容没变（或者只是索引过期）：不重编码，只续期。
      const etag = `"${contentHash(cached)}"`;
      indexSet(scope, { file, etag, ts: now() });
      return { bytes: cached, etag };
    }

    const webp = await renderWebp(raw);
    if (!webp) return null;

    const etag = `"${contentHash(webp)}"`;
    const stored = await storeFile(file, webp);
    if (stored) await pruneSiblings(target.id, file);
    // 写盘失败也照样回这次的结果：磁盘缓存只是下次加速的手段。
    indexSet(scope, { file, etag, ts: now() });
    return { bytes: webp, etag };
  }

  /** 同一 scope 的并发首次请求合并成一次回源。 */
  async function withInflight(scope, factory) {
    const existing = inflight.get(scope);
    if (existing) return existing;
    let task;
    task = factory().finally(() => {
      if (inflight.get(scope) === task) inflight.delete(scope);
    });
    inflight.set(scope, task);
    return task;
  }

  /** 拿到 `{ bytes, etag }` 或 null（null = 交回原代理）。 */
  async function payloadFor(target, ctx) {
    const scope = scopeOf(target, ctx.cookie);

    const hit = indexGet(scope);
    if (hit) {
      const bytes = await readFileOrNull(hit.file);
      if (bytes) return { bytes, etag: hit.etag };
      // 文件被清掉了（手工删 / 被同 id 的清理挤掉）：当作未命中，重新走回源。
      index.delete(scope);
    }

    return withInflight(scope, () => buildFromUpstream(target, ctx, scope));
  }

  function sendWebp(req, res, { bytes, etag }, headers) {
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': AVATAR_CACHE_CONTROL });
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': bytes.length,
      'cache-control': AVATAR_CACHE_CONTROL,
      etag,
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    // HEAD 只回头：body 一定不能写。
    if (String(req.method || '').toUpperCase() === 'HEAD') res.end();
    else res.end(bytes);
  }

  /**
   * @returns {Promise<boolean>} true = 已经把响应写完；false = 没处理，调用方继续走原代理。
   */
  async function handle(req, res, target = matchAvatarPath(req.url || '')) {
    if (!target) return false;
    const method = String(req.method || '').toUpperCase();
    // 其它方法（POST 之类）不在这里发明 405，原样交给反代。
    if (method !== 'GET' && method !== 'HEAD') return false;

    try {
      // 这是网关自己生成的响应，反代的鉴权流程到不了这里：必须自己问一次上游登录态。
      const auth = await checkAuth(req);
      if (!auth?.ok) {
        // 明确的未登录/无权限：按 avatar-pack 同一条路拒绝。
        // 鉴权服务本身不可用（503）：交回反代，让它用自己的错误契约回，不在这里造 503 文本。
        if (auth && (auth.status === 401 || auth.status === 403)) {
          deny(res, auth);
          return true;
        }
        return false;
      }

      const cookie = String(req.headers.cookie || '');
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
      const payload = await payloadFor(target, { cookie, userAgent });
      if (!payload) return false;

      if (res.destroyed || res.writableEnded) return true;
      // `/api/avatar/user` 是按账号变的：声明 public 会让中间缓存把它发给别人。
      const extra = target.kind === 'user' ? { vary: 'cookie' } : {};
      sendWebp(req, res, payload, extra);
      return true;
    } catch (err) {
      warn(`avatar-cache: 处理失败（回退原代理）：${err?.message || err}`);
      // 已经写出响应头就没法再交回反代，只能断开，不能让前端挂在一个收不完的响应上。
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) res.destroy();
        return true;
      }
      return false;
    }
  }

  return {
    match: matchAvatarPath,
    handle,
    /** 仅供诊断/测试：当前索引条数。 */
    indexSize: () => index.size,
  };
}
