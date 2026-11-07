/* tests/notifications.test.mjs — 「一轮答完了」的通知判定与权限状态机
 *
 * 这一层只做判断，不碰原生也不碰 DOM：notify() / requestPermission() / isForeground()
 * 全是注入的。所以 node 里可以完整验一遍真机上最容易出岔子的那几条：
 *
 * 1. 该发的：后台 + 正常跑完，标题是助手名，正文只说「回复已完成」（不塞正文摘要）；
 * 2. 不该发的：前台（人正看着）、aborted（用户自己停的）、同一 sessionId+streamId 重复；
 * 3. truncated（stopReason:"length" 转过来的）另有文案；
 * 4. 权限状态机：granted / denied / unsupported 之后都不再请求；
 * 5. 没有桥（桌面浏览器）时安静降级，绝不抛错——event-router 是同步调用，
 *    这里漏一个 rejection 就变成页面顶上的未捕获异常横幅。
 */

import assert from 'node:assert/strict';
import { createNotifications, BODY_DONE, BODY_TRUNCATED } from '../web/notifications.js';

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

/**
 * 一套夹具：记录发出去的通知与权限请求次数。
 * clock 可手动推进，用来验「没有 streamId 时的时间窗去重」和「权限没结论时的退避」。
 */
function setup({
  foreground = false,
  permission = 'granted',
  notifyImpl = null,
  requestImpl = null,
  agentName = 'Hana',
} = {}) {
  const sent = [];
  const calls = { permission: 0 };
  let clock = 1_000_000;
  const notifications = createNotifications({
    notify: notifyImpl || ((title, body) => {
      sent.push({ title, body });
      return true;
    }),
    requestPermission: requestImpl || (async () => {
      calls.permission += 1;
      return permission;
    }),
    isForeground: () => foreground,
    agentName,
    now: () => clock,
  });
  return {
    notifications,
    sent,
    calls,
    advance(ms) { clock += ms; },
  };
}

const turn = (overrides = {}) => ({
  sessionId: 's-1',
  sessionPath: 'C:/sessions/one',
  streamId: 'stream-1',
  aborted: false,
  truncated: false,
  ...overrides,
});

/* ------------------------------------------------------------------ */
/* 1. 该发的                                                           */
/* ------------------------------------------------------------------ */

await t('后台 + 正常跑完：发一条，标题助手名，正文只说「回复已完成」', async () => {
  const { notifications, sent } = setup();
  assert.equal(await notifications.onTurnEnd(turn()), 'sent');
  assert.deepEqual(sent, [{ title: 'Hana', body: BODY_DONE }]);
  assert.equal(BODY_DONE, '回复已完成');
});

