/* tests/message_actions_quote.test.mjs — 「引用」动作的契约测试
 *
 * 只看四件事：
 * 1. 助手消息与用户消息都带 quote，位置在 copy 之后、edit-resend 之前；
 * 2. 没有正文时 quote 隐藏（和 copy 一样不给入口）；
 * 3. 流式中 quote 仍然可用（引用旧消息不该被生成状态挡住）；
 * 4. plan 形状是 { kind: 'quote', text, author?, at? }，且执行器不接管引用。
 *
 * 不启动页面、不连网关、不依赖浏览器。
 */

import assert from 'node:assert/strict';
import { actionsForMessage, runMessageAction } from '../web/message-actions.js';

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

const SESSION = { sessionId: 'sess_1', path: 'C:\\hana\\sessions\\a.jsonl' };

const ASSISTANT = {
  id: '12',
  role: 'assistant',
  text: '这是助手回复的正文。',
  isLastAssistant: true,
};
const OLD_ASSISTANT = {
  id: '9',
  role: 'assistant',
  text: '更早的一条助手回复。',
  isLastAssistant: false,
};
const USER = {
  id: '11',
  role: 'user',
  text: '这是用户消息的正文',
  isLastUser: true,
};

function actionById(result, id) {
  return (result.actions || []).find((action) => action.id === id) || null;
}

function idsOf(result) {
  return (result.actions || []).map((action) => action.id);
}

/* ------------------------------------------------------------------ */
/* 1. 位置                                                              */
/* ------------------------------------------------------------------ */

await t('助手消息：引用排在复制之后、重试之前', () => {
  const result = actionsForMessage(ASSISTANT, { session: SESSION, streaming: false });
  assert.deepEqual(idsOf(result), ['copy', 'quote', 'retry']);

  const quote = actionById(result, 'quote');
  assert.ok(quote, '助手消息也要能引用');
  assert.equal(quote.label, '引用');
  assert.equal(quote.available, true);
  assert.equal(quote.hidden, false);
  assert.equal(quote.reason, '');
  assert.equal(quote.reasonCode, null);
});

await t('用户消息：引用排在复制之后、编辑重发之前', () => {
  const result = actionsForMessage(USER, { session: SESSION, streaming: false });
  assert.deepEqual(idsOf(result), ['copy', 'quote', 'edit-resend', 'replay']);

  const quote = actionById(result, 'quote');
  assert.equal(quote.available, true);
  assert.equal(quote.label, '引用');
});

await t('更早的助手消息（非最后一条）：重试隐藏，但引用照样可用', () => {
  const result = actionsForMessage(OLD_ASSISTANT, { session: SESSION, streaming: false });
  assert.equal(actionById(result, 'retry').hidden, true);
  assert.equal(actionById(result, 'quote').available, true);
  assert.equal(actionById(result, 'quote').hidden, false);
});

/* ------------------------------------------------------------------ */
/* 2. 没有正文就隐藏                                                    */
/* ------------------------------------------------------------------ */

await t('空正文：引用隐藏，reasonCode 是 empty-text', () => {
  for (const message of [
    { id: '1', role: 'user', text: '   ', isLastUser: true },
    { id: '2', role: 'assistant', text: '', isLastAssistant: true },
    { id: '3', role: 'user' },
  ]) {
    const quote = actionById(actionsForMessage(message, { session: SESSION }), 'quote');
    assert.ok(quote, '纯函数仍返回候选');
    assert.equal(quote.available, false);
    assert.equal(quote.hidden, true, '没有正文时连入口都不该画');
    assert.equal(quote.reasonCode, 'empty-text');
    assert.match(quote.reason, /可引用/);
    assert.equal(quote.plan, null);
  }
});

/* ------------------------------------------------------------------ */
/* 3. 流式中仍然可用                                                    */
/* ------------------------------------------------------------------ */

