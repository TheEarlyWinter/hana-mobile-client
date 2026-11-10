/* tests/search_jump_assembly.test.mjs — 搜索定位的**装配层**用例（I3-1）
 *
 * 为什么单独一个文件：`tests/search_jump.test.mjs` 的 38 例全是模块级（注入假容器、假时钟、
 * 假 loadOlder），它们绿了也证明不了真机那条链是通的。真机出过两次事故，两次都在装配层：
 *   1. finder 少包一层容器 —— 模块要 `(query) => Element`，渲染器给的是
 *      `(container, query) => Element`，少包一层就把 query 当容器，永远返回 null；
 *   2. 定位早于首屏 —— 历史还没上屏就开始按文本找，空扫描被当成「没有更多历史」。
 * 所以这里只做两件事：
 *   A. 用**真 web/app.js + 真搜索面板**跑「搜到一条 → 点结果 → openSession → 首屏 → 高亮出现」，
 *      不直接调 findTurnByText、不手动拼 locate 参数（`locateQuery`/`locateSnippet`/`messageCount`
 *      是 features/search.js 交给 app 装配段的那几个字段，只有走真入口才验证得到）；
 *   B. 用**真 chat-panel + 真渲染器 + 真 search-jump**跑首屏未就绪的时序（waitForTranscript 链）。
 *
 * B 为什么不从 app.js 走：`#transcript` 的第一个子节点是历史控制带
 * （history-pagination-view 的 ensureBar 在每次 setState 时插），而 waitForTranscript 的判据是
 * `children.length > 0`——装配到 app 之后这条等待几乎立刻返回（去掉它用例也不会红），走 app.js
 * 造不出「空区等待」这个状态。这是装配层的一个已知缺口，不在这批用例的修复范围，
 * 所以等待行为在装配单元上钉，入口链在 A 组钉。
 *
 * 纪律：所有用例登记在跑测循环之前；不引依赖；改生产代码只为反例验证，验完必须还原。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { createChatPanel } from '../web/chat-panel.js';
import { createRendererState } from '../web/renderer-state.js';

const h = createHarness();

/* ------------------------------------------------------------------ */
/* 宿主夹具：一个路由化的 fetch，形状照 history-pager 的契约           */
/* ------------------------------------------------------------------ */

const SID = 'sess-report';
const PATH = 'C:/sessions/report';
const QUERY = '季度报告';

/** user 消息：content 直接是字符串。 */
function asUser(id, text) {
  return { id: String(id), role: 'user', content: text, timestamp: '2026-11-01T10:00:00.000Z' };
}

/** assistant 消息：content 是块数组（宿主历史里的常态）。 */
function asAssistant(id, text) {
  return {
    id: String(id),
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: '2026-11-01T10:01:00.000Z',
  };
}

/**
 * 宿主行为。
 *   page：下一次 `/api/sessions/messages`（不带 before）返回哪一页；
 *   older：带 before= 时返回哪一页（null 表示「没有更早的了」）；
 *   result：`/api/sessions/search` 给的那条命中（两种 phase 给同一份）。
 */
const host = {
  page: { messages: [], blocks: [], hasMore: false },
  older: null,
  result: null,
  requests: [],
};

h.setFetch(async (url) => {
  const raw = String(url);
  const path = raw.split('?')[0];
  host.requests.push(raw);

  if (path === '/api/web-auth/session') {
    return h.jsonRes({ authenticated: true, principal: { id: 'user-1', name: 'qa' } });
  }
  if (path === '/api/mobile/bootstrap') {
    return h.jsonRes({
      agents: [{ id: 'agent-1', name: 'Hana', isPrimary: true }],
      userName: 'qa',
      homeFolder: 'C:/work/workspace',
    });
  }
  if (path === '/api/sessions') return h.jsonRes([]);
  if (path === '/api/sessions/search') {
    // phase=title 只出一条（不足 5 条会让 search.js 再扫一次 content），两份给同一份命中即可。
    return h.jsonRes({ results: host.result ? [host.result] : [] });
  }
  if (path === '/api/sessions/messages') {
    if (/[?&]before=\d+/.test(raw)) {
      if (!host.older) return h.jsonRes({ messages: [], blocks: [], hasMore: false });
      return h.jsonRes(host.older);
    }
    return h.jsonRes(host.page);
  }

  // 与本用例无关的启动/侧边请求（偏好、头像、闲聊角标、会话摘要、模型列表）：
  // 给一个空对象就够，它们的失败不影响搜索定位这条链。
  return h.jsonRes({});
});

