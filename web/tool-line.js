/* web/tool-line.js — 工具行的名字与收尾三态
 *
 * 工具调用那一行的**文案**：名字怎么剥掉宿主前缀与调用 hash 变成人能读的样子，
 * 收尾时行尾写「完成 / 失败」、行内打 ✓ 还是 ✗。
 *
 * 全是纯函数：字符串进、字符串出，不碰 DOM、不读写渲染器的闭包——
 * 摆节点、加 class、写 dataset 仍然是 chat-renderer 的事。
 *
 * 和 tool-ops.js 的分工是单向的：那边翻译「正在做什么」（动词 + 参数），
 * 这边只管「这行叫什么名字」和「最后成没成」。两个词表互不 import，
 * 因为一个是渲染时的静态选择，另一个是收尾事件才决定的终态。
 */

/**
 * 把工具名变成人能读的样子。
 *
 * 服务端发的原始名形如：
 *   app__twinkstar_web_access__twinkstar_web_access_bro_006a28b90908
 * 前缀、宿主 id、调用 hash 对用户都没意义，抽出真正的名字，剩下的交给 CSS 省略。
 *
 * 注意这里只去掉**结构**，不做分词大小写改写（`readFile` 仍是 `readFile`）；
 * 认工具类别是 tool-ops.js 的事，那边另有自己的一套词表。
 *
 * @param {unknown} raw 宿主的原始工具名；空 / 假值 / 认不出来时退回 'tool'
 * @returns {string} 显示名
 */
export function prettyToolName(raw) {
  let s = String(raw || 'tool').trim();
  if (!s) return 'tool';
  s = s.replace(/^(app|mcp|plugin)__/, '');
  s = s.replace(/[_-][0-9a-f]{6,}$/i, '');   // 尾部调用 id
  s = s.replace(/[_-]bro$/i, '');
  // 不能写成 /^(.+?)[ _-]\1$/：分孪组里允许含分隔符时，回退是致命的（一长串重复字符
  // 能把主线程卡死）。把首段限定成「不含分隔符」就是线性的。
  const dup = s.match(/^([^ _-]{1,64})[ _-]\1$/);
  if (dup) s = dup[1];
  // 还可能是 `A__A` 这种双下划线分段重复（app id 与 tool 前缀同名时的常见形态）
  const parts = s.split('__').map((p) => p.replace(/[_-]+/g, ' ').trim()).filter(Boolean);
  const uniq = parts.filter((p, i) => p !== parts[i - 1]);
  s = uniq.join(' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s || String(raw || 'tool');
}

/**
 * 收尾态的中文，写到行尾的 `.state` 上。
 *
 * 这个 span 从加沉静视图之前就在了（经典视图的逐条列表与回归断言都盯着它），
 * 所以文案不许跟着视图模式变：只有两态，没有「运行中」——那是 addTool 的入参默认值。
 *
 * @param {boolean} failed 这次调用是否失败
 * @returns {string} `失败` 或 `完成`
 */
export function toolStateText(failed) {
  return failed ? '失败' : '完成';
}

/**
 * 收尾态的记号，写到行尾的 `.op-mark` 上（纯装饰，外层已经 aria-hidden）。
 *
 * 和 toolStateText 放在一起是有意的：✗ 与「失败」必须成对出现，
 * 分散在两处迟早会出现「打了勾却写着失败」。
 *
 * @param {boolean} failed
 * @returns {string} `✗` 或 `✓`
 */
export function toolMark(failed) {
  return failed ? '✗' : '✓';
}