await t('正文里不带任何回复内容（锁屏可见，不能泄内容）', async () => {
  const { notifications, sent } = setup();
  // 就算上游多塞了字段进来，也不该出现在通知里
  await notifications.onTurnEnd(turn({ text: '这是很长的一段回复正文', summary: '摘要' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, BODY_DONE);
  assert.ok(!sent[0].body.includes('回复正文'));
});

await t('助手名可以是取值函数（换了角色后标题跟着变）', async () => {
  let name = 'Hana';
  const sent = [];
  const notifications = createNotifications({
    notify: (title, body) => { sent.push({ title, body }); return true; },
    requestPermission: async () => 'granted',
    isForeground: () => false,
    agentName: () => name,
  });
  await notifications.onTurnEnd(turn());
  name = '小花';
  await notifications.onTurnEnd(turn({ streamId: 'stream-2' }));
  assert.deepEqual(sent.map((item) => item.title), ['Hana', '小花']);
});

await t('助手名拿不到时退回默认值，不会发出空标题', async () => {
  const { notifications, sent } = setup({ agentName: '   ' });
  await notifications.onTurnEnd(turn());
  assert.equal(sent[0].title, 'Hana');
});

/* ------------------------------------------------------------------ */
/* 2. 不该发的                                                         */
/* ------------------------------------------------------------------ */

await t('前台不发：人正看着屏幕，连权限都不问', async () => {
  const { notifications, sent, calls } = setup({ foreground: true });
  assert.equal(await notifications.onTurnEnd(turn()), 'skipped-foreground');
  assert.equal(sent.length, 0);
  assert.equal(calls.permission, 0, '前台不发时没必要要权限');
});

await t('aborted 不发：用户自己按的停止', async () => {
  const { notifications, sent, calls } = setup();
  assert.equal(await notifications.onTurnEnd(turn({ aborted: true })), 'skipped-aborted');
  assert.equal(sent.length, 0);
  assert.equal(calls.permission, 0);
});

await t('同一 sessionId+streamId 只发一次（stream_turn_end 与 turn_end 都会到）', async () => {
  const { notifications, sent } = setup();
  assert.equal(await notifications.onTurnEnd(turn()), 'sent');
  assert.equal(await notifications.onTurnEnd(turn({ type: 'turn_end' })), 'skipped-duplicate');
  assert.equal(sent.length, 1);
});

await t('去重先于前台判断：同一轮在前面被前台挡掉，切后台后也不会补发', async () => {
  let foreground = true;
  const sent = [];
  const notifications = createNotifications({
    notify: (title, body) => { sent.push({ title, body }); return true; },
    requestPermission: async () => 'granted',
    isForeground: () => foreground,
  });
  assert.equal(await notifications.onTurnEnd(turn()), 'skipped-foreground');
  foreground = false;
  assert.equal(await notifications.onTurnEnd(turn()), 'skipped-duplicate');
  assert.equal(sent.length, 0);
});

await t('不同会话的同一个 streamId 各算一轮', async () => {
  const { notifications, sent } = setup();
  await notifications.onTurnEnd(turn({ sessionId: 's-1', streamId: 'same' }));
  await notifications.onTurnEnd(turn({ sessionId: 's-2', sessionPath: 'C:/sessions/two', streamId: 'same' }));
  assert.equal(sent.length, 2);
});

await t('没有 streamId 时退到 seq 去重', async () => {
  const { notifications, sent } = setup();
  await notifications.onTurnEnd(turn({ streamId: undefined, seq: 7 }));
  await notifications.onTurnEnd(turn({ streamId: undefined, seq: 7 }));
  assert.equal(sent.length, 1);
});

await t('streamId 与 seq 都没有时靠时间窗挡重复', async () => {
  const { notifications, sent, advance } = setup();
  await notifications.onTurnEnd({ sessionPath: 'C:/sessions/one' });
  await notifications.onTurnEnd({ sessionPath: 'C:/sessions/one' });
  assert.equal(sent.length, 1);
  advance(2000);
  await notifications.onTurnEnd({ sessionPath: 'C:/sessions/one' });
  assert.equal(sent.length, 2, '过了时间窗就是新一轮');
});

await t('空 / 非对象的事件安静忽略', async () => {
  const { notifications, sent } = setup();
  assert.equal(await notifications.onTurnEnd(null), 'ignored');
  assert.equal(await notifications.onTurnEnd('stream_turn_end'), 'ignored');
  assert.equal(sent.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3. truncated：文案另写                                              */
/* ------------------------------------------------------------------ */

await t('truncated 用另一句文案（说清楚可能没写完）', async () => {
  const { notifications, sent } = setup();
  await notifications.onTurnEnd(turn({ truncated: true }));
  assert.deepEqual(sent, [{ title: 'Hana', body: BODY_TRUNCATED }]);
  assert.notEqual(BODY_TRUNCATED, BODY_DONE);
  assert.ok(BODY_TRUNCATED.includes('截断'));
});

/* ------------------------------------------------------------------ */
/* 4. 权限状态机                                                       */
/* ------------------------------------------------------------------ */

await t('granted 之后只请求一次', async () => {
  const { notifications, sent, calls } = setup({ permission: 'granted' });
  assert.equal(notifications.permissionState(), 'unknown');
  await notifications.onTurnEnd(turn({ streamId: 'a' }));
  await notifications.onTurnEnd(turn({ streamId: 'b' }));
  assert.equal(calls.permission, 1);
  assert.equal(notifications.permissionState(), 'granted');
  assert.equal(sent.length, 2);
});

await t('denied 之后不再请求，也不再发', async () => {
  const { notifications, sent, calls } = setup({ permission: 'denied' });
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'a' })), 'skipped-permission');
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'b' })), 'skipped-permission');
  assert.equal(calls.permission, 1);
  assert.equal(notifications.permissionState(), 'denied');
  assert.equal(sent.length, 0);
});

await t('unsupported（桌面浏览器 / 没有原生桥）之后不再请求，结果记成 unsupported', async () => {
  const { notifications, sent, calls } = setup({ permission: 'unsupported' });
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'a' })), 'unsupported');
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'b' })), 'unsupported');
  assert.equal(calls.permission, 1);
  assert.equal(notifications.permissionState(), 'unsupported');
  assert.equal(sent.length, 0);
});