const hana = await h.loadApp();
const S = hana.S;
await h.waitFor(() => S.currentAgent, 'boot 完成');

/* ------------------------------------------------------------------ */
/* 观察助手                                                            */
/* ------------------------------------------------------------------ */

const transcript = () => h.getEl('transcript');

/** 消息区里的轮次（渲染器给每条消息挂 .turn；历史控制带不是轮次）。 */
const turns = () => transcript().children.filter((n) => /(^|\s)turn(\s|$)/.test(String(n.className || '')));

/** 当前带高亮的轮次：定位成功唯一稳定的外部迹象。 */
const highlighted = () => turns().filter((n) => n.classList.contains('search-hit-flash'));

const flashText = () => h.textOf(h.getEl('flashBar'));

/**
 * 走真实入口：点头部搜索按钮 → 输入词 → 等结果 → 点第一条。
 * 不调 feature.search，也不直接 openSession：要验的就是面板把 locateQuery / snippet /
 * matchKind / messageCount 交给 app 装配段、再由装配段转给定位模块这条链。
 *
 * 等的是「含这一条标题的结果」而不是「列表非空」：重开面板时上一轮的列表还在 DOM 里
 * （executeSearch 要等 150ms 防抖才清空），按非空判断会点到上一轮的结果。
 */
async function searchAndPick(query, expectTitle) {
  const holder = h.getEl('homeHeadActions');
  const btn = h.findAll(holder, '#btnSearch')[0];
  assert.ok(btn, '夹具：搜索入口按钮应该挂在头部（features/search.js 的 mount）');
  btn.click();

  const input = h.doc.querySelector('.message-search-input');
  assert.ok(input, '夹具：搜索面板应该已打开');
  input.value = query;
  input.dispatchEvent('input');

  await h.waitFor(
    () => h.doc.querySelectorAll('.message-search-item').some((li) => h.textOf(li).includes(expectTitle)),
    `搜索结果出现（${expectTitle}）`,
  );
  const item = h.doc.querySelectorAll('.message-search-item')
    .find((li) => h.textOf(li).includes(expectTitle));
  item.click();
}

/* ------------------------------------------------------------------ */
/* 用例登记                                                            */
/* ------------------------------------------------------------------ */

const cases = [];
function test(name, run) {
  cases.push({ name, run });
}

/* ------------------------- A. 真机入口全链路 ------------------------- */

test('A1 真实入口：搜索点一条结果 → 打开会话 → 高亮落在正文命中那一轮', async () => {
  // 真机现象：点搜索结果后停在会话底部、什么都不闪（finder 少包一层容器时永远 null），
  // 用户以为搜索坏了。这里从搜索面板点进去，中间不碰 findTurnByText。
  host.result = {
    path: PATH,
    sessionId: SID,
    title: '季度经营复盘',
    snippet: '...季度报告的结论是收入同比增长 12%...',
    matchKind: 'content',
    messageCount: 2,
    agentId: 'agent-1',
  };
  host.older = null;
  host.page = {
    messages: [
      asUser(1, '帮我看下上个季度的经营情况'),
      asAssistant(2, '季度报告的结论是收入同比增长 12%，毛利率回升。'),
    ],
    blocks: [],
    hasMore: false,
  };

  await searchAndPick(QUERY, '季度经营复盘');

  await h.waitFor(() => highlighted().length === 1, '定位后应出现高亮（实际没找到落点）');
  const hit = highlighted()[0];
  const all = turns();
  assert.equal(all.length, 2, `夹具：首屏应渲染出两轮，实际 ${all.length}`);
  assert.equal(hit, all[1], '高亮应落在含搜索词的 assistant 轮，而不是第一轮');
  assert.ok(h.textOf(hit).includes(QUERY), `落点正文应含搜索词，实际：${h.textOf(hit)}`);
  assert.equal(
    all[0].classList.contains('search-hit-flash'),
    false,
    '没命中的轮次不能带高亮',
  );
  assert.equal(S.session?.path, PATH, '装配段应把搜索结果里的会话打开');
  const history = host.requests.filter((u) => u.includes('/api/sessions/messages'));
  assert.ok(history.length > 0, '装配段应发出历史请求（真的走了 openSession）');
  assert.ok(
    history[0].includes(`sessionId=${SID}`) && history[0].includes('path='),
    `历史请求要带 opensession 拿到的会话身份，实际：${history[0]}`,
  );
});

