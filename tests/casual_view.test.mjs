/* tests/casual_view.test.mjs — Hana 宿主闲聊（Casual Chat）视图层测试
 *
 * 测试覆盖：
 * 1. 8 种 item.kind 各渲染出对应节点（voice 走文字兜底）
 * 2. 未知 kind 不崩，安全退化为灰色占位
 * 3. 自己与对方气泡分侧（.casual-row--user 与 .casual-row--agent）及连续气泡圆角修饰
 * 4. pending / failed 标记与点击失败重试（onRetry）
 * 5. typing 状态的显示与隐藏
 * 6. unread 分隔线位置计算（从末尾往前数 unread 条前插入「以下为新消息」）
 * 7. 输入框交互：回车发送、点击发送、空文本拦截与发送后清空
 * 8. 滚到顶部触发 onLoadEarlier 及其节流机制（短时间内多次滚动只触发一次）
 * 9. open / close / destroy 生命周期与 scrollToLatest 滚动行为
 * 10. 顶部栏交互（返回触发 onClose、表情包按钮触发 onOpenStickers）
 * 11. 标记已读 onMarkRead 的时机与单条去重逻辑
 * 12. 已读上报失败（false / reject）不记账，下一次状态更新重试；reset() 清空去重
 * 13. reset() 清空输入框草稿（切 Agent / 登出后不带走旧草稿）
 * 14. 空历史且加载结束时展示空态文案，加载中 / 有条目时不展示
 *
 * 验收规则：
 * 必须全绿并在结尾输出 ALL PASS，若失败则 process.exit(1)。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createCasualView } from '../web/casual-view.js';

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

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/* =========================================================================
 * 1. 8 种 item.kind 渲染与 voice 文字兜底
 * ========================================================================= */
await t('8 种 item.kind 各渲染出对应结构（voice 走文字兜底）', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const entries = [
    { id: '1', actor: 'user', occurredAt: 1700000000000, item: { kind: 'text', text: '你好呀，今天天气真好' } },
    { id: '2', actor: 'agent', occurredAt: 1700000001000, item: { kind: 'sticker', stickerId: 's1', url: 'https://img/cat.png', note: '猫猫卖萌' } },
    { id: '3', actor: 'user', occurredAt: 1700000002000, item: { kind: 'image', url: 'https://img/scenery.jpg', width: 200, height: 150 } },
    { id: '4', actor: 'agent', occurredAt: 1700000003000, item: { kind: 'card', cardId: 'c1', title: '日程安排', block: '下午三点前端评审会' } },
    { id: '5', actor: 'user', occurredAt: 1700000004000, item: { kind: 'file', fileId: 'f1', name: 'design.fig', mime: 'application/octet-stream', size: 1048576 } },
    { id: '6', actor: 'agent', occurredAt: 1700000005000, item: { kind: 'approval', approvalId: 'a1', title: '部署确认', status: '待确认', detail: '是否发布到预发环境？' } },
    { id: '7', actor: 'agent', occurredAt: 1700000006000, item: { kind: 'reset' } },
    { id: '8', actor: 'agent', occurredAt: 1700000007000, item: { kind: 'voice', text: '喵呜，好梦呀！', durationMs: 2500 } },
  ];

  view.setState({ entries });

  const root = h.doc.body.querySelector('.casual-view');
  assert.ok(root, '应渲染出根节点 .casual-view');

  // 1. text
  const textEl = root.querySelector('.casual-item--text .casual-text');
  assert.ok(textEl, 'text 应存在 .casual-text 节点');
  assert.equal(textEl.textContent, '你好呀，今天天气真好');

  // 2. sticker
  const stickerImg = root.querySelector('.casual-item--sticker .casual-sticker-img');
  assert.ok(stickerImg, 'sticker 应存在 img 节点');
  assert.equal(stickerImg.src, 'https://img/cat.png');
  assert.equal(stickerImg.alt, '猫猫卖萌');

  // 3. image
  const imgEl = root.querySelector('.casual-item--image .casual-image');
  assert.ok(imgEl, 'image 应存在 img 节点');
  assert.equal(imgEl.src, 'https://img/scenery.jpg');

  // 4. card
  const cardTitle = root.querySelector('.casual-item--card .casual-card-title');
  const cardBlock = root.querySelector('.casual-item--card .casual-card-block');
  assert.ok(cardTitle, 'card 应有标题');
  assert.equal(cardTitle.textContent, '日程安排');
  assert.equal(cardBlock.textContent, '下午三点前端评审会');

  // 5. file
  const fileName = root.querySelector('.casual-item--file .casual-file-name');
  const fileMeta = root.querySelector('.casual-item--file .casual-file-meta');
  assert.ok(fileName, 'file 应有文件名');
  assert.equal(fileName.textContent, 'design.fig');
  assert.ok(fileMeta.textContent.includes('1.0 MB'), 'file 元信息应包含格式化大小');

  // 6. approval
  const appTitle = root.querySelector('.casual-item--approval .casual-approval-title');
  const appStatus = root.querySelector('.casual-item--approval .casual-approval-status');
  const appDetail = root.querySelector('.casual-item--approval .casual-approval-detail');
  assert.equal(appTitle.textContent, '部署确认');
  assert.equal(appStatus.textContent, '待确认');
  assert.equal(appDetail.textContent, '是否发布到预发环境？');

  // 7. reset (居中系统提示)
  const resetTip = root.querySelector('.casual-reset .casual-system-tip-text');
  assert.ok(resetTip, 'reset 应渲染为系统提示条');
  assert.equal(resetTip.textContent, '会话已重置');

  // 8. voice (文字兜底)
  const voiceEl = root.querySelector('.casual-voice');
  assert.ok(voiceEl, 'voice 应对齐文字兜底节点');
  assert.equal(voiceEl.textContent, '语音：喵呜，好梦呀！');

  view.destroy();
});

