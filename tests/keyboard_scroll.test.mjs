/* 缺陷 9 回归：键盘弹起后聊天区变矮，贴着底的内容必须还在底部
 *
 * 历史根因：watchKeyboard().adjust() 先更新 --kb 再 scrollToBottom()，而 scrollToBottom 内部用
 * nearBottom()（clientHeight）判断。视图变矮之后底部间距变大，本来贴底的那一屏不再
 * 算「贴底」，于是最新内容留在屏幕外。
 *
 * 真机（Android 13 WebView）还有第二条路径：键盘弹起时布局视口直接缩小
 * （adjustResize），documentElement.clientHeight 与 visualViewport.height 一起变小，
 * adjust() 里的 inset 恒为 0，于是「inset > 0 才滚」这个前置条件直接把滚动短路掉——
 * 布局确实变矮了，内容就被裁在下面。所以贴底状态改成持续跟踪（滚动事件刷新），
 * 视口一变只要 pinned 就滚，不再看 inset。
 *
 * 锁的行为：
 *   - 贴底判定来自用户最后一次真实滚动，不在布局变化之后现算；
 *   - VisualViewport 内缩模式（布局不变、vv 变矮）与 resize 模式（布局一起变矮、--kb 恒 0）
 *     都要把贴底的会话滚到底；
 *   - 每次 adjust() 滚两次：同步一次 + 下一帧补一次；
 *   - 用户没贴底时不许硬拽到底；没有活动会话时不动滚动位置。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();

h.setFetch(async (url) => {
  const path = String(url).split('?')[0];
  if (path === '/api/web-auth/session') return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions/messages') return h.jsonRes({ messages: [], blocks: [], hasMore: false });
  if (path === '/api/sessions') return h.jsonRes([]);
  throw new Error('unexpected fetch: ' + url);
});

// 布局高度：键盘弹起时 transcript 的可见高度跟着 --kb 变矮（内缩模式）
// 或者跟着布局高度一起变矮（resize 模式）。两种都按真机那样叠起来算。
const LAYOUT_HEIGHT = 800;
h.documentElement.clientHeight = LAYOUT_HEIGHT;
let layoutShrink = 0;                  // resize 模式：键盘吃掉的那部分布局高度
const kbInset = () => Number(String(h.cssVars.get('--kb') || '0').replace('px', '')) || 0;

const transcript = h.getEl('transcript');
Object.defineProperty(transcript, 'scrollHeight', { configurable: true, get: () => 1000 });
Object.defineProperty(transcript, 'clientHeight', {
  configurable: true,
  get: () => 600 - kbInset() - layoutShrink,
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

/** VisualViewport 内缩模式（iOS 那套）：布局高度不变，只有 vv 变矮。 */
function keyboard(height) {
  h.visualViewport.height = height;
  h.fireVisualViewport('resize');
}

/** resize 模式（Android WebView adjustResize）：布局视口与 vv 一起变矮，inset 恒 0。 */
function resizeKeyboard(visibleHeight) {
  layoutShrink = LAYOUT_HEIGHT - visibleHeight;
  h.documentElement.clientHeight = visibleHeight;
  h.visualViewport.height = visibleHeight;
  // 真机上 window.resize 与 visualViewport.resize 都会派发；两者走同一个 adjust()。
  h.fireWindow('resize');
  h.fireVisualViewport('resize');
}

/** 把布局恢复成没弹键盘的样子。 */
function resetLayout() {
  layoutShrink = 0;
  h.documentElement.clientHeight = LAYOUT_HEIGHT;
  h.visualViewport.height = LAYOUT_HEIGHT;
}

/** 用户在 transcript 里滚动：真机会派发 scroll，贴底状态由它持续刷新。 */
function userScroll(top) {
  transcript.scrollTop = top;
  transcript.dispatchEvent('scroll');
}

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

/* ------------------------------------------------------------------ */

