/* tests/composer_controller.test.mjs
 *
 * web/composer-controller.js 单元测试：
 * 覆盖 composer.back() 契约：
 * 1. sheet 打开时（主页或聊天页目标）：关 sheet 并返回 true；
 * 2. sheet 已关闭时：返回 false；
 * 3. 关闭 sheet 时不清已选附件（S.attach / S.homeAttach）、不丢输入草稿（input / homeInput）；
 * 4. 不触发发送、不触发系统文件选择（pickCamera / pickGallery click）；
 * 5. 再次调用 back() 返回 false。
 */

import assert from 'node:assert/strict';
import { createComposer } from '../web/composer-controller.js';

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function makeMockElement(id = '') {
  const listeners = {};
  return {
    id,
    hidden: true,
    value: '',
    disabled: false,
    clicked: 0,
    click() {
      this.clicked += 1;
      (listeners['click'] || []).forEach((f) => f({ target: this }));
    },
    addEventListener(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    dispatchEvent(evt, data) {
      (listeners[evt] || []).forEach((f) => f({ target: this, ...data }));
    },
    style: {},
    querySelector() { return null; },
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
  };
}

function setupComposer(initialState = {}, options = {}) {
  const elements = {};
  const getElement = (id) => {
    if (!elements[id]) elements[id] = makeMockElement(id);
    return elements[id];
  };

  const state = {
    attach: [],
    homeAttach: [],
    busy: false,
    sending: false,
    wsReady: true,
    session: { path: 'session/path', sessionId: 'session-id' },
    sentInputs: new Set(),
    ...initialState,
  };

  const rendered = [];
  const frames = [];
  let waits = 0;
  const renderer = {
    scrollToBottom() {},
    appendUser: (...args) => rendered.push(args),
    appendSystem() {},
    clearStats() {},
  };

  const sockets = {
    send(frame) { frames.push(frame); return options.sendResult === undefined ? true : options.sendResult; },
    drop() {},
  };

  const streamState = {};
  const flash = () => {};
  const waitForReady = async () => {
    waits += 1;
    return options.waitForReady ? options.waitForReady() : true;
  };
  const autoGrow = () => {};

  const composer = createComposer({
    state,
    getElement,
    renderer,
    sockets,
    streamState,
    flash,
    waitForReady,
    autoGrow,
    captureQuote: options.captureQuote,
    consumeQuote: options.consumeQuote,
  });

  return { composer, state, elements, getElement, frames, rendered, get waits() { return waits; } };
}

t('composer 暴露 back() 方法', () => {
  const { composer } = setupComposer();
  assert.equal(typeof composer.back, 'function', 'composer 必须导出 back 方法');
});

t('sheet 关闭时调用 back() 返回 false', () => {
  const { composer, getElement } = setupComposer();
  getElement('attachSheet').hidden = true;
  assert.equal(composer.back(), false, 'sheet 关闭时 back() 必须返回 false');
});

t('聊天页 sheet 打开后调用 back()：关闭 sheet 且返回 true，保留附件与输入草稿', () => {
  const { composer, state, getElement } = setupComposer({
    attach: [{ name: 'chat.png', base64: 'abc' }],
  });
  const sheet = getElement('attachSheet');
  const input = getElement('input');
  const pickCamera = getElement('pickCamera');
  const pickGallery = getElement('pickGallery');

  input.value = '保留的草稿文本';
  composer.openAttachSheet(true, 'chat');
  assert.equal(sheet.hidden, false, 'openAttachSheet 后 sheet 应当可见');

  const handled = composer.back();
  assert.equal(handled, true, 'sheet 打开时 back() 必须返回 true');
  assert.equal(sheet.hidden, true, 'back() 必须把 sheet.hidden 置为 true');

  // 严格核验副作用边界：
  assert.equal(input.value, '保留的草稿文本', 'back() 不得清空聊天输入草稿');
  assert.deepEqual(state.attach, [{ name: 'chat.png', base64: 'abc' }], 'back() 不得清空已选附件');
  assert.equal(pickCamera.clicked, 0, '不得触发拍照调用');
  assert.equal(pickGallery.clicked, 0, '不得触发相册选择');
  assert.equal(state.sending, false, '不得触发消息发送');

  // 再次调用返回 false
  assert.equal(composer.back(), false, '已关闭后再次调用 back() 必须返回 false');
});

t('主页 sheet 打开后调用 back()：关闭 sheet 且返回 true，保留主页草稿与附件', () => {
  const { composer, state, getElement } = setupComposer({
    homeAttach: [{ name: 'home.png', base64: 'xyz' }],
  });
  const sheet = getElement('attachSheet');
  const homeInput = getElement('homeInput');
  homeInput.value = '主页保留草稿';

  composer.openAttachSheet(true, 'home');
  assert.equal(sheet.hidden, false);

  const handled = composer.back();
  assert.equal(handled, true);
  assert.equal(sheet.hidden, true);

  assert.equal(homeInput.value, '主页保留草稿', '不得清空主页草稿');
  assert.deepEqual(state.homeAttach, [{ name: 'home.png', base64: 'xyz' }], '不得清空主页已选附件');

  assert.equal(composer.back(), false);
});

async function at(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

await at('sendPrepared 共享发送管线但不改普通草稿、附件或引用', async () => {
  let captured = 0;
  let consumed = 0;
  const attachment = { id: 'ordinary-file', kind: 'file', name: 'keep.pdf', fileId: 'sf-keep', base64: 'file' };
  const setup = setupComposer({
    attach: [attachment],
  }, {
    captureQuote: () => { captured += 1; return 8; },
    consumeQuote: () => { consumed += 1; },
  });
  const { composer, state, getElement, frames, rendered } = setup;
  getElement('input').value = '普通草稿必须保留';
  state.busy = false;
  const feed = { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 3, title: '冻结标题' };
  const result = await composer.sendPrepared({ text: '关于这条日报', feed, isCurrent: () => true });

  assert.deepEqual(result, { frameWritten: true, committed: true, inputId: frames[0].inputId });
  assert.equal(setup.waits, 1, 'prepared 只走一次现有 WS ready wait');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].feedItemId, feed.itemId);
  assert.equal(frames[0].feedRevision, 3);
  assert.deepEqual(state.attach, [attachment], '不得消费普通附件');
  assert.equal(getElement('input').value, '普通草稿必须保留', '不得清普通聊天草稿');
  assert.equal(captured, 0, '不得捕获普通引用');
  assert.equal(consumed, 0, '不得消费普通引用');
  assert.equal(rendered.length, 1, '本地消息仍正常登记');
  assert.equal(rendered[0][0], '关于这条日报');
  assert.deepEqual(rendered[0][1], []);
  assert.deepEqual(rendered[0][2], []);
  assert.equal(state.sentInputs.has(result.inputId), true);
  assert.equal(state.busy, true);
});

await at('sendPrepared 写帧失败保留普通输入和附件且返回明确未发送结果', async () => {
  const attachment = { id: 'ordinary-image', name: 'keep.png', mimeType: 'image/png', base64: 'AAAA' };
  const { composer, state, getElement, frames } = setupComposer({ attach: [attachment] }, { sendResult: false });
  getElement('input').value = '保留';
  const result = await composer.sendPrepared({
    text: '日报问题',
    feed: { itemId: 'fi_0123456789ABCDEFGHJKMNPQRS', revision: 1 },
    isCurrent: () => true,
  });
  assert.equal(result.frameWritten, false);
  assert.equal(result.committed, false);
  assert.ok(result.error instanceof Error);
  assert.equal(frames.length, 1);
  assert.equal(getElement('input').value, '保留');
  assert.deepEqual(state.attach, [attachment]);
  assert.equal(state.sentInputs.size, 0);
});

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
