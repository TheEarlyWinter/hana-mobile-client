/* web/card-bridge.js — 卡片双向通信宿主桥
 *
 * 核心安全设计与契约：
 * 1. 独立缓存与并发控制：每个已注册卡片独立维护 cache 与 pending；单副作用互斥锁（每 record 同一时刻仅准一个 invoke/emit，并发拒绝 CARD_ACTION_BUSY）；
 * 2. 严格 fail-closed：缺省 confirmAction、确认未通过或抛错、getActiveContext 失效或不匹配时，坚决阻断 POST；
 * 3. 活跃上下文与竞态拦截：confirm pending 与 prepare pending 恢复后，二次核验 frame 挂载、未被注销且 sessionId/sessionPath 精确一致；
 * 4. 严谨权限与实体校验：chat 隐式派生 sessions.read/write（不派生 sessions.create），正则验证 chat-card 实体，严密校验 scopes；
 * 5. 协议集中适配：规范映射 host.capabilities / state.get / state.set / tool.invoke / emit / track / data.get；
 * 6. 宿主第二道确认 handleHostConfirmation：严格匹配正在 pending invoke 的卡片，独立弹窗二次确认，发送 confirmed/rejected POST；
 * 7. 文档通道：register 生成 256-bit nonce，SDK 从受控 meta / URL fragment 读取并通过一次性 MessageChannel 连接；窗口裸请求一律拒绝；
 * 8. 预算与缓存：invoke input 64KiB/节点/深度上限，响应 256KiB、缓存 512KiB/100 条，超限不进入确认/API/缓存。
 */

const CHAT_CARD_ENTITY_REGEX = /^chat-card:[A-Za-z0-9_-]{1,128}$/;
const NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_EMIT_BYTES = 8192;
const MAX_STATE_BYTES = 65536;
const MAX_DATA_BYTES = 262144; // 256 KiB 数据广播上限
const MAX_REQUEST_ID_LEN = 128;
const MAX_CACHE_PER_FRAME = 100;
const MAX_CACHE_TOTAL_BYTES = 512 * 1024;
const MAX_CACHE_RESPONSE_BYTES = 256 * 1024;
const MAX_PENDING_PER_FRAME = 50;
const MAX_BINDING_ID_LEN = 128;
const MAX_INVOKE_INPUT_BYTES = 64 * 1024;
const MAX_INVOKE_INPUT_NODES = 4096;
const MAX_INVOKE_STRING_BYTES = 64 * 1024;
const MAX_INVOKE_DEPTH = 64;
const MIN_REQUEST_TIMEOUT_MS = 10;
const MAX_REQUEST_TIMEOUT_MS = 300000;
const MAX_HANDLED_CONFIRM_IDS = 1024;

function hasScope(scopes, requiredScope) {
  if (!Array.isArray(scopes)) return false;
  if (scopes.includes('*') || scopes.includes(requiredScope)) return true;
  // studio.owner 是精确权限，不能被较宽的 studio 命名空间冒充
  if (requiredScope === 'studio.owner') return false;
  // 宿主契约（76980–77001）：chat 隐式派生 sessions.read 与 sessions.write，但不派生 sessions.create
  if (scopes.includes('chat')) {
    if (requiredScope === 'sessions.read' || requiredScope === 'sessions.write') {
      return true;
    }
  }
  const [ns] = requiredScope.split('.');
  if (scopes.includes(ns) || scopes.includes(`${ns}.*`)) return true;
  return false;
}

function getJsonByteLength(val) {
  if (val === undefined) return 0;
  try {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    return new TextEncoder().encode(str).length;
  } catch {
    return Infinity;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 有界 JSON 预算：先按每 string 长度、节点数、累计 UTF-8 字节快速拒绝，
 * 避免先 JSON.stringify 一个巨型字符串再检查。调用方最后仍需做一次精确 UTF-8 核对。
 */
function measureBoundedJson(value, limits) {
  const { maxBytes, maxStringBytes, maxNodes, maxDepth } = limits;
  const encoder = new TextEncoder();
  const seen = new WeakSet();
  let bytes = 0;
  let nodes = 0;

  function addString(str) {
    if (typeof str !== 'string') throw new Error('not a string');
    if (str.length > maxStringBytes) throw new Error('string_too_large');
    bytes += encoder.encode(str).length + 2;
    if (bytes > maxBytes) throw new Error('bytes_too_large');
  }

  function walk(node, depth) {
    nodes += 1;
    if (nodes > maxNodes) throw new Error('too_many_nodes');
    if (depth > maxDepth) throw new Error('too_deep');

    if (node === null) {
      bytes += 4;
      return;
    }
    const type = typeof node;
    if (type === 'string') {
      addString(node);
      return;
    }
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new Error('non_finite_number');
      bytes += String(node).length;
      return;
    }
    if (type === 'boolean') {
      bytes += node ? 4 : 5;
      return;
    }
    if (type !== 'object') {
      // undefined / function / symbol / bigint 都不可 JSON 序列化
      throw new Error('unserializable');
    }
    if (seen.has(node)) throw new Error('circular');
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        bytes += 2;
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (!isPlainObject(node)) throw new Error('non_plain_object');
      bytes += 2;
      for (const key of Object.keys(node)) {
        addString(key);
        walk(node[key], depth + 1);
      }
    } finally {
      seen.delete(node);
    }
  }

  walk(value, 0);
  if (bytes > maxBytes) throw new Error('bytes_too_large');
  return bytes;
}

