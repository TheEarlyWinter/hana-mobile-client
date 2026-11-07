/* tests/chat_renderer_serene.test.mjs
 *
 * 沉静视图：每轮过程压成一行计数摘要。
 *
 * 这是父代理这边的验收测试：按事先定好的契约断言渲染器行为，
 * 工具名不再出现在摘要里、流式中追加「正在进行」、失败单独计数。
 * 纯文案规则在 tests/turn_summary.test.mjs 里测，这里测「接线是否真的接上」。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createChatRenderer } from '../web/chat-renderer.js';
import { sereneSummary } from '../web/turn-summary.js';

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

function makeRenderer() {
  const h = createHarness({ debug: false });
  const state = { session: null, agentName: '小鲸鱼', replaying: false };
  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => null,
    cardController: null,
    fileUrls: () => ({}),
    paintAvatar: () => {},
    agentAvatarUrlById: () => null,
    userAvatarUrl: () => null,
    flash: () => {},
    onBusyChange: () => {},
    formatSereneSummary: sereneSummary,
  });
  const transcript = () => h.getEl('transcript');
  const meta = () => transcript().querySelector('.turn-meta');
  const summaryText = () => {
    const m = meta();
    if (!m || m.hidden) return '';
    const s = m.querySelector('summary');
    return s ? s.textContent : '';
  };
  return { h, state, renderer, transcript, meta, summaryText };
}

await t('沉静：思考与操作只报数，摘要里不出现工具名', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('serene');

  renderer.startAssistantTurn();
  renderer.addThinking('先看看文件结构');
  renderer.addTool('read', undefined, '运行中', 'c1');
  renderer.addTool('bash', undefined, '运行中', 'c2');

  const text = summaryText();
  assert.ok(text.includes('1 次思考'), `应有思考计数，实际：${text}`);
  assert.ok(text.includes('2 项操作'), `应有操作计数，实际：${text}`);
  assert.ok(!text.includes('read'), `沉静视图不该列工具名，实际：${text}`);
  assert.ok(!text.includes('bash'), `沉静视图不该列工具名，实际：${text}`);
});

await t('沉静：流式过程中追加「正在进行」', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('serene');

  renderer.startAssistantTurn();
  renderer.addThinking('想一想');
  renderer.addTool('read', undefined, '运行中', 'c1');

  const text = summaryText();
  assert.ok(text.endsWith('· 正在进行'), `流式中应提示正在进行，实际：${text}`);
});

await t('沉静：工具失败计入「n 项未成功」', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('serene');

  renderer.startAssistantTurn();
  renderer.addTool('read', undefined, '运行中', 'c1');
  renderer.addTool('bash', undefined, '运行中', 'c2');
  renderer.finishTool('c2', false);

  const text = summaryText();
  assert.ok(text.includes('2 项操作'), `操作数不该因失败减少，实际：${text}`);
  assert.ok(text.includes('1 项未成功'), `失败要单独计数，实际：${text}`);
});

await t('沉静：本轮结束后不再显示「正在进行」', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('serene');

  renderer.startAssistantTurn();
  renderer.addThinking('想一想');
  renderer.addAssistantText('结论是……');
  renderer.finishTurn();

  const text = summaryText();
  assert.ok(text.includes('1 次思考'), `结束后仍应保留计数，实际：${text}`);
  assert.ok(!text.includes('正在进行'), `结束后不该再说正在进行，实际：${text}`);
});

await t('沉静：一轮里只有正文、没有过程时，摘要行保持隐藏', () => {
  const { renderer, meta } = makeRenderer();
  renderer.setViewMode('serene');

  renderer.startAssistantTurn();
  renderer.addAssistantText('直接给答案');

  const m = meta();
  assert.ok(!m || m.hidden === true, '没有过程就不该出现摘要行');
});

await t('经典：切回经典后仍然逐个列出工具名（原行为不许被改坏）', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('classic');

  renderer.startAssistantTurn();
  renderer.addTool('read', undefined, '运行中', 'c1');
  renderer.addTool('bash', undefined, '运行中', 'c2');

  const text = summaryText();
  assert.ok(text.includes('read'), `经典视图应保留工具名，实际：${text}`);
  assert.ok(text.includes('bash'), `经典视图应保留工具名，实际：${text}`);
  assert.ok(!text.includes('项操作'), `经典视图不该用计数摘要，实际：${text}`);
});

await t('未知模式按沉静处理（非法值不能让渲染器崩）', () => {
  const { renderer, summaryText } = makeRenderer();
  renderer.setViewMode('weird');

  renderer.startAssistantTurn();
  renderer.addTool('read', undefined, '运行中', 'c1');

  const text = summaryText();
  assert.ok(text.includes('1 项操作'), `未知模式应落回沉静，实际：${text}`);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
