/* tests/native_bridge_share.test.mjs — 分享下行 + 屏幕常亮开关的桥协议测试
 *
 * 这条通道无设备可跑：真机上的 WebView 会把端口投到主 frame 的 window 上，
 * 这里用一个假 window 复现同一件事（dispatch 一条带 ports 的 message 事件），
 * 断言的是**我们自己那份协议**，不含真实 Android 行为：
 *
 * 1. onShare 注册之前收到的分享要缓存（最多 1 条，后来的覆盖先来的），
 *    注册之后立即投递一次，且不会重复回放、重复注册互不影响、取消订阅后不再触发；
 * 2. 下行 share 的单独校验：kind 必须是 text、text 必须是字符串、字段只取 text / title，
 *    超长（> 16384）整条丢、版本不符丢、非 share 下行不触发 handler；
 * 3. 文本与标题都按 8000 截断、去控制字符（保留换行）；
 * 4. setKeepScreenOn 的报文形状 {v:1,action:'screen',on}，非法值不发报文，
 *    没有原生壳时返回 false 而不是抛错。
 *
 * 全部用例都是事件驱动（握手事件直接 dispatch、端口消息直接 emit），
 * 不靠固定 sleep 等状态。每个用例结束都 dispose，不留悬挂定时器。
 *
 * 注意：新用例必须写在下方的收尾统计之前——写在后面等于永远不会执行。
 */

import assert from 'node:assert/strict';
import {
  createNativeBridge,
  SHARE_TEXT_MAX,
} from '../web/native-bridge.js';

const ORIGIN = 'https://app.example';
const HELLO = '{"v":1,"bridge":"hana-native","max":2048}';
/** 下行报文的字符上限（协议常量，故意在测试里写死一份：改了必须有人确认）。 */
const INBOUND_MAX = 16384;

