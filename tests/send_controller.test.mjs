/* createSendController 独立契约：竞态由 deferred 控制，不加载 app.js / DOM。 */

import assert from 'node:assert/strict';
import { createSendController } from '../web/send-controller.js';

const failures = [];
async function test(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const state = {
    draft: { rawText: '  问题  ', attachments: [] },
    session: { path: 'session/path', sessionId: 'session-id' },
  };
  const calls = {
    waits: 0,
    frames: [],
    commits: [],
    reports: [],
    sending: [],
    ids: 0,
    reads: 0,
  };

  const controller = createSendController({
    readDraft: () => { calls.reads += 1; return state.draft; },
    readSession: () => state.session,
    waitForReady: () => {
      calls.waits += 1;
      return options.waitForReady ? options.waitForReady() : Promise.resolve(true);
    },
    sendFrame: (frame) => {
      calls.frames.push(frame);
      return options.sendFrame ? options.sendFrame(frame) : true;
    },
    commitSent: (payload) => {
      calls.commits.push(payload);
      if (options.commitSent) return options.commitSent(payload);
    },
    report: (payload) => calls.reports.push(payload),
    onSendingChange: (sending) => {
      calls.sending.push(sending);
      if (options.onSendingChange) return options.onSendingChange(sending);
    },
    makeInputId: () => {
      calls.ids += 1;
      return options.inputId || `input-${calls.ids}`;
    },
  });

  return { controller, state, calls };
}

await test('空草稿或无 session 静默返回', async () => {
  const empty = harness();
  empty.state.draft = { rawText: ' \t ', attachments: [] };
  await empty.controller.send();
  assert.equal(empty.calls.waits, 0);
  assert.equal(empty.calls.frames.length, 0);
  assert.equal(empty.calls.reports.length, 0);
  assert.deepEqual(empty.calls.sending, []);

  const noSession = harness();
  noSession.state.session = null;
  noSession.state.draft.attachments = [{ mimeType: 'image/png', base64: 'AAAA' }];
  await noSession.controller.send();
  assert.equal(noSession.calls.waits, 0);
  assert.equal(noSession.calls.frames.length, 0);
  assert.equal(noSession.calls.reports.length, 0);
});

await test('空正文+纯 pending 附件沿用旧行为静默返回', async () => {
  const h = harness();
  h.state.draft = { rawText: '  ', attachments: [{ id: 'pending', name: 'pending.png' }] };
  await h.controller.send();
  assert.deepEqual(h.calls.reports, []);
  assert.equal(h.calls.waits, 0);
  assert.equal(h.calls.frames.length, 0);
  assert.deepEqual(h.calls.sending, []);
});

await test('非空正文+pending 附件报告 images-pending，不等待也不发送', async () => {
  const h = harness();
  h.state.draft = { rawText: '问题', attachments: [{ id: 'pending', name: 'pending.png' }] };
  await h.controller.send();
  assert.deepEqual(h.calls.reports, [{ code: 'images-pending' }]);
  assert.equal(h.calls.waits, 0);
  assert.equal(h.calls.frames.length, 0);
  assert.deepEqual(h.calls.sending, []);
});

await test('无效图片复用 attach.js 校验结果并在等待前报告', async () => {
  const h = harness();
  h.state.draft.attachments = [{ mimeType: 'image/heic', base64: 'AAAA' }];
  await h.controller.send();
  assert.deepEqual(h.calls.reports, [{ code: 'invalid-images', message: '不支持的图片格式：image/heic' }]);
  assert.equal(h.calls.waits, 0);
  assert.equal(h.calls.frames.length, 0);
});

await test('发送在途重复调用被单飞锁拦截，结束后释放', async () => {
  const gate = deferred();
  const h = harness({ waitForReady: () => gate.promise });
  const first = h.controller.send();
  assert.equal(h.controller.isSending(), true);
  assert.deepEqual(h.calls.sending, [true]);

  await h.controller.send();
  assert.equal(h.calls.waits, 1);
  assert.equal(h.calls.frames.length, 0);
  assert.equal(h.calls.commits.length, 0);

  gate.resolve(true);
  await first;
  assert.equal(h.controller.isSending(), false);
  assert.deepEqual(h.calls.sending, [true, false]);
  assert.equal(h.calls.frames.length, 1);
});