await t('流式中：引用不受生成状态影响', () => {
  const assistant = actionsForMessage(ASSISTANT, { session: SESSION, streaming: true });
  assert.equal(actionById(assistant, 'quote').available, true);
  assert.equal(actionById(assistant, 'quote').hidden, false);
  assert.ok(actionById(assistant, 'quote').plan, '流式中也要给出 plan');
  assert.equal(actionById(assistant, 'retry').available, false, '对照：重试仍被流式挡住');

  const user = actionsForMessage(USER, { session: SESSION, streaming: true });
  assert.equal(actionById(user, 'quote').available, true);
  assert.ok(actionById(user, 'quote').plan);
  assert.equal(actionById(user, 'edit-resend').available, false, '对照：编辑重发仍被流式挡住');
});

await t('没有会话时引用也可用（纯本地动作，不依赖 session）', () => {
  for (const message of [ASSISTANT, USER]) {
    const quote = actionById(actionsForMessage(message, { session: null }), 'quote');
    assert.equal(quote.available, true);
    assert.ok(quote.plan);
  }
});

/* ------------------------------------------------------------------ */
/* 4. plan 形状                                                         */
/* ------------------------------------------------------------------ */

await t('plan 形状：kind=quote，text 与消息正文逐字一致', () => {
  const raw = '第一行\n第二行「带标点」';
  const quote = actionById(
    actionsForMessage({ id: '7', role: 'user', text: raw, isLastUser: true }, { session: SESSION }),
    'quote',
  );
  assert.deepEqual(quote.plan, { kind: 'quote', text: raw });
  assert.equal(quote.plan.text, raw, '正文原样带走，不 trim 不改写');
});

await t('plan：消息自带的 author / at 透传，拿不到就不写这两个键', () => {
  const withMeta = actionById(
    actionsForMessage({
      id: '8',
      role: 'assistant',
      text: '正文',
      author: 'Hana',
      ts: 1730000000000,
    }, { session: SESSION }),
    'quote',
  );
  assert.deepEqual(withMeta.plan, {
    kind: 'quote',
    text: '正文',
    author: 'Hana',
    at: 1730000000000,
  });

  const bare = actionById(
    actionsForMessage({ id: '9', role: 'user', text: '正文' }, { session: SESSION }),
    'quote',
  );
  assert.deepEqual(bare.plan, { kind: 'quote', text: '正文' });
  assert.equal('author' in bare.plan, false, '拿不到作者就不加 author 键');
  assert.equal('at' in bare.plan, false, '拿不到时间就不加 at 键');
});

await t('plan：没有消息级作者时用 context 的 userName / agentName 兜底', () => {
  const user = actionById(
    actionsForMessage({ id: '10', role: 'user', text: '问' }, {
      session: SESSION,
      userName: '测试用户',
      agentName: 'Hana',
    }),
    'quote',
  );
  assert.equal(user.plan.author, '测试用户');

  const assistant = actionById(
    actionsForMessage({ id: '11', role: 'assistant', text: '答' }, {
      session: SESSION,
      userName: '测试用户',
      agentName: 'Hana',
    }),
    'quote',
  );
  assert.equal(assistant.plan.author, 'Hana');
});

/* ------------------------------------------------------------------ */
/* 5. 执行器不接管引用                                                  */
/* ------------------------------------------------------------------ */

await t('执行器：quote plan 显式返回 quote-delegated，不落到 unknown-plan', async () => {
  const action = actionById(
    actionsForMessage(USER, { session: SESSION, streaming: false }),
    'quote',
  );
  const calls = [];
  const result = await runMessageAction(action, {
    api: async () => { calls.push('api'); },
    fillComposer: async () => { calls.push('fillComposer'); },
    copy: async () => { calls.push('copy'); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quote-delegated');
  assert.notEqual(result.code, 'unknown-plan');
  assert.match(result.message, /引用/);
  assert.deepEqual(calls, [], '引用动作不应触发任何适配器');
});

/* ------------------------------------------------------------------ */
/* 6. 回归：未知角色、空入参仍不返回 quote                              */
/* ------------------------------------------------------------------ */

await t('未知角色与空入参：不返回任何操作', () => {
  assert.deepEqual(actionsForMessage({ role: 'system', text: '系统提示' }, {}).actions, []);
  assert.deepEqual(actionsForMessage(null, {}).actions, []);
  assert.deepEqual(actionsForMessage(undefined, {}).actions, []);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll quote action tests passed.');
}
