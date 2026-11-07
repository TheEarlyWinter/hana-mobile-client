/* tests/session_actions.test.mjs
 *
 * web/session-actions.js 的单元测试与契约测试。
 *
 * 覆盖：
 * 1. 纯规划函数：请求体构造（rename / pin / archive / restore）、身份字段容错、
 *    空标题与缺目标的拒绝、不可变更新（不改原数组、不改原行对象）。
 * 2. 执行器：乐观更新先落地、成功后不再回写、失败回滚到原列表、
 *    服务端 4xx 也回滚并带状态码、列表已被后续操作替换时不做破坏性回滚。
 * 3. 视图：菜单结构与文案、置顶/取消置顶切换、重命名内联校验、
 *    onAction 事件形状、字符串 key 解析、dispose 后不再响应。
 *
 * 断言口径：模块只注入 fetchImpl，绝不直接读全局 S、不自己查别人的 DOM 节点；
 * 本文件的 mock document 故意不提供 getElementById / querySelector，控住这条边界。
 */

import assert from 'node:assert/strict';
import { sessionTitle } from '../web/session-list-view.js';
import {
  SessionActionError,
  createSessionActions,
  createSessionActionsView,
  isPinned,
  planArchive,
  planRename,
  planRestore,
  planTogglePin,
  sameSession,
  sessionIdOf,
  sessionPathOf,
} from '../web/session-actions.js';

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

const PATH_A = 'C:\\Users\\example\\.hanako\\agents\\hanako\\sessions\\a.jsonl';
const PATH_B = 'C:\\Users\\example\\.hanako\\agents\\hanako\\sessions\\b.jsonl';

const rowA = {
  sessionId: 'sess_a',
  path: PATH_A,
  title: '会话 A',
  pinned: false,
  modified: 3000,
};
const rowB = {
  sessionId: 'sess_b',
  path: PATH_B,
  title: '会话 B',
  pinned: true,
  modified: 2000,
};
const rowLegacy = { path: 'C:/legacy/only-path.jsonl', title: '只有路径' };

function makeList() {
  return [rowA, rowB, rowLegacy];
}

/* ------------------------------------------------------------------ */
/* mock DOM（只提供视图真正需要的最小面）                              */
/* ------------------------------------------------------------------ */