/* =========================================================================
 * 2. 未知 kind 不崩
 * ========================================================================= */
await t('未知 kind 不崩溃，平稳退化为占位节点', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const entries = [
    { id: 'u1', actor: 'agent', occurredAt: 1700000000000, item: { kind: 'alien_mind_link', raw: '10101' } },
  ];

  assert.doesNotThrow(() => {
    view.setState({ entries });
  }, '渲染未知 kind 时不能抛出异常');

  const root = h.doc.body.querySelector('.casual-view');
  const unsupportedEl = root.querySelector('.casual-unsupported');
  assert.ok(unsupportedEl, '未知 kind 应渲染 .casual-unsupported 占位元素');
  assert.ok(unsupportedEl.textContent.includes('alien_mind_link'), '占位元素中应包含未知 kind 名称');

  view.destroy();
});

/* =========================================================================
 * 3. 自己与对方气泡分侧
 * ========================================================================= */
await t('气泡根据 actor 正确区分角色分侧（user 靠右，agent 靠左）', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  view.setState({
    agentName: '茉莉',
    avatarUrl: 'https://avatar/moli.png',
    entries: [
      { id: '1', actor: 'agent', occurredAt: 1700000000000, item: { kind: 'text', text: '主人下午好喵' } },
      { id: '2', actor: 'user', occurredAt: 1700000001000, item: { kind: 'text', text: '下午好' } },
    ],
  });

  const root = h.doc.body.querySelector('.casual-view');
  const rows = root.querySelectorAll('.casual-row');
  assert.equal(rows.length, 2, '应有 2 行消息');

  // 第 1 条 agent
  assert.ok(rows[0].classList.contains('casual-row--agent'), '第 1 条应具有 agent 侧类名');
  const agentAvatar = rows[0].querySelector('.casual-avatar img');
  assert.ok(agentAvatar, 'agent 消息侧应具有头像');
  assert.equal(agentAvatar.src, 'https://avatar/moli.png');

  // 第 2 条 user
  assert.ok(rows[1].classList.contains('casual-row--user'), '第 2 条应具有 user 侧类名');

  view.destroy();
});

/* =========================================================================
 * 4. pending 与 failed 标记，点失败条目回调 onRetry
 * ========================================================================= */
