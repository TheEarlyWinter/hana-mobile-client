/**
 * HTTP 反向代理：把 /api 的请求原样转给本机 hana-server，并在响应侧加网关自己的约束。
 *
 * 三类约束都在这一个文件里，因为它们的顺序和边界互相牵制：
 *   - 工作区 content 路径：一律强制附件下载，3xx 直接失败（不能把 Cookie 带去 Location）；
 *   - 其它 /api 的主动内容（HTML/SVG/XHTML）：同样降级成下载，不当页面解释；
 *   - 其余响应：剥 hop-by-hop 头、必要时给 Set-Cookie 补 Secure。
 *
 * 连接生命周期：客户端断开 / 上游中途断开 / 正常结束都走同一个幂等 teardown，
 * 否则客户端一走开，上游 socket 会一直挂到 idle timeout。
 */

import http from 'node:http';
import {
  CARD_HOST_TOOL_IDLE_MS,
  EXTERNAL_SCHEME,
  UPSTREAM,
  UPSTREAM_IDLE_MS,
} from './config.mjs';
import {
  isLogoutPath,
  isWorkspaceContentPath,
  secureSetCookieHeaders,
  stripHopByHopHeaders,
  upstreamIdleTimeoutFor,
} from './security-policy.mjs';
import { upstreamHeaders } from './upstream-access.mjs';
import { revokeCardTokens } from './card-host.mjs';

const WORKSPACE_CONTENT_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
const API_DOCUMENT_CSP = "sandbox; default-src 'none'";
const API_DOCUMENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);

function mimeOf(headers = {}) {
  const raw = Array.isArray(headers['content-type']) ? headers['content-type'][0] : headers['content-type'];
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
}

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    // 控制字符和路径/头注入字符先清掉；Unicode 正文保留给 filename*。
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  // 按 code point 截断，避免把代理对切成半个字符。
  return Array.from(cleaned).slice(0, 120).join('').trim();
}

/** RFC 6266 的 filename= 只能是 ASCII；非 ASCII 字符逐字降级成下划线。 */
function asciiFilename(name) {
  return Array.from(String(name || ''), (ch) =>
    /^[\x20-\x7e]$/.test(ch) && ch !== '"' && ch !== '\\' ? ch : '_',
  ).join('');
}

function safeAttachmentFilename(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return '';

  let name = '';
  const encoded = value.match(/filename\*\s*=\s*([^;]+)/i);
  if (encoded) {
    const candidate = encoded[1].trim().replace(/^UTF-8''/i, '');
    try {
      name = decodeURIComponent(candidate);
    } catch {
      name = '';
    }
  }
  if (!name) {
    const plain = value.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    if (plain) name = (plain[1] ?? plain[2] ?? '').trim();
  }

  name = sanitizeFilename(name);
  return name;
}

/**
 * 一律按附件下载。上游没给文件名时，用 URL 里的 name 参数兜底。
 *
 * 为什么要兜底：/api/mobile/workspace/content 的路径里没有扩展名，
 * Android 的 URLUtil.guessFileName 只能从 Content-Disposition 或 MIME 推，
 * 两者都缺时就把文件存成 <uuid>.bin——用户在下载目录里根本认不出是什么。
 */
