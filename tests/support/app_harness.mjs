/* tests/support/app_harness.mjs — 无 jsdom 的极简浏览器环境
 *
 * 项目里的测试都是「node tests/xxx.test.mjs + 手写假 DOM」，本文件把那套假 DOM
 * 收成一份共用夹具，避免每个新用例各写一遍（也避免彼此行为不一致）。
 *
 * 只提供 web/ 真代码会用到的能力：
 *   - document.getElementById / createElement / body / documentElement
 *   - 节点：children、classList、innerHTML（含极简 HTML 解析，file-preview 用字符串建面板）、
 *     querySelector(All)（只认 .class / #id / 标签名）、insertBefore、remove、replaceWith
 *   - window / visualViewport 事件登记（用例可以 fire 回去）
 *   - MockWebSocket：open() / close() / serverClose()，可观察 sent 帧与实例
 *   - 路由化 fetch（每个用例自己给路由）+ 可选的图片处理管线桩
 *
 * 用法：
 *   const h = createHarness();            // 必须在 import web/app.js 之前调用
 *   h.setFetch(router);
 *   await h.loadApp();                    // 等 window.__hana 就绪
 */

const VOID_TAGS = new Set([
  'img', 'br', 'hr', 'input', 'meta', 'link', 'path', 'circle', 'rect', 'line',
  'polyline', 'polygon', 'ellipse', 'source', 'area', 'base', 'col', 'embed',
  'param', 'track', 'wbr', 'use',
]);

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(lt|gt|amp|quot|apos|nbsp);/g, (_m, key) => ENTITIES[key] || _m);
}

function splitClasses(value) {
  return String(value || '').split(/\s+/).filter(Boolean);
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return attrs;
}

