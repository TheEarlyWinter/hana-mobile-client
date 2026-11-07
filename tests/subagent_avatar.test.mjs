/* tests/subagent_avatar.test.mjs — 子代理（分身）卡片上的执行者头像
 *
 * 卡片（web/subagent-view.js）刻意不 import 任何项目模块，头像地址只能由装配方注入：
 *   createSubagentView({ document, avatarUrlById: (id) => string|null })
 * app.js 手里才有 bootstrap 的 agent 列表（agentAvatarUrlById），它不给，卡片就保持旧样。
 *
 * 这里钉住五件事：
 *   1. 不传 avatarUrlById：卡片结构与旧样一致，一个 <img> 都没有（还是那个「分」徽标）；
 *   2. 传了且返回地址：出 <img class="subagent-avatar">，src 对、alt 空、占旧徽标那一格；
 *   3. 传了但返回 null：出名字首字的占位圆（subagent-avatar-fallback），没有 <img>；
 *   4. block_update 之后才拿到 id：占位就地升级成图片，还是同一张卡、不是新的一张；
 *   5. 只有名字没有 id：用名字兜底，不崩、不空。
 * 另外两条守规矩的：404 就地降级（不留破图、不反复重试同一个地址）、同一个 id 两张卡同一张脸。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 夹具先落地：与其它 web/ 用例一致，document 由夹具提供给注入点。 */
const h = createHarness({ debug: false });

const { createSubagentView } = await import('../web/subagent-view.js');

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
/* 沙盘                                                                */
/* ------------------------------------------------------------------ */

/** 一张干净的沙盘：一个挂卡片的 host + 一个 view（不碰 transcript）。 */
function boot(options = {}) {
  const host = h.makeNode('div');
  host.className = 'turn-body';
  const view = createSubagentView({ document: h.doc, ...options });
  return { host, view };
}

/** 走历史回放的入口，host 显式指定，免得依赖「最近一条助手正文」。 */
const draw = (view, host, block) => view.render({ type: 'subagent', ...block }, { host });

const cardOf = (host, taskId) => host.querySelectorAll('.subagent-card')
  .find((card) => card.dataset.taskId === taskId);

const avatarTextOf = (card) => h.textOf(card.querySelector('.subagent-avatar-fallback') || card).trim();

/* ------------------------------------------------------------------ */
/* 1. 不传依赖 = 旧样                                                   */
/* ------------------------------------------------------------------ */

await t('不传 avatarUrlById：卡片保持旧样，一个 <img> 都不画', () => {
  const { view, host } = boot();
  assert.equal(draw(view, host, {
    taskId: 'x1',
    agentName: '寻迹',
    executorAgentId: 'ag-1',
    streamStatus: 'done',
    summary: '3 个文件受影响',
  }), true, '画出来了就要返回 true');

  const card = cardOf(host, 'x1');
  assert.ok(card, '卡片要画出来');
  assert.equal(card.querySelectorAll('img').length, 0, '没接头像来源就不能出 <img>');
  const badge = card.querySelector('.subagent-card-icon');
  assert.ok(badge, '旧样里的「分」徽标要原样保留');
  assert.equal(h.textOf(badge).trim(), '分');
  assert.equal(card.querySelectorAll('.subagent-avatar').length, 0, '没接就当没有这回事');
  assert.ok(h.textOf(card).includes('寻迹'), '名字照旧在');
});

/* ------------------------------------------------------------------ */
/* 2. 给了地址 = 图片                                                   */
/* ------------------------------------------------------------------ */

await t('给了地址：img.subagent-avatar 带对的 src，alt 为空，占旧徽标那一格', () => {
  const calls = [];
  const { view, host } = boot({
    avatarUrlById: (id) => {
      calls.push(id);
      return id === 'exec-1' ? '/api/agents/exec-1/avatar' : null;
    },
  });

  draw(view, host, {
    taskId: 'x2',
    agentName: 'Luna',
    executorAgentNameSnapshot: 'Luna',
    executorAgentId: 'exec-1',
    requestedAgentId: 'req-1',
    agentId: 'generic-1',
    streamStatus: 'running',
    streamKey: 'C:/sessions/c2',
  });

  const card = cardOf(host, 'x2');
  const img = card.querySelector('img.subagent-avatar');
  assert.ok(img, '给了地址就该画图片');
  assert.equal(img.src, '/api/agents/exec-1/avatar');
  assert.equal(img.alt, '', '头像是装饰性的，alt 必须为空串');
  assert.equal(img.getAttribute('aria-label'), null, '卡片本身已有可读名字，不再给头像 aria-label');
  assert.equal(card.children[0], img, '头像占在旧「分」徽标的位置（第一个孩子）');
  assert.equal(card.querySelector('.subagent-card-icon'), null, '有头像就不该再叠一个旧徽标');
  assert.deepEqual(calls, ['exec-1'], '取 id 的顺序：executorAgentId → requestedAgentId → agentId');
});

