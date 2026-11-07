/* 代码块一键复制测试（E11）
 *
 * 跑法：node tests/code_copy.test.mjs
 *
 * 假 DOM 复用 tests/support/app_harness.mjs（项目现有的无 jsdom 夹具），
 * 但它节点的 dispatchEvent 只调本节点的监听器、不冒泡；事件委托的行为要靠冒泡，
 * 所以下面自己补一个沿 parentNode 往上派发到 root 的 clickTarget()。
 *
 * 覆盖：委托点击、sync 幂等、按钮不进 <pre>、空/多代码块、< 与中文、失败反馈。
 */

import { createHarness } from './support/app_harness.mjs';
import { renderMarkdown } from '../web/md.js';
import { installCodeCopy } from '../web/code-copy.js';

const h = createHarness();
const { doc } = h;

let bad = 0;

async function runCheck(name, fn) {
  try {
    const result = await fn();
    if (result === false) throw new Error('断言返回 false');
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || '值'}不相等\n      期望 ${e}\n      实际 ${a}`);
}

/* ---------------------------- 夹具 ---------------------------- */

function makeRoot() {
  const root = doc.createElement('div');
  root.className = 'msg-list';
  doc.body.appendChild(root);
  return root;
}

/** 按真实渲染路径造消息：renderMarkdown 的 HTML 塞进 .md-body。 */
function pasteMarkdown(root, markdown) {
  root.innerHTML = `<div class="msg"><div class="md-body">${renderMarkdown(markdown)}</div></div>`;
}

/** 模拟浏览器冒泡：从 target 一路派发到 root（含）。 */
function clickTarget(target, root) {
  const evt = {
    type: 'click',
    target,
    preventDefault() {},
    stopPropagation() {},
  };
  let cur = target;
  while (cur) {
    cur.dispatchEvent(evt);
    if (cur === root) break;
    cur = cur.parentNode;
  }
  return evt;
}

/** 可控定时器：用例自己决定什么时候跑复位回调，并断言延时。 */
function createTimers() {
  const pending = [];
  let seq = 0;
  return {
    pending,
    setTimeout(fn, ms) {
      seq += 1;
      pending.push({ id: seq, fn, ms, cancelled: false });
      return seq;
    },
    clearTimeout(id) {
      const entry = pending.find((item) => item.id === id);
      if (entry) entry.cancelled = true;
    },
    run() {
      for (const entry of pending.splice(0)) {
        if (!entry.cancelled) entry.fn();
      }
    },
  };
}

function createClipboard({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    // 复制实现由装配层注入（模块自己不 import 另一个模块），测试直接替这个函数。
    copy: async (text) => {
      calls.push(text);
      if (fail) throw new Error('clipboard denied');
      return { ok: true };
    },
    navigator: {
      clipboard: {
        async writeText(text) {
          calls.push(text);
          if (fail) throw new Error('clipboard denied');
        },
      },
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

/* ---------------------------- 用例 ---------------------------- */

await runCheck('委托点击复制该块 pre 的文本，并给出成功反馈', async () => {
  const root = makeRoot();
  pasteMarkdown(root, '说明一行\n\n```js\nconst a = 1;\nif (a < 2 && "ok") {}\n```');
  const clip = createClipboard();
  const timers = createTimers();
  const ctl = installCodeCopy({ root, doc, copy: clip.copy, timers });

  assertEqual(ctl.sync(), 1, '补按钮数量');
  const btn = root.querySelector('.code-copy-btn');
  assert(btn, '没找到复制按钮');
  assertEqual(btn.textContent, '复制', '初始文案');

  clickTarget(btn, root);
  await flush();

  assertEqual(clip.calls, ['const a = 1;\nif (a < 2 && "ok") {}'], '剪贴板内容');
  assertEqual(btn.textContent, '已复制', '成功文案');
  assertEqual(btn.getAttribute('data-state'), 'done', '成功状态');
  assertEqual(timers.pending.length, 1, '复位定时器数量');
  assertEqual(timers.pending[0].ms, 1200, '复位延时');

  timers.run();
  assertEqual(btn.textContent, '复制', '复位文案');
  assertEqual(btn.getAttribute('data-state'), null, '复位后状态标记应清掉');
});

await runCheck('sync() 幂等，按钮追加在块末尾、不进 pre', async () => {
  const root = makeRoot();
  pasteMarkdown(root, '```js\nconst a = 1;\n```');
  const clip = createClipboard();
  const timers = createTimers();
  const ctl = installCodeCopy({ root, doc, copy: clip.copy, timers });

  assertEqual([ctl.sync(), ctl.sync(), ctl.sync(), ctl.sync()], [1, 0, 0, 0], '每次 sync 新增数量');

  const blocks = root.querySelectorAll('.md-code');
  assertEqual(blocks.length, 1, '代码块数量');
  const block = blocks[0];
  const pre = block.querySelector('pre');
  const btn = root.querySelector('.code-copy-btn');

  assertEqual(block.querySelectorAll('.code-copy-btn').length, 1, '按钮数量');
  assertEqual(pre.querySelector('.code-copy-btn'), null, '按钮不能进 pre');
  assertEqual(pre.textContent, 'const a = 1;', 'pre 文本不能被按钮污染');
  assert(block.classList.contains('has-code-copy'), '块上缺少 has-code-copy 标记');
  assert(block.children[block.children.length - 1] === btn, '按钮应是块的最后一个子节点');

  // 点代码本体不复制：用户还要能选中文字。
  clickTarget(pre, root);
  await flush();
  assertEqual(clip.calls, [], '点 pre 不应触发复制');

  clickTarget(btn, root);
  await flush();
  assertEqual(clip.calls, ['const a = 1;'], '剪贴板只应拿到代码，不含按钮文案');
});

await runCheck('多代码块 + 空代码块：空块不给按钮、各块互不串文本', async () => {
  const root = makeRoot();
  pasteMarkdown(root, [
    '```js',
    'const a = 1;',
    '```',
    '',
    '```',
    '',
    '```',
    '',
    '```python',
    'print("你好")',
    '```',
  ].join('\n'));
  const clip = createClipboard();
  const timers = createTimers();
  const ctl = installCodeCopy({ root, doc, copy: clip.copy, timers });

  const blocks = root.querySelectorAll('.md-code');
  assertEqual(blocks.length, 3, '代码块数量');
  assertEqual(ctl.sync(), 2, '空代码块不应补按钮');
  assertEqual(ctl.sync(), 0, '再次 sync 不新增');
  assertEqual(root.querySelectorAll('.code-copy-btn').length, 2, '按钮总数');
  assertEqual(blocks[1].querySelector('.code-copy-btn'), null, '空代码块上的按钮');

  const btns = root.querySelectorAll('.code-copy-btn');
  clickTarget(btns[1], root);
  await flush();
  assertEqual(clip.calls, ['print("你好")'], '第二个块的剪贴板内容');
});

