/**
 * Hana Mobile Gateway
 * -------------------
 * 极薄的同源网关：托管我们自己的移动端前端，并把 /api 与 WebSocket 原样转发给
 * 本机正在运行的 hana-server。
 *
 * 为什么要它：hana-server 的登录 cookie 是 HttpOnly + SameSite=Strict，
 * 任何跨源客户端（Capacitor 默认的 https://localhost、局域网另一台机器）
 * 都拿不到它。让页面由本网关同源提供，cookie 就自然成立。
 *
 * 零依赖，只用 node 内置模块。
 * 环境变量、TLS 与绑定策略见 config.mjs；卡片托管、WS 与 HTTP 反代各自成模块。
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { ensureWebBundle } from './web-build.mjs';
import {
  isAllowedOrigin,
  isCreateSessionPath,
  isEncodedAliasOfProtectedPath,
  isOwnerSessionCreatePath,
  isWriteMethod,
  OWNER_SESSION_CREATE_PATH,
} from './security-policy.mjs';
import { isEligibleOwnerPrincipal, isOwnerPrincipalCandidate, loadLocalOwner } from './local-owner.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';
import { CARD_RUNTIME_PATH, denyCardRuntime, serveCard, serveSharedCardRuntime } from './card-host.mjs';
import { serveFeedCard } from './feed-card-host.mjs';
import { serveSessionFile } from './session-files.mjs';
import { serveStatic } from './static-files.mjs';
import { createWebsocketProxy } from './websocket-proxy.mjs';
import { createHttpProxy } from './http-proxy.mjs';
import { createLogger } from './logger.mjs';
import {
  ALLOWED_ORIGINS,
  EXTERNAL_HTTPS,
  GATEWAY_SCHEME,
  HANA_HOME,
  LISTEN,
  LOG_DIR,
  LOG_ENABLED,
  LOG_KEEP_FILES,
  LOG_MAX_BYTES,
  LOG_WS,
  TLS_OPTIONS,
  UPSTREAM,
  WEB_ROOT,
  WS_LOG,
  startupError,
} from './config.mjs';

/** 结构化日志：gateway/logs/*.jsonl，单文件 5MB 滚一段、只留 5 份；HANA_GATEWAY_LOG=off 时整体关闭。 */
const logger = LOG_ENABLED
  ? createLogger({ dir: LOG_DIR, maxBytes: LOG_MAX_BYTES, keepFiles: LOG_KEEP_FILES })
  : null;

/** req.url 带着 query，路由判断只看 pathname —— `/api?x=1`、`/api?` 也得走反代。 */
function pathnameOf(rawUrl) {
  // 非 origin-form（绝对形式等）原样返回，维持旧行为，不额外放行
  if (!rawUrl.startsWith('/')) return rawUrl;
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return rawUrl.split('?')[0];
  }
}

function isApiPath(rawUrl) {
  const pathname = pathnameOf(rawUrl);
  return pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/mobile/api/');
}

/** 写请求/WS 的源校验：只认同源或显式 allowlist，不读 X-Forwarded-Proto。 */
function isAllowedGatewayOrigin(req) {
  return isAllowedOrigin({
    origin: req.headers.origin,
    host: req.headers.host,
    scheme: GATEWAY_SCHEME,
    allowedOrigins: ALLOWED_ORIGINS,
  });
}

function denyOrigin(res) {
  res.writeHead(403, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: 'origin_not_allowed' }));
}

/**
 * 编码别名的安全拒绝：上游会把 `/api/workspace/con%74ent` 当成同一条路由，
 * 而网关按字面路径判「是否强制下载」。所以宁可直接拒绝，也不转发过去。
 */
function denyEncodedPath(res) {
  res.writeHead(400, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify({ error: 'encoded_path_not_allowed' }));
}

/* HTTP 反向代理（含强制下载、hop-by-hop 清理）已拆到 http-proxy.mjs。 */

const { proxyHttp } = createHttpProxy({ isApiPath });

/* ------------------------------------------------------------------ */
/* 本机 owner 代办：仅精确 POST /api/sessions/new                        */
/* ------------------------------------------------------------------ */

const OWNER_BODY_MAX_BYTES = 8 * 1024;
const OWNER_RESPONSE_MAX_BYTES = 64 * 1024;
const OWNER_REQUEST_TIMEOUT_MS = 30_000;
const OWNER_AGENT_ID_MAX_LENGTH = 256;
const OWNER_AGENT_NAME_MAX_LENGTH = 256;

