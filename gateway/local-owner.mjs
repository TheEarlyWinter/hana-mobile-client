/* 本机 owner 配置读取与新建会话代办资格。
 *
 * 只读 HANA_HOME/server-info.json；不读取任何其它配置、Cookie 或密码文件。
 * 失败原因只返回安全代码，不带文件路径、JSON 错误或 token。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_INFO_NAME = 'server-info.json';
const SERVER_INFO_MAX_BYTES = 64 * 1024;
const TOKEN_MAX_LENGTH = 4096;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** 与官方 CLI 的默认 HANA_HOME 解析保持一致；测试可显式传入。 */
export function resolveHanaHome(env = process.env) {
  const configured = typeof env?.HANA_HOME === 'string' ? env.HANA_HOME.trim() : '';
  return configured || path.join(os.homedir(), '.hanako');
}

/** owner 请求只能发往回环地址；不做 DNS 解析。 */
export function isLoopbackAddress(host) {
  const raw = String(host || '').trim().toLowerCase();
  const normalized = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return LOOPBACK_HOSTS.has(normalized);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取当前本机 server-info。每次调用都重新读文件，确保 token 轮换后不继续使用旧值。
 * 返回的失败对象只有 ok/reason，不包含 token、文件内容或底层错误。
 */
export function loadLocalOwner({ hanaHome, upstreamHost, upstreamPort } = {}) {
  if (!nonEmptyString(hanaHome)) return { ok: false, reason: 'invalid_hana_home' };
  if (!isLoopbackAddress(upstreamHost)) return { ok: false, reason: 'unsafe_upstream' };
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    return { ok: false, reason: 'invalid_upstream_port' };
  }

  const filePath = path.join(hanaHome, SERVER_INFO_NAME);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: 'missing_server_info' };
  }
  if (!stat.isFile() || stat.size > SERVER_INFO_MAX_BYTES) {
    return { ok: false, reason: 'invalid_server_info' };
  }

  let info;
  try {
    info = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { ok: false, reason: 'invalid_server_info' };
  }
  if (!isPlainObject(info)) return { ok: false, reason: 'invalid_server_info' };

  const token = info.token;
  const pid = info.pid;
  const port = info.port;
  const serverId = typeof info.serverId === 'string' && info.serverId ? info.serverId : null;
  const serverNodeId =
    typeof info.serverNodeId === 'string' && info.serverNodeId
      ? info.serverNodeId
      : serverId;
  const studioId = typeof info.studioId === 'string' && info.studioId ? info.studioId : null;

  if (!nonEmptyString(token) || token.length > TOKEN_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    return { ok: false, reason: 'incomplete_server_info' };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'incomplete_server_info' };
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'incomplete_server_info' };
  }
  if (!serverNodeId || !studioId) return { ok: false, reason: 'incomplete_server_info' };

  if (port !== upstreamPort) return { ok: false, reason: 'port_mismatch' };
  if (!isProcessAlive(pid)) return { ok: false, reason: 'stale_pid' };

  return {
    ok: true,
    token,
    info: {
      pid,
      port,
      serverId,
      serverNodeId,
      studioId,
    },
  };
}

/**
 * 代办资格：只允许本机密码账户（account_user / user_session / password）且持有
 * studio.owner scope，并要求登录快照里的 server/studio 与当前本机 server-info 一致。
 *
 * 刻意不比较 userId：官方只保证本机 owner 记录和账户记录存在于同一实例，
 * 不保证两者的 userId 字面相同；比较 userId 会误拒正常账户。
 * 也不用 connectionKind 作为门：网关转发到上游时的 transport 归类会随 network.mode
 * 变化，账户身份由 kind/credentialKind/authMethod 锁定，本机边界由 server/studio 绑定。
 */
export function isOwnerPrincipalCandidate(principal) {
  if (!isPlainObject(principal)) return false;
  if (principal.kind !== 'account_user') return false;
  if (principal.credentialKind !== 'user_session') return false;
  if (principal.authMethod !== 'password') return false;
  return Array.isArray(principal.scopes) && principal.scopes.includes('studio.owner');
}

export function isEligibleOwnerPrincipal(principal, ownerInfo) {
  if (!isOwnerPrincipalCandidate(principal) || !isPlainObject(ownerInfo)) return false;

  if (!nonEmptyString(principal.serverNodeId) || !nonEmptyString(ownerInfo.serverNodeId)) return false;
  if (principal.serverNodeId !== ownerInfo.serverNodeId) return false;
  if (!nonEmptyString(principal.studioId) || !nonEmptyString(ownerInfo.studioId)) return false;
  if (principal.studioId !== ownerInfo.studioId) return false;

  // serverId 在部分运行时上下文中可能为空；只有本机记录明确给出时才比对。
  if (nonEmptyString(ownerInfo.serverId) && principal.serverId !== ownerInfo.serverId) return false;

  return true;
}