test('A2 首屏只给一页：定位自己翻出来的更早历史落地后照样命中', async () => {
  // 真机现象：命中在很久以前的轮次里，首屏那一页没有它；以前空扫描一次就报「没找到」。
  // 这里锁的是「每次循环都重新扫当前 #transcript」——历史由真 pager prepend 上屏之后，
  // 绑定在容器上的 finder 才看得见它。
  host.result = {
    path: PATH,
    sessionId: SID,
    title: '很久以前的季度复盘',
    snippet: '...季度报告的结论...',
    matchKind: 'content',
    messageCount: 200,
    agentId: 'agent-1',
  };
  host.page = {
    messages: [asUser(41, '最新的一条消息'), asAssistant(42, '收到，我看看')],
    blocks: [],
    hasMore: true,
  };
  host.older = {
    messages: [asAssistant(21, '更早的结论：季度报告显示收入增长，毛利率回升。')],
    blocks: [],
    hasMore: false,
  };

  const before = host.requests.filter((u) => u.includes('before=')).length;
  await searchAndPick(QUERY, '很久以前的季度复盘');

  await h.waitFor(() => highlighted().length === 1, '翻到更早一页后应命中并高亮');
  const hit = highlighted()[0];
  assert.ok(h.textOf(hit).includes('更早的结论'), `落点应是更早页里的那一轮，实际：${h.textOf(hit)}`);
  const older = host.requests.filter((u) => u.includes('before='));
  assert.equal(older.length, before + 1, '定位应该恰好往前翻一页（命中即停）');
  assert.ok(/before=41\b/.test(older[older.length - 1]), `翻页游标应是首屏最早一条，实际：${older.slice(-1)}`);
});

test('A3 正文里没有落点（标题命中）：滚回会话顶部并给出可见提示', async () => {
  // 真机现象：标题命中但正文没这个词时，定位静默停在底部。装配段必须把 hint 接到 flash，
  // 否则用户看不到任何反馈（模块里那句提示等于丢了）。
  host.result = {
    path: PATH,
    sessionId: SID,
    title: '标题命中的会话',
    snippet: '',
    matchKind: 'title',
    messageCount: 2,
    agentId: 'agent-1',
  };
  host.older = null;
  host.page = {
    messages: [asUser(1, '先聊聊别的'), asAssistant(2, '好，你说')],
    blocks: [],
    hasMore: false,
  };

  await searchAndPick('季度经营复盘', '标题命中的会话');

  await h.waitFor(
    () => flashText().includes('标题命中，已到会话开头'),
    '标题命中且正文无锚点时应浮出提示',
  );
  // 不断言 scrollTop：首屏贴底的滚动钉（scroll-pin 的 follow）在假 DOM 里会在下一拍
  // 再写一次 scrollTop，跟「滚回顶部」抢；那是滚动实现的事，不是这条装配链的契约。
  assert.equal(highlighted().length, 0, '没有任何命中时不能乱高亮');
});

/* ------------------ B. 首屏未就绪：waitForTranscript 链 ------------------ */

/** 装配一份聊天区：真渲染器 + 真 search-jump，只有「翻页」和「复制」换成桩。 */
function bootPanel() {
  const transcriptEl = h.getEl('transcript');
  transcriptEl.innerHTML = '';
  transcriptEl.scrollTop = 0;

  const historyView = {
    append: (node) => transcriptEl.appendChild(node),
    isPrepending: () => false,
  };
  const calls = { loadOlder: 0 };

  const panel = createChatPanel({
    document: h.doc,
    getElement: (id) => h.getEl(id),
    rendererState: createRendererState(),
    appState: { session: { sessionId: SID, path: PATH, agentName: 'Hana' }, userName: 'qa', agentName: 'Hana' },
    getHistoryView: () => historyView,
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    avatars: { paint: () => {}, agentUrlById: () => '', userUrl: () => '' },
    flash: () => {},
    onBusyChange: () => {},
    copyText: async () => ({ ok: true }),
    loadOlder: async () => {
      calls.loadOlder += 1;
      return false;   // 首屏之外没有更早的：早期定位只能靠「等历史落地」
    },
  });

  return { transcriptEl, historyView, calls, panel };
}