function createMockDocument() {
  const docListeners = new Map();

  function createElement(tag) {
    const listenerMap = new Map();
    const children = [];
    const classes = new Set();
    const attrs = new Map();

    const el = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      parentNode: null,
      children,
      style: {},
      disabled: false,
      value: '',
      _text: '',
      get textContent() {
        return this._text;
      },
      set textContent(val) {
        this._text = val == null ? '' : String(val);
        children.length = 0;
      },
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
        toggle: (n, on) => {
          if (on === undefined) {
            if (classes.has(n)) classes.delete(n);
            else classes.add(n);
            return classes.has(n);
          }
          if (on) classes.add(n);
          else classes.delete(n);
          return Boolean(on);
        },
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = el;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      addEventListener(type, fn) {
        if (!listenerMap.has(type)) listenerMap.set(type, new Set());
        listenerMap.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listenerMap.get(type)?.delete(fn);
      },
      fire(type, extra = {}) {
        const set = listenerMap.get(type);
        if (!set) return;
        for (const fn of [...set]) {
          fn({ type, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {}, ...extra });
        }
      },
      listenerCount() {
        let n = 0;
        for (const set of listenerMap.values()) n += set.size;
        return n;
      },
    };

    Object.defineProperty(el, 'className', {
      enumerable: true,
      get: () => Array.from(classes).join(' '),
      set: (val) => {
        classes.clear();
        String(val || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach((n) => classes.add(n));
      },
    });

    return el;
  }

  return {
    createElement,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    fire(type, extra = {}) {
      const set = docListeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn({ type, target: null, preventDefault() {}, ...extra });
    },
    listenerCount(type) {
      return docListeners.get(type)?.size || 0;
    },
  };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(root, pred) {
  const out = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

function findByClass(root, cls) {
  return findAll(root, (n) => n.classList?.contains(cls))[0] || null;
}

function findButtonByText(root, text) {
  return findAll(root, (n) => n.tagName === 'BUTTON' && n.textContent === text)[0] || null;
}

function actionButtons(root) {
  return findAll(root, (n) => n.tagName === 'BUTTON' && n.classList.contains('sa-action'));
}

/* ------------------------------------------------------------------ */
/* 1. 字段容错                                                          */
/* ------------------------------------------------------------------ */

await t('字段容错：path / sessionPath、sessionId / id 都能取到', () => {
  assert.equal(sessionPathOf({ path: PATH_A }), PATH_A);
  assert.equal(sessionPathOf({ sessionPath: PATH_A }), PATH_A);
  assert.equal(sessionPathOf({ path: '  ' }), '');
  assert.equal(sessionPathOf(null), '');
  assert.equal(sessionIdOf({ sessionId: 'sess_a' }), 'sess_a');
  assert.equal(sessionIdOf({ id: 'sess_b' }), 'sess_b');
  assert.equal(sessionIdOf({}), '');
});

await t('isPinned：布尔、pinnedAt 都算置顶，脏值按未置顶', () => {
  assert.equal(isPinned({ pinned: true }), true);
  assert.equal(isPinned({ pinned: false }), false);
  assert.equal(isPinned({ pinnedAt: '2026-11-01T00:00:00Z' }), true);
  assert.equal(isPinned({ pinned: 'yes' }), true, '非空真值也算已置顶');
  assert.equal(isPinned({}), false);
  assert.equal(isPinned(null), false);
});

await t('sameSession：路径为主身份，斜杠与大小写不敏感；只有 id 时按 id 对齐', () => {
  assert.equal(sameSession(rowA, { path: PATH_A.toLowerCase().replace(/\\/g, '/') }), true);
  assert.equal(sameSession(rowA, rowB), false);
  assert.equal(sameSession({ sessionId: 'sess_x' }, { sessionId: 'sess_x' }), true);
  assert.equal(sameSession({ sessionId: 'sess_x' }, { sessionId: 'sess_y' }), false);
  assert.equal(sameSession({ path: PATH_A }, { sessionId: 'sess_a' }), false, '一侧只有 id 时不能乱配');
  assert.equal(sameSession(null, rowA), false);
});

/* ------------------------------------------------------------------ */
/* 2. planRename                                                        */
/* ------------------------------------------------------------------ */

await t('planRename：请求体是 { method, url, body:{ path, title } }，标题去空白', () => {
  const plan = planRename(rowA, '  新标题  ');
  assert.equal(plan.action, 'rename');
  assert.equal(plan.request.method, 'POST');
  assert.equal(plan.request.url, '/api/sessions/rename');
  assert.deepEqual(plan.request.body, { path: PATH_A, title: '新标题' });
});

await t('planRename：只有 sessionPath 的会话也能构造请求', () => {
  const plan = planRename({ sessionId: 'sess_c', sessionPath: PATH_B }, '改名');
  assert.deepEqual(plan.request.body, { path: PATH_B, title: '改名' });
});

await t('planRename：空标题 / 纯空白 / 非字符串一律拒绝，且不带请求', () => {
  for (const title of ['', '   ', '\t\n', null, undefined, 42, {}]) {
    assert.throws(
      () => planRename(rowA, title),
      (err) => {
        assert.ok(err instanceof SessionActionError, `期望 SessionActionError，实际 ${err?.name}`);
        assert.equal(err.code, 'invalid-title');
        return true;
      },
      `标题 ${JSON.stringify(title)} 应被拒绝`,
    );
  }
});

await t('planRename：缺 path 拒 missing-path，无任何身份拒 missing-target', () => {
  assert.throws(() => planRename({ sessionId: 'sess_a' }, '标题'), (err) => err.code === 'missing-path');
  assert.throws(() => planRename(null, '标题'), (err) => err.code === 'missing-target');
  assert.throws(() => planRename({}, '标题'), (err) => err.code === 'missing-target');
});

await t('planRename.apply：返回新数组，原数组与原行对象都不改', () => {
  const list = makeList();
  const snapshot = list.map((s) => ({ ...s }));
  const plan = planRename(rowA, '改过的 A');
  const next = plan.apply(list);

  assert.notEqual(next, list, '必须返回新数组');
  assert.equal(next.length, list.length);
  assert.deepEqual(list, snapshot, '原数组不能被改');
  assert.equal(rowA.title, '会话 A', '原行对象不能被改');
  assert.equal(next[0].title, '改过的 A');
  assert.equal(next[0].pinned, false, '其余字段原样保留');
  assert.equal(next[1], rowB, '未命中的行保持同一引用');
  assert.equal(next[2], rowLegacy);
});

await t('planRename.apply：路径大小写/斜杠差异也能命中目标行', () => {
  const list = makeList();
  const plan = planRename({ path: PATH_A.replace(/\\/g, '/').toUpperCase() }, '命中');
  const next = plan.apply(list);
  assert.equal(next[0].title, '命中');
  assert.equal(next[1], rowB);
});

await t('planRename.apply：列表不是数组时抛 TypeError', () => {
  const plan = planRename(rowA, '标题');
  assert.throws(() => plan.apply(null), TypeError);
  assert.throws(() => plan.apply({ sessions: [] }), TypeError);
});

/* ------------------------------------------------------------------ */
/* 3. planTogglePin                                                     */
/* ------------------------------------------------------------------ */

await t('planTogglePin：pinned 严格取反，body 带身份字段', () => {
  const on = planTogglePin(rowA);
  assert.equal(on.action, 'pin');
  assert.equal(on.request.url, '/api/sessions/pin');
  assert.equal(on.request.method, 'POST');
  assert.equal(on.request.body.pinned, true);
  assert.equal(on.request.body.sessionId, 'sess_a');
  assert.equal(on.request.body.sessionPath, PATH_A);

  const off = planTogglePin(rowB);
  assert.equal(off.request.body.pinned, false, '已置顶的会话要取反成 false');

  for (const plan of [on, off]) {
    assert.equal(typeof plan.request.body.pinned, 'boolean', 'pinned 必须是布尔，不能是字符串');
    assert.ok(!('path' in plan.request.body), 'pin 用 sessionPath，不能用 rename 的 path');
  }
});

await t('planTogglePin：pinnedAt 形式的行取反成 false；只有 id 时 body 只带 sessionId', () => {
  assert.equal(planTogglePin({ sessionId: 'sess_p', pinnedAt: '2026-11-01T00:00:00Z' }).request.body.pinned, false);
  const plan = planTogglePin({ sessionId: 'sess_only_id' });
  assert.deepEqual(plan.request.body, { pinned: true, sessionId: 'sess_only_id' });
});

await t('planTogglePin.apply：只改目标行的 pinned，不改原数组', () => {
  const list = makeList();
  const snapshot = list.map((s) => ({ ...s }));
  const next = planTogglePin(rowA).apply(list);

  assert.notEqual(next, list);
  assert.deepEqual(list, snapshot);
  assert.equal(rowA.pinned, false, '原行对象不能被改');
  assert.equal(next[0].pinned, true);
  assert.equal(next[1], rowB);
});

await t('planTogglePin.apply：以当前行取反，连续两次回到原值', () => {
  const list = makeList();
  const once = planTogglePin(rowA).apply(list);
  // 第二次要以「已置顶后的那一行」为输入，这才是真实调用顺序（视图反查的是列表里的最新行）
  const twice = planTogglePin(once[0]).apply(once);
  assert.equal(once[0].pinned, true);
  assert.equal(planTogglePin(once[0]).request.body.pinned, false, '取反依据是输入行自身');
  assert.equal(twice[0].pinned, false);
  assert.equal(list[0].pinned, false);
  assert.equal(rowA.pinned, false, '原行对象始终不被改');
});

/* ------------------------------------------------------------------ */
/* 4. planArchive / planRestore                                          */
/* ------------------------------------------------------------------ */

await t('planArchive：POST /api/sessions/archive，body 只放身份字段', () => {
  const plan = planArchive(rowA);
  assert.equal(plan.action, 'archive');
  assert.equal(plan.request.method, 'POST');
  assert.equal(plan.request.url, '/api/sessions/archive');
  assert.deepEqual(plan.request.body, { sessionId: 'sess_a', sessionPath: PATH_A });
  assert.ok(!('path' in plan.request.body));
  assert.ok(!('pinned' in plan.request.body));
});

await t('planArchive：文案不叫删除 —— 模块只暴露归档语义', () => {
  assert.equal(planArchive(rowLegacy).action, 'archive');
  assert.ok(!('delete' in planArchive(rowLegacy)));
  assert.throws(() => planArchive(null), (err) => err.code === 'missing-target');
  assert.throws(() => planArchive({}), (err) => err.code === 'missing-target');
});

await t('planArchive.apply：从列表里移除目标行，原数组不动', () => {
  const list = makeList();
  const snapshot = list.map((s) => ({ ...s }));
  const next = planArchive(rowA).apply(list);

  assert.notEqual(next, list);
  assert.equal(next.length, 2);
  assert.equal(next[0], rowB, '剩余行保持同一引用');
  assert.equal(next[1], rowLegacy);
  assert.deepEqual(list, snapshot, '原数组不能被改');
});

await t('planRestore：POST /api/sessions/restore，apply 把 archived 置回 false', () => {
  const archived = { ...rowA, archived: true };
  const list = [archived, rowB];
  const plan = planRestore(archived);
  assert.equal(plan.action, 'restore');
  assert.equal(plan.request.url, '/api/sessions/restore');
  assert.deepEqual(plan.request.body, { sessionId: 'sess_a', sessionPath: PATH_A });

  const next = plan.apply(list);
  assert.equal(next[0].archived, false);
  assert.equal(archived.archived, true, '原行对象不能被改');
  assert.equal(next[1], rowB);
});

/* ------------------------------------------------------------------ */
/* 5. 执行器：乐观更新 + 回滚                                            */
/* ------------------------------------------------------------------ */

function harness({ fetchImpl, initial = makeList() } = {}) {
  let list = initial;
  const commits = [];
  const errors = [];
  const calls = [];

  const impl =
    fetchImpl ||
    (() => Promise.resolve({ ok: true, status: 200, text: async () => '{"ok":true}' }));

  const actions = createSessionActions({
    fetchImpl: (url, init) => {
      calls.push({ url, init });
      return impl(url, init);
    },
    getList: () => list,
    commitList: (next) => {
      commits.push(next);
      list = next;
    },
    onError: (event) => errors.push(event),
  });

  return {
    actions,
    commits,
    errors,
    calls,
    get list() {
      return list;
    },
    setList(next) {
      list = next;
    },
  };
}

await t('执行器：成功路径发一次 POST，先乐观落地，结果返回 ok + 新列表', async () => {
  const h = harness();
  const result = await h.actions.rename(rowA, '  新名字 ');

  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, '/api/sessions/rename');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { path: PATH_A, title: '新名字' });

  assert.equal(h.commits.length, 1, '成功后只提交乐观结果，不再回写');
  assert.equal(h.commits[0][0].title, '新名字');
  assert.equal(h.list, h.commits[0]);

  assert.equal(result.ok, true);
  assert.equal(result.action, 'rename');
  assert.equal(result.list[0].title, '新名字');
  assert.equal(h.errors.length, 0);
});

