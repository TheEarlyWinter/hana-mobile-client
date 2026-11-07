/* 草稿落盘（B2）在装配层的行为回归。
 *
 * 纯模块（web/draft-store.js）自己已有 19 条测试，这里只锁「app.js 真的接上了」：
 * 输入会落盘、按返回会立刻落盘、换会话会把对应草稿填回来。
 * 这几条一旦失效，用户感知就是「我打了一半的字没了」。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 假 localStorage：app.js 的 createDraftStore() 不注入 storage，读的是 globalThis.localStorage。
 * 必须在 loadApp() 之前装好。 */
const backing = new Map();
globalThis.localStorage = {
  getItem: (key) => (backing.has(key) ? backing.get(key) : null),
  setItem: (key, value) => {
    backing.set(key, String(value));
  },
  removeItem: (key) => {
    backing.delete(key);
  },
  clear: () => backing.clear(),
  key: (index) => [...backing.keys()][index] ?? null,
  get length() {
    return backing.size;
  },
};

const DRAFT_KEY = 'hana.drafts.v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function savedDrafts() {
  const raw = backing.get(DRAFT_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.drafts ? parsed.drafts : {};
  } catch {
    return {};
  }
}

const h = createHarness();

const sessionA = {  path: 'C:/sessions/draft-a.jsonl',
  sessionId: 'sess-a',
  title: '会话 A',
  agentId: 'agent-1',
  namespace: 'home',
};
const sessionB = {
  path: 'C:/sessions/draft-b.jsonl',
  sessionId: 'sess-b',
  title: '会话 B',
  agentId: 'agent-1',
  namespace: 'home',
};
// 没有任何草稿的会话：切过去时输入框必须是空串，不能留着上一个会话的字。
const sessionC = {
  path: 'C:/sessions/draft-c.jsonl',
  sessionId: 'sess-c',
  title: '会话 C',
  agentId: 'agent-1',
  namespace: 'home',
};
// 首页发送建出来的新会话（首页输入框的内容会移交给它）。
const sessionHandoff = {
  path: 'C:/sessions/home-handoff.jsonl',
  sessionId: 'sess-handoff',
  title: '新对话',
  agentId: 'agent-1',
  namespace: 'home',
};

// 预先给会话 B 存一份草稿。必须在 loadApp 之前写：draft-store 在构造时读一次盘，
// 这正好模拟「上次开着 App 时存的草稿，这次启动还在」。
backing.set(DRAFT_KEY, JSON.stringify({
  version: 1,
  drafts: {
    [sessionB.path]: { text: 'B 的草稿', savedAt: Date.now() },
    // 首页大输入岛自己的草稿：启动时会填进 homeInput；聊天框首次打开会话不能把它删掉。
    home: { text: '首页启动恢复的草稿', savedAt: Date.now() },
  },
}));

const defaultFetch = async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: '助手1' }],
      currentAgent: { id: 'agent-1', name: '助手1' },
      sessions: [sessionA, sessionB, sessionC],
      homeFolder: 'C:/work',
      auth: { token: 't-1' },
    });
  }
  if (path === '/api/sessions/new') {
    return h.jsonRes(sessionHandoff);
  }
  if (path.startsWith('/api/sessions/list') || path === '/api/sessions') {
    return h.jsonRes({ ok: true, sessions: [sessionA, sessionB, sessionC] });
  }
  if (path.includes('/entries')) return h.jsonRes({ entries: [], hasMore: false });
  return h.jsonRes({});
};

h.setFetch(defaultFetch);

const hana = await h.loadApp();const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

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

await t('启动时恢复的首页草稿：首次打开会话不能被空聊天框删掉', async () => {
  const homeInput = h.getEl('homeInput');
  assert.equal(homeInput.value, '首页启动恢复的草稿', '夹具：启动时首页输入显示了已持久化的草稿');
  assert.equal(savedDrafts().home?.text, '首页启动恢复的草稿', '夹具：首页草稿已持久化');

  await openAndWait(sessionA);

  assert.equal(h.getEl('input').value, '', '聊天框不能把首页草稿当成自己的草稿');
  assert.equal(homeInput.value, '首页启动恢复的草稿', '首页输入框自己的草稿不能被聊天框接管');
  assert.equal(
    savedDrafts().home?.text,
    '首页启动恢复的草稿',
    '首次打开会话不能把独立首页输入框的持久化草稿删掉',
  );
});

