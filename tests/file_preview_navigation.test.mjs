/* 缺陷回归：文件卡的预览不能跨导航打开，也不能把旧错误报到新页面
 *
 * 根因：chat-renderer 的文件卡 onOpen 先 await fileUrls.forFile()，拿到地址后直接
 * openFilePreview()；失败也直接 flash()。等待期间用户可能已经切会话、返回列表或退出登录，
 * 晚到的结果属于旧页面：
 *   - 成功 → 在新会话/列表/登录页上弹出一个旧会话的预览；
 *   - 失败 → 向新页面报一条旧文件读不到的错误。
 * 另外 openSession 不清预览：已经打开的预览会一直盖在新会话上面。
 *
 * 锁的行为：
 *   1. 会话没变时点文件卡照常打开预览（保护性正例，不能被守卫误伤）；
 *   2. 地址解析开始时捕获会话与登录身份；await 之后两者任一变了就整份丢弃，
 *      成功不开预览、失败不 flash；
 *   3. 切会话时关闭已打开的预览。
 *
 * 只改 chat-renderer / conversation-controller 的行为，不引入新的跨模块状态框架：
 * 归属判据就是 app 里已有的 state.session 对象与 state.principal。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const SESS_A = { path: 'C:/sessions/preview-a', sessionId: 'sess-preview-a', title: '预览会话 A', agentId: 'agent-1' };
const SESS_B = { path: 'C:/sessions/preview-b', sessionId: 'sess-preview-b', title: '预览会话 B', agentId: 'agent-1' };

const stamp = (n) => new Date(Date.UTC(2026, 10, 2, 0, 0, n)).toISOString();

const PAGES = new Map([
  [SESS_A.sessionId, {
    messages: [
      { id: '1', role: 'user', content: 'A-用户', timestamp: stamp(1) },
      {
        id: '2',
        role: 'assistant',
        content: [{ type: 'text', text: 'A-助手' }],
        timestamp: stamp(2),
      },
    ],
    // 两张历史文件卡：一张只带 fileId（读得出来），一张连 fileId 都没有（解析会失败）。
    blocks: [
      { type: 'file', fileId: 'sf_a', label: 'a.txt', ext: 'txt', size: 2048, afterIndex: 1 },
      { type: 'file', label: 'b.txt', ext: 'txt', size: 10, afterIndex: 1 },
    ],
    hasMore: false,
  }],
  [SESS_B.sessionId, {
    messages: [{ id: '1', role: 'user', content: 'B-用户', timestamp: stamp(1) }],
    blocks: [],
    hasMore: false,
  }],
]);

/** 是否让 /api/studio/workspaces（文件地址解析的第一步）挂起。 */
const state = { holdRoots: false, pendingRoots: [], rootsCalls: 0 };

