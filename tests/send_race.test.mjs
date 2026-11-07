/* 发送流程竞态回归测试
 *
 * 覆盖 sendMessage 在 await waitForWs() 前后的 4 处竞态/错误行为：
 * 1. 等待 WS 期间重复点击 -> 必须确保单次发送，不产生并发重复消息
 * 2. 等待 WS 期间切换会话 -> 必须放弃旧消息发送，不能跨会话把旧消息发给新会话
 * 3. 等待 WS 期间用户修改草稿 -> 恢复后不可盲目清空输入框，不清除新草稿
 * 4. wsSend 失败 -> 不可丢弃草稿，不可在 UI 上画出未成功发送的消息
 */

import assert from 'node:assert/strict';

// 准备极简 DOM 与浏览器全局环境（用于在无头 Node 环境下加载 web/app.js）
const elements = {};
function makeEl(tag = 'div', id = '') {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    listeners: {},
    children: [],
    style: {},
    classList: {
      add(cls) {
        const current = (node.className || '').split(/\s+/).filter(Boolean);
        if (!current.includes(cls)) current.push(cls);
        node.className = current.join(' ');
      },
      remove(cls) {
        const current = (node.className || '').split(/\s+/).filter((c) => c && c !== cls);
        node.className = current.join(' ');
      },
      contains(cls) {
        return (node.className || '').split(/\s+/).includes(cls);
      },
    },
    addEventListener(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    },
    removeEventListener(evt, fn) {
      if (this.listeners[evt]) {
        this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn);
      }
    },
    dispatchEvent(evt, data) {
      (this.listeners[evt] || []).forEach((f) => f(data));
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const index = ref ? this.children.indexOf(ref) : -1;
      this.children.splice(index === -1 ? this.children.length : index, 0, child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
    },
    querySelector() {
      return makeEl();
    },
    querySelectorAll() {
      return [];
    },
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    scrollHeight: 32,
    attributes: {},
    setAttribute(name, val) {
      this.attributes[name] = String(val);
    },
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
  };
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements[id]) elements[id] = makeEl('div', id);
  return elements[id];
}

globalThis.location = { protocol: 'http:', host: 'localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  documentElement: { style: { setProperty() {} } },
  addEventListener: () => {},
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0 };
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ fn, once: !!options.once });
    this.listeners.set(type, list);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item.fn !== fn));
  }

  dispatchEvent(typeOrEvent, data) {
    const event = typeof typeOrEvent === 'string'
      ? { ...(data || {}), type: typeOrEvent }
      : typeOrEvent;
    const list = [...(this.listeners.get(event.type) || [])];
    for (const item of list) {
      item.fn.call(this, event);
      if (item.once) this.removeEventListener(event.type, item.fn);
    }
  }

  open() {
    if (this.readyState === MockWebSocket.OPEN || this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent('open');
  }

  send(data) {
    this.sent.push(String(data));
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent('close');
  }
}

globalThis.WebSocket = MockWebSocket;
let fetchHandler = null;
globalThis.fetch = async (...args) => {
  if (fetchHandler) return fetchHandler(...args);
  return { ok: false, text: async () => '' };
};

// 加载 app.js
await import('../web/app.js');

const S = globalThis.__hana.S;
const btnSend = getEl('btnSend');
const input = getEl('input');
const transcript = getEl('transcript');
const homeInput = getEl('homeInput');
const btnHomeSend = getEl('btnHomeSend');

function clickSend() {
  btnSend.dispatchEvent('click');
}

function resetEnv() {
  fetchHandler = null;
  elements['input'].value = '';
  elements['input'].style = {};
  elements['homeInput'].value = '';
  elements['homeInput'].style = {};
  elements['btnHomeSend'].disabled = false;
  elements['transcript'].children = [];
  S.attach = [];
  S.session = null;
  S.wsReady = false;
  S.ws = null;
  S.busy = false;
  if ('sending' in S) S.sending = false;
  S.sentInputs.clear();
}

