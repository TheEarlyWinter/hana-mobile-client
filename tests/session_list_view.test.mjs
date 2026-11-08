/* tests/session_list_view.test.mjs
 *
 * web/session-list-view.js 单元测试与契约测试
 * 覆盖：
 * 1. sessionTime: modified / updatedAt / lastActiveAt / mtime / createdAt 优先级与类型解析
 * 2. sessionTitle: title / name / firstMessage 截断 / 默认 '(无标题)'
 * 3. sessionFolder: basename 优先，homeFolder fallback，路径斜杠处理
 * 4. createSessionListView:
 *    - 构造时不触发渲染，不调用 getContext
 *    - showLoading: DOM 结构与中文文案
 *    - showError: DOM 结构与错误文案
 *    - render: 空列表文案、排序不修改原数组、按 now 注入进行日期分组 (今天/昨天/最近一周/更早)
 *    - row: 类名与 DOM 结构、avatar URL 与首字母回退、agent 仅按 id 匹配、元数据与相对时间、点击回调传原 session
 *    - 动态 getContext: 上下文变化后下一次渲染实时生效
 */

import assert from 'node:assert/strict';
import {
  sessionTime,
  sessionTitle,
  sessionFolder,
  createSessionListView,
} from '../web/session-list-view.js';
import { planTogglePin } from '../web/session-actions.js';

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

function createMockDocument() {
  function createMockElement(tag, cls = '') {
    const listeners = new Map();
    const children = [];
    const classListSet = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);

    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      style: {},
      attributes: new Map(),
      children,
      get className() {
        return Array.from(classListSet).join(' ');
      },
      set className(val) {
        classListSet.clear();
        if (val) val.split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
      },
      classList: {
        add: (...args) => args.forEach(c => classListSet.add(c)),
        remove: (...args) => args.forEach(c => classListSet.delete(c)),
        contains: (c) => classListSet.has(c),
      },
      _text: '',
      get textContent() {
        return this._text;
      },
      set textContent(val) {
        this._text = String(val == null ? '' : val);
        children.length = 0;
      },
      _html: '',
      get innerHTML() {
        return this._html;
      },
      set innerHTML(val) {
        this._html = String(val == null ? '' : val);
        if (val === '') {
          children.length = 0;
          this._text = '';
        }
      },
      appendChild(child) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx !== -1) {
          children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      addEventListener(type, fn, options = {}) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, once: !!options.once });
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const list = listeners.get(type) ? [...listeners.get(type)] : [];
        for (const item of list) {
          item.fn.call(this, typeof event === 'string' ? { type } : event);
          if (item.once) {
            const arr = listeners.get(type);
            const idx = arr.indexOf(item);
            if (idx !== -1) arr.splice(idx, 1);
          }
        }
      },
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) || null; },
      querySelector(sel) {
        return findFirst(this, sel);
      },
      querySelectorAll(sel) {
        const res = [];
        findAll(this, sel, res);
        return res;
      },
    };
    return el;
  }

  function matches(node, sel) {
    if (sel.startsWith('.')) {
      const classes = sel.split('.').filter(Boolean);
      return classes.every(c => node.classList.contains(c));
    }
    return node.tagName.toLowerCase() === sel.toLowerCase();
  }

  function findFirst(parent, sel) {
    for (const child of parent.children) {
      if (matches(child, sel)) return child;
      const found = findFirst(child, sel);
      if (found) return found;
    }
    return null;
  }

  function findAll(parent, sel, res) {
    for (const child of parent.children) {
      if (matches(child, sel)) res.push(child);
      findAll(child, sel, res);
    }
  }

  return {
    createElement: (tag) => createMockElement(tag),
  };
}

/* ------------------------------------------------------------------ */
/* 1. sessionTime 纯函数测试                                           */
/* ------------------------------------------------------------------ */

