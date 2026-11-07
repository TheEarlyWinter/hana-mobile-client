/* tests/settings_view.test.mjs
 *
 * web/settings-view.js 单元测试与交互契约测试
 * 覆盖：
 * 1. 结构与生命周期：
 *    - 纯入参注入 container，不在视图内 document.getElementById 找外界节点
 *    - open() / close() / isOpen()
 *    - destroy() 彻底清理 DOM 与事件监听器，不留滚动锁定
 * 2. 加载中态 (status: 'loading')：
 *    - 渲染出加载动画/骨架与提示文案
 * 3. 失败态 (status: 'error')：
 *    - 渲染错误提示文本
 *    - 渲染重试按钮，点击触发 onRetry 回调
 * 4. 正常渲染 (status: 'loaded')：
 *    - 模型列表渲染：展示模型名、厂商标识、当前选中态
 *    - 点击其他模型触发 onSelectModel(modelId, provider)
 *    - 思考级别渲染：按传入的 thinkingLevels 集合渲染，高亮当前 thinkingLevel
 *    - 点击其他级别触发 onSelectThinkingLevel(level)
 *    - 若 thinkingLevels 为空/不支持，展示不支持提示或禁用态
 *    - 外观字号：展示字号档位（小/标准/大/特大），高亮当前字号
 *    - 点击字号触发 onSelectFontSize(val)，并自动同步 --chat-message-font-size 到 documentElement
 * 5. 聊天视图（沉静 / 经典）：
 *    - 展示两个选项，viewMode 指向的那一项有选中态
 *    - 点击触发 onSelectViewMode(mode)，选中态立刻迁移（异步回调不阻塞）
 *    - 纯本地偏好：加载态与失败态下这块依然在、依然可点
 */

