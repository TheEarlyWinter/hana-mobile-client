/* 缺陷 10 回归：首页「添加图片附件」按钮没有接线
 *
 * 根因：index.html 有 #btnHomeAttach 和 #homeAttachBar，JS 里没有任何引用，点了没反应。
 *
 * 方案：接线（不是删控件）。首页发送链路本来就支持图片（prompt 帧的 images 字段、
 * buildPromptFrame、commitSent 都覆盖了），缺的只是①首页自己的附件状态、②发送时
 * 把图交接给聊天页。所以这里独立一份 homeAttach 托盘，首页发送成功后连同草稿一起
 * 交给聊天页的 S.attach，由同一个 sendController 发出。
 *
 * 锁的行为：
 *   1. 首页附件按钮打开同一个来源选择面板，选中的图进首页托盘（不进聊天托盘）；
 *   2. 图片没处理完时首页发送会明确提示，不会把半成品发出去；
 *   3. 发送帧里带 images，发送成功后首页托盘清空；
 *   4. 聊天页的附件按钮仍进聊天托盘（两条路不串）。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
h.installImagePipeline({ delayMs: 2 });

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/OH-WorkSpace',
    });
  }
  if (path === '/api/sessions/new') return h.jsonRes({ path: 'p-created', sessionId: 's-created' });
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const pick = (id, files) => h.getEl(id).dispatchEvent('change', { target: { files, value: '' } });
const promptFrames = () => h.MockWebSocket.instances
  .flatMap((ws) => ws.sent.filter((f) => f && f.type === 'prompt'));

function resetTrays() {
  S.attach = [];
  S.homeAttach = [];
  S.attachSeq = 0;
  hana.renderAttachBar('chat');
  hana.renderAttachBar('home');
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

await t('首页附件按钮：点开同一个来源选择面板', async () => {
  resetTrays();
  h.getEl('attachSheet').hidden = true;
  h.getEl('btnHomeAttach').dispatchEvent('click');
  assert.equal(h.getEl('attachSheet').hidden, false, '首页的「+」必须真的打开选图面板');
  h.getEl('attachSheet').hidden = true;
});

await t('首页选图：进首页自己的托盘，不进聊天托盘', async () => {
  resetTrays();
  h.getEl('btnHomeAttach').dispatchEvent('click');
  pick('pickGallery', [h.makeImageFile('home-1.png', { b64: 'SE9NRTE=' })]);

  await h.waitFor(() => (S.homeAttach || []).some((a) => a && a.base64), '首页托盘应拿到处理好的图片');
  assert.equal(S.homeAttach.length, 1, `首页托盘应有 1 张，实际 ${S.homeAttach.length}`);
  assert.equal(S.attach.length, 0, '首页选图不能跑进聊天页的托盘');
  assert.equal(h.getEl('homeAttachBar').hidden, false, '首页附件托盘应显示出来');
  assert.equal(h.getEl('homeAttachBar').children.length, 1, '首页托盘应有 1 个缩略图');
  assert.equal(h.getEl('attachBar').hidden, true, '聊天页托盘不该被首页选图点亮');
});

await t('首页发送：prompt 帧带上首页的图片，发送成功后首页托盘清空', async () => {
  resetTrays();
  h.getEl('homeInput').value = '带图的消息';
  h.getEl('btnHomeAttach').dispatchEvent('click');
  pick('pickGallery', [h.makeImageFile('home-2.png', { b64: 'SE9NRTI=' })]);
  await h.waitFor(() => (S.homeAttach || []).some((a) => a && a.base64), '首页托盘应拿到图片');
  const expected = S.homeAttach[0].base64;

  const before = promptFrames().length;
  h.getEl('btnHomeSend').dispatchEvent('click');

  await h.waitFor(() => S.session?.path === 'p-created', '应打开新建会话');
  await h.waitFor(() => h.MockWebSocket.instances.length > 0, '应建立连接');
  h.MockWebSocket.instances.at(-1).open();
  await h.waitFor(() => promptFrames().length > before, '应发出 prompt 帧');

  const frame = promptFrames().at(-1);
  assert.equal(frame.text, '带图的消息');
  assert.ok(Array.isArray(frame.images) && frame.images.length === 1, `帧里必须带 1 张图，实际 ${JSON.stringify(frame.images)}`);
  assert.equal(frame.images[0].data, expected, '帧里的图片数据必须来自首页托盘');
  assert.equal(frame.images[0].mimeType, 'image/png');

  await h.waitFor(() => S.homeAttach.length === 0, '发送成功后首页托盘应清空');
  assert.equal(h.getEl('homeAttachBar').hidden, true, '首页托盘清空后应收起');
  assert.equal(S.attach.length, 0, '已发出的图不能留在聊天页托盘里');
  S.session = null;
});

await t('图片还在处理时首页发送会被拦下并提示', async () => {
  resetTrays();
  // 手工放一个「处理中」的槽位（没有 base64），模拟选完图立刻点发送
  S.homeAttach = [{ id: 'slot-x', name: 'busy.png', pending: true }];
  h.getEl('homeInput').value = '别发半成品';
  const before = promptFrames().length;

  h.getEl('btnHomeSend').dispatchEvent('click');
  await h.settle(4);

  assert.equal(promptFrames().length, before, '图片没处理完时不能发送');
  assert.ok(/图片还在处理/.test(h.getEl('flashBar').textContent), `应提示稍后再发，实际：${h.getEl('flashBar').textContent}`);
  assert.equal(h.getEl('homeInput').value, '别发半成品', '被拦下时草稿必须留着');
  assert.equal(S.homeAttach.length, 1, '被拦下时附件必须留着');
});

await t('聊天页附件按钮仍进聊天托盘（两条路不串）', async () => {
  resetTrays();
  S.session = { path: 'p-chat', sessionId: 's-chat', title: '聊天' };
  h.getEl('btnAttach').dispatchEvent('click');
  pick('pickCamera', [h.makeImageFile('chat-1.png', { b64: 'Q0hBVA==' })]);

  await h.waitFor(() => (S.attach || []).some((a) => a && a.base64), '聊天托盘应拿到图片');
  assert.equal(S.attach.length, 1, '聊天页选图应进聊天托盘');
  assert.equal(S.homeAttach.length, 0, '聊天页选图不能跑进首页托盘');
  S.session = null;
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