await t('sessionTime: 优先级与类型解析正确', () => {
  assert.equal(sessionTime({}), 0);
  assert.equal(sessionTime(null), 0);

  // modified 优先级最高
  assert.equal(sessionTime({ modified: 1000, updatedAt: 500 }), 1000);
  // 字符串 ISO 时间解析
  const iso = '2026-11-02T08:00:00.000Z';
  assert.equal(sessionTime({ updatedAt: iso }), Date.parse(iso));
  // 其它字段回退
  assert.equal(sessionTime({ lastActiveAt: 300 }), 300);
  assert.equal(sessionTime({ mtime: 200 }), 200);
  assert.equal(sessionTime({ createdAt: 100 }), 100);
  // 非法时间字符串回退为 0
  assert.equal(sessionTime({ modified: 'not-a-date' }), 0);
});

/* ------------------------------------------------------------------ */
/* 2. sessionTitle 纯函数测试                                          */
/* ------------------------------------------------------------------ */

await t('sessionTitle: 标题裁剪与回退', () => {
  assert.equal(sessionTitle({}), '(无标题)');
  assert.equal(sessionTitle(null), '(无标题)');
  assert.equal(sessionTitle({ title: '  会话标题一  ' }), '会话标题一');
  assert.equal(sessionTitle({ name: '会话标题二' }), '会话标题二');
  // 无 title/name 时取 firstMessage 前 60 字符
  const longMsg = '这是一条非常长非常长非常长非常长的用户提问消息，超过了六十个字符限制的超长内容，应该被截断成正好六十个字。';
  assert.equal(sessionTitle({ firstMessage: longMsg }), longMsg.slice(0, 60));
  assert.equal(sessionTitle({ firstMessage: '   ' }), '(无标题)');
});

/* ------------------------------------------------------------------ */
/* 3. sessionFolder 纯函数测试                                         */
/* ------------------------------------------------------------------ */

await t('sessionFolder: 先 basename 后 homeFolder 回退', () => {
  // POSIX 路径 basename
  assert.equal(sessionFolder({ cwd: '/home/user/project' }), 'project');
  // Windows 路径 basename
  assert.equal(sessionFolder({ workspace: 'C:\\Users\\Admin\\workspace\\myapp' }), 'myapp');
  // 尾部斜杠处理
  assert.equal(sessionFolder({ folder: '/data/repo/' }), 'repo');
  // 候选字段优先级 cwd > workspace > folder > homeFolder
  assert.equal(sessionFolder({ cwd: '/a/foo', workspace: '/b/bar' }), 'foo');
  // 无有效路径时使用 homeFolder 参数
  assert.equal(sessionFolder({}, 'fallbackDir'), 'fallbackDir');
  assert.equal(sessionFolder({ cwd: '' }, 'defaultHome'), 'defaultHome');
  assert.equal(sessionFolder({}), '');
});

/* ------------------------------------------------------------------ */
/* 4. createSessionListView: 构造与状态切换 (loading / error / empty)  */
/* ------------------------------------------------------------------ */

await t('createSessionListView: 构造时不触发渲染或 getContext', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let contextCalled = 0;
  createSessionListView({
    document: doc,
    container,
    getContext: () => { contextCalled += 1; return {}; },
    onOpenSession: () => {},
  });
  assert.equal(container.children.length, 0);
  assert.equal(contextCalled, 0);
});

await t('showLoading & showError: 呈现正确结构与文案', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({}),
    onOpenSession: () => {},
  });

  view.showLoading();
  assert.equal(container.children.length, 1);
  const loadingEl = container.children[0];
  assert.equal(loadingEl.className, 'empty');
  assert.equal(loadingEl.textContent, '载入中…');

  view.showError(new Error('网络断开'));
  assert.equal(container.children.length, 1);
  const errorEl = container.children[0];
  assert.equal(errorEl.className, 'empty');
  assert.equal(errorEl.textContent, '拉取会话失败：网络断开');
});

await t('render: 空列表呈现空提示文案', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({}),
    onOpenSession: () => {},
  });

  view.render([]);
  assert.equal(container.children.length, 1);
  const emptyEl = container.children[0];
  assert.equal(emptyEl.className, 'empty');
  assert.equal(emptyEl.textContent, '还没有会话。');
});

/* ------------------------------------------------------------------ */
/* 5. 排序不改动原数组与日期分组                                        */
/* ------------------------------------------------------------------ */

