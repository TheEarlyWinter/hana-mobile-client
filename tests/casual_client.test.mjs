/* tests/casual_client.test.mjs — 闲聊 HTTP 客户端契约测试
 *
 * 覆盖：URL / 查询参数（before 与 agentId 编码）、摘要归一化、8 种 item 的形状与
 * file/voice 透传、必需字段与非法值报错、send 的 body 形状与附件校验、
 * clientMessageId 生成/复用、发送回执（含 reset 标记）、已读回执、贴纸包、
 * 风格、reset 文本命令，以及未设置 agentId 时的中文报错。
 * 全部请求走假 request，不碰真实宿主。
 */

import assert from 'node:assert/strict';
import { createCasualClient } from '../web/casual-client.js';

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

function createRecorder(handler) {
  const calls = [];
  async function request(path, init = {}) {
    const call = { path, init, method: init.method || 'GET', body: init.body };
    calls.push(call);
    if (typeof handler === 'function') return handler(call, calls.length - 1);
    return handler;
  }
  return { request, calls };
}

function makeEntry(overrides = {}) {
  return {
    id: 'entry-1',
    sourceEntryId: 'src-1',
    actor: 'agent',
    occurredAt: '2026-11-04T02:00:00.000Z',
    item: { kind: 'text', text: '早安' },
    ...overrides,
  };
}

async function caught(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('期望抛出异常，但没有');
}

/* ---- 1. URL 与查询参数 ---- */

await t('摘要 / 分页的 URL 与查询参数正确，before 与 agentId 都做 URL 编码', async () => {
  const { request, calls } = createRecorder((call) => {
    if (call.path.includes('/summary')) return { preview: null, unread: 0 };
    return { entries: [], hasMore: false, typing: false };
  });
  const client = createCasualClient({ request, agentId: 'agent-1' });

  assert.equal(client.getAgentId(), 'agent-1');

  await client.loadSummary();
  assert.equal(calls[0].path, '/api/casual/agent-1/summary');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);

  await client.loadPage();
  assert.equal(calls[1].path, '/api/casual/agent-1/entries?limit=50');

  const before = 'src/2026-11-04 a=1&b=2';
  await client.loadPage({ before });
  const pagePath = calls[2].path;
  assert.ok(pagePath.startsWith('/api/casual/agent-1/entries?'), pagePath);
  const query = new URLSearchParams(pagePath.split('?')[1]);
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('before'), before, 'before 解码后必须与传入值一致');
  assert.ok(
    pagePath.includes('before=src%2F2026-11-04+a%3D1%26b%3D2'),
    `before 必须整体编码，实际：${pagePath}`,
  );

  client.setAgentId('agent 2/测试');
  assert.equal(client.getAgentId(), 'agent 2/测试');
  await client.loadSummary();
  assert.equal(calls[3].path, '/api/casual/agent%202%2F%E6%B5%8B%E8%AF%95/summary');
});

/* ---- 2. 摘要 ---- */

await t('摘要归一化：preview 可为 null、unread 取整、occurredAt 统一成 ISO', async () => {
  const withPreview = createRecorder({
    preview: { text: '在吗', occurredAt: '2026-11-04T10:00:00+08:00', previewKind: 'text' },
    unread: 2.9,
  });
  const client = createCasualClient({ request: withPreview.request, agentId: 'a' });
  const summary = await client.loadSummary();
  assert.equal(summary.unread, 2, 'unread 必须取整');
  assert.equal(summary.preview.text, '在吗');
  assert.equal(summary.preview.occurredAt, '2026-11-04T02:00:00.000Z');
  assert.equal(summary.preview.previewKind, 'text');

  const empty = createRecorder({ preview: null, unread: 0 });
  const client2 = createCasualClient({ request: empty.request, agentId: 'a' });
  assert.deepEqual(await client2.loadSummary(), { preview: null, unread: 0 });
});