await t('执行器：请求失败回滚到原列表，返回值带上错误', async () => {
  const h = harness({ fetchImpl: () => Promise.reject(new Error('网络断了')) });
  const before = h.list;
  const result = await h.actions.rename(rowA, '新名字');

  assert.equal(h.commits.length, 2, '先乐观提交，再回滚提交');
  assert.equal(h.commits[0][0].title, '新名字');
  assert.equal(h.commits[1], before, '回滚要把原列表原样提交回去');
  assert.equal(h.list, before);

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.phase, 'request');
  assert.equal(result.error.message, '网络断了');
  assert.equal(result.list, before);

  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].type, 'error');
  assert.equal(h.errors[0].action, 'rename');
  assert.equal(h.errors[0].rolledBack, true);
});

await t('执行器：服务端 4xx 也回滚，错误信息带状态码与服务端 detail', async () => {
  const h = harness({
    fetchImpl: () =>
      Promise.resolve({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"detail":"title must be non-empty"}',
      }),
  });
  const before = h.list;
  const result = await h.actions.rename(rowA, '新名字');

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.error.status, 400);
  assert.match(result.error.message, /400/);
  assert.match(result.error.message, /title must be non-empty/);
  assert.equal(h.list, before);
});

await t('执行器：规划阶段被拒（空标题）不发请求、不动列表', async () => {
  const h = harness();
  const before = h.list;
  const result = await h.actions.rename(rowA, '   ');

  assert.equal(h.calls.length, 0, '空标题不能发请求');
  assert.equal(h.commits.length, 0, '空标题不能改列表');
  assert.equal(h.list, before);
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'plan');
  assert.equal(result.rolledBack, false);
  assert.equal(result.error.code, 'invalid-title');
  assert.equal(h.errors.length, 1);
});

