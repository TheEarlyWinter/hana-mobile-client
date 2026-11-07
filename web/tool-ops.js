/* web/tool-ops.js — 把一次工具调用翻成人话
 *
 * 手机端的「沉静视图」不再只报「3 项操作」这种数字：它要像宿主那样逐条列流水，
 * 一行写成「用完了 Get-ChildItem C:\Users\…」。这一模块只做翻译，不碰 DOM：
 *
 *   describeToolOp(name, args) -> { kind, icon, verbDone, verbRunning, verbFailed, argText }
 *
 * 三个输入形状上的事实（宿主 bundle 里核实过，别凭印象改）：
 *  - name 是宿主的原始工具名，可能带 `app__` / `mcp__` 前缀与尾部调用 hash，
 *    形如 `app__twinkstar_web_access__twinkstar_web_access_bro_006a28b90908`；
 *  - args 是**对象**，只会含一份白名单键（file_path/path/command/cmd/chars/process_id/
 *    pattern/url/query/key/value/action/type/schedule/prompt/label/scope/cardInstanceId）；
 *  - 老宿主或历史回放可能连 args 都没有，也可能把参数塞成字符串。
 *
 * 所以这里的规矩是：认不出来的工具名一律落 other，参数缺就当空——
 * 一行「正在做」也好过崩掉整条消息。词表（图标与三个动词）集中在下方 OPS，
 * 改文案只改那一处。
 */

/**
 * 每一种 kind 的视觉与动词。
 *
 * - icon：纯装饰字形，不带 emoji（emoji 在不同系统上大小与基线都不一样，会把行高顶歪）；
 * - verbRunning / verbDone：进行时与完成式，前者用于还在跑的那一行；
 * - verbFailed：失败时用。不用 verbDone 顶替——「改好了」后面跟着「失败」自相矛盾，
 *   「没改成」才对得上行尾的「失败」与那个 ✗。
 */
const OPS = {
  exec: { icon: '>_', verbRunning: '正在用电脑', verbDone: '用完了', verbFailed: '没用成' },
  read: { icon: '▤', verbRunning: '正在翻', verbDone: '翻完了', verbFailed: '没翻开' },
  edit: { icon: '✎', verbRunning: '正在改', verbDone: '改好了', verbFailed: '没改成' },
  search: { icon: '⌕', verbRunning: '正在找', verbDone: '找完了', verbFailed: '没找到' },
  web: { icon: '↗', verbRunning: '正在查', verbDone: '查完了', verbFailed: '没查到' },
  card: { icon: '▣', verbRunning: '正在画', verbDone: '画好了', verbFailed: '没画成' },
  subagent: { icon: '⧉', verbRunning: '正在叫分身', verbDone: '分身回来了', verbFailed: '分身没回' },
  other: { icon: '·', verbRunning: '正在做', verbDone: '做完了', verbFailed: '没做成' },
};

/**
 * 按 kind 优选的取值键。取不到就走 FALLBACK_KEYS，最后才轮到「随便哪个非空值」。
 * 顺序有意义：exec 优先 command（Bash 的正名），cmd 是老写法。
 */
const ARG_KEYS_BY_KIND = {
  exec: ['command', 'cmd'],
  read: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  search: ['pattern', 'query'],
  web: ['url', 'query'],
};

/** 宿主白名单里剩下的键，顺序按「人最想先看到什么」排。 */
const FALLBACK_KEYS = [
  'key', 'value', 'action', 'label', 'prompt', 'schedule',
  'type', 'chars', 'process_id', 'scope', 'cardInstanceId',
];

/**
 * 工具名的分类规则，**顺序即优先级**。
 *
 * 顺序上最容易踩的两个坑：
 *  - `web_search` 既是 web 又是 search：web 必须排在 search 前面，否则搜索类工具的
 *    取值键会变成 pattern，而 web 工具的参数叫 query，整行就只剩一个动词；
 *  - `show_card` 里的 show 不要单独当规则（`show_file` 是读），只认 card 这个词。
 */
