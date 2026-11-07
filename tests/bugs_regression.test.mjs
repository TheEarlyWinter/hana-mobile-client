/* 四项已审查缺陷回归测试
 *
 * 缺陷 1: updateHeroCompanion 中 avatarUrl/name 插 innerHTML，改为 createElement img 属性赋值避免 DOM XSS
 * 缺陷 2: api 的 15 秒计时器需覆盖 res.text 读取完成
 * 缺陷 3: tool_start/end 以 toolCallId/id 匹配以支持交错结束；有 callId 找不到对应项时不应错误标记其他工具，仅缺 ID 时回退
 * 缺陷 4: 续流事件游标未更新 / 切会话未清理 / 重复回放去重 / 新 stream 独立序列 / 不可凭空推断 nextSeq
 */

import assert from 'node:assert/strict';

// 准备极简 DOM 与浏览器全局环境
const elements = {};
function makeEl(tag = 'div', id = '') {
  let innerHtmlVal = '';
  const node = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    listeners: {},
    children: [],
    style: {},
    dataset: {},
    classList: {
      add(cls) {
        const current = (node.className || '').split(/\s+/).filter(Boolean);
        if (!current.includes(cls)) current.push(cls);
        node.className = current.join(' ');
      },
      remove(cls) {
        const current = (node.className || '').split(/\s+/).filter((c) => c && c !== cls);
        node.className = current.join(' ');
      },
      contains(cls) {
        return (node.className || '').split(/\s+/).includes(cls);
      },
      toggle(cls, force) {
        if (force === undefined) force = !this.contains(cls);
        if (force) this.add(cls);
        else this.remove(cls);
      },
    },
    addEventListener(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
    },
    removeEventListener(evt, fn) {
      if (this.listeners[evt]) {
        this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn);
      }
    },
    dispatchEvent(evt, data) {
      (this.listeners[evt] || []).forEach((f) => f(data));
    },
    appendChild(child) {
      if (!child) return child;
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, ref) {
      if (!child) return child;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      if (child) child.parentNode = null;
      return child;
    },
    replaceChildren(...newChildren) {
      this.children = [...newChildren];
      newChildren.forEach((c) => { if (c) c.parentNode = this; });
    },
    get firstChild() {
      return this.children[0] || null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const res = [];
      const match = (n) => {
        if (!n) return;
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          if (cls.includes(':not(')) {
            const [base, notPart] = cls.split(':not(');
            const notCls = notPart.replace(')', '').replace('.', '');
            if (n.classList.contains(base) && !n.classList.contains(notCls)) res.push(n);
          } else if (n.classList.contains(cls)) {
            res.push(n);
          }
        } else if (sel === 'img' && n.tagName === 'IMG') {
          res.push(n);
        } else if (sel === 'summary' && n.tagName === 'SUMMARY') {
          res.push(n);
        } else if (sel === tag.toLowerCase()) {
          res.push(n);
        }
        (n.children || []).forEach(match);
      };
      (this.children || []).forEach(match);
      return res;
    },
    value: '',
    textContent: '',
    get innerHTML() {
      return innerHtmlVal;
    },
    set innerHTML(val) {
      innerHtmlVal = String(val);
      node._innerHTMLSetCalled = true;
      node._lastInnerHTML = innerHtmlVal;
    },
    disabled: false,
    scrollHeight: 32,
    attributes: {},
    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'src') this.src = String(val);
      if (name === 'alt') this.alt = String(val);
    },
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
  };
  return node;
}

function getEl(id) {
  if (!id) return makeEl('div', '');
  if (!elements[id]) elements[id] = makeEl('div', id);
  return elements[id];
}

