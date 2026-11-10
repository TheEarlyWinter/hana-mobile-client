/* 缺陷 8 回归：会话文件下载在 WebView 里走不通
 *
 * 根因三处：
 *   1. fileHrefFor() 兜底成 /api/resources/<id>/content，而壳的下载白名单只放行
 *      /api/mobile/workspace/content（MainActivity.isWorkspaceContentUrl），点了必错；
 *   2. listRoots() 失败后把 [] 缓存住、fileRootsLoading 保持已完成，之后永不重试；
 *   3. 文件卡 / 工作区列表 / 预览各自用 <a download> 或裸导航，WebView 不认 download 属性。
 *
 * 锁的行为：只生成壳认的下载地址；拿不到工作区信息就明确降级（不给必错的入口）；
 * 取根失败允许重试、登录身份变化时作废缓存；三处下载统一走 download.js 一个入口。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

const state = {
  rootsFail: false,
  rootsCalls: 0,
  // 资源地址请求计数：文件卡再也不能自己按 fileId 去取缩略图（缺陷 H6e）
  resourceCalls: 0,
  roots: [{ mountId: 'mount-1', label: 'workspace', nativeRootPath: 'C:/work/workspace' }],
  // 需要观察「请求在途时 reset / 切身份」的用例，把下一次取根挂在这里。
  rootsQueue: [],
};

/** 让下一次取根挂起，由用例决定什么时候成功/失败。 */
function deferRoots() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  state.rootsQueue.push(() => promise);
  return {
    resolve: (payload) => resolve(h.jsonRes(payload)),
    reject: (err) => reject(err),
  };
}

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
  // 资源读地址：fetch 读，壳不拦；预览能不能打开就看这条能不能回。
  if (path.startsWith('/api/resources/')) {
    state.resourceCalls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() { return `RESOURCE-BODY ${path}`; },
      async arrayBuffer() { return new ArrayBuffer(0); },
    };
  }
  if (path === '/api/studio/workspaces') {
    state.rootsCalls += 1;
    if (state.rootsQueue.length) return state.rootsQueue.shift()();
    if (state.rootsFail) return h.jsonRes({ error: 'boom' }, { ok: false, status: 500 });
    return h.jsonRes({ ok: true, studioId: 'studio-1', workspaces: state.roots });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

const hana = await h.loadApp();
const S = hana.S;
/* 渲染进度袋：D2 起测试直接读它，S 上不再转发这些字段。 */
const R = hana?.rendererState || globalThis.__hana.rendererState;
await h.waitFor(() => S.currentAgent, 'boot 完成');

const DOWNLOAD_PREFIX = '/api/mobile/workspace/content';

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
/* 1. download.js：唯一入口 + 白名单                                    */
/* ------------------------------------------------------------------ */

await t('download.js：只对壳白名单内的同源地址发起导航', async () => {
  const { isMobileDownloadUrl, startDownload, MOBILE_DOWNLOAD_PATH } = await import('../web/download.js');

  assert.equal(MOBILE_DOWNLOAD_PATH, DOWNLOAD_PREFIX, '白名单路径必须与壳的 isWorkspaceContentUrl 一致');
  assert.equal(isMobileDownloadUrl(`${DOWNLOAD_PREFIX}?mountId=m&name=a.txt`), true, '工作区地址可下载');
  assert.equal(isMobileDownloadUrl('/api/resources/sf_1/content'), false, '资源地址壳不认，不能下载');
  assert.equal(isMobileDownloadUrl(`${DOWNLOAD_PREFIX}/`), false, '尾斜杠壳判否');
  assert.equal(isMobileDownloadUrl(`${DOWNLOAD_PREFIX}-old`), false, '前缀相同但路径不同壳判否');
  assert.equal(isMobileDownloadUrl(`${DOWNLOAD_PREFIX}?name=a#frag`), false, '带 fragment 壳判否');
  assert.equal(isMobileDownloadUrl('https://evil.example' + DOWNLOAD_PREFIX), false, '跨站地址一律拒绝');
  assert.equal(
    isMobileDownloadUrl(`http://localhost:8080${DOWNLOAD_PREFIX}?name=a.txt`),
    true,
    '同源绝对地址也可以',
  );

  globalThis.location.href = 'http://localhost:8080/';
  assert.equal(startDownload(`${DOWNLOAD_PREFIX}?mountId=m&name=a.txt`), true, '白名单地址应导航');
  assert.equal(globalThis.location.href, `${DOWNLOAD_PREFIX}?mountId=m&name=a.txt`, '下载必须靠导航实现');

  let rejected = null;
  assert.equal(
    startDownload('/api/resources/sf_1/content', { onReject: (u) => { rejected = u; } }),
    false,
    '非白名单地址不能导航',
  );
  assert.equal(rejected, '/api/resources/sf_1/content', '被拒绝时要回调给用户一句话');
  assert.equal(
    globalThis.location.href,
    `${DOWNLOAD_PREFIX}?mountId=m&name=a.txt`,
    '被拒绝的地址不能改掉当前页面地址',
  );
});

/* ------------------------------------------------------------------ */
/* 2. fileUrls：读地址永远尽量给，下载地址只给壳认的                    */
/* ------------------------------------------------------------------ */

await t('只有 fileId：readUrl 给资源地址、downloadUrl 为 null', async () => {
  S.session = { path: 'p-dl', sessionId: 's-dl', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = true;
  state.rootsCalls = 0;

  const { readUrl, downloadUrl } = await hana.fileUrls.forFile({ fileId: 'sf_1', label: 'a.docx', ext: 'docx' });
  assert.equal(downloadUrl, null, `没有工作区信息时不能给下载地址，实际 ${downloadUrl}`);
  assert.ok(
    String(downloadUrl ?? '').indexOf('/api/resources/') === -1,
    '下载地址绝不能是壳不认的 /api/resources',
  );
  assert.equal(readUrl, '/api/resources/sf_1/content', '只拿得到 fileId 时必须还能读（fetch 不是导航，壳不拦）');
  assert.equal(state.rootsCalls, 1, '应真的去问过一次工作区根');
});

await t('取根失败后允许重试，成功就给出两个地址', async () => {
  state.rootsFail = false;
  const file = {
    fileId: 'sf_2',
    filePath: 'C:/work/workspace/out/report.docx',
    label: 'report.docx',
    ext: 'docx',
  };
  const { readUrl, downloadUrl } = await hana.fileUrls.forFile(file);

  assert.ok(downloadUrl, '取根恢复后应能解析出下载地址');
  assert.ok(downloadUrl.startsWith(DOWNLOAD_PREFIX), `必须是壳认的下载地址，实际 ${downloadUrl}`);
  assert.ok(downloadUrl.includes('mountId=mount-1'), `地址要带工作区 mountId，实际 ${downloadUrl}`);
  assert.ok(downloadUrl.includes('subdir=out'), `地址要带相对子目录，实际 ${downloadUrl}`);
  assert.ok(downloadUrl.includes('name=report.docx'), `地址要带文件名，实际 ${downloadUrl}`);
  assert.equal(readUrl, downloadUrl, '能映射到工作区时读和下载用同一个地址');
  assert.equal(state.rootsCalls, 2, `失败那一次不能把空结果缓存住（应第二次真去请求），实际 ${state.rootsCalls} 次`);
});

await t('登录身份变化时作废工作区根缓存', async () => {
  const file = {
    fileId: 'sf_3',
    filePath: 'C:/work/workspace/out/report.docx',
    label: 'report.docx',
    ext: 'docx',
  };
  const before = state.rootsCalls;
  await hana.fileUrls.forFile(file);
  assert.equal(state.rootsCalls, before, '同一身份不该重复取根（缓存生效）');

  // 换一个人登录：上一个人的根不能继续用
  S.principal = { id: 'user-2' };
  state.roots = [{ mountId: 'mount-2', label: '别人的工作站', nativeRootPath: 'C:/work/workspace' }];
  const { downloadUrl } = await hana.fileUrls.forFile(file);
  assert.equal(state.rootsCalls, before + 1, '身份变化必须重新取根');
  assert.ok(downloadUrl.includes('mountId=mount-2'), `必须用新身份的根，实际 ${downloadUrl}`);

  S.principal = { id: 'user-1' };
  state.roots = [{ mountId: 'mount-1', label: 'workspace', nativeRootPath: 'C:/work/workspace' }];
  hana.resetFileRoots();
});

/* 根缓存绑定代次与身份：在途请求回来时，如果这中间 reset 过（退出 / 换登录），
 * 它带回的根与错误都属于上一回，不能写进现在的缓存。 */

const epochFile = {
  fileId: 'sf_epoch',
  filePath: 'C:/work/workspace/out/report.docx',
  label: 'report.docx',
  ext: 'docx',
};

await t('取根途中 reset：旧请求成功不能覆盖新缓存', async () => {
  S.principal = { id: 'user-1' };
  S.session = { path: 'p-epoch', sessionId: 's-epoch', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;

  const stale = deferRoots();
  const before = state.rootsCalls;
  const pendingA = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 1, 'A 的取根请求应已发出');

  hana.resetFileRoots();          // 退出登录 / 换身份：代次 +1
  state.roots = [{ mountId: 'mount-2', label: '新根', nativeRootPath: 'C:/work/workspace' }];
  const pendingB = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 2, 'B 的取根请求应已发出');
  const b = await pendingB;
  assert.ok(b.downloadUrl?.includes('mountId=mount-2'), `B 必须使用新根，实际 ${b.downloadUrl}`);

  // A 这才回来：它属于上一个代次，不能把缓存改回旧根。
  stale.resolve({
    ok: true,
    studioId: 'studio-1',
    workspaces: [{ mountId: 'mount-1', label: '旧根', nativeRootPath: 'C:/work/workspace' }],
  });
  await pendingA;

  const c = await hana.fileUrls.forFile(epochFile);
  assert.equal(state.rootsCalls, before + 2, '旧请求成功不能写缓存：第三次不该再取根');
  assert.ok(c.downloadUrl?.includes('mountId=mount-2'), `缓存必须仍是 B 的根，实际 ${c.downloadUrl}`);
  assert.equal(hana.fileUrls.getError(), '', '旧请求成功不能留下错误');
});

await t('取根途中 reset：旧请求失败不能写进新缓存或错误', async () => {
  S.principal = { id: 'user-1' };
  S.session = { path: 'p-epoch-fail', sessionId: 's-epoch-fail', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;

  const stale = deferRoots();
  const before = state.rootsCalls;
  const pendingA = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 1, 'A 的取根请求应已发出');

  hana.resetFileRoots();
  state.roots = [{ mountId: 'mount-2', label: '新根', nativeRootPath: 'C:/work/workspace' }];
  const pendingB = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 2, 'B 的取根请求应已发出');
  await pendingB;

  stale.reject(new Error('旧请求失败'));
  await pendingA;                 // 取根失败被 forFile 兜住，不该炸到调用方
  assert.equal(hana.fileUrls.getError(), '', '旧请求失败不能污染当前错误状态');

  const c = await hana.fileUrls.forFile(epochFile);
  assert.equal(state.rootsCalls, before + 2, '旧失败不能清掉 B 的缓存');
  assert.ok(c.downloadUrl?.includes('mountId=mount-2'), `缓存必须仍是 B 的根，实际 ${c.downloadUrl}`);
});