await t('权限请求同时只发一次（两轮前后脚结束时也只有一个请求）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  let asked = 0;
  const notifications = createNotifications({
    notify: (title, body) => { sent.push({ title, body }); return true; },
    requestPermission: () => { asked += 1; return gate; },
    isForeground: () => false,
  });
  const first = notifications.onTurnEnd(turn({ streamId: 'a' }));
  const second = notifications.onTurnEnd(turn({ streamId: 'b' }));
  release('granted');
  assert.deepEqual(await Promise.all([first, second]), ['sent', 'sent']);
  assert.equal(asked, 1);
  assert.equal(sent.length, 2);
});

await t('权限没结论（unknown）时退避一分钟再问，不每轮都弹', async () => {
  const { notifications, sent, calls, advance } = setup({ permission: 'unknown' });
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'a' })), 'skipped-permission');
  assert.equal(await notifications.onTurnEnd(turn({ streamId: 'b' })), 'skipped-permission');
  assert.equal(calls.permission, 1, '退避期内不该再问');
  assert.equal(notifications.permissionState(), 'unknown');
  assert.equal(sent.length, 0);
  advance(61_000);
  await notifications.onTurnEnd(turn({ streamId: 'c' }));
  assert.equal(calls.permission, 2, '过了退避期可以再问一次');
});

await t('权限请求抛错当成 unsupported，不把异常漏出去', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};   // 这条用例故意让它报错，测试里不刷屏
  try {
    const { notifications } = setup({
      requestImpl: async () => { throw new Error('桥断了'); },
    });
    assert.equal(await notifications.onTurnEnd(turn()), 'unsupported');
    assert.equal(notifications.permissionState(), 'unsupported');
  } finally {
    console.warn = originalWarn;
  }
});

/* ------------------------------------------------------------------ */
/* 5. 没有桥 / 桥出错：安静降级                                        */
/* ------------------------------------------------------------------ */

await t('全默认参数（没有原生桥）时安静降级，不报错、不发送', async () => {
  const notifications = createNotifications({ isForeground: () => false });
  assert.equal(await notifications.onTurnEnd(turn()), 'unsupported');
  assert.equal(notifications.permissionState(), 'unsupported');
  // 没有 document 的 node 环境里，默认 isForeground 也不该抛错
  const bare = createNotifications({});
  assert.equal(typeof (await bare.onTurnEnd(turn())), 'string');
});

await t('notify 抛错只是没发出去，onTurnEnd 仍然 resolve', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { notifications } = setup({
      notifyImpl: () => { throw new Error('端口死了'); },
    });
    assert.equal(await notifications.onTurnEnd(turn()), 'skipped-bridge');
  } finally {
    console.warn = originalWarn;
  }
});

await t('notify 返回 false 也算没发出去', async () => {
  const { notifications } = setup({ notifyImpl: () => false });
  assert.equal(await notifications.onTurnEnd(turn()), 'skipped-bridge');
});

await t('reset() 清干净：同样的 streamId 可以重新判定', async () => {
  const { notifications, sent } = setup();
  await notifications.onTurnEnd(turn());
  await notifications.onTurnEnd(turn());
  assert.equal(sent.length, 1);
  notifications.reset();
  assert.equal(notifications.permissionState(), 'unknown');
  await notifications.onTurnEnd(turn());
  assert.equal(sent.length, 2);
});

/* ------------------------------------------------------------------ */
/* 6. 和 event-router 的注入口接上（真模块，边界是桩）                    */
/* ------------------------------------------------------------------ */

const { createEventRouter } = await import('../web/event-router.js');

/** 最小的路由：只在收尾那一支上装点记录动作，其余用桩。 */
function bootRouter({ onTurnEnd = null } = {}) {
  const order = [];
  const state = {
    session: { sessionId: 's-1', path: 'C:/sessions/one' },
    sentInputs: new Set(),
    lastLocalUser: null,
    busy: false,
  };
  const router = createEventRouter({
    state,
    getElement: () => null,
    renderer: {
      markTurnEnd: () => order.push('markTurnEnd'),
      finishTurn: () => order.push('finishTurn'),
    },
    sockets: { requestContextUsage: () => order.push('contextUsage') },
    streamState: { observe() {}, reset: () => order.push('reset') },
    flash: () => {},
    setBusy: () => {},
    loadSessions: async () => {},
    loadHistory: async () => {},
    chatSubtitle: () => '',
    onTurnEnd: onTurnEnd
      ? (info) => {
        order.push('onTurnEnd');
        onTurnEnd(info);
      }
      : null,
  });
  return { router, order };
}