globalThis.location = { protocol: 'http:', host: 'localhost:8080', search: '?debug=1' };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.document = {
  getElementById: getEl,
  createElement: (tag) => makeEl(tag),
  documentElement: { style: { setProperty() {} } },
  addEventListener: () => {},
  body: makeEl('body'),
};
globalThis.visualViewport = { addEventListener: () => {}, height: 800, offsetTop: 0 };

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor() {
    this.readyState = 1;
    this.listeners = {};
  }
  addEventListener(evt, fn) {
    (this.listeners[evt] = this.listeners[evt] || []).push(fn);
  }
  removeEventListener(evt, fn) {
    if (this.listeners[evt]) {
      this.listeners[evt] = this.listeners[evt].filter((f) => f !== fn);
    }
  }
  dispatchEvent(evt, data) {
    (this.listeners[evt] || []).forEach((f) => f(data));
  }
  send() {}
  close() {}
}
globalThis.WebSocket = MockWebSocket;
globalThis.fetch = async () => ({ ok: false });

// 准备必要的默认 DOM 树结构
const btnSend = getEl('btnSend');
const sendLabel = makeEl('span');
sendLabel.className = 'send-label';
btnSend.appendChild(sendLabel);

// 动态加载 app.js
await import('../web/app.js');

const S = globalThis.__hana.S;
const streamState = globalThis.__hana.streamState;

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
/* 缺陷 1: updateHeroCompanion DOM XSS 防护                            */
/* ------------------------------------------------------------------ */

await t('缺陷1: updateHeroCompanion 使用 createElement img 赋值而非 innerHTML 拼接', () => {
  const avatarEl = getEl('heroAgentAvatar');
  avatarEl.children = [];
  avatarEl.innerHTML = '';
  avatarEl._innerHTMLSetCalled = false;

  const maliciousUrl = 'https://example.com/avatar.png" onerror="alert(1)';
  const maliciousName = 'Bot"><script>alert(2)</script>';
  S.currentAgent = {
    avatarUrl: maliciousUrl,
    name: maliciousName,
  };

  // 调用 updateHeroCompanion
  if (typeof globalThis.__hana.updateHeroCompanion === 'function') {
    globalThis.__hana.updateHeroCompanion();
  } else {
    throw new Error('__hana.updateHeroCompanion 未导出或未定义');
  }

  // 断言：不得调用 innerHTML 拼接 HTML 字符串，而必须通过 createElement img 并为属性赋值
  assert.equal(avatarEl._innerHTMLSetCalled, false, '检测到调用了 innerHTML 赋值，存在 DOM XSS 风险！');
  const img = avatarEl.children.find((c) => c.tagName === 'IMG');
  assert.ok(img, '必须通过 createElement("img") 挂载 img 子节点');
  assert.equal(img.src, maliciousUrl, 'img.src 必须通过属性直接赋值');
  assert.equal(img.alt, maliciousName, 'img.alt 必须通过属性直接赋值');
});

/* ------------------------------------------------------------------ */
/* 缺陷 2: api 15 秒计时器需覆盖 res.text 读取完成                    */
/* ------------------------------------------------------------------ */

