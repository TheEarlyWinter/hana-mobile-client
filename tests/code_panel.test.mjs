/* 仓库现状面板测试（web/code-panel.js）
 *
 * 跑法：node tests/code_panel.test.mjs
 *
 * 假 DOM 复用 tests/support/app_harness.mjs；api / getSession 都是注入的依赖，所以整条
 * 「打开 → 串行拉四类数据 → 渲染 → 点文件看 diff → 关闭」都能在 Node 里跑，不用真网络。
 *
 * 覆盖：正常数据三块都渲染、isMain/isCurrent 标记、isRepository:false、缺 cwd/sessionId
 * 不发请求、单块 500 不牵连其它块、403 说成「权限」而不是「加载失败」、点文件拉 diff
 * 且参数正确、omitted（binary / too-large）、串行与逐块加载态、刷新、重复 open 不叠 DOM、
 * close 幂等、Esc / 点背景 / 返回、纯函数判定表。
 */

import { createHarness } from './support/app_harness.mjs';
import {
  createCodePanel,
  changeStatusLabel,
  describeCodeError,
  describeStatus,
} from '../web/code-panel.js';

const h = createHarness();
const { doc } = h;

const rejections = [];
process.on('unhandledRejection', (err) => rejections.push(err));

let bad = 0;
const panels = [];

function makeMount() {
  const mount = doc.createElement('div');
  mount.className = 'cp-test-mount';
  doc.body.appendChild(mount);
  return mount;
}

function cleanupDom() {
  for (const panel of panels.splice(0)) {
    try {
      panel.close();
    } catch {
      // 清理失败不掩盖真正的断言失败
    }
  }
  for (const node of doc.body.querySelectorAll('.code-panel-root')) node.remove();
  for (const node of doc.body.querySelectorAll('.cp-test-mount')) node.remove();
}