import assert from 'node:assert/strict';
import { createSettingsView } from '../web/settings-view.js';
import { DEFAULT_FONT_SIZE } from '../web/settings-controller.js';

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
  const allElements = [];

  function createMockElement(tag, cls = '') {
    const listeners = new Map();
    const children = [];
    const classListSet = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);
    const attributes = new Map();
    const styleMap = new Map();

    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      children,
      attributes,
      dataset: {},
      parentNode: null,
      hidden: false,
      disabled: false,
      style: {
        setProperty(k, v) { styleMap.set(k, String(v)); },
        getPropertyValue(k) { return styleMap.get(k) || ''; },
        get cssText() {
          return Array.from(styleMap.entries()).map(([k, v]) => `${k}:${v}`).join(';');
        },
        set cssText(val) {
          styleMap.clear();
          if (val) {
            val.split(';').filter(Boolean).forEach(part => {
              const [k, v] = part.split(':');
              if (k && v) styleMap.set(k.trim(), v.trim());
            });
          }
        },
      },
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
        toggle: (c, force) => {
          if (force === true) classListSet.add(c);
          else if (force === false) classListSet.delete(c);
          else if (classListSet.has(c)) classListSet.delete(c);
          else classListSet.add(c);
        },
      },
      _text: '',
      get textContent() {
        if (children.length > 0) {
          return children.map(c => c.textContent).join('');
        }
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
      removeEventListener(type, fn) {
        if (!listeners.has(type)) return;
        const list = listeners.get(type);
        const idx = list.findIndex(item => item.fn === fn);
        if (idx !== -1) list.splice(idx, 1);
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const list = listeners.get(type) ? [...listeners.get(type)] : [];
        for (const item of list) {
          item.fn.call(this, typeof event === 'string' ? { type, target: this, currentTarget: this } : { target: this, currentTarget: this, ...event });
          if (item.once) {
            this.removeEventListener(type, item.fn);
          }
        }
      },
      setAttribute(k, v) {
        attributes.set(k, String(v));
        if (k.startsWith('data-')) {
          const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          this.dataset[key] = String(v);
        }
      },
      getAttribute(k) { return attributes.get(k) || null; },
      hasAttribute(k) { return attributes.has(k); },
      removeAttribute(k) {
        attributes.delete(k);
        if (k.startsWith('data-')) {
          const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
          delete this.dataset[key];
        }
      },
      click() {
        this.dispatchEvent({ type: 'click' });
      },
      querySelector(sel) {
        return findFirst(this, sel);
      },
      querySelectorAll(sel) {
        const res = [];
        findAll(this, sel, res);
        return res;
      },
    };
    allElements.push(el);
    return el;
  }

  function matches(node, sel) {
    if (!node || node.nodeType !== 1) return false;
    // 简单支持 [data-key="val"]
    const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/);
    if (attrMatch) {
      const attr = attrMatch[1];
      const val = attrMatch[2];
      if (val !== undefined) return node.getAttribute(attr) === val;
      return node.hasAttribute(attr);
    }
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

  const documentElement = createMockElement('html');
  const body = createMockElement('body');
  documentElement.appendChild(body);

  return {
    documentElement,
    body,
    createElement: (tag) => createMockElement(tag),
    getElementById: () => {
      throw new Error('测试规范：禁止在设置视图中调用 document.getElementById 查找外界节点！');
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

// ---------------- 测试执行 ----------------

await t('构造与生命周期：DOM 挂载在传入的 container 内部，open/close/destroy 干净彻底', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div', 'custom-settings-root');
  doc.body.appendChild(container);

  let closed = false;
  const view = createSettingsView({
    container,
    document: doc,
    onClose: () => { closed = true; },
  });

  // 初始为隐藏态
  assert.equal(view.isOpen(), false);
  const mask = container.querySelector('.settings-mask');
  const drawer = container.querySelector('.settings-drawer');
  assert.ok(mask, '遮罩层必须渲染在 container 内');
  assert.ok(drawer, '抽屉必须渲染在 container 内');
  assert.equal(drawer.classList.contains('open'), false);

  // 打开
  view.open();
  assert.equal(view.isOpen(), true);
  assert.equal(drawer.classList.contains('open'), true);

  // 点击关闭按钮触发 onClose
  const closeBtn = drawer.querySelector('.settings-close-btn');
  assert.ok(closeBtn, '必须存在关闭按钮');
  closeBtn.click();
  assert.equal(closed, true);

  // 关闭
  view.close();
  assert.equal(view.isOpen(), false);
  assert.equal(drawer.classList.contains('open'), false);

  // 销毁
  view.destroy();
  assert.equal(container.children.length, 0, 'destroy 后容器内所有节点应被彻底移除');
});

await t('加载中状态：显示加载状态与提示', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const view = createSettingsView({ container, document: doc });

  view.render({
    status: 'loading',
    models: [],
    thinkingLevels: null,
    fontSize: DEFAULT_FONT_SIZE,
  });

  const loadingEl = container.querySelector('.settings-loading');
  assert.ok(loadingEl, '应包含 settings-loading 提示');
  assert.ok(loadingEl.textContent.includes('加载中'), '应显示加载文案');
});

await t('失败状态：显示错误提示与重试按钮，点击重试触发 onRetry', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let retried = false;

  const view = createSettingsView({
    container,
    document: doc,
    onRetry: () => { retried = true; },
  });

  view.render({
    status: 'error',
    error: '获取模型列表失败: 500 Server Error',
    models: [],
    fontSize: DEFAULT_FONT_SIZE,
  });

  const errorEl = container.querySelector('.settings-error');
  assert.ok(errorEl, '应包含 settings-error 节点');
  assert.ok(errorEl.textContent.includes('获取模型列表失败'));

  const retryBtn = errorEl.querySelector('.settings-retry-btn');
  assert.ok(retryBtn, '应提供重试按钮');
  retryBtn.click();
  assert.equal(retried, true, '点击重试应触发 onRetry 回调');
});

