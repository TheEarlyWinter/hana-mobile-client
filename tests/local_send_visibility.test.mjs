/* 刚发出的消息必须活过整页替换（真机 2026-11-10 发现）
 *
 * 现场：手机上发一条长消息 → 回会话列表 → 再点进来。openSession 先清屏，再整页渲染
 * 网关给的那一页；如果那一页停在发送之前（尾部快照 / 宿主还没落盘），乐观画好的用户
 * 气泡就随清屏一起没了，屏上只剩助手正在跑的那一轮。
 *
 * 锁的行为（web/conversation-controller.js keepLocalSendVisible）：
 *   1. 本端刚发的消息不在这一页历史里 → 补回屏上，且只补一条；
 *   2. 这一页本来就有它 → 不补（不许出现两条一样的用户消息）；
 *   3. 超过兜底窗口（默认 120s）不再补：那时历史一定已经包含它，补就是重复；
 *   4. 翻更早页（prepend）不走这条兜底——它不是整页替换，气泡还在屏上。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const PATH = 'C:/sessions/local-send';

const OLD_TURNS = [
  { id: '1', role: 'user', content: '上一轮的问题', timestamp: '2026-11-10T00:40:00.000Z' },
  { id: '2', role: 'assistant', content: '上一轮的回复', timestamp: '2026-11-10T00:41:00.000Z' },
];

/** 发送前那一刻的旧页：只有历史，没有刚发的那条。 */
const beforeSend = (hasMore = false) => ({ messages: OLD_TURNS, blocks: [], hasMore });

/** 发送后宿主落盘、网关刷新过：页里带着那条。 */
const withSent = (text) => ({
  messages: [...OLD_TURNS, { id: '3', role: 'user', content: text, timestamp: '2026-11-10T01:15:36.000Z' }],
  blocks: [],
  hasMore: false,
});

const hist = { page: beforeSend(), older: null };

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({ agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }], userName: 'qa', homeFolder: 'C:/work/workspace' });
  }
  if (path === '/api/sessions/messages') {
    if (/[?&]before=\d+/.test(String(url)) && hist.older) return h.jsonRes(hist.older);
    return h.jsonRes(hist.page);
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const transcript = () => h.getEl('transcript');
const transcriptText = () => h.textOf(transcript());
const countOf = (needle) => transcriptText().split(needle).length - 1;

/** 打开一个会话并等历史落屏；每个用例用独立 sessionId，互不继承屏上内容。 */
async function open(sid, page) {
  hist.page = page;
  await hana.openSession({ sessionId: sid, path: `${PATH}/${sid}.jsonl`, title: sid });
  await h.waitFor(() => transcriptText().length > 0, '历史页渲染完成', 3000);
  // 发消息要求 WS 已开：给一个 readyState=1 的替身（与 attach_files 同一套做法），
  // 不然 composer 会停在「等待连接」而不画气泡。
  S.ws = { readyState: 1, send() {} };
  S.wsReady = true;
  await h.settle(2);
}

async function send(text) {
  h.getEl('input').value = text;
  h.getEl('input').dispatchEvent({ type: 'input' });
  const done = hana.sendMessage();
  await h.settle(3);
  await done;
  await h.settle(3);
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

await t('发完之后回列表再进来：那一页停在发送之前，气泡也必须还在', async () => {
  const text = '丰川祥子：立冬这天的南北对比，一条竖线分两半。';
  await open('sess-send-1', beforeSend());
  assert.ok(transcriptText().includes('上一轮的回复'), '夹具：旧历史应已上屏');

  await send(text);
  assert.equal(countOf(text), 1, '发送后应有一条自己的气泡');

  // 回列表再点进来：网关这一页还没有那条消息。
  await open('sess-send-1', beforeSend());

  assert.equal(countOf(text), 1, `整页替换后那条消息不能消失：${transcriptText().slice(0, 200)}`);
});

await t('那一页本来就带着它：不许补成两条', async () => {
  const text = '这次宿主已经落盘了。';
  await open('sess-send-2', beforeSend());
  await send(text);
  assert.equal(countOf(text), 1, '发送后一条');

  await open('sess-send-2', withSent(text));
  assert.equal(countOf(text), 1, '页里有就别再补');
});

await t('翻更早页不是整页替换：不补、不重复', async () => {
  const text = '翻页时也别把我那条补第二遍。';
  hist.older = {
    messages: [{ id: '0', role: 'assistant', content: 'OLDER-PAGE', timestamp: '2026-11-09T23:00:00.000Z' }],
    blocks: [],
    hasMore: false,
  };
  await open('sess-send-3', beforeSend(true));
  await send(text);
  assert.equal(countOf(text), 1, '发送后一条');

  await hana.loadOlderPage();
  await h.settle(5);
  assert.equal(countOf(text), 1, 'prepend 之后仍是一条');
  assert.ok(transcriptText().includes('OLDER-PAGE'), '更早那页应已上屏');
});

await t('兜底只在短窗口内生效：隔了很久就不再凭记忆补', async () => {
  const text = '十分钟以后就不该再补了。';
  const realNow = Date.now;
  await open('sess-send-4', beforeSend());
  await send(text);
  try {
    // 把时钟推过窗口：这时宿主历史一定已经包含它，再补就是凭空多一条。
    Date.now = () => realNow() + 10 * 60 * 1000;
    await open('sess-send-4', beforeSend());
  } finally {
    Date.now = realNow;
  }
  assert.equal(countOf(text), 0, '超出窗口后不该补');
});

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
}