await t('执行器：列表已被后续操作替换时不覆盖，rolledBack 报 false', async () => {
  let rejectFn = () => {};
  const h = harness({
    fetchImpl: () =>
      new Promise((resolve, reject) => {
        rejectFn = reject;
      }),
  });

  const pending = h.actions.togglePin(rowA);
  await Promise.resolve();
  assert.equal(h.commits.length, 1, '乐观更新已落地');

  const other = [rowB];
  h.setList(other);
  rejectFn(new Error('晚了'));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false, '别人的新状态不能被旧请求的回滚顶掉');
  assert.equal(h.list, other);
  assert.equal(h.errors[0].rolledBack, false);
  assert.equal(h.errors[0].stale, true);
});

await t('执行器：pin 走 /api/sessions/pin 且布尔取反；archive 走归档路由', async () => {
  const h = harness();
  await h.actions.togglePin(rowA);
  assert.equal(h.calls[0].url, '/api/sessions/pin');
  assert.equal(JSON.parse(h.calls[0].init.body).pinned, true);

  await h.actions.togglePin(rowB);
  assert.equal(JSON.parse(h.calls[1].init.body).pinned, false);

  await h.actions.archive(rowA);
  assert.equal(h.calls[2].url, '/api/sessions/archive');
  assert.ok(!('pinned' in JSON.parse(h.calls[2].init.body)));
  assert.equal(h.list.some((s) => s.sessionId === 'sess_a'), false, '归档后列表里不再有它');
});