await t('成功渲染：模型列表与选中态，点击模型触发 onSelectModel', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selected = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectModel: (modelId, provider) => {
      selected = { modelId, provider };
    },
  });

  view.render({
    status: 'loaded',
    models: [
      { id: 'qwen-max', name: '通义千问 Max', provider: 'dashscope' },
      { id: 'deepseek-v3', name: 'DeepSeek V3', provider: 'deepseek' },
    ],
    providerDisplayNames: { dashscope: '阿里百炼', deepseek: 'DeepSeek' },
    currentModelId: 'qwen-max',
    currentProvider: 'dashscope',
    thinkingLevel: 'medium',
    thinkingLevels: ['off', 'medium', 'high'],
    fontSize: '15px',
  });

  const items = container.querySelectorAll('.settings-model-item');
  assert.equal(items.length, 2);

  // 验证当前选中的项有 active/selected 样式类
  assert.equal(items[0].classList.contains('active'), true);
  assert.equal(items[1].classList.contains('active'), false);
  assert.ok(items[0].textContent.includes('通义千问 Max'));
  assert.ok(items[0].textContent.includes('阿里百炼'));

  // 点击未选中的模型
  items[1].click();
  assert.deepEqual(selected, { modelId: 'deepseek-v3', provider: 'deepseek' });
});

await t('模型列表：当存在相同 id 但不同 provider 的模型时，有且仅有匹配 provider 的项打勾', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({
    container,
    document: doc,
  });

  view.render({
    status: 'loaded',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Deepseek V4.1 Flash', provider: 'opencode-go' },
      { id: 'deepseek-v4.1-flash', name: '大肥鱼', provider: 'cpa' },
    ],
    providerDisplayNames: { 'opencode-go': 'OpenCode Go', cpa: '大肥鱼官方' },
    currentModelId: 'deepseek-v4.1-flash',
    currentProvider: 'cpa', // 只选中 cpa 厂商
    thinkingLevel: 'off',
    thinkingLevels: null,
    fontSize: '15px',
  });

  const items = container.querySelectorAll('.settings-model-item');
  assert.equal(items.length, 2);

  const opencodeItem = items[0];
  const cpaItem = items[1];

  assert.equal(cpaItem.classList.contains('active'), true, 'cpa 必须处于选中态');
  assert.equal(opencodeItem.classList.contains('active'), false, 'opencode-go 绝不能处于选中态');
});

await t('思考级别渲染：按可用集合渲染，高亮当前级别；点击触发回调', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selectedLevel = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectThinkingLevel: (lvl) => {
      selectedLevel = lvl;
    },
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'medium',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    fontSize: '15px',
  });

  const segmentBtns = container.querySelectorAll('.settings-level-btn');
  assert.equal(segmentBtns.length, 4);

  // 验证各按钮文案与选中状态
  const activeBtn = container.querySelector('.settings-level-btn.active');
  assert.ok(activeBtn, '应有高亮的选中项');
  assert.equal(activeBtn.dataset.level, 'medium');

  // 点击 'high'
  const highBtn = Array.from(segmentBtns).find((b) => b.dataset.level === 'high');
  assert.ok(highBtn);
  highBtn.click();
  assert.equal(selectedLevel, 'high');
});

await t('思考级别：当 thinkingLevels 为 null/空时呈现不支持提示', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({ container, document: doc });
  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: null, // 当前模型不支持思考
    fontSize: '15px',
  });

  const unsupportedTip = container.querySelector('.settings-unsupported-tip');
  assert.ok(unsupportedTip, '应展示不支持提示');
  assert.ok(unsupportedTip.textContent.includes('不支持') || unsupportedTip.textContent.includes('不可用'));
});

await t('思考级别：正在读取档位时不渲染旧模型的三格', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const view = createSettingsView({ container, document: doc });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: null,
    thinkingLevels: null,
    thinkingStatus: 'loading',
    fontSize: '15px',
  });

  assert.equal(container.querySelectorAll('.settings-level-btn').length, 0, '读取中不得画出会被误认为当前档位的按钮');
  const tip = container.querySelector('.settings-unsupported-tip');
  assert.ok(tip && tip.textContent.includes('正在读取'), `应提示正在读取，实际：${tip && tip.textContent}`);
});

await t('思考级别：读取失败时给重试按钮，点击只重拉档位', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let retried = 0;
  const view = createSettingsView({
    container,
    document: doc,
    onRetryThinking: () => { retried += 1; },
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: null,
    thinkingLevels: null,
    thinkingStatus: 'error',
    thinkingError: '网络抖动',
    fontSize: '15px',
  });

  const tip = container.querySelector('.settings-unsupported-tip');
  assert.ok(tip && tip.textContent.includes('失败'), `应提示读取失败，实际：${tip && tip.textContent}`);
  const retryBtn = container.querySelector('.settings-retry-btn');
  assert.ok(retryBtn, '失败态应提供重试按钮');
  retryBtn.click();
  assert.equal(retried, 1);
});

