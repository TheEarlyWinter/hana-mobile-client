/* 协议纯函数层：不碰 DOM、不持状态，供 app.js 与独立测试共用。
 *
 * 这些实现从 web/app.js 原样抽出（contentBlocks / blockText / splitMoodBlock /
 * cleanMoodText / belongsToCurrentSession），行为保持逐字一致；新增的
 * parseSocketPayload / unwrapReplayEvent 只把 WebSocket 收包与回放解包从
 * 事件处理里拆出来。
 */

/** 历史消息兼容各种形状，统一成 content 块数组。 */
export function contentBlocks(message) {
  if (!message) return [];
  if (typeof message === 'string') return [{ type: 'text', text: message }];
  if (Array.isArray(message)) return message;
  // content 数组原样进（调用方有拿返回值当身份用的地方），需要补块时才复制。
  if (Array.isArray(message.content)) return withDerivedBlocks(message, message.content);
  const blocks = [];
  if (typeof message.content === 'string') blocks.push({ type: 'text', text: message.content });
  else if (typeof message.text === 'string') blocks.push({ type: 'text', text: message.text });
  return withDerivedBlocks(message, blocks);
}

/**
 * 补上宿主放在**平级字段**里的思考与工具调用。
 *
 * 宿主 `/api/sessions/messages` 的投影不是标准 content 数组：思考被抽成
 * `thinking` 字符串，调用被抽成 `toolCalls` 数组，`content` 里只剩可见正文。
 * 手机端以前只读 content，于是「退出重进后思考视图全没了」——实时能看到，
 * 是因为实时走的是流式块，两条路径的数据形状本来就不一样。
 *
 * 只在该字段还没被表达成块时才补，避免两路都带的宿主把内容画两遍。
 */
function withDerivedBlocks(message, blocks) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return blocks;
  const hasThinking = blocks.some((b) => b && (b.type === 'thinking' || b.type === 'reasoning'));
  const thinking = typeof message.thinking === 'string' ? message.thinking : '';
  const wantThinking = Boolean(thinking.trim()) && !hasThinking;

  const calls = Array.isArray(message.toolCalls) ? message.toolCalls
    : Array.isArray(message.tool_calls) ? message.tool_calls
      : Array.isArray(message.toolUses) ? message.toolUses : [];
  const hasCalls = blocks.some((b) => b && (b.type === 'toolCall' || b.type === 'tool_use' || b.type === 'tool_call'));
  const wantCalls = calls.length > 0 && !hasCalls;

  // 什么都补不了就原样返回：调用方有拿返回值当身份用的地方（原数组引用）。
  if (!wantThinking && !wantCalls) return blocks;

  const out = [...blocks];
  if (wantThinking) out.unshift({ type: 'thinking', thinking });
  if (wantCalls) {
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      out.push({
        type: 'toolCall',
        name: call.name || call.toolName || 'tool',
        input: call.input || call.args || call.arguments || null
      });
    }
  }
  return out;
}

export function blockText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  return '';
}

/**
 * 把正文里的 mood 块剥出来。
 *
 * 服务端把 `<mood>` / `<pulse>` / `<reflect>` 原样写在 assistant 的 text 里，
 * 桌面端会抽出来单独渲染（它只认开头那一个）。实际跑下来模型也会写在中间：
 *
 *   整个文件只有一个选择器……零冲突。
 *
 *   <mood>
 *   Vibe: ……
 *   </mood>
 *
 * 所以按「行首的标签」来找，而不是只看 `^`。两个防误伤：
 * 一是必须独占行首（行内代码 `` `<mood>` `` 不算）；二是落在围栅代码块里的不算。
 *
 * 返回 { mood, body }：mood 为 null 表示这一条没有 mood 块。
 * 未闭合时从标签起的部分都算 mood，正文先留空——流式阶段本来就该这样。
 */
export function splitMoodBlock(text) {
  const src = String(text ?? '');
  const open = /(?:^|\n)[ \t]*<(mood|pulse|reflect)>/i.exec(src);
  if (!open) return { mood: null, body: src };
  const tagStart = open.index + open[0].indexOf('<');
  const fences = (src.slice(0, tagStart).match(/```/g) || []).length;
  if (fences % 2 === 1) return { mood: null, body: src };   // 代码块里引用的标签

  const tag = open[1].toLowerCase();
  const close = `</${tag}>`;
  const head = src.slice(0, open.index);
  const after = src.slice(tagStart + tag.length + 2);
  const closeIdx = after.toLowerCase().indexOf(close);
  if (closeIdx < 0) return { mood: after, body: head };

  const mood = after.slice(0, closeIdx);
  const body = (head + after.slice(closeIdx + close.length)).replace(/\n{3,}/g, '\n\n').trim();
  return { mood, body };
}

/** 去掉 mood 文本里可能残留的标签（服务端事件和正文两条路都可能带上）。 */
export function cleanMoodText(text) {
  return String(text || '')
    .replace(/^\s*<(mood|pulse|reflect)>/i, '')
    .replace(/<\/(mood|pulse|reflect)>\s*$/i, '')
    .trim();
}

/**
 * 这条事件是不是当前会话的。
 *
 * /ws 是全局事件流：桌面端正在跑的轮次也会推过来。不过滤的话，
 * 别人的思考、工具调用会画进这个会话，还会把发送按钮永久卡在「停止」。
 * 事件一般带 sessionId + sessionPath，两个都可作为依据；都没带的是全局广播，放行。
 */
export function belongsToSession(ev, session) {
  if (!ev || typeof ev !== 'object' || !session) return false;
  if (ev.sessionId && session.sessionId && ev.sessionId !== session.sessionId) return false;
  if (
    ev.sessionPath &&
    session.path &&
    String(ev.sessionPath).toLowerCase() !== String(session.path).toLowerCase()
  ) {
    return false;
  }
  return true;
}

/** WebSocket 文本帧 → 事件对象；坏 JSON、null、标量一律 null。 */
export function parseSocketPayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  return data;
}

/**
 * stream_resume 里的一条回放记录 → { event, seq }。
 *
 * 支持 `{ seq, event }` 包装和直接事件两种形状；外层 seq 是 number 时优先，
 * 否则退回事件自身的 seq。事件缺少 sessionId/sessionPath 时从 envelope 继承，
 * 需要补字段才浅复制，绝不改写传入对象；没有可继承字段时保留事件原引用。
 */
export function unwrapReplayEvent(item, envelope) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  let inner;
  if (Object.prototype.hasOwnProperty.call(item, 'event')) {
    if (!item.event || typeof item.event !== 'object' || Array.isArray(item.event)) return null;
    inner = item.event;
  } else {
    inner = item;
  }

  const seq =
    typeof item.seq === 'number'
      ? item.seq
      : (typeof inner.seq === 'number' ? inner.seq : null);

  const inheritSessionId = !inner.sessionId && !!envelope?.sessionId;
  const inheritSessionPath = !inner.sessionPath && !!envelope?.sessionPath;
  let event = inner;
  if (inheritSessionId || inheritSessionPath) {
    event = { ...inner };
    if (inheritSessionId) event.sessionId = envelope.sessionId;
    if (inheritSessionPath) event.sessionPath = envelope.sessionPath;
  }

  return { event, seq };
}
