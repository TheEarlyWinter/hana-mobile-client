/* 网关边界策略：只放纯函数，便于回归测试，不读取任何宿主凭据。 */

import fs from 'node:fs';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const DROP_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-access-token',
  'x-api-key',
  'api-key',
  'forwarded',
  'x-forwarded',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-rewrite-url',
]);

const ORIGIN_MAX_LENGTH = 255;

/**
 * 单项允许源校验：一个字符串只能是恰好一个 Origin（scheme://host[:port]）。
 *
 * 为什么连逗号都要拒绝：配置里的一项会变成会话里的一段文本，而下游按逗号拆成多个源。
 * 放行逗号就等于让“一项配置”偷偷变成“多个源”，写错一项就把别人的域名放行了。
 * 反斜杠也拒绝：`new URL` 对特殊协议会把 `\\` 当成 `/`，先挡在同一条判定里更省事。
 *
 * 返回 { ok: true, origin } 或 { ok: false, reason }；reason 只用于诊断，不含输入原文。
 */
export function validateAllowedOrigin(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not_a_string' };
  const text = value.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > ORIGIN_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (text.includes(',')) return { ok: false, reason: 'comma' };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'whitespace' };
  if (text.includes('\\')) return { ok: false, reason: 'backslash' };

  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'relative' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (!url.hostname) return { ok: false, reason: 'host' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo' };
  if (url.search) return { ok: false, reason: 'query' };
  if (url.hash) return { ok: false, reason: 'fragment' };
  if (url.pathname !== '/') return { ok: false, reason: 'path' };
  return { ok: true, origin: `${url.protocol}//${url.host}`.toLowerCase() };
}

function normalizeOrigin(value) {
  const result = validateAllowedOrigin(value);
  return result.ok ? result.origin : null;
}

/** 写请求：只把 GET / HEAD / OPTIONS 当只读，其余一律要求同源 Origin。 */
export function isWriteMethod(method) {
  return !SAFE_METHODS.has(String(method || '').toUpperCase());
}

/** 默认回环判定：localhost、127/8、::1。 */
export function isLoopbackHost(host) {
  const raw = String(host || '').trim().toLowerCase();
  const h = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice('::ffff:'.length));
  if (net.isIP(h) === 4) return h.startsWith('127.');
  return false;
}

/**
 * 明文绑定策略：loopback 或 TLS 可以直接；非 loopback + 明文必须显式 opt-in。
 * 返回 insecureLan 让启动日志打印明文风险。
 */
export function evaluateBindPolicy({ host, tls = false, allowInsecureLan = false } = {}) {
  if (isLoopbackHost(host)) return { ok: true, insecureLan: false };
  if (tls) return { ok: true, insecureLan: false };
  if (allowInsecureLan === true) return { ok: true, insecureLan: true };
  return { ok: false, insecureLan: false };
}

/**
 * 解析显式允许源列表（逗号分隔的多项，每一项都必须是单个 Origin）。
 *
 * strict=false：非法项丢弃，不把坏配置当成放行（老行为）。
 * strict=true ：非法项直接抛错——启动脚本要的是“配错就起不来”，而不是“悄悄少一条”。
 */
export function parseAllowedOrigins(raw = '', { strict = false } = {}) {
  const out = new Set();
  for (const item of String(raw ?? '').split(',')) {
    const text = item.trim();
    if (!text) continue;
    const result = validateAllowedOrigin(text);
    if (result.ok) {
      out.add(result.origin);
      continue;
    }
    if (!strict) continue;
    const err = new Error(`invalid allowed origin (${result.reason})`);
    err.reason = result.reason;
    throw err;
  }
  return out;
}

/**
 * HTTP 写请求 / WebSocket 握手源校验：
 * - 缺省、空、null、带路径/userinfo 的 Origin 一律拒绝；
 * - 同源要求 scheme 与网关实际 scheme 一致，host 与本次请求 Host 一致；
 * - 或命中显式允许源列表；
 * - 不读取 X-Forwarded-Proto。
 */
export function isAllowedOrigin({ origin, host, scheme, allowedOrigins = new Set() } = {}) {
  if (typeof origin !== 'string' || !origin.trim() || origin.trim().toLowerCase() === 'null') return false;
  if (typeof host !== 'string' || !host.trim()) return false;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins instanceof Set && allowedOrigins.has(normalized)) return true;

  const proto = String(scheme || '').toLowerCase();
  if (proto !== 'http' && proto !== 'https') return false;
  const expected = normalizeOrigin(`${proto}://${host}`);
  return Boolean(expected) && normalized === expected;
}

