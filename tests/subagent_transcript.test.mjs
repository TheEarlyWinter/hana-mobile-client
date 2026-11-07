/* tests/subagent_transcript.test.mjs — 单元 B：过程块 → 只读时间轴
 *
 * 锁的是**归一化规则**（契约 3.2 / 3.3），不是界面：
 * 1. 同一消息多段文本合并成一条 say，正文保留原文只去首尾空白
 * 2. 连续 thinking 合并成一条 think；被正文/工具打断就重开
 * 3. 工具：短名 + 参数摘要（超 40 字截断）、结果失败改判 failed、按 toolCallId 精确配对
 * 4. 未知块（卡片 / 文件 / 子代理 / 将来新增）静默跳过，不产步骤也不抛
 * 5. 输入不是数组 / 字段缺失 / 单条坏数据：结果降级为空或少一步，绝不抛
 * 6. 截断：前 20 + note + 最后 (maxSteps-20)，truncated 置真，省略文案带真实条数
 *
 * 夹具字段取自真实宿主形状（本机 ~/.hanako 的 subagent-sessions 原始条目核对）：
 *   assistant.content[] = {type:'thinking', thinking} | {type:'text', text}
 *                       | {type:'toolCall', id, name, arguments}
 *   {role:'toolResult', toolCallId, toolName, content:[{type:'text',text}], isError}
 * 另有一组按 /api/sessions/messages 的 projection 形状写（thinking / toolCalls 在平级），
 * 那是 web/protocol.js 里记着的已知坑。
 *
 * 纯 Node 断言，不需要假 DOM：这个单元不许碰 DOM。
 */

import assert from 'node:assert/strict';
import { toTimeline } from '../web/subagent-transcript.js';

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

/** 一段助手正文消息（真实形状：content 是块数组）。 */
function assistantText(id, ...texts) {
  return {
    role: 'assistant',
    id: String(id),
    content: texts.map((text) => ({ type: 'text', text })),
  };
}

/** 一次工具调用（真实形状：参数键是 arguments）。 */
function toolCall(name, args, callId = null, id = null) {
  const block = { type: 'toolCall', name, arguments: args };
  if (callId) block.id = callId;
  return { role: 'assistant', id: String(id ?? callId ?? 'call'), content: [block] };
}

/** 一条工具结果（真实形状：role toolResult + isError）。 */
function toolResult(toolName, callId, text, isError = false) {
  return {
    role: 'toolResult',
    toolCallId: callId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 空输入与非数组                                                       */
/* ------------------------------------------------------------------ */

t('空数组：四件套都空，不抛', () => {
  const out = toTimeline([]);
  assert.deepEqual(out.steps, [], '空输入不该产出步骤');
  assert.deepEqual(out.stats, { stepCount: 0, toolCount: 0 }, '统计要归零');
  assert.equal(out.task, null, '没有 user 消息时 task 必须是 null');
  assert.equal(out.truncated, false, '空输入不算截断');
});

t('blocks 不是数组：返回空结果而不是抛错', () => {
  for (const value of [undefined, null, 'x', 42, { messages: [] }, { blocks: [] }]) {
    const out = toTimeline(value);
    assert.deepEqual(out, {
      steps: [],
      stats: { stepCount: 0, toolCount: 0 },
      task: null,
      truncated: false,
    }, `输入 ${JSON.stringify(value)} 应该降级成空结果`);
  }
});

t('字段缺失 / 脏条目：不产步骤也不抛', () => {
  const out = toTimeline([
    null,
    undefined,
    42,
    true,
    [],
    {},
    { role: 'assistant' },                                   // 没有 content
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'text' }] },      // text 不是字符串
    { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    { role: 'user' },                                        // 没有正文
    { role: 'system', content: '忽略我' },
    '   ',
  ]);
  assert.deepEqual(out.steps, [], '这些条目一个 step 都不该产出');
  assert.equal(out.task, null, '空白 user 消息不能当 task');
});

/* ------------------------------------------------------------------ */
/* 文本合并                                                            */
/* ------------------------------------------------------------------ */

t('同一消息多段文本合并成一条 say，正文去首尾空白', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [
      { type: 'text', text: '第一段。' },
      { type: 'text', text: '  第二段。  ' },
    ] },
  ]);
  assert.equal(out.steps.length, 1, '同一条消息的两段正文必须合成一条');
  assert.equal(out.steps[0].kind, 'say');
  assert.equal(out.steps[0].title, '结论', 'say 的标题固定是「结论」');
  assert.equal(out.steps[0].meta, null, 'say 没有 meta');
  assert.equal(out.steps[0].text, '第一段。\n第二段。', '正文原样保留，只去掉首尾空白');
});