await t('执行器：只用注入的 fetchImpl，不去碰 globalThis.fetch', async () => {
  const original = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = () => {
    globalCalls += 1;
    return Promise.reject(new Error('不应该走到全局 fetch'));
  };
  try {
    const h = harness();
    const result = await h.actions.rename(rowA, '新名字');
    assert.equal(result.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(globalCalls, 0, '模块不能自己 fetch');
  } finally {
    globalThis.fetch = original;
  }
});

await t('执行器：注入的 fetch 不可用时报错，而不是静默成功', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const holder = { list: makeList() };
    const actions = createSessionActions({
      fetchImpl: null,
      getList: () => holder.list,
      commitList: (next) => {
        holder.list = next;
      },
    });
    const result = await actions.rename(rowA, '新名字');
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true, '没有 fetch 也属于请求失败，要回滚');
    assert.equal(result.error.code, 'no-fetch');
    assert.equal(holder.list[0].title, '会话 A', '列表要回到原状');
  } finally {
    globalThis.fetch = original;
  }
});

await t('执行器：commitList 抛异常时不 reject，错误也能返回', async () => {
  const actions = createSessionActions({
    fetchImpl: () => Promise.resolve({ ok: true, status: 200 }),
    getList: () => makeList(),
    commitList: () => {
      throw new Error('渲染炸了');
    },
  });
  const result = await actions.rename(rowA, '新名字');
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'plan');
  assert.equal(result.error.message, '渲染炸了');
});

await t('执行器：onError 回调自己抛异常也不会盖住原始错误', async () => {
  const actions = createSessionActions({
    fetchImpl: () => Promise.reject(new Error('网络断了')),
    getList: () => makeList(),
    commitList: () => {},
    onError: () => {
      throw new Error('提示框炸了');
    },
  });
  const result = await actions.togglePin(rowA);
  assert.equal(result.ok, false);
  assert.equal(result.error.message, '网络断了');
});

/* ------------------------------------------------------------------ */
/* 6. 视图                                                              */
/* ------------------------------------------------------------------ */

function makeView({ list = makeList() } = {}) {
  const doc = createMockDocument();
  const mount = doc.createElement('div');
  const events = [];
  const view = createSessionActionsView({
    document: doc,
    mount,
    list,
    onAction: (event) => events.push(event),
  });
  return { doc, mount, events, view };
}

await t('视图：open 后挂出菜单，标题取会话标题，三个动作文案正确', () => {
  const { mount, view } = makeView();
  assert.equal(view.isOpen(), false, '构造后不该自己打开');

  assert.equal(view.open(rowA), true);
  assert.equal(view.isOpen(), true);
  assert.equal(mount.children.length, 1, '菜单挂在传入的 mount 上');

  const root = mount.children[0];
  assert.equal(root.style.display, 'flex');
  assert.equal(findButtonByText(root, '重命名') != null, true);
  assert.equal(findButtonByText(root, '置顶') != null, true);
  assert.equal(findButtonByText(root, '归档') != null, true);
  assert.equal(findButtonByText(root, '删除'), null, '不能出现「删除」文案');

  const name = findByClass(root, 'sa-session-name');
  assert.equal(name.textContent, '会话 A');
});

await t('视图：已置顶的会话显示「取消置顶」，未置顶显示「置顶」', () => {
  const { mount, view } = makeView();
  view.open(rowA);
  assert.equal(findButtonByText(mount.children[0], '置顶') != null, true);

  view.open(rowB);
  assert.equal(findButtonByText(mount.children[0], '取消置顶') != null, true);
  assert.equal(findButtonByText(mount.children[0], '置顶'), null);
});

await t('视图：点置顶回调 { type:"pin", session } 并关闭', () => {
  const { mount, events, view } = makeView();
  view.open(rowA);
  const btn = findButtonByText(mount.children[0], '置顶');
  btn.fire('click');

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pin');
  assert.equal(events[0].session, rowA);
  assert.equal(view.isOpen(), false);
});

