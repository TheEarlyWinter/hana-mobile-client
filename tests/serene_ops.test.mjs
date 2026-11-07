/* tests/serene_ops.test.mjs
 *
 * 沉静视图的「逐条操作流水」：工具行要写出人话（用完了 Get-ChildItem …），
 * 失败要标出来，折叠时只露最后一条，而经典视图一个字都不许变。
 *
 * 用真 renderer + 真 router + 假 DOM（与 turn_segment.test.mjs 同一套写法），
 * 这样 tool_start 的 args 是从事件路由一路走到 DOM 的，而不是在渲染器里手动喂。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
const { createChatRenderer } = await import('../web/chat-renderer.js');
const { createEventRouter } = await import('../web/event-router.js');
const { createStreamState } = await import('../web/stream-state.js');
const { sereneSummary } = await import('../web/turn-summary.js');
const { describeToolOp } = await import('../web/tool-ops.js');

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

/** 起一条聊天链路：真 renderer + 真 router，只把 DOM / socket / 历史容器换成夹具。 */
function boot({ viewMode = 'serene' } = {}) {
  const transcript = h.getEl('transcript');
  transcript.children.length = 0;

  const state = {
    session: { sessionId: 's-ops', path: 'C:/sessions/ops' },
    agentName: '小鲸鱼',
    userName: '你',
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
    busy: false,
    turnStart: 0,
    firstTokenMs: 0,
    charCount: 0,
    speed: 0,
  };

  const renderer = createChatRenderer({
    state,
    getElement: (id) => h.getEl(id),
    getHistoryView: () => null,
    cardController: { render: () => h.makeNode('div') },
    fileUrls: { forFile: async () => ({ readUrl: null, downloadUrl: null }) },
    paintAvatar: () => {},
    agentAvatarUrlById: () => '',
    userAvatarUrl: () => '',
    flash: () => {},
    onBusyChange: () => {},
    formatSereneSummary: sereneSummary,
  });
  renderer.setViewMode(viewMode);

  const router = createEventRouter({
    state,
    getElement: (id) => h.getEl(id),
    renderer,
    sockets: { requestContextUsage() {} },
    cardBridge: null,
    streamState: createStreamState(),
    flash: () => {},
    setBusy: () => {},
    loadSessions: async () => {},
    loadHistory: async () => {},
    chatSubtitle: () => '',
    debug: false,
  });

  const meta = () => transcript.querySelector('.turn-meta');
  const rows = () => transcript.querySelectorAll('.meta-tool');
  const rowAt = (i) => rows()[i] || null;
  const summaryText = () => {
    const m = meta();
    if (!m || m.hidden) return '';
    const s = m.querySelector('summary');
    return s ? s.textContent : '';
  };

  return {
    state,
    renderer,
    send: (ev) => router.handleEvent(ev),
    transcript,
    meta,
    rows,
    rowAt,
    summaryText,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 行里真的写出入参                                                  */
/* ------------------------------------------------------------------ */

t('exec：tool_start 的 command 落到 .op-arg，data-kind=exec', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'c1', name: 'Bash', args: { command: 'Get-ChildItem C:\\Users\\x' } });

  const row = c.rowAt(0);
  assert.ok(row, '应当画出一行工具');
  assert.equal(row.dataset.kind, 'exec', `kind 应为 exec，实际 ${row.dataset.kind}`);
  const arg = row.querySelector('.op-arg');
  assert.ok(arg, 'exec 行要有 .op-arg');
  assert.ok(
    arg.textContent.includes('Get-ChildItem C:\\Users\\x'),
    `参数没画出来，实际：${arg.textContent}`,
  );
  // 经典视图依赖的两个 class 必须还在
  assert.equal(row.querySelector('.name').textContent, 'Bash');
  assert.equal(row.querySelector('.state').textContent, '运行中');
  assert.equal(row.dataset.ok, '', '运行中的行 data-ok 应为空');
});

t('read：file_path 落到 .op-arg，data-kind=read', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'c2', name: 'read', args: { file_path: 'web/app.js' } });

  const row = c.rowAt(0);
  assert.equal(row.dataset.kind, 'read');
  const arg = row.querySelector('.op-arg');
  assert.ok(arg && arg.textContent.includes('web/app.js'), `参数没画出来：${arg && arg.textContent}`);
  assert.equal(row.querySelector('.op-verb').textContent, '正在翻');
});

