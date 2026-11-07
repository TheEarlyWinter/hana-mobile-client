/* tests/reference_block.test.mjs
 *
 * 引用块解析与渲染。
 *
 * 背景：手机端以前把 [hana_reference] … [/hana_reference] 整段丢掉，
 * 桌面看得到的引用手机上完全看不到。这里锁住「解析出来 + 画成卡片」的行为。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { parseReferenceBlocks, hasReferenceBlocks, renderReferenceCard } from '../web/reference-block.js';

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

const SAMPLE = [
  '帮我看看这几个技能',
  '',
  '[hana_reference]',
  'core（3）',
  '- automation — Create and update scheduled automation suggestions.',
  '- browser — Control the in-app browser.',
  '- ui_edit — Read/edit one running Showcard instance.',
  '[/hana_reference]',
].join('\n');

await t('解析：正文里去掉引用块，条目与标签被抽出来', () => {
  const { text, references } = parseReferenceBlocks(SAMPLE);

  assert.equal(references.length, 1, '应解析出一块引用');
  assert.equal(references[0].label, 'core（3）', '标签要保留原文');
  assert.deepEqual(references[0].items.length, 3, '三条条目都要保留');
  assert.ok(references[0].items[0].startsWith('automation — '), '条目内容要完整');
  assert.ok(text.includes('帮我看看这几个技能'), '正文要保留');
  assert.ok(!text.includes('[hana_reference]'), '正文里不能残留标记');
  assert.ok(!text.includes('automation'), '引用内容不该混进正文');
});

await t('解析：多种标记都认（context / reminder / app_context）', () => {
  for (const tag of ['hana_context', 'hana_reminder', 'hana_app_context']) {
    const src = `正文\n[${tag}]\n提示（1）\n- 一条内容\n[/${tag}]`;
    const { text, references } = parseReferenceBlocks(src);
    assert.equal(references.length, 1, `${tag} 应被识别`);
    assert.equal(references[0].items[0], '一条内容');
    assert.equal(text, '正文', `${tag} 的正文应只剩「正文」`);
  }
});

await t('解析：没有标记时原样返回，不做任何改写', () => {
  const plain = '普通消息，没有任何引用。';
  const { text, references } = parseReferenceBlocks(plain);
  assert.equal(text, plain);
  assert.deepEqual(references, []);
  assert.equal(hasReferenceBlocks(plain), false);
});

await t('解析：空块不产生空卡片，也不吃掉正文', () => {
  const src = '正文\n[hana_reference]\n[/hana_reference]';
  const { text, references } = parseReferenceBlocks(src);
  assert.deepEqual(references, [], '空引用不该产生条目');
  assert.ok(text.includes('正文'), '正文必须还在');
});

await t('解析：只有正文没有条目时，整块当标签保留', () => {
  const src = '[hana_reference]\n这是一段说明文字\n[/hana_reference]';
  const { text, references } = parseReferenceBlocks(src);
  assert.equal(references.length, 1);
  assert.equal(references[0].label, '这是一段说明文字');
  assert.equal(text, '');
});

await t('渲染：卡片默认收起，标题带标签与条目数', () => {
  const h = createHarness({ debug: false });
  const card = renderReferenceCard(h.doc, { label: 'core（3）', items: ['a', 'b', 'c'] });

  assert.ok(card, '应生成卡片');
  assert.equal(card.tagName, 'DETAILS', '用 details 做折叠');
  assert.equal(card.open === true, false, '默认收起');
  const summary = card.querySelector('summary');
  assert.ok(summary.textContent.includes('core（3）'), `标题要带标签，实际：${summary.textContent}`);
  assert.ok(summary.textContent.includes('3 项'), `标题要带条目数，实际：${summary.textContent}`);
  assert.equal(card.querySelectorAll('.user-reference-item').length, 3, '三条条目都要画出来');
});

await t('渲染：没有标签时标题写「引用」', () => {
  const h = createHarness({ debug: false });
  const card = renderReferenceCard(h.doc, { label: '', items: ['x'] });
  assert.ok(card);
  assert.equal(card.querySelector('summary').textContent, '引用 · 1 项');
});

await t('渲染：空引用返回 null，不产生空节点', () => {
  const h = createHarness({ debug: false });
  assert.equal(renderReferenceCard(h.doc, { label: '', items: [] }), null);
  assert.equal(renderReferenceCard(h.doc, null), null);
});

await t('渲染：条目文字按纯文本写入（不解析 HTML）', () => {
  const h = createHarness({ debug: false });
  const card = renderReferenceCard(h.doc, { label: 'x', items: ['<img src=x onerror=alert(1)>'] });
  const row = card.querySelector('.user-reference-item');
  assert.equal(row.textContent, '<img src=x onerror=alert(1)>', '必须保留原文而不是被当成标签');
});

await t('与附件拆分联动：splitUserContent 不再丢掉引用块，正文保持干净', async () => {
  const { splitUserContent } = await import('../web/attach.js');
  const parsed = splitUserContent(SAMPLE);

  assert.equal(parsed.references.length, 1, '引用块要被摘出来而不是丢掉');
  assert.ok(!parsed.text.includes('[hana_reference]'), '正文里不能残留标记');
  assert.ok(parsed.text.includes('帮我看看这几个技能'), '用户的正文要保留');
});

await t('渲染器接收：用户消息会把引用画成卡片，而不是静默丢弃', async () => {
  const { createChatRenderer } = await import('../web/chat-renderer.js');
  const h = createHarness({ debug: false });
  const state = { session: null, agentName: '小鲸鱼', replaying: false };
  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => ({ isPrepending: () => false }),
    cardController: null,
    fileUrls: () => ({}),
    paintAvatar: () => {},
    agentAvatarUrlById: () => null,
    userAvatarUrl: () => null,
    flash: () => {},
    onBusyChange: () => {},
  });

  renderer.appendUser('帮我看看这几个技能', [], [], Date.now(), [{ label: 'core（3）', items: ['a', 'b', 'c'] }]);

  const transcript = h.getEl('transcript');
  const card = transcript.querySelector('.user-reference');
  assert.ok(card, '应画出引用卡片');
  assert.ok(card.querySelector('summary').textContent.includes('3 项'), '标题要带条目数');
  assert.equal(card.querySelectorAll('.user-reference-item').length, 3, '三条条目都要在');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