await t('思考级别：值与集合不一致时全部禁用，不自动高亮任何一格', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selected = null;
  let retried = 0;
  const view = createSettingsView({
    container,
    document: doc,
    onSelectThinkingLevel: (lvl) => { selected = lvl; },
    onRetryThinking: () => { retried += 1; },
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    // 真机现象：宿主给 max，界面还拿着上家的 off/medium/high
    thinkingLevel: 'max',
    thinkingLevels: ['off', 'medium', 'high'],
    thinkingStatus: 'inconsistent',
    fontSize: '15px',
  });

  const btns = Array.from(container.querySelectorAll('.settings-level-btn'));
  assert.equal(btns.length, 3, '集合本身仍要画出来，让人看见真实现状');
  assert.equal(container.querySelector('.settings-level-btn.active'), null, '不得自动高亮任何一格');
  assert.ok(btns.every((b) => b.disabled === true), '不一致时不得允许点击');
  btns[0].click();
  assert.equal(selected, null, '禁用状态下的点击不得触发选择');
  assert.ok(container.querySelector('.settings-retry-btn'), '不一致时应允许重试');
});

await t('外观字号：分段切换，触发回调并实时应用到 documentElement 变量', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let changedSize = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectFontSize: (size) => {
      changedSize = size;
    },
  });

  view.render({
    status: 'loaded',
    models: [],
    fontSize: '15px',
  });

  // 默认应用初始字号到 documentElement
  assert.equal(doc.documentElement.style.getPropertyValue('--chat-message-font-size'), '15px');

  const fontBtns = container.querySelectorAll('.settings-font-btn');
  assert.ok(fontBtns.length >= 3);

  // 点击 17px
  const largeBtn = Array.from(fontBtns).find((b) => b.dataset.size === '17px');
  assert.ok(largeBtn);
  largeBtn.click();

  assert.equal(changedSize, '17px');
  assert.equal(doc.documentElement.style.getPropertyValue('--chat-message-font-size'), '17px');
});

/* ---------------- 任务 B：流式生成中禁用模型切换 ---------------- */

await t('流式状态：正在生成时未选中的模型条目处于禁用态，点击只给提示不触发 onSelectModel', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selected = null;
  let noticeMsg = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectModel: (m, p) => { selected = { m, p }; },
    onNotice: (msg) => { noticeMsg = msg; },
  });

  // 1. streaming: true 渲染
  view.render({
    status: 'loaded',
    streaming: true,
    models: [
      { id: 'm1', name: 'Model 1', provider: 'p1' },
      { id: 'm2', name: 'Model 2', provider: 'p2' },
    ],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'low',
    thinkingLevels: ['low', 'high'],
  });

  const items = container.querySelectorAll('.settings-model-item');
  const disabledItem = items[1]; // 未选中的 m2
  assert.equal(disabledItem.classList.contains('disabled'), true, '未选中的模型条目应标记 disabled 样式');

  // 点击未选中的模型
  disabledItem.click();
  assert.equal(selected, null, '流式状态下点击未选中模型绝不触发 onSelectModel');
  assert.ok(noticeMsg && noticeMsg.includes('正在生成'), '应触发中文提示');

  // 2. streaming: false 恢复
  noticeMsg = null;
  view.render({
    status: 'loaded',
    streaming: false,
    models: [
      { id: 'm1', name: 'Model 1', provider: 'p1' },
      { id: 'm2', name: 'Model 2', provider: 'p2' },
    ],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'low',
    thinkingLevels: ['low', 'high'],
  });

  const newItems = container.querySelectorAll('.settings-model-item');
  assert.equal(newItems[1].classList.contains('disabled'), false, '流式结束后移除 disabled');
  newItems[1].click();
  assert.deepEqual(selected, { m: 'm2', p: 'p2' }, '恢复后点击正常触发 onSelectModel');
});

/* ---------------- 任务：savingModel 与 精确 provider 匹配 ---------------- */

