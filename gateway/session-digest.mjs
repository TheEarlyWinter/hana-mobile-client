/**
 * 会话摘要：只回「哪个会话变了 / 还在不在跑」，不给整张列表。
 *
 * 为什么需要它：手机锁屏时 WS 断了，回来只知道界面是旧的，
 * 不知道离开期间有没有会话跑完。会话列表的 `modified` 不顶用——它只跟用户发消息走，
 * 助手回复不动它（真机验过）。真正能用的信号在宿主 `/api/sessions` 的每一行里：
 *
 *   messageCount         消息条数（助手回复也会让它变）
 *   status.isStreaming   这一轮是不是还在生成
 *
 * 这两样只有宿主自己知道，所以由网关代问：用本机 owner 令牌走回环，
 * 与 `/api/sessions/new` 同一套资格；手机端拿不到整张会话列表，只拿摘要。
 *
 * 安全边界：
 *   - 端点本身要求调用方已登录（server.mjs 里先 checkReadAuth，与头像聚合同一条路）；
 *   - 上游请求只走 127.0.0.1，token 从 server-info.json 现读，不落日志、不进响应；
 *   - 只输出四个字段，不转发路径、摘要、附件等其它会话信息。
 */

import http from 'node:http';
import { UPSTREAM } from './config.mjs';
import { loadLocalOwner, resolveHanaHome } from './local-owner.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';

/** 网关自己的端点：放在 /gw 下，不会被反代吃掉。 */
export const SESSION_DIGEST_PATH = '/gw/session-digest';

/** 一次最多回这么多条：会话再多，手机也只关心最近这些。 */
export const MAX_DIGEST_SESSIONS = 80;
/** 2 秒内的重复请求直接吃缓存：一次回前台会同时触发列表与摘要两条请求。 */
export const DEFAULT_TTL_MS = 2000;
/** 上游拉列表的超时。它是本机回环，正常几十毫秒。 */
const UPSTREAM_TIMEOUT_MS = 8000;
/** 响应体上限：会话列表是几千条也可能，超过就当异常。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function toId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 一条会话行 → 摘要条目；缺 id 或条数不是非负整数的一律丢掉。 */
export function normalizeDigestRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = toId(raw.sessionId);
  if (!sessionId) return null;
  const count = Number(raw.messageCount);
  if (!Number.isFinite(count) || count < 0) return null;
  const status = raw.status && typeof raw.status === 'object' ? raw.status : {};
  return {
    sessionId,
    title: typeof raw.title === 'string' ? raw.title : '',
    messageCount: Math.floor(count),
    // 只认布尔真值：字段缺失按「不知道」处理，宁可少提示也不误报。
    isStreaming: status.isStreaming === true,
    hasStreaming: typeof status.isStreaming === 'boolean',
  };
}

/**
 * 原始会话数组 → 摘要。按 messageCount 降序取前 N 条：最近有动静的排前面，
 * 手机端做差也只需要这些。
 */
export function normalizeDigest(rows, limit = MAX_DIGEST_SESSIONS) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rows) {
    const row = normalizeDigestRow(raw);
    if (!row || seen.has(row.sessionId)) continue;
    seen.add(row.sessionId);
    out.push(row);
  }
  out.sort((a, b) => b.messageCount - a.messageCount);
  return out.slice(0, Math.max(1, limit));
}

/** 用 owner 令牌问本机会话列表；失败一律返回 null，让端点回 502 而不是挂住。 */
function defaultFetchRows() {
  return new Promise((resolve) => {
    const hanaHome = resolveHanaHome();
    const owner = loadLocalOwner({
      hanaHome,
      upstreamHost: UPSTREAM.host,
      upstreamPort: UPSTREAM.port,
    });
    if (!owner || !owner.ok) {
      resolve(null);
      return;
    }

    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.request(
      {
        host: UPSTREAM.host,
        port: UPSTREAM.port,
        method: 'GET',
        path: '/api/sessions',
        headers: {
          host: `${UPSTREAM.host}:${UPSTREAM.port}`,
          // owner 令牌只走回环这一跳，从不写进日志或错误信息。
          authorization: `Bearer ${owner.token}`,
          accept: 'application/json',
          connection: 'close',
        },
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            res.destroy();
            done(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if ((res.statusCode || 0) !== 200) {
            done(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            done(Array.isArray(parsed) ? parsed : null);
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * @param {object} [options]
 * @param {() => Promise<Array|null>} [options.fetchRows] 测试注入假上游
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
export function createSessionDigest({
  fetchRows = defaultFetchRows,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  limit = MAX_DIGEST_SESSIONS,
  checkAuth = checkReadAuth,
  deny = denyRead,
} = {}) {
  let cache = null; // { at, body }
  let inflight = null;

  async function build() {
    const rows = await fetchRows();
    if (!Array.isArray(rows)) return null;
    const sessions = normalizeDigest(rows, limit).map(({ hasStreaming, ...rest }) => rest);
    return { at: now(), sessions };
  }

  /** 拿一份摘要；命中缓存时连上游都不问。失败返回 null。 */
  async function get() {
    const at = now();
    if (cache && at - cache.at < ttlMs) return cache.body;
    if (!inflight) {
      inflight = build()
        .then((body) => {
          if (body) cache = { at: body.at, body };
          return body;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  /** 网关端点入口。
   *
   * 这是网关自己的路由，/api/* 的反代鉴权到不了这里：先问一次上游登录态，
   * 与头像聚合同一条路。没登录就交给上游那套拒绝逻辑回 401/403。
   */
  async function handle(req, res) {
    const auth = await checkAuth(req);
    if (!auth?.ok) {
      deny(res, auth);
      return;
    }
    const body = await get();
    if (!body) {
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'digest_unavailable' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // 内容随时在变，且是本人数据：不让任何中间层留。
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return { get, handle, clear: () => { cache = null; } };
}
