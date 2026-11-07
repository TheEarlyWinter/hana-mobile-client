/* tests/chat_view_mode_integration.test.mjs
 *
 * 沉静视图的「装配」验收：真正加载 web/app.js，走真实接线。
 *
 * 为什么单独写：三个模块各自的单测都绿，不代表 app.js 把它们接对了。
 * 这条用例盯三件事——
 *   1. 登录后确实去读宿主偏好 /api/preferences/chat-ui；
 *   2. 摘要用的是 turn-summary 的文案（注入生效，不是渲染器兜底）；
 *   3. 在设置面板里点「经典视图」会 PUT 回宿主，并且摘要立刻换回逐条样式。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const calls = [];
let serverViewMode = 'serene';

h.setFetch(async (url, init = {}) => {
  const path = String(url).split('?')[0];
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ path, method, body: init.body || null });

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
  if (path === '/api/preferences/chat-ui') {
    if (method === 'PUT') {
      const next = JSON.parse(init.body || '{}');
      if (next.viewMode === 'classic' || next.viewMode === 'serene') serverViewMode = next.viewMode;
      return h.jsonRes({ ok: true, chatUi: { viewMode: serverViewMode } });
    }
    return h.jsonRes({ chatUi: { viewMode: serverViewMode } });
  }
  // 设置面板打开后还会拉模型与思考级别；这里给空形状，避免无关报错干扰。
  if (path === '/api/sessions') return h.jsonRes([]);
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');
await h.waitFor(
  () => calls.some((c) => c.path === '/api/preferences/chat-ui' && c.method === 'GET'),
  '启动后应读取聊天视图偏好',
);

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

/** 摘要行的文字：没有就不返回空串。 */
function summaryText() {
  const meta = h.getEl('transcript').querySelector('.turn-meta');
  if (!meta || meta.hidden) return '';
  const s = meta.querySelector('summary');
  return s ? s.textContent : '';
}

/** 设置面板里聊天视图的两个按钮。用属性读模式：夹具的 dataset 不跟着 setAttribute 同步。 */
function viewModeButtons() {
  const container = h.getEl('settingsContainer');
  return typeof container.querySelectorAll === 'function'
    ? container.querySelectorAll('.settings-view-mode-btn')
    : [];
}

function viewModeButton(mode) {
  return viewModeButtons().find((b) => b.getAttribute('data-view-mode') === mode) || null;
}

/** 造一轮带过程的消息，返回摘要文字。 */
function runTurnWithTools() {
  hana.startAssistantTurn();
  hana.addThinking('先看看文件');
  hana.addTool('read', undefined, '运行中', 'c1');
  hana.addTool('bash', undefined, '运行中', 'c2');
  const text = summaryText();
  hana.finishTurn();
  return text;
}

await t('启动即读宿主偏好：GET /api/preferences/chat-ui', () => {
  const get = calls.find((c) => c.path === '/api/preferences/chat-ui' && c.method === 'GET');
  assert.ok(get, '启动后没有读偏好，装配漏了 chatViewMode.load()');
});

await t('默认沉静：摘要用计数文案（证明 turn-summary 注入生效）', () => {
  // 清掉上一轮残留，保证断言看的是本轮
  h.getEl('transcript').innerHTML = '';
  const text = runTurnWithTools();

  assert.ok(text.includes('1 次思考'), `摘要应有思考计数，实际：${text}`);
  assert.ok(text.includes('2 项操作'), `摘要应有操作计数，实际：${text}`);
  assert.ok(!text.includes('read'), `沉静视图不该列工具名，实际：${text}`);
});

await t('设置里切经典视图：PUT 回宿主，且摘要立刻换回逐条样式', async () => {
  h.getEl('btnSettings').dispatchEvent({ type: 'click' });
  await h.waitFor(() => viewModeButtons().length >= 2, '设置面板应渲染出聊天视图的两个选项');

  const classicBtn = viewModeButton('classic');
  assert.ok(classicBtn, '找不到「经典视图」按钮');
  classicBtn.dispatchEvent({ type: 'click' });

  await h.waitFor(
    () => calls.some((c) => c.path === '/api/preferences/chat-ui' && c.method === 'PUT'),
    '点选后应向宿主写回偏好',
  );
  const put = calls.filter((c) => c.path === '/api/preferences/chat-ui' && c.method === 'PUT').at(-1);
  assert.equal(JSON.parse(put.body).viewMode, 'classic', 'PUT 必须带上用户选中的模式');

  h.getEl('transcript').innerHTML = '';
  const text = runTurnWithTools();
  assert.ok(text.includes('read'), `切到经典后摘要应恢复工具名，实际：${text}`);
  assert.ok(!text.includes('项操作'), `经典视图不该用计数摘要，实际：${text}`);
});

await t('切回沉静：再点一次能回到计数文案', async () => {
  const sereneBtn = viewModeButton('serene');
  assert.ok(sereneBtn, '找不到「沉静视图」按钮');
  sereneBtn.dispatchEvent({ type: 'click' });

  await h.waitFor(() => serverViewMode === 'serene', '服务端应收到 serene');

  h.getEl('transcript').innerHTML = '';
  const text = runTurnWithTools();
  assert.ok(text.includes('1 次思考'), `切回沉静后市应回到计数，实际：${text}`);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