await t('视图：点归档先进入确认态，不直接回调', () => {
  const { mount, events, view } = makeView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');

  assert.equal(events.length, 0, '归档不能点一下就生效');
  assert.equal(view.isOpen(), true);
  const root = mount.children[0];
  const text = findByClass(root, 'sa-confirm-text');
  assert.equal(text.textContent, '归档后从列表移除，可在桌面端恢复');
  assert.equal(findButtonByText(root, '置顶'), null, '确认态里动作列表已收起');

  // 确认后才回调，且文案仍是归档
  findByClass(root, 'sa-btn-danger').fire('click');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'archive');
  assert.equal(events[0].session, rowA);
  assert.equal(view.isOpen(), false);
});

await t('视图：进入重命名后输入框预填当前标题，空标题不发事件并提示', () => {
  const { mount, events, view } = makeView();
  view.open(rowA);
  findButtonByText(mount.children[0], '重命名').fire('click');

  const root = mount.children[0];
  const input = findByClass(root, 'sa-rename-input');
  assert.equal(input.value, '会话 A', '预填当前标题');
  assert.equal(findButtonByText(root, '重命名'), null, '重命名模式下动作列表收起');

  input.value = '   ';
  findButtonByText(root, '保存').fire('click');
  assert.equal(events.length, 0, '空标题不能触发重命名');
  const err = findByClass(root, 'sa-error');
  assert.ok(err.textContent.length > 0, '要给出可见提示');
  assert.equal(view.isOpen(), true, '校验失败时保持打开');

  input.value = '  新标题  ';
  findButtonByText(root, '保存').fire('click');
  assert.equal(events.length, 1);
  assert.deepEqual(
    { type: events[0].type, title: events[0].title },
    { type: 'rename', title: '新标题' },
    '标题要 trim 后回传',
  );
  assert.equal(view.isOpen(), false);
});

await t('视图：输入框回车等同保存', () => {
  const { mount, events, view } = makeView();
  view.open(rowA);
  findButtonByText(mount.children[0], '重命名').fire('click');

  const input = findByClass(mount.children[0], 'sa-rename-input');
  input.value = '回车改名';
  input.fire('keydown', { key: 'Enter' });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'rename');
  assert.equal(events[0].title, '回车改名');
});

await t('视图：用 path / sessionId 字符串也能打开，并取列表里最新的 pinned 状态', () => {
  const { mount, events, view } = makeView();
  assert.equal(view.open(PATH_A), true);
  assert.equal(findButtonByText(mount.children[0], '置顶') != null, true);

  view.close();
  view.setList(makeList().map((s) => (s.sessionId === 'sess_a' ? { ...s, pinned: true } : s)));
  assert.equal(view.open('sess_a'), true);
  assert.equal(findButtonByText(mount.children[0], '取消置顶') != null, true);

  findButtonByText(mount.children[0], '取消置顶').fire('click');
  assert.equal(events[0].session.sessionId, 'sess_a');
  assert.equal(events[0].session.pinned, true, '事件里的 session 是列表中的最新行');
});

await t('视图：未知 key 打不开，也不留下半开状态', () => {
  const { mount, view } = makeView();
  assert.equal(view.open('不存在的 key'), false);
  assert.equal(view.isOpen(), false);
  assert.equal(mount.children.length, 0);
});

await t('视图：遮罩点击与 Escape 都能关闭', () => {
  const { doc, mount, view } = makeView();
  view.open(rowA);
  const root = mount.children[0];
  root.fire('click', { target: root });
  assert.equal(view.isOpen(), false);

  view.open(rowA);
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(view.isOpen(), false);
});

await t('视图：setBusy 禁用按钮，避免重复提交', () => {
  const { mount, view } = makeView();
  view.open(rowA);
  const root = mount.children[0];
  view.setBusy(true);
  assert.equal(actionButtons(root).every((b) => b.disabled === true), true);
  view.setBusy(false);
  assert.equal(actionButtons(root).every((b) => b.disabled === false), true);
});

await t('视图：dispose 摘掉节点、解绑监听，之后不再回调', () => {
  const { mount, events, view } = makeView();
  view.open(rowA);
  const root = mount.children[0];
  view.dispose();

  assert.equal(mount.children.length, 0, 'dom 要被摘掉');
  findButtonByText(root, '归档').fire('click');
  assert.equal(events.length, 0, 'dispose 之后不能再回调');
  assert.equal(view.isOpen(), false);
});