t('不同消息的正文不合并（各是一条 say）', () => {
  const out = toTimeline([assistantText(2, '甲'), assistantText(3, '乙')]);
  assert.deepEqual(out.steps.map((s) => s.text), ['甲', '乙'], '消息边界必须断开合并');
});

t('老形状：content 直接是字符串也能读', () => {
  const out = toTimeline([{ role: 'assistant', id: '2', content: '直接给的正文' }]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].text, '直接给的正文');
});

t('裸块数组（没有 role）：字符串当正文，相邻文本合并', () => {
  const out = toTimeline(['一段', { type: 'text', text: '两段' }]);
  assert.equal(out.steps.length, 1, '没有消息身份时按相邻合并');
  assert.equal(out.steps[0].text, '一段\n两段');
});

/* ------------------------------------------------------------------ */
/* 思考合并                                                            */
/* ------------------------------------------------------------------ */

t('连续 thinking 合并成一条 think，时长累加', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [
      { type: 'thinking', thinking: '先看结构', durationMs: 4000 },
      { type: 'thinking', thinking: '再看调用', durationMs: 8000 },
    ] },
  ]);
  assert.equal(out.steps.length, 1, '两段思考必须并成一条');
  assert.equal(out.steps[0].kind, 'think');
  assert.equal(out.steps[0].title, '思考');
  assert.equal(out.steps[0].text, '先看结构\n再看调用');
  assert.equal(out.steps[0].meta, '12 秒', '有毫秒字段时写成「N 秒」');
});

t('思考被正文打断就重开一段（不跨内容合并）', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [
      { type: 'thinking', thinking: '想一想' },
      { type: 'text', text: '说说看' },
      { type: 'thinking', thinking: '再想想' },
    ] },
  ]);
  assert.deepEqual(out.steps.map((s) => s.kind), ['think', 'say', 'think'], '顺序与断开都要对');
  assert.deepEqual(out.steps.map((s) => s.text), ['想一想', '说说看', '再想想']);
});

t('reasoning 类型按思考处理；空白思考不产步骤', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [
      { type: 'reasoning', text: '  ' },
      { type: 'reasoning', text: '兜底字段 text' },
    ] },
  ]);
  assert.equal(out.steps.length, 1, '空白思考不能产步骤');
  assert.equal(out.steps[0].kind, 'think');
  assert.equal(out.steps[0].text, '兜底字段 text');
});

t('超长思考正文截到 400 字并补省略号', () => {
  const long = '想'.repeat(500);
  const out = toTimeline([{ role: 'assistant', id: '2', content: [{ type: 'thinking', thinking: long }] }]);
  const text = out.steps[0].text;
  assert.equal(Array.from(text).length, 401, '400 字 + 省略号');
  assert.ok(text.endsWith('…'), '截断必须带省略号');
});

/* ------------------------------------------------------------------ */
/* 工具步骤                                                            */
/* ------------------------------------------------------------------ */

t('工具调用：短名 + 首个关键参数（真实 arguments 键）', () => {
  const out = toTimeline([
    toolCall('read', { path: 'C:\\work\\a.js' }, 'call_1', 2),
  ]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].kind, 'tool');
  assert.equal(out.steps[0].title, 'read', '标题用短工具名');
  assert.equal(out.steps[0].meta, 'C:\\work\\a.js', 'meta 用路径参数');
  assert.equal(out.steps[0].status, 'ok', '没有结果时默认 ok（契约只按失败结果改判）');
});

t('工具名削掉 app__ 前缀与调用 hash', () => {
  const out = toTimeline([
    toolCall('app__twinkstar_web_access__twinkstar_web_access_bro_006a28b90908',
      { url: 'https://example.com/a' }, 'call_1', 2),
  ]);
  assert.equal(out.steps[0].title, 'twinkstar web access', '前缀与 hash 不该露给用户');
  assert.equal(out.steps[0].meta, 'https://example.com/a');
});

t('老形状：参数键是 input / args 也能取到', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [{ type: 'toolCall', name: 'read', input: { file_path: 'b.md' } }] },
    { role: 'assistant', id: '3', content: [{ type: 'tool_use', name: 'grep', args: { pattern: 'TODO' } }] },
    { role: 'assistant', id: '4', content: [{ type: 'tool_call', name: 'exec_command', args: { cmd: 'git status' } }] },
  ]);
  assert.deepEqual(out.steps.map((s) => s.meta), ['b.md', 'TODO', 'git status']);
  assert.deepEqual(out.steps.map((s) => s.title), ['read', 'grep', 'exec command']);
});