t('没有 args 的老形状不崩：行还在，只是不画 .op-arg', () => {
  const c = boot();
  c.send({ type: 'tool_start', toolName: 'grep', toolCallId: 'c3' });

  const row = c.rowAt(0);
  assert.ok(row, '缺 args 也要有行');
  assert.equal(row.dataset.kind, 'search');
  assert.equal(row.querySelector('.op-arg'), null, '没参数就不该有空 .op-arg');
  assert.equal(row.querySelector('.op-verb').textContent, '正在找');
});

/* ------------------------------------------------------------------ */
/* 2. 收尾：动词与勾叉                                                  */
/* ------------------------------------------------------------------ */

t('运行中用「正在…」，成功后变「用完了」+ ✓ + data-ok=true', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'c4', name: 'Bash', args: { command: 'ls' } });

  let row = c.rowAt(0);
  assert.equal(row.querySelector('.op-verb').textContent, '正在用电脑');
  assert.equal(row.querySelector('.op-mark').textContent, '');

  c.send({ type: 'tool_end', id: 'c4', name: 'Bash', success: true, status: 'success' });

  row = c.rowAt(0);
  assert.equal(row.querySelector('.op-verb').textContent, '用完了', '收尾后动词要换成完成式');
  assert.equal(row.querySelector('.op-mark').textContent, '✓');
  assert.equal(row.dataset.ok, 'true');
  assert.equal(row.classList.contains('done'), true);
  assert.equal(row.querySelector('.state').textContent, '完成');
  assert.equal(row.classList.contains('failed'), false);
});

t('失败：宿主只说 success:false 也要标出来（✗ / failed / 未成功）', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'c5', name: 'edit', args: { file_path: 'web/md.js' } });
  c.send({ type: 'tool_start', id: 'c6', name: 'read', args: { file_path: 'web/app.js' } });
  // 既没有 error 也没有 status，只有 success:false
  c.send({ type: 'tool_end', id: 'c5', name: 'edit', success: false });

  const row = c.rowAt(0);
  assert.equal(row.dataset.ok, 'false');
  assert.equal(row.querySelector('.op-mark').textContent, '✗');
  assert.equal(row.classList.contains('failed'), true);
  assert.equal(row.classList.contains('done'), true);
  assert.equal(row.querySelector('.state').textContent, '失败');
  assert.equal(row.querySelector('.op-verb').textContent, '没改成', '失败不能用完成式动词');

  const text = c.summaryText();
  assert.ok(text.includes('2 项操作'), `操作数不该因失败减少，实际：${text}`);
  assert.ok(text.includes('1 项未成功'), `失败要记进摘要，实际：${text}`);
});

t('失败：status:failed 的老判据仍然算失败', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'c7', name: 'read', args: { file_path: 'a.js' } });
  c.send({ type: 'tool_end', id: 'c7', name: 'read', status: 'failed' });

  const row = c.rowAt(0);
  assert.equal(row.dataset.ok, 'false');
  assert.equal(row.querySelector('.op-mark').textContent, '✗');
  assert.ok(c.summaryText().includes('1 项未成功'));
});

/* ------------------------------------------------------------------ */
/* 3. 折叠：只露最后一条                                                */
/* ------------------------------------------------------------------ */

t('沉静：.meta-tool.last 只出现在最后一行', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'a1', name: 'read', args: { file_path: 'a.js' } });
  c.send({ type: 'tool_start', id: 'a2', name: 'grep', args: { pattern: 'TODO' } });
  c.send({ type: 'tool_start', id: 'a3', name: 'Bash', args: { command: 'npm test' } });

  const rows = c.rows();
  assert.equal(rows.length, 3);
  const marked = rows.filter((row) => row.classList.contains('last'));
  assert.equal(marked.length, 1, `只该有一行带 last，实际 ${marked.length} 行`);
  assert.equal(marked[0], rows[2], 'last 要落在最后一行');

  // 收尾重画之后仍然只有最后一行带 last（旧的要摘掉）
  c.send({ type: 'tool_end', id: 'a1', name: 'read', success: true });
  const after = c.rows().filter((row) => row.classList.contains('last'));
  assert.equal(after.length, 1, `重画后仍然只该有一行带 last，实际 ${after.length} 行`);
  assert.equal(after[0], c.rows()[2]);
});