await runCheck('剪贴板失败：按钮显示「复制失败」，不抛异常', async () => {
  const root = makeRoot();
  pasteMarkdown(root, '```ts\nconst x: number = 1;\n```');
  const clip = createClipboard({ fail: true });
  const timers = createTimers();
  const ctl = installCodeCopy({ root, doc, copy: clip.copy, timers });
  ctl.sync();

  const btn = root.querySelector('.code-copy-btn');
  let thrown = null;
  try {
    clickTarget(btn, root);
    await flush();
  } catch (err) {
    thrown = err;
  }

  assertEqual(thrown, null, '点击不应同步抛错');
  assertEqual(clip.calls.length, 1, '尝试复制次数');
  assertEqual(btn.textContent, '复制失败', '失败文案');
  assertEqual(btn.getAttribute('data-state'), 'fail', '失败状态');

  timers.run();
  assertEqual(btn.textContent, '复制', '失败后也复位');
});

await runCheck('复制实现自身抛错也按失败处理', async () => {
  const root = makeRoot();
  pasteMarkdown(root, '```js\nlet n = 0;\n```');
  const timers = createTimers();
  const ctl = installCodeCopy({
    root,
    doc,
    navigator: {},
    timers,
    copy: () => {
      throw new Error('boom');
    },
  });
  ctl.sync();

  const btn = root.querySelector('.code-copy-btn');
  clickTarget(btn, root);
  await flush();
  assertEqual(btn.textContent, '复制失败', '失败文案');
});

await runCheck('同一容器重复 install 不重复绑定监听', async () => {
  const root = makeRoot();
  pasteMarkdown(root, '```js\nconst a = 1;\n```');
  const first = createClipboard();
  const second = createClipboard();
  const timers = createTimers();

  const ctlA = installCodeCopy({ root, doc, copy: first.copy, timers });
  const ctlB = installCodeCopy({ root, doc, copy: second.copy, timers });
  ctlB.sync();
  ctlA.sync();

  const btn = root.querySelector('.code-copy-btn');
  clickTarget(btn, root);
  await flush();

  assertEqual(first.calls, ['const a = 1;'], '第一次 install 的剪贴板');
  assertEqual(second.calls, [], '第二次 install 不应再绑一份监听');
  assertEqual(root.querySelectorAll('.code-copy-btn').length, 1, '按钮数量');
});

await runCheck('缺少 root 时给出明确错误', async () => {
  let message = '';
  try {
    installCodeCopy({ doc });
  } catch (err) {
    message = String(err && err.message);
  }
  assert(message.includes('root'), `错误信息应说明缺少 root，实际：${message}`);
});

await flush();
if (rejections.length) {
  bad += 1;
  console.log(`FAIL  出现未处理的 Promise 拒绝：${rejections.map((r) => String(r && r.message ? r.message : r)).join('; ')}`);
} else {
  console.log('PASS  没有未处理的 Promise 拒绝');
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