await t('打字 400ms 后落盘到当前会话的草稿键下', async () => {
  await hana.openSession(sessionA);
  const input = h.getEl('input');
  input.value = '写到一半的话';
  input.dispatchEvent('input', { target: input });
  await sleep(520);
  const drafts = savedDrafts();
  assert.equal(drafts[sessionA.path]?.text, '写到一半的话', '草稿应写在会话 A 的 path 下');
});

await t('按返回时立刻落盘（不等防抖）', async () => {
  const input = h.getEl('input');
  input.value = '按下就走的字';
  input.dispatchEvent('input', { target: input });
  // 不等待，直接按返回：防抖还没到点
  const handled = window.HanaMobile.back();
  assert.equal(handled, true, '聊天页返回应被页面自己处理');
  assert.equal(savedDrafts()[sessionA.path]?.text, '按下就走的字', '返回时必须已经落盘');
});

await t('切到另一个会话后，把那个会话的草稿填回输入框', async () => {
  const input = h.getEl('input');
  input.value = '';
  await hana.openSession(sessionB);
  await h.waitFor(() => S.session?.path === sessionB.path, '切到会话 B');
  assert.equal(input.value, 'B 的草稿', '切进 B 应恢复 B 的草稿');
});

/* ------------------------------------------------------------------ */
/* 会话切换时的草稿归属                                                */
/*                                                                     */
/* 契约：输入框里的字始终属于 draftKey 指向的那个会话。换会话时必须先  */
/* 把旧字记到旧会话键下，再换成目标会话的草稿（没有草稿就是空串）。     */
/* 错法（修复前）：只落盘、不清输入框，也不管输入框非空就不填，于是    */
/* A 的字留在 B 的输入框里，下一笔输入把两边草稿混在一起。              */
/* ------------------------------------------------------------------ */

async function openAndWait(session) {
  await hana.openSession(session);
  await h.waitFor(() => S.session?.path === session.path, `切到 ${session.title}`);
}

/** 在当前会话里写一段字，并可选等防抖真落盘（每一例自己铺自己的前置状态）。 */
async function typeDraft(session, text, { settle = true } = {}) {
  await openAndWait(session);
  const input = h.getEl('input');
  input.value = text;
  input.dispatchEvent('input', { target: input });
  if (settle) await sleep(520);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function backToListIfNeeded() {
  if (h.getEl('view-chat').hidden === false) {
    assert.equal(h.window.HanaMobile.back(), true, '聊天页返回应被页面自己处理');
  }
}

/** 首页发送并发出一帧：返回实际写帧的那条连接。 */
async function startHomeSendAndOpenWs() {
  const before = h.MockWebSocket.instances.length;
  const pending = hana.sendFromHome();
  await h.waitFor(() => h.MockWebSocket.instances.length > before, '首页发送打开了新连接');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();
  await pending;
  return ws;
}

function lastPromptText(ws) {
  const prompts = ws.frames('prompt');
  return prompts.length ? prompts[prompts.length - 1].text : null;
}

await t('B 有未落盘的输入，直接打开 A：显示 A 的草稿，B 的字留在 B 的键下', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionA, 'A 的草稿');
  await typeDraft(sessionB, 'B 的旧草稿');
  // 不等防抖，直接切会话：这一笔只能记在 B 名下。
  input.value = 'B 的未落盘输入';
  input.dispatchEvent('input', { target: input });

  await openAndWait(sessionA);

  assert.equal(input.value, 'A 的草稿', '切到 A 必须显示 A 的草稿，不能留着 B 的文字');
  assert.equal(savedDrafts()[sessionB.path]?.text, 'B 的未落盘输入', '切换时必须先把 B 未落盘的输入存回 B');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 的草稿', 'A 的草稿不能被 B 覆盖');
});

await t('A 有未落盘的输入，打开没有草稿的 C：C 是空串，A 的字落到 A 键下', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionA, 'A 的旧草稿');
  input.value = 'A 的未落盘输入';
  input.dispatchEvent('input', { target: input });
  await openAndWait(sessionC);

  assert.equal(input.value, '', 'C 没有草稿，输入框必须是空串而不是 A 的文字');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 的未落盘输入', '切换时必须先把 A 未落盘的输入存回 A');
  assert.equal(savedDrafts()[sessionC.path], undefined, 'C 不能因此多出一份草稿');
});

