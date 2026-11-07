/* tests/action_confirmation.test.mjs
 * 
 * 动作确认对话框契约测试：
 * 1. 默认拒绝（Escape、取消、背景点击、主动 close/cancelAll 均为 false）
 * 2. 只有明确点击允许按钮才返回 true
 * 3. 队列防洪：超出上限直接拒绝
 * 4. 串行展示：前一个处理完毕后才展示下一个
 * 5. 文本安全：参数必须作为纯文本 (textContent) 渲染，防止 XSS
 * 6. 大对象和原型防御：details 格式化安全且有界
 * 7. 默认 60s 有界超时，超时自动拒绝并清理 timer
 * 8. 无 DOM 环境快速拒绝且不锁死队列
 * 9. 无障碍 dialog 与 aria-modal 属性
 */

import assert from 'node:assert/strict';
import { createActionConfirmation } from '../web/action-confirmation.js';

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

// 最小化 Mock DOM 环境
function createMockDocument() {
  const elements = [];
  const eventListeners = new Map();

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.className = '';
      this.style = {};
      this.children = [];
      this.parentNode = null;
      this.textContent = '';
      this._listeners = new Map();
      this.attributes = new Map();
      elements.push(this);
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k); }
    appendChild(child) {
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
    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }
    querySelector(sel) {
      for (const c of this.children) {
        if (sel.startsWith('.') && c.className.split(/\s+/).includes(sel.slice(1))) return c;
        if (sel.toLowerCase() === c.tagName.toLowerCase()) return c;
        const sub = c.querySelector(sel);
        if (sub) return sub;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.children) {
        if (sel.startsWith('.') && c.className.split(/\s+/).includes(sel.slice(1))) out.push(c);
        if (sel.toLowerCase() === c.tagName.toLowerCase()) out.push(c);
        out.push(...c.querySelectorAll(sel));
      }
      return out;
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
      const list = this._listeners.get(ev.type) || [];
      for (const fn of list) fn.call(this, ev);
    }
  }

  const body = new MockElement('BODY');
  const doc = {
    body,
    createElement(tag) {
      return new MockElement(tag);
    },
    addEventListener(type, fn) {
      if (!eventListeners.has(type)) eventListeners.set(type, []);
      eventListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = eventListeners.get(type) || [];
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(ev) {
      const list = eventListeners.get(ev.type) || [];
      for (const fn of list) fn(ev);
    }
  };

  return { doc, elements };
}

await t('初始化时不向 DOM 注入任何节点（懒 DOM）', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });
  assert.equal(doc.body.children.length, 0);
  assert.equal(confirmation.isOpen(), false);
});

await t('confirm 默认通过取消按钮或关闭拒绝，返回 false', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const promise = confirmation.confirm({
    title: '确认执行',
    message: '卡片申请调用工具'
  });

  assert.equal(confirmation.isOpen(), true);
  const cancelBtn = doc.body.querySelector('.h-confirm-btn-cancel');
  assert.ok(cancelBtn, '取消按钮应存在');

  cancelBtn.dispatchEvent({ type: 'click' });
  const result = await promise;
  assert.equal(result, false);
  assert.equal(confirmation.isOpen(), false);
});

await t('点击允许按钮返回 true', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const promise = confirmation.confirm({
    title: '确认提交',
    message: '允许发送此消息到会话？'
  });

  const okBtn = doc.body.querySelector('.h-confirm-btn-allow');
  assert.ok(okBtn, '允许按钮应存在');

  okBtn.dispatchEvent({ type: 'click' });
  const result = await promise;
  assert.equal(result, true);
  assert.equal(confirmation.isOpen(), false);
});

await t('按 Escape 键默认拒绝', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const promise = confirmation.confirm({
    title: '测试 Escape',
    message: '按 ESC 取消'
  });

  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  const result = await promise;
  assert.equal(result, false);
  assert.equal(confirmation.isOpen(), false);
});