function ownerHostHeader(host, port) {
  const raw = String(host || '').trim();
  const formatted = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
  return `${formatted}:${port}`;
}

function normalizeOwnerHost(host) {
  const raw = String(host || '').trim();
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
}

function isJsonContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * owner 新建会话的请求体白名单。
 *
 * 手机端只需要两个动作：建 Chat、建 Code。宿主 bundle 里：
 *   - `Bnt(body)` 只认 `body.namespace` 的 home / code，其它值 400；
 *   - Code 会话必须自带目录（`Fnt` 在 `workspaceSelection.cwd` 为空时抛
 *     code_repository_required，宿主不会替客户端猜一个目录）。
 * 所以白名单只允许 agentId / namespace / cwd 三个键，其余一律拒绝——
 * 仍然不让手机端把任意字段（例如服务端管理的 codeWorktree）塞进创建请求。
 */
const OWNER_ALLOWED_KEYS = new Set(['agentId', 'namespace', 'cwd', 'thinkingLevel']);
const OWNER_NAMESPACES = new Set(['home', 'code']);
const OWNER_CWD_MAX_LENGTH = 4096;
/** 思考档位只校验形状：真实可选值随模型/Agent 变（实测 /api/session-thinking-level 给的是 off/medium/high/max），
 *  写死在网关就会在宿主扩档时误拦，语义交给宿主判定。 */
const OWNER_THINKING_LEVEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** 只接受 JSON object；成功时只提取白名单内的字段，值全部重新校验。 */
function parseOwnerBody(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON 错误信息可能带正文片段，不读取、不记录。
    return { ok: false, status: 400, error: 'invalid_request' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: 'invalid_request' };
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) return { ok: true, body: {} };
  for (const key of keys) {
    if (!OWNER_ALLOWED_KEYS.has(key)) return { ok: false, status: 400, error: 'invalid_request' };
  }

  const body = {};

  if ('agentId' in parsed) {
    const { agentId } = parsed;
    if (typeof agentId !== 'string') return { ok: false, status: 400, error: 'invalid_request' };
    const trimmed = agentId.trim();
    if (!trimmed || trimmed.length > OWNER_AGENT_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, status: 400, error: 'invalid_request' };
    }
    body.agentId = trimmed;
  }

  if ('namespace' in parsed) {
    const { namespace } = parsed;
    if (typeof namespace !== 'string' || !OWNER_NAMESPACES.has(namespace)) {
      return { ok: false, status: 400, error: 'invalid_request' };
    }
    body.namespace = namespace;
  }

  if ('thinkingLevel' in parsed) {
    const { thinkingLevel } = parsed;
    if (typeof thinkingLevel !== 'string' || !OWNER_THINKING_LEVEL_RE.test(thinkingLevel)) {
      return { ok: false, status: 400, error: 'invalid_request' };
    }
    body.thinkingLevel = thinkingLevel;
  }

  if ('cwd' in parsed) {
    const { cwd } = parsed;
    // 目录只对 Code 有意义；跟其它字段混用一律拒。
    if (body.namespace !== 'code') return { ok: false, status: 400, error: 'invalid_request' };
    if (typeof cwd !== 'string') return { ok: false, status: 400, error: 'code_repository_required' };
    const trimmed = cwd.trim();
    if (
      !trimmed ||
      trimmed.length > OWNER_CWD_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(trimmed) ||
      !path.isAbsolute(trimmed)
    ) {
      return { ok: false, status: 400, error: 'code_repository_required' };
    }
    // 网关和宿主在同一台机器上，先替宿主看一眼：目录不存在就不把注定 400 的请求转过去。
    try {
      if (!fs.statSync(trimmed).isDirectory()) {
        return { ok: false, status: 400, error: 'code_repository_required' };
      }
    } catch {
      return { ok: false, status: 400, error: 'code_repository_required' };
    }
    body.cwd = trimmed;
  }

  // Code 会话必须带目录：宿主会拒绝，这里提前把同一个错误码回给前端。
  if (body.namespace === 'code' && !body.cwd) {
    return { ok: false, status: 400, error: 'code_repository_required' };
  }

  return { ok: true, body };
}

function readOwnerBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > OWNER_BODY_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, error: 'request_too_large' });
        return;
      }
      resolve(parseOwnerBody(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => {
      resolve({ ok: false, status: 400, error: 'invalid_request' });
    });
  });
}

function sendOwnerJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendOwnerError(res, status, error) {
  sendOwnerJson(res, status, { error });
}

/**
 * 用本机 server-info 的 loopback token 请求上游；不带客户端 Cookie、不跟随 3xx、
 * 不读取/记录上游错误正文，也不把上游 Set-Cookie 透传给手机。
 */
function requestOwnerSession({ token, port, body }) {
  const payload = Buffer.from(JSON.stringify(body));
  const ownerHost = normalizeOwnerHost(UPSTREAM.host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const ownerReq = http.request(
      {
        host: ownerHost,
        port,
        method: 'POST',
        path: OWNER_SESSION_CREATE_PATH,
        headers: {
          host: ownerHostHeader(ownerHost, port),
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': payload.length,
          accept: 'application/json',
          connection: 'close',
        },
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        if (status < 200 || status >= 300) {
          // 不读取错误正文；保留 4xx 的业务语义，3xx/5xx 统一安全失败。
          // 401 是 owner token 失效，不是手机 Cookie 失效，不能回给客户端当登录过期。
          upstreamRes.resume();
          const safeStatus = status >= 400 && status < 500 && status !== 401 ? status : 502;
          finish({ ok: false, status: safeStatus });
          return;
        }

        let size = 0;
        let tooLarge = false;
        const chunks = [];
        upstreamRes.on('data', (chunk) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > OWNER_RESPONSE_MAX_BYTES) {
            tooLarge = true;
            chunks.length = 0;
            finish({ ok: false, status: 502 });
            upstreamRes.destroy();
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          if (tooLarge) return;
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish({ ok: false, status: 502 });
            return;
          }
          const sessionPath = parsed?.path;
          const sessionId = parsed?.sessionId;
          const agentId = parsed?.agentId;
          const agentName = parsed?.agentName;
          if (
            typeof sessionPath !== 'string' || !sessionPath || sessionPath.length > 4096 ||
            typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 ||
            typeof agentId !== 'string' || !agentId || agentId.length > OWNER_AGENT_ID_MAX_LENGTH
          ) {
            finish({ ok: false, status: 502 });
            return;
          }
          const session = { path: sessionPath, sessionId, agentId };
          // agentName 是可选展示提示：缺失/空/坏类型/超长时省略，
          // 不能因为缺少它就否定已经创建成功的会话。
          if (
            typeof agentName === 'string' &&
            agentName.trim() &&
            agentName.length <= OWNER_AGENT_NAME_MAX_LENGTH
          ) {
            session.agentName = agentName.trim();
          }
          finish({ ok: true, session });
        });
        upstreamRes.on('error', () => finish({ ok: false, status: 502 }));
      },
    );

    ownerReq.setTimeout(OWNER_REQUEST_TIMEOUT_MS, () => {
      ownerReq.destroy(new Error('owner request timeout'));
    });
    ownerReq.on('error', () => finish({ ok: false, status: 502 }));
    ownerReq.end(payload);
  });
}

/**
 * 新建会话是唯一在路由里先 await 鉴权的请求：客户端可能在这段窗口里离开。
 * 在 await 之前盯住响应关闭（与 http-proxy 的断连判定同源），用它取消鉴权；
 * 真正发创建请求之前再复查一次——宿主已经接受的创建撤不回来，所以不能替
 * 已经离开的客户端下单。监听在结束时显式解除，不轮询。
 */
function watchCreateClient(res) {
  const controller = new AbortController();
  let closedEarly = false;
  const onClose = () => {
    if (res.writableFinished) return;
    closedEarly = true;
    controller.abort();
  };
  res.on('close', onClose);
  return {
    signal: controller.signal,
    clientGone: () => closedEarly || res.destroyed,
    dispose: () => res.off('close', onClose),
  };
}

/**
 * 返回 true 表示本函数已经写响应；false 表示不满足代办条件，交回普通 Cookie 反代。
 * 认证已由调用方完成；这里只读取本机 owner 配置，绝不把 Cookie 发进 owner 请求。
 */