await t('摘要脏数据报中文错误：缺 unread / 缺 preview 字段', async () => {
  const missingUnread = createRecorder({ preview: null });
  const client = createCasualClient({ request: missingUnread.request, agentId: 'a' });
  const err1 = await caught(() => client.loadSummary());
  assert.match(err1.message, /unread/);
  assert.match(err1.message, /闲聊/);

  const missingTime = createRecorder({ unread: 1, preview: { text: 'x' } });
  const client2 = createCasualClient({ request: missingTime.request, agentId: 'a' });
  const err2 = await caught(() => client2.loadSummary());
  assert.match(err2.message, /occurredAt/);

  const missingText = createRecorder({ unread: 1, preview: { occurredAt: '2026-11-04T02:00:00Z' } });
  const client3 = createCasualClient({ request: missingText.request, agentId: 'a' });
  const err3 = await caught(() => client3.loadSummary());
  assert.match(err3.message, /text/);
});

/* ---- 3. Entry / item 归一化 ---- */

await t('8 种 item 全部归一化，file / voice 整对象透传不丢字段', async () => {
  const entries = [
    makeEntry({ id: 'e-text', sourceEntryId: 's-text', item: { kind: 'text', text: '你好' } }),
    makeEntry({
      id: 'e-card',
      sourceEntryId: 's-card',
      item: { kind: 'card', cardId: 'card-1', title: '卡片', block: { type: 'summary', rows: [1, 2] } },
    }),
    makeEntry({
      id: 'e-sticker',
      sourceEntryId: 's-sticker',
      actor: 'user',
      item: { kind: 'sticker', stickerId: 'st-1', url: '/api/casual/stickers/st-1', note: '挥手' },
    }),
    makeEntry({
      id: 'e-image',
      sourceEntryId: 's-image',
      item: { kind: 'image', url: '/media/a.png', fileId: 'f-2', width: 640, height: 480 },
    }),
    makeEntry({
      id: 'e-file',
      sourceEntryId: 's-file',
      item: {
        kind: 'file',
        fileId: 'f-9',
        name: '报告.pdf',
        mime: 'application/pdf',
        size: 2048,
        extra: { nested: true },
      },
    }),
    makeEntry({
      id: 'e-approval',
      sourceEntryId: 's-approval',
      item: {
        kind: 'approval',
        approvalId: 'ap-1',
        title: '允许执行？',
        status: 'pending',
        detail: '要跑一条命令',
        source: { kind: 'session', sessionId: 'sess-1' },
      },
    }),
    makeEntry({ id: 'e-reset', sourceEntryId: 's-reset', item: { kind: 'reset' } }),
    makeEntry({
      id: 'e-voice',
      sourceEntryId: 's-voice',
      item: { kind: 'voice', text: '语音转写', fileId: 'v-1', durationMs: 1200, extra: '保留' },
    }),
  ];

  const { request, calls } = createRecorder({
    entries,
    hasMore: true,
    typing: true,
  });
  const client = createCasualClient({ request, agentId: 'a' });
  const page = await client.loadPage();

  assert.equal(calls[0].path, '/api/casual/a/entries?limit=50');
  assert.equal(page.hasMore, true);
  assert.equal(page.typing, true);
  assert.equal(page.entries.length, 8);

  const byId = new Map(page.entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('e-text').item, { kind: 'text', text: '你好' });
  assert.deepEqual(byId.get('e-card').item, {
    kind: 'card',
    cardId: 'card-1',
    title: '卡片',
    block: { type: 'summary', rows: [1, 2] },
  });
  assert.deepEqual(byId.get('e-sticker').item, {
    kind: 'sticker',
    stickerId: 'st-1',
    url: '/api/casual/stickers/st-1',
    note: '挥手',
  });
  assert.deepEqual(byId.get('e-image').item, {
    kind: 'image',
    url: '/media/a.png',
    fileId: 'f-2',
    width: 640,
    height: 480,
  });
  assert.deepEqual(byId.get('e-file').item, {
    kind: 'file',
    fileId: 'f-9',
    name: '报告.pdf',
    mime: 'application/pdf',
    size: 2048,
    extra: { nested: true },
  }, 'file 条目必须原样透传');
  assert.deepEqual(byId.get('e-approval').item, {
    kind: 'approval',
    approvalId: 'ap-1',
    title: '允许执行？',
    status: 'pending',
    detail: '要跑一条命令',
    source: { kind: 'session', sessionId: 'sess-1' },
  });
  assert.deepEqual(byId.get('e-reset').item, { kind: 'reset' });
  assert.deepEqual(byId.get('e-voice').item, {
    kind: 'voice',
    text: '语音转写',
    fileId: 'v-1',
    durationMs: 1200,
    extra: '保留',
  }, 'voice 条目必须保留，不能丢');
});