t('沉静：.turn-meta 默认带 collapsed，点 summary 切换，切经典时摘掉', () => {
  const c = boot();
  c.send({ type: 'tool_start', id: 'b1', name: 'Bash', args: { command: 'ls' } });

  const meta = c.meta();
  assert.ok(meta, '应当有摘要行');
  assert.ok(meta.classList.contains('collapsed'), '沉静模式默认收着');

  const summary = meta.querySelector('summary');
  summary.dispatchEvent('click');
  assert.equal(meta.classList.contains('collapsed'), false, '点一下应展开');
  summary.dispatchEvent('click');
  assert.equal(meta.classList.contains('collapsed'), true, '再点一下应收起');

  c.renderer.setViewMode('classic');
  assert.equal(meta.classList.contains('collapsed'), false, '切到经典不应留着 collapsed');
  // 经典模式点 summary 交给原生 details：这里不该再改 class
  summary.dispatchEvent('click');
  assert.equal(meta.classList.contains('collapsed'), false);

  c.renderer.setViewMode('serene');
  assert.equal(meta.classList.contains('collapsed'), true, '切回沉静要补回 collapsed');
});

t('折叠绑定是幂等的：同一行重复 ensureMeta 不会一次点击连开连关', () => {
  const c = boot();
  // 同一轮里连着两次工具：ensureMeta 被复用两次，绑定不该叠加
  c.send({ type: 'tool_start', id: 'd1', name: 'Bash', args: { command: 'ls' } });
  c.send({ type: 'tool_start', id: 'd2', name: 'Bash', args: { command: 'pwd' } });

  const meta = c.meta();
  meta.querySelector('summary').dispatchEvent('click');
  assert.equal(meta.classList.contains('collapsed'), false, '一次点击只该翻一次');
});

/* ------------------------------------------------------------------ */
/* 4. 经典视图回归                                                      */
/* ------------------------------------------------------------------ */

t('经典：摘要仍是「工具名 ×次数」，参数不许漏进 summary', () => {
  const c = boot({ viewMode: 'classic' });
  c.send({ type: 'tool_start', id: 'e1', name: 'read', args: { file_path: 'web/app.js' } });
  c.send({ type: 'tool_start', id: 'e2', name: 'read', args: { file_path: 'web/md.js' } });

  const text = c.summaryText();
  assert.ok(text.includes('read'), `经典视图要保留工具名，实际：${text}`);
  assert.ok(text.includes('×2'), `同名工具要带次数，实际：${text}`);
  assert.ok(!text.includes('web/app.js'), `参数不该出现在 summary 里，实际：${text}`);
  assert.ok(!text.includes('项操作'), `经典视图不该用计数摘要，实际：${text}`);
  assert.equal(c.meta().classList.contains('collapsed'), false, '经典视图不该折叠');
  // 参数仍然在行里（只是不在 summary 上）
  assert.ok(c.rowAt(0).querySelector('.op-arg').textContent.includes('web/app.js'));
});

/* ------------------------------------------------------------------ */
/* 5. 翻译器本身                                                        */
/* ------------------------------------------------------------------ */

t('describeToolOp：带 app 前缀与尾部 hash 的名字也能认', () => {
  const raw = 'app__twinkstar_web_access__twinkstar_web_access_bro_006a28b90908';
  const args = { query: 'hana 手机端' };
  const snapshot = JSON.stringify(args);
  const op = describeToolOp(raw, args);

  assert.equal(op.kind, 'web', `应认成 web，实际 ${op.kind}`);
  assert.equal(op.argText, 'hana 手机端');
  assert.equal(JSON.stringify(args), snapshot, '不许改动入参');

  assert.equal(describeToolOp('exec_command', { cmd: 'dir' }).kind, 'exec');
  assert.equal(describeToolOp('ls', { path: 'web' }).kind, 'read');
  assert.equal(describeToolOp('grep', { pattern: 'TODO' }).kind, 'search');
  assert.equal(describeToolOp('web_fetch', { url: 'https://example.com' }).kind, 'web');
  assert.equal(describeToolOp('show_card', {}).kind, 'card');
  assert.equal(describeToolOp('subagent', {}).kind, 'subagent');
  assert.equal(describeToolOp('whatever_tool', {}).kind, 'other');
});

t('describeToolOp：对象值转成单行 JSON，长文本不在 JS 里截断', () => {
  const objOp = describeToolOp('read', { file_path: { a: 1, b: [2, 3] } });
  assert.equal(objOp.argText, '{"a":1,"b":[2,3]}', `对象要单行化，实际：${objOp.argText}`);

  const long = 'x'.repeat(5000);
  const longOp = describeToolOp('Bash', { command: long });
  assert.equal(longOp.argText.length, 5000, '截断交给 CSS，JS 不许动长度');

  const multi = describeToolOp('Bash', { command: 'git add .\n  git commit -m "x"\t' });
  assert.equal(multi.argText, 'git add . git commit -m "x"', '换行要摊平');
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
