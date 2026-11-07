/* tests/stream_stats_timing.test.mjs
 *
 * W7 裁决防回归断言：不伪造非本地流的 TTFT 起点
 *
 * 审查裁决：
 * W7（性能统计）裁决不予采纳。远端推送流的真实发起时间对客户端不可知，
 * 客户端不得在收到推送或 startAssistantTurn 时将客户端本地时间伪造成首响测量起点，
 * 避免产生失真或误导性的 TTFT 统计。
 */

import assert from 'node:assert/strict';

function makeDoc() {
  const el = (tag = 'div') => {
    const children = [];
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      style: {},
      children,
      textContent: '',
      innerHTML: '',
      classList: {
        add(c) { node.className += ' ' + c; },
        remove(c) { node.className = node.className.replace(c, ''); },
        toggle(c, v) {},
      },
      appendChild(c) { children.push(c); return c; },
      querySelector(sel) {
        if (sel === '.foot-stats') {
          let found = children.find((c) => c.className.includes('foot-stats'));
          if (!found) {
            found = el('span');
            found.className = 'foot-stats';
            children.push(found);
          }
          return found;
        }
        return null;
      },
      querySelectorAll() { return []; },
      setAttribute() {},
    };
    return node;
  };
  return {
    createElement: el,
    body: el('body'),
  };
}

globalThis.document = makeDoc();
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { createChatRenderer } = await import('../web/chat-renderer.js');

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

await t('chat-renderer: 非本地发起的推送流不得伪造 turnStart 起点', async () => {
  const doc = globalThis.document;
  const state = {
    turn: null,
    turnBody: null,
    turnFootEl: null,
    turnMeta: null,
    thinkAt: 0,
    textEl: null,
    streamingRaw: '',
    turnStart: 0,
    firstTokenMs: 0,
    charCount: 0,
    speed: 0,
  };

  const renderer = createChatRenderer({
    container: doc.createElement('div'),
    state,
    document: doc,
    agentAvatarUrlById: () => '',
    paintAvatar: () => {},
    getElement: () => null,
  });

  assert.equal(state.turnStart, 0, '初始 turnStart 为 0');

  // 当收到非本地发送的服务端推送流事件时，触发 startAssistantTurn
  renderer.startAssistantTurn();

  // W7 裁决：不伪造非本地流的 turnStart
  assert.equal(state.turnStart, 0, '非本地流不得人为设置伪造的客户端本地起点');
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