await t('防抖已落盘后再切：A 的字不会进入 C', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionA, 'A 已落盘');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 已落盘', '夹具：A 的草稿已落盘');

  await openAndWait(sessionC);

  assert.equal(input.value, '', '落盘后再切会话，C 的输入框也必须是空串');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 已落盘', 'A 的草稿不能被切换动作改写');
});

await t('C 有自己的草稿：切回 C 显示 C 的草稿，再回 A 时 A 的字还在', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionA, 'A 的草稿');
  await typeDraft(sessionC, 'C 自己的草稿');
  await openAndWait(sessionA);
  await openAndWait(sessionC);
  assert.equal(input.value, 'C 自己的草稿', '两次切换后 C 仍应显示自己的草稿');

  await openAndWait(sessionA);
  assert.equal(input.value, 'A 的草稿', '回到 A 必须恢复 A 的草稿');
  assert.equal(savedDrafts()[sessionC.path]?.text, 'C 自己的草稿', 'C 的草稿必须原样保留');
});

await t('同会话重开保留刚输入的字，不被旧草稿覆盖', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionA, 'A 的旧草稿');
  input.value = '刚补的一句';
  input.dispatchEvent('input', { target: input });
  await openAndWait(sessionA);

  assert.equal(input.value, '刚补的一句', '同一个会话重开，输入框里的新字不能拿旧草稿盖掉');
  await sleep(520);
  assert.equal(savedDrafts()[sessionA.path]?.text, '刚补的一句', '重开后防抖落盘仍写在 A 名下');
});

await t('返回列表再进入：B 显示 B 的草稿，再回 A 时 A 的字还在', async () => {
  const input = h.getEl('input');

  await typeDraft(sessionB, 'B 的草稿');
  await typeDraft(sessionA, 'A 的旧草稿');
  input.value = 'A 返回前的字';
  input.dispatchEvent('input', { target: input });
  assert.equal(h.window.HanaMobile.back(), true, '聊天页返回应被页面自己处理');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 返回前的字', '返回列表时 A 的字必须已落盘');

  await openAndWait(sessionB);
  assert.equal(input.value, 'B 的草稿', '从列表进入 B 必须显示 B 的草稿');

  await openAndWait(sessionA);
  assert.equal(input.value, 'A 返回前的字', '再回 A 时 A 的字必须还在');
});

await t('首页发送：移交给新会话的文字不会被草稿恢复覆盖', async () => {
  const input = h.getEl('input');
  const homeInput = h.getEl('homeInput');

  await typeDraft(sessionA, 'A 的旧草稿');
  input.value = 'A 留给自己的草稿';
  input.dispatchEvent('input', { target: input });
  assert.equal(h.window.HanaMobile.back(), true, '先退回列表，再从首页发送');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 留给自己的草稿', '夹具：A 的新草稿已落盘');

  const wsBefore = h.MockWebSocket.instances.length;
  homeInput.value = '首页要发的话';
  const pending = hana.sendFromHome();
  await h.waitFor(() => h.MockWebSocket.instances.length > wsBefore, '首页发送打开了新连接');
  const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
  ws.open();
  await pending;

  const prompts = ws.frames('prompt');
  assert.equal(prompts.length, 1, `应只发出一条 prompt，实际 ${prompts.length} 条`);
  assert.equal(prompts[0].text, '首页要发的话', '移交的文字必须原样发出，不能被上一会话的草稿顶掉或拼接');
  assert.equal(input.value, '', '发出去之后聊天输入框应清空');
  assert.equal(homeInput.value, '', '安全移交后首页输入框应清空');
  // 首页输入框没有自己的防抖在跑（用例直接赋值，没有 input 事件）：
  // 只要首页草稿里出现这句话，就说明切换会话时顺手把首页输入也落盘了，
  // 下次启动会从草稿里把已经发出去的首页文字又复活到输入框。
  assert.equal(savedDrafts().home, undefined, '会话切换不该把即将移交的首页文字写成首页草稿');
  assert.equal(savedDrafts()[sessionA.path]?.text, 'A 留给自己的草稿', '首页发送不能改写 A 的草稿');
  assert.equal(savedDrafts()[sessionHandoff.path], undefined, '新会话不该凭空多出一份草稿');
});

