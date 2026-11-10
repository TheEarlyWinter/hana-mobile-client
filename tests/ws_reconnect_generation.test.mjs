/* 缺陷 3 回归：连接代次与重连定时器
 *
 * 根因：
 *   - connectWS() 的 close 回调里存了一个匿名 setTimeout，新建连接时不取消。定时器
 *     只检查 S.session，于是它醒来就 connectWS()，把刚建好的连接关掉；
 *   - open / message / error 回调也不校验 socket 身份，旧连接迟到的事件照样处理。
 *
 * 锁的行为：每次连接一个代次号，所有回调只认自己那一代；重连定时器只有一个引用，
 * 手动连接 / 切会话 / 退出时都会取消。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createWebsocketClient } from '../web/websocket-client.js';

const h = createHarness();

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
/* 渲染进度袋：D2 起测试直接读它，S 上不再转发这些字段。 */
const R = hana?.rendererState || globalThis.__hana.rendererState;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const lastSocket = () => h.MockWebSocket.instances.at(-1);
const transcriptText = () => h.textOf(h.getEl('transcript'));

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* ------------------------------------------------------------------ */

await t('掉线后排的重连定时器，不能关掉随后手动建好的新连接', async () => {
  S.session = { path: 'p-gen', sessionId: 's-gen', title: '代次' };
  S.ws = null;
  S.wsReady = false;
  const base = h.MockWebSocket.instances.length;

  hana.connectWS();
  const ws1 = lastSocket();
  ws1.open();
  assert.equal(S.wsReady, true, '夹具：第一条连接应已就绪');

  S.reconnectDelay = 25;   // 先连上再调小退避（open 回调会把退避重置回 800ms）
  ws1.serverClose();       // 服务端掉线 → 排一个 25ms 的重连
  assert.equal(S.wsReady, false, '掉线后应标记未就绪');

  // 用户马上手动连上（回前台 / 切会话都会走 connectWS）
  hana.connectWS();
  const ws2 = lastSocket();
  assert.notEqual(ws2, ws1, '手动连接应建一条新连接');
  ws2.open();
  assert.equal(S.ws, ws2, '当前连接应是被手动建起的那条');

  // 等过旧定时器的触发点：它绝不能把 ws2 关掉再建一条
  await h.delay(140);

  assert.equal(
    h.MockWebSocket.instances.length - base,
    2,
    `旧重连定时器不该再建第三条连接，实际新建 ${h.MockWebSocket.instances.length - base} 条`,
  );
  assert.equal(ws2.closeCalls, 0, '新连接不能被旧定时器关掉');
  assert.equal(ws2.readyState, h.MockWebSocket.OPEN, '新连接必须还是打开状态');
  assert.equal(S.ws, ws2, 'S.ws 不能被旧定时器换掉');
  assert.equal(S.wsReady, true, '新连接就绪状态不能被旧定时器打回 false');
});

await t('旧连接的迟到消息不处理，新连接的消息照常处理', async () => {
  S.session = { path: 'p-ev', sessionId: 's-ev', title: '事件隔离' };
  h.getEl('transcript').innerHTML = '';
  S.busy = false;
  R.turn = null;

  hana.connectWS();
  const wsA = lastSocket();
  wsA.open();
  hana.connectWS();          // 换了一条连接
  const wsB = lastSocket();
  wsB.open();
  assert.equal(S.ws, wsB);

  // A 迟到的事件：绝不能进界面
  wsA.push({ type: 'text_delta', delta: '迟到内容', sessionId: 's-ev', sessionPath: 'p-ev' });
  await h.settle(4);
  assert.equal(S.busy, false, '旧连接迟到的事件不能把界面推进生成态');
  assert.ok(!transcriptText().includes('迟到内容'), `旧连接的事件不能渲染，实际：${transcriptText()}`);

  // 新连接的事件照常处理（正向对照）
  wsB.push({ type: 'text_delta', delta: '正常内容', sessionId: 's-ev', sessionPath: 'p-ev' });
  await h.settle(4);
  assert.equal(S.busy, true, '当前连接的事件必须正常处理');
  assert.ok(transcriptText().includes('正常内容'), '当前连接的消息应渲染出来');
  S.busy = false;
  R.turn = null;
});

