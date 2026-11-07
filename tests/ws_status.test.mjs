/* tests/ws_status.test.mjs — E9 用的 onStatusChange 状态回调
 *
 * 目的：断线细条（connection-banner）只能靠「连接层报出来的事实」决定显示什么，
 * 所以 websocket-client 必须把 connecting / connected / reconnecting / closed 报出来。
 *
 * 这份用例锁三件事：
 *   1. 四种状态的触发点与顺序（含「会重连」与「不会重连」的分叉）；
 *   2. 旧代次连接的迟到事件不产生状态——否则旧连接的 close 会把刚连上的新连接
 *      报成断线，细条就会乱闪；
 *   3. 新回调不改变原有事件：onReadyChange / onOpen / onMessage / onError 的相对顺序与次数
 *      跟改动前一致。
 */

import assert from 'node:assert/strict';
import { createWebsocketClient } from '../web/websocket-client.js';

class FakeSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;              // CONNECTING
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  fire(type, extra = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this, ...extra });
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.fire('open');
  }

  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }

  /** 页面主动关闭：代次已经作废，真实现里也不会再派发 close。 */
  close() {
    this.readyState = 3;
  }

  /** 服务端/网络掉线。 */
  serverClose() {
    this.readyState = 3;
    this.fire('close');
  }

  push(payload) {
    this.fire('message', { data: JSON.stringify(payload) });
  }
}

const last = () => FakeSocket.instances.at(-1);

function makeClient({ shouldReconnect = () => true, reconnectDelay = 800 } = {}) {
  const events = [];
  const state = { ws: null, wsReady: false, reconnectDelay, pendingAbort: null, session: null };
  const records = { messages: [], errors: 0 };
  const client = createWebsocketClient({
    state,
    getSession: () => null,               // 没有会话：重连与否完全由 shouldReconnect 决定
    shouldReconnect,
    getWebSocket: () => FakeSocket,
    getLocation: () => ({ protocol: 'http:', host: 'localhost:24000' }),
    onStatusChange: (status) => events.push(`status:${status}`),
    onReadyChange: (ready) => events.push(`ready:${ready}`),
    onOpen: () => events.push('open'),
    onError: () => { records.errors += 1; },
    onMessage: (data) => records.messages.push(data),
  });
  return { client, state, events, records };
}

let failed = 0;

function test(name, run) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