await t('savingModel 状态：保存期间阻止进一步模型切换点击，实现零重复 select', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selectCount = 0;
  let selected = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectModel: (m, p) => {
      selectCount++;
      selected = { m, p };
    },
  });

  // 1. savingModel: true 渲染
  view.render({
    status: 'loaded',
    savingModel: true,
    models: [
      { id: 'm1', name: 'Model 1', provider: 'p1' },
      { id: 'm2', name: 'Model 2', provider: 'p2' },
    ],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: null,
  });

  const items = container.querySelectorAll('.settings-model-item');
  const targetItem = items[1]; // 未选中的 m2

  // 点击未选中的模型
  targetItem.click();
  assert.equal(selectCount, 0, 'savingModel 保存期间点击模型绝不能触发 onSelectModel');
  assert.equal(selected, null);

  // 再次点击，确保零重复调用
  targetItem.click();
  assert.equal(selectCount, 0, 'savingModel 保存期间重复点击依然被阻断');

  // 2. savingModel: false 恢复后可以正常点击
  view.render({
    status: 'loaded',
    savingModel: false,
    models: [
      { id: 'm1', name: 'Model 1', provider: 'p1' },
      { id: 'm2', name: 'Model 2', provider: 'p2' },
    ],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: null,
  });

  const updatedItems = container.querySelectorAll('.settings-model-item');
  updatedItems[1].click();
  assert.equal(selectCount, 1, 'savingModel 恢复后点击应正常触发 onSelectModel');
  assert.deepEqual(selected, { m: 'm2', p: 'p2' });
});

await t('savingModel 状态：保存模型期间不影响思考级别的调节', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let selectedLevel = null;

  const view = createSettingsView({
    container,
    document: doc,
    onSelectThinkingLevel: (lvl) => {
      selectedLevel = lvl;
    },
  });

  // savingModel: true 状态下渲染
  view.render({
    status: 'loaded',
    savingModel: true,
    models: [
      { id: 'm1', name: 'Model 1', provider: 'p1' },
    ],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'low',
    thinkingLevels: ['off', 'low', 'high'],
  });

  const btns = container.querySelectorAll('.settings-level-btn');
  const highBtn = Array.from(btns).find((b) => b.dataset.level === 'high');
  assert.ok(highBtn);

  // 点击 high
  highBtn.click();
  assert.equal(selectedLevel, 'high', 'savingModel 期间思考级别切换绝不能被阻断');
});

await t('provider 匹配：当 currentProvider 未知或空时，不得将所有同 id 模型假认选中', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({
    container,
    document: doc,
  });

  // 两个不同 provider 的同名 id 模型，且 currentProvider 为 null（未知）
  view.render({
    status: 'loaded',
    models: [
      { id: 'common-model', name: '模型 A', provider: 'provider-1' },
      { id: 'common-model', name: '模型 B', provider: 'provider-2' },
    ],
    currentModelId: 'common-model',
    currentProvider: null, // 未知 provider
    thinkingLevel: 'off',
    thinkingLevels: null,
  });

  const items = container.querySelectorAll('.settings-model-item');
  assert.equal(items.length, 2);

  const activeItems = Array.from(items).filter((it) => it.classList.contains('active'));
  assert.notEqual(activeItems.length, 2, 'provider 未知时绝不能把所有同 id 的模型都选中高亮');
  assert.equal(activeItems.length, 0, 'provider 未知时不应假认任何一项为 active');
});

await t('网络与连接：渲染「切换接入方式」，点击只发意图给 onServerMode', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let serverModeCalls = 0;

  const view = createSettingsView({
    container,
    document: doc,
    onServerMode: () => { serverModeCalls += 1; },
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: ['off', 'high'],
    fontSize: '15px',
  });

  const section = container.querySelector('.settings-section-connection');
  assert.ok(section, '设置面板里应有「网络与连接」分区');

  const entry = section.querySelector('.settings-link-row');
  assert.ok(entry, '应有切换接入方式的条目');
  assert.ok(entry.textContent.includes('切换接入方式'), `条目文案不对：${entry.textContent}`);

  entry.click();
  assert.equal(serverModeCalls, 1, '点击应触发 onServerMode，且只触发一次');
});