await t('旧连接的 error 不能把新连接标成断线', async () => {
  S.session = { path: 'p-dot', sessionId: 's-dot', title: '指示灯' };
  hana.connectWS();
  const wsA = lastSocket();
  wsA.open();
  hana.connectWS();
  const wsB = lastSocket();
  wsB.open();

  const dot = h.getEl('connDot');
  assert.equal(dot.className, 'dot on', '夹具：新连接就绪时指示灯应是亮的');

  wsA.dispatch('error');
  assert.equal(dot.className, 'dot on', '旧连接的错误不能改当前连接的指示灯');
});

await t('回到列表 / 退出登录后，定时器与旧连接事件全部作废', async () => {
  S.session = { path: 'p-back', sessionId: 's-back', title: '退回列表' };
  S.wsReady = false;
  hana.connectWS();
  const ws1 = lastSocket();
  ws1.open();
  S.reconnectDelay = 25;
  ws1.serverClose();     // 排一个重连
  const base = h.MockWebSocket.instances.length;

  h.getEl('view-chat').hidden = false;
  hana.backToList();
  assert.equal(S.session, null, '夹具：已退回列表');

  await h.delay(140);
  assert.equal(h.MockWebSocket.instances.length, base, '会话都退出了，不能再偷偷重连');
});

await t('createWebsocketClient: getSession 为空但 shouldReconnect 为 true 时，掉线后重连定时器必须成功触发重连', async () => {
  const dummyState = { ws: null, wsReady: false, reconnectDelay: 20 };
  let allowReconnect = true;
  let socketCount = 0;
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeSocket.OPEN;
      this.listeners = new Map();
      socketCount += 1;
    }
    addEventListener(type, cb) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(cb);
    }
    close() { this.readyState = 3; }
    fire(type) { for (const cb of this.listeners.get(type) || []) cb({}); }
  }

  const client = createWebsocketClient({
    state: dummyState,
    getSession: () => null, // 没有会话（例如在主页纯闲聊）
    shouldReconnect: () => allowReconnect,
    getWebSocket: () => FakeSocket,
    getLocation: () => ({ protocol: 'http:', host: 'localhost:24000' }),
  });

  client.connect();
  assert.equal(socketCount, 1, '初次连接建立 1 个 socket');
  dummyState.ws.fire('open');
  assert.equal(client.isReady(), true);

  // 连上后 open 回调会把 reconnectDelay 重设回 800ms，这里在掉线前设成 20ms 便于单测
  dummyState.reconnectDelay = 20;
  dummyState.ws.fire('close');
  assert.equal(client.isReady(), false);

  // 等待定时器执行
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(socketCount, 2, 'shouldReconnect 为 true 时定时器唤醒必须建立新连接');
});

await t('createWebsocketClient: shouldReconnect 为 false 时，掉线后重连定时器绝不发起新连接', async () => {
  const dummyState = { ws: null, wsReady: false, reconnectDelay: 20 };
  let allowReconnect = false;
  let socketCount = 0;
  class FakeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeSocket.OPEN;
      this.listeners = new Map();
      socketCount += 1;
    }
    addEventListener(type, cb) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(cb);
    }
    close() { this.readyState = 3; }
    fire(type) { for (const cb of this.listeners.get(type) || []) cb({}); }
  }

  const client = createWebsocketClient({
    state: dummyState,
    getSession: () => null,
    shouldReconnect: () => allowReconnect,
    getWebSocket: () => FakeSocket,
    getLocation: () => ({ protocol: 'http:', host: 'localhost:24000' }),
  });

  client.connect();
  assert.equal(socketCount, 1);
  dummyState.ws.fire('open');

  // 手动触发一次 scheduleReconnect
  client.scheduleReconnect(20);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(socketCount, 1, 'shouldReconnect 为 false 时定时器唤醒不得发起连接');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