await t('render: 排序不修改原传入数组，并按日期分段归类', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  // 注入固定基准时间：2026-11-02 12:00:00 本地时间
  const fakeNow = new Date(2026, 10, 2, 12, 0, 0).getTime();
  const todayStart = new Date(2026, 10, 2, 0, 0, 0).getTime();

  const sToday = { id: '1', title: '今天会话', modified: todayStart + 3600e3 };
  const sYesterday = { id: '2', title: '昨天会话', modified: todayStart - 1000 };
  const sWeek = { id: '3', title: '本周会话', modified: todayStart - 3 * 86400e3 };
  const sEarlier = { id: '4', title: '更早会话', modified: todayStart - 10 * 86400e3 };

  // 乱序传入
  const originalList = [sYesterday, sEarlier, sToday, sWeek];
  const listCopy = [...originalList];

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({ agentName: 'Hana', agents: [] }),
    onOpenSession: () => {},
    now: () => fakeNow,
  });

  view.render(originalList);

  // 1. 验证原数组未被修改
  assert.deepEqual(originalList, listCopy);

  // 2. 检查 DOM 分组标签
  const groupLabels = container.querySelectorAll('.group-label');
  assert.equal(groupLabels.length, 4);
  assert.equal(groupLabels[0].textContent, '今天');
  assert.equal(groupLabels[1].textContent, '昨天');
  assert.equal(groupLabels[2].textContent, '最近一周');
  assert.equal(groupLabels[3].textContent, '更早');

  // 3. 检查每个 group-label 后跟着对应的 session-item
  const items = container.querySelectorAll('.session-item');
  assert.equal(items.length, 4);
  assert.equal(items[0].querySelector('.session-title').textContent, '今天会话');
  assert.equal(items[1].querySelector('.session-title').textContent, '昨天会话');
  assert.equal(items[2].querySelector('.session-title').textContent, '本周会话');
  assert.equal(items[3].querySelector('.session-title').textContent, '更早会话');
});

/* ------------------------------------------------------------------ */
/* 6. row(session) 节点结构、头像注入、元数据与点击事件                   */
/* ------------------------------------------------------------------ */

await t('row: 验证类名、头像注入、agents仅按id匹配与点击回调传原session', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const fakeNow = new Date(2026, 10, 2, 12, 0, 0).getTime();

  let clickedSession = null;
  const mockAgents = [
    { id: 'cat-agent', name: '猫娘', avatarUrl: '/cat.png' },
    { id: 'dog-agent', name: '修狗', hasAvatar: true },
  ];

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({
      agentName: '默认助理',
      homeFolder: '默认目录',
      agents: mockAgents,
    }),
    onOpenSession: (s) => {
      clickedSession = s;
    },
    now: () => fakeNow,
  });

  const sessionObj = {
    sessionId: 'sess-123',
    agentId: 'cat-agent',
    agentName: '猫娘',
    title: '重构测试会话',
    messageCount: 5,
    cwd: '/workspace/project-alpha',
    modified: fakeNow - 120e3, // 2分钟前
  };

  const rowEl = view.row(sessionObj);
  assert.equal(rowEl.className, 'session-item');

  // 头像元素与注入
  const av = rowEl.querySelector('.avatar.avatar-agent');
  assert.ok(av, '应有 avatar avatar-agent');
  assert.equal(av.title, '猫娘');
  const img = av.querySelector('img');
  assert.ok(img, 'cat-agent 具有 avatarUrl，应渲染 img');
  assert.equal(img.src, '/cat.png');

  // 标题
  const titleEl = rowEl.querySelector('.session-title');
  assert.equal(titleEl.textContent, '重构测试会话');

  // 元数据: [agent, '5 条', folder].join(' · ')
  const metaEl = rowEl.querySelector('.session-meta');
  assert.equal(metaEl.textContent, '猫娘 · 5 条 · project-alpha');

  // 时间
  const timeEl = rowEl.querySelector('.session-time');
  assert.equal(timeEl.textContent, '2 分钟前');

  // 点击触发并传递原对象引用
  rowEl.dispatchEvent({ type: 'click' });
  assert.equal(clickedSession, sessionObj);
});