t('超长工具参数截到 40 字并补省略号', () => {
  const cmd = `git status ${'x'.repeat(80)}`;
  const out = toTimeline([toolCall('exec_command', { cmd }, 'call_1', 2)]);
  const meta = out.steps[0].meta;
  assert.equal(Array.from(meta).length, 41, '40 字 + 省略号，实际：' + meta);
  assert.ok(meta.endsWith('…'), '超长必须补省略号');
  assert.equal(meta, `${cmd.slice(0, 40)}…`, '截断位置必须是第 40 个字符之后');
});

t('工具参数是多行命令时压成一行', () => {
  const out = toTimeline([toolCall('exec_command', { cmd: 'cd web\n\n  node a.js\t--x' }, 'call_1', 2)]);
  assert.equal(out.steps[0].meta, 'cd web node a.js --x', 'meta 不许换行爆炸');
});

t('没有可认的参数时 meta 是 null', () => {
  const out = toTimeline([toolCall('read', null, 'call_1', 2)]);
  assert.equal(out.steps[0].meta, null);
  assert.equal(out.steps[0].title, 'read');
});

t('工具名缺失：标题退成 tool，不抛', () => {
  const out = toTimeline([{ role: 'assistant', id: '2', content: [{ type: 'toolCall' }] }]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].title, 'tool');
});

/* ------------------------------------------------------------------ */
/* 工具结果与失败标记                                                   */
/* ------------------------------------------------------------------ */

t('工具结果失败 → 该 step 标 failed，并带上原因', () => {
  const out = toTimeline([
    toolCall('exec_command', { cmd: 'git status' }, 'call_1', 2),
    toolResult('exec_command', 'call_1', 'fatal: not a git repository', true),
  ]);
  assert.equal(out.steps.length, 1, '结果本身不是一步');
  assert.equal(out.steps[0].status, 'failed', 'isError:true 必须标 failed');
  assert.ok(out.steps[0].text.includes('fatal: not a git repository'), '失败原因要写进正文');
});

t('工具结果成功 → status ok，正文留空（不塞整段输出）', () => {
  const out = toTimeline([
    toolCall('read', { path: 'a.js' }, 'call_1', 2),
    toolResult('read', 'call_1', '很长的文件内容'.repeat(100), false),
  ]);
  assert.equal(out.steps[0].status, 'ok');
  assert.equal(out.steps[0].text, '', '成功的输出不该进时间轴正文');
});

t('结果按 toolCallId 精确配对：同名两次调用不串台', () => {
  const out = toTimeline([
    toolCall('read', { path: 'a.js' }, 'call_1', 2),
    toolCall('read', { path: 'b.js' }, 'call_2', 3),
    toolResult('read', 'call_1', 'a.js 读失败', true),
    toolResult('read', 'call_2', 'b.js 读成功', false),
  ]);
  assert.deepEqual(out.steps.map((s) => s.status), ['failed', 'ok'], '结果必须按 id 落到各自的调用上');
  assert.ok(out.steps[0].text.includes('a.js 读失败'));
  assert.equal(out.steps[1].text, '');
});

t('结果没有 callId 时退到同名未收尾的那一条', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', content: [{ type: 'toolCall', name: 'grep', arguments: { pattern: 'x' } }] },
    { role: 'toolResult', toolName: 'grep', content: [{ type: 'text', text: 'boom' }], isError: true },
  ]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].status, 'failed', '缺 id 也要能标回原地');
});

t('结果找不到对应调用：跳过，不产步骤', () => {
  const out = toTimeline([toolResult('read', 'call_x', '孤儿结果', true)]);
  assert.deepEqual(out.steps, [], '孤儿结果不是过程');
  assert.deepEqual(out.stats, { stepCount: 0, toolCount: 0 });
});

t('失败判据兼容 status / success / error（实时事件口径）', () => {
  const cases = [
    { status: 'failed' },
    { status: 'error' },
    { success: false },
    { error: 'explode' },
    { is_error: true },
  ];
  for (const extra of cases) {
    const out = toTimeline([
      toolCall('read', { path: 'a' }, 'call_1', 2),
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [], ...extra },
    ]);
    assert.equal(out.steps[0].status, 'failed', `${JSON.stringify(extra)} 应该判成失败`);
  }
  const ok = toTimeline([
    toolCall('read', { path: 'a' }, 'call_1', 2),
    { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [], status: 'ok', success: true, error: null },
  ]);
  assert.equal(ok.steps[0].status, 'ok', '明确成功的不能误判');
});

