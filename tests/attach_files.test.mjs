/* 文档附件：宿主没有内联文档通道，只能「先上传成会话文件，再用 fileId 引用」。
 *
 * 这组用例锁的是那条路的端到端行为：
 *   1. 选文件 → 托盘出现一条带文件名/大小的文件项，**这时还不上传**（懒上传）；
 *   2. 点发送 → 先 POST /api/upload-blob 换 fileId，再把 fileId 放进 prompt 帧的
 *      sessionFileRefs（不是 images，也不是 text 里的假标记）；
 *   3. 只有文件、没有正文的消息也要能发出去；
 *   4. 超限/不支持/上传失败都要有中文提示，且不能把半成品发出去；
 *   5. 图片仍走原来的压缩管线，两条路各算各的上限。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { MAX_FILES, MAX_FILE_BYTES, FILE_READY_FLAG } from '../web/attach.js';

const h = createHarness();
h.installImagePipeline({ delayMs: 1 });

const uploads = [];
let uploadReply = null;

h.setFetch(async (url, init = {}) => {
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
  if (path === '/api/sessions/new') return h.jsonRes({ path: 'C:/s/new.jsonl', sessionId: 's-new' });
  if (path === '/api/upload-blob') {
    const body = JSON.parse(init.body || '{}');
    uploads.push(body);
    if (typeof uploadReply === 'function') return uploadReply(body);
    return h.jsonRes({
      uploads: [{ fileId: `sf_${uploads.length}`, name: body.name, mime: body.mimeType, size: 2048 }],
      uploadsDir: 'C:/hana/session-files/x',
    });
  }
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

/* ------------------------------------------------------------------ */

const pick = (id, files) => h.getEl(id).dispatchEvent('change', { target: { files, value: '' } });

/** 假文件：只要 name/type/size/_b64，够 FileReader 桩读出来。 */
const makeFile = (name, { type = '', size = 2048, b64 = 'UERG' } = {}) => ({ name, type, size, _b64: b64 });

function resetChat() {
  S.attach = [];
  S.homeAttach = [];
  S.attachSeq = 0;
  S.busy = false;
  h.getEl('input').value = '';
  h.getEl('transcript').innerHTML = '';
  h.getEl('attachBar').hidden = true;
  uploads.length = 0;
  uploadReply = null;
}

function setupSession() {
  S.session = { path: 'C:/s/chat.jsonl', sessionId: 's-chat', title: '聊天' };
  const sent = [];
  S.ws = {
    readyState: 1,
    send(data) { sent.push(JSON.parse(String(data))); },
  };
  S.wsReady = true;
  return sent;
}

const attachBarText = () => h.textOf(h.getEl('attachBar'));

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

await t('选文档：托盘显示文件名和大小，这时先不上传', async () => {
  resetChat();
  setupSession();
  await hana.addFiles([makeFile('采购合同.pdf', { type: 'application/pdf', size: 2048 })], 'chat');

  assert.equal(uploads.length, 0, '选完不该立刻上传（发送时才传，省得传完又删）');
  assert.equal(S.attach.length, 1, `托盘应有 1 项，实际 ${S.attach.length}`);
  const item = S.attach[0];
  assert.equal(item.kind, 'file');
  assert.equal(item.name, '采购合同.pdf');
  assert.equal(item.base64, FILE_READY_FLAG, '文件项要带就绪标记，否则发送管线会把它当「还在处理」');
  assert.equal(item.fileId, undefined, '还没上传，当然没有 fileId');

  assert.equal(h.getEl('attachBar').hidden, false, '托盘应展开');
  const text = attachBarText();
  assert.ok(text.includes('采购合同.pdf'), `托盘要显示文件名，实际：${text}`);
  assert.ok(text.includes('2 KB'), `托盘要显示文件大小，实际：${text}`);
  S.session = null;
});

