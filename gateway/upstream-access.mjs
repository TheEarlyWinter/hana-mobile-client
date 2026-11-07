/**
 * 网关访问上游的三件事：转发头、读取类资源鉴权、日志脱敏。
 *
 * 为什么要单独成模块：卡片托管、会话文件、HTTP 反代、WS 反代四条路径都要用同一套
 * 鉴权与同一个上游 Host，任何一处不一致都会变成绕过或 401 之谜。
 */

import http from 'node:http';
import { UPSTREAM } from './config.mjs';
import { sanitizeUpstreamHeaders } from './security-policy.mjs';

/** 网关托管的卡片/会话文件不公开：每个请求都拿 Cookie 去问上游登录态。 */
const AUTH_SESSION_PATH = '/api/web-auth/session';
const AUTH_TIMEOUT_MS = 5_000;
/** 认证响应只应是几百字节的会话快照；超限直接销毁，不解析也不缓存。 */
const AUTH_RESPONSE_MAX_BYTES = 64 * 1024;

/** 转发到上游前的头：客户端凭据/伪造转发头先剥掉，Host 覆盖成上游地址。 */
export function upstreamHeaders(headers) {
  const out = sanitizeUpstreamHeaders(headers);
  out.host = `${UPSTREAM.host}:${UPSTREAM.port}`;
  return out;
}

/**
 * 读取类资源（/gw/card、/gw/file）的鉴权：转发客户端的 Cookie 问上游
 * `/api/web-auth/session`，只有上游明确返回 authenticated === true 才放行。
 * 不看来源地址——回环连接不代表已登录（桌面端自己也走回环）。
 *
 * signal 可选：HTTP 新建会话用它在客户端断开时取消还在等待的鉴权。
 * 不传时行为与原来完全一致；取消只表示“这次检查不再需要”，绝不等于已认证。
 */
export async function checkReadAuth(req, { signal } = {}) {
  const cookie = req.headers.cookie;
  if (!cookie) return { ok: false, status: 401, reason: 'unauthenticated' };
  if (signal?.aborted) return { ok: false, status: 503, reason: 'auth_cancelled' };

  let sessionRes;
  try {
    sessionRes = await new Promise((resolve, reject) => {
      let settled = false;
      let authReq = null;

      const settle = (ok, value) => {
        if (settled) return;
        settled = true;
        // 及时解除取消监听：请求结束/失败后 signal 不再需要盯着这个请求。
        if (signal) signal.removeEventListener('abort', onAbort);
        if (ok) resolve(value);
        else reject(value);
      };
      // 客户端已经走了：拆掉在途的上游请求，别让它在后台白等到超时。
      const onAbort = () => {
        if (authReq) authReq.destroy(new Error('auth check aborted'));
        settle(false, new Error('auth check aborted'));
      };

      authReq = http.request(
        {
          host: UPSTREAM.host,
          port: UPSTREAM.port,
          method: 'GET',
          path: AUTH_SESSION_PATH,
          headers: {
            host: `${UPSTREAM.host}:${UPSTREAM.port}`,
            cookie,
            accept: 'application/json',
            connection: 'close',
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          let tooLarge = false;
          res.on('data', (c) => {
            if (tooLarge) return;
            size += c.length;
            if (size > AUTH_RESPONSE_MAX_BYTES) {
              tooLarge = true;
              chunks.length = 0;
              authReq.destroy(new Error(`auth response > ${AUTH_RESPONSE_MAX_BYTES} bytes`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (tooLarge) return;
            settle(true, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
          });
          // 上游响应没读完就断开时不会有 'end'：不接住 'error'/'close'，
          // 这个 promise 会永远挂着，调用方的请求也永远不收尾。
          res.on('error', () => settle(false, new Error('auth response error')));
          res.on('close', () => {
            if (!res.complete) settle(false, new Error('auth response aborted'));
          });
        },
      );
      authReq.setTimeout(AUTH_TIMEOUT_MS, () =>
        authReq.destroy(new Error(`auth check idle > ${AUTH_TIMEOUT_MS}ms`)),
      );
      authReq.on('error', (err) => settle(false, err));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      authReq.end();
    });
  } catch {
    // 上游没起 / 超时 / 连接被断 / 客户端取消：一律按不可用拒绝，不降级放行
    return {
      ok: false,
      status: 503,
      reason: signal?.aborted ? 'auth_cancelled' : 'auth_upstream_unreachable',
    };
  }

  if (sessionRes.status === 401 || sessionRes.status === 403) {
    return { ok: false, status: 401, reason: 'unauthenticated' };
  }
  if (sessionRes.status !== 200) {
    return { ok: false, status: 503, reason: 'auth_upstream_error' };
  }

  let session;
  try {
    session = JSON.parse(sessionRes.body);
  } catch {
    return { ok: false, status: 503, reason: 'auth_bad_response' };
  }
  if (session?.authenticated === true) return { ok: true, principal: session.principal ?? null };
  return { ok: false, status: 401, reason: 'unauthenticated' };
}

/** 安全拒绝：不回传上游细节，也不让浏览器缓存。 */
export function denyRead(res, auth) {
  res.writeHead(auth.status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(auth.status === 401 ? 'unauthorized' : 'auth service unavailable');
}

/** 访问日志不能出现卡片令牌原文，也不把常见凭据类 query 打出来。 */
export function redactUrlForLog(rawUrl) {
  let value = String(rawUrl || '').replace(/t_[A-Za-z0-9_-]{43}/g, 't_[redacted]');
  value = value.replace(
    /([?&](?:token|access_token|refresh_token|code|password|secret|key|auth)=)[^&]*/gi,
    '$1[redacted]',
  );
  return value;
}
