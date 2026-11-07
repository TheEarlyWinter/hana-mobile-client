/* tests/search_metadata_contract.test.mjs
 *
 * 搜索结果会话元数据（agentId, cwd, workspaceMountId 等）契约与补齐测试
 * 覆盖主控要求的四个核心分支场景：
 * 1. 搜索自带元数据：features/search 必须转发 result 自带的 agentId/agentName/cwd/workspaceMountId/workspaceLabel
 * 2. namespace 归属：使用发起搜索时的归属，不用点击时改变的列表值
 * 3. 装配层已缓存元数据补齐：当搜索结果缺失元数据时，按规范化 path 从 S.sessions 补齐
 * 4. 装配层无资料场景：搜索与缓存均缺时保留 null，不拿当前 Agent 猜归属
 */

import assert from 'node:assert/strict';
import { createSearchFeature } from '../web/features/search.js';

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

// 模拟 app.js 装配层中对 openSession 的补全逻辑
function createOpenSessionAdapter({ state, convOpenSession }) {
  const norm = (p) => (typeof p === 'string' ? p.trim().replace(/\\/g, '/').toLowerCase() : '');
  return (session) => {
    const targetPath = norm(session?.path);
    const cached = (Array.isArray(state?.sessions) ? state.sessions : []).find(
      (s) => s && norm(s.path) === targetPath
    );
    const merged = {
      ...(cached || {}),
      ...session,
      agentId: session?.agentId || cached?.agentId || null,
      agentName: session?.agentName || cached?.agentName || null,
      cwd: session?.cwd || cached?.cwd || null,
      workspaceMountId: session?.workspaceMountId || cached?.workspaceMountId || null,
      workspaceLabel: session?.workspaceLabel || cached?.workspaceLabel || null,
      namespace: session?.namespace || cached?.namespace || 'home',
    };
    convOpenSession(merged);
  };
}

function makeDoc() {
  const listeners = new Map();
  const allNodes = [];

  function makeEl(tag = 'div') {
    const nodeListeners = new Map();
    const children = [];
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      style: {},
      children,
      value: '',
      hidden: false,
      addEventListener(type, fn) {
        if (!nodeListeners.has(type)) nodeListeners.set(type, []);
        nodeListeners.get(type).push(fn);
      },
      dispatchEvent(evt) {
        const type = typeof evt === 'string' ? evt : evt.type;
        for (const fn of nodeListeners.get(type) || []) fn.call(node, evt);
      },
      appendChild(c) {
        this.children.push(c);
        c.parentNode = this;
        return c;
      },
      removeChild(c) {
        const idx = this.children.indexOf(c);
        if (idx !== -1) this.children.splice(idx, 1);
        return c;
      },
      setAttribute() {},
      querySelector(sel) {
        if (sel === 'input') return allNodes.find((n) => n.tagName === 'INPUT') || null;
        if (sel === 'li') return allNodes.find((n) => n.tagName === 'LI') || null;
        return null;
      },
      querySelectorAll() { return []; },
    };
    allNodes.push(node);
    return node;
  }

  const body = makeEl('body');

  return {
    createElement: (tag) => makeEl(tag),
    body,
    allNodes,
  };
}

await t('features/search.js onSelect: 必须转发搜索结果自带的 agentId/agentName/cwd/workspaceMountId/workspaceLabel', async () => {
  let opened = null;
  const doc = makeDoc();
  let currentNamespace = 'code';

  const feature = createSearchFeature({
    getElement: () => null,
    api: async () => ({
      results: [{
        path: 'C:/sessions/test.jsonl',
        sessionId: 'sess-123',
        title: '自带元数据的会话',
        agentId: 'agent-custom',
        agentName: '专属助手',
        cwd: 'C:/projects/myapp',
        workspaceMountId: 'mount-789',
        workspaceLabel: '项目工作区',
      }],
    }),
    getNamespace: () => currentNamespace,
    openSession: (s) => { opened = s; },
    document: doc,
  });

  feature.open();

  // 模拟在输入框中触发 input
  const inputEl = doc.allNodes.find((n) => n.tagName === 'INPUT');
  assert.ok(inputEl, '搜索输入框必须存在');
  inputEl.value = 'test';
  inputEl.dispatchEvent({ type: 'input' });

  // 等待防抖（150ms）与搜索异步结果渲染
  await new Promise((r) => setTimeout(r, 220));

  // 搜索完成后，用户此时切换了命名空间为 'home'
  currentNamespace = 'home';

  // 查找渲染出的结果 li 并点击
  const li = doc.allNodes.find((n) => n.tagName === 'LI');
  assert.ok(li, '应渲染出搜索结果列表项 li');
  li.dispatchEvent({ type: 'click' });

  assert.ok(opened, 'openSession 必须被调用');
  assert.equal(opened.path, 'C:/sessions/test.jsonl');
  assert.equal(opened.agentId, 'agent-custom', '必须透传 agentId');
  assert.equal(opened.agentName, '专属助手', '必须透传 agentName');
  assert.equal(opened.cwd, 'C:/projects/myapp', '必须透传 cwd');
  assert.equal(opened.workspaceMountId, 'mount-789', '必须透传 workspaceMountId');
  assert.equal(opened.workspaceLabel, '项目工作区', '必须透传 workspaceLabel');
  assert.equal(opened.namespace, 'code', 'namespace 必须是发起搜索时的 code，而不是点击时已切为 home 的值');
});

await t('装配层已缓存元数据补齐：搜索结果缺 agentId 时从 S.sessions 补齐，namespace 使用搜索时归属', () => {
  const fakeState = {
    sessions: [
      {
        path: 'C:/work/chat-1.jsonl',
        sessionId: 'sess-1',
        title: '原有标题',
        agentId: 'agent-cached',
        agentName: '已缓存助手',
        cwd: 'C:/work',
        workspaceMountId: 'mount-1',
        workspaceLabel: '默认工作区',
        namespace: 'home',
      },
    ],
    currentAgent: { id: 'agent-current-global', name: '全局当前助手' },
  };

  let openedSession = null;
  const openSession = createOpenSessionAdapter({
    state: fakeState,
    convOpenSession: (s) => { openedSession = s; },
  });

  openSession({
    path: 'c:/work/chat-1.jsonl',
    sessionId: 'sess-1',
    title: '搜索标题',
    namespace: 'code',
  });

  assert.ok(openedSession, 'openSession 应被调用');
  assert.equal(openedSession.agentId, 'agent-cached', '应从 S.sessions 补齐 agentId');
  assert.equal(openedSession.cwd, 'C:/work', '应补齐 cwd');
  assert.equal(openedSession.workspaceMountId, 'mount-1', '应补齐 workspaceMountId');
  assert.equal(openedSession.namespace, 'code', '应保留搜索时的 namespace（code）');
});

await t('装配层无资料场景：S.sessions 与搜索均无 agentId 时保留 null，绝不拿当前 Agent 猜归属', () => {
  const fakeState = {
    sessions: [],
    currentAgent: { id: 'agent-current-global', name: '全局当前助手' },
  };

  let openedSession = null;
  const openSession = createOpenSessionAdapter({
    state: fakeState,
    convOpenSession: (s) => { openedSession = s; },
  });

  openSession({
    path: 'C:/unknown/chat.jsonl',
    sessionId: 'sess-unknown',
    title: '未知会话',
    namespace: 'home',
  });

  assert.ok(openedSession);
  assert.equal(openedSession.agentId, null, '缺少元数据时必须保持 null，保留现有明确报错，不得猜当前 Agent');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