async function waitFor(description, predicate, timeoutMs = 1500) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMs) {
      throw new Error(`等待超时：${description}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sentFrames(ws) {
  return ws.sent.map((raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function promptFrame(ws) {
  return sentFrames(ws).find((frame) => frame.type === 'prompt') || null;
}

function cleanupHomeFlow(ws) {
  // 先断开会话/清空 S.ws，close 回调就不会走重连和禁按钮分支。
  S.session = null;
  S.wsReady = false;
  if (S.ws === ws) S.ws = null;
  if (ws && ws.readyState !== globalThis.WebSocket.CLOSED) ws.close();
  homeInput.value = '';
  btnHomeSend.disabled = false;
}

let bad = 0;
async function t(name, fn) {
  resetEnv();
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 测试用例                                                            */
/* ------------------------------------------------------------------ */

await t('确保单次发送：等待 WS 期间重复点击不可产生重复发送', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '测试单次发送';

  // 第一次点击
  clickSend();
  // 等待期间重复点击
  clickSend();

  // 随后 WS 就绪
  ws.readyState = 1;
  S.wsReady = true;

  // 等待 tick 唤醒
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(sentFrames.length, 1, `期望只发送 1 帧，实际发送了 ${sentFrames.length} 帧`);
});

await t('不会跨会话发旧消息：等待 WS 期间切换会话不可把旧草稿发到新会话', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  S.session = { path: 'session-A-path', sessionId: 'session-A-id' };
  input.value = '会话A的旧消息';

  // 在会话 A 点击发送
  clickSend();

  // 等待 WS 期间，用户切换了会话到 B
  S.session = { path: 'session-B-path', sessionId: 'session-B-id' };

  // 随后 WS 就绪
  ws.readyState = 1;
  S.wsReady = true;

  await new Promise((r) => setTimeout(r, 120));

  // 不应该向会话 B 发送会话 A 的旧消息
  assert.equal(sentFrames.length, 0, `期望放弃旧消息发送（0 帧），实际发送了 ${sentFrames.length} 帧给 ${sentFrames[0]?.sessionPath}`);
});

await t('同会话对象 path/ID 原地变化：等待期间也不得误发', async () => {
  for (const field of ['path', 'sessionId']) {
    const sentFrames = [];
    const ws = {
      readyState: 0,
      send(data) {
        sentFrames.push(JSON.parse(data));
      },
    };
    S.ws = ws;
    S.wsReady = false;
    S.session = { path: 'path-1', sessionId: 'sess-1' };
    input.value = `就地修改 ${field} 的草稿`;

    clickSend();

    // 同一个对象原地改字段：引用比较发现不了，必须靠起发时捕获的标量
    S.session[field] = `mutated-${field}`;

    ws.readyState = 1;
    S.wsReady = true;

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(sentFrames.length, 0, `同一 session 对象的 ${field} 原地变化不得误发`);
    input.value = '';
  }
});

await t('不清除等待时新草稿：等待 WS 期间修改草稿或新增附件不可在恢复后被清空', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '旧草稿内容';
  const initialAttach = { id: 1, name: 'a.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
  S.attach = [initialAttach];

  // 点击发送
  clickSend();

  // 用户在等待 WS 恢复期间修改了草稿，并新增了附件
  input.value = '等待期间编辑的新草稿内容';
  const newAttach = { id: 2, name: 'b.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
  S.attach = [initialAttach, newAttach];

  // WS 就绪
  ws.readyState = 1;
  S.wsReady = true;

  await new Promise((r) => setTimeout(r, 120));

  // 发送的是旧快照，但输入框中用户新写的内容不能被无脑清空！
  assert.equal(input.value, '等待期间编辑的新草稿内容', `期望保留等待时编辑的新草稿，实际 input.value 为: "${input.value}"`);
  // 新添加的附件也不能被清空
  assert.ok(S.attach.includes(newAttach), '期望保留等待期间新增的附件');
});

await t('shown 快照：等待期间修改附件预览，仍使用 controller 起发时捕获的数据', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '图片快照测试';
  const img = {
    id: 1,
    name: 'original.png',
    mimeType: 'image/png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    previewUrl: 'blob:original-preview',
  };
  S.attach = [img];

  clickSend();

  // controller 在 await 前已生成 shown 快照；等待期间改对象不应影响上屏预览。
  img.name = 'mutated.png';
  img.previewUrl = 'blob:mutated-preview';

  ws.readyState = 1;
  S.wsReady = true;

  await new Promise((r) => setTimeout(r, 120));

  assert.equal(sentFrames.length, 1, '应发送 1 帧');
  const userTurns = transcript.children.filter((c) => c.className?.includes('turn user'));
  assert.equal(userTurns.length, 1, '应画出 1 个用户气泡');

  const imgs = [];
  const walk = (node) => {
    if (node.className?.split(/\s+/).includes('user-media')) {
      for (const child of node.children || []) {
        if (child.tagName === 'IMG') imgs.push(child);
      }
    }
    for (const child of node.children || []) walk(child);
  };
  walk(userTurns[0]);

  assert.equal(imgs.length, 1, '应画出 1 张用户消息图片');
  assert.equal(imgs[0].src, 'blob:original-preview', '必须使用 controller 起发时的 previewUrl 快照');
  assert.equal(imgs[0].alt, 'original.png', '必须使用 controller 起发时的文件名快照');
  assert.equal(S.attach.length, 0, '已发送附件应从草稿中移除');
});

await t('发送失败不丢草稿：wsSend 失败不可清空草稿及附件，且不可画出用户消息', async () => {
  const ws = {
    readyState: 1, // waitForWs 能通过
    send(data) {},
  };
  S.ws = ws;
  S.wsReady = true;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '重要草稿不可丢';
  const myAttach = { id: 1, name: 'important.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
  S.attach = [myAttach];

  // 模拟在 waitForWs 之后、wsSend 之时，连接变为断开
  let checkCount = 0;
  Object.defineProperty(ws, 'readyState', {
    get() {
      checkCount++;
      return checkCount === 1 ? 1 : 3; // 第一次通过 waitForWs，第二次进入 wsSend 返回 false
    },
  });

  clickSend();
  await new Promise((r) => setTimeout(r, 50));

  // 1. 草稿不可丢失
  assert.equal(input.value, '重要草稿不可丢', `期望草稿保留在输入框中，实际为: "${input.value}"`);
  assert.equal(S.attach.length, 1, `期望附件保留，实际附件数量为: ${S.attach.length}`);
  // 2. transcript 中不可画出用户消息
  const userTurns = transcript.children.filter((c) => c.className?.includes('turn user'));
  assert.equal(userTurns.length, 0, `期望未画出用户消息气泡，实际画出了 ${userTurns.length} 个`);
});

await t('正常发送成功：草稿清空、附件移除、用户消息上屏并置 busy', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 1,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = true;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '正常消息';
  const img = { id: 1, name: 'ok.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
  S.attach = [img];

  clickSend();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sentFrames.length, 1, '已发送 1 帧');
  assert.equal(input.value, '', '输入框已清空');
  assert.equal(S.attach.length, 0, '附件已清空');
  assert.equal(S.busy, true, 'S.busy 应为 true');
  const userTurns = transcript.children.filter((c) => c.className?.includes('turn user'));
  assert.equal(userTurns.length, 1, 'transcript 应渲染用户气泡');
});

await t('waitForWs 超时未就绪：草稿不丢且不画出消息', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '未就绪时的草稿';

  // 触发发送（由于 WS 一直为 0，waitForWs 会等待直到超时或我们测试其等待期间的行为）
  // 模拟一个较快超时的 waitForWs 测试场景
  // 注意：原 waitForWs 默认是 4000ms，在测试中我们可以在 200ms 后检查状态依然受保护
  clickSend();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sentFrames.length, 0, '尚未就绪时不应发送帧');
  assert.equal(input.value, '未就绪时的草稿', '草稿应完好保留在输入框中');
  assert.equal(S.busy, false, '未就绪时不进入 busy');

  // 释放这次悬挂的 send，避免单飞锁泄漏到下一个用例：换会话后让 waitForWs 立刻通过，控制器会静默取消
  S.session = null;
  S.ws = { readyState: 1, send() {} };
  S.wsReady = true;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sentFrames.length, 0, '释放发送锁时不得补发消息');
});

await t('回车键防重复：等待 WS 期间连续按回车不会产生重复发送', async () => {
  const sentFrames = [];
  const ws = {
    readyState: 0,
    send(data) {
      sentFrames.push(JSON.parse(data));
    },
  };
  S.ws = ws;
  S.wsReady = false;
  btnSend.disabled = false;
  S.session = { path: 'path-1', sessionId: 'sess-1' };
  input.value = '回车发送测试';

  const pressEnter = () => {
    input.dispatchEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault() {},
    });
  };

  pressEnter();
  pressEnter();
  pressEnter();

  ws.readyState = 1;
  S.wsReady = true;

  await new Promise((r) => setTimeout(r, 120));

  assert.equal(sentFrames.length, 1, `多次回车期望只发送 1 帧，实际发送了 ${sentFrames.length} 帧`);
});

await t('sendFromHome in-flight 防重：请求在途期间重复触发只应发起一次会话创建', async () => {
  let sessionNewCalls = 0;
  let resolveSessionNew;
  const sessionNewPromise = new Promise((resolve) => {
    resolveSessionNew = resolve;
  });
  const socketBase = MockWebSocket.instances.length;
  let ws = null;

  try {
    fetchHandler = async (url) => {
      if (url.includes('/api/sessions/new')) {
        sessionNewCalls++;
        await sessionNewPromise;
        return {
          ok: true,
          text: async () => JSON.stringify({ path: 'home-sess-path', sessionId: 'home-sess-id' }),
        };
      }
      if (url.includes('/api/sessions/messages') || url.includes('/api/sessions')) {
        return {
          ok: true,
          text: async () => JSON.stringify([]),
        };
      }
      return { ok: false, text: async () => '' };
    };

    homeInput.value = '主页发问测试';

    // 第一次触发（按钮点击）
    btnHomeSend.dispatchEvent('click');

    // 在请求在途期间，通过回车再次触发
    homeInput.dispatchEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      preventDefault() {},
    });

    // 或者再次点击按钮
    btnHomeSend.dispatchEvent('click');

    // 放行首个请求
    resolveSessionNew();
    await waitFor('主页会话创建完成', () => sessionNewCalls === 1);

    // 等 connectWS 真正创建连接，再由测试显式打开；不能靠真实定时器撞 3 秒上限。
    await waitFor('主页 WebSocket 创建', () => MockWebSocket.instances.length > socketBase);
    ws = MockWebSocket.instances[socketBase];
    ws.open();

    await waitFor('主页 prompt 已发送', () => promptFrame(ws));
    await waitFor('主页按钮已重新启用', () => btnHomeSend.disabled === false);

    assert.equal(sessionNewCalls, 1, `期望只调用 1 次 /api/sessions/new，实际调用了 ${sessionNewCalls} 次`);
    assert.equal(promptFrame(ws)?.text, '主页发问测试', '主页流程应发送原始输入');
    assert.equal(promptFrame(ws)?.sessionPath, 'home-sess-path', '主页消息必须发往新建会话路径');
    assert.equal(promptFrame(ws)?.sessionId, 'home-sess-id', '主页消息必须携带新建会话 ID');
    assert.equal(ws.readyState, globalThis.WebSocket.OPEN, 'WebSocket 应已打开');
    assert.equal(btnHomeSend.disabled, false, '主页流程完成后按钮应重新启用');
  } finally {
    cleanupHomeFlow(ws || MockWebSocket.instances[socketBase]);
  }
});

await t('主页 Enter 忽略 isComposing / keyCode 229：输入法组合输入期间按回车不可触发发送', async () => {
  let sessionNewCalls = 0;
  const socketBase = MockWebSocket.instances.length;
  let ws = null;

  try {
    fetchHandler = async (url) => {
      if (url.includes('/api/sessions/new')) {
        sessionNewCalls++;
        return {
          ok: true,
          text: async () => JSON.stringify({ path: 'home-sess-path', sessionId: 'home-sess-id' }),
        };
      }
      return { ok: true, text: async () => JSON.stringify([]) };
    };

    homeInput.value = '拼音输入中';

    // 1. isComposing 为 true 时按回车
    homeInput.dispatchEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      isComposing: true,
      preventDefault() {},
    });

    // 2. keyCode 为 229 时按回车
    homeInput.dispatchEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      shiftKey: false,
      isComposing: false,
      preventDefault() {},
    });

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sessionNewCalls, 0, `输入法组合期间不应发起会话创建，实际发起了 ${sessionNewCalls} 次`);

    // 正向对照：普通 Enter 必须真的触发新建，证明上面的 0 不是因为 homeSending 锁残留。
    homeInput.dispatchEvent('keydown', {
      key: 'Enter',
      shiftKey: false,
      isComposing: false,
      preventDefault() {},
    });
    await waitFor('IME 正向对照创建完成', () => sessionNewCalls === 1);
    await waitFor('IME 正向对照 WebSocket 创建', () => MockWebSocket.instances.length > socketBase);
    ws = MockWebSocket.instances[socketBase];
    ws.open();
    await waitFor('IME 正向对照 prompt 已发送', () => promptFrame(ws));
    await waitFor('IME 正向对照按钮已重新启用', () => btnHomeSend.disabled === false);

    assert.equal(sessionNewCalls, 1, `普通 Enter 应发起 1 次会话创建，实际 ${sessionNewCalls} 次`);
    assert.equal(promptFrame(ws)?.text, '拼音输入中', '普通 Enter 应发送原始输入');
    assert.equal(promptFrame(ws)?.sessionPath, 'home-sess-path', '普通 Enter 消息必须发往新建会话路径');
    assert.equal(promptFrame(ws)?.sessionId, 'home-sess-id', '普通 Enter 消息必须携带新建会话 ID');
    assert.equal(ws.readyState, globalThis.WebSocket.OPEN, '正向对照的 WebSocket 应已打开');
    assert.equal(btnHomeSend.disabled, false, '正向对照完成后按钮应重新启用');
  } finally {
    cleanupHomeFlow(ws || MockWebSocket.instances[socketBase]);
  }
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED (成功复现现有竞态缺陷)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