let total = 0;
let bad = 0;
async function t(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${String(err?.stack || err?.message || err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 夹具：假 window + 假端口                                             */
/* ------------------------------------------------------------------ */

function fakeWindow(origin = ORIGIN) {
  const listeners = new Map();
  return {
    location: { origin },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchMessage(event) {
      for (const fn of [...(listeners.get('message') || [])]) fn(event);
    },
  };
}

function fakePort() {
  const port = {
    sent: [],
    onmessage: null,
    started: false,
    closed: false,
    postMessage(data) {
      if (port.closed) throw new Error('端口已关闭');
      port.sent.push(data);
    },
    start() {
      port.started = true;
    },
    close() {
      port.closed = true;
    },
    /** 模拟「原生 → 页面」的一条消息。 */
    emit(data) {
      port.onmessage?.({ data });
    },
  };
  return port;
}

function helloEvent(win, port) {
  return { type: 'message', origin: ORIGIN, data: HELLO, ports: [port], source: win };
}

/** 握手已经完成的桥（端口已被页面接管），再加一个假原生端口好往里 emit。 */
function kit(overrides = {}) {
  const win = fakeWindow();
  const port = fakePort();
  const bridge = createNativeBridge({
    window: win,
    expectedOrigin: ORIGIN,
    handshakeTimeoutMs: 50,
    ...overrides,
  });
  win.dispatchMessage(helloEvent(win, port));
  return { win, port, bridge };
}

/** 原生会发出来的那种下行 share 报文。 */
function shareMessage(text, title = '') {
  return JSON.stringify({ v: 1, action: 'share', kind: 'text', text, title });
}

/**
 * 把已排队的微任务跑完。这不是 sleep：这里等的是 Promise 链（await ready 的续体），
 * 不是时间；固定 setTimeout 既慢又不稳。
 */
async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* 1. onShare：注册前缓存、注册后立即投递一次                            */
/* ------------------------------------------------------------------ */

await t('注册之前收到的分享会缓存，onShare 注册后立即投递一次', async () => {
  const { port, bridge } = kit();
  try {
    // 顺序和真机一样：页面先接管端口并回 hello，原生这时就把分享投下来了，
    // 但 app.js 还没接线（onShare 还没调）——这条必须留着。
    port.emit(shareMessage('第一段\n第二段', '来源标题'));
    const seen = [];
    const off = bridge.onShare((share) => seen.push(share));
    assert.equal(seen.length, 1, '注册后应立刻收到缓存的那一条');
    assert.deepEqual(seen[0], { text: '第一段\n第二段', title: '来源标题' });
    off();
  } finally {
    bridge.dispose();
  }
});

await t('缓存只投一次：再注册一个订阅者不会回放同一条', async () => {
  const { port, bridge } = kit();
  try {
    port.emit(shareMessage('只该出现一次'));
    const first = [];
    const second = [];
    bridge.onShare((share) => first.push(share.text));
    bridge.onShare((share) => second.push(share.text));
    assert.deepEqual(first, ['只该出现一次']);
    assert.deepEqual(second, [], '缓存已经投递过，不该重复回放');
  } finally {
    bridge.dispose();
  }
});

await t('注册前的缓存最多 1 条：后来的覆盖先来的', async () => {
  const { port, bridge } = kit();
  try {
    port.emit(shareMessage('旧的'));
    port.emit(shareMessage('新的'));
    const seen = [];
    bridge.onShare((share) => seen.push(share.text));
    assert.deepEqual(seen, ['新的']);
  } finally {
    bridge.dispose();
  }
});

await t('有订阅者时立即投递，不进缓存（不会事后重复回放）', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    let off = bridge.onShare((share) => seen.push(share.text));
    port.emit(shareMessage('立刻'));
    assert.deepEqual(seen, ['立刻']);
    off();
    off = bridge.onShare((share) => seen.push(share.text));
    assert.deepEqual(seen, ['立刻'], '重新注册时没有缓存可回放');
    off();
  } finally {
    bridge.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 2. onShare：订阅的取消与重复注册                                      */
/* ------------------------------------------------------------------ */

await t('重复注册互不影响：取消旧订阅不会摘掉顶替它的新订阅', async () => {
  const { port, bridge } = kit();
  try {
    const first = [];
    const second = [];
    const offFirst = bridge.onShare((share) => first.push(share.text));
    const offSecond = bridge.onShare((share) => second.push(share.text));
    offFirst();                       // 旧的已经被顶替，取消它不该影响新的
    port.emit(shareMessage('A'));
    assert.deepEqual(second, ['A'], '新的订阅应该照收');
    assert.deepEqual(first, [], '被顶替的订阅不该再收到');
    offSecond();
  } finally {
    bridge.dispose();
  }
});

await t('取消订阅后不再触发 handler，重复取消也不报错', async () => {
  const { port, bridge } = kit();
  try {
    let calls = 0;
    const off = bridge.onShare(() => {
      calls += 1;
    });
    port.emit(shareMessage('一次'));
    assert.equal(calls, 1);
    off();
    off();                            // 重复取消：幂等
    port.emit(shareMessage('两次'));
    assert.equal(calls, 1, '取消之后不该再收到');
  } finally {
    bridge.dispose();
  }
});

await t('handler 抛错不会弄坏桥：下一条照常投递', async () => {
  const { port, bridge } = kit();
  const realWarn = console.warn;
  console.warn = () => {};            // 预期内的告警，别混进测试输出
  try {
    let calls = 0;
    bridge.onShare(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });
    port.emit(shareMessage('1'));
    port.emit(shareMessage('2'));
    assert.equal(calls, 2);
  } finally {
    console.warn = realWarn;
    bridge.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 下行 share 的单独校验                                             */
/* ------------------------------------------------------------------ */

await t('超过下行上限（16384）的报文被整条丢弃，不截半条给页面', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    const huge = shareMessage('x'.repeat(INBOUND_MAX + 2000));
    assert.ok(huge.length > INBOUND_MAX, '用例前提：报文确实超长');
    port.emit(huge);
    assert.equal(seen.length, 0);
  } finally {
    bridge.dispose();
  }
});

await t('版本不符（v:2）的分享被丢弃', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    port.emit(JSON.stringify({ v: 2, action: 'share', kind: 'text', text: '不该到页面' }));
    port.emit(JSON.stringify({ action: 'share', kind: 'text', text: '缺 v 也不行' }));
    assert.equal(seen.length, 0);
  } finally {
    bridge.dispose();
  }
});

await t('share 报文超过旧的 2048 上限时仍然收下（这正是放宽到 16384 的理由）', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share.text));
    const longText = 'a'.repeat(4000);
    const payload = shareMessage(longText);
    assert.ok(payload.length > 2048 && payload.length < INBOUND_MAX, '用例前提：报文在 2048 与 16384 之间');
    port.emit(payload);
    assert.deepEqual(seen, [longText], '4000 字的正文应该原样到页面（没到 8000 不用截）');
  } finally {
    bridge.dispose();
  }
});

await t('权限回执沿用旧的 2048 上限：3KB 的回执仍被丢弃（等到回执超时）', async () => {
  const { port, bridge } = kit({ permissionReplyTimeoutMs: 30 });
  try {
    const pending = bridge.requestPermission();
    await flushMicrotasks();
    const outbound = JSON.parse(port.sent.at(-1));
    assert.equal(outbound.action, 'requestPermission');
    port.emit('{"v":1,"reply":"permission","id":"' + outbound.id + '","status":"granted"}' + ' '.repeat(3000));
    assert.equal(await pending, 'unknown', '超长回执不能被当成 granted');
  } finally {
    bridge.dispose();
  }
});

await t('非 share 下行不触发 handler（权限回执 / 通知 / 卡片消息都不算）', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    port.emit(JSON.stringify({ v: 1, reply: 'permission', id: 'p1', status: 'granted' }));
    port.emit(JSON.stringify({ v: 1, action: 'notify', title: 'Hana', body: '完成' }));
    port.emit(JSON.stringify({ v: 1, hello: true }));
    port.emit('{"type":"card"}');
    port.emit('这不是 json');
    port.emit(null);
    assert.equal(seen.length, 0);
  } finally {
    bridge.dispose();
  }
});

