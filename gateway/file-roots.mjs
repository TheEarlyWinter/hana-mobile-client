/**
 * 会话文件可读的根目录：HANA_HOME 下三个固定目录 + 本机工作区挂载 + 当前登录用户的工作区根。
 *
 * 为什么要工作区根：宿主给会话文件记的是绝对路径（`filePath`），agent 生成的文件、
 * 外部目录里的文件都落在宿主存储之外（`storageKind: "external"`），上游
 * `/api/resources/<fileId>/content` 对这类文件回 400。手机上唯一的替代读法就是
 * `/gw/file/<b64url(path)>`——它必须知道「哪些目录算自己的」。
 *
 * 三个来源：
 *  1. HANA_HOME 下固定三个目录（会话文件 / 上传 / 附件原图）；
 *  2. 本机工作区挂载：`HANA_HOME/studio-mounts.json` 里 status=active 的 local_fs 挂载。
 *     这份文件就在同一台机器上，读它比让上游转一手更可靠；disabled 的挂载一律不算。
 *  3. 上游 `/api/studio/workspaces` 返回的根（带请求自己的 Cookie，60 秒缓存）。
 *
 * 第 3 条只能问上游要，而且要带着「这个请求自己的 Cookie」问：用别人的根等于越权，
 * 用上一次登录留下的根等于把上一任的文件发给这一任。所以缓存按 sha256(cookie) 隔离。
 * 取失败（上游没起、超时、非 200、非 JSON、形状不对）一律退化成前两个来源，
 * 绝不把 500 抛给调用方——读不到工作区文件是能力降级，不是网关故障。
 */

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HANA_HOME, UPSTREAM } from './config.mjs';

const WORKSPACES_PATH = '/api/studio/workspaces';
const UPSTREAM_TIMEOUT_MS = 5_000;
/** 工作区列表只应是几 KB；超限直接不做解析，也不缓存。 */
const UPSTREAM_MAX_BYTES = 256 * 1024;
/** 成功结果缓存 60 秒（任务契约）。 */
const CACHE_TTL_MS = 60_000;
/**
 * 失败也短暂缓存：上游抖动时，每个 /gw/file 请求都会为此多打一次上游，
 * 不缓存就把一次上游故障放大成两倍请求量。5 秒足以挡掉连打，恢复也不拖。
 */
const FAILURE_TTL_MS = 5_000;
/** 缓存条目上限：Cookie 的数量不由我们控制，不封顶就是一条内存增长路径。 */
const CACHE_MAX_ENTRIES = 64;

/** HANA_HOME 下固定放行的三个目录（会话文件、用户上传、附件原图）。 */
export const HANA_HOME_ROOTS = Object.freeze([
  path.join(HANA_HOME, 'session-files'),
  path.join(HANA_HOME, 'uploads'),
  // 服务端把用户上传的原图存在 attachments/，历史消息里的
  // `[attached_image: <path>]` 标记指的就是这里。
  path.join(HANA_HOME, 'attachments'),
]);

/** key = sha256(cookie)，value = { roots, expiresAt }。 */
const cache = new Map();

function cacheKeyFor(cookie) {
  return createHash('sha256').update(String(cookie || '')).digest('hex');
}

/** 本机挂载清单：按 mtime 失效，改了挂载下一次请求就生效，不用重启网关。 */
const MOUNTS_FILE = path.join(HANA_HOME, 'studio-mounts.json');
let mountsCache = { mtimeMs: -1, roots: [] };