function validateInvokeInput(input) {
  if (!isPlainObject(input)) {
    const err = new Error('tool.invoke input must be a plain object');
    err.code = 'CARD_INVOKE_INPUT_INVALID';
    throw err;
  }
  try {
    measureBoundedJson(input, {
      maxBytes: MAX_INVOKE_INPUT_BYTES,
      maxStringBytes: MAX_INVOKE_STRING_BYTES,
      maxNodes: MAX_INVOKE_INPUT_NODES,
      maxDepth: MAX_INVOKE_DEPTH,
    });
  } catch (cause) {
    const err = new Error(`tool.invoke input rejected: ${cause.message}`);
    err.code = cause.message === 'circular' || cause.message === 'unserializable'
      ? 'CARD_INVOKE_INPUT_INVALID'
      : 'CARD_INVOKE_INPUT_TOO_LARGE';
    throw err;
  }
  const exact = getJsonByteLength(input);
  if (!Number.isFinite(exact) || exact > MAX_INVOKE_INPUT_BYTES) {
    const err = new Error(`tool.invoke input exceeds ${MAX_INVOKE_INPUT_BYTES} bytes`);
    err.code = 'CARD_INVOKE_INPUT_TOO_LARGE';
    throw err;
  }
  // 确认与 API 使用同一份快照，避免后续引用变化
  return JSON.parse(JSON.stringify(input));
}

function clampRequestTimeout(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (n < MIN_REQUEST_TIMEOUT_MS) return MIN_REQUEST_TIMEOUT_MS;
  if (n > MAX_REQUEST_TIMEOUT_MS) return MAX_REQUEST_TIMEOUT_MS;
  return Math.floor(n);
}

function sessionPathsEqual(a, b) {
  if (!a && !b) return true;
  return Boolean(a) && Boolean(b) && String(a) === String(b);
}

function nonceEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeCapability(raw) {
  switch (raw) {
    case 'host.capabilities':
    case 'capabilities':
      return 'capabilities';
    case 'state.get':
    case 'state:get':
      return 'state:get';
    case 'state.set':
    case 'state:set':
      return 'state:set';
    case 'tool.invoke':
    case 'tools:invoke':
    case 'tools.invoke':
      return 'tools:invoke';
    case 'emit':
    case 'events:emit':
    case 'events.emit':
      return 'events:emit';
    case 'track':
    case 'events:track':
    case 'events.track':
      return 'events:track';
    case 'data.get':
    case 'data:get':
      return 'data:get';
    default:
      return raw;
  }
}

/**
 * 创建卡片通信宿主桥
 * @param {object} [options]
 * @param {Function} [options.api] HTTP 请求客户端
 * @param {Window} [options.window] 监听 message 的 Window 实例
 * @param {Function} [options.confirmAction] 动作确认弹窗回调 async ({ title, message, details }) => boolean
 * @param {Function} [options.getActiveContext] 获取当前活跃前台会话 () => ({ sessionId, sessionPath?, isVisible })
 * @param {Function} [options.getPrincipal] 获取当前登录主体 () => ({ scopes: string[] })
 */
