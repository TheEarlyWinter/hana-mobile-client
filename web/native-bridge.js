/* web/native-bridge.js — 页面 → 原生壳的通知通道（只做通知这一件事）
 *
 * 为什么是 WebMessageChannel 而不是别的：
 *  - 壳里严禁 addJavascriptInterface（MainActivity 类注释写了原因：它对所有 frame 生效，
 *    连 show_card 渲染出的卡片 iframe 都能拿到，等于把原生能力交给一张卡片）；
 *  - 自定义 scheme 那条路只能靠 URL 导航，shouldOverrideUrlLoading 只告诉我们「这次导航
 *    目标是不是主 frame」，分不清是谁发起的：卡片 iframe 一句 top.location = 'hana-notify://…'
 *    就能冒充页面去发通知，还得额外加手势/来源判断才勉强收得住；
 *  - WebView.postWebMessage 的投递对象是**主 frame**，且只在文档 origin 与 targetOrigin
 *    相符时才投。端口一旦递到主 frame 那份 window 上，卡片 iframe 拿不到、也伪造不了来源。
 *    两边各校验一次（原生校验 targetOrigin，页面校验 event.origin），比单边 URL 判断厚。
 *
 * 契约：
 *   createNativeBridge({ window, expectedOrigin }) -> {
 *     available: boolean,                 // 握手成功后才是 true（桌面浏览器里恒为 false）
 *     whenReady(): Promise<boolean>,
 *     notify(title, body): Promise<boolean>,
 *     requestPermission(): Promise<'granted'|'denied'|'unsupported'|'unknown'>,
 *     dispose(): void,
 *   }
 *
 * 消息形状（上下行都是 JSON 字符串，非 JSON / 版本不符 / 超长一律丢弃）：
 *   上行 {v:1, hello:true}                           握手回执，原生据此停掉重投
 *   上行 {v:1, action:'notify', title, body}          发一条「回复完成」
 *   上行 {v:1, action:'requestPermission', id}        要通知权限
 *   下行 {v:1, reply:'permission', id, status}        权限结论
 * 只有这两种 action。这不是通用 RPC，别往里加东西。
 */

/** 原生递端口时那句话里的指纹：消息里没有它就不当握手（卡片之间也会 postMessage）。 */
const HELLO_MARKER = '"bridge":"hana-native"';
const PROTOCOL_VERSION = 1;
/** 下行单条报文上限：原生只发权限回执，几十个字符，2048 已经宽松得离谱。 */
const MAX_INBOUND_CHARS = 2048;
/** 上行单条报文上限：原生侧还有一份独立校验，两边都不许超。 */
const MAX_OUTBOUND_CHARS = 1024;
/** 通知标题 / 正文的字符上限；锁屏只看得见一两行，再长也显示不出来。 */
export const NOTIFY_TITLE_MAX = 64;
export const NOTIFY_BODY_MAX = 160;
/** 握手超时：壳没递端口就当没有原生，绝不挂住页面。原生重投总长约 3 秒。 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3000;
/** 权限回执超时：用户可能盯着系统权限框想一会儿，给足 20 秒。 */
export const DEFAULT_PERMISSION_REPLY_TIMEOUT_MS = 20000;

/**
 * 规整成 RFC 6454 的 origin 序列化（scheme://host[:port]，默认端口省略）。
 * 原生侧的 targetOrigin 就是按这个形状发的，两边必须用同一种写法比较。
 */