await t('首页草稿已防抖落盘：发送成功后存储被清掉，过了防抖时间也不复活', async () => {
  backToListIfNeeded();
  const homeInput = h.getEl('homeInput');

  homeInput.value = '已落盘的首页草稿';
  homeInput.dispatchEvent('input', { target: homeInput });
  await sleep(520);
  assert.equal(savedDrafts().home?.text, '已落盘的首页草稿', '夹具：首页草稿已落盘');

  const ws = await startHomeSendAndOpenWs();

  assert.equal(lastPromptText(ws), '已落盘的首页草稿', '首页文字必须原样发出');
  assert.equal(homeInput.value, '', '安全移交后首页输入框应清空');
  assert.equal(savedDrafts().home, undefined, '成功移交后不能留着已发送的首页草稿');
  await sleep(520);
  assert.equal(savedDrafts().home, undefined, '过了原防抖时间也不能把已发送的文字复活');
});

await t('等待期间首页输入新内容：新内容保留，草稿切到新内容', async () => {
  backToListIfNeeded();
  const homeInput = h.getEl('homeInput');

  homeInput.value = '发送时的首页文字';
  homeInput.dispatchEvent('input', { target: homeInput });
  await sleep(520);
  assert.equal(savedDrafts().home?.text, '发送时的首页文字', '夹具：首页草稿已落盘');

  const gate = deferred();
  let createStarted = false;
  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/new') {
      createStarted = true;
      return gate.promise;
    }
    return defaultFetch(url, init);
  });

  try {
    const wsBefore = h.MockWebSocket.instances.length;
    const pending = hana.sendFromHome();
    await h.waitFor(() => createStarted, '会话创建请求已发出');

    homeInput.value = '等待期间新输入';
    homeInput.dispatchEvent('input', { target: homeInput });

    gate.resolve(h.jsonRes(sessionHandoff));
    // 等移交真的发生（聊天输入框拿到发出时那份），此时结算应已执行。
    await h.waitFor(() => h.getEl('input').value === '发送时的首页文字', '首页文字已移交');
    assert.equal(
      savedDrafts().home?.text,
      '等待期间新输入',
      '成功移交后首页草稿必须切到新输入，不能留着已发送的旧文字',
    );

    await h.waitFor(() => h.MockWebSocket.instances.length > wsBefore, '首页发送打开了新连接');
    const ws = h.MockWebSocket.instances[h.MockWebSocket.instances.length - 1];
    ws.open();
    await pending;

    assert.equal(lastPromptText(ws), '发送时的首页文字', '发出的仍是发起时那份文字');
    assert.equal(homeInput.value, '等待期间新输入', '等待期间的新输入不能被清掉');
    await sleep(520);
    assert.equal(savedDrafts().home?.text, '等待期间新输入', '新输入继续作为首页草稿保留');
  } finally {
    h.setFetch(defaultFetch);
  }
});

await t('首页发送失败：首页输入与已落盘草稿都保留', async () => {
  backToListIfNeeded();
  const homeInput = h.getEl('homeInput');

  homeInput.value = '失败要保留的首页草稿';
  homeInput.dispatchEvent('input', { target: homeInput });
  await sleep(520);
  assert.equal(savedDrafts().home?.text, '失败要保留的首页草稿', '夹具：首页草稿已落盘');

  h.setFetch(async (url, init = {}) => {
    const path = String(url).split('?')[0];
    if (path === '/api/sessions/new') {
      return h.jsonRes({ error: 'create down' }, { ok: false, status: 500 });
    }
    return defaultFetch(url, init);
  });

  try {
    await hana.sendFromHome();
    assert.equal(homeInput.value, '失败要保留的首页草稿', '失败后首页输入必须保留');
    assert.equal(savedDrafts().home?.text, '失败要保留的首页草稿', '失败后首页草稿必须保留');
    assert.equal(h.getEl('view-chat').hidden, true, '失败时不得进入聊天页');
  } finally {
    h.setFetch(defaultFetch);
  }
});

await t('退登会清掉所有草稿（不把上家的字留给下一个人）', async () => {
  await hana.resetAfterLogout();
  assert.deepEqual(savedDrafts(), {}, '登出后草稿库应为空');
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