await t('缺陷2: api 的 15 秒计时器需覆盖 res.text 读取完成（超时应抛出请求超时）', async () => {
  if (typeof globalThis.__hana.api !== 'function') {
    throw new Error('__hana.api 未导出或未定义');
  }

  // 模拟场景：fetch 建立连接很快返回，但 res.text() 读取响应体耗时超时
  let fetchSignal = null;
  const originalFetch = globalThis.fetch;

  try {
    let timerClearedBeforeBody = false;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = (id) => {
      timerClearedBeforeBody = true;
      originalClearTimeout(id);
    };

    globalThis.fetch = async (url, init) => {
      fetchSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        text: async () => {
          // 如果 clearTimeout 在 text 开始前就已经被调用，说明未覆盖 res.text
          if (timerClearedBeforeBody) {
            throw new Error('clearTimeout 已在 res.text() 开始前被调用，未覆盖 res.text！');
          }
          // 模拟超时触发 abort
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          throw err;
        },
      };
    };

    let errCaught = null;
    try {
      await globalThis.__hana.api('/api/test-timeout');
    } catch (e) {
      errCaught = e;
    }

    assert.ok(errCaught, '超时应该抛出错误');
    assert.match(errCaught.message, /请求超时：\/api\/test-timeout/, '必须统一被捕获并转换为 请求超时：pathname');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ------------------------------------------------------------------ */
/* 缺陷 3: tool_start/end 匹配与降级策略                              */
/* ------------------------------------------------------------------ */

await t('缺陷3: tool_start/end 以 toolCallId/id 匹配以支持交错结束', () => {
  S.session = { path: 'path-test', sessionId: 'sess-test' };
  const transcript = getEl('transcript');
  transcript.children = [];

  globalThis.__hana.startAssistantTurn();

  // 先启动 tool 1
  const ev1 = {
    type: 'tool_start',
    id: 'call_1',
    toolCallId: 'call_1',
    name: 'tool_first',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(ev1);

  // 再启动 tool 2
  const ev2 = {
    type: 'tool_start',
    id: 'call_2',
    toolCallId: 'call_2',
    name: 'tool_second',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(ev2);

  const metaBody = S.turn.querySelector('.meta-body');
  assert.ok(metaBody, '启动 tool 后应该成功初始化 meta-body');

  const tools = metaBody.querySelectorAll('.meta-tool');
  assert.equal(tools.length, 2, '应该生成两个 tool 行');
  const rowTool1 = tools[0];
  const rowTool2 = tools[1];

  // 现在交错结束：tool 1 先结束！
  const ev1End = {
    type: 'tool_end',
    id: 'call_1',
    toolCallId: 'call_1',
    name: 'tool_first',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(ev1End);

  // 断言：tool 1 对应的 row 应该标记为 done，而 tool 2 应该仍然处于未 done 状态
  assert.equal(rowTool1.classList.contains('done'), true, 'tool 1 应该被标记为 done');
  assert.equal(rowTool2.classList.contains('done'), false, 'tool 2 不应该被标记为 done（支持交错结束）');

  // 随后 tool 2 结束
  const ev2End = {
    type: 'tool_end',
    id: 'call_2',
    toolCallId: 'call_2',
    name: 'tool_second',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(ev2End);
  assert.equal(rowTool2.classList.contains('done'), true, 'tool 2 此时应该被标记为 done');
});

await t('缺陷3补充: tool_end 有 callId 找不到对应项时不应错误标记其他工具，仅缺 ID 时回退', () => {
  S.session = { path: 'path-test', sessionId: 'sess-test' };
  const transcript = getEl('transcript');
  transcript.children = [];

  globalThis.__hana.startAssistantTurn();

  // 启动正在运行的 tool A
  const evA = {
    type: 'tool_start',
    id: 'call_A',
    toolCallId: 'call_A',
    name: 'tool_active',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(evA);

  const metaBody = S.turn.querySelector('.meta-body');
  const tools = metaBody.querySelectorAll('.meta-tool');
  const rowToolA = tools[0];
  assert.equal(rowToolA.classList.contains('done'), false, 'tool A 初始处于运行中');

  // 场景 1: 收到 tool_end 带着一个不匹配的 callId (例如 'call_NON_EXISTENT')
  // 严格要求：绝不能把 rowToolA 误标记为完成！
  const evMismatch = {
    type: 'tool_end',
    id: 'call_NON_EXISTENT',
    toolCallId: 'call_NON_EXISTENT',
    name: 'tool_other',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(evMismatch);
  assert.equal(rowToolA.classList.contains('done'), false, '有 callId 却找不到对应项时不应误标记其他工具！');

  // 场景 2: 收到 tool_end 没有带任何 ID (缺 ID)
  // 此时才允许回退取最后一个未完成的工具进行标记
  const evNoId = {
    type: 'tool_end',
    name: 'tool_active',
    sessionId: 'sess-test',
    sessionPath: 'path-test',
  };
  globalThis.__hana.handleEvent(evNoId);
  assert.equal(rowToolA.classList.contains('done'), true, '仅缺 ID 时才回退标记未完成工具');
});

/* ------------------------------------------------------------------ */
/* 缺陷 4: 续流游标、切会话、重复回放与新 stream 序列                 */
/* ------------------------------------------------------------------ */

await t('缺陷4.1: 切会话时必须清理流式游标（streamState）', async () => {
  S.session = { path: 'path-A', sessionId: 'sess-A' };
  streamState.reset();
  streamState.observe({ streamId: 'stream_sess_A', seq: 128 });

  // 切换到新会话 B
  await globalThis.__hana.openSession({ path: 'path-B', sessionId: 'sess-B', title: '会话B' });

  const snap = streamState.snapshot();
  assert.equal(snap.streamId, null, '切会话后 streamId 必须被清理为 null');
  assert.equal(snap.lastSeq, 0, '切会话后 lastSeq 必须被清理为 0');
});

await t('缺陷4.2: stream_resume 必须解包事件并更新游标', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  S.streamingRaw = '';
  const transcript = getEl('transcript');
  transcript.children = [];

  const resumeMsg = {
    type: 'stream_resume',
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
    streamId: 'stream_resumed_999',
    sinceSeq: 0,
    events: [
      { seq: 1, event: { type: 'text_delta', delta: 'Hello' } },
      { seq: 2, event: { type: 'text_delta', delta: ' World' } },
    ],
  };

  globalThis.__hana.handleEvent(resumeMsg);

  assert.equal(streamState.snapshot().streamId, 'stream_resumed_999', 'streamId 必须被更新');
  assert.equal(
    streamState.snapshot().lastSeq,
    2,
    `lastSeq 必须根据已实际处理事件更新为 2（当前为 ${streamState.snapshot().lastSeq}）`,
  );
  assert.ok(S.streamingRaw.includes('Hello World'), `嵌套事件中的 delta 必须被解包处理，当前为 "${S.streamingRaw}"`);
});

await t('缺陷4.3: 新 stream 独立序列（streamId 变更时 lastSeq 重置）', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  streamState.observe({ streamId: 's_old_1', seq: 88 }); // 旧 stream 的 seq 已经走到 88

  // 现在新 stream 开启，首个事件 streamId 为 's_new_2'，seq 从 1 开始
  const newStreamMsg = {
    type: 'text_delta',
    delta: 'Hi',
    streamId: 's_new_2',
    seq: 1,
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
  };

  // 通过 WS 消息模拟接收
  if (S.ws && S.ws.listeners['message']) {
    S.ws.dispatchEvent('message', { data: JSON.stringify(newStreamMsg) });
  } else {
    // 若未绑定则直接 handleEvent
    globalThis.__hana.handleEvent(newStreamMsg);
  }

  const snap = streamState.snapshot();
  assert.equal(snap.streamId, 's_new_2', 'streamId 必须更新为新流 ID');
  assert.equal(snap.lastSeq, 1, `新 stream 的 seq 是独立的，streamId 变更时 lastSeq 必须重置再递增，当前为 ${snap.lastSeq}`);
});

await t('缺陷4.4: stream_resume 重复回放去重（跳过已处理的 seq，避免重复渲染）', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  streamState.beginReplay({ streamId: 's_resume_dedup' });
  streamState.acceptReplay(2); // 客户端之前已经成功处理了 seq: 1 和 seq: 2
  S.streamingRaw = '已处理';
  const transcript = getEl('transcript');
  transcript.children = [];

  // 断线续流返回了重叠的事件：seq 1, seq 2（已处理）和 seq 3（新事件）
  const resumeMsg = {
    type: 'stream_resume',
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
    streamId: 's_resume_dedup',
    sinceSeq: 0,
    events: [
      { seq: 1, event: { type: 'text_delta', delta: '已' } },
      { seq: 2, event: { type: 'text_delta', delta: '处理' } },
      { seq: 3, event: { type: 'text_delta', delta: '新内容' } },
    ],
  };

  globalThis.__hana.handleEvent(resumeMsg);

  assert.equal(streamState.snapshot().lastSeq, 3, `lastSeq 必须更新到新处理的 seq 3（当前为 ${streamState.snapshot().lastSeq}）`);
  assert.equal(S.streamingRaw, '已处理新内容', `重复的 seq: 1 和 seq: 2 必须跳过，不可重复渲染！当前为 "${S.streamingRaw}"`);
});

await t('缺陷4.5: 不可凭空推断 nextSeq 越过未实际处理事件', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  streamState.beginReplay({ streamId: 's_test_nextseq' });

  // 模拟一个包含 nextSeq=50 但 events 里实际只有 seq: 1 的消息
  const resumeMsg = {
    type: 'stream_resume',
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
    streamId: 's_test_nextseq',
    nextSeq: 50,
    events: [
      { seq: 1, event: { type: 'text_delta', delta: 'part1' } },
    ],
  };

  globalThis.__hana.handleEvent(resumeMsg);

  // 必须根据实际处理的事件更新为 1，绝不可越过未处理事件跃迁到 49 或 50
  assert.equal(streamState.snapshot().lastSeq, 1, `不可无证据凭空推断 nextSeq 越过事件，lastSeq 必须为 1，当前为 ${streamState.snapshot().lastSeq}`);
});

await t('缺陷4.6: envelope 上的高 seq 不得跳过内部实际事件', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  S.streamingRaw = '';

  const resumeMsg = {
    type: 'stream_resume',
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
    streamId: 's_high_envelope_seq',
    seq: 50,
    events: [
      { seq: 1, event: { type: 'text_delta', delta: '甲' } },
      { seq: 2, event: { type: 'text_delta', delta: '乙' } },
    ],
  };

  globalThis.__hana.handleEvent(resumeMsg);

  assert.equal(S.streamingRaw, '甲乙', `envelope seq 不得让内部事件被当成重复而跳过，当前为 "${S.streamingRaw}"`);
  assert.equal(streamState.snapshot().lastSeq, 2, `游标只能按实际消费的 seq 推进到 2，当前为 ${streamState.snapshot().lastSeq}`);
});

await t('缺陷4.7: abort 带上 snapshot 的 streamId，本地 finish 不清游标', () => {
  S.session = { path: 'path-abort', sessionId: 'sess-abort' };
  streamState.reset();
  streamState.observe({ streamId: 's_abort', seq: 7 });

  const frames = [];
  const ws = new MockWebSocket();
  ws.send = (data) => frames.push(JSON.parse(data));
  S.ws = ws;
  S.wsReady = true;
  S.busy = true;

  getEl('btnSend').dispatchEvent('click');

  assert.equal(frames.length, 1, `应发送 1 帧 abort，实际 ${frames.length}`);
  assert.equal(frames[0].type, 'abort');
  assert.equal(frames[0].streamId, 's_abort', 'abort 必须带上 snapshot 里的 streamId');
  assert.deepEqual(streamState.snapshot(), { streamId: 's_abort', lastSeq: 7 }, '本地 finishTurn 不能清掉游标');
});

await t('缺陷4.8: 回放先过滤 inner 所属会话，再推进游标', () => {
  S.session = { path: 'path-cur', sessionId: 'sess-cur' };
  streamState.reset();
  S.streamingRaw = '';

  const resumeMsg = {
    type: 'stream_resume',
    sessionPath: 'path-cur',
    sessionId: 'sess-cur',
    streamId: 's_mixed_sessions',
    events: [
      {
        seq: 100,
        event: { type: 'text_delta', delta: '外', sessionId: 'sess-foreign', sessionPath: 'other' },
      },
      { seq: 1, event: { type: 'text_delta', delta: '内' } },
    ],
  };

  globalThis.__hana.handleEvent(resumeMsg);

  assert.ok(!S.streamingRaw.includes('外'), `别的会话的事件不得渲染，当前为 "${S.streamingRaw}"`);
  assert.ok(S.streamingRaw.includes('内'), `本会话事件必须正常渲染，当前为 "${S.streamingRaw}"`);
  assert.equal(streamState.snapshot().lastSeq, 1, `foreign seq 100 不得污染游标，最终应为 1，当前为 ${streamState.snapshot().lastSeq}`);
});

if (bad > 0) {
  console.error(`\nFAILED: ${bad} tests failed.`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