await t('row: agents 仅按 id 匹配，id 不匹配或无图时退回首字母', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const fakeNow = 100000;

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({
      agentName: '默认',
      agents: [{ id: 'agent-1', name: '同名', avatarUrl: '/1.png' }],
    }),
    onOpenSession: () => {},
    now: () => fakeNow,
  });

  // agentId 为未知 id，即使 agentName 与某个 agent 相同也不按 name 匹配
  const rowEl = view.row({
    agentId: 'unknown-id',
    agentName: '同名',
    title: '未知智能体',
    modified: fakeNow,
  });

  const av = rowEl.querySelector('.avatar.avatar-agent');
  assert.equal(av.children.length, 0); // 没有 img
  assert.equal(av.textContent, '同'); // 首字母退回
});

/* ------------------------------------------------------------------ */
/* 6b. Code 会话行：Code 标识 + 原对象与 workspace 字段保留             */
/* ------------------------------------------------------------------ */

await t('row: Code 会话的 meta 显示 Code 标识，cwd 用 basename', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const fakeNow = 1000;

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({ agentName: '默认', homeFolder: '默认目录', agents: [] }),
    onOpenSession: () => {},
    now: () => fakeNow,
  });

  const rowEl = view.row({
    sessionId: 'sess-code',
    namespace: 'code',
    title: 'Code 会话',
    agentName: 'DeepSeek',
    messageCount: 12,
    cwd: 'C:\\Users\\\\example\\Desktop\\workspace\\hana-mobile',
    workspaceMountId: 'mount_abc',
    workspaceLabel: 'Hana Mobile Workspace',
    modified: fakeNow,
  });

  const metaEl = rowEl.querySelector('.session-meta');
  const badge = rowEl.querySelector('.session-ns-badge');
  assert.ok(badge, 'Code 会话应渲染 .session-ns-badge');
  assert.equal(badge.textContent, 'Code');
  assert.equal(badge.parentNode, metaEl, 'Code 标识应位于 session-meta 内');

  // cwd 展示沿用 sessionFolder 的 basename，而不是 workspaceLabel
  assert.ok(metaEl.textContent.includes('hana-mobile'), 'meta 应包含 cwd basename');
  assert.ok(!metaEl.textContent.includes('Workspace'), 'meta 不应改成 workspaceLabel');
  assert.ok(metaEl.textContent.includes('DeepSeek'));
  assert.ok(metaEl.textContent.includes('12 条'));
});

await t('row: Code 会话点击回传原对象，namespace/cwd/workspace 字段不丢', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let clicked = null;

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({ agentName: '默认', homeFolder: '默认目录', agents: [] }),
    onOpenSession: (s) => { clicked = s; },
    now: () => 1000,
  });

  const codeSession = {
    sessionId: 'sess-code-2',
    namespace: 'code',
    title: '手机端 Code 会话',
    agentName: 'DeepSeek',
    cwd: 'C:\\repo\\hana-mobile',
    workspaceMountId: 'mount_xyz',
    workspaceLabel: 'Hana Mobile',
    modified: 900,
  };

  const rowEl = view.row(codeSession);
  rowEl.dispatchEvent({ type: 'click' });

  assert.equal(clicked, codeSession, '必须回传同一对象引用');
  assert.equal(clicked.namespace, 'code');
  assert.equal(clicked.cwd, 'C:\\repo\\hana-mobile');
  assert.equal(clicked.workspaceMountId, 'mount_xyz');
  assert.equal(clicked.workspaceLabel, 'Hana Mobile');
});

await t('row: Chat 会话不出现 Code 标识，meta 布局保持原样', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({ agentName: 'Hana', homeFolder: '', agents: [] }),
    onOpenSession: () => {},
    now: () => 1000,
  });

  const rowEl = view.row({
    sessionId: 'sess-home',
    namespace: 'home',
    title: 'Chat 会话',
    agentName: 'Hana',
    messageCount: 2,
    cwd: '/work/project',
    modified: 900,
  });

  assert.equal(rowEl.querySelector('.session-ns-badge'), null);
  assert.equal(rowEl.querySelector('.session-meta').textContent, 'Hana · 2 条 · project');
});

