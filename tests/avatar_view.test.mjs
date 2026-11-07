/* tests/avatar_view.test.mjs
 *
 * web/avatar-view.js 单元测试与契约测试
 * 覆盖：
 * 1. initialOf: 空值兜底、英文字母首字母大写、中文及非英文字符保留
 * 2. agentAvatarUrl: 直接 avatarUrl、嵌套 avatar.url、hasAvatar + id 编码、仅 agentId、无头像返回 null
 * 3. createAvatarView({ document }):
 *    - 闭包只持 DOM 工厂，不访问全局 document
 *    - 无 url 时文本首字母回退（fallback 优先于 name 优先于 'H'）
 *    - 有 url 时创建 img 标签，属性 alt, loading='eager', decoding='async', src
 *    - 加载失败 error 回退：img 移除且容器显示首字母，once 监听生效
 *    - 避免 innerHTML 注入安全检查
 */

import assert from 'node:assert/strict';
import { initialOf, agentAvatarUrl, createAvatarView } from '../web/avatar-view.js';

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
    if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
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
/* 1. initialOf 纯函数测试                                             */
/* ------------------------------------------------------------------ */

await t('initialOf: 空值与空白字符安全返回点号', () => {
  assert.equal(initialOf(''), '·');
  assert.equal(initialOf(null), '·');
  assert.equal(initialOf(undefined), '·');
  assert.equal(initialOf('   '), '·');
});

await t('initialOf: 英文首字母自动大写', () => {
  assert.equal(initialOf('gemini'), 'G');
  assert.equal(initialOf('Alice'), 'A');
  assert.equal(initialOf('  bob  '), 'B');
});

await t('initialOf: 中文与非字母保留首字符', () => {
  assert.equal(initialOf('小花'), '小');
  assert.equal(initialOf('催花清雨'), '催');
  assert.equal(initialOf('123'), '1');
  assert.equal(initialOf('★星'), '★');
});

/* ------------------------------------------------------------------ */
/* 2. agentAvatarUrl 纯函数测试                                        */
/* ------------------------------------------------------------------ */

await t('agentAvatarUrl: 空 agent 返回 null', () => {
  assert.equal(agentAvatarUrl(null), null);
  assert.equal(agentAvatarUrl(undefined), null);
});

await t('agentAvatarUrl: 显式 avatarUrl 优先返回', () => {
  assert.equal(agentAvatarUrl({ avatarUrl: 'https://example.com/a.png', hasAvatar: true }), 'https://example.com/a.png');
  assert.equal(agentAvatarUrl({ avatar: { url: '/static/b.png' } }), '/static/b.png');
});

await t('agentAvatarUrl: hasAvatar 为 true 时使用 id 或 agentId 生成路径并转义', () => {
  assert.equal(agentAvatarUrl({ id: 'cat', hasAvatar: true }), '/api/agents/cat/avatar');
  assert.equal(agentAvatarUrl({ agentId: 'dog/1', hasAvatar: true }), '/api/agents/dog%2F1/avatar');
});

await t('agentAvatarUrl: hasAvatar 为假或无 id 时返回 null', () => {
  assert.equal(agentAvatarUrl({ id: 'cat', hasAvatar: false }), null);
  assert.equal(agentAvatarUrl({ hasAvatar: true }), null);
});

/* ------------------------------------------------------------------ */
/* 3. createAvatarView & paintAvatar 闭包及 DOM 测试                    */
/* ------------------------------------------------------------------ */

await t('createAvatarView: 返回具有 paintAvatar 的闭包对象', () => {
  const doc = createMockDocument();
  const view = createAvatarView({ document: doc });
  assert.equal(typeof view.paintAvatar, 'function');
});

await t('paintAvatar: host 为空时安全退出', () => {
  const doc = createMockDocument();
  const { paintAvatar } = createAvatarView({ document: doc });
  assert.doesNotThrow(() => paintAvatar(null, { url: '/a.png' }));
  assert.doesNotThrow(() => paintAvatar(undefined));
});

await t('paintAvatar: 无 url 时使用 initialOf 填充文本', () => {
  const doc = createMockDocument();
  const { paintAvatar } = createAvatarView({ document: doc });
  const host = doc.createElement('div');
  host.textContent = 'old';

  paintAvatar(host, { url: null, name: 'Gemini' });
  assert.equal(host.textContent, 'G');
  assert.equal(host.children.length, 0);

  // fallback 优先于 name
  paintAvatar(host, { fallback: 'Assistant', name: 'Gemini' });
  assert.equal(host.textContent, 'A');

  // 无 name 无 fallback 时回退到 'H'
  paintAvatar(host, {});
  assert.equal(host.textContent, 'H');
});

await t('paintAvatar: 有 url 时创建 img 节点并配置 eager / async / alt', () => {
  const doc = createMockDocument();
  const { paintAvatar } = createAvatarView({ document: doc });
  const host = doc.createElement('div');

  paintAvatar(host, { url: '/api/avatar.png', name: '猫娘' });
  assert.equal(host.children.length, 1);
  const img = host.children[0];
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.src, '/api/avatar.png');
  assert.equal(img.alt, '猫娘');
  assert.equal(img.loading, 'eager');
  assert.equal(img.decoding, 'async');
});

await t('paintAvatar: img 失败触发 error 事件时回退为首字母并移除 img', () => {
  const doc = createMockDocument();
  const { paintAvatar } = createAvatarView({ document: doc });
  const host = doc.createElement('div');

  paintAvatar(host, { url: '/broken.png', name: 'Gemini' });
  assert.equal(host.children.length, 1);
  const img = host.children[0];

  img.dispatchEvent({ type: 'error' });
  assert.equal(host.children.length, 0);
  assert.equal(host.textContent, 'G');
});

await t('paintAvatar: 不进行 innerHTML 字符串拼接避免 XSS', () => {
  const doc = createMockDocument();
  const { paintAvatar } = createAvatarView({ document: doc });
  const host = doc.createElement('div');
  const payload = '<img src=x onerror=alert(1)>';

  paintAvatar(host, { name: payload });
  assert.equal(host.innerHTML, ''); // 没有通过 innerHTML 注入任何 HTML 片段
  assert.equal(host.textContent, '<'); // textContent 为安全的纯文本首字符
});

if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
