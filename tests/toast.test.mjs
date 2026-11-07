/* tests/toast.test.mjs — E5 提示条（web/toast.js）
 *
 * 假 DOM 用共用夹具 tests/support/app_harness.mjs；时钟换成手摇的：
 * 把 globalThis.setTimeout/clearTimeout 顶掉，再由 clock.advance(ms) 推进，
 * 这样「info 3 秒自灭」「同文案 2 秒内合并」都能确定性地验，不靠真实等待。
 *
 * 覆盖：error 常驻 / info 自灭、长文本折叠展开、详情展开、最多 3 条、
 *       同文案合并计数、✕ 关闭、clear、dispose、aria 属性、根被摘掉后的自愈。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import {
  createToaster,
  INFO_TIMEOUT_MS,
  MERGE_WINDOW_MS,
  MAX_VISIBLE,
  ROOT_ID,
} from '../web/toast.js';

/* ------------------------------ 假时钟 ------------------------------ */

function createClock(start = 1_700_000_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();

  const clock = {
    now: () => now,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { id: seq, at: now + Math.max(0, Number(ms) || 0), fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** 推进时间并按到期顺序执行回调（同一时刻按登记顺序）。 */
    advance(ms) {
      const target = now + Math.max(0, ms);
      for (;;) {
        let due = null;
        for (const timer of timers.values()) {
          if (timer.at > target) continue;
          if (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) due = timer;
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
  return clock;
}

const clock = createClock();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...args) => clock.setTimeout(() => fn(...args), ms);
globalThis.clearTimeout = (id) => clock.clearTimeout(id);

const h = createHarness();
const doc = h.doc;

const toaster = createToaster({ doc, mount: doc.body, now: clock.now });

/* ------------------------------ 小工具 ------------------------------ */

const rootEl = () => h.getEl(ROOT_ID);
const rootToasts = () => (rootEl().children || []).filter((n) => n && n.tagName === 'DIV');
const textOf = (toast) => toast.querySelector('.toast-text')?.textContent || '';
const btnOf = (toast, cls) => toast.querySelector(cls);
const bodyHasRoot = () => (doc.body.children || []).some((n) => n && n.id === ROOT_ID);

function reset() {
  toaster.clear();
}

const cases = [];
function t(name, fn) {
  cases.push({ name, fn });
}

/* ------------------------------ 用例 ------------------------------ */

t('error 不自动消失：过 60 秒还在；info 3 秒后自己走', () => {
  reset();
  toaster.show('保存失败：磁盘只读');
  assert.equal(rootToasts().length, 1, 'error 应立即出现');

  clock.advance(60_000);
  assert.equal(rootToasts().length, 1, '业务性错误不能被计时器吃掉，必须等用户点 ✕');

  toaster.show('已复制', { level: 'info' });
  assert.equal(rootToasts().length, 2, 'info 也应出现');
  clock.advance(INFO_TIMEOUT_MS - 1);
  assert.equal(rootToasts().length, 2, '不到 3 秒不能消失');
  clock.advance(1);
  assert.equal(rootToasts().length, 1, 'info 满 3 秒应自动消失');
  assert.equal(textOf(rootToasts()[0]), '保存失败：磁盘只读', '留下来的必须是那条 error');
});

t('长文本：先折成 2 行 + 展开，展开后全文可读，能收起', () => {
  reset();
  const long = '请求失败：'.concat('上游返回 502，网关重试三次都没成功；'.repeat(8));
  assert.ok(long.length > 120, '用例文本必须超过 120 字');
  toaster.show(long);

  const toast = rootToasts()[0];
  const text = toast.querySelector('.toast-text');
  assert.equal(text.textContent, long, '折叠只影响显示，DOM 里要保留全文');
  assert.equal(text.classList.contains('is-clamped'), true, '长文本默认折叠');
  assert.equal(text.classList.contains('is-expanded'), false);

  const expand = btnOf(toast, '.toast-expand');
  assert.ok(expand, '长文本要有「展开」入口');
  assert.equal(expand.hidden, false);
  assert.equal(expand.textContent, '展开');
  assert.equal(expand.getAttribute('aria-expanded'), 'false');

  expand.dispatchEvent('click');
  assert.equal(text.classList.contains('is-clamped'), false, '展开后不该再被截成 2 行');
  assert.equal(text.classList.contains('is-expanded'), true, '展开后走 40vh 可滚动样式');
  assert.equal(expand.textContent, '收起');
  assert.equal(expand.getAttribute('aria-expanded'), 'true');

  expand.dispatchEvent('click');
  assert.equal(text.classList.contains('is-clamped'), true, '能再收回去');
  assert.equal(expand.textContent, '展开');
});

t('短文本但带换行：也要折叠（多行报错同样读不完）', () => {
  reset();
  toaster.show('第一行原因\n第二行原因');
  const toast = rootToasts()[0];
  assert.equal(toast.querySelector('.toast-text').classList.contains('is-clamped'), true);
  assert.equal(btnOf(toast, '.toast-expand').hidden, false);
});

t('短文本：不出现「展开」按钮', () => {
  reset();
  toaster.show('网络断了');
  const toast = rootToasts()[0];
  assert.equal(btnOf(toast, '.toast-expand').hidden, true);
  assert.equal(toast.querySelector('.toast-text').classList.contains('is-clamped'), false);
});

t('detail：点「详情」看等宽原文，再点收起；没有 detail 时不露入口', () => {
  reset();
  const detail = 'Error: EACCES: permission denied\n    at Object.writeFile (fs.js:12:3)\n    at save (app.js:88:5)';
  toaster.show('保存失败', { detail });

  const toast = rootToasts()[0];
  const detailBtn = btnOf(toast, '.toast-detail-btn');
  const panel = toast.querySelector('.toast-detail-wrap');
  const pre = toast.querySelector('.toast-detail');

  assert.equal(detailBtn.hidden, false, '带 detail 必须有「详情」入口');
  assert.equal(detailBtn.getAttribute('aria-expanded'), 'false');
  assert.equal(panel.hidden, true, '详情默认收起');
  assert.equal(pre.textContent, detail, '详情要显示原始文本，含换行与缩进');

  detailBtn.dispatchEvent('click');
  assert.equal(panel.hidden, false, '点开后应显示详情面板');
  assert.equal(detailBtn.textContent, '收起详情');
  assert.equal(detailBtn.getAttribute('aria-expanded'), 'true');

  detailBtn.dispatchEvent('click');
  assert.equal(panel.hidden, true, '能再收起');

  reset();
  toaster.show('没有详情');
  assert.equal(btnOf(rootToasts()[0], '.toast-detail-btn').hidden, true, '没 detail 就不能给空入口');
});

t('详情可复制：没有 clipboard 时退回 execCommand，并摘掉临时节点', () => {
  reset();
  let copied = '';
  doc.execCommand = (cmd) => {
    copied = cmd;
    return true;
  };
  try {
    toaster.show('保存失败', { detail: 'Error: boom' });
    const toast = rootToasts()[0];
    toast.querySelector('.toast-detail-btn').dispatchEvent('click');
    const copyBtn = toast.querySelector('.toast-copy');
    copyBtn.dispatchEvent('click');

    assert.equal(copied, 'copy', '应调起复制命令');
    assert.equal(copyBtn.textContent, '已复制', '成功后给回执');
    const leftovers = (doc.body.children || []).filter((n) => n && n.tagName === 'TEXTAREA');
    assert.equal(leftovers.length, 0, '临时 textarea 必须摘掉');
  } finally {
    delete doc.execCommand;
  }
});

t('最多 3 条：第 4 条进来时最旧的一条自动关', () => {
  reset();
  assert.equal(MAX_VISIBLE, 3, '契约是同时最多 3 条');
  toaster.show('第 1 条');
  clock.advance(5_000); // 躲开合并窗口，别把不同文案当重复
  toaster.show('第 2 条');
  clock.advance(5_000);
  toaster.show('第 3 条');
  clock.advance(5_000);
  assert.equal(rootToasts().length, 3);

  toaster.show('第 4 条');
  const texts = rootToasts().map(textOf);
  assert.deepEqual(texts, ['第 2 条', '第 3 条', '第 4 条'], '挤掉的应是最旧那条');
});

t('同文案 2 秒内重复出现：合并成一条并计数 ×2；超过窗口另起一条', () => {
  reset();
  toaster.show('网络错误，稍后重试');
  clock.advance(1_200);
  assert.equal(MERGE_WINDOW_MS, 2000, '合并窗口是 2 秒');
  toaster.show('网络错误，稍后重试');

  assert.equal(rootToasts().length, 1, '2 秒内的同一文案不能刷成两条');
  const toast = rootToasts()[0];
  const count = toast.querySelector('.toast-count');
  assert.equal(count.hidden, false, '重复过就要显示计数');
  assert.equal(count.textContent, '×2');

  clock.advance(600);
  toaster.show('网络错误，稍后重试');
  assert.equal(rootToasts().length, 1, '持续点击仍在窗口内，继续合并');
  assert.equal(toast.querySelector('.toast-count').textContent, '×3');

  clock.advance(MERGE_WINDOW_MS + 1);
  toaster.show('网络错误，稍后重试');
  assert.equal(rootToasts().length, 2, '过了窗口就是新的一条');
  assert.equal(rootToasts()[1].querySelector('.toast-count').hidden, true, '新的一条计数从 1 开始');
});

t('✕ 关闭：只关掉自己那一条', () => {
  reset();
  toaster.show('第一条错误');
  clock.advance(5_000);
  toaster.show('第二条错误');
  const first = rootToasts()[0];

  first.querySelector('.toast-close').dispatchEvent('click');
  assert.equal(rootToasts().length, 1);
  assert.equal(textOf(rootToasts()[0]), '第二条错误', '关掉的必须是点的那条');
});

t('clear() 清空所有提示，info 的计时器一并停掉', () => {
  reset();
  toaster.show('错误一');
  clock.advance(5_000);
  toaster.show('提示二', { level: 'info' });
  assert.equal(rootToasts().length, 2);

  toaster.clear();
  assert.equal(rootToasts().length, 0, 'clear 后一条都不能留');
  assert.equal(rootEl().hidden, true, '空堆栈要收起来');
  assert.equal(clock.pending(), 0, 'clear 必须把 info 计时器清掉，别留幽灵回调');

  clock.advance(10_000);
  assert.equal(rootToasts().length, 0, '清掉之后计时的尾巴不能再动界面');
});

t('空文案直接忽略，不建空条', () => {
  reset();
  assert.equal(toaster.show(''), null);
  assert.equal(toaster.show(null), null);
  assert.equal(rootToasts().length, 0);
});

t('无障碍：容器 role=status，错误条 role=alert，✕ 有 aria-label', () => {
  reset();
  toaster.show('出错了');
  const root = rootEl();
  assert.equal(root.getAttribute('role'), 'status', '容器必须能被读屏播报');
  assert.equal(root.getAttribute('aria-live'), 'polite');

  const toast = rootToasts()[0];
  assert.equal(toast.getAttribute('role'), 'alert', '错误用 alert 抢占播报');
  const close = toast.querySelector('.toast-close');
  assert.equal(close.getAttribute('aria-label'), '关闭提示');
  assert.ok(String(close.getAttribute('aria-label')).trim().length > 0);

  toaster.show('只是提示', { level: 'info' });
  const infoToast = rootToasts()[1];
  assert.equal(infoToast.getAttribute('role'), null, 'info 不重复抢播报，交给容器');
});

t('根节点被页面清掉后还能自愈显示（退出登录后错误不能丢）', () => {
  reset();
  toaster.show('旧错误');
  rootEl().remove();
  assert.equal(bodyHasRoot(), false, '前提：根确实被摘掉了');

  toaster.show('新错误');
  assert.equal(bodyHasRoot(), true, '下一条提示要把根重新挂回 body');
  assert.ok(rootToasts().map(textOf).includes('新错误'), '而且内容要看得见');
});

t('dispose()：摘掉整棵树、清计时器，之后不再响应', () => {
  reset();
  toaster.show('提示，稍后消失', { level: 'info' });
  const saved = rootToasts()[0];

  toaster.dispose();
  assert.equal(bodyHasRoot(), false, 'dispose 要把根从 body 摘掉');
  assert.equal(clock.pending(), 0, 'dispose 不能留下计时器');

  assert.equal(toaster.show('销毁后不该再出现'), null, 'dispose 后 show 直接忽略');
  assert.equal(bodyHasRoot(), false, '更不能再把树建回来');

  // 之前拿到的按钮引用也不能再改界面
  const before = saved.querySelector('.toast-text').textContent;
  saved.querySelector('.toast-close').dispatchEvent('click');
  assert.equal(saved.querySelector('.toast-text').textContent, before);
  toaster.clear();
});

/* ------------------------------ 跑 ------------------------------ */

let bad = 0;
for (const { name, fn } of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${String(error?.stack || error?.message || error).split('\n').join('\n      ')}`);
  }
}

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