/* ------------------------------------------------------------------ */
/* 7. 动态 getContext 测试                                             */
/* ------------------------------------------------------------------ */

await t('动态 getContext: 状态变更后渲染实时反映最新 context', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const fakeNow = 500000;

  let currentContext = {
    agentName: 'AgentA',
    homeFolder: 'dirA',
    agents: [],
  };

  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => currentContext,
    onOpenSession: () => {},
    now: () => fakeNow,
  });

  const s = { title: '测试动态上下文', modified: fakeNow };

  const row1 = view.row(s);
  assert.ok(row1.querySelector('.session-meta').textContent.includes('AgentA'));
  assert.ok(row1.querySelector('.session-meta').textContent.includes('dirA'));

  // 变更 context
  currentContext = {
    agentName: 'AgentB',
    homeFolder: 'dirB',
    agents: [{ id: 'b', avatarUrl: '/b.png' }],
  };

  const row2 = view.row(s);
  assert.ok(row2.querySelector('.session-meta').textContent.includes('AgentB'));
  assert.ok(row2.querySelector('.session-meta').textContent.includes('dirB'));

  const row3 = view.row({ ...s, agentId: 'b' });
  assert.ok(row3.querySelector('img'), 'agentId: b 应当渲染出头像 img');
});

await t('render: 置顶会话单独成组排在最前', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const nowMs = Date.parse('2026-11-03T11:00:00Z');
  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({}),
    onOpenSession: () => {},
    now: () => nowMs,
  });
  const pinned = {
    path: 'a',
    title: '钉住的',
    modified: new Date(nowMs - 3600e3).toISOString(),
    pinnedAt: '2026-11-03T09:00:00Z',
  };
  const normal = { path: 'b', title: '普通的', modified: new Date(nowMs).toISOString() };
  view.render([normal, pinned]);
  const labels = container.children
    .filter((c) => c.className === 'group-label')
    .map((c) => c.textContent);
  assert.equal(labels[0], '置顶', '第一个分组必须是置顶');
  assert.deepEqual(labels.slice(1), ['今天'], '置顶之外的仍按日期分组');
});

await t('render: 乐观更新置顶（仅带 pinned: true 无 pinnedAt）必须进入置顶分组', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const nowMs = Date.parse('2026-11-03T11:00:00Z');
  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({}),
    onOpenSession: () => {},
    now: () => nowMs,
  });

  const session = { path: 'c', title: '待置顶会话', modified: new Date(nowMs).toISOString() };
  const list = [session];

  // 使用 session-actions 的真实 planTogglePin 进行乐观更新
  const plan = planTogglePin(session);
  const updatedList = plan.apply(list);

  assert.equal(updatedList[0].pinned, true);
  assert.equal(updatedList[0].pinnedAt, undefined, '乐观更新未产生 pinnedAt');

  view.render(updatedList);
  const labels = container.children
    .filter((c) => c.className === 'group-label')
    .map((c) => c.textContent);
  assert.equal(labels[0], '置顶', '仅有 pinned: true 的会话必须被渲染在置顶分组');
});

await t('render: 乐观更新取消置顶（带旧 pinnedAt 但 pinned: false）绝不得进入置顶分组', () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const nowMs = Date.parse('2026-11-03T11:00:00Z');
  const view = createSessionListView({
    document: doc,
    container,
    getContext: () => ({}),
    onOpenSession: () => {},
    now: () => nowMs,
  });

  const pinnedSession = {
    path: 'd',
    title: '已置顶会话',
    modified: new Date(nowMs).toISOString(),
    pinnedAt: '2026-11-03T09:00:00Z',
  };
  const list = [pinnedSession];

  // 使用 session-actions 真实 planTogglePin 取消置顶
  const plan = planTogglePin(pinnedSession);
  const updatedList = plan.apply(list);

  assert.equal(updatedList[0].pinned, false);
  assert.ok(updatedList[0].pinnedAt, '保留了原 session 上的 pinnedAt');

  view.render(updatedList);
  const labels = container.children
    .filter((c) => c.className === 'group-label')
    .map((c) => c.textContent);
  assert.ok(!labels.includes('置顶'), '取消置顶后绝不能存在置顶分组标签');
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
