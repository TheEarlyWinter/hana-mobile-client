/* web/turn-summary.js — 沉静视图的一句话过程摘要
 *
 * 只管文案，不碰 DOM、不读状态：调用方（app.js）在装配时把它注入给 chat-renderer，
 * 渲染器只负责把计数喂进来、把字符串贴到那一行上。
 *
 * 唯一的依赖是 web/renderer-stats.js 的 countOf（计数门槛只有一份）。它本身不碰 DOM、
 * 不读状态，所以这里依旧可以在纯 Node 里单独跑；反过来让 renderer-stats 依赖本模块
 * 会把「视图模式文案」拉进渲染器，那才是真的不想看到的耦合。
 *
 * 规则（父代理定的文案，改动前先看清楚）：
 *   - 片段顺序固定：思考 → 操作 → 未成功，用 ` · ` 连接；
 *   - 非正数片段不出现，全都没有时退成人话：流式里「正在进行」，否则「忙了一阵」；
 *   - 流式中还有内容时，尾部追加 ` · 正在进行`；
 *   - 计数只认正整数：负数 / 小数 / 字符串 / NaN 一律当「无此片段」——
 *     界面上冒出 `NaN 次思考` 比少一段更糟，宁可少说。
 */

import { countOf } from './renderer-stats.js';

/**
 * 一轮的过程摘要。
 *
 * @param {object} [stats]
 * @param {number} [stats.thinkingCount] 思考过几段
 * @param {number} [stats.opCount] 工具操作总数
 * @param {number} [stats.failedCount] 未成功的操作数
 * @param {boolean} [stats.streaming] 这一轮是否还在流式输出
 * @returns {string} 形如「2 次思考 · 5 项操作 · 1 项未成功 · 正在进行」
 */
export function sereneSummary({
  thinkingCount = 0,
  opCount = 0,
  failedCount = 0,
  streaming = false,
} = {}) {
  const parts = [];
  const think = countOf(thinkingCount);
  const ops = countOf(opCount);
  const failed = countOf(failedCount);
  if (think) parts.push(`${think} 次思考`);
  if (ops) parts.push(`${ops} 项操作`);
  if (failed) parts.push(`${failed} 项未成功`);

  if (!parts.length) return streaming ? '正在进行' : '忙了一阵';
  return streaming ? `${parts.join(' · ')} · 正在进行` : parts.join(' · ');
}