async function testAsync(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* ---------------------------------------------------------------- */

test('connect → connecting；open → connected，且原有回调顺序不变', () => {
  const { client, events } = makeClient();
  client.connect();
  assert.deepEqual(events, ['status:connecting'], '建连接时应只报 connecting');

  last().open();
  assert.deepEqual(
    events,
    ['status:connecting', 'ready:true', 'status:connected', 'open'],
    `状态回调不能打乱 onReadyChange → onOpen 的相对顺序，实际：${events.join(' | ')}`,
  );
  client.drop();
});

test('旧代次连接的迟到 open 不产生 connected', () => {
  const { client, state, events } = makeClient();
  client.connect();
  const first = last();
  client.connect();                        // 换了一条连接（切会话 / 回前台）
  const second = last();
  assert.equal(events.filter((e) => e === 'status:connecting').length, 2, '夹具：应有两次建连接');

  first.open();                            // 旧连接迟到
  assert.equal(events.includes('status:connected'), false, '旧连接的 open 不能报 connected');
  assert.equal(state.ws, second, '夹具：当前连接应是新的那条');

  second.open();
  assert.deepEqual(
    events.slice(-3),
    ['ready:true', 'status:connected', 'open'],
    `新连接照常报 connected，实际：${events.join(' | ')}`,
  );
  client.drop();
});

test('掉线且会重连：先 ready:false 再 reconnecting', () => {
  const { client, state, events } = makeClient({ reconnectDelay: 5 });
  client.connect();
  last().open();
  events.length = 0;

  state.reconnectDelay = 5;
  last().serverClose();
  assert.deepEqual(
    events,
    ['ready:false', 'status:reconnecting'],
    `掉线应先报未就绪再报重连中，实际：${events.join(' | ')}`,
  );
  client.drop();                           // 清掉排队中的重连定时器
  assert.equal(events.at(-1), 'status:closed', 'drop 应报 closed');
});

test('connect 替换已就绪连接：先 ready:false 再 connecting', () => {
  const { client, state, events } = makeClient();
  client.connect();
  last().open();
  events.length = 0;

  client.connect();                 // 切会话 / 回前台：旧连接要被替换
  assert.equal(state.wsReady, false, '替换连接时必须立刻标记未就绪');
  assert.deepEqual(
    events,
    ['ready:false', 'status:connecting'],
    `替换连接应先报未就绪再报 connecting，实际：${events.join(' | ')}`,
  );

  last().open();
  assert.equal(state.wsReady, true);
  assert.deepEqual(
    events.slice(-3),
    ['ready:true', 'status:connected', 'open'],
    `新连接 open 后才报就绪，实际：${events.join(' | ')}`,
  );
  client.drop();
});

test('drop 已就绪连接：先 ready:false 再 closed', () => {
  const { client, state, events } = makeClient();
  client.connect();
  last().open();
  events.length = 0;

  client.drop();
  assert.equal(state.wsReady, false);
  assert.deepEqual(events, ['ready:false', 'status:closed'], `主动收摊也必须通知界面断开，实际：${events.join(' | ')}`);
});

test('未就绪时 connect/drop 不额外报 ready:false', () => {
  const { client, events } = makeClient();
  client.connect();
  events.length = 0;

  client.connect();
  assert.deepEqual(events, ['status:connecting'], '本来就没就绪，不能重复报 ready:false');

  events.length = 0;
  client.drop();
  assert.deepEqual(events, ['status:closed'], '未就绪时 drop 只报 closed');
});

test('掉线但不会重连：报 closed，而不是 reconnecting', () => {
  const { client, events } = makeClient({ shouldReconnect: () => false, reconnectDelay: 5 });
  client.connect();
  last().open();
  events.length = 0;

  last().serverClose();
  assert.deepEqual(events, ['ready:false', 'status:closed'], '不重连时不能报「正在重连」');
});

await testAsync('drop() 报 closed，并取消排队中的重连', async () => {
  const { client, state, events } = makeClient({ reconnectDelay: 5 });
  client.connect();
  const socket = last();
  socket.open();
  socket.serverClose();                    // 排一个 5ms 的重连
  const countBefore = FakeSocket.instances.length;

  client.drop();
  assert.equal(events.at(-1), 'status:closed', 'drop 必须报 closed 收掉提示');

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(FakeSocket.instances.length, countBefore, 'drop 之后不能再偷偷建连接');
  assert.equal(state.ws, null);
});

test('drop() 之后旧连接的迟到 close 不产生任何状态', () => {
  const { client, events } = makeClient();
  client.connect();
  const socket = last();
  socket.open();
  client.drop();
  events.length = 0;

  socket.serverClose();
  assert.deepEqual(events, [], '退出/回首页后旧连接的 close 不能再报状态');
});

test('消息与报错照旧：不产生额外状态', () => {
  const { client, events, records } = makeClient();
  client.connect();
  const socket = last();
  socket.open();
  events.length = 0;

  socket.push({ type: 'text_delta', delta: '一' });
  assert.equal(records.messages.length, 1, '消息必须照旧分发');
  assert.equal(records.messages[0].type, 'text_delta');

  socket.fire('error');
  assert.equal(records.errors, 1, 'error 必须照旧回调 onError');
  assert.deepEqual(events, [], 'error 单独出现不算断线，不能报状态');
  client.drop();
});

await testAsync('onStatusChange 抛异常也不影响连接建立与原有回调', async () => {
  const state = { ws: null, wsReady: false, reconnectDelay: 800, pendingAbort: null, session: null };
  const events = [];
  const client = createWebsocketClient({
    state,
    getSession: () => null,
    getWebSocket: () => FakeSocket,
    getLocation: () => ({ protocol: 'http:', host: 'localhost:24000' }),
    onStatusChange: () => { throw new Error('细条自己炸了'); },
    onReadyChange: (ready) => events.push(`ready:${ready}`),
    onOpen: () => events.push('open'),
  });

  assert.doesNotThrow(() => client.connect(), 'connect 不能被状态回调的异常带崩');
  assert.doesNotThrow(() => last().open(), 'open 不能被状态回调的异常带崩');
  assert.deepEqual(events, ['ready:true', 'open'], '原有回调仍要按顺序执行');
  assert.equal(state.wsReady, true);
  client.drop();
});

if (failed > 0) {
  console.log(`\n${failed} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