export function createCardBridge({
  api,
  window: win = globalThis.window,
  confirmAction,
  getActiveContext,
  getPrincipal,
  crypto: cryptoImpl = globalThis.crypto,
  now = () => Date.now()
} = {}) {
  // Map<iframe, { iframe, context, cache: Map, pending: Set, actionLock: boolean, pendingInvoke: object|null }>
  const registeredFrames = new Map();
  const handledConfirmIds = new Set();

  function isContextActive(context) {
    if (!getActiveContext || typeof getActiveContext !== 'function') return false;
    try {
      const active = getActiveContext();
      if (!active || active.isVisible !== true) return false;
      if (!active.sessionId || !context.sessionId || active.sessionId !== context.sessionId) {
        return false;
      }
      if (active.sessionPath && context.sessionPath && active.sessionPath !== context.sessionPath) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function getScopes() {
    try {
      const p = getPrincipal ? getPrincipal() : null;
      return Array.isArray(p?.scopes) ? p.scopes : [];
    } catch {
      return [];
    }
  }

  function evictCache(record) {
    while (record.cache.size >= MAX_CACHE_PER_FRAME) {
      const oldestKey = record.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const old = record.cache.get(oldestKey);
      record.cache.delete(oldestKey);
      record.cacheBytes -= old?.bytes || 0;
    }
    while (record.cacheBytes > MAX_CACHE_TOTAL_BYTES && record.cache.size > 0) {
      const oldestKey = record.cache.keys().next().value;
      const old = record.cache.get(oldestKey);
      record.cache.delete(oldestKey);
      record.cacheBytes -= old?.bytes || 0;
    }
  }

  function replyToFrame(record, _source, reqId, ok, dataOrError) {
    if (!record || !record.active || !record.port || !reqId) return;

    let msg = {
      type: 'card:response',
      requestId: reqId,
      ok: Boolean(ok)
    };
    if (ok) {
      msg.result = (dataOrError && typeof dataOrError === 'object') ? dataOrError : {};
    } else {
      msg.code = dataOrError?.code || 'CARD_HOST_ERROR';
      msg.error = dataOrError?.error || dataOrError?.message || 'Operation failed';
      msg.result = {};
    }

    let bytes = getJsonByteLength(msg);
    if (!Number.isFinite(bytes) || bytes > MAX_CACHE_RESPONSE_BYTES) {
      // 超大响应不进入缓存，也不把私密大对象交给卡片
      msg = {
        type: 'card:response',
        requestId: reqId,
        ok: false,
        code: 'CARD_RESPONSE_TOO_LARGE',
        error: `Card host response exceeds ${MAX_CACHE_RESPONSE_BYTES} bytes`,
        result: {}
      };
      bytes = getJsonByteLength(msg);
    } else {
      const existing = record.cache.get(reqId);
      if (existing) {
        record.cache.delete(reqId);
        record.cacheBytes -= existing.bytes || 0;
      }
      evictCache(record);
      record.cache.set(reqId, { msg, bytes });
      record.cacheBytes += bytes;
      evictCache(record);
    }

    try {
      record.port.postMessage(msg);
    } catch (err) {
      console.error('[card-bridge] port postMessage failed:', err);
    }
  }

  function findRegisteredRecord(source) {
    for (const [iframe, record] of registeredFrames.entries()) {
      if (iframe && iframe.contentWindow === source) {
        if (iframe.isConnected === false || !record.active) return null;
        return record;
      }
    }
    return null;
  }

  function isRequestLive(record, reqId, deadline) {
    return Boolean(
      record &&
      record.active &&
      record.port &&
      record.iframe?.isConnected !== false &&
      !record.cancelled.has(reqId) &&
      now() <= deadline
    );
  }

  function ensureLive(record, reqId, deadline, { started = false } = {}) {
    if (isRequestLive(record, reqId, deadline)) return true;
    replyToFrame(record, null, reqId, false, {
      code: started ? 'CARD_RESULT_UNKNOWN' : 'CARD_TIMEOUT',
      error: started
        ? '操作已开始，结果未知；请检查后勿重试'
        : 'Card request deadline expired or was cancelled'
    });
    return false;
  }

  async function handlePortRequest(record, req) {
    let reqId = null;
    let deadline = 0;
    const event = { source: null };
    try {
      if (!record || !record.active || !record.port) return;
      const { context } = record;
      if (!req || typeof req !== 'object') return;
      if (req.type !== 'card:request') return;

      if (typeof req.requestId !== 'string' || !req.requestId || req.requestId.length > MAX_REQUEST_ID_LEN) {
        return;
      }
      reqId = req.requestId;

      // 检查独立缓存
      if (record.cache.has(reqId)) {
        const cached = record.cache.get(reqId);
        try { record.port.postMessage(cached.msg); } catch (err) {
          console.error('[card-bridge] cache replay failed:', err);
        }
        return;
      }

      // 检查独立 pending
      if (record.pending.has(reqId)) {
        return;
      }
      if (record.pending.size >= MAX_PENDING_PER_FRAME) {
        replyToFrame(record, event.source, reqId, false, {
          code: 'CARD_PENDING_OVERFLOW',
          error: 'Frame pending requests limit exceeded'
        });
        return;
      }

      record.pending.add(reqId);

      const rawCap = typeof req.capability === 'string' ? req.capability : '';
      const capability = normalizeCapability(rawCap);
      const payload = req.payload !== undefined ? req.payload : {};
      const isAction = capability === 'tools:invoke' || capability === 'events:emit';
      const timeoutMs = clampRequestTimeout(req.timeoutMs, isAction ? MAX_REQUEST_TIMEOUT_MS : 15000);
      deadline = now() + timeoutMs;

      const scopes = getScopes();

      switch (capability) {
        case 'capabilities': {
          const validEntity = typeof context.cardEntityId === 'string' && CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId);
          const hasRead = hasScope(scopes, 'sessions.read');
          const hasWrite = hasScope(scopes, 'sessions.write');
          const hasRun = hasScope(scopes, 'tools.run');
          const hasStudio = hasScope(scopes, 'studio.owner');

          const stateAvail = Boolean(validEntity && context.sessionId && hasRead && hasWrite);
          const emitAvail = Boolean(validEntity && context.cardId && context.sessionId && context.sourceVersion && hasWrite);
          const invokeAvail = Boolean(validEntity && context.sessionId && hasRun);
          const trackAvail = Boolean(validEntity && context.sessionId && hasStudio);
          const dataAvail = Boolean(validEntity && hasStudio);

          const result = {
            environment: 'host',
            capabilities: {
              state: stateAvail ? 'available' : 'requires_host',
              emit: emitAvail ? 'available' : 'requires_host',
              invoke: invokeAvail ? 'available' : 'requires_host',
              track: { status: trackAvail ? 'available' : 'requires_host' },
              data: { status: dataAvail ? 'available' : 'requires_host' },
              'data.get': { status: dataAvail ? 'available' : 'requires_host' },
              'net.request-access': 'unsupported'
            }
          };
          replyToFrame(record, event.source, reqId, true, result);
          break;
        }

        case 'state:get': {
          if (!hasScope(scopes, 'sessions.read')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing sessions.read permission'
            });
            break;
          }
          if (!context.cardEntityId || !context.sessionId || !CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_IDENTITY_MISSING',
              error: 'Card identity is missing or invalid'
            });
            break;
          }
          if (!isContextActive(context)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_CONTEXT_INACTIVE',
              error: 'Session is not active or card is not visible'
            });
            break;
          }
          if (!ensureLive(record, reqId, deadline)) break;

          const reqBody = {
            cardEntityId: context.cardEntityId,
            sessionId: context.sessionId
          };
          if (context.sessionPath) reqBody.sessionPath = context.sessionPath;

          try {
            const res = await api('/api/card-host/state/get', {
              method: 'POST',
              body: JSON.stringify(reqBody)
            });
            if (!ensureLive(record, reqId, deadline)) break;
            if (!isContextActive(context)) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_CONTEXT_INACTIVE',
                error: 'Session is not active or card is not visible'
              });
              break;
            }
            if (!res || res.ok !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: res?.code || 'CARD_HOST_STATE_FAILED',
                error: res?.error || res?.message || 'Failed to get card state'
              });
            } else {
              const state = res.result?.state ?? res.state ?? {};
              const seeded = Boolean(res.result?.seeded ?? res.seeded);
              replyToFrame(record, event.source, reqId, true, { state, seeded });
            }
          } catch (err) {
            replyToFrame(record, event.source, reqId, false, {
              code: err.body?.code || 'CARD_HOST_STATE_ERROR',
              error: err.message || 'State request failed'
            });
          }
          break;
        }

        case 'state:set': {
          if (!hasScope(scopes, 'sessions.write')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing sessions.write permission'
            });
            break;
          }
          if (!context.cardEntityId || !context.sessionId || !CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_IDENTITY_MISSING',
              error: 'Card identity is missing or invalid'
            });
            break;
          }
          if (!isContextActive(context)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_CONTEXT_INACTIVE',
              error: 'Session is not active or card is not visible'
            });
            break;
          }
          if (getJsonByteLength(payload) > MAX_STATE_BYTES) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_PAYLOAD_TOO_LARGE',
              error: `state.set payload exceeds limit of ${MAX_STATE_BYTES} bytes`
            });
            break;
          }

          const reqBody = {
            cardEntityId: context.cardEntityId,
            sessionId: context.sessionId
          };
          if (context.sessionPath) reqBody.sessionPath = context.sessionPath;

          if (payload.state && typeof payload.state === 'object') {
            reqBody.state = payload.state;
          } else if (typeof payload.key === 'string' && payload.key) {
            reqBody.key = payload.key;
            if (payload.delete === true) reqBody.delete = true;
            else reqBody.value = payload.value;
          } else {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_STATE_KEY_REQUIRED',
              error: 'state.set requires either state or key'
            });
            break;
          }

          try {
            if (!ensureLive(record, reqId, deadline)) break;
            const res = await api('/api/card-host/state/set', {
              method: 'POST',
              body: JSON.stringify(reqBody)
            });
            if (!ensureLive(record, reqId, deadline, { started: true })) break;
            if (!isContextActive(context)) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_CONTEXT_INACTIVE',
                error: 'Session is not active or card is not visible'
              });
              break;
            }
            if (!res || res.ok !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: res?.code || 'CARD_HOST_STATE_FAILED',
                error: res?.error || res?.message || 'Failed to persist state'
              });
            } else {
              const state = res.result?.state ?? res.state ?? {};
              replyToFrame(record, event.source, reqId, true, { state });
            }
          } catch (err) {
            replyToFrame(record, event.source, reqId, false, {
              code: err.body?.code || 'CARD_HOST_STATE_ERROR',
              error: err.message || 'State persist failed'
            });
          }
          break;
        }

        case 'tools:invoke': {
          if (!hasScope(scopes, 'tools.run')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing tools.run permission'
            });
            break;
          }
          if (typeof payload.bindingId !== 'string' || !payload.bindingId.trim()) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_TOOL_BINDING_ID_REQUIRED',
              error: 'Card invocation requires bindingId'
            });
            break;
          }
          if (payload.bindingId.length > MAX_BINDING_ID_LEN) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_TOOL_BINDING_ID_INVALID',
              error: `bindingId exceeds ${MAX_BINDING_ID_LEN} chars`
            });
            break;
          }
          let invokeInput;
          try {
            invokeInput = validateInvokeInput(payload.input !== undefined ? payload.input : {});
          } catch (inputErr) {
            replyToFrame(record, event.source, reqId, false, {
              code: inputErr.code || 'CARD_INVOKE_INPUT_INVALID',
              error: inputErr.message
            });
            break;
          }
          if (!context.cardEntityId || !context.sessionId || !CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_IDENTITY_MISSING',
              error: 'Card identity is missing or invalid'
            });
            break;
          }

          if (!isContextActive(context)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_CONTEXT_INACTIVE',
              error: 'Session is not active or card is not visible'
            });
            break;
          }
          if (!ensureLive(record, reqId, deadline)) break;

          // 单副作用互斥锁
          if (record.actionLock) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_ACTION_BUSY',
              error: 'Another card action is currently pending confirmation or execution'
            });
            break;
          }

          record.actionLock = true;
          try {
            if (!confirmAction || typeof confirmAction !== 'function') {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_HOST_CONFIRMATION_REQUIRED',
                error: 'Action confirmation handler is unavailable'
              });
              break;
            }

            let allowed = false;
            try {
              allowed = await confirmAction({
                title: '操作确认',
                message: `卡片申请调用工具: ${payload.bindingId}`,
                details: invokeInput
              });
            } catch (confirmErr) {
              allowed = false;
            }

            if (allowed !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_HOST_INVOKE_DENIED',
                error: 'Action denied by user'
              });
              break;
            }

            // 二次核验生命周期
            if (!ensureLive(record, reqId, deadline)) break;
            if (
              registeredFrames.get(record.iframe) !== record ||
              record.iframe.isConnected === false ||
              !isContextActive(context)
            ) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_CONTEXT_INVALIDATED',
                error: 'Context became inactive or card was detached during confirmation'
              });
              break;
            }

            const invokeBody = {
              bindingId: payload.bindingId,
              input: invokeInput,
              cardEntityId: context.cardEntityId,
              executionSessionId: context.sessionId,
              confirmationSessionId: context.sessionId
            };
            if (context.cardInstanceId) {
              invokeBody.cardInstanceId = context.cardInstanceId;
            }

            // 记录 pendingInvoke 状态以备宿主第二道确认匹配
            record.pendingInvoke = {
              bindingId: payload.bindingId,
              input: invokeInput,
              requestId: reqId
            };

            try {
              if (!ensureLive(record, reqId, deadline)) break;
              const res = await api('/api/card-host/tools/invoke', {
                method: 'POST',
                body: JSON.stringify(invokeBody)
              });
              if (!ensureLive(record, reqId, deadline, { started: true })) break;
              if (!res || res.ok !== true) {
                replyToFrame(record, event.source, reqId, false, {
                  code: res?.code || 'CARD_HOST_INVOKE_FAILED',
                  error: res?.error || res?.message || 'Tool invocation failed'
                });
              } else {
                replyToFrame(record, event.source, reqId, true, res.result ?? res);
              }
            } catch (err) {
              replyToFrame(record, event.source, reqId, false, {
                code: err.body?.code || 'CARD_HOST_INVOKE_ERROR',
                error: `Tool invocation error: ${err.message}. Do not retry blindly.`
              });
            }
          } finally {
            record.actionLock = false;
            record.pendingInvoke = null;
          }
          break;
        }

        case 'events:emit': {
          if (!hasScope(scopes, 'sessions.write')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing sessions.write permission'
            });
            break;
          }
          if (typeof payload.name !== 'string' || !NAME_REGEX.test(payload.name)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_EMIT_INPUT_INVALID',
              error: 'Event name must match ^[a-z0-9][a-z0-9._-]{0,63}$'
            });
            break;
          }
          if (getJsonByteLength(payload.payload) > MAX_EMIT_BYTES) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_PAYLOAD_TOO_LARGE',
              error: `emit payload exceeds limit of ${MAX_EMIT_BYTES} bytes`
            });
            break;
          }
          if (payload.to !== undefined && payload.to !== null && payload.to !== context.sessionId) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_EMIT_ROUTE_FORBIDDEN',
              error: 'Specifying arbitrary to session destination is forbidden'
            });
            break;
          }
          if (!context.cardId || !context.sessionId || !context.sourceVersion) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_SOURCE_INVALID',
              error: 'cardId, sessionId and sourceVersion are required for emit'
            });
            break;
          }

          if (!isContextActive(context)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_CONTEXT_INACTIVE',
              error: 'Session is not active or card is not visible'
            });
            break;
          }
          if (!ensureLive(record, reqId, deadline)) break;

          // 单副作用互斥锁
          if (record.actionLock) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_ACTION_BUSY',
              error: 'Another card action is currently pending confirmation or execution'
            });
            break;
          }

          record.actionLock = true;
          try {
            if (!confirmAction || typeof confirmAction !== 'function') {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_HOST_CONFIRMATION_REQUIRED',
                error: 'Action confirmation handler is unavailable'
              });
              break;
            }

            let allowed = false;
            try {
              allowed = await confirmAction({
                title: '卡片消息发送确认',
                message: `卡片申请向会话发送事件: ${payload.name}`,
                details: payload.payload
              });
            } catch (confirmErr) {
              allowed = false;
            }

            if (allowed !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_HOST_EMIT_DENIED',
                error: 'Emit denied by user'
              });
              break;
            }

            // 二次核验生命周期
            if (!ensureLive(record, reqId, deadline)) break;
            if (
              registeredFrames.get(record.iframe) !== record ||
              record.iframe.isConnected === false ||
              !isContextActive(context)
            ) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_CONTEXT_INVALIDATED',
                error: 'Context became inactive or card was detached during confirmation'
              });
              break;
            }

            const prepareBody = {
              cardId: context.cardId,
              sessionId: context.sessionId,
              sourceVersion: context.sourceVersion,
              name: payload.name,
              payload: payload.payload !== undefined ? payload.payload : {}
            };

            let prepRes;
            try {
              if (!ensureLive(record, reqId, deadline)) break;
              prepRes = await api('/api/card-host/events/prepare', {
                method: 'POST',
                body: JSON.stringify(prepareBody)
              });
              if (!ensureLive(record, reqId, deadline)) break;
            } catch (err) {
              replyToFrame(record, event.source, reqId, false, {
                code: err.body?.code || 'CARD_HOST_PREPARE_ERROR',
                error: err.message || 'Prepare event submission failed'
              });
              break;
            }

            if (!prepRes || prepRes.ok !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: prepRes?.code || 'CARD_HOST_PREPARE_FAILED',
                error: prepRes?.error || prepRes?.message || 'Failed to prepare event ticket'
              });
              break;
            }

            const ticket = prepRes.result?.submitTicket ?? prepRes.submitTicket;
            if (!ticket) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_HOST_TICKET_MISSING',
                error: 'No ticket returned from event prepare'
              });
              break;
            }

            if (
              registeredFrames.get(record.iframe) !== record ||
              record.iframe.isConnected === false ||
              !isContextActive(context)
            ) {
              replyToFrame(record, event.source, reqId, false, {
                code: 'CARD_CONTEXT_INVALIDATED',
                error: 'Context became inactive or card was detached before ticket consumption'
              });
              break;
            }

            try {
              if (!ensureLive(record, reqId, deadline)) break;
              const emitRes = await api('/api/card-host/events/emit', {
                method: 'POST',
                body: JSON.stringify({ submitTicket: ticket })
              });
              if (!ensureLive(record, reqId, deadline, { started: true })) break;
              if (!emitRes || emitRes.ok !== true) {
                replyToFrame(record, event.source, reqId, false, {
                  code: emitRes?.code || 'CARD_HOST_EMIT_FAILED',
                  error: emitRes?.error || emitRes?.message || 'Failed to emit event'
                });
              } else {
                replyToFrame(record, event.source, reqId, true, emitRes.result ?? emitRes);
              }
            } catch (err) {
              replyToFrame(record, event.source, reqId, false, {
                code: err.body?.code || 'CARD_HOST_EMIT_ERROR',
                error: err.message || 'Emit event failed'
              });
            }
          } finally {
            record.actionLock = false;
          }
          break;
        }

        case 'events:track': {
          if (!hasScope(scopes, 'studio.owner')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing studio.owner permission'
            });
            break;
          }
          if (typeof payload.name !== 'string' || !NAME_REGEX.test(payload.name)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_TRACK_INPUT_INVALID',
              error: 'Track event name must match ^[a-z0-9][a-z0-9._-]{0,63}$'
            });
            break;
          }
          if (getJsonByteLength(payload.payload) > MAX_EMIT_BYTES) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_PAYLOAD_TOO_LARGE',
              error: `track payload exceeds limit of ${MAX_EMIT_BYTES} bytes`
            });
            break;
          }
          if (!context.cardEntityId || !context.sessionId || !CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_IDENTITY_MISSING',
              error: 'Card identity is missing or invalid'
            });
            break;
          }

          const trackBody = {
            cardEntityId: context.cardEntityId,
            executionSessionId: context.sessionId,
            name: payload.name,
            payload: payload.payload !== undefined ? payload.payload : {}
          };

          try {
            if (!ensureLive(record, reqId, deadline)) break;
            const res = await api('/api/card-host/events/track', {
              method: 'POST',
              body: JSON.stringify(trackBody)
            });
            if (!ensureLive(record, reqId, deadline, { started: true })) break;
            if (!res || res.ok !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: res?.code || 'CARD_HOST_TRACK_FAILED',
                error: res?.error || res?.message || 'Track logging failed'
              });
            } else {
              replyToFrame(record, event.source, reqId, true, res.result ?? res);
            }
          } catch (err) {
            replyToFrame(record, event.source, reqId, false, {
              code: err.body?.code || 'CARD_HOST_TRACK_ERROR',
              error: err.message || 'Track request failed'
            });
          }
          break;
        }

        case 'data:get': {
          if (!hasScope(scopes, 'studio.owner')) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_FORBIDDEN',
              error: 'Missing studio.owner permission'
            });
            break;
          }
          if (!context.cardEntityId || !CHAT_CARD_ENTITY_REGEX.test(context.cardEntityId)) {
            replyToFrame(record, event.source, reqId, false, {
              code: 'CARD_HOST_IDENTITY_MISSING',
              error: 'Card identity is missing or invalid'
            });
            break;
          }
          try {
            if (!ensureLive(record, reqId, deadline)) break;
            const res = await api('/api/card-host/data/read', {
              method: 'POST',
              body: JSON.stringify({ cardEntityId: context.cardEntityId })
            });
            if (!ensureLive(record, reqId, deadline, { started: true })) break;
            if (!res || res.ok !== true) {
              replyToFrame(record, event.source, reqId, false, {
                code: res?.code || 'CARD_HOST_DATA_FAILED',
                error: res?.error || res?.message || 'Failed to read host data'
              });
            } else {
              replyToFrame(record, event.source, reqId, true, {
                data: res.result?.data ?? res.data ?? null
              });
            }
          } catch (err) {
            replyToFrame(record, event.source, reqId, false, {
              code: err.body?.code || 'CARD_HOST_DATA_ERROR',
              error: err.message || 'Host data request failed'
            });
          }
          break;
        }

        case 'net:request-access': {
          replyToFrame(record, event.source, reqId, false, {
            code: 'CARD_NETWORK_UNSUPPORTED',
            error: 'Arbitrary network access from cards is not supported'
          });
          break;
        }

        default: {
          replyToFrame(record, event.source, reqId, false, {
            code: 'CARD_CAPABILITY_UNKNOWN',
            error: `Unknown capability: ${capability}`
          });
          break;
        }
      }
    } catch (globalErr) {
      if (record && reqId) {
        replyToFrame(record, event.source, reqId, false, {
          code: 'CARD_BRIDGE_INTERNAL_ERROR',
          error: String(globalErr?.message || globalErr)
        });
      }
    } finally {
      if (record && reqId) {
        record.pending.delete(reqId);
        record.cancelled.delete(reqId);
      }
    }
  }

  function makeNonce() {
    if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
      throw new Error('CARD_SECURE_RANDOM_UNAVAILABLE: crypto.getRandomValues is required');
    }
    const bytes = new Uint8Array(32);
    cryptoImpl.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function closeRecordPort(record) {
    if (!record) return;
    record.active = false;
    record.connected = false;
    record.revoked = true;
    try { record.port?.close?.(); } catch { /* ignore */ }
    record.port = null;
    try {
      if (record.loadHandler && record.iframe?.removeEventListener) {
        record.iframe.removeEventListener('load', record.loadHandler);
      }
    } catch { /* ignore */ }
    if (registeredFrames.get(record.iframe) === record) {
      registeredFrames.delete(record.iframe);
    }
  }

  function revokeRecord(record, reason) {
    if (!record || !record.active) return;
    record.revokedReason = reason || 'revoked';
    closeRecordPort(record);
  }

  function handleWindowMessage(event) {
    const data = event?.data;
    if (!data || typeof data !== 'object' || data.type !== 'card:connect') return;
    if (typeof data.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(data.nonce)) return;
    const record = findRegisteredRecord(event.source);
    if (!record || !record.active || record.connected) return;
    if (!nonceEquals(record.nonce, data.nonce)) return;
    const port = event.ports && event.ports[0];
    if (!port || typeof port.postMessage !== 'function') return;

    // 每次注册只绑定一个文档端口，后续请求不再走 window 广播
    record.port = port;
    record.connected = true;
    port.onmessage = (portEvent) => handlePortMessage(record, portEvent);
    port.onmessageerror = () => revokeRecord(record, 'port_error');
    try { port.start?.(); } catch { /* some MessagePort implementations auto-start */ }
  }

  function handlePortMessage(record, event) {
    if (!record || !record.active || !record.port) return;
    if (record.iframe && record.iframe.isConnected === false) {
      revokeRecord(record, 'iframe_detached');
      return;
    }
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'card:request') {
      void handlePortRequest(record, data);
      return;
    }
    if (data.type === 'card:cancel') {
      if (typeof data.requestId === 'string' && data.requestId.length <= MAX_REQUEST_ID_LEN) {
        // 只标记当前确实在处理的请求；未知 requestId 不进入无界集合
        if (record.pending.has(data.requestId)) record.cancelled.add(data.requestId);
      }
      return;
    }
    if (data.type === 'card:disconnect') {
      revokeRecord(record, 'sdk_disconnect');
    }
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('message', handleWindowMessage);
  }

  function register(iframe, trustedContext = {}) {
    if (!iframe) return null;
    const old = registeredFrames.get(iframe);
    if (old) revokeRecord(old, 'reregister');

    const frozen = Object.freeze({
      cardEntityId: typeof trustedContext.cardEntityId === 'string' ? trustedContext.cardEntityId : null,
      cardId: typeof trustedContext.cardId === 'string' ? trustedContext.cardId : null,
      cardInstanceId: typeof trustedContext.cardInstanceId === 'string' ? trustedContext.cardInstanceId : null,
      sourceVersion: typeof trustedContext.sourceVersion === 'string' ? trustedContext.sourceVersion : null,
      sessionId: typeof trustedContext.sessionId === 'string' ? trustedContext.sessionId : null,
      sessionPath: typeof trustedContext.sessionPath === 'string' ? trustedContext.sessionPath : null,
      title: typeof trustedContext.title === 'string' ? trustedContext.title : '卡片'
    });
    const nonce = makeNonce();
    const record = {
      iframe,
      context: frozen,
      nonce,
      port: null,
      connected: false,
      active: true,
      revoked: false,
      initialLoadSeen: false,
      cache: new Map(),
      cacheBytes: 0,
      pending: new Set(),
      cancelled: new Set(),
      actionLock: false,
      pendingInvoke: null
    };
    record.loadHandler = () => {
      if (!record.active) return;
      if (!record.initialLoadSeen) {
        record.initialLoadSeen = true;
        return;
      }
      // 同一 WindowProxy 的第二份文档：旧 nonce/端口立即失效
      revokeRecord(record, 'iframe_reload');
    };
    iframe.addEventListener?.('load', record.loadHandler);
    registeredFrames.set(iframe, record);
    return { nonce };
  }

  function unregister(iframe) {
    const record = registeredFrames.get(iframe);
    if (record) revokeRecord(record, 'unregister');
  }

  function clear() {
    for (const record of Array.from(registeredFrames.values())) {
      revokeRecord(record, 'clear');
    }
    // handledConfirmIds 不随 clear 清空，避免已处理的宿主确认被重新打开
    while (handledConfirmIds.size > MAX_HANDLED_CONFIRM_IDS) {
      const oldest = handledConfirmIds.values().next().value;
      handledConfirmIds.delete(oldest);
    }
  }

  async function handleHostConfirmation(ev) {
    if (!ev || typeof ev !== 'object') return;
    let block = ev.block;
    if (!block && ev.type === 'card_host_confirmation') {
      block = ev;
    }
    if (!block || (block.type !== 'card_host_confirm' && ev.type !== 'card_host_confirmation')) {
      return;
    }

    const confirmId = block.confirmId;
    const cardEntityId = block.cardEntityId;
    const sessionId = ev.sessionId || block.sessionId;
    const sessionPath = ev.sessionPath || block.sessionPath;

    if (!confirmId || !cardEntityId || !sessionId) return;
    if (handledConfirmIds.has(confirmId)) return;

    // 匹配当前正处于 invoke 等待中的活跃卡片
    let matchedRecord = null;
    for (const [iframe, record] of registeredFrames.entries()) {
      if (
        record.active &&
        record.actionLock &&
        record.pendingInvoke &&
        record.context.cardEntityId === cardEntityId &&
        record.context.sessionId === sessionId &&
        iframe.isConnected !== false &&
        isContextActive(record.context)
      ) {
        if (sessionPath && record.context.sessionPath && record.context.sessionPath !== sessionPath) {
          continue;
        }
        matchedRecord = record;
        break;
      }
    }

    if (!matchedRecord) {
      return;
    }

    // 记录进入确认时的 invoke 身份；恢复后必须是同一个对象，不能被新 invoke 顶替
    const pendingInvokeAtConfirm = matchedRecord.pendingInvoke;
    handledConfirmIds.add(confirmId);
    while (handledConfirmIds.size > MAX_HANDLED_CONFIRM_IDS) {
      const oldest = handledConfirmIds.values().next().value;
      handledConfirmIds.delete(oldest);
    }

    const postConfirm = async (allow) => {
      const action = allow ? 'confirmed' : 'rejected';
      const res = await api(`/api/confirm/${encodeURIComponent(confirmId)}`, {
        method: 'POST',
        body: JSON.stringify({ action })
      });
      if (!res || res.ok !== true) {
        const err = new Error(res?.error || res?.message || 'Host confirmation response was not ok');
        err.code = res?.code || 'CARD_HOST_CONFIRM_FAILED';
        err.status = res?.status;
        throw err;
      }
      return res;
    };

    if (!confirmAction || typeof confirmAction !== 'function') {
      await postConfirm(false);
      return;
    }

    const title = `宿主工具权限确认: ${block.toolName || block.subject || block.grantKind || '操作'}`;
    let msg = `卡片申请获得宿主权限: ${block.grantKind || 'tool'}`;
    if (block.subject) msg += ` (${block.subject})`;
    if (block.cardTitle) msg = `【${block.cardTitle}】` + msg;

    let details = block.params || {};
    if (block.combinationWarning) {
      details = {
        warning: block.combinationWarning,
        toolName: block.toolName,
        params: block.params
      };
    }

    let userAllowed = false;
    try {
      userAllowed = await confirmAction({
        title,
        message: msg,
        details
      });
    } catch {
      userAllowed = false;
    }

    // 再次校验生命周期：必须是同一个 pendingInvoke，且会话路径仍匹配
    const stillValid = (
      registeredFrames.get(matchedRecord.iframe) === matchedRecord &&
      matchedRecord.active &&
      matchedRecord.iframe.isConnected !== false &&
      matchedRecord.pendingInvoke === pendingInvokeAtConfirm &&
      Boolean(sessionPath) &&
      Boolean(matchedRecord.context.sessionPath) &&
      sessionPathsEqual(sessionPath, matchedRecord.context.sessionPath) &&
      isContextActive(matchedRecord.context)
    );

    if (!stillValid || userAllowed !== true) {
      await postConfirm(false);
    } else {
      await postConfirm(true);
    }
  }

  function handleHostDataChanged(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (ev.type !== 'app_event') return false;

    const eventObj = ev.event;
    if (!eventObj || typeof eventObj !== 'object') return false;
    if (eventObj.type !== 'card-data-changed' || eventObj.source !== 'server') return false;

    const payload = eventObj.payload;
    if (!payload || typeof payload !== 'object') return false;

    const cardEntityId = payload.cardEntityId;
    if (typeof cardEntityId !== 'string' || !cardEntityId || cardEntityId.length > MAX_REQUEST_ID_LEN) {
      return false;
    }
    if (!CHAT_CARD_ENTITY_REGEX.test(cardEntityId)) {
      return false;
    }

    const scopes = getScopes();
    const hasStudio = hasScope(scopes, 'studio.owner');
    if (!hasStudio) {
      return false;
    }

    const dataBytes = getJsonByteLength(payload.data);
    if (dataBytes > MAX_DATA_BYTES) {
      return false;
    }

    let dispatched = false;
    for (const [iframe, record] of registeredFrames.entries()) {
      if (
        iframe.isConnected !== false &&
        record.active &&
        record.port &&
        record.context.cardEntityId === cardEntityId
      ) {
        try {
          record.port.postMessage({
            type: 'hana.card-data-changed',
            data: payload.data
          });
          dispatched = true;
        } catch (err) {
          console.error('[card-bridge] Failed to dispatch card-data-changed to card port:', err);
        }
      }
    }
    return dispatched;
  }

  function dispose() {
    clear();
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('message', handleWindowMessage);
    }
  }

  return {
    register,
    unregister,
    clear,
    handleHostConfirmation,
    handleHostDataChanged,
    dispose
  };
}