export function normalizeOrigin(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text === 'null') return '';
  try {
    const origin = new URL(text).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

/** 通知文案压成一行并截断：换行 / 控制字符在通知栏里只会显示成怪东西。 */
function clampText(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function normalizeStatus(raw) {
  return raw === 'granted' || raw === 'denied' || raw === 'unsupported' ? raw : 'unknown';
}

/**
 * 定时器。不是为了让 Node 测试提前退场就 unref：
 * unref 过的定时器不会阻止进程退出，于是 `await bridge.notify(...)` 在没有任何其它活的
 * 进程里会永远等下去（Node 报 unsettled top-level await）。每一处等待都必须真的会落地。
 */
function startTimer(fn, ms) {
  return setTimeout(fn, Math.max(0, Number(ms) || 0));
}

/**
 * @param {object} options
 * @param {Window|null} options.window 页面窗口（测试里可以是假 window）
 * @param {string} [options.expectedOrigin] 期望 origin，通常是 window.location.origin
 * @param {number} [options.handshakeTimeoutMs]
 * @param {number} [options.permissionReplyTimeoutMs]
 */
export function createNativeBridge({
  window = null,
  expectedOrigin = '',
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  permissionReplyTimeoutMs = DEFAULT_PERMISSION_REPLY_TIMEOUT_MS,
} = {}) {
  const win = window;
  /** 用页面自己报的 origin 兜底：装配时传一次就行，传空也不至于全靠调用方。 */
  const wanted = normalizeOrigin(expectedOrigin) || normalizeOrigin(win?.location?.origin);

  /** waiting：等原生递端口；ready：端口在手；unavailable：没壳 / 超时 / 端口已死。 */
  let state = 'waiting';
  let port = null;
  let seq = 0;
  /** 在途的权限请求：id → resolve(status)。 */
  const pending = new Map();
  let settleReady = null;
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });

  const handshakeTimer = startTimer(() => {
    // 桌面浏览器里不会有端口过来：3 秒后安静地认定「没有原生」，页面照常用。
    // 真机调试时这条日志是判断「桥没通」的第一现场（转发到 logcat 的 HanaWebConsole）。
    if (state === 'waiting') {
      console.info('[bridge] 3 秒内没收到原生端口，按没有原生壳处理');
    }
    markUnavailable();
  }, handshakeTimeoutMs);

  function markUnavailable() {
    if (state !== 'waiting') return;
    clearTimeout(handshakeTimer);
    state = 'unavailable';
    settleReady(false);
  }

  function closePort() {
    const dead = port;
    port = null;
    if (!dead) return;
    try {
      dead.onmessage = null;
      dead.close?.();
    } catch {
      // 端口已经失效：没什么可收拾的
    }
  }

  /**
   * 握手消息判定：必须是「带端口 + 带指纹 + origin 对得上」。
   *
   * 真机实测：Android WebView 的 `postWebMessage` 送到页面时 `event.origin` 是**空串**、
   * `event.source` 是 **null**，所以不能要求 source 恒定等于 window（那样在真机上永远握手失败）。
   * 这里的安全依据是**端口本身**：`WebMessagePort` 只能由壳创建，网页侧（含同行 iframe）
   * 造不出来，所以「带端口 + 带确切指纹」已经是足够强的身份凭据。
   * origin 能拿到时必须严格相等，拿不到才退到这条。
   */
  function isOurHandshake(event) {
    if (!event || typeof event !== 'object') return false;
    const ports = event.ports;
    if (!ports || !ports.length) return false;
    if (typeof event.data !== 'string' || !event.data.includes(HELLO_MARKER)) return false;
    if (!wanted) return false;
    const origin = typeof event.origin === 'string' ? event.origin : '';
    if (origin && origin !== 'null') return origin === wanted;
    // origin 缺失：本页自身也得站在预期 origin 上，否则说明整页已经被导到别处了。
    if (normalizeOrigin(win?.location?.origin) !== wanted) return false;
    return event.source == null || event.source === win;
  }

  function adopt(rawPort) {
    if (!rawPort || typeof rawPort.postMessage !== 'function') return;
    if (rawPort === port) return;          // 同一个端口重复投：什么都不用做
    closePort();
    port = rawPort;
    // 挂上 onmessage 就等于 start()，显式再来一次也无害（Chromium 里是幂等的）。
    rawPort.onmessage = onPortMessage;
    try {
      rawPort.start?.();
    } catch {
      // 有的实现没有 start()，不碍事
    }
    try {
      rawPort.postMessage(JSON.stringify({ v: PROTOCOL_VERSION, hello: true }));
    } catch {
      // 回执发不出去也不影响：原生那边最多多重投几次端口，页面这边照样能用
    }
    state = 'ready';
    clearTimeout(handshakeTimer);
    settleReady(true);
    console.info('[bridge] 原生端口已接管，通知可用');
  }

  /** 下行只有一个来源：原生。只认权限回执，其余（含超长、非 JSON）一律丢。 */
  function onPortMessage(event) {
    const data = event?.data;
    if (typeof data !== 'string' || data.length > MAX_INBOUND_CHARS) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.v !== PROTOCOL_VERSION) return;
    if (msg.reply !== 'permission') return;
    const id = typeof msg.id === 'string' ? msg.id : '';
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    waiter(normalizeStatus(msg.status));
  }

  function post(text) {
    if (!port) return false;
    try {
      port.postMessage(text);
      return true;
    } catch {
      // 端口死了（页面导航、壳销毁）：认定不可用，别让后面继续往死端口里丢东西。
      closePort();
      state = 'unavailable';
      return false;
    }
  }

  async function notify(title, body) {
    const ok = await ready;
    if (!ok || !port) return false;
    const text = JSON.stringify({
      v: PROTOCOL_VERSION,
      action: 'notify',
      title: clampText(title, NOTIFY_TITLE_MAX),
      body: clampText(body, NOTIFY_BODY_MAX),
    });
    if (text.length > MAX_OUTBOUND_CHARS) return false;
    return post(text);
  }

  async function requestPermission() {
    const ok = await ready;
    if (!ok || !port) return 'unsupported';
    seq += 1;
    const id = 'p' + seq;
    const text = JSON.stringify({ v: PROTOCOL_VERSION, action: 'requestPermission', id });
    if (!post(text)) return 'unsupported';
    return new Promise((resolve) => {
      const timer = startTimer(() => {
        // 20 秒还没回执：可能用户还开着系统权限框，也可能壳那边出岔子了。
        // 给 'unknown'，让上层保持「没结论」而不是错误地记成 denied。
        if (pending.delete(id)) resolve('unknown');
      }, permissionReplyTimeoutMs);
      pending.set(id, (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  /**
   * 握手入口。状态已经 ready 之后仍然接受新端口：原生没等到 hello 会重投，
   * 重投时它会把上一轮的端口关掉；页面这边必须跟着接管新的那条，否则两边各拿半条死端口。
   * 已经判定「没有原生」之后不再改主意（那个 promise 已经 resolve 过了）。
   */
  function onWindowMessage(event) {
    if (state === 'unavailable') return;
    if (!isOurHandshake(event)) {
      // 只记带端口的消息：普通 postMessage 很多（卡片等），全记会淹没日志。
      if (event && event.ports && event.ports.length) {
        const origin = typeof event.origin === 'string' ? event.origin : '(缺)';
        console.warn(`[bridge] 收到带端口的消息但未采纳：origin=${origin} 期望=${wanted} data=${typeof event.data === 'string' ? event.data.slice(0, 40) : typeof event.data}`);
      }
      return;
    }
    adopt(event.ports[0]);
  }

  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('message', onWindowMessage);
  } else {
    // 连事件都挂不上（不是 window、或者被裁剪过）：没有原生，立刻收摊。
    markUnavailable();
  }

  function dispose() {
    clearTimeout(handshakeTimer);
    try {
      win?.removeEventListener?.('message', onWindowMessage);
    } catch {
      // 无所谓
    }
    closePort();
    for (const [, settle] of pending) settle('unsupported');
    pending.clear();
    state = 'unavailable';
    settleReady(false);   // 已经 resolve 过就无效；还没 resolve 的别再等 3 秒
  }

  return {
    get available() {
      return state === 'ready';
    },
    whenReady: () => ready.then((ok) => Boolean(ok) && state === 'ready'),
    notify,
    requestPermission,
    dispose,
  };
}