/* ------------------------------------------------------------------ */
/* 3. 没地址 = 首字占位                                                 */
/* ------------------------------------------------------------------ */

await t('传了但返回 null：名字首字的占位圆，没有 <img>', () => {
  const { view, host } = boot({ avatarUrlById: () => null });

  draw(view, host, {
    taskId: 'x3',
    agentName: '寻迹',
    executorAgentId: 'unknown-1',
    streamStatus: 'running',
    streamKey: 'C:/sessions/c3',
  });
  const zhCard = cardOf(host, 'x3');
  const fallback = zhCard.querySelector('.subagent-avatar-fallback');
  assert.ok(fallback, '认不出的 id 就用首字占位');
  assert.ok(fallback.classList.contains('subagent-avatar'), '占位圆也要带 subagent-avatar，尺寸与图片一致');
  assert.equal(avatarTextOf(zhCard), '寻', '中文名取第一个字');
  assert.equal(fallback.getAttribute('aria-hidden'), 'true', '占位圆是装饰性的，别让读屏器念一个孤零零的字');
  assert.equal(zhCard.querySelectorAll('img').length, 0, '没地址就不该有 <img>');

  draw(view, host, { taskId: 'x3-en', agentName: 'luna', streamStatus: 'done', summary: '好了' });
  assert.equal(avatarTextOf(cardOf(host, 'x3-en')), 'L', '英文名取首字母并大写');
});

/* ------------------------------------------------------------------ */
/* 4. 补丁后才拿到 id = 就地升级                                        */
/* ------------------------------------------------------------------ */

await t('block_update 补上 id：占位就地升级成图片，整张卡不重建', () => {
  const { view, host } = boot({
    avatarUrlById: (id) => (id === 'exec-9' ? '/api/agents/exec-9/avatar' : null),
  });

  draw(view, host, {
    taskId: 'x4',
    agentName: '寻迹',
    streamStatus: 'running',
    streamKey: 'C:/sessions/c4',
  });
  const card = cardOf(host, 'x4');
  const fallback = card.querySelector('.subagent-avatar-fallback');
  assert.ok(fallback, '补丁来之前只有名字，只能先画首字');
  assert.equal(avatarTextOf(card), '寻');

  view.handleEvent({
    type: 'block_update',
    taskId: 'x4',
    patch: { executorAgentId: 'exec-9', executorAgentNameSnapshot: '寻迹' },
  });

  assert.equal(cardOf(host, 'x4'), card, '改的还是原来那张卡');
  assert.equal(host.querySelectorAll('.subagent-card').length, 1, '不能另起一张卡');
  const img = card.querySelector('img.subagent-avatar');
  assert.ok(img, '拿到 id 与地址后要升级成图片');
  assert.equal(img.src, '/api/agents/exec-9/avatar');
  assert.equal(card.querySelectorAll('.subagent-avatar').length, 1, '一个位置上只能有一个头像节点');
  assert.equal(card.querySelector('.subagent-avatar-fallback'), null, '占位要被换掉，不是叠上去');
  assert.equal(card.querySelector('.subagent-card-name').textContent, '寻迹', '这次升级不该动名字');
});

/* ------------------------------------------------------------------ */
/* 5. 只有名字 = 名字兜底                                               */
/* ------------------------------------------------------------------ */

await t('名字在、id 不在：用名字兜底，不崩也不空', () => {
  const calls = [];
  const { view, host } = boot({
    avatarUrlById: (id) => { calls.push(id); return null; },
  });

  draw(view, host, { taskId: 'x5', requestedAgentNameSnapshot: 'Gemini', streamStatus: 'done', summary: '改完了' });
  const named = cardOf(host, 'x5');
  assert.ok(named, '只有名字也要能画卡');
  assert.equal(avatarTextOf(named), 'G', '英文名首字母大写');
  assert.deepEqual(calls, [], '没有 id 就不该去问头像地址');

  draw(view, host, { taskId: 'x5-empty', streamStatus: 'done' });
  const blank = cardOf(host, 'x5-empty');
  assert.ok(blank, '名字与 id 都没有也要画（旧代码本来就会画）');
  assert.equal(avatarTextOf(blank), '分', '兜底名字是「分身」，首字自然是「分」');

  // 有 id 但装配方不认识这个 agent：首字仍取名字，不拿 id 当名字用
  draw(view, host, { taskId: 'x5-idonly', executorAgentId: 'luna-2', streamStatus: 'done' });
  assert.deepEqual(calls, ['luna-2'], '有 id 就要去问一次');
  assert.equal(avatarTextOf(cardOf(host, 'x5-idonly')), 'L');
});