async function maybeProxyOwnerSession(req, res, principal, createClient = null) {
  // 客户端已经走了：连 owner 配置都不必读，更不能发创建。
  if (createClient?.clientGone()) {
    req.resume();
    return true;
  }
  if (!isOwnerPrincipalCandidate(principal)) return false;

  const owner = loadLocalOwner({
    hanaHome: HANA_HOME,
    upstreamHost: UPSTREAM.host,
    upstreamPort: UPSTREAM.port,
  });
  if (!owner.ok) {
    req.resume();
    sendOwnerError(res, 503, 'owner_unavailable');
    return true;
  }
  if (!isEligibleOwnerPrincipal(principal, owner.info)) return false;

  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    sendOwnerError(res, 415, 'invalid_request');
    return true;
  }

  const parsed = await readOwnerBody(req);
  if (!parsed.ok) {
    sendOwnerError(res, parsed.status, parsed.error);
    return true;
  }

  // 正文读完再确认一次：客户端可能在这段时间断开。创建一旦发出就不可撤销，
  // 所以只取消“尚未发出的副作用”，不声称能撤销宿主已接受的创建。
  if (createClient?.clientGone()) return true;

  const result = await requestOwnerSession({
    token: owner.token,
    port: owner.info.port,
    body: parsed.body,
  });
  if (!result.ok) {
    sendOwnerError(res, result.status, 'owner_session_create_failed');
    return true;
  }

  sendOwnerJson(res, 200, result.session);
  return true;
}

/* WebSocket、卡片托管、会话文件与静态托管已拆到各自模块，这里只管路由与启动。 */

const { proxyUpgrade } = createWebsocketProxy({
  isAllowedGatewayOrigin,
  log: logger ? (entry) => logger.log(entry) : null,
});

async function handleRequest(req, res) {
  const url = req.url || '';

  // 访问日志已经并入结构化日志（kind=http，带 method/path/status/ms/ip）：
  // 不再每个请求往 stdout 打一行 —— 那行会被 supervise.cmd 重定向到 %TEMP%\hana-gateway.log，
  // 那个文件没有轮转，一个跑得久的网关能把它堆到几万行。

  // 受保护精确路径的百分号编码别名一律拒绝（否则上游会按同一条路由处理，绕开网关附加的约束）
  if (isEncodedAliasOfProtectedPath(url)) {
    req.resume();
    denyEncodedPath(res);
    return;
  }

  // 所有写请求（登录、上传、卡片工具、新建会话……）先过同源 Origin 校验。
  if (isWriteMethod(req.method) && !isAllowedGatewayOrigin(req)) {
    req.resume();
    denyOrigin(res);
    return;
  }

  // 新建会话先确认 Cookie 会话；只有本机密码账户 + studio.owner 的精确
  // POST /api/sessions/new 才会走单独的 owner 代办分支，其余仍用客户端 Cookie。
  // 鉴权期间盯住连接：客户端一走就取消鉴权，避免后台白等上游。
  let createSessionAuth = null;
  let createClient = null;
  if (isWriteMethod(req.method) && isCreateSessionPath(url)) {
    createClient = watchCreateClient(res);
    const auth = await checkReadAuth(req, { signal: createClient.signal });
    if (createClient.clientGone()) {
      createClient.dispose();
      return;
    }
    if (!auth.ok) {
      createClient.dispose();
      req.resume();
      denyRead(res, auth);
      return;
    }
    createSessionAuth = auth;
  }

  if (url.startsWith('/shared/')) {
    let pathname;
    try {
      pathname = new URL(url, 'http://localhost').pathname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad url');
      return;
    }
    if (pathname === CARD_RUNTIME_PATH) {
      serveSharedCardRuntime(req, res).catch((err) => {
        res.gatewayError = err;
        if (!res.headersSent) denyCardRuntime(res);
        else res.destroy(err);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  if (url.startsWith('/gw/card/')) {
    const pathname = new URL(url, 'http://localhost').pathname;
    serveCard(req, res, pathname).catch((err) => {
      res.gatewayError = err;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`card error: ${err?.message || err}`);
    });
    return;
  }
  if (url.startsWith('/gw/feed/')) {
    const pathname = new URL(url, 'http://localhost').pathname;
    serveFeedCard(req, res, pathname).catch((err) => {
      res.gatewayError = err;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`feed card error: ${err?.message || err}`);
    });
    return;
  }
  if (url.startsWith('/gw/file/')) {
    const pathname = new URL(url, 'http://localhost').pathname;
    serveSessionFile(req, res, pathname).catch((err) => {
      res.gatewayError = err;
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`file error: ${err?.message || err}`);
    });
    return;
  }
  if (isApiPath(url)) {
    // owner bearer 只用于精确的 POST /api/sessions/new；new-detached 和相似路径
    // 仍按原样带客户端 Cookie 反代，绝不共用 isCreateSessionPath 的宽匹配。
    if (req.method === 'POST' && isOwnerSessionCreatePath(url) && createSessionAuth?.ok) {
      const handled = await maybeProxyOwnerSession(req, res, createSessionAuth.principal, createClient);
      if (handled) {
        createClient?.dispose();
        return;
      }
    }
    // 普通代理创建前再确认客户端仍存活：鉴权过后它可能已经断开。
    if (createClient?.clientGone()) {
      createClient.dispose();
      return;
    }
    createClient?.dispose();
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res).catch((err) => {
    res.gatewayError = err;
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`gateway error: ${err?.message || err}`);
  });
}