await t('键盘弹起：原来贴底的，弹起后仍要贴底', async () => {
  S.session = { path: 'p-kb', sessionId: 's-kb', title: '键盘' };
  keyboard(800);                       // --kb = 0，clientHeight = 600
  await h.settle();
  userScroll(400);                     // 1000 - 400 - 600 = 0 → 贴底
  assert.equal(hana.nearBottom(), true, '夹具：起始状态是贴底的');

  keyboard(500);                       // 键盘占 300px
  assert.equal(h.cssVars.get('--kb'), '300px', '布局变量仍要按键盘高度更新');
  assert.equal(
    transcript.scrollTop,
    1000,
    `贴底的会话在键盘弹起后必须还在底部（新的底部是 1000），实际 ${transcript.scrollTop}`,
  );

  await h.settle();                    // rAF 补滚之后也不能把它带偏
  assert.equal(hana.nearBottom(), true, 'rAF 补滚之后仍然贴底');
});

await t('键盘弹起：用户正在往上翻的，不许硬拽到底', async () => {
  keyboard(800);
  await h.settle();                    // 先让上一轮的补滚落地
  userScroll(100);                     // 1000 - 100 - 600 = 300 → 不贴底
  assert.equal(hana.nearBottom(), false, '夹具：起始状态不贴底');

  keyboard(500);
  assert.equal(h.cssVars.get('--kb'), '300px', '布局变量仍要更新');
  await h.settle();
  assert.equal(transcript.scrollTop, 100, '用户没贴底时不能被拽到最底');
});

await t('没有活动会话时不动滚动位置', async () => {
  S.session = null;
  keyboard(800);
  await h.settle();
  transcript.scrollTop = 400;
  keyboard(500);
  assert.equal(h.cssVars.get('--kb'), '300px', '布局变量与有没有会话无关');
  await h.settle();
  assert.equal(transcript.scrollTop, 400, '不在会话里时不该动滚动位置');
});

await t('resize 模式：布局视口一起变矮（inset 恒 0），贴底的会话也要滚到底', async () => {
  S.session = { path: 'p-resize', sessionId: 's-resize', title: '键盘' };
  resetLayout();
  h.fireWindow('resize');              // 收键盘：--kb 回到 0
  await h.settle();
  userScroll(400);                     // 1000 - 400 - 600 = 0 → 贴底
  assert.equal(hana.nearBottom(), true, '夹具：起始状态是贴底的');
  assert.equal(transcript.clientHeight, 600, '夹具：键盘没弹时 transcript 是 600px');

  // 数一下 adjust() 到底滚了几次：要求「同步一次 + 下一帧一次」。
  const realScrollToBottom = hana.renderer.scrollToBottom;
  let scrollCalls = 0;
  hana.renderer.scrollToBottom = (...args) => {
    scrollCalls += 1;
    return realScrollToBottom(...args);
  };
  try {
    resizeKeyboard(500);               // 键盘占 300px：布局 500，vv 500，inset 恒 0
    assert.equal(h.cssVars.get('--kb'), '0px', 'resize 模式下 --kb 不再是键盘高度的信号');
    assert.equal(transcript.clientHeight, 300, '夹具：transcript 确实变矮了（真机上「被裁掉」的来源）');
    assert.equal(
      hana.nearBottom(),
      true,
      '同步那次就要按变矮后的布局贴底，不能等下一帧',
    );
    assert.equal(
      transcript.scrollTop,
      1000,
      `resize 模式下贴底的会话也必须滚到底，实际 ${transcript.scrollTop}`,
    );
    assert.equal(scrollCalls, 2, `两个视口事件各同步滚一次，实际 ${scrollCalls} 次`);

    await h.settle();                  // 给 rAF 补滚一个 tick（harness 里 rAF = setTimeout 0）
    assert.equal(transcript.scrollTop, 1000, 'rAF 补滚之后仍应在底部');
    assert.equal(scrollCalls, 4, `每个视口事件都要再补一次 rAF 滚动，实际 ${scrollCalls} 次`);
  } finally {
    hana.renderer.scrollToBottom = realScrollToBottom;
  }
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