await test('waitForReady=false 报 not-ready，不发送不提交并释放锁', async () => {
  const h = harness({ waitForReady: () => Promise.resolve(false) });
  await h.controller.send();
  assert.deepEqual(h.calls.reports, [{ code: 'not-ready' }]);
  assert.equal(h.calls.frames.length, 0);
  assert.equal(h.calls.commits.length, 0);
  assert.equal(h.controller.isSending(), false);
  assert.deepEqual(h.calls.sending, [true, false]);
});

await test('sendFrame=false 报 disconnected，不提交并释放锁', async () => {
  const h = harness({ sendFrame: () => false });
  await h.controller.send();
  assert.deepEqual(h.calls.reports, [{ code: 'disconnected' }]);
  assert.equal(h.calls.frames.length, 1);
  assert.equal(h.calls.commits.length, 0);
  assert.equal(h.controller.isSending(), false);
  assert.deepEqual(h.calls.sending, [true, false]);
});

await test('成功时用捕获的 session 标量和 trimmed text 构帧并提交一次', async () => {
  const h = harness({ inputId: 'fixed-input-id' });
  h.state.session.agentName = 'must not leak';
  await h.controller.send();

  assert.deepEqual(h.calls.frames, [{
    type: 'prompt',
    sessionId: 'session-id',
    sessionPath: 'session/path',
    text: '问题',
    displayMessage: { text: '问题' },
    clientMessageId: 'fixed-input-id',
    inputId: 'fixed-input-id',
  }]);
  assert.equal(h.calls.commits.length, 1);
  assert.deepEqual(h.calls.commits[0], {
    rawText: '  问题  ',
    text: '问题',
    attachments: [],
    inputId: 'fixed-input-id',
    prepared: false,
    shown: [],
    // 默认投递方式是开新的一轮；steer（插话）是显式传的
    delivery: 'prompt',
  });
  assert.deepEqual(h.calls.reports, []);
  assert.equal(h.calls.ids, 1);
});

await test('等待期间编辑草稿与新增附件：提交原附件引用及预览数据快照', async () => {
  const gate = deferred();
  const original = {
    id: 'original',
    name: 'a-before.png',
    mimeType: 'image/png',
    base64: 'AAAA',
    previewUrl: 'blob:preview-before',
  };
  const addedDuringWait = { id: 'new', name: 'b.png', mimeType: 'image/png', base64: 'BBBB' };
  const h = harness({ waitForReady: () => gate.promise });
  h.state.draft = { rawText: '  旧文本  ', attachments: [original] };

  const sending = h.controller.send();
  original.name = 'a-after.png';
  original.previewUrl = 'blob:preview-after';
  h.state.draft = { rawText: '等待时的新文本', attachments: [original, addedDuringWait] };
  gate.resolve(true);
  await sending;

  assert.equal(h.calls.frames.length, 1);
  assert.equal(h.calls.frames[0].text, '旧文本');
  assert.deepEqual(h.calls.frames[0].images, [{ mimeType: 'image/png', data: 'AAAA' }]);
  assert.equal(h.calls.commits.length, 1);
  assert.equal(h.calls.commits[0].rawText, '  旧文本  ');
  assert.equal(h.calls.commits[0].text, '旧文本');
  assert.equal(h.calls.commits[0].attachments.length, 1);
  assert.equal(h.calls.commits[0].attachments[0], original, '附件引用身份必须保留');
  assert.notEqual(h.calls.commits[0].attachments, h.state.draft.attachments, '提交的是捕获的附件数组快照');
  assert.equal(h.calls.commits[0].attachments.includes(addedDuringWait), false);
  assert.deepEqual(h.calls.commits[0].shown, [{
    src: 'blob:preview-before',
    name: 'a-before.png',
    mimeType: 'image/png',
  }], 'shown 必须来自 await 前捕获的纯数据快照');
});

await test('等待后 session 对象替换则静默取消', async () => {
  const gate = deferred();
  const h = harness({ waitForReady: () => gate.promise });
  const sending = h.controller.send();
  h.state.session = { path: 'other/path', sessionId: 'other-id' };
  gate.resolve(true);
  await sending;

  assert.equal(h.calls.frames.length, 0);
  assert.equal(h.calls.commits.length, 0);
  assert.deepEqual(h.calls.reports, []);
  assert.equal(h.controller.isSending(), false);
});