await t('视图：没有 document / mount 时立即报错，不静默降级', () => {
  assert.throws(() => createSessionActionsView({ mount: {} }), /document/);
  assert.throws(() => createSessionActionsView({ document: createMockDocument() }), /mount/);
});

/* ------------------------------------------------------------------ */
/* 7. 标题回退（宿主 title 恒为 null，会话名在 firstMessage 里）            */
/* ------------------------------------------------------------------ */

// 真机上的真实形状：title 是 null，名字只有 firstMessage。
const rowNullTitle = {
  sessionId: 'sess_untitled',
  path: 'C:\\sessions\\untitled.jsonl',
  title: null,
  firstMessage: '测速一下',
  pinned: false,
  modified: 1500,
};

function menuName(list, target) {
  const { mount, view } = makeView({ list });
  assert.equal(view.open(target), true);
  return findByClass(mount.children[0], 'sa-session-name').textContent;
}

await t('标题回退：title 为 null 时用 firstMessage，不能显示 (无标题)', () => {
  assert.equal(menuName([rowNullTitle], rowNullTitle), '测速一下');
});

await t('标题回退：从列表反查权威行后依然用 firstMessage（接线层注入的假 title 不算数）', () => {
  // 复现缺陷路径：调用方为了兜底传了 { ...s, title: '假标题' }，
  // 视图会优先用列表里的权威行，所以模块自己的解析必须能从 firstMessage 取到名字。
  const patched = { ...rowNullTitle, title: '假标题' };
  assert.equal(menuName([rowNullTitle], patched), '测速一下');
});

await t('标题回退：优先级 title → name → firstMessage；空白串不算有值', () => {
  assert.equal(
    menuName([{ ...rowNullTitle, title: '正式标题', name: '旧名字' }], rowNullTitle),
    '正式标题',
    'title 优先于 name',
  );
  assert.equal(menuName([{ ...rowNullTitle, title: null, name: '旧名字' }], rowNullTitle), '旧名字');
  assert.equal(
    menuName([{ ...rowNullTitle, title: '   ' }], rowNullTitle),
    '测速一下',
    '空白 title 要继续回退到 firstMessage',
  );
});

await t('标题回退：firstMessage 前 60 字截断，与 session-list-view 的 sessionTitle 一致', () => {
  const long = '字'.repeat(80);
  const { mount, view } = makeView({ list: [{ ...rowNullTitle, firstMessage: long }] });
  view.open(rowNullTitle);
  const shown = findByClass(mount.children[0], 'sa-session-name').textContent;
  assert.equal(shown, '字'.repeat(60));
  assert.equal(shown.length, 60);
});

await t('标题回退：firstMessage 去首尾空白', () => {
  const { mount, view } = makeView({ list: [{ ...rowNullTitle, firstMessage: '  测速一下  ' }] });
  view.open(rowNullTitle);
  assert.equal(findByClass(mount.children[0], 'sa-session-name').textContent, '测速一下');
});

await t('标题回退：重命名输入框预填 firstMessage 派生的标题', () => {
  const { mount, view } = makeView({ list: [rowNullTitle] });
  view.open(rowNullTitle);
  findButtonByText(mount.children[0], '重命名').fire('click');
  assert.equal(findByClass(mount.children[0], 'sa-rename-input').value, '测速一下');
});

await t('标题回退：完全没有名字时显示 (无标题)，重命名预填留空', () => {
  const bare = { sessionId: 'sess_bare', path: 'C:\\sessions\\bare.jsonl', title: null, firstMessage: '   ' };
  const { mount, view } = makeView({ list: [bare] });
  view.open(bare);
  assert.equal(findByClass(mount.children[0], 'sa-session-name').textContent, '(无标题)');

  findButtonByText(mount.children[0], '重命名').fire('click');
  assert.equal(findByClass(mount.children[0], 'sa-rename-input').value, '', '占位标题不能预填进输入框');
});

await t('标题回退：与 session-list-view 的 sessionTitle 逐例对齐', () => {
  const cases = [
    { title: '正式标题', name: '名字', firstMessage: '第一句' },
    { title: null, name: '名字', firstMessage: '第一句' },
    { title: null, firstMessage: '测速一下' },
    { title: '   ', firstMessage: '测速一下' },
    { title: null, firstMessage: '  测速一下  ' },
    { title: null, firstMessage: '字'.repeat(80) },
    { title: null, firstMessage: '   ' },
    { title: null },
    {},
  ];
  for (const fixture of cases) {
    const row = { ...rowNullTitle, ...fixture };
    const expected = sessionTitle(row);
    assert.equal(menuName([row], row), expected, `与列表不一致：${JSON.stringify(fixture)}`);
  }
});

