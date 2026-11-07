/* tests/new_session_label.test.mjs
 *
 * 「新建对话」按钮文案跟随命名空间。
 *
 * 为什么单独测：真机反馈——切到 Code 标签后，抽屉里的按钮还写着「新建 Chat 对话」，
 * 点了也确实建出 Chat 会话。文案与行为必须一起跟命名空间走，不能各写各的。
 */

import assert from 'node:assert/strict';
import { createNewSessionLabel } from '../web/new-session-label.js';

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

/** 最小元素：只提供这条功能真正用到的几个口子。 */
function makeDoc(ids) {
  const map = new Map();
  for (const id of ids) {
    const attrs = new Map();
    const span = {
      textContent: '新建 Chat 对话',
      _tag: 'span',
    };
    const el = {
      id,
      textContent: '',
      attributes: attrs,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return attrs.get(k) || null; },
      querySelector(sel) { return sel === 'span' ? span : null; },
      _span: span,
    };
    map.set(id, el);
  }
  return {
    getElementById: (id) => map.get(id) || null,
    _map: map,
  };
}

await t('切到 code：标题、aria-label 与按钮内文案一起变成「新建 Code 对话」', () => {
  const doc = makeDoc(['btnNew', 'btnNewChat']);
  const label = createNewSessionLabel({ document: doc });

  label.setNamespace('code');

  const btn = doc.getElementById('btnNewChat');
  assert.equal(btn.getAttribute('title'), '新建 Code 对话', 'title 必须跟着变');
  assert.equal(btn.getAttribute('aria-label'), '新建 Code 对话', '无障碍标签也必须跟着变');
  assert.equal(btn._span.textContent, '新建 Code 对话', '可见文案必须跟着变');

  const iconOnly = doc.getElementById('btnNew');
  assert.equal(iconOnly.getAttribute('title'), '新建 Code 对话', '首页那个纯图标按钮同样要改 title');
});

await t('切回 home：文案回到「新建 Chat 对话」', () => {
  const doc = makeDoc(['btnNew', 'btnNewChat']);
  const label = createNewSessionLabel({ document: doc });

  label.setNamespace('code');
  label.setNamespace('home');

  const btn = doc.getElementById('btnNewChat');
  assert.equal(btn.getAttribute('title'), '新建 Chat 对话');
  assert.equal(btn._span.textContent, '新建 Chat 对话');
});

await t('未知命名空间：按 home 处理，不能拼出「新建 undefined 对话」', () => {
  const doc = makeDoc(['btnNewChat']);
  const label = createNewSessionLabel({ document: doc });

  label.setNamespace('weird');

  const btn = doc.getElementById('btnNewChat');
  assert.equal(btn.getAttribute('title'), '新建 Chat 对话');
  assert.ok(!btn._span.textContent.includes('undefined'));
});

await t('缺元素时静默跳过，不抛错（首屏尚未挂载 / 单测精简 DOM）', () => {
  const doc = makeDoc([]);
  const label = createNewSessionLabel({ document: doc });
  label.setNamespace('code');
  assert.ok(true, '没有按钮也不该抛');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
