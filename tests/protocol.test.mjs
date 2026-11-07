/* 解耦协议层回归：以 web/app.js 当前内联实现为基准，锁定解析输出。 */

import assert from 'node:assert/strict';
import {
  contentBlocks,
  blockText,
  splitMoodBlock,
  cleanMoodText,
  belongsToSession,
  parseSocketPayload,
  unwrapReplayEvent,
} from '../web/protocol.js';

const failures = [];
function check(name, run) {
  try {
    run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
  }
}

function table(name, rows, fn) {
  for (const [label, input, expected] of rows) {
    check(`${name}: ${label}`, () => assert.deepEqual(fn(input), expected));
  }
}

/* contentBlocks / blockText: history 兼容输入形状。 */
table('contentBlocks', [
  ['null', null, []],
  ['undefined', undefined, []],
  ['falsey number', 0, []],
  ['empty string', '', []],
  ['plain string', 'hello', [{ type: 'text', text: 'hello' }]],
  ['content array takes precedence', { content: [{ type: 'image', url: '/x' }], text: 'fallback' }, [{ type: 'image', url: '/x' }]],
  ['content string', { content: 'body' }, [{ type: 'text', text: 'body' }]],
  ['fallback text string', { text: 'legacy' }, [{ type: 'text', text: 'legacy' }]],
  ['unsupported shape', { content: 42, text: null }, []],
], (message) => contentBlocks(message));

check('contentBlocks: 数组输入原样返回同一数组', () => {
  const blocks = [{ type: 'text', text: 'x' }];
  assert.equal(contentBlocks(blocks), blocks);
});
check('contentBlocks: message.content 数组原样返回同一数组', () => {
  const blocks = [{ type: 'image', url: '/x' }];
  assert.equal(contentBlocks({ content: blocks }), blocks);
});

/* 宿主历史投影的平级字段：思考在 thinking、调用在 toolCalls。
 * 不补这两块，退出重进后思考视图（N 次思考 · M 项操作）就整个没了。 */
check('contentBlocks: thinking 平级字段补成 thinking 块并放最前', () => {
  const out = contentBlocks({ content: [{ type: 'text', text: '正文' }], thinking: '想一想' });
  assert.equal(out[0].type, 'thinking');
  assert.equal(out[0].thinking, '想一想');
  assert.equal(out[1].text, '正文');
});
check('contentBlocks: toolCalls 平级字段补成 toolCall 块', () => {
  const out = contentBlocks({
    content: [{ type: 'text', text: '正文' }],
    toolCalls: [{ name: 'read', input: { path: 'a.js' } }, { toolName: 'shell' }]
  });
  const calls = out.filter((b) => b.type === 'toolCall');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read');
  assert.deepEqual(calls[0].input, { path: 'a.js' });
  assert.equal(calls[1].name, 'shell');
});
check('contentBlocks: 已经有 thinking/toolCall 块时不重复补', () => {
  const out = contentBlocks({
    content: [{ type: 'thinking', thinking: '已有' }, { type: 'toolCall', name: 'x' }],
    thinking: '再来一份',
    toolCalls: [{ name: 'y' }]
  });
  assert.equal(out.filter((b) => b.type === 'thinking').length, 1);
  assert.equal(out.filter((b) => b.type === 'toolCall').length, 1);
});
check('contentBlocks: thinking 是空白串时不补空块', () => {
  const out = contentBlocks({ content: [{ type: 'text', text: '正文' }], thinking: '   ' });
  assert.equal(out.length, 1);
});

table('blockText', [
  ['null', null, ''],
  ['falsey number', 0, ''],
  ['string block', 'plain', 'plain'],
  ['text string', { type: 'text', text: 'body' }, 'body'],
  ['non-string text', { text: 7 }, ''],
  ['missing text', { type: 'image', url: '/x' }, ''],
], (block) => blockText(block));

/* Mood 标签解析：三个别名、流式未闭合、代码围栏、行内误命中与正文位置。 */
table('splitMoodBlock', [
  ['无标签时原样保留正文空白', '  原文\n', { mood: null, body: '  原文\n' }],
  ['mood 标签', '<mood>平静</mood>正文', { mood: '平静', body: '正文' }],
  ['pulse 标签', '<pulse>专注</pulse>正文', { mood: '专注', body: '正文' }],
  ['reflect 标签', '<reflect>反思</reflect>正文', { mood: '反思', body: '正文' }],
  ['大小写不敏感且保留标签内空格', '<MoOd> 想法 </MOOD>\n正文', { mood: ' 想法 ', body: '正文' }],
  ['标签位于正文中间', '前言\n<mood>内心</mood>\n正文', { mood: '内心', body: '前言\n正文' }],
  ['未闭合标签保留流式内容并截断正文', '前言\n<mood>正在输入', { mood: '正在输入', body: '前言' }],
  ['围栏代码块中的标签不解析', '前言\n```md\n<mood>代码</mood>\n```\n后文', { mood: null, body: '前言\n```md\n<mood>代码</mood>\n```\n后文' }],
  ['行内标签不解析', '文字 `<mood>不是标签</mood>` 结束', { mood: null, body: '文字 `<mood>不是标签</mood>` 结束' }],
  ['闭合块后压缩连续空行并修剪正文', '甲\n\n\n<mood>x</mood>\n\n\n乙\n', { mood: 'x', body: '甲\n\n乙' }],
  ['null 输入', null, { mood: null, body: '' }],
], (text) => splitMoodBlock(text));

