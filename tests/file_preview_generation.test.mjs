/* 缺陷 7 回归：迟到的预览响应会覆盖当前文件
 *
 * 根因：file-preview.js 的异步读取（fetch / 解 docx）完成后直接 setBody()，没有代次校验。
 * A 的响应晚于 B 返回就会把 B 的正文盖掉（标题还是 B）；面板关掉之后迟到的响应
 * 也照样往隐藏面板里写。
 *
 * 锁的行为：每次 open 递增预览代次，每个 await 之后、每次写 DOM 之前核对；
 * close 也递增，关闭后在途响应一律作废。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const pendings = new Map();
h.setFetch((url) => new Promise((resolve) => {
  pendings.set(String(url), resolve);
}));

const { openFilePreview, closeFilePreview, previewKind } = await import('../web/file-preview.js');

const WS = '/api/mobile/workspace/content';
const textResponse = (body) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  async text() {
    return body;
  },
  async arrayBuffer() {
    return new ArrayBuffer(0);
  },
});

const panelBody = () => h.doc.body.querySelector('.file-preview-body');
const panelTitle = () => h.doc.body.querySelector('.file-preview-title')?.textContent || '';
const panelRoot = () => h.doc.body.querySelector('.file-preview');
const bodyText = () => h.textOf(panelBody());
const release = (url, response) => {
  const fn = pendings.get(url);
  assert.ok(fn, `没有挂起中的请求可释放：${url}`);
  fn(response);
};

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

await t('A 的响应晚于 B 返回：不能覆盖 B 的正文（标题还是 B）', async () => {
  const urlA = `${WS}?mountId=m&name=A.txt`;
  const urlB = `${WS}?mountId=m&name=B.txt`;

  const openingA = openFilePreview({ file: { label: 'A.txt', ext: 'txt' }, readUrl: urlA, downloadUrl: urlA });
  await h.settle(2);
  const openingB = openFilePreview({ file: { label: 'B.txt', ext: 'txt' }, readUrl: urlB, downloadUrl: urlB });
  await h.settle(2);

  release(urlB, textResponse('BBB-正文'));
  await openingB;
  assert.equal(panelTitle(), 'B.txt', '夹具：当前标题应是 B');
  assert.ok(bodyText().includes('BBB-正文'), '夹具：B 的正文应已上屏');

  release(urlA, textResponse('AAA-正文'));
  await openingA;
  await h.settle(2);

  assert.ok(bodyText().includes('BBB-正文'), `B 的正文不能被 A 的迟到响应盖掉，实际：${bodyText()}`);
  assert.ok(!bodyText().includes('AAA-正文'), 'A 的迟到响应不能写进面板');
  assert.equal(panelTitle(), 'B.txt', '标题仍应是 B（不能出现标题 B、正文 A 的错配）');
});

await t('关闭后迟到的响应不再写隐藏面板', async () => {
  const urlC = `${WS}?mountId=m&name=C.txt`;
  const opening = openFilePreview({ file: { label: 'C.txt', ext: 'txt' }, readUrl: urlC, downloadUrl: urlC });
  await h.settle(2);

  assert.equal(closeFilePreview(), true, '夹具：面板应处于打开状态，可以被 closeFilePreview 关掉');
  assert.equal(panelRoot().hidden, true, '关掉后面板应隐藏');

  release(urlC, textResponse('CCC-迟到正文'));
  await opening;
  await h.settle(2);

  assert.equal(panelBody().children.length, 0, '关闭之后的迟到响应不能往隐藏面板里写内容');
  assert.equal(panelRoot().hidden, true, '面板必须保持隐藏');
});

await t('只拿得到资源地址：正文照常读，但不给下载按钮', async () => {
  const readUrl = '/api/resources/sf_1/content';
  // xls 是 Office 97-2003 的老二进制格式，解不了，直接走兑底提示（xlsx/pptx/pdf 已有内置预览）
  await openFilePreview({ file: { label: 'x.xls', ext: 'xls' }, readUrl });

  assert.equal(
    h.doc.body.querySelector('.file-preview-download'),
    null,
    '非白名单地址不能给一个点了必错的下载按钮',
  );
  assert.ok(
    /老格式/.test(bodyText()),
    `预览本身要能用（只是下不了），实际：${bodyText()}`,
  );
});

await t('预览分流：xlsx / pptx / pdf 走内置预览，xls / ppt / doc 仍走兑底', () => {
  // 这里只锁分流表本身：真渲染由 xlsx_preview / pptx_preview / pdf_preview 各自测。
  const cases = [
    ['xlsx', 'xlsx'], ['pptx', 'pptx'], ['pdf', 'pdf'],
    ['xls', 'unsupported'], ['ppt', 'unsupported'], ['doc', 'unsupported'],
    ['XLSX', 'xlsx'],
  ];
  for (const [ext, want] of cases) {
    assert.equal(previewKind(ext), want, `${ext} 应该分流到 ${want}，实际 ${previewKind(ext)}`);
  }
});

await t('资源读地址 + 文本文件：能读出正文，且没有下载入口', async () => {
  const readUrl = '/api/resources/sf_2/content';
  const opening = openFilePreview({ file: { label: 'notes.txt', ext: 'txt' }, readUrl });
  await h.settle(2);
  release(readUrl, textResponse('RESOURCE-读到的正文'));
  await opening;

  assert.ok(bodyText().includes('RESOURCE-读到的正文'), `必须真的通过资源地址读出来，实际：${bodyText()}`);
  assert.equal(h.doc.body.querySelector('.file-preview-download'), null, '没有白名单地址就不该有下载按钮');
});

await t('工作区地址：给下载按钮，点击走统一的下载入口（导航）', async () => {
  const url = `${WS}?mountId=m&name=y.xls`;
  globalThis.location.href = 'http://localhost:8080/';
  await openFilePreview({ file: { label: 'y.xls', ext: 'xls' }, readUrl: url, downloadUrl: url });

  const link = h.doc.body.querySelector('.file-preview-download');
  assert.ok(link, '工作区地址应给出下载按钮');
  link.dispatchEvent('click', { preventDefault() {} });
  assert.equal(globalThis.location.href, url, '下载必须靠导航（WebView 不认 <a download>）');
  closeFilePreview();
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