await t('发送文档：先上传换 fileId，再随 prompt 帧的 sessionFileRefs 发出去', async () => {
  resetChat();
  const sent = setupSession();
  h.getEl('input').value = '看下这份合同';
  await hana.addFiles([makeFile('采购合同.pdf', { type: 'application/pdf' })], 'chat');

  await hana.sendMessage();

  assert.equal(uploads.length, 1, '应当发一次上传');
  assert.equal(uploads[0].sessionPath, 'C:/s/chat.jsonl', '必须传到当前会话的文件区');
  assert.equal(uploads[0].name, '采购合同.pdf');
  assert.equal(uploads[0].base64Data, 'UERG');
  assert.equal(uploads[0].mimeType, 'application/pdf');
  assert.equal(uploads[0].presentation, 'attachment');

  assert.equal(sent.length, 1, `应当只发 1 帧，实际 ${sent.length}`);
  const frame = sent[0];
  assert.equal(frame.text, '看下这份合同');
  assert.equal('images' in frame, false, '文档不能塞进 images');
  assert.deepEqual(frame.sessionFileRefs, [
    { fileId: 'sf_1', label: '采购合同.pdf', kind: 'attachment', sessionPath: 'C:/s/chat.jsonl', sessionId: 's-chat' },
  ]);
  assert.equal(
    frame.text.includes('SessionFile'),
    false,
    '不能把标记写进正文：宿主会按 sessionFileRefs 自己展开，写两遍就重复了',
  );

  assert.equal(S.attach.length, 0, '发送成功后托盘应清空');
  assert.equal(h.getEl('attachBar').hidden, true, '托盘清空后应收起');
  S.session = null;
});

await t('只有文件、没有正文也能发', async () => {
  resetChat();
  const sent = setupSession();
  await hana.addFiles([makeFile('数据.xlsx', { type: '', size: 4096, b64: 'WExTWA==' })], 'chat');

  await hana.sendMessage();

  assert.equal(uploads.length, 1);
  assert.equal(
    uploads[0].mimeType,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '浏览器给空 type 时要按扩展名补出真实 mime',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '');
  assert.equal('images' in sent[0], false);
  assert.equal(sent[0].sessionFileRefs.length, 1);
  assert.equal(sent[0].sessionFileRefs[0].label, '数据.xlsx');
  S.session = null;
});