await t('条目必需字段缺失 / 非法值都抛中文错误', async () => {
  const cases = [
    [makeEntry({ sourceEntryId: undefined }), /sourceEntryId/],
    [makeEntry({ id: undefined }), /id/],
    [makeEntry({ actor: 'system' }), /actor/],
    [makeEntry({ occurredAt: '昨天' }), /occurredAt/],
    [makeEntry({ item: { kind: 'text' } }), /文本/],
    [makeEntry({ item: { kind: 'gift', giftId: 'g1' } }), /item\.kind/],
    [makeEntry({ item: { kind: 'approval', approvalId: 'a', title: 't', status: 'maybe' } }), /status/],
  ];

  for (const [entry, pattern] of cases) {
    const { request } = createRecorder({ entries: [entry], hasMore: false, typing: false });
    const client = createCasualClient({ request, agentId: 'a' });
    const err = await caught(() => client.loadPage());
    assert.match(err.message, pattern, `应命中 ${pattern}，实际：${err.message}`);
  }
});

/* ---- 4. send ---- */

await t('send 的 body 形状：文本 + 附件归一化 + clientMessageId', async () => {
  const { request, calls } = createRecorder(() => ({ entryId: 'srv-1', entries: [] }));
  const client = createCasualClient({ request, agentId: 'agent-1', newId: () => 'cm-fixed' });

  const result = await client.send({
    text: '你好',
    attachments: [{ fileId: 'f-1', mime: 'image/png', name: '猫.png', extra: 'drop-me' }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/casual/agent-1/messages');
  assert.equal(calls[0].method, 'POST');
  assert.equal(typeof calls[0].body, 'string', 'body 必须是 JSON 字符串（注入的 api() 只接受字符串）');
  assert.deepEqual(JSON.parse(calls[0].body), {
    text: '你好',
    attachments: [{ fileId: 'f-1', mime: 'image/png', name: '猫.png' }],
    clientMessageId: 'cm-fixed',
  });
  assert.deepEqual(result, { entryId: 'srv-1', entries: [], reset: false });

  await client.send({ stickerId: 'st-1' });
  assert.deepEqual(JSON.parse(calls[1].body), { stickerId: 'st-1', clientMessageId: 'cm-fixed' });
});

await t('send 的 clientMessageId：外部传入优先，newId 只在缺省时调用', async () => {
  let generated = 0;
  const { request, calls } = createRecorder(() => ({ entryId: 'srv-1', entries: [] }));
  const client = createCasualClient({
    request,
    agentId: 'a',
    newId: () => {
      generated += 1;
      return `generated-${generated}`;
    },
  });

  await client.send({ text: '一', clientMessageId: 'cm-explicit' });
  assert.equal(generated, 0, '显式传了 clientMessageId 就不该再生成');
  assert.equal(JSON.parse(calls[0].body).clientMessageId, 'cm-explicit');

  await client.send({ text: '二' });
  assert.equal(generated, 1);
  assert.equal(JSON.parse(calls[1].body).clientMessageId, 'generated-1');

  const badNewId = createCasualClient({
    request: async () => ({ entryId: 'x', entries: [] }),
    agentId: 'a',
    newId: () => '',
  });
  const err = await caught(() => badNewId.send({ text: '三' }));
  assert.match(err.message, /newId/);
});

await t('send 参数校验：空内容 / 附件缺 fileId、mime / attachments 非数组', async () => {
  const client = createCasualClient({
    request: async () => ({ entryId: 'x', entries: [] }),
    agentId: 'a',
    newId: () => 'cm',
  });

  const empty = await caught(() => client.send({}));
  assert.match(empty.message, /发送内容为空/);

  const blank = await caught(() => client.send({ text: '   ' }));
  assert.match(blank.message, /发送内容为空/);

  const noText = await caught(() => client.send({ stickerId: '' }));
  assert.match(noText.message, /stickerId/);

  const noFileId = await caught(() => client.send({ text: 'hi', attachments: [{ mime: 'image/png' }] }));
  assert.match(noFileId.message, /fileId/);

  const noMime = await caught(() => client.send({ text: 'hi', attachments: [{ fileId: 'f-1' }] }));
  assert.match(noMime.message, /mime/);

  const notArray = await caught(() => client.send({ text: 'hi', attachments: 'f-1' }));
  assert.match(notArray.message, /数组/);
});

await t('send 回执归一化：entries 逐条校验、缺 entryId / entries 报错', async () => {
  const okRecorder = createRecorder({
    entryId: 'srv-1',
    entries: [makeEntry({ id: 'srv-1', sourceEntryId: 'src-1' })],
    reset: true,
  });
  const client = createCasualClient({ request: okRecorder.request, agentId: 'a' });
  const result = await client.send({ text: 'hi' });
  assert.equal(result.entryId, 'srv-1');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].sourceEntryId, 'src-1');
  assert.equal(result.reset, true);

  const noEntryId = createCasualClient({
    request: async () => ({ entries: [] }),
    agentId: 'a',
  });
  const err1 = await caught(() => noEntryId.send({ text: 'hi' }));
  assert.match(err1.message, /entryId/);

  const noEntries = createCasualClient({
    request: async () => ({ entryId: 'srv-1' }),
    agentId: 'a',
  });
  const err2 = await caught(() => noEntries.send({ text: 'hi' }));
  assert.match(err2.message, /entries/);
});

/* ---- 5. 已读 / 贴纸 / 风格 / reset ---- */

await t('markRead 的路径、body 与回执；空 entryId 报错', async () => {
  const { request, calls } = createRecorder({ ok: true });
  const client = createCasualClient({ request, agentId: 'agent-1' });
  const receipt = await client.markRead('entry-9');
  assert.equal(calls[0].path, '/api/casual/agent-1/read');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { entryId: 'entry-9' });
  assert.deepEqual(receipt, { ok: true, reset: false });

  const emptyReceipt = createRecorder(null);
  const client2 = createCasualClient({ request: emptyReceipt.request, agentId: 'a' });
  assert.deepEqual(await client2.markRead('entry-1'), { ok: true, reset: false }, '空回执按成功处理');

  const err = await caught(() => client.markRead(''));
  assert.match(err.message, /entryId/);
});