await test('同一 session 对象的 path 或 sessionId 原地变化也静默取消', async () => {
  for (const field of ['path', 'sessionId']) {
    const gate = deferred();
    const h = harness({ waitForReady: () => gate.promise });
    const capturedSession = h.state.session;
    const sending = h.controller.send();
    capturedSession[field] = `mutated-${field}`;
    gate.resolve(true);
    await sending;

    assert.equal(h.calls.frames.length, 0, `${field} 原地变化不得误发`);
    assert.equal(h.calls.commits.length, 0);
    assert.deepEqual(h.calls.reports, []);
    assert.equal(h.controller.isSending(), false);
  }
});

await test('等待异常原样传播且 finally 释放锁', async () => {
  const failure = new Error('wait exploded');
  const h = harness({ waitForReady: () => Promise.reject(failure) });
  await assert.rejects(h.controller.send(), (error) => error === failure);
  assert.equal(h.controller.isSending(), false);
  assert.deepEqual(h.calls.sending, [true, false]);
  assert.equal(h.calls.frames.length, 0);
  assert.equal(h.calls.commits.length, 0);
});

await test('commitSent 异常原样传播且 finally 释放锁', async () => {
  const failure = new Error('commit exploded');
  const h = harness({ commitSent: () => { throw failure; } });
  await assert.rejects(h.controller.send(), (error) => error === failure);
  assert.equal(h.controller.isSending(), false);
  assert.deepEqual(h.calls.sending, [true, false]);
  assert.equal(h.calls.frames.length, 1, '帧已发送后才调用 commitSent');
  assert.equal(h.calls.commits.length, 1);
});

await test('图片单独发送有效，且 controller 实例锁互相隔离', async () => {
  const gate = deferred();
  const left = harness({ waitForReady: () => gate.promise });
  left.state.draft = {
    rawText: '   ',
    attachments: [{ id: 'image-only', mimeType: 'image/jpeg', base64: 'AAAA' }],
  };
  const leftSend = left.controller.send();
  assert.equal(left.controller.isSending(), true);

  const right = harness();
  await right.controller.send();
  assert.equal(right.controller.isSending(), false);
  assert.equal(right.calls.frames.length, 1);
  assert.equal(left.calls.frames.length, 0);

  gate.resolve(true);
  await leftSend;
  assert.equal(left.calls.frames.length, 1);
  assert.equal(left.calls.frames[0].text, '');
  assert.deepEqual(left.calls.frames[0].images, [{ mimeType: 'image/jpeg', data: 'AAAA' }]);
});

await test('delivery=steer：帧改成 steer 类型，提交也带上 delivery', async () => {
  const h = harness();
  await h.controller.send({ delivery: 'steer' });
  assert.equal(h.calls.frames.length, 1);
  assert.equal(h.calls.frames[0].type, 'steer', '生成中插话要用 steer 帧，不能开新轮');
  assert.equal(h.calls.frames[0].text, '问题');
  assert.equal(h.calls.commits[0].delivery, 'steer');
});

await test('preparedDraft 不读取普通草稿，顶层带 feed ID/revision 且返回完整成功结果', async () => {
  const h = harness();
  const ordinaryDraft = h.state.draft;
  const feed = { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 4, title: '冻结标题' };
  const current = () => true;
  const result = await h.controller.send({
    preparedDraft: { rawText: '  针对日报提问  ', outgoingText: '针对日报提问', attachments: [], feed },
    isCurrent: current,
  });

  assert.deepEqual(result, { frameWritten: true, committed: true, inputId: 'input-1' });
  assert.equal(h.calls.reads, 0, 'prepared 不得读取普通草稿或触发引用捕获');
  assert.equal(h.state.draft, ordinaryDraft);
  assert.equal(h.calls.waits, 1, '沿用一次原 WS 就绪等待');
  assert.deepEqual(h.calls.frames[0], {
    type: 'prompt',
    sessionId: 'session-id',
    sessionPath: 'session/path',
    text: '针对日报提问',
    displayMessage: { text: '针对日报提问' },
    clientMessageId: 'input-1',
    inputId: 'input-1',
    feedItemId: feed.itemId,
    feedRevision: 4,
  });
  assert.deepEqual(h.calls.commits[0], {
    rawText: '  针对日报提问  ',
    text: '针对日报提问',
    attachments: [],
    inputId: 'input-1',
    shown: [],
    delivery: 'prompt',
    prepared: true,
  });
});

