/* 一轮回复的边界：stream_turn_end 是「一段流结束」，不是「这一轮结束」。
 *
 * 2026-11-05 手机实测（logcat 抓的真实事件序）：
 *   thinking_start → thinking_end → tool_start → tool_end → stream_turn_end
 *   thinking_start → thinking_end → tool_start → tool_end → stream_turn_end
 *   tool_start → tool_end → stream_turn_end → …
 * 宿主在每个工具回合后都发一次 stream_turn_end。旧的 event-router 拿它当整轮结束，
 * 于是每个工具回合都新开一条气泡、计数永远停在「1 次思考 · 1 项操作」，
 * 并且每回合都弹一次「回复完成」通知。
 *
 * 真正的一轮起止是 session_status{isStreaming:true|false}。
 *
 * 这里用真 renderer + 真 router，只把 DOM/socket 换成夹具。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';

const h = createHarness();
const { createChatRenderer } = await import('../web/chat-renderer.js');
const { createEventRouter } = await import('../web/event-router.js');
const { createHistoryPaginationView } = await import('../web/history-pagination-view.js');
const { createStreamState } = await import('../web/stream-state.js');
const { sereneSummary } = await import('../web/turn-summary.js');

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

function boot({ viewMode = 'serene' } = {}) {
  const transcript = h.getEl('transcript');
  transcript.children.length = 0;

  const state = {
    session: { sessionId: 's-seg', path: 'C:/sessions/seg' },
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

  const historyView = createHistoryPaginationView({ document: h.doc, container: transcript, onLoadOlder: () => {} });
  const ends = [];
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
    onTurnEnd: (info) => ends.push(info),
    debug: false,
  });

  return {
    state,
    renderer,
    send: (ev) => router.handleEvent(ev),
    ends,
    transcript,
    turns: () => transcript.querySelectorAll('.turn'),
    summary: () => {
      const m = transcript.querySelector('.turn-meta');
      if (!m || m.hidden) return '';
      const s = m.querySelector('summary');
      return s ? s.textContent : '';
    },
  };
}

/** 宿主真实的一段：思考 + 一次工具 + 该段结束。 */
function segment(send, { tool = 'read', callId } = {}) {
  send({ type: 'thinking_start' });
  send({ type: 'thinking_delta', delta: '想一想' });
  send({ type: 'thinking_end' });
  send({ type: 'tool_start', toolName: tool, toolCallId: callId });
  send({ type: 'tool_end', toolName: tool, toolCallId: callId });
  send({ type: 'stream_turn_end' });
}

t('三段工具回合合成一条气泡，计数累加到 3', () => {
  const c = boot();
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c1' });
  segment(c.send, { callId: 'c2' });
  segment(c.send, { callId: 'c3' });

  assert.equal(c.turns().length, 1, `三段只应有一条气泡，实际 ${c.turns().length} 条`);
  assert.equal(c.state.turn !== null, true, 'stream_turn_end 之后这一轮仍然开着');
  const text = c.summary();
  assert.match(text, /3 次思考/, `思考应累计为 3，实际：${text}`);
  assert.match(text, /3 项操作/, `操作应累计为 3，实际：${text}`);
  assert.match(text, /正在进行/, '整轮还没结束，应带「正在进行」');
  assert.equal(c.ends.length, 0, 'stream_turn_end 不能触发「一轮结束」通知');
});

t('session_status isStreaming:false 才收尾：摘要去掉「正在进行」，通知只发一次', () => {
  const c = boot();
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c1' });
  segment(c.send, { callId: 'c2' });
  c.send({ type: 'session_status', isStreaming: false });

  assert.equal(c.ends.length, 1, `整轮结束只应通知一次，实际 ${c.ends.length} 次`);
  assert.equal(c.state.turn, null, '收尾后本轮游标要清空');
  const text = c.summary();
  assert.match(text, /2 次思考/, `实际：${text}`);
  assert.match(text, /2 项操作/, `实际：${text}`);
  assert.ok(!text.includes('正在进行'), `收尾后不该再有「正在进行」，实际：${text}`);
});

t('下一轮从新气泡开始，不并到上一轮里', () => {
  const c = boot();
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c1' });
  c.send({ type: 'session_status', isStreaming: false });

  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c2' });

  assert.equal(c.turns().length, 2, `两轮应有两条气泡，实际 ${c.turns().length} 条`);
});

t('兜底：上一轮没收到 false 就开新流，旧轮先收掉，不并成一条', () => {
  const c = boot();
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c1' });
  // 宿主异常：没有 isStreaming:false，直接开下一轮
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c2' });

  assert.equal(c.turns().length, 2, `旧轮必须先收尾，实际 ${c.turns().length} 条气泡`);
  assert.equal(c.ends.length, 1, '旧轮收尾应产生一次通知');
});

t('经典视图：思考时长跨段累加，不只报最后一段', () => {
  const c = boot({ viewMode: 'classic' });
  c.send({ type: 'session_status', isStreaming: true });
  segment(c.send, { callId: 'c1' });
  segment(c.send, { callId: 'c2' });

  const text = c.summary();
  // 夹具里 performance.now() 基本不动，所以这里只钉「出现时长文案 + 工具名」，
  // 不钉具体秒数；累加逻辑由 chat_renderer_serene 的单元用例覆盖。
  assert.match(text, /思考/, `经典视图应报时长，实际：${text}`);
  assert.match(text, /read/, `经典视图应列工具名，实际：${text}`);
  assert.match(text, /×2/, `两次同名工具应合并计数，实际：${text}`);
});

if (bad) {
  console.log(`\n${bad} 个用例失败`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