await t('贴纸包归一化：editable / note / 空包，脏数据报错', async () => {
  const { request, calls } = createRecorder({
    packs: [
      {
        id: 'p1',
        name: '默认',
        editable: true,
        stickers: [
          { id: 's1', url: '/api/casual/stickers/s1', note: '挥手' },
          { id: 's2', url: 'data:image/png;base64,xx' },
        ],
      },
      { id: 'p2', name: '', stickers: [] },
    ],
  });
  const client = createCasualClient({ request, agentId: 'a' });
  const result = await client.loadStickerPacks();
  assert.equal(calls[0].path, '/api/casual/stickers');
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(result, {
    packs: [
      {
        id: 'p1',
        name: '默认',
        editable: true,
        stickers: [
          { id: 's1', url: '/api/casual/stickers/s1', note: '挥手' },
          { id: 's2', url: 'data:image/png;base64,xx' },
        ],
      },
      { id: 'p2', name: '', editable: false, stickers: [] },
    ],
  });

  const cases = [
    [{}, /packs/],
    [{ packs: [{ id: 'p', name: 'n', stickers: 'no' }] }, /stickers/],
    [{ packs: [{ id: 'p', name: 'n', stickers: [{ id: 's' }] }] }, /url/],
    [{ packs: [{ name: 'n', stickers: [] }] }, /id/],
  ];
  for (const [payload, pattern] of cases) {
    const badClient = createCasualClient({ request: async () => payload, agentId: 'a' });
    const err = await caught(() => badClient.loadStickerPacks());
    assert.match(err.message, pattern, `应命中 ${pattern}，实际：${err.message}`);
  }
});