await t('cancelAll() 取消当前及队列中所有待处理的确认', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const p1 = confirmation.confirm({ title: '确认 1', message: '任务 1' });
  const p2 = confirmation.confirm({ title: '确认 2', message: '任务 2' });

  confirmation.cancelAll();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, false);
  assert.equal(r2, false);
  assert.equal(confirmation.isOpen(), false);
});

await t('队列防洪：超出最大排队容量立即拒绝后续请求', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc, maxQueueSize: 2 });

  const p1 = confirmation.confirm({ title: '1', message: '1' });
  const p2 = confirmation.confirm({ title: '2', message: '2' });
  const p3 = confirmation.confirm({ title: '3', message: '3' });
  const pExcess = confirmation.confirm({ title: '4', message: '4' });

  // 第4个超出 maxQueueSize=2 (1个正在展示，2个排队，第4个应被拒)
  const rExcess = await pExcess;
  assert.equal(rExcess, false, '超出容量的请求应直接 resolve false');

  confirmation.cancelAll();
  await Promise.all([p1, p2, p3]);
});

await t('文本渲染使用 textContent 且安全截断大对象 details', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const giantDetails = {
    nested: { a: 'x'.repeat(20000) }
  };

  const promise = confirmation.confirm({
    title: '<script>alert(1)</script>',
    message: '<b>粗体</b>',
    details: giantDetails
  });

  const titleEl = doc.body.querySelector('.h-confirm-title');
  const msgEl = doc.body.querySelector('.h-confirm-message');
  const detEl = doc.body.querySelector('.h-confirm-details');

  assert.equal(titleEl.textContent, '<script>alert(1)</script>');
  assert.equal(msgEl.textContent, '<b>粗体</b>');
  assert.ok(detEl.textContent.length <= 4096, 'details 文本必须有界截断');

  confirmation.close();
  await promise;
});

await t('超时安全：默认有界超时或自定义 timeoutMs 超时默认拒绝返回 false', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc, timeoutMs: 50 });

  const promise = confirmation.confirm({
    title: '超时测试',
    message: '等待超时'
  });
  assert.equal(confirmation.isOpen(), true);

  const res = await promise;
  assert.equal(res, false, '超时未处理应默认拒绝');
  assert.equal(confirmation.isOpen(), false);
});

await t('队列超时从入队开始计时：排队期间过期，展示时立即拒绝', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc, timeoutMs: 40 });

  const p1 = confirmation.confirm({ title: '1', message: 'first' });
  await new Promise((r) => setTimeout(r, 10));
  const p2 = confirmation.confirm({ title: '2', message: 'second' });

  // 到 55ms 时：p1 已超时，p2 若从入队计时也应已超时；
  // 旧实现会把 p2 展示出来并重新开始 40ms，因而仍在 pending。
  await new Promise((r) => setTimeout(r, 45));
  const first = await p1;
  assert.equal(first, false);

  const raced = await Promise.race([
    p2.then((v) => ({ settled: true, v })),
    new Promise((r) => setTimeout(() => r({ settled: false }), 10)),
  ]);
  assert.equal(raced.settled, true, '排队超时必须沿用入队 deadline');
  assert.equal(raced.v, false);
});

await t('无 DOM 环境下立即拒绝且不锁死队列', async () => {
  const mockDocNoBody = { body: null };
  const confirmation = createActionConfirmation({ document: mockDocNoBody });

  const p1 = confirmation.confirm({ title: '任务1', message: '无body' });
  const p2 = confirmation.confirm({ title: '任务2', message: '无body' });

  const r1 = await p1;
  const r2 = await p2;

  assert.equal(r1, false);
  assert.equal(r2, false);
  assert.equal(confirmation.isOpen(), false, '无 DOM 时不应挂死 currentRequest');
});

await t('对话框具备 role="dialog" 和 aria-modal 等无障碍属性', async () => {
  const { doc } = createMockDocument();
  const confirmation = createActionConfirmation({ document: doc });

  const promise = confirmation.confirm({ title: 'ARIA测试', message: '无障碍检查' });
  const modal = doc.body.querySelector('.h-confirm-modal');
  assert.ok(modal, '模态窗口应存在');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');

  confirmation.close();
  await promise;
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nAll action confirmation tests passed.');
}