await t('pending 状态显示「发送中」，failed 状态显示「!」且点击触发 onRetry', () => {
  const h = createHarness({ debug: false });
  let retriedId = null;

  const view = createCasualView({
    document: h.doc,
    onRetry: (id) => {
      retriedId = id;
    },
  });

  view.setState({
    entries: [
      { id: 'msg-pending', actor: 'user', pending: true, item: { kind: 'text', text: '正在发' } },
      { id: 'msg-failed', actor: 'user', failed: true, item: { kind: 'text', text: '发送失败了' } },
    ],
  });

  const root = h.doc.body.querySelector('.casual-view');
  const pendingNode = root.querySelector('.casual-status--pending');
  assert.ok(pendingNode, '应当渲染 .casual-status--pending 节点');
  assert.equal(pendingNode.textContent, '发送中');

  const failedNode = root.querySelector('.casual-status--failed');
  assert.ok(failedNode, '应当渲染 .casual-status--failed 节点');
  assert.equal(failedNode.textContent, '!');

  // 点击触发重试
  failedNode.click();
  assert.equal(retriedId, 'msg-failed', '点击重试应调用 onRetry 并带上对应消息 id');

  view.destroy();
});

/* =========================================================================
 * 5. typing 状态的展示与隐藏
 * ========================================================================= */
await t('typing 状态切换正确控制「对方正在输入…」', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const typingEl = root.querySelector('.casual-typing');
  assert.equal(typingEl.hidden, true, '初始 typing 应隐藏');

  view.setState({ typing: true });
  assert.equal(typingEl.hidden, false, 'typing 为 true 时应展示');
  const typingText = typingEl.querySelector('.casual-typing-text');
  assert.ok(typingText, '应存在输入提示文案节点');
  assert.ok(typingText.textContent.includes('对方正在输入'), '展示文案包含输入中提示');

  view.setState({ typing: false });
  assert.equal(typingEl.hidden, true, 'typing 恢复为 false 时隐藏');

  view.destroy();
});

/* =========================================================================
 * 6. unread 分隔线位置计算
 * ========================================================================= */
await t('unread > 0 时从末尾往前数 unread 条插入未读分隔线', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const entries = [
    { id: 'm1', actor: 'user', occurredAt: 1700000000000, item: { kind: 'text', text: '消息1' } },
    { id: 'm2', actor: 'agent', occurredAt: 1700000000000, item: { kind: 'text', text: '消息2' } },
    { id: 'm3', actor: 'agent', occurredAt: 1700000000000, item: { kind: 'text', text: '消息3' } },
    { id: 'm4', actor: 'agent', occurredAt: 1700000000000, item: { kind: 'text', text: '消息4' } },
  ];

  // 4条消息，未读2条，未读起始应在 m3（索引 2）之前
  view.setState({ entries, unread: 2 });

  const root = h.doc.body.querySelector('.casual-view');
  const divider = root.querySelector('.casual-unread-divider');
  assert.ok(divider, '应当存在 .casual-unread-divider');
  const dividerText = divider.querySelector('.casual-unread-divider-text');
  assert.ok(dividerText, '应当存在未读提示文本节点');
  assert.ok(dividerText.textContent.includes('以下为新消息'));

  // 验证未读分隔线在 DOM 树中的前后关系
  const listEl = root.querySelector('.casual-list');
  const dividerIndex = listEl.children.indexOf(divider);
  const m3Row = listEl.querySelector('.casual-row-id-m3');
  assert.ok(m3Row, '应当找到 m3 消息行');
  const m3Index = listEl.children.indexOf(m3Row);

  assert.equal(dividerIndex, m3Index - 1, '未读分隔线应当紧邻在第一条未读消息 m3 之前');

  // 当 unread 为 0 时，应不再展示未读分隔线
  view.setState({ entries, unread: 0 });
  const noDivider = root.querySelector('.casual-unread-divider');
  assert.equal(noDivider, null, 'unread 为 0 时不应渲染未读分隔线');

  view.destroy();
});

/* =========================================================================
 * 7. 输入框交互：回车发送、点击发送、空文本拦截
 * ========================================================================= */
await t('输入框输入回车或点击发送按钮触发 onSend，空内容被拦截', () => {
  const h = createHarness({ debug: false });
  const sentList = [];

  const view = createCasualView({
    document: h.doc,
    onSend: (text) => {
      sentList.push(text);
    },
  });

  const root = h.doc.body.querySelector('.casual-view');
  const inputEl = root.querySelector('.casual-input');
  const sendBtn = root.querySelector('.casual-send-btn');

  // 1. 空内容回车
  inputEl.value = '   ';
  inputEl.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false });
  assert.equal(sentList.length, 0, '全空格文本回车不触发 onSend');

  // 2. 正常输入回车
  inputEl.value = '你好，Hana！';
  inputEl.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: false });
  assert.equal(sentList.length, 1, '回车后应触发一次 onSend');
  assert.equal(sentList[0], '你好，Hana！', '发送内容准确');
  assert.equal(inputEl.value, '', '发送后输入框应被清空');

  // 3. 点击发送按钮
  inputEl.value = '今天真开心';
  sendBtn.click();
  assert.equal(sentList.length, 2, '点击发送按钮应触发 onSend');
  assert.equal(sentList[1], '今天真开心');
  assert.equal(inputEl.value, '', '点击发送后输入框应被清空');

  view.destroy();
});

