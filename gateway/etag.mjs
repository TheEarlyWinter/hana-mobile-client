/**
 * `If-None-Match` 的比较规则。
 *
 * 单独放在这里，是因为它已经有两个使用者（静态产物、头像），而「静态文件服务器 import
 * 头像模块」这种依赖方向是不该出现的：一方只是想让另一方用同一个比较函数，却被迫把
 * 整条头像抓取链路（含上游请求、缓存、并发控制）拖进静态资源的依赖图。
 *
 * 规则：我们只发弱 etag（`W/"..."`），所以一律按 RFC 的弱比较处理——
 * 去掉 `W/` 与引号后比字面量；另外客户端可能回 `*`（任意命中）或逗号列表（任一项命中）。
 * 不实现 `If-Modified-Since`：本项目从不发 `Last-Modified`。
 */

/** 去掉 `W/` 前缀与首尾引号，只留可比的值。 */
function etagToken(value) {
  return String(value).trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/**
 * @param {string|undefined|null} headerValue `If-None-Match` 原值
 * @param {string} etag 响应里发出的 etag
 * @returns {boolean}
 */
export function etagMatches(headerValue, etag) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return false;
  const target = etagToken(etag);
  for (const part of headerValue.split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (token === '*') return true;
    if (etagToken(token) === target) return true;
  }
  return false;
}