/* ------------------------------------------------------------------ */
/* 未知块                                                              */
/* ------------------------------------------------------------------ */

t('未知块静默跳过：卡片 / 文件 / 子代理 / 未知名', () => {
  const out = toTimeline([
    { type: 'interactive_card', cardId: 'card-1', afterIndex: 0 },
    { type: 'file', fileId: 'sf_a', label: 'a.txt', afterIndex: 0 },
    { type: 'subagent', taskId: 'task-1', streamStatus: 'done', afterIndex: 1 },
    { type: 'mystery_block', payload: { a: 1 } },
  ]);
  assert.deepEqual(out.steps, [], '未知块一个 note 都不该产出');
  assert.deepEqual(out.stats, { stepCount: 0, toolCount: 0 });
});

t('未知块不会打断前后的步骤顺序', () => {
  const out = toTimeline([
    assistantText(2, '先说话'),
    { type: 'file', fileId: 'sf_a', afterIndex: 0 },
    toolCall('read', { path: 'a' }, 'call_1', 3),
  ]);
  assert.deepEqual(out.steps.map((s) => s.kind), ['say', 'tool']);
});

/* ------------------------------------------------------------------ */
/* task 与 ask                                                         */
/* ------------------------------------------------------------------ */

t('首条 user 消息成为 task，并产出一条 ask', () => {
  const out = toTimeline([
    { role: 'user', id: '1', content: '帮我把登录页的返回键修好' },
    assistantText(2, '改好了'),
    { role: 'user', id: '3', content: '再补一个测试' },
  ]);
  assert.equal(out.task, '帮我把登录页的返回键修好', 'task 只认第一条 user');
  assert.deepEqual(out.steps.map((s) => s.kind), ['ask', 'say', 'ask']);
  assert.equal(out.steps[0].title, '交给它的事');
  assert.equal(out.steps[0].text, '帮我把登录页的返回键修好');
  assert.equal(out.steps[2].text, '再补一个测试', '后一条 user 也是 ask，只是不改 task');
});

t('user 消息的多段文本合并成一条 ask', () => {
  const out = toTimeline([
    { role: 'user', id: '1', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
  ]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].text, '第一行\n第二行');
  assert.equal(out.task, '第一行\n第二行');
});

t('用户消息是硬边界：没有任何正文也不能让前后正文合并', () => {
  const out = toTimeline([
    { type: 'text', text: '甲' },
    { role: 'user', content: '   ' },   // 只有附件那种空正文
    { type: 'text', text: '乙' },
  ]);
  assert.deepEqual(out.steps.map((s) => s.text), ['甲', '乙'], '跨用户的正文不能合并成一条');
});

/* ------------------------------------------------------------------ */
/* 宿主 projection 的已知坑                                             */
/* ------------------------------------------------------------------ */

t('平级 thinking / toolCalls（宿主投影）也能变成步骤', () => {
  const out = toTimeline([
    {
      role: 'assistant',
      id: '2',
      content: [{ type: 'text', text: '正文' }],
      thinking: '想了很久',
      toolCalls: [{ name: 'rg', input: { pattern: 'foo' } }],
    },
  ]);
  assert.deepEqual(out.steps.map((s) => s.kind), ['think', 'say', 'tool'], '平级字段要补成块');
  assert.equal(out.steps[0].text, '想了很久');
  assert.equal(out.steps[2].title, 'rg');
  assert.equal(out.steps[2].meta, 'foo');
});

t('已经带 thinking 块的宿主不重复补（不画两遍）', () => {
  const out = toTimeline([
    { role: 'assistant', id: '2', thinking: '平级', content: [{ type: 'thinking', thinking: '块里' }, { type: 'text', text: '正文' }] },
  ]);
  assert.deepEqual(out.steps.map((s) => s.text), ['块里', '正文'], '平级思考在有块时必须让位');
});

t('{ message: {...} } 外壳也能读（历史 entry 老形状）', () => {
  const out = toTimeline([{ message: { role: 'assistant', content: [{ type: 'text', text: '壳里的话' }] } }]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].text, '壳里的话');
});

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

t('stats：stepCount 是全部步骤，toolCount 只数工具', () => {
  const out = toTimeline([
    { role: 'user', id: '1', content: '干活' },
    { role: 'assistant', id: '2', content: [
      { type: 'thinking', thinking: '想' },
      { type: 'text', text: '说话' },
      { type: 'toolCall', name: 'read', arguments: { path: 'a' } },
      { type: 'toolCall', name: 'grep', arguments: { pattern: 'x' } },
    ] },
  ]);
  assert.deepEqual(out.steps.map((s) => s.kind), ['ask', 'think', 'say', 'tool', 'tool']);
  assert.equal(out.stats.stepCount, 5, 'ask + think + say + 2 tool');
  assert.equal(out.stats.toolCount, 2, 'toolCount 只数 kind=tool');
  assert.equal(out.stats.stepCount, out.steps.length, 'stepCount 必须等于 steps 条数');
});

