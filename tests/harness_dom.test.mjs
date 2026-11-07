import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

test('append/remove/replace 正确维护父节点并从旧父节点摘除', () => {
  const h = createHarness();
  const oldParent = h.makeNode('section');
  const newParent = h.makeNode('section');
  const child = h.makeNode('button');

  oldParent.appendChild(child);
  assert.equal(child.parentNode, oldParent);
  assert.equal(child.parentElement, oldParent);

  newParent.appendChild(child);
  assert.equal(oldParent.children.length, 0);
  assert.equal(child.parentNode, newParent);
  assert.equal(child.parentElement, newParent);

  const replacement = h.makeNode('a');
  assert.equal(newParent.replaceChild(replacement, child), child);
  assert.equal(child.parentNode, null);
  assert.equal(replacement.parentNode, newParent);

  newParent.removeChild(replacement);
  assert.equal(replacement.parentNode, null);
  assert.equal(replacement.parentElement, null);
});

test('insertBefore 按锚点定位，null 追加并维护兄弟指针', () => {
  const h = createHarness();
  const actions = h.getEl('homeHeadActions');
  const anchor = h.getEl('btnRefresh');
  assert.equal(anchor.parentNode, actions, '刷新按钮应挂在真实容器节点下');

  const before = h.makeNode('button');
  actions.insertBefore(before, anchor);
  const after = h.makeNode('button');
  actions.insertBefore(after, null);

  assert.deepEqual(actions.children, [before, anchor, after]);
  assert.equal(actions.firstChild, before);
  assert.equal(actions.lastChild, after);
  assert.equal(before.nextSibling, anchor);
  assert.equal(anchor.nextSibling, after);
});

test('textContent 读取聚合后代，写入清空旧子节点并放入文本节点', () => {
  const h = createHarness();
  const root = h.makeNode('div');
  const first = h.makeNode('#text');
  first.textContent = '前';
  const nested = h.makeNode('strong');
  nested.textContent = '中';
  const last = h.makeNode('#text');
  last.textContent = '后';
  root.appendChild(first);
  root.appendChild(nested);
  root.appendChild(last);

  assert.equal(root.textContent, '前中后');

  root.textContent = '替换';
  assert.equal(root.textContent, '替换');
  assert.equal(root.children.length, 1);
  assert.equal(root.firstChild.tagName, '#TEXT');
  assert.equal(root.firstChild.parentNode, root);
  assert.equal(first.parentNode, null);
  assert.equal(nested.parentNode, null);
  assert.equal(last.parentNode, null);

  root.textContent = '';
  assert.equal(root.textContent, '');
  assert.equal(root.children.length, 0);
});

let failed = 0;
for (const { name, run } of cases) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
