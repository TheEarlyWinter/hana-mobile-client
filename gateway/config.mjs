/**
 * 网关配置：环境变量、TLS、绑定策略。
 *
 * 这些值在进程启动时读一次就固定；不合法就在启动时退出，不带着半套配置起服务。
 *
 * 环境变量：
 *   HANA_UPSTREAM_HOST  上游地址，默认 127.0.0.1
 *   HANA_UPSTREAM_PORT  上游端口，默认 23917
 *   HANA_GW_PORT        监听端口，默认 24000
 *   HANA_GW_HOST        监听地址，默认 127.0.0.1
 *   HANA_GW_ALLOW_INSECURE_LAN  非回环 + 明文时必需设为 1
 *   HANA_GW_ALLOWED_ORIGINS     逗号分隔的显式允许 Origin（每一项都必须是单个 Origin）
 *   HANA_GW_EXTERNAL_HTTPS      设 1 表示公网 TLS 在网关外终止（隧道/反代），Set-Cookie 补 Secure
 *   HANA_GW_TLS_CERT_FILE / HANA_GW_TLS_KEY_FILE  同时提供才启用 HTTPS
 *   HANA_GW_LOG_WS      设 1 则把 WebSocket 文本帧写进 gateway/ws-frames.log
 *   HANA_GATEWAY_LOG    设 off 则整体关闭结构化日志（gateway/logs/*.jsonl）
 *   HANA_GATEWAY_LOG_DIR  结构化日志目录，默认 <仓库>/gateway/logs
 *   HANA_GATEWAY_LOG_MAX_BYTES  单文件上限，默认 5242880（5MB），超过就滚动到下一段
 *   HANA_GATEWAY_LOG_KEEP_FILES  只留最近多少份，默认 5；与单文件上限相乘就是硬上限
 *   HANA_GW_CARD_HOST_TOOL_IDLE_MS  card-host 工具调用 idle timeout，默认 160000（测试可调短）
 *   HANA_GW_WS_UPSTREAM_TIMEOUT_MS  WS 上游连接/握手超时，默认 10000（测试可调短）
 *   HANA_HOME           宿主数据目录，默认 ~/.hanako
 *
 * 卡片令牌的 TTL/上限、读取鉴权超时等细节配置放在用到它们的模块里。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBindPolicy, parseAllowedOrigins } from './security-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 启动期配置错误：打印一行就退出，不降级、不猜测。 */
export function startupError(message) {
  console.error(`[hana-mobile] ${message}`);
  process.exit(1);
}

export const WEB_ROOT = path.resolve(__dirname, '..', 'web');
export const WS_LOG = path.join(__dirname, 'ws-frames.log');
export const LOG_WS = process.env.HANA_GW_LOG_WS === '1';

/** 结构化日志：默认落 gateway/logs，`HANA_GATEWAY_LOG=off` 整体关闭。 */
export const LOG_ENABLED = String(process.env.HANA_GATEWAY_LOG || '').trim().toLowerCase() !== 'off';
export const LOG_DIR = process.env.HANA_GATEWAY_LOG_DIR
  ? path.resolve(process.env.HANA_GATEWAY_LOG_DIR)
  : path.join(__dirname, 'logs');

/** 正整数环境变量；不合法就用默认值（不因为写错一个数变成无限增长）。 */
function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * 轮转参数：单文件上限 × 保留份数 = 日志目录的硬上限（默认 5 × 5MB = 25MB）。
 * 默认值写在 logger.mjs 里；这里只在环境变量确实给了合法值时覆盖。
 */
export const LOG_MAX_BYTES = positiveIntEnv('HANA_GATEWAY_LOG_MAX_BYTES', 5 * 1024 * 1024);
export const LOG_KEEP_FILES = positiveIntEnv('HANA_GATEWAY_LOG_KEEP_FILES', 5);

export const UPSTREAM = {
  host: process.env.HANA_UPSTREAM_HOST || '127.0.0.1',
  port: Number(process.env.HANA_UPSTREAM_PORT || 23917),
};

export const LISTEN = {
  host: process.env.HANA_GW_HOST || '127.0.0.1',
  port: Number(process.env.HANA_GW_PORT || 24000),
};