await t('share 单独校验：kind 必须是 text，text 必须是字符串', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    port.emit(JSON.stringify({ v: 1, action: 'share', kind: 'text', text: 42 }));
    port.emit(JSON.stringify({ v: 1, action: 'share', kind: 'text' }));
    port.emit(JSON.stringify({ v: 1, action: 'share', kind: 'image', text: '图不接' }));
    port.emit(JSON.stringify({ v: 1, action: 'share', text: '缺 kind' }));
    port.emit(JSON.stringify({ v: 1, action: 'share', kind: 'text', text: '   ' }));
    assert.equal(seen.length, 0);
  } finally {
    bridge.dispose();
  }
});

await t('文本与标题都按 8000 截断、去控制字符但保留换行', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    const text = 'a\r\nb\tc\u0007\u0000\u009f' + '字'.repeat(SHARE_TEXT_MAX);
    const title = 'T'.repeat(SHARE_TEXT_MAX + 50);
    port.emit(shareMessage(text, title));
    assert.equal(seen.length, 1);
    const share = seen[0];
    assert.equal(share.text.length, SHARE_TEXT_MAX, '正文按上限截断，不整条丢');
    assert.ok(share.text.startsWith('a\nb c'), `换行要保留、制表符当空格：${JSON.stringify(share.text.slice(0, 8))}`);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(share.text), '不该带控制字符到页面');
    assert.equal(share.title.length, SHARE_TEXT_MAX);
  } finally {
    bridge.dispose();
  }
});

await t('报文里只取 text / title，多余字段不会被用上', async () => {
  const { port, bridge } = kit();
  try {
    const seen = [];
    bridge.onShare((share) => seen.push(share));
    port.emit(JSON.stringify({
      v: 1, action: 'share', kind: 'text', text: '正文', title: '标题',
      url: 'https://evil.example', html: '<b>x</b>', run: 'anything',
    }));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { text: '正文', title: '标题' });
    assert.deepEqual(Object.keys(seen[0]).sort(), ['text', 'title']);
  } finally {
    bridge.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 4. setKeepScreenOn                                                   */
/* ------------------------------------------------------------------ */

await t('setKeepScreenOn 的报文形状是 {v:1,action:"screen",on}', async () => {
  const { port, bridge } = kit();
  try {
    assert.equal(await bridge.setKeepScreenOn(true), true);
    assert.deepEqual(JSON.parse(port.sent.at(-1)), { v: 1, action: 'screen', on: true });
    assert.equal(await bridge.setKeepScreenOn(false), true);
    assert.deepEqual(JSON.parse(port.sent.at(-1)), { v: 1, action: 'screen', on: false });
  } finally {
    bridge.dispose();
  }
});

await t('非法 on 值一律不发报文（一个手滑的 0 不能变成关灯）', async () => {
  const { port, bridge } = kit();
  try {
    const before = port.sent.length;
    for (const invalid of ['true', 'false', 1, 0, null, undefined, {}, []]) {
      assert.equal(await bridge.setKeepScreenOn(invalid), false, `非法值应返回 false：${String(invalid)}`);
    }
    assert.equal(port.sent.length, before, '非法值不该产生任何上行报文');
  } finally {
    bridge.dispose();
  }
});

await t('没有原生壳时 setKeepScreenOn 返回 false，不抛错', async () => {
  // 连 addEventListener 都没有：立刻判定没有原生，不会等握手超时
  const bridge = createNativeBridge({ window: {}, expectedOrigin: ORIGIN, handshakeTimeoutMs: 20 });
  try {
    assert.equal(bridge.available, false);
    assert.equal(await bridge.setKeepScreenOn(true), false);
    assert.equal(await bridge.setKeepScreenOn(false), false);
    // onShare 在没有原生时也要能安全注册 / 取消
    const off = bridge.onShare(() => {});
    assert.equal(typeof off, 'function');
    assert.equal(off(), undefined);
    // 非函数 handler 不该炸
    assert.equal(typeof bridge.onShare(null), 'function');
  } finally {
    bridge.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 5. dispose                                                          */
/* ------------------------------------------------------------------ */

await t('dispose 会清掉订阅与缓存：之后注册收不到那条，端口也不再投递', async () => {
  const { port, bridge } = kit();
  try {
    port.emit(shareMessage('还没人收'));       // 进缓存
  } catch (err) {
    bridge.dispose();
    throw err;
  }
  bridge.dispose();
  const seen = [];
  bridge.onShare((share) => seen.push(share.text));
  port.emit(shareMessage('dispose 之后'));
  assert.deepEqual(seen, [], 'dispose 之后既不该回放缓存，也不该再收新消息');
  assert.equal(bridge.available, false);
});

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

if (bad > 0) {
  console.log(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log(`\nALL PASS（${total} 个用例）`);
}