table('cleanMoodText', [
  ['剥除 mood 首尾标签', '<mood>  内心  </mood>', '内心'],
  ['剥除 pulse 标签', '<pulse>专注</pulse>', '专注'],
  ['剥除 reflect 标签且大小写不敏感', '  <REFLECT>想法</reflect>  ', '想法'],
  ['仅首标签', '<mood>内容', '内容'],
  ['仅尾标签', '内容</pulse>', '内容'],
  ['普通文本只修剪空白', '  普通文本  ', '普通文本'],
  ['null 输入', null, ''],
  ['number 输入转字符串', 12, '12'],
], (text) => cleanMoodText(text));

/* WebSocket 原始载荷解析。 */
table('parseSocketPayload', [
  ['JSON object', '{"type":"text_delta","seq":3}', { type: 'text_delta', seq: 3 }],
  ['JSON null', 'null', null],
  ['JSON number', '3', null],
  ['JSON boolean', 'false', null],
  ['JSON string', '"text"', null],
  ['无效 JSON', '{broken', null],
  ['undefined 原始值', undefined, null],
], (raw) => parseSocketPayload(raw));

/* 会话过滤：沿用 app.js 的标识缺省与 path 大小写规则。 */
const current = { sessionId: 'sess-a', path: 'Folder/Session' };
const sessionCases = [
  ['无当前会话拒绝事件', { sessionId: 'sess-a' }, null, false],
  ['无标识的全局广播允许', { type: 'thinking_delta' }, current, true],
  ['匹配 sessionId', { sessionId: 'sess-a' }, current, true],
  ['sessionId 冲突拒绝', { sessionId: 'sess-b', sessionPath: 'Folder/Session' }, current, false],
  ['path 大小写不同仍匹配', { sessionPath: 'folder/session' }, current, true],
  ['path 冲突拒绝', { sessionId: 'sess-a', sessionPath: 'other' }, current, false],
  ['当前会话缺 sessionId 时不比较该字段', { sessionId: 'remote' }, { path: 'Folder/Session' }, true],
  ['当前会话缺 path 时不比较该字段', { sessionPath: 'other' }, { sessionId: 'sess-a' }, true],
  ['事件缺一个标识时由另一个标识判定', { sessionPath: 'FOLDER/SESSION' }, current, true],
];
for (const [label, event, session, expected] of sessionCases) {
  check(`belongsToSession: ${label}`, () => assert.equal(belongsToSession(event, session), expected));
}

/* Replay 外层/内层序号优先级与直接事件形式。 */
table('unwrapReplayEvent', [
  ['wrapper 外层 number seq 优先', { seq: 8, event: { type: 'text', seq: 3 } }, { event: { type: 'text', seq: 3 }, seq: 8 }],
  ['外层 seq 非 number 时回退内层 seq', { seq: '8', event: { type: 'text', seq: 3 } }, { event: { type: 'text', seq: 3 }, seq: 3 }],
  ['无外层与内层 seq 时返回 null seq', { event: { type: 'text' } }, { event: { type: 'text' }, seq: null }],
  ['直接事件使用自身 seq', { type: 'text', seq: 4 }, { event: { type: 'text', seq: 4 }, seq: 4 }],
  ['直接事件没有 seq', { type: 'text' }, { event: { type: 'text' }, seq: null }],
  ['空 wrapper event 无效', { seq: 2, event: null }, null],
  ['非 object wrapper event 无效', { seq: 2, event: 'text' }, null],
  ['null item 无效', null, null],
  ['string item 无效', 'text', null],
  ['number item 无效', 3, null],
], (item) => unwrapReplayEvent(item, null));

check('unwrapReplayEvent: 缺失标识时浅复制并继承 envelope，不改输入且保留冲突标识', () => {
  const nested = { type: 'text', sessionId: 'inner-id', payload: { n: 1 } };
  const item = { seq: 9, event: nested };
  const envelope = { sessionId: 'outer-id', sessionPath: 'Outer/Path' };
  const before = JSON.stringify(item);
  const result = unwrapReplayEvent(item, envelope);

  assert.equal(result.seq, 9);
  assert.notEqual(result.event, nested, '缺 path 时应复制 event 再补字段');
  assert.equal(result.event.sessionId, 'inner-id', '冲突 sessionId 必须保留');
  assert.equal(result.event.sessionPath, 'Outer/Path');
  assert.equal(result.event.payload, nested.payload, '应为浅复制');
  assert.equal(JSON.stringify(item), before, '不可改写 replay 原对象');
});

check('unwrapReplayEvent: 空字符串标识按缺失处理并继承 envelope', () => {
  const item = { event: { type: 'text', sessionId: '' } };
  const result = unwrapReplayEvent(item, { sessionId: 'outer', sessionPath: 'p' });
  assert.deepEqual(result.event, { type: 'text', sessionId: 'outer', sessionPath: 'p' });
  assert.equal(item.event.sessionId, '', '原 event 不得被改写');
});

check('unwrapReplayEvent: 已有冲突标识时保留 event 原引用与字段', () => {
  const event = { type: 'text', sessionId: 'inner', sessionPath: 'inner/path' };
  const result = unwrapReplayEvent({ event }, { sessionId: 'outer', sessionPath: 'outer/path' });
  assert.equal(result.event, event);
  assert.equal(result.event.sessionId, 'inner');
  assert.equal(result.event.sessionPath, 'inner/path');
});

if (failures.length) {
  console.error(`\n${failures.length} protocol test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nALL PASS');
}
