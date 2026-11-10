/**
 * 会话尾部快照的「发出去」这一半：判定、命中回包、后台刷新。
 *
 * 为什么单独一层：`tail-cache.mjs` 只管存取（纯数据、好测），负责 HTTP 的部分放这里，
 * 免得缓存模块里混进 res/req。`server.mjs` 只调两个方法：
 *
 *   serve.tryServe(req, res)   → true 表示已经自己回过包（命中新鲜或旧快照）
 *   serve.capture(req, res, status, headers, body)  ← http-proxy 在响应收完时回调
 *
 * 命中为什么不走反代：慢的那 3.4 秒全在上游组装，网关拿着上一份快照直接写出去就是几毫秒。
 * 旧快照（stale）先回，再在后台悄悄换一份新的；下一次打开就是新的，用户不用等第二次。
 *
 * 安全边界：
 *   - 键里有 sha256(cookie)：换一个登录身份不会读到上一个人的历史；
 *   - 只接受 200 + JSON，错误响应不进缓存（不能把一次 502 冻结成十分钟的常态）；
 *   - 回包固定 `cache-control: no-store`：内容随时会被后台刷新替换，中间层不该留下来。
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { UPSTREAM } from './config.mjs';

/** 后台刷新单次最多读这么多：和 tail-cache 的单条上限一致，超了就不存。 */
const REFRESH_MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_TIMEOUT_MS = 15_000;
/** 命中时的响应头：内容类型固定 JSON，长度按实际发出的字节算。 */
const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * 客户端能不能收 gzip。和 http-proxy 里那份判定同一套规则：
 * 显式写了 gzip 就以它的 q 为准；没写才退回 `*`。
 */
function acceptsGzip(headers = {}) {
  const raw = headers['accept-encoding'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || !value.trim()) return false;
  let wildcardQ = null;
  for (const part of value.split(',')) {
    const [tokenRaw, ...params] = part.split(';');
    const token = tokenRaw.trim().toLowerCase();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const match = param.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (match) {
        const parsed = Number(match[1]);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (token === 'gzip') return q > 0;
    if (token === '*') wildcardQ = q;
  }
  return wildcardQ !== null && wildcardQ > 0;
}

/** 键里的身份部分：只留哈希，网关日志和内存里都不出现原始 Cookie。 */
function cookieHashOf(req) {
  const raw = req?.headers?.cookie;
  const cookie = Array.isArray(raw) ? raw.join('; ') : raw;
  return createHash('sha256').update(String(cookie || '')).digest('hex').slice(0, 32);
}

/** 把 URL 拆成 path + query；形状不对按「不适用」处理，绝不让解析异常冒到请求里。 */
function splitUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '/'), 'http://gateway.local');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.cache            tail-cache.mjs 的 createTailCache() 实例
 * @param {Function} [options.refresh]      后台刷新实现，默认走本机上游；测试注入假的
 * @param {Function} [options.log]          一行式日志（可选）
 * @param {Function} [options.now]
 */
