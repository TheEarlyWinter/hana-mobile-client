/* web/subagent-transcript.js — 把子代理的过程块压成一条只读时间轴
 *
 * 子代理详情页（web/subagent-sheet.js）只显示一串「步骤」：谁被要求什么、想了几次、
 * 用过哪些工具、最后说了什么。宿主给的是会话消息流，形状有三层，全都得吃：
 *
 *   1. `GET /api/sessions/messages` 的 `messages[]`：只有 user / assistant 两种角色。
 *      assistant 的思考与调用**不在 content 里**：宿主把思考抽成平级 `thinking` 字符串、
 *      调用抽成平级 `toolCalls` 数组，content 只剩可见正文（见 web/protocol.js 的
 *      withDerivedBlocks 注释）。这是已知的坑，所以这里直接用 protocol.contentBlocks
 *      补块，不再自己写一份——两处形状一改就会分叉。
 *   2. 同一响应的 `blocks[]`：宿主把 toolResult、卡片、文件、子代理投影成独立块，
 *      用 afterIndex 锚在消息后面。toolResult 块带 role:'toolResult' + toolName +
 *      isError（web/chat-renderer.js 的回放分支就是按这个读的）。
 *   3. 老形状：content 直接是字符串，或者一条消息里塞多段 text 块。
 *
 * 真实字段（本机 `~/.hanako/agents/<agent>/subagent-sessions/**\/*.jsonl` 原始条目核对）：
 *   assistant.content[] = { type:'thinking', thinking } | { type:'text', text }
 *                       | { type:'toolCall', id, name, arguments }
 *   { role:'toolResult', toolCallId, toolName, content:[{type:'text',text}], isError, details }
 * 注：调用参数的正名是 **arguments**（不是 input/args），三个都得认，老会话只有后者。
 *
 * 设计约束：
 *   - 纯函数：不碰 DOM、不发请求、不读全局，输入对象只读不改；
 *   - 任何字段缺失/类型不对都不许抛：单条坏数据最多丢一步，不能让整页白屏；
 *   - 未知块静默跳过（卡片、文件、子代理卡都不是「过程」，画在时间轴里只会更乱）。
 */

import { contentBlocks } from './protocol.js';
import { describeToolOp } from './tool-ops.js';

/** 默认上限。超过就掐中间——用户要看的是开头与结尾，不是第 87 次 read。 */
const DEFAULT_MAX_STEPS = 200;
/** 截断时固定留下开头这么多步（契约 3.3），因为它回答了「它被要求做什么」。 */
const HEAD_KEEP = 20;
/** 工具参数摘要上限（字符数，按码点算，避免切断 emoji / 生僻字）。 */
const ARG_MAX = 40;
/** 思考正文上限。历史回放的思考动辄上万字，整段塞进 sheet 只会卡滚动。 */
const THINK_MAX = 400;
/** 失败原因摘要上限。 */
const REASON_MAX = 120;

/** 步骤标题按契约 3.2 固定；只有 tool 用真实工具名。 */
const TITLE_ASK = '交给它的事';
const TITLE_THINK = '思考';
const TITLE_SAY = '结论';
const TITLE_NOTE = '已省略';

const TOOL_CALL_TYPES = new Set(['toolCall', 'tool_use', 'tool_call']);
const TOOL_RESULT_TYPES = new Set(['toolResult', 'tool_result']);
const THINKING_TYPES = new Set(['thinking', 'reasoning']);

/** 只认字符串；数字 / 布尔 / 对象一律当没有（宿主脏值比缺值更常见）。 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** 首尾空白去掉。正文内部换行原样保留：say 是给人读的原文。 */
function trimText(value) {
  return textOf(value).trim();
}

/** 压成一行：meta / 摘要只占一行高，多行命令也得摊平。 */
function collapse(value) {
  return trimText(value).replace(/\s+/g, ' ');
}

/**
 * 按码点截断并补省略号。
 * 用 Array.from 而不是 slice：中文与 emoji 在 UTF-16 里不是一个单元，
 * 按单元切会把最后一个字切成半个（渲染出来是个方块）。
 */
