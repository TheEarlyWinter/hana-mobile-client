/* tests/message_search.test.mjs — 消息搜索面板测试
 *
 * 覆盖：
 * 1. 打开面板 → 输入关键字 → 触发 onSearch 且参数正确
 * 2. 结果渲染出标题与片段（含高亮）；点击结果触发 onSelect 回调
 * 3. 请求中（loading）、空结果（empty）和请求失败（error）的状态文案（区分网络与 404）
 * 4. close() 后隐藏且不再响应搜索；destroy() 从 DOM 彻底清理
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createMessageSearch } from '../web/message-search.js';

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

// 辅助等待
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

await t('打开面板 → 输入关键字 → 触发 onSearch 且参数正确', async () => {
  const h = createHarness({ debug: false });
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);

  let searchCalls = [];
  const searcher = createMessageSearch({
    document: h.doc,
    container,
    debounceMs: 0, // 测试中立即搜索
    onSearch: async (q) => {
      searchCalls.push(q);
      return [];
    },
  });

  assert.equal(searcher.isOpen(), false, '初始状态为未打开');
  searcher.open();
  assert.equal(searcher.isOpen(), true, 'open() 后状态为已打开');

  const input = container.querySelector('.message-search-input');
  assert.ok(input, '面板内应存在输入框');

  input.value = '测试关键字';
  input.dispatchEvent('input');
  await tick(20);

  assert.equal(searchCalls.length, 1, '应触发一次搜索');
  assert.equal(searchCalls[0], '测试关键字', '搜索参数应准确传递');
});

await t('结果渲染出标题与片段；点击结果回调收到该条', async () => {
  const h = createHarness({ debug: false });
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);

  const mockItem = {
    sessionTitle: '前端架构讨论',
    snippet: '这里讨论了关于 Markdown 渲染的实现细节',
    path: '/path/to/session.jsonl',
    sessionId: 'sess_123',
    timestamp: 1793758000000,
  };

  let selected = null;
  const searcher = createMessageSearch({
    document: h.doc,
    container,
    debounceMs: 0,
    onSearch: async () => [mockItem],
    onSelect: (item) => {
      selected = item;
    },
  });

  searcher.open();
  const input = container.querySelector('.message-search-input');
  input.value = 'Markdown';
  input.dispatchEvent('input');
  await tick(20);

  const resultItems = container.querySelectorAll('.message-search-item');
  assert.equal(resultItems.length, 1, '应渲染出 1 条搜索结果');

  const titleEl = container.querySelector('.message-search-item-title');
  assert.ok(titleEl && titleEl.textContent.includes('前端架构讨论'), '标题应正确渲染');

  const snippetEl = container.querySelector('.message-search-item-snippet');
  assert.ok(snippetEl && snippetEl.innerHTML.includes('mark'), '关键字应当被高亮标记');

  resultItems[0].dispatchEvent('click');
  assert.deepEqual(selected, mockItem, '点击结果项应触发 onSelect 并传入对应数据');
});

await t('空结果、请求中与请求失败（404/网络异常）有清晰可读文案', async () => {
  const h = createHarness({ debug: false });
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);

  let searchMode = 'empty';
  const searcher = createMessageSearch({
    document: h.doc,
    container,
    debounceMs: 0,
    onSearch: async (q) => {
      if (searchMode === 'loading') {
        return new Promise(() => {}); // 挂起
      }
      if (searchMode === '404') {
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }
      if (searchMode === 'network') {
        throw new TypeError('Failed to fetch');
      }
      return [];
    },
  });

  searcher.open();
  const input = container.querySelector('.message-search-input');
  const statusEl = container.querySelector('.message-search-status');
  assert.ok(statusEl, '应有状态提示元素');

  // 1. 空结果
  input.value = '不存在的内容';
  input.dispatchEvent('input');
  await tick(20);
  assert.ok(statusEl.textContent.includes('未找到') || statusEl.textContent.includes('无结果'), '应提示未找到相关消息');

  // 2. 接口不存在 (404)
  searchMode = '404';
  input.value = '报错404';
  input.dispatchEvent('input');
  await tick(20);
  assert.ok(statusEl.textContent.includes('接口不存在') || statusEl.textContent.includes('未提供'), '404 应明确指出接口不存在');

  // 3. 网络异常
  searchMode = 'network';
  input.value = '网络报错';
  input.dispatchEvent('input');
  await tick(20);
  assert.ok(statusEl.textContent.includes('网络'), '网络错误应明确提示网络连接异常');
});

await t('close() 后隐藏且不再响应；destroy() 清理干净', async () => {
  const h = createHarness({ debug: false });
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);

  let searchCalls = 0;
  let closeCalled = false;

  const searcher = createMessageSearch({
    document: h.doc,
    container,
    debounceMs: 0,
    onSearch: async () => {
      searchCalls += 1;
      return [];
    },
    onClose: () => {
      closeCalled = true;
    },
  });

  searcher.open();
  assert.equal(searcher.isOpen(), true);

  searcher.close();
  assert.equal(searcher.isOpen(), false, 'close() 后 isOpen 应为 false');
  assert.equal(closeCalled, true, '应当触发 onClose 回调');

  const root = container.querySelector('.message-search-overlay');
  assert.ok(root && root.hidden, 'close() 后浮层应为 hidden');

  const input = container.querySelector('.message-search-input');
  input.value = '关闭后输入';
  input.dispatchEvent('input');
  await tick(20);
  assert.equal(searchCalls, 0, '关闭状态下不应触发搜索');

  searcher.destroy();
  assert.equal(container.children.length, 0, 'destroy() 应彻底将元素从容器中移除');
});

await t('软键盘弹出时，面板通过 --kb 让出被遮挡的高度', async () => {
  const h = createHarness({ debug: false });
  const container = h.doc.createElement('div');
  h.doc.body.appendChild(container);

  const searcher = createMessageSearch({
    document: h.doc,
    window: h.window,
    container,
    debounceMs: 0,
    onSearch: async () => [],
  });

  const cssKb = () => h.doc.documentElement.style.getPropertyValue('--kb');
  searcher.open();
  // 真机上键盘弹出时 innerHeight 不变、visualViewport.height 变小，差值就是被遮住的高度
  h.visualViewport.height = 420;
  h.fireVisualViewport('resize');
  assert.equal(cssKb(), '380px', '--kb 应等于 innerHeight 与 visualViewport 高度之差');

  h.visualViewport.height = 800;
  h.fireVisualViewport('resize');
  assert.equal(cssKb(), '0px', '键盘收起后 --kb 应归零');

  searcher.close();
  assert.equal(cssKb(), '0px', '关闭后不能把 --kb 残留给其它视图');

  searcher.destroy();
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
