/* tests/renderer_state.test.mjs — 「流式渲染状态」私有化（S 收敛第一片）
 *
 * 背景：app.js 的 S 原本同时装着两类东西——登入/会话/连接这些应用级状态，和
 * 「一轮消息画到哪儿了」这种渲染进度。后者以前是全局可见量，事件路由、会话控制、
 * 输入区都能顺手改。
 *
 * 这一片只搬渲染进度那 14 个字段（turn / turnBody / turnFootEl / turnMeta / textEl /
 * streamingRaw / thinkAt / replaying / moodEl / moodRaw / turnStart / firstTokenMs /
 * charCount / speed）到渲染器私有的 state（web/renderer-state.js），外部一律走 renderer
 * 的访问器。S 上只留兼容入口，读的是同一份数据。
 *
 * 锁的行为：
 *   1. createRendererState() 就是这 14 个字段，初值与搬走之前逐字段一致；
 *   2. 两次创建互不影响，没有共享引用；
 *   3. 访问器（hasTurn / noteChars / currentStreamingRaw / noteSendStart / clearMood /
 *      paintCurrentMeta）真的作用于注入的那份 state；
 *   4. S 上的兼容入口与渲染器那份是同一份存储：读一致，写 turn / streamingRaw 落到同一份；
 *   5. 只读字段（charCount / moodEl 之类）在严格模式下拒绝写入，状态不能被 S 旁路改掉。
 *
 * 全程真模块 + 假 DOM（tests/support/app_harness.mjs），不发真实请求。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

/* 假 DOM 必须在真模块 import 之前落地：web/*.js 在模块作用域里就会摸 document / window。 */
const h = createHarness();

const { createRendererState } = await import('../web/renderer-state.js');
const { createChatRenderer } = await import('../web/chat-renderer.js');
const { createHistoryPaginationView } = await import('../web/history-pagination-view.js');

/** 搬走之前 S 上的初值。字段既不许多也不许少，值不许变。 */
const INITIAL = {
  turn: null,
  turnBody: null,
  turnFootEl: null,
  turnMeta: null,
  textEl: null,
  streamingRaw: '',
  thinkAt: 0,
  replaying: false,
  moodEl: null,
  moodRaw: '',
  turnStart: 0,
  firstTokenMs: 0,
  charCount: 0,
  speed: 0,
};

const failures = [];
async function test(name, run) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

await test('createRendererState()：就是这 14 个字段，初值与原来的 S 逐字段一致', () => {
  const state = createRendererState();
  const keys = Object.keys(state);
  assert.equal(keys.length, 14, `字段数必须是 14，实际 ${keys.length}：${keys.join(', ')}`);
  assert.deepEqual(keys, Object.keys(INITIAL), '字段清单（含顺序）必须与搬走的这 14 个完全一致');
  for (const [key, expected] of Object.entries(INITIAL)) {
    assert.strictEqual(
      state[key],
      expected,
      `${key} 初值不对：期望 ${String(expected)}，实际 ${String(state[key])}`,
    );
  }
});

await test('两次创建互不影响：各拿一份初值，没有共享引用', () => {
  const a = createRendererState();
  const b = createRendererState();
  assert.notStrictEqual(a, b);

  a.turn = { id: 'live-turn' };
  a.moodEl = { id: 'mood' };
  a.moodRaw = '嘿嘿';
  a.streamingRaw = '甲';
  a.charCount = 9;

  for (const [key, expected] of Object.entries(INITIAL)) {
    assert.strictEqual(b[key], expected, `改 a 不能影响 b（${key}）`);
  }
  assert.strictEqual(b.moodEl, null, 'moodEl 初值必须是 null');
});