await t('账号：渲染「退出登录」，点击只发意图给 onLogout', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let logoutCalls = 0;

  const view = createSettingsView({
    container,
    document: doc,
    onLogout: () => { logoutCalls += 1; },
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
    fontSize: '15px',
  });

  const section = container.querySelector('.settings-section-account');
  assert.ok(section, '设置面板最底部应有账号分区');

  const btn = section.querySelector('.settings-danger-btn');
  assert.ok(btn, '应有退出登录按钮');
  assert.ok(btn.textContent.includes('退出登录'), `按钮文案不对：${btn.textContent}`);

  btn.click();
  assert.equal(logoutCalls, 1, '点击应触发 onLogout');
});

await t('账号：生成中点退出登录只给提示，不发退出意图', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let logoutCalls = 0;
  const notices = [];

  const view = createSettingsView({
    container,
    document: doc,
    onLogout: () => { logoutCalls += 1; },
    onNotice: (msg) => { notices.push(msg); },
  });

  view.render({
    status: 'loaded',
    streaming: true,
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
    fontSize: '15px',
  });

  const btn = container.querySelector('.settings-danger-btn');
  assert.ok(btn, '生成中也应能看到退出入口');
  btn.click();

  assert.equal(logoutCalls, 0, '流式生成中绝不能真的退出登录');
  assert.equal(notices.length, 1, '应有一条提示');
  assert.ok(notices[0].includes('生成'), `提示应说明原因：${notices[0]}`);
});

await t('失败态：接入方式与退出登录仍然可达，不能把恢复路径一起藏起来', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({ container, document: doc });
  view.render({ status: 'error', error: '加载失败' });

  assert.ok(container.querySelector('.settings-section-connection'), '失败态也要能改接入方式');
  assert.ok(container.querySelector('.settings-section-account'), '失败态也要能退出登录');
});

/* ---------------- 聊天视图：沉静 / 经典 ---------------- */

await t('聊天视图：渲染「聊天」分区与两个选项，viewMode 指向的那一项有选中态', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({
    container,
    document: doc,
    viewMode: 'serene',
  });

  view.render({
    status: 'loaded',
    models: [{ id: 'm1', name: 'M1', provider: 'p1' }],
    currentModelId: 'm1',
    currentProvider: 'p1',
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
    fontSize: '15px',
  });

  const section = container.querySelector('.settings-section-chat-view');
  assert.ok(section, '设置面板里应有「聊天」分区');
  assert.ok(section.textContent.includes('聊天'), `分区标题不对：${section.textContent}`);
  assert.ok(
    section.textContent.includes('沉静视图把过程收进一行摘要') && section.textContent.includes('经典视图保留逐条过程'),
    `分区应说明两种视图的差异：${section.textContent}`,
  );

  const btns = Array.from(section.querySelectorAll('.settings-view-mode-btn'));
  assert.equal(btns.length, 2, '必须恰好两个视图选项');

  const sereneBtn = btns.find((b) => b.dataset.viewMode === 'serene');
  const classicBtn = btns.find((b) => b.dataset.viewMode === 'classic');
  assert.ok(sereneBtn, '应有沉静视图选项');
  assert.ok(classicBtn, '应有经典视图选项');
  assert.equal(sereneBtn.textContent, '沉静视图');
  assert.equal(classicBtn.textContent, '经典视图');

  assert.equal(sereneBtn.classList.contains('active'), true, 'viewMode=serene 时沉静视图必须是选中态');
  assert.equal(sereneBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(classicBtn.classList.contains('active'), false, '经典视图不能被误标选中');
  assert.equal(classicBtn.getAttribute('aria-pressed'), 'false');
});

await t('聊天视图：viewMode=classic 时选中态落在经典视图', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({ container, document: doc, viewMode: 'classic' });
  view.render({
    status: 'loaded',
    models: [],
    fontSize: '15px',
  });

  const sereneBtn = container.querySelector('[data-view-mode="serene"]');
  const classicBtn = container.querySelector('[data-view-mode="classic"]');
  assert.ok(sereneBtn && classicBtn);
  assert.equal(classicBtn.classList.contains('active'), true);
  assert.equal(sereneBtn.classList.contains('active'), false);
});