/* ------------------------------------------------------------------ */
/* 6. 地址坏掉 = 就地降级，不再撞 404                                   */
/* ------------------------------------------------------------------ */

await t('地址 404：就地降级成首字，不留破图，也不反复重试', () => {
  const { view, host } = boot({
    avatarUrlById: (id) => (id === 'exec-bad' ? '/api/agents/exec-bad/avatar' : null),
  });

  draw(view, host, {
    taskId: 'x6',
    agentName: '寻迹',
    executorAgentId: 'exec-bad',
    streamStatus: 'running',
    streamKey: 'C:/sessions/c6',
  });
  const card = cardOf(host, 'x6');
  const img = card.querySelector('img.subagent-avatar');
  assert.ok(img, '先按地址画');
  img.dispatchEvent('error');   // 真浏览器里是 404 / 坏图触发 img.onerror

  assert.equal(card.querySelectorAll('img').length, 0, '加载失败要把 <img> 摘掉，不能让手机上出现破图');
  assert.equal(avatarTextOf(card), '寻');
  assert.equal(card.querySelectorAll('.subagent-avatar').length, 1, '一个位置上只能有一个头像节点');

  view.handleEvent({ type: 'block_update', taskId: 'x6', patch: { streamStatus: 'done', summary: '好了' } });
  assert.equal(card.querySelectorAll('img').length, 0, '已知拿不到的地址不该再拿同一个 URL 去撞');
  assert.ok(card.querySelector('.subagent-avatar-fallback'), '降级后的占位要留住');
});

/* ------------------------------------------------------------------ */
/* 7. 一致性与回调抛错                                                  */
/* ------------------------------------------------------------------ */

await t('同一个 id 在两张卡里长得一样；回调抛错当成没头像', () => {
  const { view, host } = boot({
    avatarUrlById: (id) => (id === 'req-7' ? `/api/agents/${id}/avatar` : null),
  });

  draw(view, host, { taskId: 'x7a', agentName: 'Luna', requestedAgentId: 'req-7', streamStatus: 'running' });
  draw(view, host, { taskId: 'x7b', agentName: 'Luna', executorAgentId: 'req-7', streamStatus: 'done', summary: '好了' });

  const a = cardOf(host, 'x7a').querySelector('img.subagent-avatar');
  const b = cardOf(host, 'x7b').querySelector('img.subagent-avatar');
  assert.ok(a && b, '两张卡都该有头像（requestedAgentId 也是身份）');
  assert.equal(a.src, b.src, '同一个 id 只能是同一张脸');

  const complaints = [];
  const origError = console.error;
  console.error = (...args) => complaints.push(args.join(' '));
  try {
    const broken = boot({ avatarUrlById: () => { throw new Error('bootstrap 还没到'); } });
    assert.equal(
      draw(broken.view, broken.host, { taskId: 'x7c', agentName: 'Luna', executorAgentId: 'req-x', streamStatus: 'running' }),
      true,
      '回调抛错不能把整张卡带崩',
    );
    const card = cardOf(broken.host, 'x7c');
    assert.equal(card.querySelectorAll('img').length, 0, '抛错就当没地址');
    assert.equal(avatarTextOf(card), 'L', '退回首字，卡片照画');
  } finally {
    console.error = origError;
  }
  assert.ok(complaints.length >= 1, '装配方抛错要留下痕迹，别静默吞掉');
});

/* ------------------------------------------------------------------ */
/* 8. 补丁比内容块先到（前台子代理的真实顺序）                          */
/* ------------------------------------------------------------------ */

await t('block_update 先带着 id 到达：卡片一出生就是头像', () => {
  const { view, host } = boot({
    avatarUrlById: (id) => (id === 'exec-8' ? '/api/agents/exec-8/avatar' : null),
  });

  // 补丁先于 tool_end（content_block）到达：带 streamKey 才会先造卡，这里只攒着
  view.handleEvent({
    type: 'block_update',
    taskId: 'x8',
    patch: { executorAgentId: 'exec-8', executorAgentNameSnapshot: 'Luna', streamStatus: 'done', summary: '改完了' },
  });
  assert.equal(host.querySelectorAll('.subagent-card').length, 0, '只有补丁、没有内容块时不该凭空造卡');

  draw(view, host, { taskId: 'x8', agentName: 'Luna', streamStatus: 'running', streamKey: 'C:/sessions/c8' });

  const card = cardOf(host, 'x8');
  const img = card.querySelector('img.subagent-avatar');
  assert.ok(img, '攒着的补丁里的 id 不能丢，卡片要直接画头像');
  assert.equal(img.src, '/api/agents/exec-8/avatar');
  assert.equal(card.dataset.status, 'done', '补丁里的状态也照旧要生效');
});

/* ------------------------------------------------------------------ */

if (bad > 0) {
  console.error(`\n${bad} subagent-avatar test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
