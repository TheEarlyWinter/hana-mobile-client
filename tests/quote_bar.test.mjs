/* tests/quote_bar.test.mjs — 引用条（web/quote-bar.js）的契约测试
 *
 * 用最小的假 document / mount，不启动浏览器、不连网关。覆盖：
 * 1. set 之后引用条可见，文本里有作者与正文；
 * 2. 再 set 一条是替换不是叠加（同一时刻只有一条引用）；
 * 3. 点 × 触发 onChange(null)，get() 变 null；
 * 4. applyTo 拼成 `> 作者：正文` + 空行 + 原文；没有引用时原样返回；
 * 5. 没有 mount / document 的降级路径：所有方法都能调、不抛错。
 */

import assert from 'node:assert/strict';
import { createQuoteBar } from '../web/quote-bar.js';

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 最小 DOM 夹具（只实现 quote-bar.js 用到的 API）                      */
/* ------------------------------------------------------------------ */

function matchClass(node, selector) {
  if (selector.startsWith('.')) {
    return String(node.className || '').split(/\s+/).includes(selector.slice(1));
  }
  return String(node.tagName || '').toLowerCase() === selector.toLowerCase();
}

class MockNode {
  constructor(tagName) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.style = {};
    this.attributes = new Map();
    this._ownText = '';
    this._listeners = new Map();
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._ownText;
  }

  set textContent(value) {
    this._ownText = String(value ?? '');
    for (const child of this.children.slice()) this.removeChild(child);
  }

  setAttribute(key, value) {
    this.attributes.set(String(key), String(value));
  }

  getAttribute(key) {
    return this.attributes.has(String(key)) ? this.attributes.get(String(key)) : null;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
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

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  dispatchEvent(ev) {
    const event = ev || {};
    if (!event.target) event.target = this;
    for (const fn of [...(this._listeners.get(event.type) || [])]) fn.call(this, event);
    return true;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchClass(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {}
}

function createMockDocument() {
  return {
    createElement(tag) {
      return new MockNode(tag);
    },
  };
}

function makeBar({ onChange } = {}) {
  const doc = createMockDocument();
  const mount = doc.createElement('div');
  const bar = createQuoteBar({ document: doc, mount, onChange });
  return { doc, mount, bar };
}

/* ------------------------------------------------------------------ */
/* 1. set：可见、有作者与正文                                          */
/* ------------------------------------------------------------------ */

t('set 之后引用条可见，文本包含作者与正文', () => {
  const { mount, bar } = makeBar();
  assert.ok(bar.element, '应有容器节点');
  assert.equal(mount.children.length, 1, '容器应挂到 mount 上');
  assert.equal(bar.element, mount.children[0]);
  assert.equal(bar.element.className, 'quote-bar');
  assert.equal(bar.element.hidden, true, '没设引用时应收起');

  bar.set({ text: '引用这段正文', author: 'Hana' });
  assert.equal(bar.element.hidden, false, 'set 之后应可见');

  const text = bar.element.textContent;
  assert.match(text, /引用/, '应有「引用」标记');
  assert.match(text, /Hana/, '应有说话人名');
  assert.match(text, /引用这段正文/, '应有正文');

  const authorEl = bar.element.querySelector('.quote-bar-author');
  assert.ok(authorEl);
  assert.equal(authorEl.hidden, false);
  assert.equal(bar.element.querySelector('.quote-bar-cancel').getAttribute('aria-label'), '取消引用');
});

t('没有作者时作者节点隐藏，只留正文', () => {
  const { bar } = makeBar();
  bar.set({ text: '没有作者的引用' });
  const authorEl = bar.element.querySelector('.quote-bar-author');
  assert.equal(authorEl.hidden, true);
  assert.equal(bar.element.textContent.includes('没有作者的引用'), true);
  assert.equal(bar.get().author, undefined);
});

/* ------------------------------------------------------------------ */
/* 2. 覆盖而不是叠加                                                    */
/* ------------------------------------------------------------------ */

t('再 set 一条是替换：只保留一条引用、一个正文节点', () => {
  const { mount, bar } = makeBar();
  bar.set({ text: '第一条', author: 'A' });
  bar.set({ text: '第二条', author: 'B' });

  assert.equal(mount.children.length, 1, '不能往 mount 里再塞一条');
  assert.equal(bar.element.querySelectorAll('.quote-bar-text').length, 1, '正文节点只能有一个');
  assert.equal(bar.element.textContent.includes('第一条'), false, '旧引用必须消失');
  assert.equal(bar.element.textContent.includes('第二条'), true);

  const quote = bar.get();
  assert.equal(quote.text, '第二条');
  assert.equal(quote.author, 'B');
});

t('set 空正文等价于 clear', () => {
  const { bar } = makeBar();
  bar.set({ text: '有正文', author: 'A' });
  bar.set({ text: '   ' });
  assert.equal(bar.get(), null);
  assert.equal(bar.element.hidden, true);
});

/* ------------------------------------------------------------------ */
/* 3. × 取消                                                            */
/* ------------------------------------------------------------------ */

t('点 × 触发 onChange(null)，get() 变 null，引用条收起', () => {
  const changes = [];
  const { bar } = makeBar({ onChange: (quote) => changes.push(quote) });
  bar.set({ text: '要取消的引用', author: 'Hana' });
  assert.equal(bar.get().text, '要取消的引用');

  bar.element.querySelector('.quote-bar-cancel').dispatchEvent({ type: 'click' });

  assert.equal(bar.get(), null);
  assert.equal(bar.element.hidden, true);
  assert.equal(changes.at(-1), null, '取消后必须回调 onChange(null)');
  assert.equal(bar.element.querySelector('.quote-bar-text').textContent, '');
});

t('onChange 也会在 set 时回调一次，宿主可据此同步按钮态', () => {
  const changes = [];
  const { bar } = makeBar({ onChange: (quote) => changes.push(quote) });
  bar.set({ text: '正文', author: 'A' });
  assert.deepEqual(changes, [{ text: '正文', author: 'A' }]);
  bar.clear();
  assert.deepEqual(changes, [{ text: '正文', author: 'A' }, null]);
});

t('onChange 抛错不会把引用条带崩', () => {
  const { bar } = makeBar({ onChange: () => { throw new Error('host boom'); } });
  bar.set({ text: '正文' });
  assert.equal(bar.get().text, '正文');
  bar.clear();
  assert.equal(bar.get(), null);
});

/* ------------------------------------------------------------------ */
/* 4. applyTo                                                          */
/* ------------------------------------------------------------------ */

t('applyTo：拼成「> 作者：正文」+ 空行 + 原文', () => {
  const { bar } = makeBar();
  bar.set({ text: '引用正文', author: 'Hana' });
  assert.equal(bar.applyTo('你好'), '> Hana：引用正文\n\n你好');
});

t('applyTo：没有作者时用「> 正文」', () => {
  const { bar } = makeBar();
  bar.set({ text: '引用正文' });
  assert.equal(bar.applyTo('你好'), '> 引用正文\n\n你好');
});

t('applyTo：没有引用时原样返回（连首尾空白都不动）', () => {
  const { bar } = makeBar();
  assert.equal(bar.applyTo('  你好  '), '  你好  ');
  assert.equal(bar.applyTo(''), '');

  bar.set({ text: '引用正文', author: 'Hana' });
  bar.clear();
  assert.equal(bar.applyTo('  你好  '), '  你好  ');
});

t('applyTo：正文首尾空白丢掉，引用里的换行压成单行', () => {
  const { bar } = makeBar();
  bar.set({ text: '第一行\n第二行', author: 'A' });
  assert.equal(bar.get().text, '第一行 第二行', '单行显示：换行折成空格');
  assert.equal(bar.applyTo('\n\n你好\n\n'), '> A：第一行 第二行\n\n你好');
  assert.equal(bar.applyTo(''), '> A：第一行 第二行\n\n');
});

t('applyTo：重复调用不重复拼接', () => {
  const { bar } = makeBar();
  bar.set({ text: '引用正文', author: 'Hana' });
  const once = bar.applyTo('你好');
  assert.equal(bar.applyTo(once), once);
  assert.equal(bar.applyTo(bar.applyTo(once)), once);
});

/* ------------------------------------------------------------------ */
/* 5. 降级                                                             */
/* ------------------------------------------------------------------ */

t('降级：没有 document / mount 时所有方法都能调、不抛错', () => {
  const doc = createMockDocument();
  const mount = doc.createElement('div');
  const cases = [
    createQuoteBar(),
    createQuoteBar({}),
    createQuoteBar({ mount }),            // 有 mount 没有 document
    createQuoteBar({ document: doc }),    // 有 document 没有 mount
  ];

  for (const bar of cases) {
    assert.equal(bar.element, null, '降级时没有容器节点');
    assert.equal(bar.get(), null);
    assert.equal(bar.set({ text: '正文', author: 'A' }), null, 'set 不抛错也不记状态');
    assert.equal(bar.get(), null);
    assert.equal(bar.applyTo('你好'), '你好', 'applyTo 原样返回');
    assert.equal(bar.applyTo('  你好  '), '  你好  ');
    bar.clear();
    assert.equal(bar.get(), null);
  }

  assert.equal(mount.children.length, 0, '降级时不应该往 mount 里塞节点');
});

t('降级时不传参数也不抛错', () => {
  const bar = createQuoteBar();
  assert.doesNotThrow(() => bar.set(null));
  assert.doesNotThrow(() => bar.clear());
  assert.equal(bar.applyTo(''), '');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll quote bar tests passed.');
}