h.setFetch(async (url) => {
  const full = String(url);
  const path = full.split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions/messages') {
    const params = new URLSearchParams(full.split('?')[1] || '');
    return h.jsonRes(PAGES.get(params.get('sessionId')) || { messages: [], blocks: [], hasMore: false });
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  if (path === '/api/studio/workspaces') {
    state.rootsCalls += 1;
    if (state.holdRoots) {
      return new Promise((resolve) => {
        state.pendingRoots.push(resolve);
      });
    }
    // 空工作区列表：解析退到资源读地址（/api/resources/<fileId>/content），预览照样能开。
    return h.jsonRes({ ok: true, studioId: 'studio-1', workspaces: [] });
  }
  if (path.startsWith('/api/resources/')) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `RESOURCE-BODY ${path}`;
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  }
  throw new Error('unexpected fetch: ' + full);
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');
// 与 app 同一个模块实例：面板代次、root 都是共享的。
const { closeFilePreview } = await import('../web/file-preview.js');

const transcript = () => h.getEl('transcript');
const fileCards = () => h.findAll(transcript(), '.file-card');
const cardByLabel = (label) => fileCards().find((card) => h.textOf(card).includes(label)) || null;
const cardMain = (label) => {
  const card = cardByLabel(label);
  assert.ok(card, `夹具：应有 ${label} 的文件卡，实际 ${fileCards().length} 张`);
  const main = card.querySelector('.file-card-main');
  assert.ok(main, `夹具：${label} 的卡片正文应可点`);
  return main;
};
const previewRoot = () => h.doc.body.querySelector('.file-preview');
const previewOpen = () => {
  const root = previewRoot();
  return Boolean(root) && root.hidden === false;
};
const previewTitle = () => h.doc.body.querySelector('.file-preview-title')?.textContent || '';
const flashText = () => h.textOf(h.getEl('flashBar'));

async function releaseRoots() {
  assert.ok(state.pendingRoots.length > 0, '没有挂起中的取根请求可释放');
  const [resolve] = state.pendingRoots.splice(0, 1);
  resolve(h.jsonRes({ ok: true, studioId: 'studio-1', workspaces: [] }));
  await h.settle(6);
}

/**
 * 打开会话并等它稳定。
 *
 * 注意：openSession 内部会顺手取一次工作区根（模型 chip / 工作区入口那一套），
 * 所以每次点击前必须 resetFileRoots() 把这份缓存丢掉，否则 forFile 直接命中缓存，
 * 「地址解析还在路上」这个时序就造不出来。
 */
async function openSession(session, { expectCards = false } = {}) {
  await hana.openSession(session);
  await h.waitFor(() => S.session?.sessionId === session.sessionId, `应进入 ${session.title}`);
  await h.waitFor(() => h.textOf(transcript()).length > 0, `${session.title} 的历史应渲染`);
  if (expectCards) await h.waitFor(() => fileCards().length > 0, `${session.title} 的文件卡应渲染`);
}

/** 让下一次点击真的去解析地址（不用 openSession 期间留下的缓存），并把取根挂起。 */
async function holdNextResolution() {
  // 上一条用例失败的路径可能留下没释放的挂起请求，先放掉，避免串状态。
  while (state.pendingRoots.length) {
    state.pendingRoots.splice(0, 1)[0](h.jsonRes({ ok: true, studioId: 'studio-1', workspaces: [] }));
  }
  hana.resetFileRoots();
  state.holdRoots = true;
  await h.settle(2);
}

/** 一个可控 Promise：用来制造「解析已经出发、结果还没回来」的时序。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

await t('夹具：打开会话后历史里的文件卡（含无 fileId 的一张）都渲染出来', async () => {
  await openSession(SESS_A, { expectCards: true });
  assert.equal(fileCards().length, 2, `历史里的两张文件卡都应上屏，实际 ${fileCards().length}`);
  assert.ok(cardByLabel('a.txt'), '夹具：应有一张 a.txt');
  assert.ok(cardByLabel('b.txt'), '夹具：应有一张 b.txt');
  assert.equal(previewOpen(), false, '没点之前不该有预览');
});

await t('会话没变：点文件卡照常打开预览', async () => {
  closeFilePreview();
  hana.resetFileRoots();
  state.holdRoots = false;
  const before = state.rootsCalls;

  cardMain('a.txt').dispatchEvent('click');
  await h.settle(10);

  assert.ok(state.rootsCalls > before, '夹具：解析应真的走过工作区根');
  assert.equal(previewOpen(), true, '同一会话里点文件卡必须照常打开预览（守卫不能误伤正常路径）');
  assert.equal(previewTitle(), 'a.txt', `预览标题应是 a.txt，实际 ${previewTitle()}`);
  assert.ok(
    h.textOf(h.doc.body.querySelector('.file-preview-body')).includes('RESOURCE-BODY /api/resources/sf_a/content'),
    '正文应通过资源地址读进来',
  );
  closeFilePreview();
  assert.equal(previewOpen(), false, '夹具：关掉后预览应隐藏');
});

await t('解析等待时切会话：晚到的成功不能在新会话上打开预览', async () => {
  closeFilePreview();
  await openSession(SESS_A, { expectCards: true });
  await holdNextResolution();
  cardMain('a.txt').dispatchEvent('click');
  await h.waitFor(() => state.pendingRoots.length === 1, '文件地址解析应挂起');

  await openSession(SESS_B);
  assert.equal(previewOpen(), false, '夹具：切会话后预览应是关着的');

  state.holdRoots = false;
  await releaseRoots();

  assert.equal(S.session.sessionId, SESS_B.sessionId, '活动会话必须还是 B');
  assert.equal(previewOpen(), false, '旧会话迟到的地址解析不能在新会话上弹出预览');
});

await t('解析等待时返回列表：晚到的成功不能打开预览', async () => {
  closeFilePreview();
  await openSession(SESS_A, { expectCards: true });
  await holdNextResolution();
  cardMain('a.txt').dispatchEvent('click');
  await h.waitFor(() => state.pendingRoots.length === 1, '文件地址解析应挂起');

  assert.equal(hana.backToList(), true, '返回列表应被网页吃掉（聊天 → 列表）');
  assert.equal(S.session, null, '夹具：返回列表后没有活动会话');

  state.holdRoots = false;
  await releaseRoots();

  assert.equal(previewOpen(), false, '返回列表后迟到的地址解析不能弹出预览');
  assert.equal(S.session, null, '迟到的解析不能把用户拉回某个会话');
});

await t('已打开的预览在切会话时关闭', async () => {
  closeFilePreview();
  await openSession(SESS_A, { expectCards: true });
  hana.resetFileRoots();
  state.holdRoots = false;
  cardMain('a.txt').dispatchEvent('click');
  await h.settle(10);
  assert.equal(previewOpen(), true, '夹具：预览应已打开');

  await openSession(SESS_B);

  assert.equal(previewOpen(), false, '切会话必须关掉上一个会话的预览（不能盖在新会话上面）');
});

await t('地址解析真的 reject：迟到的失败不 flash；同一会话内失败照常提示', async () => {
  closeFilePreview();
  await openSession(SESS_A, { expectCards: true });

  const original = hana.fileUrls.forFile;
  const late = deferred();
  hana.fileUrls.forFile = () => late.promise;
  try {
    cardMain('a.txt').dispatchEvent('click');
    await h.settle(2);
    await openSession(SESS_B);
    late.reject(new Error('解析炸了'));
    await h.settle(10);

    assert.equal(previewOpen(), false, '迟到的解析失败不能打开预览');
    assert.ok(
      !flashText().includes('预览失败'),
      `切会话后不能把旧文件的解析失败报到新页面，实际提示：${flashText()}`,
    );
  } finally {
    hana.fileUrls.forFile = original;
  }

  // 反例控制：同一会话里真 reject 仍然要提示（守卫不能把真实错误吞掉）。
  await openSession(SESS_A, { expectCards: true });
  const failing = deferred();
  hana.fileUrls.forFile = () => failing.promise;
  try {
    cardMain('a.txt').dispatchEvent('click');
    await h.settle(2);
    failing.reject(new Error('解析炸了'));
    await h.settle(10);
    assert.ok(
      flashText().includes('预览失败: 解析炸了'),
      `同一会话里解析失败必须照常提示，实际：${flashText()}`,
    );
  } finally {
    hana.fileUrls.forFile = original;
  }
});

await t('解析等待时登出：晚到的失败不能向登录页报旧错误', async () => {
  closeFilePreview();
  await openSession(SESS_A, { expectCards: true });
  await holdNextResolution();
  // b.txt 没有 fileId：解析完成后拿不到任何读地址，走「打不开」的提示。
  cardMain('b.txt').dispatchEvent('click');
  await h.waitFor(() => state.pendingRoots.length === 1, '文件地址解析应挂起');

  hana.resetAfterLogout();
  assert.equal(S.principal, null, '夹具：登出后没有登录身份');

  state.holdRoots = false;
  await releaseRoots();

  assert.equal(previewOpen(), false, '登出后迟到的解析不能打开预览');
  assert.ok(
    !flashText().includes('这个文件暂时拿不到可读地址'),
    `登出后不能再报旧文件的错误，实际提示：${flashText()}`,
  );
});

/* ------------------------------------------------------------------ */

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
