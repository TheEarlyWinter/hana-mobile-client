/* shared/card-runtime.mjs — 卡片宿主双向通信端（卡片 iframe 内纯 runtime 脚本）
 *
 * 规范与约束：
 * 1. 纯浏览器端脚本导出，供 srcdoc 与 gateway HTML 统一注入共用；
 * 2. window.card 与 window.hana 挂载同对象规范 API 及 card.request；
 * 3. 遵照 Canonical Capability: host.capabilities, state.get, state.set, tool.invoke, emit, track, data.get；
 * 4. 所有方法 Promise 永不 reject，统一包装为 { ok: true, result } 或 { ok: false, code, error, result: {} }；
 * 5. state.get(key) 提取 result.value，并保留完整 result.state；
 * 6. 通信安全：启动时从受控 head meta 或 URL fragment 读取一次性 nonce，
 *    建立 MessageChannel 并把 port2 只交给 parent；请求/响应/数据变更只走该文档端口；
 * 7. 响应格式兼容：支持 card:response 与 hana.card-host-response 平铺响应；
 * 8. 超时分流：动作类 5 分钟并提示勿重复提交，状态类 15 秒；超时通过 port 发送 cancel；
 * 9. 若外部环境已有完整可用 SDK，坚决不覆盖；无 MessageChannel/nonce 时 fail closed。
 */

