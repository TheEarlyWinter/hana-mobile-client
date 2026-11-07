/* 全屏看图（E12）的装配契约：渲染器不再自己开关旧灯箱，
 * 而是把「哪几张图、点的是第几张」交给注入的查看器。
 * 模块本身（缩放/滑动/判定）在 tests/lightbox.test.mjs 里另有 17 条。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createChatRenderer } from '../web/chat-renderer.js';

const h = createHarness();

const calls = [];
const renderer = createChatRenderer({
  state: {},
  getElement: (id) => h.getEl(id),
  openImageViewer: (items, index) => calls.push({ items, index }),
});

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

t('用户图集：点第 2 张，交给查看器的清单是同一条消息的全部图片且下标正确', () => {
  calls.length = 0;
  const grid = renderer.mediaGrid([
    { src: 'http://x/a.png', name: 'a' },
    { src: 'http://x/b.png', name: 'b' },
    { src: 'http://x/c.png', name: 'c' },
  ]);
  const imgs = grid.children.filter((n) => n.tagName === 'IMG');
  assert.equal(imgs.length, 3, '三张图都应渲染成 img');
  imgs[1].dispatchEvent('click');
  assert.equal(calls.length, 1, '点一次只应打开一次');
  assert.deepEqual(calls[0].items.map((i) => i.src), [
    'http://x/a.png',
    'http://x/b.png',
    'http://x/c.png',
  ]);
  assert.equal(calls[0].index, 1, '点的第二张，下标应为 1');
});

t('坏图不占位：跳过打不开的项，清单里不混进空地址', () => {
  calls.length = 0;
  const grid = renderer.mediaGrid([
    { name: '坏图' },
    { src: 'http://x/ok.png', name: 'ok' },
  ]);
  const imgs = grid.children.filter((n) => n.tagName === 'IMG');
  assert.equal(imgs.length, 1);
  imgs[0].dispatchEvent('click');
  assert.deepEqual(calls[0].items, [{ src: 'http://x/ok.png', alt: 'ok' }]);
  assert.equal(calls[0].index, 0);
});

t('没有查看器时不炸：退回旧灯箱或安静跳过', () => {  const bare = createChatRenderer({ state: {}, getElement: (id) => h.getEl(id) });
  const grid = bare.mediaGrid([{ src: 'http://x/a.png', name: 'a' }]);
  const img = grid.children.find((n) => n.tagName === 'IMG');
  img.dispatchEvent('click');   // 不该抛
  assert.ok(true);
});

t('助手正文里的 md-img：点图把同一条消息内的图当图集打开', () => {
  calls.length = 0;
  const transcript = h.getEl('transcript');
  const body = document.createElement('div');
  body.className = 'turn-body';
  const first = document.createElement('img');
  first.className = 'md-img';
  first.src = 'http://x/1.png';
  const second = document.createElement('img');
  second.className = 'md-img';
  second.src = 'http://x/2.png';
  body.appendChild(first);
  body.appendChild(second);
  transcript.appendChild(body);

  // 假 DOM 不做事件冒泡，直接以委托监听所在节点 + target 触发，
  // 这样测的是处理器本身的逻辑（真浏览器的冒泡行为不归这里管）。
  transcript.dispatchEvent('click', { target: second });
  assert.equal(calls.length, 1, '点一次只应打开一次');
  assert.deepEqual(calls[0].items.map((i) => i.src), ['http://x/1.png', 'http://x/2.png']);
  assert.equal(calls[0].index, 1);
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);process.exit(bad === 0 ? 0 : 1);
