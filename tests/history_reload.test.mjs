/* 缺陷 2 回归：原会话重载不能先清屏、再因为 busy 把整页丢掉
 *
 * 根因：loadHistory() 先 transcript.innerHTML = ''、清分页视图、清卡片，然后才
 * historyPager.open()。pager 在 canLoad()（= !S.busy）为 false 时会整页丢弃，
 * 于是旧历史已经被删、新历史又进不来，屏幕上什么都不剩。
 *
 * 锁的行为：
 *   1. 「原会话重载」（回执重拉 / 重试 / 首屏重试）拿到这一页并通过 busy 复核后才替换；
 *   2. busy 或请求失败时，已加载的历史必须原样保留，并且状态带里有「稍后重试」的提示；
 *   3. 「会话切换」仍然立刻清屏（走 loadHistory({ clearNow: true })），旧会话的消息
 *      不能挂在新标题下面。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const SID = 'sess-reload';
const PATH = 'C:/sessions/reload';

/** 宿主历史页：messages 只有 user/assistant，id 是十进制字符串。 */
function page(id, text) {
  return {
    messages: [{ id: String(id), role: 'user', content: text, timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, id)).toISOString() }],
    blocks: [],
    hasMore: false,
  };
}

const state = {
  page: page(1, 'OLD-HISTORY-1'),
  fail: false,
  historyCalls: 0,
};

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions/messages') {
    state.historyCalls += 1;
    if (state.fail) return h.jsonRes({ detail: 'boom' }, { ok: false, status: 500 });
    // before= 存在就是「加载更早」：给一页旧内容，模拟翻到了前一页。
    if (/[?&]before=\d+/.test(String(url))) return h.jsonRes({ messages: [{ id: '80', role: 'assistant', content: 'OLDER-80', timestamp: '2026-11-01T00:00:00.000Z' }], blocks: [], hasMore: false });
    return h.jsonRes(state.page);
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const transcript = () => h.getEl('transcript');
const turns = () => transcript().children.filter((n) => /(^|\s)turn(\s|$)/.test(String(n.className || '')));
const chromeBars = () => transcript().children.filter((n) => String(n.className || '').includes('history-pagination-bar'));
const barText = () => chromeBars().map((n) => h.textOf(n)).join(' | ');
const transcriptText = () => h.textOf(transcript());

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

await t('夹具：打开会话后历史能正常渲染', async () => {
  await hana.openSession({ path: PATH, sessionId: SID, title: '重载会话', agentId: 'agent-1' });
  await h.waitFor(() => turns().length === 1, '首屏历史应渲染出 1 条');
  assert.ok(transcriptText().includes('OLD-HISTORY-1'), `首屏内容应进 transcript，实际：${transcriptText()}`);
});

await t('busy 时重载：不清旧历史、不伪装空会话，状态带提示稍后再试', async () => {
  const callsBefore = state.historyCalls;
  S.busy = true;
  await hana.loadHistory();
  await h.settle(4);

  assert.equal(state.historyCalls, callsBefore, 'busy 时不该发历史请求');
  assert.equal(turns().length, 1, `旧历史不能被清掉，实际 ${turns().length} 条`);
  assert.ok(transcriptText().includes('OLD-HISTORY-1'), '旧历史正文必须还在（先清后丢就是这个缺陷）');
  assert.ok(!transcriptText().includes('这个会话还没有消息'), 'busy 不能被伪装成空会话');
  assert.ok(/正在生成回复|稍后再加载/.test(barText()), `状态带要说明为什么没加载，实际：${barText()}`);
  S.busy = false;
});

await t('busy 解除后重载：拿到这一页之后才整页替换', async () => {
  state.page = page(2, 'NEW-HISTORY-2');
  await hana.loadHistory();
  await h.settle(4);

  assert.equal(turns().length, 1, `替换后只应有新的一页，实际 ${turns().length} 条`);
  assert.ok(transcriptText().includes('NEW-HISTORY-2'), '新历史必须渲染出来');
  assert.ok(!transcriptText().includes('OLD-HISTORY-1'), '整页替换后旧内容应被换掉（不能两份叠在一起）');
});

await t('重载失败：保留已加载的历史，不清屏', async () => {
  state.fail = true;
  await hana.loadHistory();
  await h.settle(4);

  assert.equal(turns().length, 1, `失败不能动已有消息，实际 ${turns().length} 条`);
  assert.ok(transcriptText().includes('NEW-HISTORY-2'), '失败后已加载的历史必须原样保留');
  assert.ok(/失败|重试/.test(barText()), `失败要在状态带里说明，实际：${barText()}`);
  state.fail = false;
});