/* =========================================================================
 * 8. 滚到顶部触发 onLoadEarlier 及其节流
 * ========================================================================= */
await t('滚动至顶部附近触发 onLoadEarlier，且短时间内多次滚动具有节流保护', async () => {
  const h = createHarness({ debug: false });
  let loadCalls = 0;

  const view = createCasualView({
    document: h.doc,
    onLoadEarlier: () => {
      loadCalls += 1;
    },
  });

  view.open();
  view.setState({
    hasMore: true,
    loadingEarlier: false,
    entries: [{ id: '1', actor: 'user', item: { kind: 'text', text: '旧消息' } }],
  });

  const root = h.doc.body.querySelector('.casual-view');
  const messagesEl = root.querySelector('.casual-messages');

  // 滚到顶部 (scrollTop <= 40)
  messagesEl.scrollTop = 10;

  // 连续触发 3 次滚动
  messagesEl.dispatchEvent('scroll');
  messagesEl.dispatchEvent('scroll');
  messagesEl.dispatchEvent('scroll');

  assert.equal(loadCalls, 1, '由于节流保护，短时间内多次滚动应仅触发 1 次 onLoadEarlier');

  // 节流期过后再次滚动
  await tick(350);
  messagesEl.dispatchEvent('scroll');
  assert.equal(loadCalls, 2, '节流时间过后再次滚动应正常触发');

  view.destroy();
});

/* =========================================================================
 * 9. open / close / destroy 生命周期与 scrollToLatest
 * ========================================================================= */
await t('open / close / destroy 状态与生命周期行为准确', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  assert.equal(view.isOpen(), false, '初始状态 isOpen() 为 false');
  assert.equal(root.hidden, true, '初始 DOM hidden 为 true');

  view.open();
  assert.equal(view.isOpen(), true, 'open() 后 isOpen() 为 true');
  assert.equal(root.hidden, false, 'open() 后 DOM hidden 为 false');

  view.close();
  assert.equal(view.isOpen(), false, 'close() 后 isOpen() 为 false');
  assert.equal(root.hidden, true, 'close() 后 DOM hidden 为 true');

  // 验证 scrollToLatest
  const messagesEl = root.querySelector('.casual-messages');
  messagesEl.scrollHeight = 1200;
  view.scrollToLatest();
  assert.equal(messagesEl.scrollTop, 1200, 'scrollToLatest 应将 scrollTop 设置为 scrollHeight');

  // 销毁
  view.destroy();
  assert.equal(h.doc.body.querySelector('.casual-view'), null, 'destroy 后节点应从 DOM 树移除');
});

/* =========================================================================
 * 10. 顶部栏交互（返回与表情包按钮）
 * ========================================================================= */
await t('点击顶部返回与表情包按钮正确触发 onClose 与 onOpenStickers', () => {
  const h = createHarness({ debug: false });
  let closed = false;
  let stickersOpened = false;

  const view = createCasualView({
    document: h.doc,
    onClose: () => {
      closed = true;
    },
    onOpenStickers: () => {
      stickersOpened = true;
    },
  });

  const root = h.doc.body.querySelector('.casual-view');
  const backBtn = root.querySelector('.casual-header-back');
  const stickerBtn = root.querySelector('.casual-header-sticker');

  backBtn.click();
  assert.equal(closed, true, '点击返回按钮应当回调 onClose');

  stickerBtn.click();
  assert.equal(stickersOpened, true, '点击表情包按钮应当回调 onOpenStickers');

  view.destroy();
});

/* =========================================================================
 * 11. onMarkRead 时机与单条去重逻辑
 * ========================================================================= */