await t('reset 后没有新请求：旧成功也不能落进缓存', async () => {
  S.principal = null;             // 退出登录后 owner 为空
  S.session = { path: 'p-out', sessionId: 's-out', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;

  const stale = deferRoots();
  const before = state.rootsCalls;
  const pending = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 1, '取根请求应已发出');

  hana.resetFileRoots();          // 退出登录；之后没有新的取根请求
  stale.resolve({
    ok: true,
    studioId: 'studio-1',
    workspaces: [{ mountId: 'mount-stale', label: '旧根', nativeRootPath: 'C:/work/workspace' }],
  });
  await pending;

  state.roots = [{ mountId: 'mount-fresh', label: '新根', nativeRootPath: 'C:/work/workspace' }];
  const fresh = await hana.fileUrls.forFile(epochFile);
  assert.equal(state.rootsCalls, before + 2, 'reset 前的旧成功不能写缓存：下一次必须重新取根');
  assert.ok(fresh.downloadUrl?.includes('mountId=mount-fresh'), `必须用重新取到的根，实际 ${fresh.downloadUrl}`);
});

await t('取根途中换身份：旧身份的成功结果不能写进当前缓存', async () => {
  S.principal = { id: 'user-1' };
  S.session = { path: 'p-owner', sessionId: 's-owner', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;

  const stale = deferRoots();
  const before = state.rootsCalls;
  const pendingA = hana.fileUrls.forFile(epochFile);
  await h.waitFor(() => state.rootsCalls === before + 1, 'A 的取根请求应已发出');

  S.principal = { id: 'user-2' }; // 没走 reset，但 owner 已经换了
  state.roots = [{ mountId: 'mount-2', label: '别人的根', nativeRootPath: 'C:/work/workspace' }];
  const b = await hana.fileUrls.forFile(epochFile);
  assert.ok(b.downloadUrl?.includes('mountId=mount-2'), `B 必须用新身份的根，实际 ${b.downloadUrl}`);

  stale.resolve({
    ok: true,
    studioId: 'studio-1',
    workspaces: [{ mountId: 'mount-1', label: '旧身份的根', nativeRootPath: 'C:/work/workspace' }],
  });
  await pendingA;

  const c = await hana.fileUrls.forFile(epochFile);
  assert.equal(state.rootsCalls, before + 2, '旧身份的请求不能写缓存');
  assert.ok(c.downloadUrl?.includes('mountId=mount-2'), `缓存必须属于当前身份，实际 ${c.downloadUrl}`);

  S.principal = { id: 'user-1' };
  hana.resetFileRoots();
});

await t('等根期间切会话：旧文件不能用新会话的身份映射', async () => {
  S.principal = { id: 'user-1' };
  S.session = { path: 'p-old', sessionId: 's-old', agentId: 'agent-1' };  // 没有 workspaceMountId
  hana.resetFileRoots();
  state.rootsQueue.length = 0;
  state.rootsFail = true;          // 根取不到：只剩「按会话自带 mountId + 目录名反推」这条路

  const file = { fileId: 'sf_switch', filePath: 'C:/work/workspace/out/old.txt', label: 'old.txt', ext: 'txt' };
  const gate = deferRoots();
  const before = state.rootsCalls;
  const pending = hana.fileUrls.downloadUrlFor(file);
  await h.waitFor(() => state.rootsCalls === before + 1, '取根请求应已发出');

  // 等根回来的时候用户切到了另一个工作区会话
  S.session = {
    path: 'p-new',
    sessionId: 's-new',
    agentId: 'agent-1',
    workspaceMountId: 'mount-new',
    workspaceLabel: 'workspace',
  };
  gate.reject(new Error('boom'));
  const url = await pending;
  assert.equal(url, null, `旧会话没有工作区挂载点，不能借用新会话的 mountId，实际 ${url}`);

  // 正向对照：解析期间会话没变，等根回来仍能按 label 反推出地址。
  hana.resetFileRoots();
  S.session = {
    path: 'p-new2',
    sessionId: 's-new2',
    agentId: 'agent-1',
    workspaceMountId: 'mount-new2',
    workspaceLabel: 'workspace',
  };
  const gate2 = deferRoots();
  const pending2 = hana.fileUrls.downloadUrlFor(file);
  await h.waitFor(() => state.rootsCalls === before + 2, '第二次取根请求应已发出');
  gate2.reject(new Error('boom'));
  const url2 = await pending2;
  assert.ok(url2?.includes('mountId=mount-new2'), `同一会话应能反推出地址，实际 ${url2}`);

  state.rootsFail = false;
  hana.resetFileRoots();
});

/* 已完成缓存的 owner 与当前在途请求不是一回事：
 *   - A 缓存着根、隐式换 B 时，B 的请求还没回来，第二次调用不能拿 A 的根；
 *   - A1 在途 → B1 → A2 时，旧 A1 无论成功还是失败，都不能覆盖 A2 的缓存/错误。 */

await t('A 已有缓存、隐式换 B：B 在途时第二次调用不能拿 A 的 roots', async () => {
  S.principal = { id: 'user-A' };
  S.session = { path: 'p-owner-cache', sessionId: 's-owner-cache', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;
  state.roots = [{ mountId: 'mount-A', label: 'A 的根', nativeRootPath: 'C:/work/workspace' }];

  const cached = await hana.fileUrls.ensureRoots();
  assert.equal(cached[0].mountId, 'mount-A', '夹具：A 的根应已缓存');
  const before = state.rootsCalls;

  S.principal = { id: 'user-B' };          // 隐式换身份，没有 reset
  const gateB = deferRoots();
  const pendingB1 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === before + 1, 'B 的第一次取根应已发出');

  const pendingB2 = hana.fileUrls.ensureRoots();
  gateB.resolve({
    ok: true,
    studioId: 'studio-1',
    workspaces: [{ mountId: 'mount-B', label: 'B 的根', nativeRootPath: 'C:/work/workspace' }],
  });
  const [b1, b2] = await Promise.all([pendingB1, pendingB2]);
  assert.equal(b1[0].mountId, 'mount-B', 'B 的第一次请求应拿到 B 的根');
  assert.equal(b2[0].mountId, 'mount-B', `B 在途时第二次调用必须等同一次请求，实际 ${b2[0].mountId}`);
  assert.equal(state.rootsCalls, before + 1, '在途请求应该复用，不能另发一次');

  S.principal = { id: 'user-1' };
  hana.resetFileRoots();
});

await t('A1 → B1 → A2：迟到的旧 A1 成功不能覆盖 A2 的缓存', async () => {
  S.principal = { id: 'user-A' };
  S.session = { path: 'p-a1', sessionId: 's-a1', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;

  const calls = state.rootsCalls;
  const gateA1 = deferRoots();
  const pendingA1 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 1, 'A1 的取根应已发出');

  S.principal = { id: 'user-B' };
  const gateB1 = deferRoots();
  const pendingB1 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 2, 'B1 的取根应已发出');

  S.principal = { id: 'user-A' };
  const gateA2 = deferRoots();
  const pendingA2 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 3, 'A2 的取根应已发出');

  gateA2.resolve({ ok: true, studioId: 'studio-1', workspaces: [{ mountId: 'mount-A2', label: 'A2', nativeRootPath: 'C:/work/workspace' }] });
  await pendingA2;
  gateB1.resolve({ ok: true, studioId: 'studio-1', workspaces: [{ mountId: 'mount-B1', label: 'B1', nativeRootPath: 'C:/work/workspace' }] });
  await pendingB1;
  gateA1.resolve({ ok: true, studioId: 'studio-1', workspaces: [{ mountId: 'mount-A1', label: 'A1', nativeRootPath: 'C:/work/workspace' }] });
  await pendingA1;

  const current = await hana.fileUrls.ensureRoots();
  assert.equal(state.rootsCalls, calls + 3, '最终缓存应直接复用，不再取根');
  assert.equal(current[0].mountId, 'mount-A2', `迟到的旧 A1 不能覆盖 A2，实际 ${current[0].mountId}`);
  hana.resetFileRoots();
});

