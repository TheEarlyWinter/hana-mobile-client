/* tests/archive_feature.test.mjs — 归档会话特性
 *
 * 盯四件事：
 *   1. 抽屉里真的多出一个「归档会话」入口；
 *   2. 点开按 /api/sessions/archived 拉列表并渲染标题、助手名、归档时间；
 *   3. 点「还原」发 POST /api/sessions/restore，路径用归档行自己的 path，成功后该行消失；
 *   4. 失败时行不消失、按钮恢复可用、状态栏给出原因。
 */

import assert from 'node:assert/strict';
import { createArchiveFeature } from '../web/features/archive.js';

/** 够用的最小 DOM：只要 createElement / appendChild / innerHTML='' 与事件派发。 */
function createDoc() {
  const body = makeNode('body');
  const doc = {
    body,
    createElement(tag) {
      return makeNode(tag);
    },
  };
  return doc;
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    hidden: false,
    disabled: false,
    textContent: '',
    type: '',
    parentNode: null,
    children: [],
    listeners: new Map(),
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name];
    },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    dispatchEvent(type) {
      for (const fn of this.listeners.get(type) || []) fn({ type, target: this });
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = this;
      const index = this.children.indexOf(ref);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    },
    get textContent() {
      if (this._text != null) return this._text;
      return this.children.map((c) => c.textContent).join('');
    },
    set textContent(value) {
      this._text = value;
      this.children.length = 0;
    },
    set innerHTML(value) {
      this._html = value;
      this.children.length = 0;
    },
    get innerHTML() {
      return this._html || '';
    },
  };
  return node;
}

const calls = [];
let archived = [
  {
    path: 'C:/work/sessions/archived/a.jsonl',
    sessionId: 's-a',
    title: '上次那个方案',
    archivedAt: '2026-11-03T09:20:00.000Z',
    agentName: 'Hana',
  },
  {
    path: 'C:/work/sessions/archived/b.jsonl',
    sessionId: 's-b',
    title: '无关紧要的调试',
    archivedAt: '2026-11-02T22:05:00.000Z',
    agentName: 'Luna',
  },
];

let restoreFails = false;

const api = async (path, init = {}) => {
  calls.push({ path, method: (init.method || 'GET').toUpperCase(), body: init.body || null });
  if (path === '/api/sessions/archived') return { sessions: archived };
  if (path === '/api/sessions/restore') {
    if (restoreFails) throw new Error('宿主返回 409');
    return { ok: true };
  }
  return {};
};

const doc = createDoc();
const listHost = makeNode('div');
listHost.id = 'sessionList';
const listParent = makeNode('div');
listParent.appendChild(listHost);

const elements = { sessionList: listHost };
let restoredNotified = 0;
const flashes = [];

const feature = createArchiveFeature({
  getElement: (id) => elements[id] || null,
  api,
  flash: (text) => flashes.push(text),
  onRestored: () => { restoredNotified += 1; },
  document: doc,
});

feature.mount();

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

await t('抽屉里出现归档入口，且插在会话列表之前', async () => {
  const btn = listParent.children.find((n) => n.id === 'btnArchivedList');
  assert.ok(btn, '应插入 #btnArchivedList');
  assert.equal(btn.textContent, '归档会话');
  assert.equal(listParent.children.indexOf(btn) < listParent.children.indexOf(listHost), true, '应在列表之前');
});

await t('打开时拉归档列表并渲染标题、助手名、归档时间、还原按钮', async () => {
  await feature.open();
  assert.equal(calls.filter((c) => c.path === '/api/sessions/archived').length, 1);

  const panel = doc.body.children.find((n) => n.className === 'archive-panel');
  assert.ok(panel, '应挂上面板');
  assert.equal(panel.hidden, false);

  const text = panel.textContent;
  assert.ok(text.includes('上次那个方案'), `应渲染标题：${text}`);
  assert.ok(text.includes('Hana'), '应渲染助手名');
  assert.ok(text.includes('2026-11-03'), '应渲染归档日期');
  assert.ok(text.includes('还原'), '应有还原按钮');
});

await t('点还原发 POST，sessionPath 用归档行自己的路径，成功后该行消失', async () => {
  const panel = doc.body.children.find((n) => n.className === 'archive-panel');
  const restoreBtns = [];
  const walk = (node) => {
    if (node.className === 'archive-panel-restore') restoreBtns.push(node);
    for (const child of node.children) walk(child);
  };
  walk(panel);
  assert.equal(restoreBtns.length, 2, '两行各一个还原按钮');

  restoreBtns[0].dispatchEvent('click');
  await new Promise((r) => setTimeout(r, 0));

  const post = calls.find((c) => c.path === '/api/sessions/restore');
  assert.ok(post, '应发还原请求');
  assert.equal(post.method, 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.sessionPath, 'C:/work/sessions/archived/a.jsonl');
  assert.equal(body.sessionId, 's-a');

  assert.equal(feature.getRows().length, 1, '还原成功后应从归档列表移除');
  assert.equal(restoredNotified, 1, '应通知外层刷新活跃列表');
  assert.ok(flashes.some((f) => f.includes('还原')), '应给一句提示');
});

await t('还原失败时行保留、按钮恢复可用、状态栏说明原因', async () => {
  restoreFails = true;
  // 重新打开会按假接口再拉一次，所以行数要在 open 之后取。
  await feature.open();
  const rowsBefore = feature.getRows().length;
  assert.ok(rowsBefore >= 1, '必须至少有一行才能验失败分支');

  const panel = doc.body.children.find((n) => n.className === 'archive-panel');
  let btn = null;
  const walk = (node) => {
    if (!btn && node.className === 'archive-panel-restore') btn = node;
    for (const child of node.children) walk(child);
  };
  walk(panel);
  assert.ok(btn, '应有还原按钮');

  btn.dispatchEvent('click');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(feature.getRows().length, rowsBefore, '失败不能把行删掉');
  assert.equal(btn.disabled, false, '失败后按钮要能再点');
  assert.ok(panel.textContent.includes('还原失败'), `应显示失败原因：${panel.textContent}`);
  restoreFails = false;
});

await t('归档为空时给空态，不显示假行', async () => {
  archived = [];
  await feature.reload();
  const panel = doc.body.children.find((n) => n.className === 'archive-panel');
  assert.equal(feature.getRows().length, 0);
  assert.ok(panel.textContent.includes('还没有归档'), '应有空态文案');
});

await t('关掉面板后 hidden 生效', async () => {
  feature.close();
  const panel = doc.body.children.find((n) => n.className === 'archive-panel');
  assert.equal(panel.hidden, true);
  assert.equal(feature.isOpen(), false);
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