/**
 * 转发到上游前的头清理：
 * - 不把客户端 Authorization 变成上游凭据；
 * - 不把客户端伪造的转发/本机信任头带进上游；
 * - Cookie 保留，移动端只靠 Cookie 授权；
 * - Host 由调用方最后覆盖。
 */
export function sanitizeUpstreamHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    if (DROP_HEADERS.has(lower)) continue;
    if (lower.includes('forwarded')) continue;
    if (lower.startsWith('x-hana-') || lower === 'x-hana') continue;
    out[lower] = value;
  }
  delete out.host;
  return out;
}

/** 标准 hop-by-hop 头：只对单跳连接有意义，不能跨代理转发。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 剥离 hop-by-hop 头，连同 `Connection: xxx, yyy` 里点名的字段一起剥。
 *
 * WS 升级必需的 connection/upgrade 用 keepUpgrade 显式保留（代理普通 HTTP 用不到）。
 * 只删“描述本跳连接”的头，正文长度/类型/缓存类头一律不动。
 */
export function stripHopByHopHeaders(headers = {}, { keepUpgrade = false } = {}) {
  const listed = new Set();
  for (const [name, value] of Object.entries(headers)) {
    if (!name || name.toLowerCase() !== 'connection' || typeof value !== 'string') continue;
    for (const token of value.split(',')) {
      const field = token.trim().toLowerCase();
      if (field) listed.add(field);
    }
  }

  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    const upgradeField = lower === 'connection' || lower === 'upgrade';
    // 升级握手时 connection/upgrade 必须原样带到上游（包括 Connection 里点名的 upgrade）
    if (keepUpgrade && upgradeField) {
      out[lower] = value;
      continue;
    }
    if (listed.has(lower)) continue;
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function pathnameOf(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/')) return null;
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

/**
 * 逐层解码后的规范化 pathname（最多 5 层，抵双重/三层编码）；解不开返回 null。
 *
 * 为什么要解码：`new URL().pathname` 不会把 `%74` 变成 `t`，而上游（以及大多数
 * 服务端路由）会。只比原始路径就会漏掉 `/api/workspace/con%74ent` 这种“同一条路由的
 * 编码写法”，而安全相关的精确匹配（强制下载、logout 撤销）都是按字面路径判的。
 */
export function decodedPathname(rawUrl) {
  const raw = pathnameOf(rawUrl);
  if (raw === null) return null;
  let current = raw;
  for (let depth = 0; depth < 5; depth += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** WS 只允许 /ws（query 可以），/ws/、/socket 等一律不升级。 */
export function isWsPath(rawUrl) {
  return pathnameOf(rawUrl) === '/ws';
}

/** 新建会话路径：可先做 Cookie 会话检查，但检查通过也不能提权。 */
export function isCreateSessionPath(rawUrl) {
  const pathname = pathnameOf(rawUrl);
  return pathname === '/api/sessions/new' || pathname === '/api/sessions/new-detached';
}

/**
 * 只匹配真正的 POST /api/sessions/new。
 * 绝不匹配 new-detached；owner bearer 只能用于这一个精确路径。
 */
export const OWNER_SESSION_CREATE_PATH = '/api/sessions/new';

export function isOwnerSessionCreatePath(rawUrl) {
  return pathnameOf(rawUrl) === OWNER_SESSION_CREATE_PATH;
}

/** 实际 logout 路径；仅在证据明确时用于撤销卡片令牌。 */
export function isLogoutPath(rawUrl) {
  return pathnameOf(rawUrl) === '/api/web-auth/logout';
}

/** 工作区内容读取路由（四个宿主别名）：必须强制下载，不能按扩展名 inline 渲染。 */
const WORKSPACE_CONTENT_PATHS = new Set([
  '/api/mobile/workspace/content',
  '/api/workspace/content',
  '/api/mobile/workbench/content',
  '/api/workbench/content',
]);

export function isWorkspaceContentPath(rawUrl) {
  const decoded = decodedPathname(rawUrl);
  return decoded !== null && WORKSPACE_CONTENT_PATHS.has(decoded);
}

/**
 * 网关自己附加了约束的精确路径：一旦用百分号编码别名命中这些路径，
 * 那套约束就会被绕过（强制下载头、logout 撤销令牌、owner 代办边界……）。
 */
const PROTECTED_EXACT_PATHS = new Set([
  ...WORKSPACE_CONTENT_PATHS,
  '/api/web-auth/logout',
  '/api/sessions/new',
  '/api/sessions/new-detached',
  '/api/card-host/tools/invoke',
]);

/**
 * 原始路径带 percent-encoding、解码后却落在受保护精确路径上 —— 编码别名。
 * 这类请求一律拒绝：上游会把它当成同一条路由，网关却认不出来。
 */
export function isEncodedAliasOfProtectedPath(rawUrl) {
  const raw = pathnameOf(rawUrl);
  if (typeof raw !== 'string' || !raw.includes('%')) return false;
  const decoded = decodedPathname(rawUrl);
  if (decoded === null) return false;
  return PROTECTED_EXACT_PATHS.has(decoded);
}

/** card-host 工具调用需要等待宿主第二道确认 + 工具执行，单独放宽 idle timeout。 */
const CARD_HOST_TOOL_INVOKE_PATH = '/api/card-host/tools/invoke';

export function isCardHostToolInvokePath(rawUrl) {
  return pathnameOf(rawUrl) === CARD_HOST_TOOL_INVOKE_PATH;
}

/**
 * 只按精确路径选择上游 idle timeout；不接受调用方用其他路径借走长超时。
 * 默认值只作为策略参数，测试可注入短值。
 */
export function upstreamIdleTimeoutFor(rawUrl, { defaultMs = 60_000, toolInvokeMs = 160_000 } = {}) {
  const tool = isCardHostToolInvokePath(rawUrl);
  const selected = Number(tool ? toolInvokeMs : defaultMs);
  if (Number.isFinite(selected) && selected > 0) return selected;
  return tool ? 160_000 : 60_000;
}

/**
 * 在 HTTPS 网关终止 TLS 时，上游 HTTP web-auth 签发的 Set-Cookie 不一定带 Secure。
 * 逐条保留原值并补 Secure；已有该属性（大小写不敏感）不重复；数组不按逗号拆分。
 */
export function secureSetCookieHeaders(setCookie, { secure = false } = {}) {
  if (!secure || setCookie == null) return setCookie;
  const secureOne = (value) => {
    if (typeof value !== 'string' || !value) return value;
    const hasSecure = value
      .split(';')
      .slice(1)
      .some((part) => part.trim().split('=')[0].trim().toLowerCase() === 'secure');
    if (hasSecure) return value;
    return `${value.replace(/;\s*$/, '')}; Secure`;
  };
  return Array.isArray(setCookie) ? setCookie.map(secureOne) : secureOne(setCookie);
}

/* ------------------------------------------------------------------ */
/* CLI：给 start.ps1 / 运维脚本复用同一份 Origin 校验                    */
/* ------------------------------------------------------------------ */
/**
 * PowerShell 里再写一份正则，迟早会和这里的判定漂移（一边放行一边拒绝最危险），
 * 所以 start.ps1 直接把每一项交给这里：
 *   node gateway/security-policy.mjs --check-origins   （stdin 一行一项）
 * 退出码 0 + stdout 输出逗号分隔的规范化列表；失败输出原因到 stderr，退出码 2。
 */
function runCli(argv) {
  if (argv.includes('--check-origins')) {
    // stdin 没人喂就必须立刻退出：否则 readFileSync(0) 会挂在控制台输入上，
    // 在 Windows 上表现为一个永远不关的黑色 node 窗口，而且没有超时。
    if (process.stdin.isTTY) {
      process.stderr.write('usage: node security-policy.mjs --check-origins < origins.txt\n');
      process.exitCode = 64;
      return;
    }
    const guard = setTimeout(() => {
      process.stderr.write('error: --check-origins 等 stdin 超时（上游没有关管道）\n');
      process.exit(64);
    }, 10_000);
    if (typeof guard.unref === 'function') guard.unref();
    const raw = fs.readFileSync(0, 'utf8');
    clearTimeout(guard);
    const okOrigins = [];
    const problems = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const result = validateAllowedOrigin(line);
      if (result.ok) okOrigins.push(result.origin);
      else problems.push(`${line.trim()} (${result.reason})`);
    }
    if (problems.length > 0) {
      process.stderr.write(`invalid allowed origin: ${problems.join('; ')}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${okOrigins.join(',')}\n`);
    return;
  }

  process.stderr.write('usage: node security-policy.mjs --check-origins < origins.txt\n');
  process.exitCode = 64;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2));
}