await t('A1 → B1 → A2：迟到的旧 A1 失败不能覆盖 A2 的缓存或错误', async () => {
  S.principal = { id: 'user-A' };
  S.session = { path: 'p-a1f', sessionId: 's-a1f', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = false;
  state.rootsQueue.length = 0;
  state.roots = [{ mountId: 'mount-fallback', label: '兜底', nativeRootPath: 'C:/work/workspace' }];

  const calls = state.rootsCalls;
  const gateA1 = deferRoots();
  const pendingA1 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 1, 'A1 的取根应已发出');

  S.principal = { id: 'user-B' };
  const gateB1 = deferRoots();
  const pendingB1 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 2, 'B1 的取根应已发出');

  S.principal = { id: 'user-A' };
  const gateA2 = deferRoots();
  const pendingA2 = hana.fileUrls.ensureRoots();
  await h.waitFor(() => state.rootsCalls === calls + 3, 'A2 的取根应已发出');

  gateA2.resolve({ ok: true, studioId: 'studio-1', workspaces: [{ mountId: 'mount-A2', label: 'A2', nativeRootPath: 'C:/work/workspace' }] });
  await pendingA2;
  gateB1.resolve({ ok: true, studioId: 'studio-1', workspaces: [{ mountId: 'mount-B1', label: 'B1', nativeRootPath: 'C:/work/workspace' }] });
  await pendingB1;
  gateA1.reject(new Error('A1 旧失败'));
  await assert.rejects(pendingA1, /A1 旧失败/, '旧调用方仍应拿到自己的失败');

  assert.equal(hana.fileUrls.getError(), '', '旧 A1 的失败不能写进当前错误');
  const current = await hana.fileUrls.ensureRoots();
  assert.equal(state.rootsCalls, calls + 3, '旧失败不能清掉 A2 的缓存，最终不该再取根');
  assert.equal(current[0].mountId, 'mount-A2', `A2 的缓存必须还在，实际 ${current[0].mountId}`);
  hana.resetFileRoots();
});

