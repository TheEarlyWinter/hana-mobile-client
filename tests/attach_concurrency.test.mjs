/* 缺陷 6 回归：并发导入附件会突破 10 张上限
 *
 * 根因：addFiles() 在函数开头算一次 room = MAX_IMAGES - S.attach.length，然后就
 * await prepareImage()。两次并发调用各自按旧数量通过检查，槽位合起来超过 10 张，
 * 之后 validateForSend 看到 >10 张直接整批拒绝，用户一张都发不出去。
 *
 * 锁的行为：容量必须原子预留——先把本批槽位同步占掉，再逐个 await 处理；
 * 后到的调用只能拿到剩下的名额（并明确告知只取了前几张）。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { MAX_IMAGES, validateForSend } from '../web/attach.js';

const h = createHarness();
h.installImagePipeline({ delayMs: 5 });   // 让 prepareImage 真的跨 tick，制造交错

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
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const makeFiles = (prefix, count) => Array.from({ length: count }, (_v, i) => (
  h.makeImageFile(`${prefix}${i}.png`, { b64: `QUJD${prefix}${i}` })
));

const readyImages = () => (S.attach || [])
  .filter((a) => a && a.base64)
  .map((a) => ({ mimeType: a.mimeType, data: a.base64 }));

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

await t('容量原子预留：调用返回时槽位就已经同步占掉，不会给并发留空档', async () => {
  S.attach = [];
  const files = makeFiles('a', 6);
  const pending = hana.addFiles(files, 'chat');

  assert.equal(S.attach.length, 6, `本批 6 张应在 await 之前就同步占位，实际 ${S.attach.length}`);
  assert.ok(S.attach.every((slot) => slot && slot.pending), '占位时还是「处理中」状态');

  await pending;
  await h.waitFor(() => S.attach.every((a) => a && a.base64), '6 张都应处理完');
  assert.equal(S.attach.length, 6);
});

await t('两次并发导入：总数不超过 10 张，且仍然可以整批发出去', async () => {
  S.attach = [];
  h.getEl('transcript').innerHTML = '';

  const first = hana.addFiles(makeFiles('a', 6), 'chat');
  const second = hana.addFiles(makeFiles('b', 6), 'chat');   // 同时进来：只能拿剩下 4 个名额
  await Promise.all([first, second]);
  await h.waitFor(() => S.attach.every((a) => a && a.base64), '所有槽位都应处理完');

  assert.equal(S.attach.length, MAX_IMAGES, `两张并发批次合起来必须正好 ${MAX_IMAGES} 张，实际 ${S.attach.length}`);
  assert.equal(
    validateForSend(readyImages()),
    null,
    `并发导入后不能超过上限（否则整批发不出去），实际 ${S.attach.length} 张`,
  );
  // 后一批只该进来 4 张，并且明确提示
  const names = S.attach.map((a) => a.name);
  assert.equal(names.filter((n) => n.startsWith('a')).length, 6, '第一批 6 张应全部进入');
  assert.equal(names.filter((n) => n.startsWith('b')).length, 4, '第二批只能拿到剩下的 4 个名额');
  assert.ok(
    h.textOf(h.getEl('transcript')).includes(`一次最多 ${MAX_IMAGES} 张`) ||
      h.textOf(h.getEl('transcript')).includes('只取了前'),
    '被截断时要明确告诉用户只取了前几张',
  );
});

await t('处理失败的槽位会释放：不会把名额永久占死', async () => {
  S.attach = [];
  const bad1 = { name: 'broken.png', type: 'text/plain', size: 1 };
  await hana.addFiles([bad1], 'chat');
  assert.equal(S.attach.length, 0, '解不开的图片不该留在托盘里占名额');

  await hana.addFiles(makeFiles('c', 10), 'chat');
  await h.waitFor(() => S.attach.every((a) => a && a.base64), '10 张都应处理完');
  assert.equal(S.attach.length, MAX_IMAGES, '失败释放后应还能装满 10 张');
  S.attach = [];
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