export const ALLOW_INSECURE_LAN = process.env.HANA_GW_ALLOW_INSECURE_LAN === '1';

/**
 * 显式允许源：逗号分隔的多项，但每一项都必须是单个 Origin。
 * 配错就启动失败，不降级成“少一条”或“多一条”——静默丢掉非法项会让人以为生效了。
 */
export const ALLOWED_ORIGINS = (() => {
  const raw = process.env.HANA_GW_ALLOWED_ORIGINS || '';
  try {
    return parseAllowedOrigins(raw, { strict: true });
  } catch (err) {
    startupError(
      `HANA_GW_ALLOWED_ORIGINS 有非法项（每一项只许是一个 Origin：scheme://host[:port]，不含逗号/路径/查询/片段/空白/userinfo）：${err?.message || err}`,
    );
    return new Set();
  }
})();

const TLS_CERT_FILE = process.env.HANA_GW_TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.HANA_GW_TLS_KEY_FILE || '';

/**
 * 公网 TLS 在网关外终止（隧道/反代）时由启动脚本显式注入。
 * 为什么不看 X-Forwarded-Proto：那个头客户端也能伪造，用它加 Secure 等于让
 * “谁都能决定网关把 Cookie 当成不是 Secure 的”，或者反过来把明文连接当成 HTTPS。
 */
export const EXTERNAL_HTTPS = process.env.HANA_GW_EXTERNAL_HTTPS === '1';

const tls = (() => {
  if (Boolean(TLS_CERT_FILE) !== Boolean(TLS_KEY_FILE)) {
    startupError('HANA_GW_TLS_CERT_FILE and HANA_GW_TLS_KEY_FILE must both be set');
  }
  if (!TLS_CERT_FILE) return { options: null, scheme: 'http' };
  try {
    return {
      options: {
        cert: fs.readFileSync(TLS_CERT_FILE),
        key: fs.readFileSync(TLS_KEY_FILE),
      },
      scheme: 'https',
    };
  } catch (err) {
    startupError(`failed to read TLS certificate/key: ${err?.message || err}`);
    return { options: null, scheme: 'http' };
  }
})();

export const TLS_OPTIONS = tls.options;
export const GATEWAY_SCHEME = tls.scheme;

/**
 * 浏览器地址栏里看到的 scheme（「对外 scheme」）：网关自己终止 TLS 时就是
 * GATEWAY_SCHEME，公网 TLS 在网关外终止（隧道/反代）时被 HANA_GW_EXTERNAL_HTTPS
 * 提升成 https。
 * 只用于拼给浏览器用的绝对地址（卡片 CSP 的源码前缀）和 Cookie Secure；同源判定
 * 不用它 —— 同源看的是本次连接真实的 scheme，见 security-policy.mjs 的 isAllowedOrigin。
 */
export const EXTERNAL_SCHEME = EXTERNAL_HTTPS ? 'https' : GATEWAY_SCHEME;

const bindPolicy = evaluateBindPolicy({
  host: LISTEN.host,
  tls: Boolean(TLS_OPTIONS),
  allowInsecureLan: ALLOW_INSECURE_LAN,
});
if (!bindPolicy.ok) {
  startupError(
    'refusing plaintext HTTP on a non-loopback HANA_GW_HOST; set HANA_GW_ALLOW_INSECURE_LAN=1 to accept the LAN plaintext risk',
  );
}
if (bindPolicy.insecureLan) {
  console.warn(
    `[hana-mobile] WARNING: plaintext HTTP bound to non-loopback host ${LISTEN.host}; HANA_GW_ALLOW_INSECURE_LAN=1 is in effect`,
  );
}

/** 反代到上游的空闲超时。普通请求 60s；card-host 工具确认/执行单独放宽，默认 160s。 */
export const UPSTREAM_IDLE_MS = 60_000;
export const CARD_HOST_TOOL_IDLE_MS = (() => {
  const raw = Number(process.env.HANA_GW_CARD_HOST_TOOL_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 160_000;
})();

/** WS 上游连接 + 握手超时：连不上或迟迟不回 101 都不能把客户端 socket 永远挂着。 */
export const WS_UPSTREAM_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HANA_GW_WS_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

/** 宿主数据目录：卡片、会话文件、上传都在它下面。 */
export const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), '.hanako');