function clip(value, max) {
  const chars = Array.from(textOf(value));
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max).join('')}…`;
}

/** 第一个非空字符串；全空给 fallback。 */
function firstText(...values) {
  for (const value of values) {
    const text = trimText(value);
    if (text) return text;
  }
  return '';
}

/** 第一个「有值」的入参（null/undefined 跳过，空对象/空串留给上游判断）。 */
function firstValue(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/**
 * 工具名 → 短名（`read`、`rg`、`exec command`）。
 *
 * 规则与 web/chat-renderer.js 的 prettyToolName 逐条一致（那个函数在闭包里没导出，
 * 这里保留一份）：削 `app__`/`mcp__` 前缀、尾部调用 hash、`_bro` 尾巴，再把
 * `A__A` 这种重复分段去重。名字只用于标题，绝不用来判 kind。
 */
function shortToolName(raw) {
  let s = trimText(raw) || 'tool';
  s = s.replace(/^(app|mcp|plugin)__/, '');
  s = s.replace(/[_-][0-9a-f]{6,}$/i, '');   // 尾部调用 id
  s = s.replace(/[_-]bro$/i, '');
  // 首段限定成「不含分隔符」才是线性的；允许含分隔符的回退会被长串重复字符拖死。
  const dup = s.match(/^([^ _-]{1,64})[ _-]\1$/);
  if (dup) s = dup[1];
  const parts = s.split('__').map((p) => p.replace(/[_-]+/g, ' ').trim()).filter(Boolean);
  const uniq = parts.filter((part, index) => part !== parts[index - 1]);
  s = uniq.join(' ').replace(/\s+/g, ' ').trim();
  return s || trimText(raw) || 'tool';
}

/**
 * 工具调用 → 一句参数摘要。
 *
 * 取值键与分类词表全部交给 web/tool-ops.js（沉静视图用的同一份口径）：
 * exec 优先 command/cmd、read/edit 优先 file_path/path、web 优先 url/query……
 * 认不出来的工具退成白名单里的第一个非空值，再不行就是 null（sheet 不画 meta）。
 *
 * @param {string} name 宿主原始工具名
 * @param {unknown} args toolCall 的 arguments / input / args
 * @returns {string|null}
 */
function toolMeta(name, args) {
  try {
    const op = describeToolOp(name, args);
    const line = collapse(op.argText);
    return line ? clip(line, ARG_MAX) : null;
  } catch {
    // 参数里有循环引用之类：宁可没有摘要，也不要让整条时间轴断在这里
    return null;
  }
}

/**
 * 压成一行再截断：给失败原因这类「只该看一眼」的文本用。
 * @param {unknown} value
 * @param {number} max 码点上限
 */
function readable(value, max) {
  return clip(collapse(value), max);
}

/** 新的步骤 id：本次输入内的顺序号，同一次输入稳定。（契约允许 `${index}`。） */
function pushStep(ctx, fields) {
  const step = {
    id: String(ctx.seq),
    kind: fields.kind,
    title: fields.title,
    meta: fields.meta == null ? null : String(fields.meta),
    text: fields.text == null ? '' : String(fields.text),
    status: fields.status === 'failed' || fields.status === 'running' ? fields.status : 'ok',
  };
  ctx.seq += 1;
  ctx.steps.push(step);
  // 任何新步骤都打断「连续合并」：之后的文本 / 思考算新的一段。
  ctx.say = null;
  ctx.think = null;
  return step;
}

/**
 * 追加一条 say。
 *
 * 同一条助手消息里的多段 text 合并成一条（契约 3.3）：宿主把一次模型步存成一条消息，
 * 正文常被一个 thinking 块切成两三段，拆成多个「结论」会让时间轴莫名其妙地重复。
 * 消息身份未知（裸块）时按相邻合并——那时也分不出来，宁可少画。
 */
function addSay(ctx, messageKey, raw) {
  const text = trimText(raw);
  if (!text) return;
  const open = ctx.say;
  const sameMessage = Boolean(open)
    && (messageKey == null || open.key == null || open.key === messageKey);
  if (sameMessage) {
    open.step.text = `${open.step.text}\n${text}`;
    return;
  }
  const step = pushStep(ctx, { kind: 'say', title: TITLE_SAY, meta: null, text, status: 'ok' });
  ctx.say = { step, key: messageKey };
}

/** 思考块的正文：实时块用 thinking，投影块可能写成 text。 */
function thinkingTextOf(block) {
  return firstText(block.thinking, block.text);
}

/**
 * 思考块里的时长（毫秒）。
 *
 * 历史回放里宿主不存思考耗时（chat-renderer 的回放分支干脆只写「思考」不写秒数），
 * 所以这里**只在块自带数字时才写 meta**：durationMs / thinkingMs / duration / ms。
 * 这几个键名是防御性兼容（不是已核对的宿主投影字段），拿不到就 meta:null。
 */
function thinkingMsOf(block) {
  for (const key of ['durationMs', 'thinkingMs', 'duration', 'ms']) {
    const value = block[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * 追加一段思考。连续多段思考合并成一条（契约 3.3）：
 * 思考是按 delta 落盘的，一条消息里常有十几段，段段单独成步会把工具与结论全挤到屏幕外。
 *
 * 这里的「连续」是**流上的相邻**，不看消息边界——契约只在 say 那条写了「同一消息」，
 * 思考没写；中间插了正文或工具就自然断开（pushStep 会清掉合并位）。
 */
function addThink(ctx, block) {
  const text = thinkingTextOf(block);
  const ms = thinkingMsOf(block);
  if (!text) return;
  const open = ctx.think;
  if (open) {
    open.raw = open.raw ? `${open.raw}\n${text}` : text;
    open.ms += ms;
    open.step.text = clip(open.raw, THINK_MAX);
    if (open.ms > 0) open.step.meta = `${Math.max(1, Math.round(open.ms / 1000))} 秒`;
    return;
  }
  const step = pushStep(ctx, {
    kind: 'think',
    title: TITLE_THINK,
    meta: ms > 0 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : null,
    text: clip(text, THINK_MAX),
    status: 'ok',
  });
  ctx.think = { step, raw: text, ms };
}

/**
 * 一次工具调用 → 一条 tool 步骤。
 *
 * 参数键按「正名优先」排：真实 session 里是 `arguments`；projection（protocol.js 补的块）
 * 用 `input`；更老的会话可能叫 `args`。三个都认，顺序不能反——先认 input 会让
 * 带 arguments 的块丢掉参数摘要。
 */
function addToolCall(ctx, block) {
  const name = firstText(block.name, block.toolName, block.tool && block.tool.name) || 'tool';
  const args = firstValue(block.arguments, block.input, block.args);
  const callId = firstText(block.id, block.toolCallId, block.callId);
  const step = pushStep(ctx, {
    kind: 'tool',
    title: shortToolName(name),
    meta: toolMeta(name, args),
    text: '',
    status: 'ok',
  });
  // 一条调用在拿到结果前默认就是 ok（契约 3.3：只有失败结果才改判）；
  // settled 只是「这条结果归谁」的内部账，不对外暴露。
  ctx.openTools.push({ step, callId, name, settled: false });
}

/**
 * 这条工具结果是不是失败态。
 *
 * 已核对的真实字段是 `isError: boolean`（原始 session 的 toolResult 消息）；
 * status / success / error 是实时事件那一侧的口径（web/event-router.js 的 tool_end
 * 判定），投影块里也可能带，一并认——判错的代价是「失败」显示成「完成」，不能漏。
 */
function isFailedResult(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.isError === true || node.is_error === true) return true;
  const status = trimText(node.status).toLowerCase();
  if (status === 'failed' || status === 'error') return true;
  if (node.success === false) return true;
  return Boolean(node.error);
}

/** 工具结果正文：content 里的文本块；老形状可能只有 result / output / text。 */
function resultTextOf(node) {
  const parts = [];
  const blocks = Array.isArray(node.content) ? node.content : [];
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
  }
  if (!parts.length) parts.push(textOf(node.result) || textOf(node.output) || textOf(node.text));
  return parts.map(trimText).filter(Boolean).join('\n');
}

/**
 * 找这条结果对应的工具步骤。
 *
 * 顺序与 chat-renderer 的 finishTool 一致：有 callId 就精确匹配；没有 callId 或匹配不上，
 * 退到「最后一个同名且未收尾的」；再不行才是「最后一个未收尾的」。
 * 绝不把结果标到已经收尾的步骤上（同一工具连调两次时那会把两次混成一次）。
 */
function findOpenTool(ctx, callId, name) {
  const open = ctx.openTools.filter((item) => !item.settled);
  if (!open.length) return null;
  if (callId) {
    const exact = open.find((item) => item.callId && item.callId === callId);
    if (exact) return exact;
  }
  if (name) {
    const named = open.filter((item) => item.name === name);
    if (named.length) return named[named.length - 1];
  }
  return open[open.length - 1];
}

/**
 * 一条工具结果 → 改写（或不改写）已经存在的 tool 步骤，本身不产步骤。
 *
 * 契约 3.3：结果是失败态就把那条 step 标成 failed。失败原因顺手写进 text——
 * 时间轴上「exec command 失败」后面没有一句原因，用户还得回去翻会话。
 */
function addToolResult(ctx, node, outer) {
  const callId = firstText(node.toolCallId, node.callId, node.id, outer && outer.toolCallId, outer && outer.id);
  const name = firstText(node.toolName, node.name, outer && outer.toolName);
  const target = findOpenTool(ctx, callId, name);
  if (!target) return;                 // 找不到调用：结果不是过程，跳过
  target.settled = true;
  const failed = isFailedResult(node) || isFailedResult(outer);
  target.step.status = failed ? 'failed' : 'ok';
  if (failed) {
    const reason = readable(resultTextOf(node), REASON_MAX);
    if (reason) target.step.text = reason;
  }
}

/** 一条 content 块 → 步骤。未知类型静默跳过（契约 3.3）。 */
function addBlock(ctx, messageKey, block) {
  if (typeof block === 'string') {
    addSay(ctx, messageKey, block);
    return;
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  const type = textOf(block.type);

  if (THINKING_TYPES.has(type)) {
    addThink(ctx, block);
    return;
  }
  if (TOOL_CALL_TYPES.has(type)) {
    addToolCall(ctx, block);
    return;
  }
  if (TOOL_RESULT_TYPES.has(type)) {
    addToolResult(ctx, block, null);
    return;
  }
  if (type === 'text') {
    addSay(ctx, messageKey, block.text);
    return;
  }
  // 没有 type 但有 text：chat-renderer 的兜底也这么读，跟它保持一致。
  if (!type && typeof block.text === 'string') {
    addSay(ctx, messageKey, block.text);
    return;
  }
  // interactive_card / file / subagent / 宿主将来新增的块：不是过程，跳过。
}

/** 消息身份：同一条消息里的多段文本才能合并，所以需要一个稳定 key。 */
function messageKeyOf(message) {
  const raw = firstValue(message.id, message.messageId, message.index);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** 用户消息：每个非空正文产出一条 ask，并把它记成 task（只认第一条）。 */
function addUserMessage(ctx, message) {
  // 用户消息是硬边界：哪怕它一个字都没有（只有附件），前后的正文 / 思考也不能跨过它合并。
  ctx.say = null;
  ctx.think = null;

  const blocks = contentBlocks(message);
  const parts = [];
  for (const block of blocks) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object' && textOf(block.type) === 'text') parts.push(textOf(block.text));
    else if (block && typeof block === 'object' && !textOf(block.type)) parts.push(textOf(block.text));
  }
  const text = trimText(parts.join('\n'));
  if (ctx.task == null) ctx.task = text || null;
  if (!text) return;
  pushStep(ctx, { kind: 'ask', title: TITLE_ASK, meta: null, text, status: 'ok' });
}

/**
 * 助手消息：先用 protocol.contentBlocks 把平级 thinking / toolCalls 补成块
 * （复用它就是为了这个坑只修一次），再按块顺序产步骤。
 */
function addAssistantMessage(ctx, message) {
  const key = messageKeyOf(message) ?? `unit-${ctx.units}`;
  ctx.units += 1;
  for (const block of contentBlocks(message)) addBlock(ctx, key, block);
}

/** 一条输入项 → 步骤。role 优先，没 role 就当独立块（历史 blocks 里的投影就是这种）。 */
function takeItem(ctx, item, outer = null) {
  if (typeof item === 'string') {
    addSay(ctx, null, item);
    return;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;

  const role = trimText(item.role ?? (outer && outer.role)).toLowerCase();
  if (role === 'toolresult' || role === 'tool_result') {
    addToolResult(ctx, item, outer);
    return;
  }
  if (role === 'user') {
    addUserMessage(ctx, item);
    return;
  }
  if (role === 'assistant') {
    addAssistantMessage(ctx, item);
    return;
  }
  // system / developer / 未知角色：不是「它做了什么」，不产步骤。
  if (role) return;

  addBlock(ctx, messageKeyOf(item), item);
}

/** 输入项的正文：兼容 `{ message: {...} }` 这种外壳（历史 entry 的老形状之一）。 */
function unwrapItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { node: item, outer: null };
  const inner = item.message;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { node: inner, outer: item };
  return { node: item, outer: null };
}

/**
 * maxSteps 归一化：只认正整数字；脏值退回默认值。
 * 上限没有意义（200 是给滚动的自然长度），所以不设上界。
 */
function normalizeMaxSteps(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_STEPS;
}

/**
 * 截断：保留前 20 条 + 最后 (maxSteps - 20) 条，中间插一条 note（契约 3.3）。
 *
 * 为什么是「前 20 + 后 N」而不是均匀抽样：开头的 ask / 前几次思考说明它被要求干什么，
 * 结尾的结论说明结果，中间才是可牺牲的重复劳动。
 * maxSteps 小于 20 时头部按 maxSteps 收，尾部为 0——总数不超上限，别为了守 20 而放大。
 */
function truncate(steps, maxSteps) {
  if (steps.length <= maxSteps) return { steps, truncated: false };
  const headCount = Math.min(HEAD_KEEP, maxSteps);
  const tailCount = Math.max(0, maxSteps - headCount);
  const omitted = steps.length - headCount - tailCount;
  const out = steps.slice(0, headCount);
  out.push({
    id: `note-${omitted}`,
    kind: 'note',
    title: TITLE_NOTE,
    meta: null,
    text: `中间 ${omitted} 步已省略`,
    status: 'ok',
  });
  if (tailCount > 0) out.push(...steps.slice(steps.length - tailCount));
  return { steps: out, truncated: true };
}

/**
 * 宿主消息 / 过程块 → 只读时间轴的步骤数组。
 *
 * @param {unknown} blocks 宿主 `/api/sessions/messages` 的 `messages`（或 `messages + blocks`）
 *   的条目数组；也接受扁平的 content 块数组。不是数组时返回空结果，不抛。
 * @param {object} [options]
 * @param {number} [options.maxSteps=200] 最多保留多少条步骤（超出掐中间）
 * @returns {{
 *   steps: Array<{id: string, kind: 'think'|'tool'|'say'|'ask'|'note', title: string, meta: string|null, text: string, status: 'ok'|'running'|'failed'}>,
 *   stats: {stepCount: number, toolCount: number},
 *   task: string|null,
 *   truncated: boolean
 * }}
 *   stepCount / toolCount 统计的是**截断前**的真实步数：sheet 的「步骤 / 工具」两格
 *   报的是这个子代理干了多少活，不是这一屏显示了多少行。
 */
export function toTimeline(blocks, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const ctx = { steps: [], seq: 0, say: null, think: null, openTools: [], task: null, units: 0 };

  if (Array.isArray(blocks)) {
    for (const item of blocks) {
      try {
        const { node, outer } = unwrapItem(item);
        takeItem(ctx, node, outer);
      } catch {
        // 单条坏数据（循环引用、getter 抛错…）最多丢一步：整条时间轴不能因此变空。
      }
    }
  }

  const stepCount = ctx.steps.length;
  let toolCount = 0;
  for (const step of ctx.steps) {
    if (step.kind === 'tool') toolCount += 1;
  }

  const cut = truncate(ctx.steps, normalizeMaxSteps(maxSteps));
  return {
    steps: cut.steps,
    stats: { stepCount, toolCount },
    task: ctx.task,
    truncated: cut.truncated,
  };
}