/** 上游给的 nativeRootPath 只接受「绝对路径字符串」，并且剔掉控制字符。 */
function normalizeRootPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (!path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

/** 上游 body → 工作区根数组；形状不对就是 null（调用方按「取失败」处理）。 */
function parseWorkspaceRoots(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = parsed?.workspaces;
  if (!Array.isArray(list)) return null;
  const roots = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    // rootAvailable: false 表示这个挂载点现在不可用，不当作可读根。
    if (item.rootAvailable === false) continue;
    const root = normalizeRootPath(item.nativeRootPath);
    if (!root) continue;
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

/**
 * 拿这个 Cookie 的工作区根。永不 reject：任何失败都返回 null。
 * @returns {Promise<string[]|null>}
 */
function fetchWorkspaceRoots(cookie) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let upstreamReq;
    try {
      upstreamReq = http.request(
        {
          host: UPSTREAM.host,
          port: UPSTREAM.port,
          method: 'GET',
          path: WORKSPACES_PATH,
          headers: {
            host: `${UPSTREAM.host}:${UPSTREAM.port}`,
            cookie,
            accept: 'application/json',
            connection: 'close',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            finish(null);
            return;
          }
          const chunks = [];
          let size = 0;
          let tooLarge = false;
          res.on('data', (chunk) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > UPSTREAM_MAX_BYTES) {
              tooLarge = true;
              chunks.length = 0;
              upstreamReq.destroy(new Error(`workspaces response > ${UPSTREAM_MAX_BYTES} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (tooLarge) return;
            finish(parseWorkspaceRoots(Buffer.concat(chunks).toString('utf8')));
          });
          res.on('error', () => finish(null));
          res.on('close', () => {
            if (!res.complete) finish(null);
          });
        },
      );
    } catch {
      finish(null);
      return;
    }

    upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstreamReq.destroy(new Error(`workspaces request idle > ${UPSTREAM_TIMEOUT_MS}ms`));
    });
    upstreamReq.on('error', () => finish(null));
    upstreamReq.end();
  });
}

/** 过期条目先清，再按过期时间从旧到新砍到上限以内。 */
function pruneCache(now) {
  for (const [key, entry] of cache) {
    if (!(entry.expiresAt > now)) cache.delete(key);
  }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const ordered = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of ordered.slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
}

/**
 * 当前 Cookie 对应的工作区根（已规范化、去重）。取失败返回空数组，绝不抛。
 * @param {string|undefined} cookie 这个请求自己的 Cookie
 * @returns {Promise<string[]>}
 */
export async function workspaceRoots(cookie) {
  if (!cookie) return [];
  const key = cacheKeyFor(cookie);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.roots;

  const fetched = await fetchWorkspaceRoots(cookie);
  const roots = fetched || [];
  cache.set(key, { roots, expiresAt: now + (fetched ? CACHE_TTL_MS : FAILURE_TTL_MS) });
  pruneCache(now);
  return roots;
}

/**
 * 本机工作区挂载的根：`studio-mounts.json` 里 provider=local_fs 且 status=active 的。
 * 读不到或格式不对就当「没有挂载」，不影响 HANA_HOME 那三个根。
 * @returns {Promise<string[]>}
 */
async function localMountRoots() {
  let stat;
  try {
    stat = await fsp.stat(MOUNTS_FILE);
  } catch {
    mountsCache = { mtimeMs: -1, roots: [] };
    return [];
  }
  if (stat.mtimeMs === mountsCache.mtimeMs) return mountsCache.roots;

  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(MOUNTS_FILE, 'utf8'));
  } catch {
    // 文件正在被写（宿主落盘）时可能只读到半截：不缓存，下次再读。
    return mountsCache.roots;
  }

  const mounts = Array.isArray(parsed?.mounts) ? parsed.mounts : [];
  const roots = [];
  const seen = new Set();
  for (const item of mounts) {
    if (!item || typeof item !== 'object') continue;
    // 只认本机文件系统挂载；远端/存储类型不在这条路的范围里。
    if (item.provider && item.provider !== 'local_fs') continue;
    // 被禁用的挂载不能读（用户在设置里关掉就是不想让它被读）。
    if (item.status && item.status !== 'active') continue;
    const root = normalizeRootPath(item.rootLocator?.path);
    if (!root) continue;
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  mountsCache = { mtimeMs: stat.mtimeMs, roots };
  return roots;
}

/**
 * `/gw/file` 这一条请求真正可读的全部根。根顺序即比较顺序，不影响判定。
 * @param {string|undefined} cookie
 * @returns {Promise<string[]>}
 */
export async function fileRoots(cookie) {
  const [mounts, workspace] = await Promise.all([localMountRoots(), workspaceRoots(cookie)]);
  return [...HANA_HOME_ROOTS, ...mounts, ...workspace];
}