export const CARD_RUNTIME_SCRIPT = `
(function () {
  if (typeof window === 'undefined') return;
  if (window.__HANA_CARD_RUNTIME_INSTALLED__) return;

  // 保护已有可用 SDK
  if (window.card && typeof window.card.invoke === 'function' && window.card.state && typeof window.card.state.get === 'function') {
    return;
  }

  window.__HANA_CARD_RUNTIME_INSTALLED__ = true;

  var MAX_PENDING = 100;
  var pending = new Map();
  var dataChangeListeners = new Set();
  var port = null;
  var transportError = null;
  var documentAlive = true;

  function clampTimeout(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (value < 10) return 10;
    if (value > 300000) return 300000;
    return Math.floor(value);
  }

  function getTimeoutMs(isAction) {
    var cfg = window.__HANA_CARD_RUNTIME_CONFIG__ || {};
    if (isAction) {
      if (typeof cfg.actionTimeoutMs === 'number') return clampTimeout(cfg.actionTimeoutMs, 300000);
      if (typeof cfg.timeoutMs === 'number') return clampTimeout(cfg.timeoutMs, 300000);
      return 300000; // 动作类 5 分钟
    }
    if (typeof cfg.readTimeoutMs === 'number') return clampTimeout(cfg.readTimeoutMs, 15000);
    if (typeof cfg.timeoutMs === 'number') return clampTimeout(cfg.timeoutMs, 15000);
    return 15000; // 读操作 15 秒
  }

  function readNonce() {
    try {
      var meta = document.querySelector('meta[name="hana-mobile-bridge"]');
      var value = meta && meta.getAttribute('content');
      if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
    } catch (e) { /* fall through */ }
    try {
      var match = String(window.location.hash || '').match(/(?:^#|&)hana-mobile-bridge=([0-9a-f]{64})(?:&|$)/);
      if (match) return match[1];
    } catch (e) { /* fall through */ }
    return null;
  }

  function failClosed(code, message) {
    transportError = { code: code, error: message };
    pending.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        code: code,
        error: message,
        result: {}
      });
    });
    pending.clear();
  }

  function handlePortMessage(event) {
    var data = event && event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'hana.card-data-changed' || data.type === 'card:data_change' || data.type === 'card:data') {
      var nextData = data.data !== undefined ? data.data : data.payload;
      dataChangeListeners.forEach(function (fn) {
        try { fn(nextData); } catch (e) { console.error('[card-runtime] onChange callback failed:', e); }
      });
      return;
    }

    var isCardResponse = data.type === 'card:response' || data.type === 'hana.card-host-response' || data.requestId;
    if (!isCardResponse) return;

    var reqId = data.requestId;
    if (!reqId || !pending.has(reqId)) return;

    var entry = pending.get(reqId);
    pending.delete(reqId);
    clearTimeout(entry.timer);

    var res;
    if (data.ok === true) {
      res = {
        ok: true,
        result: (data.result && typeof data.result === 'object') ? data.result : {}
      };
    } else {
      res = {
        ok: false,
        code: data.code || 'CARD_HOST_ERROR',
        error: data.error || data.message || 'Unknown card host error',
        result: (data.result && typeof data.result === 'object') ? data.result : {}
      };
    }

    entry.resolve(res);
  }

  function connect() {
    var nonce = readNonce();
    if (!nonce) {
      failClosed('CARD_BRIDGE_NONCE_MISSING', 'Card bridge nonce is missing from controlled head or URL fragment');
      return;
    }
    if (typeof window.MessageChannel !== 'function') {
      failClosed('CARD_BRIDGE_UNSUPPORTED', 'MessageChannel is required for card host communication');
      return;
    }
    if (!window.parent || window.parent === window) {
      failClosed('CARD_HOST_UNAVAILABLE', 'Parent host window is not available');
      return;
    }

    try {
      var channel = new window.MessageChannel();
      port = channel.port1;
      port.onmessage = handlePortMessage;
      port.start();
      window.parent.postMessage({ type: 'card:connect', nonce: nonce }, '*', [channel.port2]);
    } catch (err) {
      port = null;
      failClosed('CARD_MESSAGE_POST_FAILED', String(err && err.message ? err.message : err));
    }
  }

  function postRequest(capability, payload, isAction) {
    return new Promise(function (resolve) {
      if (!documentAlive) {
        resolve({
          ok: false,
          code: 'CARD_DOCUMENT_UNLOADED',
          error: 'Card document is no longer alive',
          result: {}
        });
        return;
      }
      if (transportError || !port) {
        resolve({
          ok: false,
          code: (transportError && transportError.code) || 'CARD_BRIDGE_UNSUPPORTED',
          error: (transportError && transportError.error) || 'Card bridge is not connected',
          result: {}
        });
        return;
      }
      if (pending.size >= MAX_PENDING) {
        resolve({
          ok: false,
          code: 'CARD_PENDING_OVERFLOW',
          error: 'Pending requests limit exceeded',
          result: {}
        });
        return;
      }

      var requestId = 'req_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
      var timeoutMs = getTimeoutMs(isAction);

      var timer = setTimeout(function () {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          try {
            port.postMessage({ type: 'card:cancel', requestId: requestId });
          } catch (e) { /* port may already be closed */ }
          var errMsg = isAction
            ? '操作超时（结果未知，请检查后勿重复提交） (' + timeoutMs + 'ms)'
            : 'Request timed out waiting for card host response (' + timeoutMs + 'ms)';
          resolve({
            ok: false,
            code: 'CARD_TIMEOUT',
            error: errMsg,
            result: {}
          });
        }
      }, timeoutMs);

      pending.set(requestId, { resolve: resolve, timer: timer });

      try {
        port.postMessage({
          type: 'card:request',
          requestId: requestId,
          capability: capability,
          payload: payload !== undefined ? payload : {},
          timeoutMs: timeoutMs
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve({
          ok: false,
          code: 'CARD_MESSAGE_POST_FAILED',
          error: String(err && err.message ? err.message : err),
          result: {}
        });
      }
    });
  }

  window.addEventListener('pagehide', function () {
    documentAlive = false;
    if (port) {
      try { port.postMessage({ type: 'card:disconnect' }); } catch (e) { /* ignore */ }
      try { port.close(); } catch (e) { /* ignore */ }
      port = null;
    }
    pending.forEach(function (entry) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        code: 'CARD_DOCUMENT_UNLOADED',
        error: 'Card document was unloaded before the host responded',
        result: {}
      });
    });
    pending.clear();
  }, { once: true });

  connect();

  var cardApi = {
    capabilities: function () {
      return postRequest('host.capabilities', {}, false);
    },
    state: {
      get: function (key) {
        var payload = key !== undefined ? { key: key } : {};
        return postRequest('state.get', payload, false).then(function (res) {
          if (res.ok && res.result && res.result.state && typeof res.result.state === 'object') {
            if (key !== undefined && res.result.value === undefined) {
              res.result.value = res.result.state[key];
            }
          }
          return res;
        });
      },
      set: function (keyOrPatch, value) {
        var payload;
        if (typeof keyOrPatch === 'string') {
          payload = { key: keyOrPatch, value: value };
        } else if (keyOrPatch && typeof keyOrPatch === 'object') {
          payload = { state: keyOrPatch };
        } else {
          payload = {};
        }
        return postRequest('state.set', payload, false);
      }
    },
    invoke: function (bindingId, input) {
      return postRequest('tool.invoke', {
        bindingId: bindingId,
        input: (input && typeof input === 'object') ? input : {}
      }, true);
    },
    emit: function (name, payload, to) {
      return postRequest('emit', {
        name: name,
        payload: payload !== undefined ? payload : {},
        to: to
      }, true);
    },
    track: function (name, payload) {
      return postRequest('track', {
        name: name,
        payload: payload !== undefined ? payload : {}
      }, false);
    },
    data: {
      get: function () {
        return postRequest('data.get', {}, false);
      },
      onChange: function (cb) {
        if (typeof cb === 'function') {
          dataChangeListeners.add(cb);
        }
        return function unsubscribe() {
          dataChangeListeners.delete(cb);
        };
      }
    },
    request: function (capability, payload) {
      var isAction = capability === 'tool.invoke' || capability === 'emit' || capability === 'tools:invoke' || capability === 'events:emit';
      return postRequest(capability, payload, isAction);
    }
  };

  window.card = cardApi;
  window.hana = cardApi;
})();
`;

export function getCardRuntimeScript() {
  return CARD_RUNTIME_SCRIPT;
}