export function createHarness({ debug = true } = {}) {
  const elements = new Map();
  const allNodes = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const cssVars = new Map();

  /* ---------------------------- 节点 ---------------------------- */

  function makeNode(tag = 'div', id = '') {
    const classes = new Set();
    const children = [];
    const listeners = new Map();
    const attributes = new Map();
    let ownTextContent = '';

    function assertCanContain(child) {
      let ancestor = node;
      while (ancestor) {
        if (ancestor === child) throw new Error('不能将祖先节点插入其后代');
        ancestor = ancestor.parentNode;
      }
    }

    const node = {
      tagName: String(tag).toUpperCase(),
      id,
      children,
      style: {},
      dataset: {},
      hidden: false,
      disabled: false,
      value: '',
      scrollHeight: 600,
      scrollTop: 0,
      clientHeight: 600,
      parentNode: null,
      src: '',
      alt: '',
      type: '',
      title: '',
      get parentElement() {
        const parent = node.parentNode;
        return parent?.tagName && parent.tagName !== '#TEXT' ? parent : null;
      },
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(value) {
        classes.clear();
        for (const c of splitClasses(value)) classes.add(c);
      },
      classList: {
        add(...cls) { for (const c of cls) classes.add(c); },
        remove(...cls) { for (const c of cls) classes.delete(c); },
        contains(cls) { return classes.has(cls); },
        toggle(cls, force) {
          const on = force === undefined ? !classes.has(cls) : Boolean(force);
          if (on) classes.add(cls);
          else classes.delete(cls);
          return on;
        },
      },
      get firstChild() {
        return children[0] || null;
      },
      get lastChild() {
        return children[children.length - 1] || null;
      },
      get nextSibling() {
        const parent = node.parentNode;
        if (!parent) return null;
        const index = parent.children.indexOf(node);
        return index === -1 ? null : parent.children[index + 1] || null;
      },
      get previousElementSibling() {
        const parent = node.parentNode;
        if (!parent) return null;
        const siblings = parent.children.filter((c) => c.tagName !== '#TEXT');
        const index = siblings.indexOf(node);
        return index > 0 ? siblings[index - 1] : null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.set(type, listeners.get(type).filter((f) => f !== fn));
      },
      dispatchEvent(evt, extra) {
        const type = typeof evt === 'string' ? evt : evt?.type;
        const payload = typeof evt === 'string'
          ? { type, target: node, preventDefault() {}, stopPropagation() {}, ...(extra || {}) }
          : { preventDefault() {}, stopPropagation() {}, ...evt, target: evt?.target || node };
        for (const fn of [...(listeners.get(type) || [])]) fn.call(node, payload);
        return payload;
      },
      appendChild(child) {
        if (!child) return child;
        assertCanContain(child);
        if (child.parentNode) child.parentNode.removeChild(child);
        children.push(child);
        child.parentNode = node;
        return child;
      },
      insertBefore(child, ref) {
        if (!child) return child;
        if (ref == null) return node.appendChild(child);
        const refIndex = children.indexOf(ref);
        if (refIndex === -1) throw new Error('参考节点不是当前容器的子节点');
        if (child === ref) return child;
        assertCanContain(child);
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = children.indexOf(ref);
        children.splice(index, 0, child);
        child.parentNode = node;
        return child;
      },
      removeChild(child) {
        const index = children.indexOf(child);
        if (index !== -1) {
          children.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      },
      replaceChild(child, oldChild) {
        if (!child || !oldChild) throw new Error('替换节点和旧节点都必须存在');
        const oldIndex = children.indexOf(oldChild);
        if (oldIndex === -1) throw new Error('旧节点不是当前容器的子节点');
        if (child === oldChild) return oldChild;
        assertCanContain(child);
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = children.indexOf(oldChild);
        children.splice(index, 1, child);
        child.parentNode = node;
        oldChild.parentNode = null;
        return oldChild;
      },
      replaceChildren(...next) {
        for (const child of [...children]) node.removeChild(child);
        for (const child of next) node.appendChild(child);
      },
      remove() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
      replaceWith(next) {
        const parent = node.parentNode;
        if (!parent) return;
        parent.replaceChild(next, node);
      },
      querySelector(selector) {
        return findDescendant(node, selector);
      },
      querySelectorAll(selector) {
        return collectMatched(node, selector);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
        if (name === 'class') node.className = value;
        if (name === 'src') node.src = String(value);
        if (name === 'alt') node.alt = String(value);
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      hasAttribute(name) {
        return attributes.has(name);
      },
      focus() {},
      blur() {},
      click() {
        node.dispatchEvent('click');
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      },
      closest(selector) {
        let cur = node;
        while (cur) {
          if (matchesSimple(cur, selector)) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
    };

    // 真代码里 innerHTML 既用来清空容器（''），也用来一次性建小块结构（file-preview 面板）。
    let html = '';
    Object.defineProperty(node, 'textContent', {
      get() {
        if (node.tagName === '#TEXT') return ownTextContent;
        return children.map((child) => String(child.textContent ?? '')).join('');
      },
      set(value) {
        const text = String(value ?? '');
        if (node.tagName === '#TEXT') {
          ownTextContent = text;
          return;
        }
        node.replaceChildren();
        if (!text) return;
        const textNode = makeNode('#text', '');
        textNode.textContent = text;
        node.appendChild(textNode);
      },
    });
    Object.defineProperty(node, 'innerHTML', {
      get() {
        return html;
      },
      set(value) {
        html = String(value ?? '');
        // 真 DOM 里 innerHTML='' 会把子节点从树上摘下来（parentNode 变 null）；
        // 不还原这一点，history-pagination-view 的 ensureBar() 会误以为控制带还挂在容器上。
        node.replaceChildren();
        if (!html) return;
        parseHtmlInto(node, html);
      },
    });

    allNodes.push(node);
    return node;
  }

  function matchesSimple(node, selector) {
    const token = String(selector || '').trim().split(/\s+/).pop();
    if (!token || !node) return false;
    // 支持 app 里真实出现的两种写法：`a.workspace-upload-btn`（标签+类）与
    // `.meta-tool:not(.done)`（排除类）；不支持的伪类一律当不匹配。
    if (token.includes(':')) {
      const notMatch = /:not\(\.?([\w-]+)\)/.exec(token);
      const base = notMatch ? token.replace(notMatch[0], '') : token.split(':')[0];
      if (notMatch && splitClasses(node.className).includes(notMatch[1])) return false;
      if (!notMatch && token.includes(':')) return false;
      return matchesSimple(node, base);
    }
    if (token.startsWith('#')) return node.id === token.slice(1);
    const [tagPart, ...classParts] = token.split('.');
    if (tagPart && node.tagName !== tagPart.toUpperCase()) return false;
    return classParts.every((cls) => cls && splitClasses(node.className).includes(cls));
  }

  function collectMatched(root, selector) {
    const token = String(selector || '').trim().split(/\s+/).pop();
    const out = [];
    const walk = (n) => {
      for (const child of n.children || []) {
        if (child.tagName === '#TEXT') continue;
        if (matchesSimple(child, token)) out.push(child);
        walk(child);
      }
    };
    walk(root);
    return out;
  }

  function findDescendant(root, selector) {
    return collectMatched(root, selector)[0] || null;
  }

  function parseHtmlInto(root, htmlText) {
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(htmlText))) {
      const [whole, closeName, openName, attrText, selfClose, text] = m;
      if (whole.startsWith('<!--')) continue;
      if (closeName) {
        const tag = closeName.toUpperCase();
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName === tag) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      if (openName) {
        const tag = openName.toLowerCase();
        const child = makeNode(tag, '');
        const attrs = parseAttributes(attrText);
        if (attrs.class) child.className = attrs.class;
        if (attrs.id) child.id = attrs.id;
        for (const [key, value] of Object.entries(attrs)) {
          if (key === 'class' || key === 'id') continue;
          child.setAttribute(key, value);
        }
        stack[stack.length - 1].appendChild(child);
        if (!selfClose && !VOID_TAGS.has(tag)) stack.push(child);
        continue;
      }
      if (text) {
        const decoded = decodeEntities(text);
        if (!decoded.trim()) continue;
        const textNode = makeNode('#text', '');
        textNode.textContent = decoded;
        stack[stack.length - 1].appendChild(textNode);
      }
    }
  }

  function getEl(id) {
    if (!id) return makeNode('div', '');
    if (!elements.has(id)) elements.set(id, makeNode('div', id));
    return elements.get(id);
  }

  /* ---------------------------- document ---------------------------- */

  const body = makeNode('body', 'body');
  const documentElement = makeNode('html', 'html');
  documentElement.style.setProperty = (name, value) => {
    cssVars.set(name, String(value));
    documentElement.style[name] = String(value);
  };
  documentElement.style.getPropertyValue = (name) => cssVars.get(name) || '';

  // index.html 里 #btnRefresh 是 #homeHeadActions 的直接子节点。
  getEl('homeHeadActions').appendChild(getEl('btnRefresh'));

  // index.html 里 #btnSend 自带 .send-label：setBusy() 直接改写它的文案，缺了就 TypeError。
  {
    const sendBtn = getEl('btnSend');
    const label = makeNode('span', '');
    label.className = 'send-label';
    label.textContent = '发送';
    sendBtn.appendChild(label);
  }

  // index.html 里这些节点自带 hidden（调试抽屉、灯箱、附件面板、三个视图）。
  // 假 DOM 的 hidden 默认 false 会让 backToList 误以为调试抽屉开着、把返回键吃掉。
  for (const id of [
    'debug', 'lightbox', 'attachSheet', 'attachBar', 'homeAttachBar', 'drawerMask',
    'view-login', 'view-list', 'view-chat',
  ]) {
    getEl(id).hidden = true;
  }

  const doc = {
    body,
    documentElement,
    visibilityState: 'visible',
    getElementById: getEl,
    createElement: (tag) => makeNode(tag, ''),
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (documentListeners.has(type)) {
        documentListeners.set(type, documentListeners.get(type).filter((f) => f !== fn));
      }
    },
    dispatchEvent(evt) {
      const type = typeof evt === 'string' ? evt : evt?.type;
      for (const fn of [...(documentListeners.get(type) || [])]) fn({ type, target: doc });
    },
    querySelector(selector) {
      return findDescendant(body, selector);
    },
    querySelectorAll(selector) {
      return collectMatched(body, selector);
    },
  };

  /* ---------------------------- window ---------------------------- */

  const win = globalThis;
  win.window = win;
  win.document = doc;
  win.location = {
    protocol: 'http:',
    host: 'localhost:8080',
    origin: 'http://localhost:8080',
    search: debug ? '?debug=1' : '',
    href: 'http://localhost:8080/',
  };
  win.addEventListener = (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  };
  win.removeEventListener = (type, fn) => {
    if (windowListeners.has(type)) {
      windowListeners.set(type, windowListeners.get(type).filter((f) => f !== fn));
    }
  };
  win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.innerHeight = 800;
  win.innerWidth = 400;
  win.performance = win.performance || { now: () => Date.now() };

  function fireWindow(type, extra = {}) {
    for (const fn of [...(windowListeners.get(type) || [])]) fn({ type, ...extra });
  }

  function fireDocument(type, extra = {}) {
    doc.dispatchEvent({ type, ...extra });
  }

  /* ------------------------ visualViewport ------------------------ */

  const vvListeners = new Map();
  const visualViewport = {
    width: 400,
    height: 800,
    offsetTop: 0,
    offsetLeft: 0,
    pageTop: 0,
    pageLeft: 0,
    addEventListener(type, fn) {
      if (!vvListeners.has(type)) vvListeners.set(type, []);
      vvListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (vvListeners.has(type)) vvListeners.set(type, vvListeners.get(type).filter((f) => f !== fn));
    },
  };
  win.visualViewport = visualViewport;

  function fireVisualViewport(type, extra = {}) {
    for (const fn of [...(vvListeners.get(type) || [])]) fn({ type, ...extra });
  }

  /* ---------------------------- WebSocket ---------------------------- */

  class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.listeners = new Map();
      this.sent = [];
      this.closeCalls = 0;
      MockWebSocket.instances.push(this);
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      if (this.listeners.has(type)) {
        this.listeners.set(type, this.listeners.get(type).filter((f) => f !== fn));
      }
    }

    dispatch(type, extra = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) {
        fn({ type, target: this, ...extra });
      }
    }

    open() {
      if (this.readyState === MockWebSocket.OPEN || this.readyState === MockWebSocket.CLOSED) return this;
      this.readyState = MockWebSocket.OPEN;
      this.dispatch('open');
      return this;
    }

    send(data) {
      this.sent.push(JSON.parse(String(data)));
    }

    /** 页面主动关闭：已关闭就不重复派发 close。 */
    close() {
      this.closeCalls += 1;
      if (this.readyState === MockWebSocket.CLOSED) return this;
      this.readyState = MockWebSocket.CLOSED;
      this.dispatch('close');
      return this;
    }

    /** 服务端掉线：页面没调 close()，但连接断了。 */
    serverClose() {
      if (this.readyState === MockWebSocket.CLOSED) return this;
      this.readyState = MockWebSocket.CLOSED;
      this.dispatch('close');
      return this;
    }

    /** 模拟一条服务端消息。 */
    push(payload) {
      this.dispatch('message', { data: JSON.stringify(payload) });
    }

    frames(type) {
      return type ? this.sent.filter((f) => f && f.type === type) : this.sent.slice();
    }
  }
  win.WebSocket = MockWebSocket;

  /* ---------------------------- fetch ---------------------------- */

  let fetchHandler = null;

  win.fetch = async (url, init = {}) => {
    if (!fetchHandler) throw new Error(`unexpected fetch: ${url}`);
    return fetchHandler(String(url), init);
  };

  function setFetch(handler) {
    fetchHandler = handler;
  }

  /** 统一造一个 JSON 响应（含 api 客户端要读的 text/ok/status）。 */
  function jsonRes(payload, { ok = true, status = 200, statusText = null } = {}) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    return {
      ok,
      status,
      statusText: statusText || (ok ? 'OK' : `HTTP ${status}`),
      async text() {
        return text;
      },
      async json() {
        return typeof payload === 'string' ? JSON.parse(payload) : payload;
      },
    };
  }

  /* ------------------- 图片处理管线（prepareImage 用） ------------------- */

  /**
   * attach.js 的 prepareImage 依赖 createImageBitmap / canvas / FileReader。
   * 装一套最小的桩：小图（小于 1.2MB 且不缩边）会走「原样保留」分支，
   * 于是结果 base64 直接由假 File 的 _b64 决定，用例可以断言具体值。
   */
  function installImagePipeline({ delayMs = 0 } = {}) {
    win.createImageBitmap = async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { width: 8, height: 8, close() {} };
    };
    win.FileReader = class MockFileReader {
      readAsDataURL(blob) {
        setTimeout(() => {
          this.result = `data:${blob?.type || 'image/png'};base64,${blob?._b64 || 'QUJD'}`;
          if (typeof this.onload === 'function') this.onload();
        }, 0);
      }
    };
    win.Blob = win.Blob || class MockBlob {
      constructor(parts, opts) {
        this.parts = parts;
      }
    };
    win.URL = win.URL || {};
    win.URL.createObjectURL = () => 'blob:mock';
    win.URL.revokeObjectURL = () => {};
  }

  /** 造一个假 File：默认是「小图原样保留」路径。 */
  function makeImageFile(name = 'a.png', { b64 = 'QUJD', size = 128, type = 'image/png' } = {}) {
    return { name, type, size, _b64: b64 };
  }

  /* ---------------------------- app 载入 ---------------------------- */

  async function loadApp() {
    await import('../../web/app.js');
    await waitFor(() => win.__hana, 'window.__hana 就绪');
    return win.__hana;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function settle(times = 4) {
    for (let i = 0; i < times; i += 1) await delay(0);
  }

  async function waitFor(predicate, label, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      await delay(10);
    }
    throw new Error(`等待超时：${label}`);
  }

  /** 节点的完整可见文本；兄弟文本节点之间加空格便于断言阅读。 */
  function textOf(node) {
    if (!node) return '';
    const children = node.children || [];
    if (!children.length) return String(node.textContent ?? '');
    return children.map((child) => textOf(child)).filter(Boolean).join(' ');
  }

  return {
    doc,
    body,
    documentElement,
    window: win,
    elements,
    allNodes,
    getEl,
    makeNode,
    cssVars,
    fireWindow,
    fireDocument,
    fireVisualViewport,
    visualViewport,
    MockWebSocket,
    ws: MockWebSocket,
    setFetch,
    jsonRes,
    installImagePipeline,
    makeImageFile,
    loadApp,
    delay,
    settle,
    waitFor,
    textOf,
    find: findDescendant,
    findAll: collectMatched,
    get fetchHandler() {
      return fetchHandler;
    },
  };
}
