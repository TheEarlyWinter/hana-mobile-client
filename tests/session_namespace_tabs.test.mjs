/* tests/session_namespace_tabs.test.mjs
 *
 * web/session-namespace-tabs.js 契约测试
 * 覆盖：
 * 1. 构造：不触发 onChange，不写按钮状态（初始态由 index.html 与父层 setNamespace 负责）
 * 2. setNamespace：is-active 与 aria-pressed 回写，非法值按 home 处理
 * 3. 点击：只回传 onChange('home'|'code')，不自改选中态，不叠加监听
 * 4. 缺 DOM：无 getElementById / 节点缺失 / 只有一半节点时安全 no-op
 * 5. dispose：解绑点击，重复调用安全
 */

import assert from 'node:assert/strict';
import { createSessionNamespaceTabs } from '../web/session-namespace-tabs.js';

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
  const store = new Map();

  function createMockElement(tag, id = '') {
    const listeners = new Map();
    const classListSet = new Set();
    const attrs = new Map();

    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      id,
      attributes: attrs,
      get className() {
        return Array.from(classListSet).join(' ');
      },
      set className(val) {
        classListSet.clear();
        if (val) val.split(/\s+/).filter(Boolean).forEach((c) => classListSet.add(c));
      },
      classList: {
        add: (...args) => args.forEach((c) => classListSet.add(c)),
        remove: (...args) => args.forEach((c) => classListSet.delete(c)),
        contains: (c) => classListSet.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !classListSet.has(c) : !!force;
          if (on) classListSet.add(c);
          else classListSet.delete(c);
          return on;
        },
      },
      _text: '',
      get textContent() {
        return this._text;
      },
      set textContent(val) {
        this._text = String(val == null ? '' : val);
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = listeners.get(type);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx !== -1) arr.splice(idx, 1);
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const list = listeners.get(type) ? [...listeners.get(type)] : [];
        for (const fn of list) fn.call(this, typeof event === 'string' ? { type } : event);
      },
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
    };
    return el;
  }

  const doc = {
    createElement: (tag) => createMockElement(tag),
    getElementById: (id) => store.get(id) || null,
    _add(id, tag) {
      const el = createMockElement(tag, id);
      store.set(id, el);
      return el;
    },
  };
  return doc;
}

function createTabsDocument() {
  const doc = createMockDocument();
  doc._add('sessionNamespaceTabs', 'div');
  doc._add('btnNamespaceHome', 'button');
  doc._add('btnNamespaceCode', 'button');
  return doc;
}

/* ------------------------------------------------------------------ */
/* 1. 构造隔离                                                         */
/* ------------------------------------------------------------------ */

await t('构造：不触发 onChange，不写按钮状态', () => {
  const doc = createTabsDocument();
  let calls = 0;
  createSessionNamespaceTabs({ document: doc, onChange: () => { calls += 1; } });

  assert.equal(calls, 0);
  const home = doc.getElementById('btnNamespaceHome');
  const code = doc.getElementById('btnNamespaceCode');
  assert.equal(home.classList.contains('is-active'), false);
  assert.equal(home.getAttribute('aria-pressed'), null);
  assert.equal(code.classList.contains('is-active'), false);
  assert.equal(code.getAttribute('aria-pressed'), null);
});

await t('构造：缺省 onChange 时点击不抛错', () => {
  const doc = createTabsDocument();
  createSessionNamespaceTabs({ document: doc });
  assert.doesNotThrow(() => doc.getElementById('btnNamespaceCode').dispatchEvent({ type: 'click' }));
});

await t('构造：缺 document 抛明确错误', () => {
  assert.throws(() => createSessionNamespaceTabs({}), /createSessionNamespaceTabs requires \{ document \}/);
});

/* ------------------------------------------------------------------ */
/* 2. setNamespace 回写选中态                                          */
/* ------------------------------------------------------------------ */

await t('setNamespace：home/code 回写 is-active 与 aria-pressed', () => {
  const doc = createTabsDocument();
  const tabs = createSessionNamespaceTabs({ document: doc });
  const home = doc.getElementById('btnNamespaceHome');
  const code = doc.getElementById('btnNamespaceCode');

  tabs.setNamespace('home');
  assert.equal(home.classList.contains('is-active'), true);
  assert.equal(home.getAttribute('aria-pressed'), 'true');
  assert.equal(code.classList.contains('is-active'), false);
  assert.equal(code.getAttribute('aria-pressed'), 'false');

  tabs.setNamespace('code');
  assert.equal(home.classList.contains('is-active'), false);
  assert.equal(home.getAttribute('aria-pressed'), 'false');
  assert.equal(code.classList.contains('is-active'), true);
  assert.equal(code.getAttribute('aria-pressed'), 'true');

  // 反复回写同一值不残留多个 active
  tabs.setNamespace('code');
  assert.equal(code.classList.contains('is-active'), true);
  assert.equal(home.classList.contains('is-active'), false);
});