await t('图片和文档混选：图片走压缩管线进 images，文档进 sessionFileRefs', async () => {
  resetChat();
  const sent = setupSession();
  h.getEl('input').value = '两张材料';
  await hana.addFiles(
    [
      h.makeImageFile('shot.png', { b64: 'SU1H' }),
      makeFile('说明.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ],
    'chat',
  );

  await h.waitFor(() => S.attach.some((a) => a && a.kind === 'file'), '文件项应在托盘里');
  assert.equal(S.attach.length, 2, `托盘应有 2 项，实际 ${S.attach.length}`);

  await hana.sendMessage();

  const frame = sent[0];
  assert.equal(frame.images.length, 1, '图片仍走内联');
  assert.equal(frame.images[0].data, 'SU1H');
  assert.equal(frame.sessionFileRefs.length, 1);
  assert.equal(frame.sessionFileRefs[0].label, '说明.docx');
  S.session = null;
});

await t('超出体积上限的文件在选中时就被挡下，并说清楚上限', async () => {
  resetChat();
  setupSession();
  await hana.addFiles([makeFile('超大.pdf', { type: 'application/pdf', size: MAX_FILE_BYTES + 1 })], 'chat');

  assert.equal(S.attach.length, 0, '超限文件不能进托盘');
  const text = h.textOf(h.getEl('transcript'));
  assert.ok(text.includes('超大.pdf'), `提示里要带文件名，实际：${text}`);
  assert.ok(/9\.0 MB/.test(text), `提示里要带上限，实际：${text}`);
  assert.equal(uploads.length, 0);
  S.session = null;
});

await t('不支持的类型在选中时就被挡下', async () => {
  resetChat();
  setupSession();
  await hana.addFiles([makeFile('evil.exe', { type: 'application/x-msdownload' })], 'chat');

  assert.equal(S.attach.length, 0);
  assert.ok(/不支持这种文件类型/.test(h.textOf(h.getEl('transcript'))));
  S.session = null;
});

await t('文件数量上限按文件算，不占图片额度', async () => {
  resetChat();
  setupSession();
  const files = Array.from({ length: MAX_FILES + 3 }, (_v, i) => makeFile(`f${i}.pdf`, { type: 'application/pdf' }));
  await hana.addFiles(files, 'chat');

  assert.equal(S.attach.length, MAX_FILES, `应只留 ${MAX_FILES} 个，实际 ${S.attach.length}`);
  assert.ok(/只取了前/.test(h.textOf(h.getEl('transcript'))));

  // 文件占满后，图片还能继续加
  await hana.addFiles([h.makeImageFile('still-ok.png')], 'chat');
  await h.waitFor(() => S.attach.some((a) => a && a.base64 && a.base64 !== FILE_READY_FLAG), '图片应能进托盘');
  assert.equal(S.attach.length, MAX_FILES + 1);
  S.session = null;
});

await t('上传失败：不发帧、托盘移除该文件、对话里有具体原因', async () => {
  resetChat();
  const sent = setupSession();
  uploadReply = () => h.jsonRes({ uploads: [{ error: 'unsupported mimeType' }] });
  h.getEl('input').value = '发个文件';
  await hana.addFiles([makeFile('合同.pdf', { type: 'application/pdf' })], 'chat');

  await hana.sendMessage();

  assert.equal(sent.length, 0, '上传失败时不能把消息发出去');
  assert.equal(S.attach.length, 0, '失败的文件应从托盘移除');
  const text = h.textOf(h.getEl('transcript'));
  assert.ok(text.includes('合同.pdf'), `提示里要带文件名，实际：${text}`);
  assert.ok(text.includes('宿主不接受这种文件格式'), `提示里要有原因，实际：${text}`);
  assert.equal(h.getEl('input').value, '发个文件', '发不出去时草稿要留着');
  S.session = null;
});

await t('上传期间只上传一次：不会因为重复点发送传两遍', async () => {
  resetChat();
  const sent = setupSession();
  uploadReply = (body) => new Promise((resolve) => {
    setTimeout(() => resolve(h.jsonRes({
      uploads: [{ fileId: 'sf_slow', name: body.name, mime: body.mimeType, size: 2048 }],
    })), 5);
  });
  await hana.addFiles([makeFile('慢.pdf', { type: 'application/pdf' })], 'chat');

  const first = hana.sendMessage();
  const second = hana.sendMessage();
  await Promise.all([first, second]);

  assert.equal(uploads.length, 1, `同一个文件只该传一次，实际 ${uploads.length}`);
  assert.equal(sent.length, 1, `只该发一帧，实际 ${sent.length}`);
  S.session = null;
});

await t('首页选文件：进首页托盘，发送时传成当前（新建）会话的文件', async () => {
  resetChat();
  S.session = null;
  S.ws = null;
  S.wsReady = false;
  h.getEl('homeInput').value = '刚建会话就发文件';
  h.getEl('btnHomeAttach').dispatchEvent('click');
  pick('pickDocument', [makeFile('计划.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })]);

  assert.equal(S.homeAttach.length, 1, `首页托盘应有 1 项，实际 ${S.homeAttach.length}`);
  assert.equal(S.attach.length, 0, '首页选文件不能跑进聊天页托盘');
  assert.ok(h.textOf(h.getEl('homeAttachBar')).includes('计划.docx'), '首页托盘要显示文件名');

  const ws = new h.MockWebSocket('ws://localhost/ws');
  S.ws = ws;
  S.session = { path: 'C:/s/new.jsonl', sessionId: 's-new', title: '新对话' };
  S.wsReady = true;
  ws.readyState = 1;
  S.attach = S.homeAttach.slice();
  S.homeAttach = [];

  await hana.sendMessage();

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].sessionPath, 'C:/s/new.jsonl', '要传到真正要发的那个会话里');
  const frame = ws.sent.find((f) => f.type === 'prompt');
  assert.ok(frame, '应发出 prompt 帧');
  assert.equal(frame.sessionFileRefs[0].label, '计划.docx');
  assert.equal(S.attach.length, 0, '发完托盘应清空');
  S.session = null;
  S.ws = null;
  S.wsReady = false;
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