/* ------------------------------------------------------------------ */
/* 8. 归档二次确认（菜单内的状态机，不是第二个弹窗）                       */
/* ------------------------------------------------------------------ */

// 把视图接到真的执行器上：能数出到底发了几次请求。
function makeLiveView() {
  const h = harness();
  const doc = createMockDocument();
  const mount = doc.createElement('div');
  const events = [];
  const view = createSessionActionsView({
    document: doc,
    mount,
    list: makeList(),
    onAction: (event) => {
      events.push(event);
      if (event.type === 'archive') h.actions.archive(event.session);
      if (event.type === 'pin') h.actions.togglePin(event.session);
    },
  });
  return { h, doc, mount, events, view, root: () => mount.children[0] };
}

await t('归档确认：确认后才发一次 POST /api/sessions/archive', async () => {
  const { h, mount, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');
  assert.equal(h.calls.length, 0, '进入确认态不能发请求');

  findByClass(mount.children[0], 'sa-btn-danger').fire('click');
  await Promise.resolve();
  assert.equal(h.calls.length, 1, '只发一次');
  assert.equal(h.calls[0].url, '/api/sessions/archive');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { sessionId: 'sess_a', sessionPath: PATH_A });
  assert.equal(view.isOpen(), false, '执行后菜单收起');
});

await t('归档确认：取消回到操作列表，不发请求', () => {
  const { h, mount, events, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');
  findByClass(mount.children[0], 'sa-confirm-cancel').fire('click');

  assert.equal(h.calls.length, 0);
  assert.equal(events.length, 0);
  assert.equal(view.isOpen(), true, '取消只是退出确认态');
  assert.equal(findButtonByText(mount.children[0], '置顶') != null, true, '回到动作列表');
  assert.equal(findByClass(mount.children[0], 'sa-confirm-text'), null);
});

await t('归档确认：返回键先退确认态，再按一次才关菜单', () => {
  const { doc, mount, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');

  doc.fire('keydown', { key: 'Escape' });
  assert.equal(view.isOpen(), true, '第一下只收确认态');
  assert.equal(findButtonByText(mount.children[0], '置顶') != null, true);

  doc.fire('keydown', { key: 'Escape' });
  assert.equal(view.isOpen(), false, '第二下才关菜单');
});

await t('归档确认：遮罩点击也只是退回操作列表', () => {
  const { mount, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');
  const root = mount.children[0];
  root.fire('click', { target: root });
  assert.equal(view.isOpen(), true);
  assert.equal(findButtonByText(root, '置顶') != null, true);
});

await t('归档确认：确认按钮保持危险色，取消是普通按钮', () => {
  const { mount, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');
  const root = mount.children[0];
  const confirm = findByClass(root, 'sa-btn-danger');
  assert.equal(confirm.textContent, '归档');
  assert.equal(findByClass(root, 'sa-confirm-cancel').textContent, '取消');
  assert.equal(findButtonByText(root, '归档'), confirm, '确认态里只有这一个归档按钮');
});

await t('归档确认：重命名的校验错误不会被确认态吃掉', () => {
  const { doc, mount, view } = makeLiveView();
  view.open(rowA);
  findButtonByText(mount.children[0], '重命名').fire('click');
  findByClass(mount.children[0], 'sa-rename-input').value = '  ';
  findButtonByText(mount.children[0], '保存').fire('click');
  assert.ok(findByClass(mount.children[0], 'sa-error').textContent.length > 0);

  doc.fire('keydown', { key: 'Escape' }); // 退出重命名
  findButtonByText(mount.children[0], '归档').fire('click');

  const err = findByClass(mount.children[0], 'sa-error');
  assert.equal(err.textContent, '标题不能为空', '错误提示在确认态里仍然可见');
  assert.equal(err.style.display, 'block');
});

await t('back()：菜单未打开返回 false；确认态一步退层，再按才关', () => {
  const { mount, view } = makeLiveView();
  assert.equal(view.back(), false, '没开会就把退出决定留给原生');

  view.open(rowA);
  findButtonByText(mount.children[0], '归档').fire('click');
  assert.equal(view.back(), true, '确认态退一层也算已处理');
  assert.equal(view.isOpen(), true, '退掉确认态后菜单还在');
  assert.equal(view.back(), true);
  assert.equal(view.isOpen(), false);
  assert.equal(view.back(), false);
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