/* ------------------------------------------------------------------ */
/* 截断                                                                */
/* ------------------------------------------------------------------ */

/** 100 条各不相同的 say：编号看得见，方便核对保留的是哪几段。 */
const hundred = Array.from({ length: 100 }, (_, i) => assistantText(i + 2, `步骤 ${i + 1}`));

t('不超上限：原样返回，不插 note', () => {
  const out = toTimeline(hundred, { maxSteps: 100 });
  assert.equal(out.truncated, false);
  assert.equal(out.steps.length, 100);
  assert.equal(out.steps.some((s) => s.kind === 'note'), false, '没截断就不许出现 note');
});

t('超上限：保留前 20 + note + 最后 (maxSteps-20)', () => {
  const out = toTimeline(hundred, { maxSteps: 30 });
  assert.equal(out.truncated, true);
  assert.equal(out.steps.length, 31, '20 步 + 1 条 note + 10 步');
  assert.equal(out.steps[19].text, '步骤 20', '前 20 条原样保留');
  assert.equal(out.steps[20].kind, 'note', 'note 插在中间');
  assert.equal(out.steps[20].text, '中间 70 步已省略', '省略条数 = 100 - 30');
  assert.equal(out.steps[21].text, '步骤 91', '尾部从第 91 条开始');
  assert.equal(out.steps[30].text, '步骤 100', '最后一条必须是原来的最后一条');
  assert.equal(out.stats.stepCount, 100, '统计报截断前的真实步数');
});

t('maxSteps 小于 20 时头部也收着，总数不超上限', () => {
  const out = toTimeline(hundred, { maxSteps: 10 });
  assert.equal(out.truncated, true);
  assert.equal(out.steps.length, 11, '10 步 + 1 条 note');
  assert.equal(out.steps[10].kind, 'note');
  assert.equal(out.steps[10].text, '中间 90 步已省略');
});

t('maxSteps 脏值退回默认 200（不截断 100 条）', () => {
  for (const value of [0, -5, 3.5, '50', null, NaN]) {
    const out = toTimeline(hundred, { maxSteps: value });
    assert.equal(out.truncated, false, `maxSteps=${String(value)} 应按默认 200 处理`);
    assert.equal(out.steps.length, 100);
  }
});

t('截断后 note 有稳定 id，且不与数字 id 冲突', () => {
  const out = toTimeline(hundred, { maxSteps: 30 });
  const ids = out.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  assert.equal(out.steps[20].id, 'note-70');
});

/* ------------------------------------------------------------------ */
/* 纯函数与容错                                                        */
/* ------------------------------------------------------------------ */

t('不修改输入，同输入两次结果一致（id 稳定）', () => {
  const input = [
    { role: 'user', id: '1', content: '干活' },
    { role: 'assistant', id: '2', content: [
      { type: 'thinking', thinking: '想', durationMs: 1500 },
      { type: 'text', text: '正文' },
      { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.js' } },
    ] },
    toolResult('read', 'call_1', 'no such file', true),
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const first = toTimeline(input);
  const second = toTimeline(input);
  assert.deepEqual(input, snapshot, '输入必须只读');
  assert.deepEqual(first, second, '同一输入必须得到同一结果');
  assert.deepEqual(first.steps.map((s) => s.id), ['0', '1', '2', '3'], 'id 是输入内顺序号');
});

t('单条坏数据（getter 抛错）只丢那一条，其余照画', () => {
  const nasty = {};
  Object.defineProperty(nasty, 'role', { get() { throw new Error('boom'); } });
  const out = toTimeline([nasty, assistantText(2, '我还活着')]);
  assert.equal(out.steps.length, 1, '坏条目被丢掉，但后面的消息必须照画');
  assert.equal(out.steps[0].text, '我还活着');
});

t('参数里循环引用不抛（meta 可能不好看，但步骤要在）', () => {
  const circular = { cmd: 'git status' };
  circular.self = circular;
  const out = toTimeline([toolCall('exec_command', circular, 'call_1', 2)]);
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].kind, 'tool');
  assert.equal(out.steps[0].status, 'ok');
});

/* ------------------------------------------------------------------ */

if (bad > 0) {
  console.log(`\n${bad} FAILED`);
  process.exit(1);
}
console.log('\nALL PASS');
