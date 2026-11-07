/* tests/casual_stickers.test.mjs — Hana 宿主闲聊表情面板测试 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import {
  createStickerPanel,
  renderStickerItem,
  renderStickerThumb,
} from '../web/casual-stickers.js';

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const packA = {
  id: 'animals',
  name: '动物',
  editable: false,
  stickers: [{ id: 'cat', url: '/stickers/cat.webp', note: '猫猫' }],
};
const packB = {
  id: 'moods',
  name: '心情',
  editable: true,
  stickers: [{ id: 'happy', url: '/stickers/happy.webp', note: '开心' }],
};

await t('首次打开加载一次；关闭后再次打开复用已加载表情包', async () => {
  const h = createHarness({ debug: false });
  let calls = 0;
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => { calls += 1; return [packA]; },
  });

  assert.equal(panel.isOpen(), false);
  panel.open();
  await tick();
  assert.equal(panel.isOpen(), true);
  assert.equal(calls, 1, '首次打开应加载一次');

  panel.close();
  panel.open();
  await tick();
  assert.equal(calls, 1, '再次打开不应重复加载');
  panel.destroy();
});

await t('多个包显示切换 chip；点击 chip 更新表情网格', async () => {
  const h = createHarness({ debug: false });
  const panel = createStickerPanel({ document: h.doc, loadPacks: async () => [packA, packB] });
  panel.open();
  await tick();

  const chips = h.doc.querySelectorAll('.casual-sticker-pack');
  assert.equal(chips.length, 2, '两个包应显示两个切换 chip');
  assert.equal(chips[0].textContent, '动物');
  assert.equal(h.doc.querySelector('.casual-sticker-thumb').getAttribute('src'), '/stickers/cat.webp');

  chips[1].dispatchEvent('click');
  assert.equal(h.doc.querySelector('.casual-sticker-thumb').getAttribute('src'), '/stickers/happy.webp');
  assert.equal(h.doc.querySelectorAll('.casual-sticker-pack')[1].getAttribute('aria-pressed'), 'true');
  panel.destroy();
});

await t('单包不显示切换行', async () => {
  const h = createHarness({ debug: false });
  const panel = createStickerPanel({ document: h.doc, loadPacks: async () => [packA] });
  panel.open();
  await tick();

  const chips = h.doc.querySelector('.casual-sticker-packs');
  assert.ok(chips && chips.hidden, '单包时切换行应隐藏');
  panel.destroy();
});

await t('点击表情回调收到 packId 与原 sticker，并自动关闭面板', async () => {
  const h = createHarness({ debug: false });
  let picked = null;
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => [packA],
    onPick: (value) => { picked = value; },
  });
  panel.open();
  await tick();

  h.doc.querySelector('.casual-sticker-cell').dispatchEvent('click');
  assert.deepEqual(picked, { packId: 'animals', sticker: packA.stickers[0] });
  assert.equal(panel.isOpen(), false, '选择后应关闭');
  assert.equal(h.doc.querySelector('.casual-sticker-overlay').hidden, true);
  panel.destroy();
});

await t('无表情包显示空态文案；重新加载按钮强制再次加载', async () => {
  const h = createHarness({ debug: false });
  let calls = 0;
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => { calls += 1; return calls === 1 ? [] : [packA]; },
  });
  panel.open();
  await tick();

  assert.ok(h.textOf(h.doc.querySelector('.casual-sticker-content')).includes(
    '还没有表情包。可以在桌面端的闲聊设置里导入。',
  ));
  h.doc.querySelector('.casual-sticker-reload').dispatchEvent('click');
  await tick();
  assert.equal(calls, 2, '重新加载应再调用 loadPacks');
  assert.equal(h.doc.querySelector('.casual-sticker-thumb').getAttribute('src'), '/stickers/cat.webp');
  panel.destroy();
});

await t('加载失败显示中文错误；重试后恢复内容', async () => {
  const h = createHarness({ debug: false });
  let calls = 0;
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => {
      calls += 1;
      if (calls === 1) throw new Error('network failure');
      return [packB];
    },
  });
  panel.open();
  await tick();

  assert.ok(h.textOf(h.doc.querySelector('.casual-sticker-content')).includes('加载失败'));
  assert.ok(h.textOf(h.doc.querySelector('.casual-sticker-content')).includes('重试'));
  h.doc.querySelector('.casual-sticker-retry').dispatchEvent('click');
  await tick();
  assert.equal(calls, 2, '重试应重新调用 loadPacks');
  assert.equal(h.doc.querySelector('.casual-sticker-thumb').getAttribute('src'), '/stickers/happy.webp');
  panel.destroy();
});

await t('点击遮罩关闭；destroy 清除面板与遮罩节点', async () => {
  const h = createHarness({ debug: false });
  let closeCalls = 0;
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => [packA],
    onClose: () => { closeCalls += 1; },
  });
  panel.open();
  await tick();
  h.doc.querySelector('.casual-sticker-mask').dispatchEvent('click');
  assert.equal(panel.isOpen(), false);
  assert.equal(closeCalls, 1, '关闭时应触发 onClose');

  panel.open();
  panel.destroy();
  assert.equal(h.doc.body.children.length, 0, 'destroy 应从 DOM 清除所有面板节点');
  assert.equal(panel.isOpen(), false);
});

await t('消息图与缩略图正确处理 note、lazy loading；缺少 url 不崩溃', async () => {
  const h = createHarness({ debug: false });
  const messageImage = renderStickerItem(h.doc, {
    kind: 'sticker', url: '/stickers/happy.webp', note: '开心表情',
  });
  assert.equal(messageImage.className, 'casual-sticker');
  assert.equal(messageImage.getAttribute('src'), '/stickers/happy.webp');
  assert.equal(messageImage.getAttribute('alt'), '开心表情');
  assert.equal(messageImage.getAttribute('title'), '开心表情');
  assert.equal(messageImage.getAttribute('aria-label'), '开心表情');
  assert.equal(messageImage.getAttribute('loading'), 'lazy');

  const thumb = renderStickerThumb(h.doc, { id: 'x', url: '/x.webp', note: '缩略图' });
  assert.equal(thumb.className, 'casual-sticker-thumb');
  assert.equal(thumb.getAttribute('alt'), '缩略图');
  assert.equal(thumb.getAttribute('title'), '缩略图');
  assert.equal(thumb.getAttribute('loading'), 'lazy');

  const missingUrl = renderStickerItem(h.doc, { kind: 'sticker', note: '无地址' });
  assert.equal(missingUrl.tagName, 'IMG');
  assert.equal(missingUrl.getAttribute('src'), null, '缺少 url 时不要写入空 src');
});

await t('reset 作废旧的在途加载；随后 open 重新加载新表情包', async () => {
  const h = createHarness({ debug: false });
  let calls = 0;
  let resolveOld;
  const oldGate = new Promise((resolve) => { resolveOld = resolve; });
  const panel = createStickerPanel({
    document: h.doc,
    loadPacks: async () => {
      calls += 1;
      if (calls === 1) return oldGate;
      return [packB];
    },
  });

  const first = panel.open();
  await tick();
  assert.equal(calls, 1, '首次 open 应发出加载');
  assert.equal(panel.isOpen(), true);

  panel.reset();
  assert.equal(panel.isOpen(), false, 'reset 必须关闭面板');
  assert.equal(h.doc.querySelector('.casual-sticker-thumb'), null, 'reset 必须清掉旧渲染');

  resolveOld([packA]);
  assert.equal(await first, null, 'reset 后旧请求结果应被丢弃');
  await tick();
  assert.equal(h.doc.querySelector('.casual-sticker-thumb'), null, '旧结果不得回填 reset 后的面板');

  const second = panel.open();
  await tick();
  assert.equal(calls, 2, 'reset 后重新 open 应重新加载');
  const thumb = h.doc.querySelector('.casual-sticker-thumb');
  assert.equal(thumb?.getAttribute('src'), '/stickers/happy.webp', '重新打开应显示新结果');
  await second;
  panel.destroy();
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