await t('setNamespace：非法或缺失值按 home 处理，不会两个都不亮', () => {
  const doc = createTabsDocument();
  const tabs = createSessionNamespaceTabs({ document: doc });
  const home = doc.getElementById('btnNamespaceHome');
  const code = doc.getElementById('btnNamespaceCode');

  tabs.setNamespace('code');
  tabs.setNamespace(undefined);
  assert.equal(home.getAttribute('aria-pressed'), 'true');
  assert.equal(code.getAttribute('aria-pressed'), 'false');

  tabs.setNamespace('nonsense');
  assert.equal(home.getAttribute('aria-pressed'), 'true');
  assert.equal(code.getAttribute('aria-pressed'), 'false');
});

/* ------------------------------------------------------------------ */
/* 3. 点击只回传 onChange，选中态由父层 setNamespace 回写               */
/* ------------------------------------------------------------------ */

await t('点击：只回传 onChange，未回写前不自改选中态', () => {
  const doc = createTabsDocument();
  const seen = [];
  const tabs = createSessionNamespaceTabs({
    document: doc,
    onChange: (ns) => seen.push(ns),
  });
  const home = doc.getElementById('btnNamespaceHome');
  const code = doc.getElementById('btnNamespaceCode');

  tabs.setNamespace('home');

  code.dispatchEvent({ type: 'click' });
  assert.deepEqual(seen, ['code']);
  assert.equal(code.getAttribute('aria-pressed'), 'false');
  assert.equal(home.getAttribute('aria-pressed'), 'true');

  tabs.setNamespace('code');
  assert.equal(code.getAttribute('aria-pressed'), 'true');

  home.dispatchEvent({ type: 'click' });
  assert.deepEqual(seen, ['code', 'home']);
  assert.equal(home.getAttribute('aria-pressed'), 'false');

  // 每次点击只触发一次，监听不叠加
  code.dispatchEvent({ type: 'click' });
  assert.deepEqual(seen, ['code', 'home', 'code']);
});

/* ------------------------------------------------------------------ */
/* 4. 缺 DOM 安全                                                      */
/* ------------------------------------------------------------------ */

await t('缺 DOM：无 getElementById 时 setNamespace/dispose 安全 no-op', () => {
  const tabs = createSessionNamespaceTabs({ document: {}, onChange: () => { throw new Error('不应回调'); } });
  assert.doesNotThrow(() => tabs.setNamespace('code'));
  assert.doesNotThrow(() => tabs.setNamespace('home'));
  assert.doesNotThrow(() => tabs.dispose());
});

await t('缺 DOM：节点不存在时安全 no-op', () => {
  const doc = createMockDocument();
  const tabs = createSessionNamespaceTabs({ document: doc });
  assert.doesNotThrow(() => tabs.setNamespace('code'));
  assert.doesNotThrow(() => tabs.dispose());
});

await t('缺 DOM：只有 Chat 按钮时仍能回写与点击', () => {
  const doc = createMockDocument();
  const home = doc._add('btnNamespaceHome', 'button');
  const seen = [];
  const tabs = createSessionNamespaceTabs({ document: doc, onChange: (ns) => seen.push(ns) });

  tabs.setNamespace('code');
  assert.equal(home.getAttribute('aria-pressed'), 'false');

  home.dispatchEvent({ type: 'click' });
  assert.deepEqual(seen, ['home']);

  tabs.dispose();
});

/* ------------------------------------------------------------------ */
/* 5. dispose                                                          */
/* ------------------------------------------------------------------ */

await t('dispose：解绑点击，重复调用安全', () => {
  const doc = createTabsDocument();
  let calls = 0;
  const tabs = createSessionNamespaceTabs({ document: doc, onChange: () => { calls += 1; } });
  const home = doc.getElementById('btnNamespaceHome');
  const code = doc.getElementById('btnNamespaceCode');

  code.dispatchEvent({ type: 'click' });
  assert.equal(calls, 1);

  tabs.dispose();
  code.dispatchEvent({ type: 'click' });
  home.dispatchEvent({ type: 'click' });
  assert.equal(calls, 1);

  assert.doesNotThrow(() => tabs.dispose());
  assert.equal(calls, 1);
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
