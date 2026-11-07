/* web/download.js — App 内唯一的下载入口
 *
 * 真机事实（不要凭直觉改）：
 *   - WebView 里 `<a download>` 的 download 属性被忽略：点击只会变成一次普通导航，
 *     文件名由响应头决定；拿不到响应头时只能截 URL 末段，于是落到 content-xxx.bin；
 *   - 壳自己也会拦下载：MainActivity.handleDownloadStart 只放行
 *     /api/mobile/workspace/content（isWorkspaceContentUrl），别的地址一律弹
 *     「只允许下载同源 workspace content 文件」。
 *
 * 所以「下载」在这里只有一种实现：用壳认的地址做一次同源导航，让网关的
 * Content-Disposition 决定文件名。非白名单地址不导航——宁可不下载，也不要让用户
 * 点了以后撞一个必错的对话框。
 *
 * 纯函数 + 显式注入 location，方便在 node 里直接测。
 */

/** 壳唯一放行的下载路径（与 android MainActivity.isWorkspaceContentUrl 对齐）。 */
export const MOBILE_DOWNLOAD_PATH = '/api/mobile/workspace/content';

/**
 * 这个地址壳会不会放行下载。
 *
 * 规则与壳保持一致：同源、路径完全等于 /api/mobile/workspace/content、允许查询串、
 * 不允许 #fragment（壳那边带 fragment 直接判否）。
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isMobileDownloadUrl(url) {
  if (typeof url !== 'string' || !url) return false;

  let path = url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    // 绝对地址：壳只认同源，这里先按同源筛一遍，别把跨站地址递过去。
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const origin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : '';
    if (origin && parsed.origin !== origin) return false;
    path = `${parsed.pathname}${parsed.search}`;
  }

  if (path.includes('#')) return false;
  const queryAt = path.indexOf('?');
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  return pathname === MOBILE_DOWNLOAD_PATH;
}

/**
 * 触发一次下载。
 *
 * @param {string} url 必须是壳白名单内的同源地址
 * @param {object} [opts]
 * @param {{href: string}} [opts.location=globalThis.location] 导航目标
 * @param {(url: string) => void} [opts.onReject] 地址不可下载时的回调（给用户一句话）
 * @returns {boolean} 是否真的发起了导航
 */
export function startDownload(url, { location = globalThis.location, onReject = null } = {}) {
  if (!isMobileDownloadUrl(url)) {
    if (typeof onReject === 'function') onReject(typeof url === 'string' ? url : '');
    return false;
  }
  if (!location) return false;
  location.href = url;
  return true;
}