await t('翻过更早页之后，后台补拉不能整页替换把旧页冲掉', async () => {
  // 真机上的现场：搜索定位翻出更早页 → 宿主 idle 触发补拉 → 整页替换 → 旧页全没，
  // 定位于是报「没找到」（轮次 44 → 29）。这里锁住「翻过历史就不允许后台整页替换」。
  state.page = {
    messages: [{ id: '100', role: 'user', content: 'TAIL-100', timestamp: '2026-11-02T00:00:00.000Z' }],
    blocks: [],
    hasMore: true,
  };
  await hana.loadHistory();
  await h.waitFor(() => transcriptText().includes('TAIL-100'), '首屏换到新页');

  await hana.loadOlderPage();
  await h.waitFor(() => transcriptText().includes('OLDER-80'), '更早页应上屏');

  const callsBefore = state.historyCalls;
  await hana.loadHistory();
  await h.settle(4);

  assert.equal(state.historyCalls, callsBefore, '翻过历史后，后台补拉不该再发整页请求');
  assert.ok(transcriptText().includes('OLDER-80'), `更早页必须还在，实际：${transcriptText()}`);
  assert.ok(transcriptText().includes('TAIL-100'), '最新页也不能丢');
});

await t('会话切换仍然立刻清屏：旧会话的消息不能挂在新标题下面', async () => {
  // 让新会话的历史请求挂住，检查切换瞬间就已经清掉旧内容
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/sessions/messages')) {
      await pending;
      return h.jsonRes(page(3, 'SWITCHED-HISTORY-3'));
    }
    return originalFetch(url, init);
  };
  try {
    const opening = hana.openSession({ path: 'C:/sessions/other', sessionId: 'sess-other', title: '另一个会话', agentId: 'agent-1' });
    await h.settle(2);
    assert.ok(!transcriptText().includes('NEW-HISTORY-2'), '切会话的同步阶段就要清屏，旧消息不能留在新标题下');
    release();
    await opening;
    await h.waitFor(() => transcriptText().includes('SWITCHED-HISTORY-3'), '新会话历史应渲染');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await t('重载页以 assistant 开头：不能把正文写进已被替换的旧轮', async () => {
  // 首屏最后一轮是 assistant：重载拿到的新页又恰好从 assistant 开头。
  // 回放合并状态如果还指着旧 DOM，新页的正文会被追加进已经脱离文档的节点，
  // 屏幕上什么都看不到（重载成功却像丢了一页）。
  state.page = {
    messages: [
      { id: '1', role: 'user', content: 'RELOAD-USER-1', timestamp: new Date(Date.UTC(2026, 10, 2, 0, 0, 1)).toISOString() },
      {
        id: '2',
        role: 'assistant',
        content: [{ type: 'text', text: 'RELOAD-ASSIST-2' }],
        timestamp: new Date(Date.UTC(2026, 10, 2, 0, 0, 2)).toISOString(),
      },
    ],
    blocks: [],
    hasMore: false,
  };
  await hana.openSession({
    path: 'C:/sessions/reload-assist',
    sessionId: 'sess-reload-assist',
    title: '助手开头的重载',
    agentId: 'agent-1',
  });
  await h.waitFor(() => turns().length === 2, '首屏应为 1 条 user + 1 条 assistant');
  assert.ok(transcriptText().includes('RELOAD-ASSIST-2'), '夹具：首屏 assistant 正文应渲染');

  state.page = {
    messages: [
      {
        id: '3',
        role: 'assistant',
        content: [{ type: 'text', text: 'RELOAD-ASSIST-3' }],
        timestamp: new Date(Date.UTC(2026, 10, 2, 0, 0, 3)).toISOString(),
      },
    ],
    blocks: [],
    hasMore: false,
  };
  await hana.loadHistory();
  await h.settle(6);

  assert.ok(
    transcriptText().includes('RELOAD-ASSIST-3'),
    `重载后的正文必须真的上屏（不能写进已被替换的旧节点），实际：${transcriptText()}`,
  );
  assert.equal(turns().length, 1, `重载后只应有一条 assistant 轮，实际 ${turns().length} 条`);
  assert.ok(!transcriptText().includes('RELOAD-ASSIST-2'), '重载应整页替换，旧一轮不能残留');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