await t('对最早未读条目触发 onMarkRead 且单条消息严格去重', () => {
  const h = createHarness({ debug: false });
  const markedIds = [];

  const view = createCasualView({
    document: h.doc,
    onMarkRead: (id) => {
      markedIds.push(id);
    },
  });

  const entries = [
    { id: 'e1', actor: 'user', item: { kind: 'text', text: '1' } },
    { id: 'e2', actor: 'agent', item: { kind: 'text', text: '2' } },
    { id: 'e3', actor: 'agent', item: { kind: 'text', text: '3' } },
  ];

  // 3条消息，未读2条，最早未读是 e2
  view.setState({ entries, unread: 2 });
  view.open();

  assert.equal(markedIds.length, 1, '打开时应标记最早未读条目');
  assert.equal(markedIds[0], 'e2', '标记的 entryId 应为最早未读 e2');

  // 再次触发滚动或 open，不应重复对 e2 调用 onMarkRead
  const root = h.doc.body.querySelector('.casual-view');
  const messagesEl = root.querySelector('.casual-messages');
  messagesEl.dispatchEvent('scroll');
  view.open();

  assert.equal(markedIds.length, 1, '相同 entryId 不应重复上报 onMarkRead');

  view.destroy();
});

/* =========================================================================
 * 12. 顶部错误条 error 的展示与隐藏
 * ========================================================================= */
await t('error 状态展示与隐藏', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const errorBar = root.querySelector('.casual-error-bar');
  assert.equal(errorBar.hidden, true, '初始错误条隐藏');

  view.setState({ error: '网络连接异常，请重试' });
  assert.equal(errorBar.hidden, false, '设置 error 时错误条展示');
  assert.equal(errorBar.textContent, '网络连接异常，请重试');

  view.setState({ error: null });
  assert.equal(errorBar.hidden, true, 'error 清空后错误条隐藏');

  view.destroy();
});

/* =========================================================================
 * 12. 滚到底的贴底行为
 * ========================================================================= */
await t('点进去：数据晚于 open 到达，列表重建后仍停在底部', async () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const messagesEl = root.querySelector('.casual-messages');
  messagesEl.clientHeight = 600;
  messagesEl.scrollHeight = 2000;

  // 打开时还没有条目：open() 只能滚一个空列表
  view.open();
  await tick(20);

  // 条目到达，列表整棵重建，高度也变了
  messagesEl.scrollHeight = 2600;
  view.setState({
    entries: [
      { id: '1', actor: 'user', item: { kind: 'text', text: '第一句' } },
      { id: '2', actor: 'agent', item: { kind: 'text', text: '第二句' } },
    ],
  });

  assert.equal(messagesEl.scrollTop, 2600, '数据到达重建后应贴回底部，而不是停在中间');

  view.destroy();
});

await t('用户往上翻历史时，新消息到达不把视口拽回底部', async () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const messagesEl = root.querySelector('.casual-messages');
  messagesEl.clientHeight = 600;
  messagesEl.scrollHeight = 2600;

  view.open();
  view.setState({
    entries: [{ id: '1', actor: 'user', item: { kind: 'text', text: '第一句' } }],
  });

  // 用户在中间看历史，自己滚了一下
  messagesEl.scrollTop = 800;
  messagesEl.dispatchEvent('scroll');

  // 轮询带回新条目，列表再次重建
  messagesEl.scrollHeight = 3000;
  view.setState({
    entries: [
      { id: '1', actor: 'user', item: { kind: 'text', text: '第一句' } },
      { id: '2', actor: 'agent', item: { kind: 'text', text: '新来的' } },
    ],
  });

  assert.equal(messagesEl.scrollTop, 800, '看历史时不能被自动滚到底');

  view.destroy();
});

/* =========================================================================
 * 12. 已读上报失败后必须能重试
 * ========================================================================= */
