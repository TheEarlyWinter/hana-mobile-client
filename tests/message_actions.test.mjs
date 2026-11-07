/* tests/message_actions.test.mjs — 消息操作模块契约测试
 *
 * 覆盖四层：
 * 1. 纯函数可用性：流式中禁用、非最后一条不给入口、没有会话给明确原因；
 * 2. 请求体构造：retry 用 {sessionId, sessionPath}，replay 用 {path}；
 * 3. 复制降级：clipboard 失败 → execCommand，仍失败返回明确状态；
 * 4. 视图与执行器：菜单只画可见操作、禁用项不可点、onRun 收到原始动作与消息、
 *    执行器按 plan 调 api / 回填输入框，且永不抛异常。
 *
 * 不启动页面、不连网关、不依赖浏览器。
 */

import assert from 'node:assert/strict';
import {
  actionsForMessage,
  buildRetryRequest,
  buildReplayRequest,
  copyTextToClipboard,
  runMessageAction,
  createMessageActionsMenu,
} from '../web/message-actions.js';

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
/* 最小 DOM 夹具（只实现模块用到的 API）                                */
/* ------------------------------------------------------------------ */

function matches(node, selector) {
  if (!node || typeof selector !== 'string') return false;
  if (selector.startsWith('.')) {
    return String(node.className || '').split(/\s+/).includes(selector.slice(1));
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq === -1) return node.getAttribute(body) != null;
    const key = body.slice(0, eq);
    const raw = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return node.getAttribute(key) === raw;
  }
  return String(node.tagName || '').toLowerCase() === selector.toLowerCase();
}