const KIND_RULES = [
  ['subagent', (t) => t.has('subagent') || (t.has('sub') && t.has('agent'))
    || t.has('delegate') || t.has('workflow') || (t.has('task') && t.has('agent'))],
  ['card', (t) => t.has('card') || t.has('artifact') || t.has('mockup')],
  ['web', (t) => t.has('web') || t.has('browser') || t.has('browse') || t.has('http')
    || t.has('https') || t.has('fetch') || t.has('curl') || t.has('url')],
  ['search', (t) => t.has('grep') || t.has('ripgrep') || t.has('rg') || t.has('glob')
    || t.has('find') || t.has('search') || t.has('query')],
  // ls / list / dir 归「翻」而不是「找」：它们唯一的参数是 path，而 read 的取值键正是
  // file_path/path；归到 search 会让 `ls {path}` 这行只剩下「正在找」三个字。
  ['read', (t) => t.has('read') || t.has('cat') || t.has('view') || t.has('open')
    || t.has('head') || t.has('tail') || t.has('ls') || t.has('list') || t.has('dir')],
  ['edit', (t) => t.has('edit') || t.has('write') || t.has('patch') || t.has('apply')
    || t.has('replace') || t.has('create') || t.has('mkdir') || t.has('move')
    || t.has('rename') || t.has('delete') || t.has('rm') || t.has('save')],
  ['exec', (t) => t.has('exec') || t.has('execute') || t.has('bash') || t.has('shell')
    || t.has('sh') || t.has('cmd') || t.has('command') || t.has('pwsh')
    || t.has('powershell') || t.has('terminal') || t.has('console') || t.has('run')
    || t.has('python') || t.has('py') || t.has('node') || t.has('npm') || t.has('git')
    || t.has('script')],
];

/**
 * 把宿主工具名拆成一堆小写词。
 *
 * 先按 camelCase 补空格（`readFile` → `read File`），再削掉 `app__` 前缀、
 * 尾部调用 hash 与 `_bro` 尾巴，最后把一切非字母数字当分隔符。**不改入参**，
 * 也不改界面上显示的名字（那个仍由 chat-renderer 的 prettyToolName 负责）。
 *
 * @param {unknown} rawName
 * @returns {Set<string>} 词集合；认不出来时是空集
 */
function tokensOf(rawName) {
  let s = String(rawName ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  s = s.trim().toLowerCase();
  if (!s) return new Set();
  s = s.replace(/^(app|mcp|plugin)__/, '');
  s = s.replace(/[_-][0-9a-f]{6,}$/, '');   // 尾部调用 hash：_006a28b90908
  s = s.replace(/[_-]bro$/, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return new Set(s.split(' ').filter(Boolean));
}

/** 判 kind；认不出来就是 other。 */
function kindOf(rawName) {
  const tokens = tokensOf(rawName);
  if (!tokens.size) return 'other';
  for (const [kind, test] of KIND_RULES) {
    if (test(tokens)) return kind;
  }
  return 'other';
}

/** 换行、制表、连续空格一律压成一个空格：这一行只有一行高，多行命令也得摊平。 */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * 参数值 → 一行文本。
 * 字符串原样摊平；数字布尔走 String；对象/数组先 JSON 再摊平。
 * **不在这里截断**：多长由 CSS 的省略号决定，JS 截了反而把「看全文」的可能性弄没了。
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return oneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return oneLine(json);
  } catch {
    // 循环引用 / BigInt：退回 String()，宁可难看也别抛
  }
  try {
    return oneLine(String(value));
  } catch {
    return '';
  }
}

/** 从 args 里挑一句最像「这次到底干了什么」的话。 */
function argTextOf(kind, args) {
  // 老宿主/回放可能把参数直接塞成字符串，那就原样用。
  if (typeof args === 'string') return oneLine(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';

  const preferred = ARG_KEYS_BY_KIND[kind] || [];
  for (const key of preferred.concat(FALLBACK_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const text = toText(args[key]);
    if (text) return text;
  }

  // 最后兜底：白名单以外的键（宿主以后新增、或卡片类工具的自定义入参）。
  // 取第一个非空的，总比整行只剩一个动词强；顺序就是宿主写进对象的顺序。
  for (const key of Object.keys(args)) {
    const text = toText(args[key]);
    if (text) return text;
  }
  return '';
}

/**
 * 一次工具调用的完整描述。
 *
 * @param {unknown} name 宿主原始工具名（可带 app__ 前缀与尾部 hash）
 * @param {unknown} args tool_start 的 args 对象（宿主白名单键）；缺失/字符串也能吃
 * @returns {{kind: string, icon: string, verbDone: string, verbRunning: string, verbFailed: string, argText: string}}
 *   kind ∈ exec/read/edit/search/web/card/subagent/other；
 *   argText 是摊平后的一行参数文本，没有参数时是空串（调用方据此决定要不要画 .op-arg）。
 */
export function describeToolOp(name, args) {
  const kind = kindOf(name);
  const words = OPS[kind] || OPS.other;
  return {
    kind,
    icon: words.icon,
    verbDone: words.verbDone,
    verbRunning: words.verbRunning,
    verbFailed: words.verbFailed,
    argText: argTextOf(kind, args),
  };
}