async function runCheck(name, fn) {
  cleanupDom();
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
  cleanupDom();
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || '值'}不相等\n      期望 ${e}\n      实际 ${a}`);
}

function assertIncludes(text, part, label) {
  const haystack = String(text == null ? '' : text);
  if (!haystack.includes(part)) {
    throw new Error(`${label || '文本'}里没有「${part}」\n      实际 ${JSON.stringify(haystack)}`);
  }
}

const hasChinese = (value) => /[\u4e00-\u9fa5]/.test(String(value || ''));

/* ---------------------------- 夹具 ---------------------------- */

const CWD = 'C:\\work\\hana-mobile';
const SESSION = { sessionId: 'sess-1', cwd: CWD };

const REPO = {
  branches: { isRepository: true, current: 'main', branches: ['main', 'dev', 'feat/x'] },
  worktrees: {
    isRepository: true,
    repoRoot: 'C:\\work\\hana-mobile',
    currentWorktreePath: 'C:\\work\\hana-mobile',
    hasCommits: true,
    worktrees: [
      {
        path: 'C:\\work\\hana-mobile',
        branch: 'main',
        isMain: true,
        isCurrent: true,
        exists: true,
        locked: false,
        prunable: false,
      },
      {
        path: 'C:\\work\\hana-mobile-wt',
        branch: 'dev',
        isMain: false,
        isCurrent: false,
        exists: true,
        locked: true,
        prunable: true,
      },
    ],
  },
  status: {
    isRepository: true,
    branch: 'main',
    detached: false,
    upstream: 'origin/main',
    baseBranch: 'master',
    ahead: 2,
    behind: 0,
    changedFileCount: 3,
  },
  changes: {
    isRepository: true,
    files: [
      { path: 'web/code-panel.js', status: 'modified', additions: 120, deletions: 3, staged: false },
      { path: 'docs/new.md', status: 'untracked', additions: 0, deletions: 0, staged: false },
      { path: 'web/old.js', status: 'deleted', additions: 0, deletions: 40, staged: true },
    ],
  },
};

/** 从 URL 里认块名：/api/code/branches?cwd=... → branches */
function routeKey(url) {
  const match = /\/api\/code\/([a-z]+)/.exec(String(url));
  return match ? match[1] : '';
}

function httpError(status, message, body) {
  const err = new Error(`${status} ${message}`);
  err.status = status;
  err.body = body;
  return err;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 假 api：按块名路由；值可以直接给数据、给函数（自己返回 / 抛错）、给 Error（直接抛）。
 * 记下每次调用的完整参数，方便断言「没发 POST、没多传参数」。
 */
function makeApi(routes = {}) {
  const calls = [];
  const args = [];
  const api = async (...passed) => {
    const [url] = passed;
    calls.push(String(url));
    args.push(passed);
    const key = routeKey(url);
    const handler = routes[key];
    if (handler === undefined) throw new Error(`没有为 ${key || url} 准备响应`);
    if (typeof handler === 'function') return handler(url);
    if (handler instanceof Error) throw handler;
    return handler;
  };
  api.calls = calls;
  api.args = args;
  return api;
}

/**
 * 包一层 document，只为了拿到 keydown 监听。
 *
 * 假 DOM 的 document.dispatchEvent 只转交 { type, target }，extra 里的 key 会被丢掉
 * （tests/support/app_harness.mjs 的 fireDocument 因此送不到 Esc）。这里不改进共享夹具，
 * 而是在用例里记录面板注册的监听，再按浏览器的方式调一次。
 */
function makeDocWithKeyEvents() {
  const handlers = [];
  const proxy = Object.create(doc);
  proxy.addEventListener = (type, fn) => {
    if (type === 'keydown' && !handlers.includes(fn)) handlers.push(fn);
    doc.addEventListener(type, fn);
  };
  proxy.removeEventListener = (type, fn) => {
    const index = handlers.indexOf(fn);
    if (index !== -1) handlers.splice(index, 1);
    doc.removeEventListener(type, fn);
  };
  proxy.fireKey = (key) => {
    for (const fn of [...handlers]) {
      fn({ type: 'keydown', key, preventDefault() {}, stopPropagation() {} });
    }
  };
  proxy.listenerCount = () => handlers.length;
  return proxy;
}

function makePanel(api, getSession = () => SESSION, docOverride = doc) {
  const mount = docOverride.createElement('div');
  mount.className = 'cp-test-mount';
  doc.body.appendChild(mount);
  const panel = createCodePanel({ doc: docOverride, mount, api, getSession });
  panels.push(panel);
  return { panel, mount };
}

const rootOf = (mount) => mount.querySelector('.code-panel-root');
const textOf = (mount) => h.textOf(rootOf(mount));
const bodiesOf = (mount) => mount.querySelectorAll('.code-panel-section-body');

/* ---------------------------- 用例 ---------------------------- */

await runCheck('正常数据：仓库根 / 分支 / 工作树 / 改动三块都渲染，标记齐全', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  // 四个请求都发了，参数与文档一致
  assertEqual(api.calls.length, 4, '请求数量');
  assertEqual(
    api.calls.filter((url) => url === `/api/code/branches?cwd=${encodeURIComponent(CWD)}`).length,
    1,
    'branches 请求'
  );
  assertEqual(
    api.calls.filter((url) => url === `/api/code/worktrees?cwd=${encodeURIComponent(CWD)}`).length,
    1,
    'worktrees 请求'
  );
  assertEqual(
    api.calls.filter((url) => url === '/api/code/status?sessionId=sess-1').length,
    1,
    'status 请求'
  );
  assertEqual(
    api.calls.filter((url) => url === '/api/code/changes?sessionId=sess-1').length,
    1,
    'changes 请求'
  );
  // 只发 GET 式 JSON 请求：每次只传一个 URL，没有 method / body
  assert(api.args.every((passed) => passed.length === 1), '不应给 api 传第二个参数（不是 POST）');

  const text = textOf(mount);
  assertIncludes(text, '仓库根', '摘要标签');
  assertIncludes(text, CWD, '仓库根路径');
  assertIncludes(text, 'main', '当前分支');
  assertIncludes(text, '领先 2 / 落后 0', 'ahead/behind');
  assertIncludes(text, 'origin/main', '上游');

  // 分支：三条，current 有标记
  const branchItems = mount.querySelectorAll('.code-panel-branch-item');
  assertEqual(branchItems.length, 3, '分支数量');
  const currentBranches = mount.querySelectorAll('.code-panel-branch-item.is-current');
  assertEqual(currentBranches.length, 1, '当前分支只有一个');
  assertIncludes(currentBranches[0].textContent, 'main', '当前分支是 main');
  assertIncludes(currentBranches[0].textContent, '当前', '当前分支有徽标');

  // 工作树：isMain / isCurrent / locked / prunable 都要看得见
  const worktrees = mount.querySelectorAll('.code-panel-worktree-item');
  assertEqual(worktrees.length, 2, '工作树数量');
  assertIncludes(worktrees[0].textContent, 'main', '第一棵树的分支');
  assertIncludes(worktrees[0].textContent, CWD, '第一棵树的路径');
  assertIncludes(worktrees[0].textContent, '主工作树', 'isMain 标记');
  assertIncludes(worktrees[0].textContent, '当前', 'isCurrent 标记');
  assertEqual(worktrees[0].classList.contains('is-current'), true, '当前工作树整行高亮');
  assertIncludes(worktrees[1].textContent, 'dev', '第二棵树的分支');
  assertIncludes(worktrees[1].textContent, '锁定', 'locked 标记');
  assertIncludes(worktrees[1].textContent, '可清理', 'prunable 标记');
  assertEqual(worktrees[1].querySelectorAll('.code-panel-badge.is-main').length, 0, '非主工作树不标主');

  // 改动：中文状态 + ± 行数 + 是否已暂存
  const changes = mount.querySelectorAll('.code-panel-change-item');
  assertEqual(changes.length, 3, '改动数量');
  assertIncludes(changes[0].textContent, '修改', 'modified 中文');
  assertIncludes(changes[0].textContent, '+120', '新增行数');
  assertIncludes(changes[0].textContent, '−3', '删除行数（用减号）');
  assertIncludes(changes[0].textContent, '未暂存', '未暂存标记');
  assertIncludes(changes[1].textContent, '未跟踪', 'untracked 中文');
  assertIncludes(changes[2].textContent, '删除', 'deleted 中文');
  assertIncludes(changes[2].textContent, '已暂存', '已暂存标记');

  // 区块标题带数量，列表区没有被收起
  const changesSection = mount.querySelector('.code-panel-section-changes');
  assertIncludes(changesSection.querySelector('.code-panel-section-title').textContent, '3', '改动块标题带数量');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, false, '列表区可见');
  assertEqual(mount.querySelector('.code-panel-notice').hidden, true, '正常数据不显示提示');
});

await runCheck('detached HEAD：顶部写明「游离 HEAD」，不把它当成普通分支', async () => {
  const api = makeApi({
    ...REPO,
    status: {
      isRepository: true,
      branch: 'main',
      detached: true,
      upstream: null,
      baseBranch: null,
      ahead: 0,
      behind: 0,
      changedFileCount: 0,
    },
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const line = mount.querySelector('.code-panel-branch-line');
  assertIncludes(line.textContent, '游离 HEAD', 'detached 文案');
  assertIncludes(line.textContent, '当前分支', '行首标签');
  assert(!line.textContent.includes('main'), `detached 时不应把 branch 当成当前分支，实际：${line.textContent}`);
  assertIncludes(line.textContent, '领先 0 / 落后 0', 'ahead/behind 仍然显示');
});

await runCheck('isRepository:false → 显示「不是 git 仓库」，不显示空列表', async () => {
  const notRepo = { isRepository: false };
  const api = makeApi({
    branches: { isRepository: false, current: null, branches: [] },
    worktrees: { isRepository: false, repoRoot: null, worktrees: [] },
    status: { ...notRepo },
    changes: { isRepository: false, files: [] },
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const text = textOf(mount);
  assertIncludes(text, '不是 git 仓库', '非仓库文案');
  assertEqual(mount.querySelectorAll('.code-panel-branch-item').length, 0, '不应渲染空分支列表');
  assertEqual(mount.querySelectorAll('.code-panel-worktree-item').length, 0, '不应渲染空工作树列表');
  assertEqual(mount.querySelectorAll('.code-panel-change-item').length, 0, '不应渲染空改动列表');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, true, '三块列表整块收起');
  assertEqual(mount.querySelector('.code-panel-branch-line').hidden, true, '摘要里不再重复「不是 git 仓库」');
  assert(!text.includes('没有改动'), '不应该把非仓库说成「没有改动」');
});

await runCheck('缺 cwd 时一个请求都不发，显示「这个会话没有关联仓库目录」', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api, () => ({ sessionId: 'sess-1' }));
  panel.open();
  await h.settle();

  assertEqual(api.calls.length, 0, '缺 cwd 不应发请求');
  assertIncludes(textOf(mount), '这个会话没有关联仓库目录', '缺 cwd 提示');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, true, '列表区收起');
  assertEqual(
    mount.querySelector('.code-panel-refresh').disabled,
    false,
    '没发请求时也要能点刷新'
  );
});

await runCheck('缺 sessionId 时一个请求都不发', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api, () => ({ cwd: CWD }));
  panel.open();
  await h.settle();

  assertEqual(api.calls.length, 0, '缺 sessionId 不应发请求');
  assertIncludes(textOf(mount), '这个会话没有关联仓库目录', '缺 sessionId 提示');
});

await runCheck('getSession 返回 null 或抛错都不炸，按没有会话处理', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api, () => null);
  panel.open();
  await h.settle();
  assertEqual(api.calls.length, 0);
  assertIncludes(textOf(mount), '这个会话没有关联仓库目录');
  panel.close();

  const second = makePanel(api, () => {
    throw new Error('会话还没准备好');
  });
  second.panel.open();
  await h.settle();
  assertIncludes(textOf(second.mount), '这个会话没有关联仓库目录', 'getSession 抛错也要有可读提示');
  assertEqual(second.panel.isOpen(), true, '面板仍然打开');
});

await runCheck('单块 500 只坏那一块，其余块照常渲染', async () => {
  const api = makeApi({
    ...REPO,
    branches: () => {
      throw httpError(500, 'Internal Server Error');
    },
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const bodies = bodiesOf(mount);
  assertEqual(bodies.length, 3, '三块都在');
  assertIncludes(bodies[0].textContent, '读取失败', '分支块显示错误');
  assertIncludes(bodies[0].textContent, '500', '错误里带状态码');
  assertEqual(bodies[0].querySelectorAll('.code-panel-branch-item').length, 0, '失败块没有列表');

  const worktrees = mount.querySelectorAll('.code-panel-worktree-item');
  assertEqual(worktrees.length, 2, '工作树照常渲染');
  const changes = mount.querySelectorAll('.code-panel-change-item');
  assertEqual(changes.length, 3, '改动照常渲染');

  // 摘要来自 status，不因 branches 失败而空
  const text = textOf(mount);
  assertIncludes(text, 'main', '摘要仍有分支');
  assertIncludes(text, '领先 2 / 落后 0', '摘要仍有 ahead/behind');
});

await runCheck('403 → 说「这台设备没有查看仓库信息的权限」，不说「加载失败」', async () => {
  const forbidden = () => {
    throw httpError(403, 'Forbidden', { error: 'studio_owner_required' });
  };
  const api = makeApi({
    branches: forbidden,
    worktrees: forbidden,
    status: forbidden,
    changes: forbidden,
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const text = textOf(mount);
  assertIncludes(text, '这台设备没有查看仓库信息的权限', '权限文案');
  assertIncludes(text, '权限', '至少含「权限」二字');
  assert(!text.includes('加载失败'), `不应说成「加载失败」，实际：${text}`);
  assertEqual(mount.querySelector('.code-panel-notice').hidden, false, '顶部权限提示可见');
  assertIncludes(mount.querySelector('.code-panel-notice').textContent, '这台设备没有查看仓库信息的权限', '提示原文');
  // 全 403 时列表没有内容，别摞三条一样的错误
  assertEqual(mount.querySelector('.code-panel-sections').hidden, true, '全 403 时收起列表区');

  // 刷新按钮不能一直禁用
  assertEqual(mount.querySelector('.code-panel-refresh').disabled, false, '失败后刷新可用');
});

await runCheck('403 只看块内也不出现「加载失败」，且单块 403 不掩护其它块', async () => {
  const api = makeApi({
    ...REPO,
    changes: () => {
      throw httpError(403, 'Forbidden', { error: 'studio_owner_required' });
    },
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const bodies = bodiesOf(mount);
  assertIncludes(bodies[2].textContent, '没有查看权限', '改动块权限提示');
  assert(!bodies[2].textContent.includes('加载失败'), '不出现「加载失败」');
  assertEqual(mount.querySelectorAll('.code-panel-worktree-item').length, 2, '其它块照常');
  assertIncludes(mount.querySelector('.code-panel-notice').textContent, '这台设备没有查看仓库信息的权限', '顶部仍给完整说明');
});

await runCheck('点改动文件 → 拉 /api/code/diff，参数正确，diff 文本进面板', async () => {
  const DIFF = '@@ -1,2 +1,3 @@\n-旧的一行\n+新的一行\n+又一行\n';
  const api = makeApi({
    ...REPO,
    diff: () => ({ path: 'web/code-panel.js', diff: DIFF, highlight: { before: 'js', after: 'js' } }),
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();
  assertEqual(api.calls.length, 4, '打开时只有四类请求');

  mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();

  assertEqual(api.calls.length, 5, '点文件多一个请求');
  assertEqual(
    api.calls[4],
    '/api/code/diff?sessionId=sess-1&path=web%2Fcode-panel.js',
    'diff 请求参数（路径要编码，斜杠编成 %2F）'
  );
  assert(api.args[4].length === 1, 'diff 也只传一个 URL');

  const pre = mount.querySelector('.code-panel-diff-text');
  assert(pre, '应该有 diff 文本容器');
  assertIncludes(pre.textContent, '+新的一行', 'diff 内容');
  assertIncludes(pre.textContent, '-旧的一行', 'diff 内容');
  assertEqual(pre.textContent, DIFF, 'diff 原样保留（不裁行、不转义）');

  // 详情是子视图：列表让位，返回后回来
  assertEqual(mount.querySelector('.code-panel-detail').hidden, false, '详情可见');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, true, '列表暂时隐藏');
  assertIncludes(mount.querySelector('.code-panel-detail-path').textContent, 'web/code-panel.js', '详情里的路径');
  assertIncludes(mount.querySelector('.code-panel-detail-meta').textContent, '修改', '详情里的状态');

  mount.querySelector('.code-panel-detail-back').click();
  assertEqual(mount.querySelector('.code-panel-detail').hidden, true, '返回后详情收起');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, false, '返回后列表回来');
});

await runCheck('omitted：二进制 / 过大都要说明原因，不能留白', async () => {
  const binaryApi = makeApi({
    ...REPO,
    diff: () => ({ path: 'assets/logo.png', omitted: { reason: 'binary' }, diff: '' }),
  });
  const first = makePanel(binaryApi);
  first.panel.open();
  await h.settle();
  first.mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();

  const binaryNote = first.mount.querySelector('.code-panel-detail-note');
  assert(binaryNote, '二进制要有一句说明');
  assertIncludes(binaryNote.textContent, '二进制', '二进制文案');
  assertEqual(first.mount.querySelector('.code-panel-diff-text'), null, '二进制不渲染空的 pre');
  first.panel.close();

  const largeApi = makeApi({
    ...REPO,
    diff: () => ({ path: 'web/big.js', omitted: { reason: 'too-large' }, diff: '' }),
  });
  const second = makePanel(largeApi);
  second.panel.open();
  await h.settle();
  second.mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();

  const largeNote = second.mount.querySelector('.code-panel-detail-note');
  assert(largeNote, '过大要有一句说明');
  assertIncludes(largeNote.textContent, '过大', '过大文案');
  assertEqual(second.mount.querySelector('.code-panel-diff-text'), null, '过大不渲染空的 pre');
});

await runCheck('没有差异的文件给一句「没有文本差异」，不是空白', async () => {
  const api = makeApi({
    ...REPO,
    diff: () => ({ path: 'docs/new.md', diff: '', highlight: null }),
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();
  mount.querySelectorAll('.code-panel-change-item')[1].click();
  await h.settle();

  const note = mount.querySelector('.code-panel-detail-note');
  assertIncludes(note ? note.textContent : '', '没有文本差异', '空 diff 文案');
});

await runCheck('diff 失败给可读错误，403 也认权限', async () => {
  const api = makeApi({
    ...REPO,
    diff: () => {
      throw httpError(403, 'Forbidden', { error: 'studio_owner_required' });
    },
  });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();
  mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();

  const error = mount.querySelector('.code-panel-detail .code-panel-block-error');
  assert(error, '详情里要有错误');
  assertIncludes(error.textContent, '权限', 'diff 403 也说权限');
});

await runCheck('串行拉取：第一块回来之前不发第二个请求；期间刷新禁用、块内是加载态', async () => {
  // 每个请求都挂在自己的闸门上：只有上一块 resolve，下一块才会被发出来
  const calls = [];
  const gates = [];
  const api = (url) => {
    calls.push(String(url));
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  };
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  assertEqual(calls.length, 1, '第一块回来之前只应有一个请求');
  const refresh = mount.querySelector('.code-panel-refresh');
  assertEqual(refresh.disabled, true, '拉取中刷新禁用');
  for (const body of bodiesOf(mount)) assertIncludes(body.textContent, '正在读取', '三块都显示加载态');

  gates[0].resolve(REPO.branches);
  await h.settle();
  assertEqual(calls.length, 2, '第一块回来后才发第二个');
  assertEqual(refresh.disabled, true, '还剩两块时仍在拉取');
  assertEqual(mount.querySelectorAll('.code-panel-branch-item').length, 3, '已完成的块先画出来');

  gates[1].resolve(REPO.worktrees);
  await h.settle();
  assertEqual(calls.length, 3, '第二个回来才发第三个');

  gates[2].resolve(REPO.status);
  await h.settle();
  assertEqual(calls.length, 4, '第三个回来才发第四个');

  gates[3].resolve(REPO.changes);
  await h.settle();

  assertEqual(refresh.disabled, false, '全部回来后刷新恢复');
  assertEqual(mount.querySelectorAll('.code-panel-change-item').length, 3, '数据都到位');
});

await runCheck('刷新按钮重新拉一遍，不叠 DOM', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();
  assertEqual(api.calls.length, 4, '首轮四个请求');

  mount.querySelector('.code-panel-refresh').click();
  await h.settle();

  assertEqual(api.calls.length, 8, '刷新再发四个');
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 1, '刷新不叠 DOM');
  assertEqual(mount.querySelectorAll('.code-panel-change-item').length, 3, '刷新后仍渲染');
});

await runCheck('看差异时点刷新：回到列表并重新拉数据', async () => {
  const api = makeApi({ ...REPO, diff: () => ({ path: 'web/code-panel.js', diff: '+x\n' }) });
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();
  mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();
  assertEqual(mount.querySelector('.code-panel-detail').hidden, false, '先在详情里');

  mount.querySelector('.code-panel-refresh').click();
  await h.settle();

  assertEqual(mount.querySelector('.code-panel-detail').hidden, true, '刷新后回到列表');
  assertEqual(mount.querySelector('.code-panel-sections').hidden, false, '列表可见');
  // 4（打开）+ 1（diff）+ 4（刷新）
  assertEqual(api.calls.length, 9, '刷新发了四个请求');
  assertEqual(api.calls.filter((url) => routeKey(url) !== 'diff').length, 8, '除 diff 外共两轮四类请求');
});

await runCheck('重复 open 只有一层 DOM，也不重复发请求', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);

  assertEqual(panel.open(), true, '第一次真的打开了');
  await h.settle();
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 1, '一层');

  assertEqual(panel.open(), false, '重复 open 是空操作');
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-panel-root').length, 1, '不叠加 DOM');
  assertEqual(mount.querySelectorAll('.code-panel-change-item').length, 3, '内容还在');
  assertEqual(api.calls.length, 4, '没有重复请求');
  assertEqual(panel.isOpen(), true, '仍然打开');
});

await runCheck('close 幂等：第一次 true，第二次 false，DOM 干净', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  assertEqual(panel.close(), true, '第一次关闭');
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 0, 'DOM 已清');
  assertEqual(mount.children.length, 0, '挂载容器没有残骸');
  assertEqual(panel.isOpen(), false, '不再是打开态');
  assertEqual(panel.close(), false, '第二次关闭是空操作');
  assertEqual(panel.isOpen(), false, '仍然关闭');
});

await runCheck('Esc 关闭面板；看差异时 Esc 先退回列表', async () => {
  const api = makeApi({ ...REPO, diff: () => ({ path: 'web/code-panel.js', diff: '+x\n' }) });
  const keyDoc = makeDocWithKeyEvents();
  const { panel, mount } = makePanel(api, () => SESSION, keyDoc);
  panel.open();
  await h.settle();

  mount.querySelectorAll('.code-panel-change-item')[0].click();
  await h.settle();
  keyDoc.fireKey('Escape');
  assertEqual(panel.isOpen(), true, '第一次 Esc 只退回列表');
  assertEqual(mount.querySelector('.code-panel-detail').hidden, true, '详情收起');

  keyDoc.fireKey('Escape');
  assertEqual(panel.isOpen(), false, '第二次 Esc 关面板');
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 0, 'DOM 已清');

  // 关掉之后 Esc 再按也不应抛错或重建，监听也应该解绑了
  keyDoc.fireKey('Escape');
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 0);
  assertEqual(keyDoc.listenerCount(), 0, '关闭后 keydown 监听应解绑');
});

await runCheck('点背景关闭，点面板内部不关闭', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  mount.querySelector('.code-panel-sheet').click();
  assertEqual(panel.isOpen(), true, '点面板内部不关');

  mount.querySelector('.code-panel-root').click();
  assertEqual(panel.isOpen(), false, '点背景关闭');
  assertEqual(mount.querySelectorAll('.code-panel-root').length, 0, 'DOM 已清');
});

await runCheck('关闭时还在路上的请求不会把结果画回已关闭的面板', async () => {
  const gate = deferred();
  let first = true;
  const api = async (url) => {
    if (first) {
      first = false;
      return gate.promise;
    }
    return REPO[routeKey(url)];
  };
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  panel.close();
  gate.resolve(REPO.branches);
  await h.settle();

  assertEqual(mount.querySelectorAll('.code-panel-root').length, 0, '迟到的结果不重建 DOM');
  assertEqual(mount.children.length, 0, '挂载容器保持干净');
  assertEqual(rejections.length, 0, `不应出现未处理的拒绝：${rejections.map(String).join('; ')}`);
});

await runCheck('无障碍：对话框属性、中文 aria-label、提示可被朗读', async () => {
  const api = makeApi(REPO);
  const { panel, mount } = makePanel(api);
  panel.open();
  await h.settle();

  const root = rootOf(mount);
  assertEqual(root.getAttribute('role'), 'dialog', 'role');
  assertEqual(root.getAttribute('aria-modal'), 'true', 'aria-modal');
  const title = mount.querySelector('.code-panel-title');
  assertEqual(title.textContent, '仓库现状', '标题');
  assert(title.id && title.id.length > 0, '标题要有 id');
  assertEqual(root.getAttribute('aria-labelledby'), title.id, 'aria-labelledby 指向标题');

  for (const selector of ['.code-panel-refresh', '.code-panel-close', '.code-panel-change-item']) {
    const label = mount.querySelector(selector).getAttribute('aria-label');
    assert(hasChinese(label), `${selector} 应有中文 aria-label，实际：${JSON.stringify(label)}`);
  }
  const refresh = mount.querySelector('.code-panel-refresh');
  assertEqual(refresh.getAttribute('aria-busy'), 'false', '拉完后 aria-busy=false');

  const notice = mount.querySelector('.code-panel-notice');
  assertEqual(notice.getAttribute('aria-live'), 'polite', '提示可被朗读');

  panel.close();
});

await runCheck('缺依赖时给出明确错误', async () => {
  const mount = makeMount();
  const cases = [
    [{ doc, mount, getSession: () => SESSION }, 'api'],
    [{ doc, mount, api: async () => ({}) }, 'getSession'],
  ];
  for (const [options, expected] of cases) {
    let message = '';
    try {
      createCodePanel(options);
    } catch (err) {
      message = String(err && err.message);
    }
    assert(message.includes(expected), `缺少 ${expected} 时应报错，实际：${message}`);
  }
});

await runCheck('changeStatusLabel 判定表', async () => {
  assertEqual(changeStatusLabel('untracked'), '未跟踪');
  assertEqual(changeStatusLabel('added'), '新增');
  assertEqual(changeStatusLabel('deleted'), '删除');
  assertEqual(changeStatusLabel('modified'), '修改');
  assertEqual(changeStatusLabel('Modified'), '修改', '大小写不敏感');
  assertEqual(changeStatusLabel('  added  '), '新增', '首尾空格');
  assertEqual(changeStatusLabel('copied'), 'copied', '未知状态原样显示');
  assertEqual(changeStatusLabel(''), '未知改动', '空值');
  assertEqual(changeStatusLabel(null), '未知改动', '非字符串');
});

await runCheck('describeStatus 判定表', async () => {
  const normal = describeStatus({ branch: 'main', detached: false, ahead: 2, behind: 1, upstream: 'origin/main' });
  assertEqual(normal.branch, 'main');
  assertEqual(normal.sync, '领先 2 / 落后 1');
  assertEqual(normal.upstream, 'origin/main');
  assertEqual(normal.detached, false);

  const detached = describeStatus({ branch: 'main', detached: true, ahead: 0, behind: 0 });
  assertEqual(detached.branch, '游离 HEAD', 'detached 要说游离 HEAD');
  assertEqual(detached.detached, true);
  assertEqual(detached.sync, '领先 0 / 落后 0');

  assertEqual(describeStatus(null).branch, '', 'null 输入');
  assertEqual(describeStatus({}).branch, '未知分支', '缺 branch');
  assertEqual(describeStatus({ ahead: 3 }).sync, '', '缺 behind 时不编数字');
});

await runCheck('describeCodeError 判定表', async () => {
  const forbidden = describeCodeError(httpError(403, 'Forbidden', { error: 'studio_owner_required' }));
  assertEqual(forbidden.kind, 'forbidden');
  assertIncludes(forbidden.message, '权限');

  const plainForbidden = describeCodeError({ status: 403, message: '403 Forbidden' });
  assertEqual(plainForbidden.kind, 'forbidden', '只有状态码也认 403');

  const ownerCode = describeCodeError({ message: 'studio_owner_required' });
  assertEqual(ownerCode.kind, 'forbidden', '错误串里带 studio_owner_required 也认');

  const badCwd = describeCodeError(httpError(400, 'bad', { error: 'cwd_not_found' }));
  assertEqual(badCwd.kind, 'bad-path');
  assertIncludes(badCwd.message, '目录', '目录问题要说目录');

  const invalid = describeCodeError({ status: 400, body: { error: 'invalid_cwd' }, message: '400' });
  assertEqual(invalid.kind, 'bad-path');

  const missingRoute = describeCodeError({ status: 404, message: '404 Not Found' });
  assertEqual(missingRoute.kind, 'unsupported', '404 且没业务码 → 宿主没这个接口');

  const timeout = describeCodeError({ code: 'timeout', message: '请求超时：/api/code/status' });
  assertEqual(timeout.kind, 'timeout');

  const generic = describeCodeError(httpError(500, 'boom'));
  assertEqual(generic.kind, 'error');
  assertIncludes(generic.message, '读取失败');
  assertIncludes(generic.message, '500');
});

await h.settle();
if (rejections.length) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝：${rejections.map((r) => String(r && r.message ? r.message : r)).join('; ')}`);
} else {
  console.log('PASS  没有未处理的 Promise 拒绝');
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
