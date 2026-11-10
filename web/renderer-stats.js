/* web/renderer-stats.js — 一轮消息的尾注数字与时长文案
 *
 * 从 chat-renderer.js 抽出来的「数字怎么写成人话」那一半：尾注上的时钟、首响、
 * 输出速度、折叠条上的思考时长，以及计数前的脏值防御。
 *
 * 全是纯函数：入参 → 字符串 / 数字。不碰 DOM、不读闭包状态、不 import 其它模块，
 * 所以流式热路径上每次重画尾注都不必穿过渲染器的闭包。
 *
 * 这些字符串会被人逐字看到，也常被测试断言，所以行为与搬出来之前**逐字节一致**：
 * 同样的四舍五入、同样的空格与 ` · ` 分隔符、同样的门槛（首响不足 1 秒不报、
 * 字数不过 40 不算速度、速度不足 0.2 秒的样本丢弃）。改文案前先看
 * tests/renderer_parts.test.mjs，那里把边界钉住了。
 */

/**
 * 计数只认正整数；脏值当 0。
 *
 * 负数 / 小数 / 字符串 / 数字化的 boolean / NaN / Infinity 一律当「没有这一项」——
 * 界面上冒出 `NaN 项操作` 比少报一项更糟。turn-summary.js 直接 import 这一份（两边
 * 当时逐字相同，没有语义差异需要保留），全库只有这一个计数门槛，改这里就是改两处。
 *
 * @param {unknown} value
 * @returns {number} 正整数，或 0（表示没有这一项）
 */
export function countOf(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * 尾注里的时钟：24 小时制 HH:MM，按本地时区。
 *
 * @param {number} [ts] 毫秒时间戳；不传就是「现在」（调用方不传与传 undefined 等价）
 * @returns {string} 形如 `09:05`
 */
export function clockText(ts = Date.now()) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 尾注右侧那串性能数字（含前导分隔符，和空串「什么都不显示」）。
 *
 * 形状：` · 首响 1.2 s · 30.4 字/s`。前导 ` · ` 是因为它接在时间后面：
 * `.foot-stats` 与 `.foot-time` 是两个 span，分隔符只能写在文本里。
 *
 * - 首响不足 10 秒报一位小数（`1.2 s`），过了 10 秒就只报整秒（`12 s`）；
 * - 速度同一条规则，阈值是 100 字/秒；
 * - 两个都是 0（还没测出来）时返回空串，面板上不留一道空白。
 *
 * @param {object} [stats]
 * @param {number} [stats.firstTokenMs] 首响耗时（毫秒，0 表示还没测到）
 * @param {number} [stats.speed] 输出速度（字/秒，0 表示还没算出来）
 * @returns {string} 空串，或形如 ` · 首响 1.2 s · 30.4 字/s`
 */
export function footStatsText({ firstTokenMs = 0, speed = 0 } = {}) {
  const parts = [];
  if (firstTokenMs) {
    const s = firstTokenMs / 1000;
    parts.push(`首响 ${s < 10 ? s.toFixed(1) : Math.round(s)} s`);
  }
  if (speed) parts.push(`${speed < 100 ? speed.toFixed(1) : Math.round(speed)} 字/s`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/**
 * 这一轮的输出速度（字/秒）；样本不够就返回 0 表示「不报」。
 *
 * 两条门槛是原来就有的，不是这里的发明：
 *  - 没有首响时间、或整轮不足 40 字：短回答算速度没有意义（还容易被抖成天文数字）；
 *  - 扣掉首响之后不足 0.2 秒：分母太小，除出来的东西不可信。
 *
 * 调用方拿到 0 就**不要覆盖**上一次的 speed（「没算出来」不等于「速度为零」）。
 *
 * @param {object} [sample]
 * @param {number} [sample.firstTokenMs] 首响耗时（毫秒）
 * @param {number} [sample.charCount] 这一轮已经吐出的字数
 * @param {number} [sample.elapsedMs] 从本轮起点到现在的毫秒数（performance.now() - turnStart）
 * @returns {number} 字/秒；不满足门槛时是 0
 */
export function speedOf({ firstTokenMs = 0, charCount = 0, elapsedMs = 0 } = {}) {
  if (!firstTokenMs || !(charCount > 40)) return 0;
  const seconds = (elapsedMs - firstTokenMs) / 1000;
  if (!(seconds > 0.2)) return 0;
  return charCount / seconds;
}

/**
 * 思考时长的人话写法：不足 1 秒不值得报数，统一说「思考」。
 *
 * 1 秒以上：不足 10 秒带一位小数（`思考了 1.2 秒`），10 秒以上报整秒（`思考了 12 秒`）。
 * 历史回放里没有真实时长，调用方直接写「思考」。
 *
 * @param {number} sec 秒数
 * @returns {string}
 */
export function thinkLabel(sec) {
  if (!(sec >= 1)) return '思考';
  return `思考了 ${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒`;
}