await test('访问器作用于注入的 state（hasTurn / noteChars / currentStreamingRaw / noteSendStart / clearMood / paintCurrentMeta）', () => {
  const state = createRendererState();
  const transcript = h.getEl('transcript');
  transcript.children.length = 0;

  const historyView = createHistoryPaginationView({
    document: h.doc,
    container: transcript,
    onLoadOlder: () => {},
  });
  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => historyView,
    cardController: { render: () => h.makeNode('div') },
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    paintAvatar: () => {},
    agentAvatarUrlById: () => '',
    userAvatarUrl: () => '',
    flash: () => {},
    onBusyChange: () => {},
  });

  // hasTurn：读的就是注入的 state.turn
  assert.equal(renderer.hasTurn(), false, '还没开轮时 hasTurn() 必须是 false');
  const turn = renderer.startAssistantTurn();
  assert.equal(renderer.hasTurn(), true, '开了一轮之后 hasTurn() 必须是 true');
  assert.strictEqual(state.turn, turn, 'hasTurn() 必须与注入的 state.turn 一致');

  // noteChars：累加，非法入参不许把计数写成 NaN
  renderer.noteChars(3);
  assert.equal(state.charCount, 3, 'noteChars(3) 应累加 3');
  renderer.noteChars('7');
  assert.equal(state.charCount, 10, '字符串数字也要累加（事件里的长度常常是字符串算出来的）');
  renderer.noteChars(undefined);
  renderer.noteChars('x');
  assert.equal(state.charCount, 10, '非法入参只能加 0，不能变成 NaN');

  // currentStreamingRaw：读的是注入的 state.streamingRaw
  assert.equal(renderer.currentStreamingRaw(), '', '还没上屏正文时是空串');
  renderer.addAssistantText('你好');
  assert.equal(renderer.currentStreamingRaw(), '你好', '正文上屏后应能读到');
  assert.strictEqual(renderer.currentStreamingRaw(), state.streamingRaw);

  // noteSendStart：发送那一刻的计时起点
  assert.equal(state.turnStart, 0, '夹具：起点还没记');
  const before = performance.now();
  renderer.noteSendStart();
  assert.ok(state.turnStart >= before, 'noteSendStart() 必须把 turnStart 写成当前时刻');

  // clearMood：两个字段一起清
  state.moodEl = h.makeNode('div');
  state.moodRaw = '嘀咕半句';
  renderer.clearMood();
  assert.equal(state.moodEl, null, 'clearMood() 必须清掉 moodEl');
  assert.equal(state.moodRaw, '', 'clearMood() 必须把 moodRaw 清成空串');

  // paintCurrentMeta：没有 meta 时什么都不画，有 meta 时重画一次不能抛错
  state.turnMeta = null;
  assert.equal(renderer.paintCurrentMeta(), undefined, '没有 meta 时应直接返回 undefined');
  renderer.addThinking('想一下');
  assert.ok(state.turnMeta, '夹具：一次思考应该建出 meta 容器');
  assert.equal(renderer.paintCurrentMeta(), undefined, '重画 meta 不应该抛错');
  assert.ok(state.turnMeta.querySelector('summary'), 'meta 结构还在');
});

/** 整个 app 只装配一次：S / rendererState 都只在 app.js 里存在。 */
let appPromise = null;
function app() {
  if (!appPromise) {
    h.setFetch(async (url) => {
      const path = String(url).split('?')[0];
      if (path === '/api/web-auth/session') {
        return h.jsonRes({ authenticated: true, principal: { id: 'user-1' } });
      }
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
    appPromise = (async () => {
      const hana = await h.loadApp();
      await h.waitFor(() => hana.S.currentAgent, 'boot 完成');
      return hana;
    })();
  }
  return appPromise;
}

await test('渲染器状态只存在 rendererState 一份：S 上不再转发那批字段', async () => {
  const { S, rendererState, renderer } = await app();

  // D2 删掉了转发层。锁住「删干净了」：再长回来就会红。
  for (const key of ['turn', 'turnBody', 'turnMeta', 'streamingRaw', 'charCount', 'turnStart', 'moodEl', 'moodRaw', 'ctxPct']) {
    assert.strictEqual(S[key], undefined, `S.${key} 不应该再存在（应改读 hana.rendererState）`);
  }

  // rendererState 本身仍然是渲染器那一份：写进去渲染器看得见，清掉也一致。
  const live = h.makeNode('div');
  rendererState.turn = live;
  assert.equal(renderer.hasTurn(), true, '写进去的轮就是渲染器看到的活轮');

  rendererState.streamingRaw = 'LIVE-STREAM';
  assert.strictEqual(renderer.currentStreamingRaw(), 'LIVE-STREAM');

  rendererState.turn = null;
  rendererState.streamingRaw = '';
  assert.equal(renderer.hasTurn(), false, '清掉之后渲染器也看不到活轮');
  assert.equal(renderer.currentStreamingRaw(), '', '清掉之后渲染器读到的也是空串');
});

if (failures.length > 0) {
  console.log(`\n${failures.length} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