function requestHandler(req, res) {
  const startedAt = process.hrtime.bigint();
  let recorded = false;

  // 每个请求只记一条：正常结束和客户端中途断开都走这里，status 0 表示没写响应就走了。
  const recordRequest = () => {
    if (recorded || !logger) return;
    recorded = true;
    const status = res.headersSent ? res.statusCode : 0;
    const err = res.gatewayError;
    // 客户端地址（原来是 console 里的 [req] 行带的）：排「手机上打不开」时要分清这条是不是手机打的。
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    logger.log({
      level: status >= 500 ? 'error' : status >= 400 || status === 0 ? 'warn' : 'info',
      kind: 'http',
      ip,
      method: req.method,
      path: pathnameOf(req.url || ''),
      status,
      ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
      requestId: req.headers['x-request-id'],
      errorCode: err?.code,
      error: err?.message || (err ? String(err) : undefined),
    });
  };
  res.on('finish', recordRequest);
  res.on('close', recordRequest);

  handleRequest(req, res).catch((err) => {
    // 让请求日志能带上 5xx 的 errorCode / error（能拿到多少记多少）。
    res.gatewayError = err;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('gateway error');
  });
}

let server;
// 页面引用的是构建产物 `/dist/app.js`：启动前先确认它存在且不比源文件旧，
// 否则手机上会静默跑旧代码。只重建一次，失败不拦启动。
await ensureWebBundle({
  webRoot: WEB_ROOT,
  repoRoot: path.resolve(WEB_ROOT, '..'),
  log: (line) => (typeof logger?.log === 'function' ? logger.log({ level: 'info', msg: line }) : console.log(line)),
});

try {
  server = TLS_OPTIONS
    ? https.createServer(TLS_OPTIONS, requestHandler)
    : http.createServer(requestHandler);
} catch (err) {
  startupError(`failed to create server: ${err?.message || err}`);
}

server.on('upgrade', proxyUpgrade);

server.listen(LISTEN.port, LISTEN.host, () => {
  const host = LISTEN.host.includes(':') && !LISTEN.host.startsWith('[') ? `[${LISTEN.host}]` : LISTEN.host;
  const shown = LISTEN.host === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : host;
  if (logger) {
    logger.log({
      level: 'info',
      kind: 'lifecycle',
      event: 'start',
      port: LISTEN.port,
      pid: process.pid,
      detail: `listening on ${GATEWAY_SCHEME}://${shown}:${LISTEN.port} mode=${process.env.HANA_GW_MODE || 'direct'} upstream=http://${UPSTREAM.host}:${UPSTREAM.port}`,
    });
    // 启动时清一次过期日志；失败不影响服务（prune 内部已兜底，永不 reject）。
    logger.prune().catch(() => {});
  }
  console.log(`[hana-mobile] gateway listening on ${GATEWAY_SCHEME}://${shown}:${LISTEN.port}`);
  console.log(`[hana-mobile] static root : ${WEB_ROOT}`);
  console.log(`[hana-mobile] upstream    : http://${UPSTREAM.host}:${UPSTREAM.port}`);
  console.log(`[hana-mobile] ws logging  : ${LOG_WS ? WS_LOG : 'off'}`);
  if (EXTERNAL_HTTPS) {
    console.log(
      '[hana-mobile] external TLS: HANA_GW_EXTERNAL_HTTPS=1（Set-Cookie 补 Secure，卡片 CSP 用 https 前缀）',
    );
  }
});

process.on('SIGINT', () => {
  server.close(async () => {
    if (logger) {
      logger.log({ level: 'info', kind: 'lifecycle', event: 'stop', detail: 'SIGINT' });
      await logger.flush();
    }
    process.exit(0);
  });
});