/* ------------------------------------------------------------------ */
/* 3. 文件卡：下载入口只在真能下的时候出现                               */
/* ------------------------------------------------------------------ */

await t('文件卡（只有 fileId）：正文能打开预览，右侧没有下载入口', async () => {
  S.session = { path: 'p-dl', sessionId: 's-dl', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = true;
  S.busy = false;
  R.turn = null;
  h.getEl('transcript').innerHTML = '';
  const { closeFilePreview } = await import('../web/file-preview.js');
  closeFilePreview();
  hana.startAssistantTurn();

  hana.handleEvent({
    type: 'content_block',
    block: { type: 'file', fileId: 'sf_9', label: 'nope.txt', ext: 'txt', sessionId: 's-dl', sessionPath: 'p-dl' },
    sessionId: 's-dl',
    sessionPath: 'p-dl',
  });
  await h.settle(6);

  const action = R.turnBody.querySelector('.file-card-action');
  assert.ok(action, '夹具：应渲染出文件卡');
  assert.equal(action.hidden, true, '没有白名单地址时不能给一个点了必错的下载入口');
  assert.equal(R.turnBody.querySelector('.file-card').dataset.href, undefined, '卡片上不该挂假地址');

  // 正文照旧可点开：读走资源地址（fetch），壳不拦
  R.turnBody.querySelector('.file-card-main').dispatchEvent('click');
  await h.settle(10);

  const title = h.doc.body.querySelector('.file-preview-title');
  assert.ok(title, '只拿得到 fileId 的文件也必须能打开预览（不能连读都没了）');
  assert.equal(title.textContent, 'nope.txt');
  assert.ok(
    h.textOf(h.doc.body.querySelector('.file-preview-body')).includes('RESOURCE-BODY /api/resources/sf_9/content'),
    `正文应通过资源地址读进来，实际：${h.textOf(h.doc.body.querySelector('.file-preview-body'))}`,
  );
  assert.equal(
    h.doc.body.querySelector('.file-preview-download'),
    null,
    '没有壳认的下载地址时，预览里也不能出现下载按钮',
  );
  closeFilePreview();
});

await t('文件卡（有工作区路径）：预览和下载入口都在', async () => {
  state.rootsFail = false;
  hana.resetFileRoots();
  h.getEl('transcript').innerHTML = '';
  R.turn = null;
  const { closeFilePreview } = await import('../web/file-preview.js');
  closeFilePreview();
  hana.startAssistantTurn();

  hana.handleEvent({
    type: 'content_block',
    block: {
      type: 'file',
      fileId: 'sf_10',
      filePath: 'C:/work/workspace/out/report.docx',
      label: 'report.docx',
      ext: 'docx',
      sessionId: 's-dl',
      sessionPath: 'p-dl',
    },
    sessionId: 's-dl',
    sessionPath: 'p-dl',
  });
  await h.settle(8);

  const card = R.turnBody.querySelector('.file-card');
  assert.ok(card, '夹具：应渲染出文件卡');
  assert.ok(
    String(card.dataset.href || '').startsWith(DOWNLOAD_PREFIX),
    `卡片下载地址必须是壳认的地址，实际 ${card.dataset.href}`,
  );
  const action = card.querySelector('.file-card-action');
  assert.equal(action.hidden, false, '有地址时应显示下载按钮');

  // 点下载：走 download.js，导航到白名单地址
  globalThis.location.href = 'http://localhost:8080/';
  action.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(globalThis.location.href, card.dataset.href, '下载必须走统一的导航入口');

  // 点正文：预览走同一个工作区地址（fetch），且预览里有下载按钮
  card.querySelector('.file-card-main').dispatchEvent('click');
  await h.settle(10);
  const title = h.doc.body.querySelector('.file-preview-title');
  assert.equal(title?.textContent, 'report.docx');
  const dl = h.doc.body.querySelector('.file-preview-download');
  assert.ok(dl, '有工作区地址时预览里也应有下载按钮');
  closeFilePreview();
});

/* ------------------------------------------------------------------ */
/* 3b. 缺陷 H6e：缩略图只走 /gw/file，没有真实路径就不发请求             */
/* ------------------------------------------------------------------ */

/** 开一轮并画一张文件卡；工作区映射故意失败，看的就是条目自己的地址。 */
async function drawCard(block) {
  S.session = { path: 'p-thumb', sessionId: 's-thumb', agentId: 'agent-1' };
  hana.resetFileRoots();
  state.rootsFail = true;
  S.busy = false;
  R.turn = null;
  h.getEl('transcript').innerHTML = '';
  const { closeFilePreview } = await import('../web/file-preview.js');
  closeFilePreview();
  hana.startAssistantTurn();
  hana.handleEvent({
    type: 'content_block',
    block: { ...block, sessionId: 's-thumb', sessionPath: 'p-thumb' },
    sessionId: 's-thumb',
    sessionPath: 'p-thumb',
  });
  await h.settle(8);
  const card = R.turnBody.querySelector('.file-card');
  assert.ok(card, `夹具：应渲染出文件卡，block=${JSON.stringify(block)}`);
  return card;
}

/** web/file-urls.js 的 b64url（URL 安全、无填充） */
const gwFileUrl = (p) => `/gw/file/${Buffer.from(p, 'utf8').toString('base64url')}`;

await t('图片卡（有 filePath）：缩略图走 /gw/file，不碰宿主的资源地址', async () => {
  const before = state.resourceCalls;
  const pic = 'C:/work/workspace/pics/p.png';
  const card = await drawCard({ type: 'file', fileId: 'sf_pic', filePath: pic, label: 'p.png', ext: 'png' });

  const img = card.querySelector('.file-card-icon img');
  assert.ok(img, '有真实路径的图片应该有缩略图');
  assert.equal(img.src, gwFileUrl(pic), '缩略图必须走正文图片用的那条 /gw/file 路由');
  assert.equal(card.querySelector('.file-card-icon').textContent, '', '有缩略图时不再叠扩展名文字');
  assert.equal(state.resourceCalls, before, '画卡片本身不能去请求 /api/resources/…（H6e 的 400）');
});

await t('图片卡（只有 fileId）：不画 img、不发请求，只给扩展名徽标', async () => {
  const before = state.resourceCalls;
  const card = await drawCard({ type: 'file', fileId: 'sf_pic2', label: '图片.png', ext: 'png' });

  // 布尔断言：直接拿假 DOM 节点跟 null 比，失败时 assert 会把整棵树展开成报错文本（夹具里极慢）。
  assert.equal(Boolean(card.querySelector('img')), false, '没有真实路径就不能猜一个地址去取缩略图');
  assert.equal(card.querySelector('.file-card-icon').textContent, 'PNG', '应回到扩展名徽标');
  assert.equal(state.resourceCalls, before, '没有 filePath 时一个请求也不该发');
});

await t('缩略图取不到（删除/403）：换回扩展名徽标，不留破图', async () => {
  const card = await drawCard({
    type: 'file', fileId: 'sf_pic3', filePath: 'C:/work/workspace/pics/gone.jpg', label: 'gone.jpg', ext: 'jpg',
  });
  const img = card.querySelector('.file-card-icon img');
  assert.ok(img, '夹具：先有缩略图');

  img.dispatchEvent('error');
  assert.equal(Boolean(card.querySelector('.file-card-icon img')), false, '加载失败后不该还挂着 <img>');
  assert.equal(card.querySelector('.file-card-icon').textContent, 'JPG', '应显示扩展名徽标');
});

/* ------------------------------------------------------------------ */
/* 4. 工作区列表 / 预览下载也走同一个入口                                  */
/* ------------------------------------------------------------------ */

await t('工作区列表与预览的下载都走统一入口（不再裸用 <a download>）', async () => {
  const { createWorkspaceView } = await import('../web/workspace-view.js');
  const downloads = [];
  const toasts = [];
  const service = {
    async list() {
      return { ok: true, files: [{ name: 'report.bin', isDir: false, size: 12 }] };
    },
    downloadUrl(_context, { name }) {
      return `${DOWNLOAD_PREFIX}?mountId=mount-1&name=${encodeURIComponent(name)}`;
    },
    async readTextPreview() {
      return { ok: true, text: '', truncated: false };
    },
  };
  const view = createWorkspaceView({
    service,
    document: h.doc,
    toast: (msg) => toasts.push(msg),
    download: (url) => { downloads.push(url); return true; },
  });

  await view.open({ mountId: 'default', agentId: 'agent-1' });
  const link = h.doc.body.querySelector('.workspace-download-link');
  assert.ok(link, '夹具：工作区列表应渲染出下载链接');
  link.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(downloads.length, 1, '列表的下载必须走注入的统一入口');
  assert.ok(downloads[0].startsWith(DOWNLOAD_PREFIX), `列表下载地址必须是壳认的，实际 ${downloads[0]}`);

  await view.previewFile('report.bin');
  const previewBtn = h.doc.body.querySelector('.workspace-preview-unsupported a.workspace-upload-btn');
  assert.ok(previewBtn, '夹具：不支持的格式应给出下载按钮');
  previewBtn.dispatchEvent('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(downloads.length, 2, '预览里的下载也必须走同一个入口');
  assert.equal(downloads[1], downloads[0], '两处下载地址应一致（同一个 downloadUrl）');
  view.close();
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