class MockElement {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.type = '';
    this.attributes = new Map();
    this._listeners = new Map();
  }

  setAttribute(key, value) {
    this.attributes.set(String(key), String(value));
  }

  getAttribute(key) {
    return this.attributes.has(String(key)) ? this.attributes.get(String(key)) : null;
  }

  removeAttribute(key) {
    this.attributes.delete(String(key));
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    const idx = this.children.indexOf(before);
    if (idx === -1) return this.appendChild(child);
    child.parentNode = this;
    this.children.splice(idx, 0, child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type) || [];
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(ev) {
    const event = ev || {};
    if (!event.target) event.target = this;
    const list = this._listeners.get(event.type) || [];
    for (const fn of [...list]) fn.call(this, event);
    return true;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  select() {}

  setSelectionRange() {}

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}

function createMockDocument({ execCommandResult = true } = {}) {
  const doc = {
    activeElement: null,
    body: null,
    execCommands: [],
    created: [],
    createElement(tag) {
      const node = new MockElement(tag);
      node.ownerDocument = doc;
      doc.created.push(node);
      return node;
    },
    execCommand(cmd) {
      doc.execCommands.push(cmd);
      const area = doc.body.children.find((child) => child.tagName === 'TEXTAREA') || null;
      doc.lastCopiedText = area ? area.value : null;
      return execCommandResult;
    },
  };
  doc.body = doc.createElement('body');
  return doc;
}

function fakeNavigator(writeText) {
  return writeText ? { clipboard: { writeText } } : {};
}

/* ------------------------------------------------------------------ */
/* 固定数据                                                            */
/* ------------------------------------------------------------------ */

const SESSION = { sessionId: 'sess_1', path: 'C:\\hana\\sessions\\a.jsonl' };
const LAST_ASSISTANT = {
  id: '12',
  role: 'assistant',
  text: '这是最后一条助手回复。',
  isLastAssistant: true,
};
const OLD_ASSISTANT = {
  id: '9',
  role: 'assistant',
  text: '这是更早的助手回复。',
  isLastAssistant: false,
};
const LAST_USER = {
  id: '11',
  role: 'user',
  text: '这是最后一条用户消息',
  isLastUser: true,
};
const OLD_USER = {
  id: '8',
  role: 'user',
  text: '这是更早的用户消息',
  isLastUser: false,
};

function actionById(result, id) {
  return (result.actions || []).find((action) => action.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* 1. 纯函数：可用性判定                                               */
/* ------------------------------------------------------------------ */

await t('最后一条助手回复：重试可用，执行计划是 turns/retry', () => {
  const result = actionsForMessage(LAST_ASSISTANT, { session: SESSION, streaming: false });
  const retry = actionById(result, 'retry');
  assert.ok(retry, '应有 retry 操作');
  assert.equal(retry.available, true);
  assert.equal(retry.hidden, false);
  assert.equal(retry.reason, '');
  assert.deepEqual(retry.plan, {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/turns/retry',
    body: { sessionId: 'sess_1', sessionPath: 'C:\\hana\\sessions\\a.jsonl' },
  });
});

await t('非最后一条助手回复：重试不给入口（hidden=true）并带原因', () => {
  const result = actionsForMessage(OLD_ASSISTANT, { session: SESSION, streaming: false });
  const retry = actionById(result, 'retry');
  assert.ok(retry, '纯函数仍返回候选，由 UI 隐藏');
  assert.equal(retry.available, false);
  assert.equal(retry.hidden, true);
  assert.equal(retry.reasonCode, 'not-last');
  assert.match(retry.reason, /最后一条/);
  assert.equal(retry.plan, null);
});

await t('正在生成回复：重试与编辑重发都禁用，且原因可读', () => {
  const assistant = actionsForMessage(LAST_ASSISTANT, { session: SESSION, streaming: true });
  const retry = actionById(assistant, 'retry');
  assert.equal(retry.available, false);
  assert.equal(retry.hidden, false);
  assert.equal(retry.reasonCode, 'streaming');
  assert.match(retry.reason, /正在生成/);
  assert.equal(retry.plan, null);

  const user = actionsForMessage(LAST_USER, { session: SESSION, streaming: true });
  const edit = actionById(user, 'edit-resend');
  assert.equal(edit.available, false);
  assert.equal(edit.hidden, false);
  assert.equal(edit.reasonCode, 'streaming');
  assert.match(edit.reason, /正在生成/);
  assert.equal(edit.plan, null);
});

await t('没有会话：重试、编辑重发、重发都给出「没有打开的会话」', () => {
  for (const message of [LAST_ASSISTANT, LAST_USER]) {
    const result = actionsForMessage(message, { session: null, streaming: false });
    for (const id of ['retry', 'edit-resend', 'replay']) {
      const action = actionById(result, id);
      if (!action) continue;
      assert.equal(action.available, false, `${id} 应不可用`);
      assert.equal(action.hidden, false, `${id} 应显示为禁用，而不是消失`);
      assert.equal(action.reasonCode, 'no-session');
      assert.match(action.reason, /没有打开的会话/);
    }
  }
});

await t('用 lastAssistantId/lastUserId 也能判定最后一条', () => {
  const assistant = actionsForMessage(
    { id: '42', role: 'assistant', text: '回答' },
    { session: SESSION, streaming: false, lastAssistantId: '42' },
  );
  assert.equal(actionById(assistant, 'retry').available, true);

  const user = actionsForMessage(
    { id: 0, role: 'user', text: '问题' },
    { session: SESSION, streaming: false, lastUserId: 0 },
  );
  assert.equal(actionById(user, 'replay').available, true, 'id=0 是合法消息 id');
});

await t('消息自带 isLastAssistant 优先于外部 id 判定', () => {
  const result = actionsForMessage(
    { id: '12', role: 'assistant', text: '回答', isLastAssistant: false },
    { session: SESSION, streaming: false, lastAssistantId: '12' },
  );
  assert.equal(actionById(result, 'retry').hidden, true);
});

/* ------------------------------------------------------------------ */
/* 2. 纯函数：编辑重发与复制                                           */
/* ------------------------------------------------------------------ */

await t('用户消息：编辑重发返回原文，不伪造服务端改写', () => {
  const raw = '第一行\n第二行「带标点」';
  const result = actionsForMessage({ id: '11', role: 'user', text: raw, isLastUser: true }, {
    session: SESSION,
    streaming: false,
  });
  const edit = actionById(result, 'edit-resend');
  assert.ok(edit);
  assert.equal(edit.available, true);
  assert.deepEqual(edit.plan, { kind: 'edit', text: raw });
  assert.equal(edit.plan.text, raw, '必须原样回填，不能 trim 或改写');
});

await t('复制全文：原样带走 message.text', () => {
  const result = actionsForMessage(LAST_USER, { session: null, streaming: true });
  const copy = actionById(result, 'copy');
  assert.equal(copy.available, true, '流式中也可以复制');
  assert.deepEqual(copy.plan, { kind: 'copy', text: LAST_USER.text });
});

await t('空正文：复制和编辑重发不给入口', () => {
  const user = actionsForMessage({ id: '1', role: 'user', text: '   ', isLastUser: true }, {
    session: SESSION,
    streaming: false,
  });
  assert.equal(actionById(user, 'copy').hidden, true);
  assert.equal(actionById(user, 'copy').reasonCode, 'empty-text');
  assert.equal(actionById(user, 'edit-resend').hidden, true);
  assert.equal(actionById(user, 'edit-resend').reasonCode, 'empty-text');

  const assistant = actionsForMessage({ id: '2', role: 'assistant', text: '', isLastAssistant: true }, {
    session: SESSION,
    streaming: false,
  });
  assert.equal(actionById(assistant, 'copy').hidden, true);
  assert.equal(actionById(assistant, 'retry').available, true, '空回复仍可重试生成');
});

await t('content 数组：拼出文本块，忽略图片块', () => {
  const result = actionsForMessage({
    id: '3',
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', data: 'xxx', mimeType: 'image/png' },
      { type: 'text', text: '谢谢' },
    ],
  }, { session: SESSION, streaming: false });
  assert.equal(actionById(result, 'copy').plan.text, '看这张图\n谢谢');
});

await t('未知角色：不返回任何操作', () => {
  const result = actionsForMessage({ role: 'system', text: '系统提示' }, {
    session: SESSION,
    streaming: false,
  });
  assert.deepEqual(result.actions, []);
});

/* ------------------------------------------------------------------ */
/* 3. 纯函数：重发与请求体                                             */
/* ------------------------------------------------------------------ */

await t('最后一条用户消息：重发执行计划只用 { path }', () => {
  const result = actionsForMessage(LAST_USER, { session: SESSION, streaming: false });
  const replay = actionById(result, 'replay');
  assert.equal(replay.available, true);
  assert.deepEqual(replay.plan, {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/latest-user-message/replay',
    body: { path: 'C:\\hana\\sessions\\a.jsonl' },
  });
});

await t('非最后一条用户消息：重发不给入口', () => {
  const result = actionsForMessage(OLD_USER, { session: SESSION, streaming: false });
  const replay = actionById(result, 'replay');
  assert.equal(replay.available, false);
  assert.equal(replay.hidden, true);
  assert.equal(replay.reasonCode, 'not-last');
});

await t('buildRetryRequest：按可用字段构造，绝不发空 body', () => {
  assert.deepEqual(buildRetryRequest(SESSION), {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/turns/retry',
    body: { sessionId: 'sess_1', sessionPath: 'C:\\hana\\sessions\\a.jsonl' },
  });
  assert.deepEqual(buildRetryRequest({ sessionId: 'sess_2' }), {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/turns/retry',
    body: { sessionId: 'sess_2' },
  });
  assert.deepEqual(buildRetryRequest({ path: 'D:\\x.jsonl' }), {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/turns/retry',
    body: { sessionPath: 'D:\\x.jsonl' },
  });
  assert.equal(buildRetryRequest(null), null);
  assert.equal(buildRetryRequest({}), null);
});

await t('buildReplayRequest：没有 path 就不构造（服务端只认 path）', () => {
  assert.deepEqual(buildReplayRequest(SESSION), {
    kind: 'http',
    method: 'POST',
    path: '/api/sessions/latest-user-message/replay',
    body: { path: 'C:\\hana\\sessions\\a.jsonl' },
  });
  assert.equal(buildReplayRequest({ sessionId: 'sess_2' }), null);
  assert.equal(buildReplayRequest(null), null);
});

/* ------------------------------------------------------------------ */
/* 4. 复制降级                                                         */
/* ------------------------------------------------------------------ */

await t('复制优先走 navigator.clipboard.writeText', async () => {
  let written = null;
  const result = await copyTextToClipboard('正文', {
    navigator: fakeNavigator(async (text) => { written = text; }),
    document: createMockDocument(),
  });
  assert.deepEqual(result, { ok: true, via: 'clipboard', message: '已复制' });
  assert.equal(written, '正文');
});

await t('clipboard 抛错时降级到 execCommand，并清理临时节点', async () => {
  const doc = createMockDocument({ execCommandResult: true });
  const result = await copyTextToClipboard('降级正文', {
    navigator: fakeNavigator(async () => { throw new Error('denied'); }),
    document: doc,
  });
  assert.deepEqual(result, { ok: true, via: 'execCommand', message: '已复制' });
  assert.deepEqual(doc.execCommands, ['copy']);
  assert.equal(doc.lastCopiedText, '降级正文', '临时 textarea 里必须是原文');
  assert.equal(doc.body.children.length, 0, '临时节点必须移除');
});

await t('没有 clipboard API 时直接走 execCommand', async () => {
  const doc = createMockDocument({ execCommandResult: true });
  const result = await copyTextToClipboard('老 WebView', { navigator: {}, document: doc });
  assert.equal(result.ok, true);
  assert.equal(result.via, 'execCommand');
});

await t('两条路都失败时返回明确状态，不抛异常', async () => {
  const denied = await copyTextToClipboard('x', {
    navigator: fakeNavigator(async () => { throw new Error('denied'); }),
    document: createMockDocument({ execCommandResult: false }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'copy-failed');
  assert.match(denied.message, /复制失败/);

  const unsupported = await copyTextToClipboard('x', {
    navigator: {},
    document: { body: {} },
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'unsupported');
  assert.match(unsupported.message, /不支持复制/);
});

await t('空文本不碰剪贴板，返回 empty', async () => {
  let called = false;
  const result = await copyTextToClipboard('   ', {
    navigator: fakeNavigator(async () => { called = true; }),
    document: createMockDocument(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'empty');
  assert.equal(called, false);
});

/* ------------------------------------------------------------------ */
/* 5. 执行器：只按注入的适配器动作                                     */
/* ------------------------------------------------------------------ */

await t('执行器：http plan 用 JSON body 调注入的 api', async () => {
  const action = actionById(
    actionsForMessage(LAST_ASSISTANT, { session: SESSION, streaming: false }),
    'retry',
  );
  const calls = [];
  const result = await runMessageAction(action, {
    api: async (path, init) => {
      calls.push({ path, init });
      return { ok: true, streamId: 's1' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'request-ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/sessions/turns/retry');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'sess_1',
    sessionPath: 'C:\\hana\\sessions\\a.jsonl',
  });
});

await t('执行器：编辑重发把原文交给 fillComposer，不自动发送', async () => {
  const action = actionById(
    actionsForMessage(LAST_USER, { session: SESSION, streaming: false }),
    'edit-resend',
  );
  const filled = [];
  const result = await runMessageAction(action, {
    fillComposer: async (text) => { filled.push(text); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'composer-filled');
  assert.deepEqual(filled, [LAST_USER.text]);
});

await t('执行器：复制 plan 委托注入的 copy，并透传失败状态', async () => {
  const action = actionById(
    actionsForMessage(LAST_USER, { session: SESSION, streaming: false }),
    'copy',
  );
  const copied = [];
  const ok = await runMessageAction(action, {
    copy: async (text) => {
      copied.push(text);
      return { ok: true, via: 'clipboard', message: '已复制' };
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(copied, [LAST_USER.text]);

  const failed = await runMessageAction(action, {
    copy: async () => ({ ok: false, code: 'copy-failed', message: '复制失败' }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'copy-failed');
});

await t('执行器：请求失败不抛，409 给出会话忙的提示', async () => {
  const action = actionById(
    actionsForMessage(LAST_ASSISTANT, { session: SESSION, streaming: false }),
    'retry',
  );
  const busy = await runMessageAction(action, {
    api: async () => {
      const err = new Error('409 session_busy');
      err.status = 409;
      throw err;
    },
  });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'session-busy');
  assert.match(busy.message, /正在生成/);

  const failed = await runMessageAction(action, {
    api: async () => { throw new Error('boom'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'request-failed');
  assert.match(failed.message, /boom/);

  // 409 不全是「会话忙」：locator 不一致也走 409，不能被误报成正在生成。
  const mismatch = await runMessageAction(action, {
    api: async () => {
      const err = new Error('409 session_locator_mismatch');
      err.status = 409;
      err.body = { error: 'session_locator_mismatch' };
      throw err;
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'request-failed');
  assert.doesNotMatch(mismatch.message, /正在生成/);
});

await t('执行器：不可用动作/缺适配器都返回明确失败', async () => {
  const unavailable = actionById(
    actionsForMessage(OLD_ASSISTANT, { session: SESSION, streaming: false }),
    'retry',
  );
  const blocked = await runMessageAction(unavailable, {});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'unavailable');

  const retry = actionById(
    actionsForMessage(LAST_ASSISTANT, { session: SESSION, streaming: false }),
    'retry',
  );
  const noApi = await runMessageAction(retry, {});
  assert.equal(noApi.ok, false);
  assert.equal(noApi.code, 'api-unavailable');
});

/* ------------------------------------------------------------------ */
/* 6. 视图：只画可见操作，点击才调 onRun                               */
/* ------------------------------------------------------------------ */

function openMenu(doc, runs, options = {}) {
  const menu = createMessageActionsMenu({
    mount: doc.body,
    document: doc,
    onRun: (payload) => {
      runs.push(payload);
      return { ok: true };
    },
    onError: options.onError,
  });
  return menu;
}

function itemFor(doc, actionId) {
  return doc.body
    .querySelectorAll('.msg-actions-item')
    .find((node) => node.getAttribute('data-action') === actionId) || null;
}

await t('菜单：最后一条助手回复显示重试与复制，点击回传动作和原始消息', () => {
  const doc = createMockDocument();
  const runs = [];
  const menu = openMenu(doc, runs);
  assert.equal(menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } }), true);
  assert.equal(menu.isOpen(), true);

  const retry = itemFor(doc, 'retry');
  const copy = itemFor(doc, 'copy');
  assert.ok(retry, '应有重试按钮');
  assert.ok(copy, '应有复制按钮');
  assert.equal(retry.disabled, false);

  retry.dispatchEvent({ type: 'click' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].action.id, 'retry');
  assert.equal(runs[0].message, LAST_ASSISTANT, '必须原样回传消息对象');
  assert.deepEqual(runs[0].context.session, SESSION);
  assert.equal(menu.isOpen(), false, '点击后应关闭菜单');
});

await t('菜单：非最后一条助手回复没有重试入口', () => {
  const doc = createMockDocument();
  const menu = openMenu(doc, []);
  menu.open({ message: OLD_ASSISTANT, context: { session: SESSION, streaming: false } });
  assert.equal(itemFor(doc, 'retry'), null);
  assert.ok(itemFor(doc, 'copy'));
  menu.close();
});

await t('菜单：流式中重试是禁用态，显示原因且点击不触发 onRun', () => {
  const doc = createMockDocument();
  const runs = [];
  const menu = openMenu(doc, runs);
  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: true } });

  const retry = itemFor(doc, 'retry');
  assert.ok(retry);
  assert.equal(retry.disabled, true);
  assert.equal(retry.getAttribute('aria-disabled'), 'true');
  const reason = retry.querySelector('.msg-actions-reason');
  assert.ok(reason);
  assert.match(reason.textContent, /正在生成/);

  retry.dispatchEvent({ type: 'click' });
  assert.equal(runs.length, 0, '禁用项不应执行');
  menu.close();
});

await t('菜单：没有可见操作时不开、也不往 mount 里塞节点', () => {
  const doc = createMockDocument();
  const menu = openMenu(doc, []);
  assert.equal(menu.open({ message: { role: 'system', text: '系统消息' }, context: {} }), false);
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.body.children.length, 0);
});

await t('菜单：取消按钮与遮罩都只关闭，不调用 onRun', () => {
  const doc = createMockDocument();
  const runs = [];
  const menu = openMenu(doc, runs);
  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } });

  doc.body.querySelector('.msg-actions-cancel').dispatchEvent({ type: 'click' });
  assert.equal(menu.isOpen(), false);
  assert.equal(runs.length, 0);

  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } });
  const root = doc.body.querySelector('.msg-actions');
  root.dispatchEvent({ type: 'click', target: root });
  assert.equal(menu.isOpen(), false);
  assert.equal(runs.length, 0);

  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } });
  root.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(menu.isOpen(), false, 'Escape 应关闭菜单');
});

await t('菜单：onRun 抛错时走 onError，不把异常漏出去', () => {
  const doc = createMockDocument();
  const errors = [];
  const menu = createMessageActionsMenu({
    mount: doc.body,
    document: doc,
    onRun: () => { throw new Error('executor boom'); },
    onError: (err) => { errors.push(err); },
  });
  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } });
  itemFor(doc, 'retry').dispatchEvent({ type: 'click' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /executor boom/);
  assert.equal(menu.isOpen(), false);
});

await t('菜单：destroy 移除自己的节点，之后 open 不再工作', () => {
  const doc = createMockDocument();
  const menu = openMenu(doc, []);
  menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } });
  assert.equal(doc.body.children.length, 1);
  menu.destroy();
  assert.equal(doc.body.children.length, 0);
  assert.equal(menu.open({ message: LAST_ASSISTANT, context: { session: SESSION, streaming: false } }), false);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll message action tests passed.');
}