await t('已读上报失败（reject / false）不记账，下一次状态更新必须重试，成功后不再重复', async () => {
  const h = createHarness({ debug: false });
  const attempts = [];
  let mode = 'reject';

  const view = createCasualView({
    document: h.doc,
    onMarkRead: (id) => {
      attempts.push(id);
      if (mode === 'reject') {
        const failed = Promise.reject(new Error('网络抖了一下'));
        // 夹具自保：没接这个 Promise 的实现不应把整个测试进程炸掉（否则后面的用例都跑不到）。
        failed.catch(() => {});
        return failed;
      }
      if (mode === 'false') return Promise.resolve(false);
      return Promise.resolve(true);
    },
  });

  const entries = [
    { id: 'e1', actor: 'user', item: { kind: 'text', text: '1' } },
    { id: 'e2', actor: 'agent', item: { kind: 'text', text: '2' } },
    { id: 'e3', actor: 'agent', item: { kind: 'text', text: '3' } },
  ];

  view.setState({ entries, unread: 2 });
  view.open();
  assert.equal(attempts.length, 1, '打开时应对最早未读条目发一次上报');
  // 同一批状态更新连续到达时（还在上报中）不能对同一条并发重发
  view.setState({ typing: true });
  assert.equal(attempts.length, 1, '上报未完成前不得重复调用');
  await tick();

  view.setState({ typing: false });
  assert.equal(attempts.length, 2, 'reject 之后必须重试');
  await tick();

  mode = 'false';
  view.setState({ typing: true });
  assert.equal(attempts.length, 3, '返回 false 同样算失败，也要重试');
  await tick();

  mode = 'ok';
  view.setState({ typing: false });
  assert.equal(attempts.length, 4, '没确认成功就一直重试');
  await tick();

  view.setState({ typing: true });
  view.open();
  assert.equal(attempts.length, 4, '确认成功后同一条不再重复上报');
  assert.deepEqual(attempts, ['e2', 'e2', 'e2', 'e2']);

  view.destroy();
});

await t('reset() 清空已读去重：换 Agent / 登出后同一条可以重新上报', async () => {
  const h = createHarness({ debug: false });
  const attempts = [];
  const view = createCasualView({
    document: h.doc,
    onMarkRead: (id) => {
      attempts.push(id);
      return Promise.resolve(true);
    },
  });

  const entries = [
    { id: 'e1', actor: 'user', item: { kind: 'text', text: '1' } },
    { id: 'e2', actor: 'agent', item: { kind: 'text', text: '2' } },
    { id: 'e3', actor: 'agent', item: { kind: 'text', text: '3' } },
  ];

  view.setState({ entries, unread: 2 });
  view.open();
  await tick();
  assert.deepEqual(attempts, ['e2'], '成功上报一次');

  view.open();
  assert.deepEqual(attempts, ['e2'], '同一条不应重复上报');

  view.reset();
  view.open();
  assert.deepEqual(attempts, ['e2', 'e2'], 'reset 之后旧 id 不能继续挡着');

  view.destroy();
});

/* =========================================================================
 * 13. 草稿清理
 * ========================================================================= */
await t('reset() 清空输入框草稿，close() 不动草稿（同一对象重开要保留）', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const inputEl = root.querySelector('.casual-input');

  view.open();
  inputEl.value = '写了一半的话';

  view.close();
  view.open();
  assert.equal(inputEl.value, '写了一半的话', '同一个助手的草稿关掉再打开应该还在');

  view.reset();
  assert.equal(inputEl.value, '', 'reset() 必须清空草稿');

  view.destroy();
});

/* =========================================================================
 * 14. 空态
 * ========================================================================= */
await t('空历史且加载结束时展示空态文案，加载中 / 有条目时都不展示', () => {
  const h = createHarness({ debug: false });
  const view = createCasualView({ document: h.doc });

  const root = h.doc.body.querySelector('.casual-view');
  const emptyEl = root.querySelector('.casual-empty');
  assert.ok(emptyEl, '视图里应有空态节点');
  assert.equal(emptyEl.hidden, true, '数据还没到时不展示');

  view.setState({ loading: true, entries: [] });
  assert.equal(emptyEl.hidden, true, '加载中交给骨架屏，不出空态');
  assert.equal(root.querySelector('.casual-skeleton').hidden, false, '加载中骨架屏应可见');

  view.setState({ loading: false, entries: [] });
  assert.equal(emptyEl.hidden, false, '加载结束且没有条目时应展示空态');
  assert.match(emptyEl.textContent, /还没有消息/);

  view.setState({
    loading: false,
    entries: [{ id: 'e1', actor: 'agent', item: { kind: 'text', text: '1' } }],
  });
  assert.equal(emptyEl.hidden, true, '有条目后空态隐藏');

  view.destroy();
});

/* =========================================================================
 * 总结判定
 * ========================================================================= */
if (bad > 0) {
  console.error(`\nFAILED (${bad} tests failed)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