export function createTailServe({
  cache,
  refresh = null,
  log = null,
  now = () => Date.now(),
} = {}) {
  if (!cache || typeof cache.get !== 'function') {
    throw new TypeError('createTailServe requires a tail cache');
  }

  const refreshImpl = typeof refresh === 'function' ? refresh : defaultRefresh;

  function keyFor(req) {
    const parts = splitUrl(req?.url);
    if (!parts) return null;
    // 用缓存模块自己的解析结果拼 key：limit 的缺省值与 050→50 的归一只有一份，
    // 两边各写一遍迟早在「050 到底命中不命中」上漂。
    const parsed = typeof cache.parseTailRequest === 'function'
      ? cache.parseTailRequest(req?.method, parts.path, parts.query)
      : null;
    if (!parsed || !parsed.ok) return null;
    // path 也参与 key：同一个 sessionId 在不同 path 下的 transcript 不是同一份，
    // 混用会把另一个文件的内容当成本会话的历史发出去。
    const pathParam = parts.query.get('path') || '';
    return cache.key(cookieHashOf(req), `${parsed.sessionId}\u0000${pathParam}`, parsed.limit);
  }

  /** `_nc` 是页面自己要求的「这一次不要快照」：发完消息、前台对账都要看见真数据。 */
  function bypassed(req) {
    const parts = splitUrl(req?.url);
    return Boolean(parts && parts.query.has('_nc'));
  }

  /** 先回旧内容，再在后台换一份新的；同一个键同时只跑一个刷新。 */
  function scheduleRefresh(key, req) {
    if (!cache.beginRefresh(key)) return;
    const cookie = (() => {
      const raw = req?.headers?.cookie;
      return Array.isArray(raw) ? raw.join('; ') : String(raw || '');
    })();
    const parts = splitUrl(req?.url);
    const sessionId = parts ? parts.query.get('sessionId') || '' : '';
    const pathParam = parts ? parts.query.get('path') || '' : '';
    const limitRaw = parts ? parts.query.get('limit') : null;
    const limit = limitRaw === null ? 50 : Number(limitRaw);

    Promise.resolve()
      .then(() => refreshImpl({ sessionId, path: pathParam, limit, cookie }))
      .then((result) => {
        if (!result || result.status !== 200 || !result.body) return;
        cache.set(key, result.body, { etag: result.etag || '' });
      })
      .catch((err) => {
        // 刷新失败不写缓存：宁可下一次继续用旧快照，也不要存一个半截结果。
        if (typeof log === 'function') log(`tail refresh failed: ${err?.message || err}`);
      })
      .finally(() => cache.endRefresh(key));
  }

  /**
   * 命中就直接回包。返回 true 表示这个请求已经处理完，调用方不要再转给上游。
   */
  function tryServe(req, res) {
    const key = keyFor(req);
    if (!key) return false;
    // 页面点名不要快照：这条请求交给上游，响应照旧会被 capture 存成新快照。
    if (bypassed(req)) return false;

    const hit = cache.get(key);
    if (!hit || hit.state === 'miss') return false;

    const entry = hit.entry || {};
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(String(entry.body ?? ''));
    const compressed = acceptsGzip(req?.headers);
    const payload = compressed ? gzipSync(body) : body;
    const headers = {
      'content-type': JSON_TYPE,
      'content-length': String(payload.length),
      // 内容随时可能被后台刷新替换，中间层缓存下来只会发旧数据。
      'cache-control': 'no-store',
      // 排障用：fresh 表示直接命中；stale 表示先给旧的，新的已经在路上。
      'x-gw-tail-cache': hit.state === 'stale' ? 'stale' : 'fresh',
      vary: 'accept-encoding',
    };
    if (compressed) headers['content-encoding'] = 'gzip';

    if (hit.state === 'stale') scheduleRefresh(key, req);

    res.writeHead(200, headers);
    res.end(payload);
    return true;
  }

  /**
   * 反代把整段响应收完时调这里。只有「200 + JSON」才配进缓存：
   * 一次 4xx/5xx 或二进制响应被存下来，会把偶发错误变成十分钟的常态。
   */
  function capture(req, res, status, headers, body) {
    const key = keyFor(req);
    if (!key) return false;
    if (status !== 200) return false;
    const type = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return false;
    if (!body || !body.length) return false;
    const etag = String(headers?.etag || '');
    return cache.set(key, body, { etag });
  }

  /** 本机上游拉一份；失败返回 null，交给调用方忽略。 */
  function defaultRefresh({ sessionId, path: sessionPath, limit, cookie }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const params = [`sessionId=${encodeURIComponent(sessionId)}`, `limit=${encodeURIComponent(limit)}`];
      // path 跟着带：上游靠它定位 transcript，丢了就可能拿到另一个文件的内容。
      if (sessionPath) params.push(`path=${encodeURIComponent(sessionPath)}`);
      const query = `?${params.join('&')}`;
      const req = http.request(
        {
          host: UPSTREAM.host,
          port: UPSTREAM.port,
          method: 'GET',
          path: `/api/sessions/messages${query}`,
          headers: {
            host: `${UPSTREAM.host}:${UPSTREAM.port}`,
            cookie,
            accept: 'application/json',
            // 存的是明文 JSON：压缩体存下来还得再解一遍，不如直接要原始字节。
            'accept-encoding': 'identity',
            connection: 'close',
          },
          timeout: REFRESH_TIMEOUT_MS,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode || 0;
          const chunks = [];
          let total = 0;
          upstreamRes.on('data', (chunk) => {
            total += chunk.length;
            if (total > REFRESH_MAX_BYTES) {
              upstreamRes.destroy();
              done(null);
              return;
            }
            chunks.push(chunk);
          });
          upstreamRes.on('end', () => {
            if (!upstreamRes.complete) {
              done(null);
              return;
            }
            done({ status, body: Buffer.concat(chunks), etag: upstreamRes.headers?.etag || '' });
          });
          upstreamRes.on('error', () => done(null));
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

  return { keyFor, tryServe, capture };
}
