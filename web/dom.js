/* web/dom.js — 只做元素的小工具
 *
 * 原来在 app.js 里，渲染器拆出去后两边都要用，挪到这里各取所需。
 * 刻意保持极小：不做虚拟 DOM、不做批量更新，只是让「建一个带 class 和文本的
 * 元素」不必写三行。
 */

/** 建一个元素：el('div', 'turn-body', '文字') */
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** 按 id 取节点。 */
export const $ = (id) => document.getElementById(id);