await test('prepared 预处理读取异常也转成 SendResult，不逸出并不写帧', async () => {
  const failure = new Error('draft getter failed');
  const preparedDraft = { attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 1 } };
  Object.defineProperty(preparedDraft, 'rawText', { get() { throw failure; } });
  const h = harness();
  const result = await h.controller.send({ preparedDraft });
  assert.deepEqual(result, {
    frameWritten: false,
    committed: false,
    inputId: null,
    error: failure,
  });
  assert.equal(h.calls.waits, 0);
  assert.equal(h.calls.frames.length, 0);
});

await test('prepared 的单飞冲突与 WS 未就绪都返回未写帧 SendResult', async () => {
  const gate = deferred();
  const h = harness({ waitForReady: () => gate.promise });
  const input = { rawText: '提问', attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 1 } };
  const first = h.controller.send({ preparedDraft: input });
  const duplicate = await h.controller.send({ preparedDraft: input });
  assert.equal(duplicate.frameWritten, false);
  assert.equal(duplicate.committed, false);
  assert.equal(duplicate.inputId, null);
  assert.ok(duplicate.error instanceof Error);
  gate.resolve(false);
  const notReady = await first;
  assert.equal(notReady.frameWritten, false);
  assert.equal(notReady.committed, false);
  assert.equal(notReady.inputId, null);
  assert.ok(notReady.error instanceof Error);
  assert.equal(h.calls.waits, 1);
  assert.equal(h.calls.frames.length, 0);
});

await test('prepared 等待后归属失效或帧写入失败均零帧提交且返回 SendResult', async () => {
  const gate = deferred();
  let current = true;
  const h = harness({ waitForReady: () => gate.promise, sendFrame: () => false });
  const pending = h.controller.send({
    preparedDraft: { rawText: '提问', attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 1 } },
    isCurrent: () => current,
  });
  current = false;
  gate.resolve(true);
  const stale = await pending;
  assert.equal(stale.frameWritten, false);
  assert.equal(stale.committed, false);
  assert.equal(stale.inputId, null);
  assert.equal(h.calls.frames.length, 0, '等待后必须先检查导航归属');
  assert.equal(h.calls.commits.length, 0);

  current = true;
  const disconnectedHarness = harness({ sendFrame: () => false });
  const disconnected = await disconnectedHarness.controller.send({
    preparedDraft: { rawText: '提问', attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 1 } },
    isCurrent: () => true,
  });
  assert.equal(disconnected.frameWritten, false);
  assert.equal(disconnected.committed, false);
  assert.ok(disconnected.inputId);
  assert.ok(disconnected.error instanceof Error);
  assert.equal(disconnectedHarness.calls.frames.length, 1, 'sendFrame=false 算未写帧');
  assert.equal(disconnectedHarness.calls.commits.length, 0);
});

await test('prepared commit 失败和 release 失败分别保留精确 frameWritten/committed 与 inputId', async () => {
  const commitError = new Error('commit failed');
  const commitHarness = harness({ commitSent: () => { throw commitError; } });
  const commitResult = await commitHarness.controller.send({
    preparedDraft: { rawText: '提问', attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 2 } },
    isCurrent: () => true,
  });
  assert.deepEqual(commitResult, {
    frameWritten: true,
    committed: false,
    inputId: 'input-1',
    error: commitError,
  });
  assert.equal(commitHarness.calls.frames.length, 1);
  assert.equal(commitHarness.calls.commits[0].prepared, true);

  const releaseError = new Error('release failed');
  const releaseHarness = harness({ onSendingChange: (value) => { if (!value) throw releaseError; } });
  const releaseResult = await releaseHarness.controller.send({
    preparedDraft: { rawText: '提问', attachments: [], feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 2 } },
    isCurrent: () => true,
  });
  assert.equal(releaseResult.frameWritten, true);
  assert.equal(releaseResult.committed, true);
  assert.equal(releaseResult.inputId, releaseHarness.calls.commits[0].inputId);
  assert.equal(releaseResult.error, releaseError);
  assert.equal(releaseHarness.calls.frames.length, 1);
});

if (failures.length) {
  console.error(`\n${failures.length} send-controller test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}