await t('风格归一化：appearance 可为 null/对象，缺 stylePackId 报错', async () => {
  const withAppearance = createRecorder({ stylePackId: 'paper', appearance: { tone: 'warm' } });
  const client = createCasualClient({ request: withAppearance.request, agentId: 'a' });
  assert.deepEqual(await client.loadStyle(), { stylePackId: 'paper', appearance: { tone: 'warm' } });
  assert.equal(withAppearance.calls[0].path, '/api/casual/a/style');

  const noAppearance = createRecorder({ stylePackId: 'plain', appearance: null });
  const client2 = createCasualClient({ request: noAppearance.request, agentId: 'a' });
  assert.deepEqual(await client2.loadStyle(), { stylePackId: 'plain', appearance: null });

  const missing = createCasualClient({ request: async () => ({ appearance: null }), agentId: 'a' });
  const err = await caught(() => missing.loadStyle());
  assert.match(err.message, /stylePackId/);
});

await t('reset() 通过 /reset 文本命令发送，回执带 reset 标记', async () => {
  const { request, calls } = createRecorder({
    entryId: 'r-1',
    entries: [makeEntry({ id: 'r-1', sourceEntryId: 's-r', item: { kind: 'reset' } })],
    reset: true,
  });
  const client = createCasualClient({ request, agentId: 'a', newId: () => 'cm-reset' });
  const result = await client.reset();

  assert.equal(calls[0].path, '/api/casual/a/messages');
  assert.deepEqual(JSON.parse(calls[0].body), { text: '/reset', clientMessageId: 'cm-reset' });
  assert.equal(result.reset, true);
  assert.equal(result.entries[0].item.kind, 'reset');

  const withoutFlag = createRecorder({ entryId: 'r-2', entries: [] });
  const client2 = createCasualClient({ request: withoutFlag.request, agentId: 'a' });
  assert.equal((await client2.reset()).reset, false, '回执没带 reset 就按 false 处理');
});

/* ---- 6. 构造与 agentId ---- */

await t('构造参数校验与未设置 agentId 的中文报错', async () => {
  assert.throws(() => createCasualClient(), /request/);
  assert.throws(() => createCasualClient({ request: () => {} , newId: 1 }), /newId/);
  assert.throws(() => createCasualClient({ request: () => {}, agentId: '' }), /agentId/);

  const client = createCasualClient({ request: async () => ({}) });
  assert.equal(client.getAgentId(), null);
  const err = await caught(() => client.loadSummary());
  assert.match(err.message, /agentId/);
  const pageErr = await caught(() => client.loadPage());
  assert.match(pageErr.message, /agentId/);
  const styleErr = await caught(() => client.loadStyle());
  assert.match(styleErr.message, /agentId/);

  assert.throws(() => client.setAgentId(''), /agentId/);
  assert.throws(() => client.setAgentId(null), /agentId/);
});

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