await t('stream_turn_end 只记段信息、不发通知；整轮结束（session_status:false）才发，且带的是那段的字段', async () => {
  const got = [];
  const { router, order } = bootRouter({ onTurnEnd: (info) => got.push(info) });
  router.handleEvent({
    type: 'stream_turn_end',
    sessionId: 's-1',
    sessionPath: 'C:/sessions/one',
    streamId: 'stream-9',
    seq: 12,
  });
  assert.equal(got.length, 0, '一段流结束不是整轮结束，不能发通知');
  assert.deepEqual(order, [], '也不能收尾：后面还可能有工具回合');

  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  assert.equal(got.length, 1, '整轮结束应该发一条');
  assert.deepEqual(got[0], {
    type: 'stream_turn_end',
    sessionId: 's-1',
    sessionPath: 'C:/sessions/one',
    streamId: 'stream-9',
    aborted: false,
    truncated: false,
    stopReason: null,
    seq: 12,
  });
  assert.deepEqual(order, ['onTurnEnd', 'markTurnEnd', 'finishTurn', 'contextUsage', 'reset']);
});

await t('stopReason:"length" 也算 truncated，aborted 原样带出', async () => {
  const got = [];
  const { router } = bootRouter({ onTurnEnd: (info) => got.push(info) });
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'a', stopReason: 'length' });
  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'b', aborted: true });
  router.handleEvent({ type: 'turn_end', sessionId: 's-1', streamId: 'b', aborted: true });
  assert.equal(got[0].truncated, true);
  assert.equal(got[0].stopReason, 'length');
  assert.equal(got[1].aborted, true);
  assert.equal(got[1].truncated, false);
  assert.equal(got[1].sessionPath, 'C:/sessions/one', '会话字段缺失时用当前会话补');
});

await t('回调在收尾（finishTurn）之前调，且一轮只调一次', async () => {
  const got = [];
  const { router, order } = bootRouter({ onTurnEnd: (info) => got.push(info) });
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'a' });
  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  assert.deepEqual(order, ['onTurnEnd', 'markTurnEnd', 'finishTurn', 'contextUsage', 'reset']);
  assert.equal(got.length, 1);
});

await t('不注入回调时路由行为不变（整轮结束照旧收尾）', async () => {
  const { router, order } = bootRouter();
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'a' });
  assert.deepEqual(order, [], '分段不收尾');
  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  assert.deepEqual(order, ['markTurnEnd', 'finishTurn', 'contextUsage', 'reset']);
});

await t('回调抛错不能把收尾搞断', async () => {
  const originalError = console.error;
  console.error = () => {};   // 路由会记一行，测试里不刷屏
  try {
    const { router, order } = bootRouter({ onTurnEnd: () => { throw new Error('通知挂了'); } });
    router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
    assert.deepEqual(order, ['onTurnEnd', 'markTurnEnd', 'finishTurn', 'contextUsage', 'reset']);
  } finally {
    console.error = originalError;
  }
});

await t('端到端：路由 → notifications → notify（后台一轮只发一条，分段不重复发）', async () => {
  const sent = [];
  const notifications = createNotifications({
    notify: (title, body) => { sent.push({ title, body }); return true; },
    requestPermission: async () => 'granted',
    isForeground: () => false,
    agentName: 'Hana',
  });
  const { router } = bootRouter({ onTurnEnd: (info) => { notifications.onTurnEnd(info); } });
  // 一轮回复里两个工具回合（每段都以 stream_turn_end 收尾）+ 最后整轮结束
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'stream-1' });
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'stream-1' });
  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [{ title: 'Hana', body: BODY_DONE }], '两个工具回合不能发两条通知');

  // 被截断的一轮：文案另写，仍然只一条
  router.handleEvent({ type: 'stream_turn_end', sessionId: 's-1', streamId: 'stream-2', stopReason: 'length' });
  router.handleEvent({ type: 'session_status', sessionId: 's-1', isStreaming: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent[1], { title: 'Hana', body: BODY_TRUNCATED });
  assert.equal(sent.length, 2);
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
