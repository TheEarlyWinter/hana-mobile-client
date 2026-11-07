/* tests/android_back_features.test.mjs
 *
 * Android 物理返回键（window.HanaMobile.back）对接各全屏/模态特性的集成测试。
 * 使用真实 app_harness 运行真实 app.js 与 feature 实例。
 * 覆盖：
 * 1. 归档面板 (archive) 打开时按返回键先关面板，返回 true，不退底层页面
 * 2. 搜索浮层 (search) 打开时按返回键先关搜索，返回 true，不退底层页面
 * 3. 闲聊面板 (casual) 打开时按返回键先关闲聊，返回 true，不退底层页面
 * 4. 闲聊内贴纸抽屉 (stickers) 打开时按返回键先关贴纸抽屉（闲聊保持），再按返回键关闲聊
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

// 挂载 sessionList 的父容器关系，与真实 index.html 保持一致
h.getEl('homeScroll').appendChild(h.getEl('sessionList'));

const entry = (id, text, actor = 'agent') => ({
  id,
  sourceEntryId: id,
  actor,
  occurredAt: '2026-11-04T03:00:00.000Z',
  item: { kind: 'text', text },
});

h.setFetch(async (url, init = {}) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/OH-WorkSpace',
    });
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  if (path === '/api/sessions/archived') return h.jsonRes({ sessions: [] });
  if (path === '/api/preferences/chat-ui') return h.jsonRes({ chatUi: { viewMode: 'serene' } });
  if (path === '/api/casual/agent-1/summary') return h.jsonRes({ preview: null, unread: 0 });
  if (path === '/api/casual/agent-1/entries') {
    return h.jsonRes({ entries: [entry('e1', '你好')], hasMore: false, typing: false });
  }
  if (path === '/api/casual/stickers') return h.jsonRes({ packs: [] });
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const hook = globalThis.HanaMobile;
assert.ok(hook && typeof hook.back === 'function', 'HanaMobile.back 必须存在');

const nodeById = (id) => h.allNodes.find((n) => n && n.id === id) || null;
const nodeByClass = (cls) =>
  h.allNodes.find((n) => n && typeof n.className === 'string' && n.className.split(/\s+/).includes(cls)) || null;

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

await t('归档面板打开时按返回键：先关闭归档面板并返回 true，不退底层视图', async () => {
  const btnArchive = nodeById('btnArchivedList');
  assert.ok(btnArchive, '必须存在归档入口按钮');
  btnArchive.dispatchEvent('click');

  const archivePanel = nodeByClass('archive-panel');
  assert.ok(archivePanel, '点击归档入口应在 DOM 中创建归档面板');
  assert.equal(archivePanel.hidden, false, '归档面板应处于打开状态');

  const handled = hook.back();
  assert.equal(handled, true, '归档面板打开时按返回键必须被消费并返回 true');
  assert.equal(archivePanel.hidden, true, '返回键应关闭归档面板');
  assert.equal(h.getEl('view-list').hidden, false, '关闭归档面板不应退出列表页');
});

await t('搜索面板打开时按返回键：先关闭搜索面板并返回 true，不退底层视图', async () => {
  const btnSearch = nodeById('btnSearch');
  assert.ok(btnSearch, '必须存在搜索入口按钮');
  btnSearch.dispatchEvent('click');

  const searchOverlay = nodeByClass('message-search-overlay');
  assert.ok(searchOverlay, '搜索浮层应在 DOM 中挂载');
  assert.equal(searchOverlay.hidden, false, '搜索浮层应处于打开状态');

  const handled = hook.back();
  assert.equal(handled, true, '搜索浮层打开时按返回键必须被消费并返回 true');
  assert.equal(searchOverlay.hidden, true, '返回键应关闭搜索浮层');
  assert.equal(h.getEl('view-list').hidden, false, '关闭搜索浮层不应退出列表页');
});

await t('闲聊面板打开时按返回键：先关闭闲聊面板并返回 true，不退底层视图', async () => {
  const btnCasual = nodeById('btnCasual');
  assert.ok(btnCasual, '必须存在闲聊入口按钮');
  btnCasual.dispatchEvent('click');

  const casualView = nodeByClass('casual-view');
  assert.ok(casualView, '闲聊面板应在 DOM 中挂载');
  assert.equal(casualView.hidden, false, '闲聊面板应处于打开状态');

  const handled = hook.back();
  assert.equal(handled, true, '闲聊面板打开时按返回键必须被消费并返回 true');
  assert.equal(casualView.hidden, true, '返回键应关闭闲聊面板');
  assert.equal(h.getEl('view-list').hidden, false, '关闭闲聊面板不应退出列表页');
});

await t('闲聊面板内贴纸抽屉打开时按返回键：先关贴纸抽屉保持闲聊，再按一次才关闲聊', async () => {
  const btnCasual = nodeById('btnCasual');
  btnCasual.dispatchEvent('click');

  const casualView = nodeByClass('casual-view');
  assert.ok(casualView && !casualView.hidden, '闲聊面板已打开');

  // 触发闲聊面板内的表情按钮
  const btnSticker = nodeByClass('casual-header-sticker');
  assert.ok(btnSticker, '闲聊面板内必须有表情按钮');
  btnSticker.dispatchEvent('click');

  const stickerOverlay = nodeByClass('casual-sticker-overlay');
  assert.ok(stickerOverlay, '贴纸面板应已挂载到 body');
  assert.equal(stickerOverlay.hidden, false, '贴纸面板应处于打开状态');

  // 第 1 下返回：关贴纸面板，闲聊面板保持
  const handled1 = hook.back();
  assert.equal(handled1, true, '第 1 下返回必须被消费');
  assert.equal(stickerOverlay.hidden, true, '贴纸面板必须被关闭');
  assert.equal(casualView.hidden, false, '闲聊面板必须保持开启');

  // 第 2 下返回：关闲聊面板
  const handled2 = hook.back();
  assert.equal(handled2, true, '第 2 下返回必须被消费');
  assert.equal(casualView.hidden, true, '闲聊面板必须被关闭');
  assert.equal(h.getEl('view-list').hidden, false, '底层列表页不退');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
