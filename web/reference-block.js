/* web/reference-block.js
 *
 * 宿主注入的「引用」块：解析与渲染。
 *
 * 背景：宿主会把这些标记直接塞进用户消息文本里——
 *   [hana_reference] … [/hana_reference]
 *   [hana_context] … [/hana_context]
 *   [hana_reminder] … [/hana_reminder]
 *   [hana_app_context] … [/hana_app_context]
 * 里面是「标签（n）+ 条目列表」的纯文本，例如：
 *
 *   [hana_reference]
 *   core（5）
 *   - automation — Create and update scheduled automation suggestions.
 *   [/hana_reference]
 *
 * 手机端以前的做法是**整段丢掉**（attach.js 里的过滤正则），所以桌面看得到的引用，
 * 在手机上一个字都看不到。这里改成解析出来，交给渲染器画成一张可折叠的「引用」卡。
 *
 * 管什么：
 *   1. 把文本里的引用块摘出来，返回去掉引用后的正文 + 结构化的引用数据；
 *   2. 把一块引用画成 DOM（可折叠，默认收起，标题显示标签与条目数）。
 *
 * 不管什么：
 *   1. 不判断该不该显示（渲染器决定落点）；
 *   2. 不 import 任何项目模块，不碰全局状态；document 由调用方传入。
 */

const BLOCK_TAGS = Object.freeze([
  'hana_reference',
  'hana_context',
  'hana_reminder',
  'hana_app_context',
]);

/** 块标记的正则：允许跨行，非贪婪。 */
const BLOCK_RE = new RegExp(
  `\\[(?:${BLOCK_TAGS.join('|')})\\][\\s\\S]*?\\[\\/(?:${BLOCK_TAGS.join('|')})\\]`,
  'g',
);

/** 单个块的开头，用来判断一行是不是引用块的起始。 */
const OPEN_RE = new RegExp(`^\\[(?:${BLOCK_TAGS.join('|')})\\]\\s*$`);

/**
 * 拆一行引用块的内部内容。
 * 约定形状：第一行非条目行当作标签（可能带「（n）」），其余以「- 」开头的行是条目。
 * 不符合约定时（比如整块只有一段话）退化成：label 为空、items 只有这一段。
 *
 * @param {string} inner 去掉首尾标记后的文本
 * @returns {{label: string, items: string[]}}
 */
function parseInner(inner) {
  const lines = String(inner || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let label = '';
  const items = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*·]\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1].trim());
      continue;
    }
    // 还没收集到条目之前，第一条普通行当标签；之后出现的普通行并进上一条或自成一条。
    if (!label) {
      label = line;
      continue;
    }
    if (items.length) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }

  return { label, items: items.filter(Boolean) };
}

/**
 * 从一段文本里摘出所有引用块。
 *
 * @param {string} text
 * @returns {{text: string, references: Array<{label: string, items: string[]}>}}
 *   text 是去掉引用块后的正文（可能为空字符串），references 按出现顺序排列。
 */
export function parseReferenceBlocks(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.includes('[hana_')) return { text: raw, references: [] };

  const references = [];
  const stripped = raw.replace(BLOCK_RE, (match) => {
    // 去掉首尾标记，只留内部内容
    const inner = match.replace(/^\[[a-z_]+\]/, '').replace(/\[\/[a-z_]+\]$/, '');
    const parsed = parseInner(inner);
    // 空块不产生空卡片
    if (parsed.label || parsed.items.length) references.push(parsed);
    return '';
  });

  // 去掉引用块后可能留下多余空行，压回最多一个空行
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, references };
}

/** 一段文本里是否含有引用块（给调用方做快速判断用）。 */
export function hasReferenceBlocks(text) {
  return typeof text === 'string' && text.includes('[hana_') && BLOCK_RE.test(text);
}

/**
 * 把一块引用画成可折叠卡片。
 *
 * @param {Document} doc
 * @param {{label: string, items: string[]}} reference
 * @returns {Element|null} 没有可显示内容时返回 null
 */
export function renderReferenceCard(doc, reference) {
  if (!doc || !reference) return null;
  const items = Array.isArray(reference.items) ? reference.items.filter(Boolean) : [];
  const label = typeof reference.label === 'string' ? reference.label : '';
  if (!items.length && !label) return null;

  const details = doc.createElement('details');
  details.className = 'user-reference';

  const summary = doc.createElement('summary');
  // 标题：有标签用标签，没标签就写「引用」；条目数只在有条目时补
  const title = label || '引用';
  summary.textContent = items.length ? `${title} · ${items.length} 项` : title;
  details.appendChild(summary);

  if (items.length) {
    const list = doc.createElement('div');
    list.className = 'user-reference-list';
    for (const item of items) {
      const row = doc.createElement('div');
      row.className = 'user-reference-item';
      row.textContent = item;
      list.appendChild(row);
    }
    details.appendChild(list);
  }

  return details;
}

/** 供测试与外部引用的块标记清单。 */
export { BLOCK_TAGS, OPEN_RE };