function attachmentDisposition(raw, fallbackName = '') {
  const filename = safeAttachmentFilename(raw) || sanitizeFilename(fallbackName);
  if (!filename) return 'attachment';
  // filename= 只放 ASCII fallback；Unicode 原名放 RFC 5987 的 filename*。
  const ascii = asciiFilename(filename) || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 工作区 content 路由：无论上游怎么声明，都按下载处理并锁死解释/缓存。 */
function hardenWorkspaceContentHeaders(upstreamHeadersValue, rawUrl = '') {
  const headers = { ...upstreamHeadersValue };
  const forced = new Set([
    'content-disposition',
    'x-content-type-options',
    'cache-control',
    'content-security-policy',
  ]);
  for (const key of Object.keys(headers)) {
    if (forced.has(key.toLowerCase())) delete headers[key];
  }
  let fallbackName = '';
  try {
    fallbackName = new URL(rawUrl, 'http://localhost').searchParams.get('name') || '';
  } catch {
    fallbackName = '';
  }
  headers['content-disposition'] = attachmentDisposition(upstreamHeadersValue['content-disposition'], fallbackName);
  headers['x-content-type-options'] = 'nosniff';
  headers['cache-control'] = 'no-store';
  headers['content-security-policy'] = WORKSPACE_CONTENT_CSP;
  return headers;
}

/** 任意 /api 文档响应：同源 active content 也只能下载，不能当页面解释。 */
function hardenApiDocumentHeaders(upstreamHeadersValue) {
  const headers = { ...upstreamHeadersValue };
  const forced = new Set([
    'content-disposition',
    'x-content-type-options',
    'cache-control',
    'content-security-policy',
  ]);
  for (const key of Object.keys(headers)) {
    if (forced.has(key.toLowerCase())) delete headers[key];
  }
  headers['content-disposition'] = attachmentDisposition(upstreamHeadersValue['content-disposition']);
  headers['x-content-type-options'] = 'nosniff';
  headers['cache-control'] = 'no-store';
  headers['content-security-policy'] = API_DOCUMENT_CSP;
  return headers;
}

/**
 * @param {{ isApiPath: (rawUrl: string) => boolean }} deps 路由层的 API 前缀判定（与 server.mjs 共用一份）
 */
export function createHttpProxy({ isApiPath }) {
  function isApiDocumentResponse(req, headers) {
    if (!isApiPath(req.url || '')) return false;
    return API_DOCUMENT_TYPES.has(mimeOf(headers));
  }

  function hardenProxyResponseHeaders(req, upstreamHeadersValue, status = 0) {
    if (isWorkspaceContentPath(req.url || '')) return hardenWorkspaceContentHeaders(upstreamHeadersValue, req.url || '');
    // 非工作区下载入口的 3xx 保持原样，不因通用文档规则改变重定向语义。
    if (status >= 300 && status < 400) return upstreamHeadersValue;
    if (isApiDocumentResponse(req, upstreamHeadersValue)) return hardenApiDocumentHeaders(upstreamHeadersValue);
    return upstreamHeadersValue;
  }

  function proxyHttp(req, res) {
    // hop-by-hop 头只描述“客户端↔网关”这一跳，不能带到上游去
    const headers = stripHopByHopHeaders(upstreamHeaders(req.headers));

    // 幂等收尾：客户端断开、上游断开、正常结束都走同一条路，
    // 否则客户端一走开，上游 socket 会一直挂到 idle timeout。
    let upstreamResRef = null;
    let settled = false;
    let upstreamReq = null;
    const teardown = () => {
      if (settled) return;
      settled = true;
      if (upstreamResRef) upstreamResRef.destroy();
      if (upstreamReq) upstreamReq.destroy();
    };

    upstreamReq = http.request(
      {
        host: UPSTREAM.host,
        port: UPSTREAM.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        upstreamResRef = upstreamRes;
        // 上游可能在响应头之后断掉：不接住就是未捕获的 'error'，能直接打挂网关；
        // 接住之后还得把客户端那边一起断掉，否则前端会挂在一个永远收不完的响应上。
        const failResponse = () => {
          if (!res.writableEnded && !res.destroyed) res.destroy();
          teardown();
        };
        upstreamRes.on('error', failResponse);
        upstreamRes.on('close', () => {
          if (!upstreamRes.complete) failResponse();
        });

        const st = upstreamRes.statusCode || 502;
        // 工作区下载入口不能把 Cookie 带进任何 3xx：不复制 Location、不跟随、不请求目标。
        // 304 也按失败处理，避免客户端缓存/条件请求改变下载路径。
        if (isWorkspaceContentPath(req.url || '') && st >= 300 && st < 400) {
          upstreamRes.on('error', () => {});
          upstreamRes.resume();
          const body = JSON.stringify({ error: 'download_redirect_blocked' });
          res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
          });
          res.end(body);
          return;
        }
        // 4xx/5xx 不再单独打 console：server.mjs 的 requestHandler 对每个请求只记一条
        // 结构化 http 记录，已经带 status / ms / ip / error，这行是重复的，而且它写的是
        // %TEMP% 里的控制台流，长期不重启就会一直长。
        // 只有服务端明确成功的 logout 才立即撤销所有卡片短时令牌。
        if (isLogoutPath(req.url || '') && st >= 200 && st < 300) {
          revokeCardTokens();
        }
        const responseHeaders = stripHopByHopHeaders(hardenProxyResponseHeaders(req, upstreamRes.headers, st));
        const setCookieKey = Object.keys(responseHeaders).find((key) => key.toLowerCase() === 'set-cookie');
        if (setCookieKey) {
          responseHeaders[setCookieKey] = secureSetCookieHeaders(responseHeaders[setCookieKey], {
            secure: EXTERNAL_SCHEME === 'https',
          });
        }
        if (res.destroyed || res.writableEnded) {
          teardown();
          return;
        }
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );

    // 客户端走了就不能继续往上写：不然后台白白等一个没人要的响应。
    req.on('aborted', teardown);
    req.on('error', teardown);
    res.on('error', teardown);
    res.on('close', () => {
      if (!res.writableFinished) teardown();
    });

    // 上游卡死时不能把客户端连接永远挂着（前端 15 秒会放弃，但这里不主动断就一直占着 socket）
    const idleMs = upstreamIdleTimeoutFor(req.url || '', {
      defaultMs: UPSTREAM_IDLE_MS,
      toolInvokeMs: CARD_HOST_TOOL_IDLE_MS,
    });
    upstreamReq.setTimeout(idleMs, () => {
      upstreamReq.destroy(new Error(`upstream idle > ${idleMs}ms`));
    });

    upstreamReq.on('error', (err) => {
      // 已经收尾过了：这是自己拆的（客户端断开 / 上游中断），不是要回给客户端的上游故障
      if (settled) return;
      if (res.destroyed || res.writableEnded) {
        teardown();
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // 交给 server.mjs 的请求日志：5xx 记录带 errorCode（ECONNREFUSED / ETIMEDOUT …）。
      res.gatewayError = err;
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: 'upstream_unreachable',
          detail: err.message,
          hint: 'hana-server 没在跑？确认桌面端已启动，且端口与 HANA_UPSTREAM_PORT 一致。',
        }),
      );
    });

    req.pipe(upstreamReq);
  }

  return { proxyHttp };
}