/** 历史一页落地：这就是 conversation-controller.renderHistoryPage 里那三行。 */
function landHistory(panel, entries) {
  panel.renderer.beginHistoryPage();
  for (const entry of entries) panel.renderer.renderEntry(entry);
  panel.renderer.endHistoryPage();
}

test('B1 首屏还空就排好了定位：历史落地后仍然命中，且空等期间不翻页', async () => {
  // 真机现象：openSession 的 Promise 回来时 #transcript 还差一帧，定位拿到一次空扫描，
  // 又被当成「没有更多历史」。这里复刻 app.js 那条链：opened.then(waitForTranscript).then(locate)。
  const { panel, calls } = bootPanel();

  const opened = Promise.resolve();   // 会话已就绪、首屏内容还没上屏的那一瞬间
  let located = null;
  opened
    .then(panel.waitForTranscript)
    .then(() => panel.searchJump.locate({
      query: QUERY,
      snippet: '...季度报告的结论...',
      matchKind: 'content',
      messageCount: 2,
    }))
    .then((res) => { located = res; });

  // 等两轮 100ms 轮询：这段时间里消息区必须还是空的，定位也不许已经开始翻页。
  await h.delay(250);
  assert.equal(transcript().children.length, 0, '夹具：这段时间消息区应该还是空的');
  assert.equal(calls.loadOlder, 0, '首屏还没上屏就翻页 = 空扫描被当成「没找到」');
  assert.equal(located, null, '历史还没到，定位不该已经有结论');

  // 历史落地（真渲染器画出的两轮，含目标那一轮）。
  landHistory(panel, [asUser(1, '帮我看下上个季度的经营情况'), asAssistant(2, '季度报告的结论是收入同比增长 12%')]);

  await h.waitFor(() => highlighted().length === 1, '历史落地后应命中并高亮');
  assert.equal(h.textOf(highlighted()[0]).includes(QUERY), true, '落点正文应含搜索词');
  await h.waitFor(() => located && located.found === true, '定位结果应为 found');
  assert.equal(located.pagesLoaded, 0, '内容已经在首屏命中，不该再翻页');
  panel.searchJump.dispose();
});

test('B2 首屏一直不来：不永久挂住，定位仍会空跑一次并给出结论', async () => {
  // waitForTranscript 的上限是 2 秒（20 轮）。等满就必须放行，否则用户点完搜索永远没有反馈。
  const { panel, calls } = bootPanel();

  const started = Date.now();
  let located = null;
  Promise.resolve()
    .then(panel.waitForTranscript)
    .then(() => panel.searchJump.locate({ query: QUERY, matchKind: 'content' }))
    .then((res) => { located = res; });

  await h.waitFor(() => located !== null, '等满上限后定位仍应给出结论', 4000);
  assert.ok(Date.now() - started >= 1800, '不该在 2 秒上限之前就放弃等待');
  assert.equal(located.found, false, '屏上什么都没有，结论只能是没找到');
  assert.equal(calls.loadOlder, 1, '放行后仍要走一次「有没有更早的历史」再收场');
  panel.searchJump.dispose();
});

test('B3 只有历史控制带时不算「首屏就绪」：要等到真正的轮次', async () => {
  // 装配到 app 后 #transcript 的第一个子节点是 .history-pagination-bar（pager 发请求前就
  // emitState 插进去），按 children.length 判会立刻返回——真机上这条等待就等于不存在。
  const { panel } = bootPanel();
  const bar = h.doc.createElement('div');
  bar.className = 'history-pagination-bar';
  transcript().appendChild(bar);

  let done = false;
  panel.waitForTranscript().then(() => { done = true; });
  await h.delay(400);
  assert.equal(done, false, '只有控制带不算首屏就绪');

  landHistory(panel, [asUser(1, '帮我看下上个季度的经营情况'), asAssistant(2, '季度报告的结论是收入同比增长 12%')]);
  await h.waitFor(() => done === true, '.turn 上屏后应放行', 2000);
  panel.searchJump.dispose();
});

/* --------------------------- 跑测循环 --------------------------- */

let failed = 0;
for (const item of cases) {
  try {
    await item.run();
    console.log(`PASS  ${item.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${item.name}\n      ${err.stack || err.message}`);
  }
}

console.log(failed === 0 ? `\nALL PASS（${cases.length} 个用例）` : `\nFAILED (${failed} tests failed)`);
process.exit(failed === 0 ? 0 : 1);
