/* 缺陷 5 回归：聊天输入框没处理 IME 的 keyCode === 229
 *
 * 根因：首页输入只判定 `!e.isComposing`，聊天输入框同理。部分 Android WebView / 输入法
 * 在组合态只给 keyCode 229、不给 isComposing，于是中文候选词上按回车会被当发送。
 *
 * 锁的行为：聊天页 / 首页 / 登录页共用同一套回车口径（Shift+Enter 换行、
 * isComposing 或 keyCode 229 都不算发送）。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

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
await h.waitFor(() => S.currentAgent, 'boot 完成');

const input = h.getEl('input');
const btnSend = h.getEl('btnSend');
const frames = [];

function armComposer(text = '组合输入') {
  S.session = { path: 'p-ime', sessionId: 's-ime', title: '输入法' };
  S.busy = false;
  S.wsReady = true;
  S.ws = { readyState: 1, send: (data) => frames.push(JSON.parse(String(data))), close() {} };
  input.value = text;
  btnSend.disabled = false;
}

function pressEnter(extra = {}) {
  input.dispatchEvent('keydown', {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefault() {},
    ...extra,
  });
}

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

await t('isSendEnter：isComposing 与 keyCode 229 都不算发送', () => {
  assert.equal(hana.isSendEnter({ key: 'Enter' }), true, '普通回车应算发送');
  assert.equal(hana.isSendEnter({ key: 'Enter', isComposing: true }), false, '组合态回车不算发送');
  assert.equal(hana.isSendEnter({ key: 'Enter', keyCode: 229 }), false, 'keyCode 229 不算发送');
  assert.equal(hana.isSendEnter({ key: 'Enter', shiftKey: true }), false, 'Shift+Enter 是换行');
  assert.equal(hana.isSendEnter({ key: 'a' }), false, '非回车不算发送');
});

await t('聊天输入框：组合态（keyCode 229）按回车不发消息', async () => {
  frames.length = 0;
  armComposer();

  pressEnter({ keyCode: 229 });
  await h.settle(4);
  assert.equal(frames.filter((f) => f.type === 'prompt').length, 0, 'keyCode 229 的 Enter 不能被当发送');

  pressEnter({ isComposing: true });
  await h.settle(4);
  assert.equal(frames.filter((f) => f.type === 'prompt').length, 0, 'isComposing 组合态的 Enter 不能被当发送');

  pressEnter({ shiftKey: true });
  await h.settle(4);
  assert.equal(frames.filter((f) => f.type === 'prompt').length, 0, 'Shift+Enter 只应换行');
  assert.equal(input.value, '组合输入', '组合/换行的回车都不能清掉草稿');
});

await t('聊天输入框：普通回车照常发送（正向对照）', async () => {
  frames.length = 0;
  armComposer('正常回车');
  pressEnter();
  await h.settle(6);

  const prompts = frames.filter((f) => f.type === 'prompt');
  assert.equal(prompts.length, 1, `普通回车应发送 1 帧，实际 ${prompts.length}`);
  assert.equal(prompts[0].text, '正常回车');
  assert.equal(prompts[0].sessionPath, 'p-ime');
  S.busy = false;
  S.session = null;
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