await t('聊天视图：点击另一项回调收到正确 mode，选中态立刻迁移', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const calls = [];

  const view = createSettingsView({
    container,
    document: doc,
    viewMode: 'serene',
    onSelectViewMode: (mode) => { calls.push(mode); },
  });

  view.render({ status: 'loaded', models: [], fontSize: '15px' });

  const classicBtn = container.querySelector('[data-view-mode="classic"]');
  classicBtn.click();

  assert.deepEqual(calls, ['classic'], '点击经典视图应只回调一次 classic');

  const sereneBtn = container.querySelector('[data-view-mode="serene"]');
  assert.equal(classicBtn.classList.contains('active'), true, '点击后选中态应立刻迁到经典视图');
  assert.equal(classicBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(sereneBtn.classList.contains('active'), false);
  assert.equal(sereneBtn.getAttribute('aria-pressed'), 'false');

  // 再点已选中的那一项：没有变化，不重复发意图
  classicBtn.click();
  assert.deepEqual(calls, ['classic'], '重复点击当前项不应再次回调');
});

await t('聊天视图：回调是 async 时不阻塞 UI，点击同步返回', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  let received = null;

  const view = createSettingsView({
    container,
    document: doc,
    viewMode: 'serene',
    // 故意给一个永不 resolve 的 Promise：视图若 await 就会卡住
    onSelectViewMode: (mode) => {
      received = mode;
      return new Promise(() => {});
    },
  });

  view.render({ status: 'loaded', models: [], fontSize: '15px' });

  const classicBtn = container.querySelector('[data-view-mode="classic"]');
  const ret = classicBtn.click();
  assert.equal(ret, undefined, '点击必须是同步返回，不能把回调的 Promise 抛给事件流');
  assert.equal(received, 'classic', '回调拿到正确的 mode');
  assert.equal(classicBtn.classList.contains('active'), true, 'UI 不等回调完成就先迁移选中态');
});

await t('聊天视图：加载态与失败态下照样渲染、照样可点', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');
  const calls = [];

  const view = createSettingsView({
    container,
    document: doc,
    viewMode: 'serene',
    onSelectViewMode: (mode) => { calls.push(mode); },
  });

  // 加载态
  view.render({ status: 'loading', models: [], fontSize: '15px' });
  let section = container.querySelector('.settings-section-chat-view');
  assert.ok(section, '加载态下「聊天」分区不能消失');
  assert.equal(section.querySelectorAll('.settings-view-mode-btn').length, 2);
  section.querySelector('[data-view-mode="classic"]').click();
  assert.deepEqual(calls, ['classic'], '加载态下点击也要发意图');

  // 失败态（重新渲染后仍按本地最新值标记）
  view.render({ status: 'error', error: '获取模型列表失败', models: [], fontSize: '15px' });
  section = container.querySelector('.settings-section-chat-view');
  assert.ok(section, '失败态下「聊天」分区不能消失');
  assert.equal(section.querySelector('[data-view-mode="classic"]').classList.contains('active'), true, '失败态沿用刚刚点选的经典视图');
  section.querySelector('[data-view-mode="serene"]').click();
  assert.deepEqual(calls, ['classic', 'serene']);
});

await t('聊天视图：viewMode 随 render state 送来时以 state 为准，未知值不假认选中', async () => {
  const doc = createMockDocument();
  const container = doc.createElement('div');

  const view = createSettingsView({ container, document: doc, viewMode: 'serene' });

  view.render({ status: 'loaded', models: [], fontSize: '15px', viewMode: 'classic' });
  assert.equal(
    container.querySelector('[data-view-mode="classic"]').classList.contains('active'),
    true,
    'state 里的 viewMode 应覆盖构造时的初值',
  );

  view.render({ status: 'loaded', models: [], fontSize: '15px', viewMode: 'unknown-mode' });
  const activeBtns = Array.from(container.querySelectorAll('.settings-view-mode-btn'))
    .filter((b) => b.classList.contains('active'));
  assert.equal(activeBtns.length, 1, '未知值时应保持上一个已知模式，不能两项同时选中或全空');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
