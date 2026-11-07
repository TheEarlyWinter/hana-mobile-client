/**
 * 日报卡片托管：把宿主烘焙好的 HTML 卡片按条目与版本暴露给手机前端。
 *
 * 公开路径是 /gw/feed/<itemId>/r<revision>/...；客户端不传本机路径，网关只按固定
 * 目录 HANA_HOME/feed/items/<id>/card/r<N> 定位。realpath 之后要求目录仍在 feed 根内，
 * 而且正好是「这个条目这个版本」——软链接指向别的条目或 feed 根之外一律拒绝。
 *
 * 鉴权、Cookie/令牌、CSP 与流式响应都复用 card-host 的共享内核，这里只解析路由。
 */

import path from 'node:path';
import { HANA_HOME } from './config.mjs';
import { pathKey, realpathOrNull, resolveInsideRoots } from './file-utils.mjs';
import { serveCardDirectory } from './card-host.mjs';

/** 宿主 wire 的条目 ID：fi_ + 26 位 Crockford ULID（不含 I/L/O/U）。 */
const FEED_ITEM_ID_RE = /^fi_[0-9A-HJKMNP-TV-Z]{26}$/;
/** 版本段固定 r 加正整数；r0、r01、r-1 都不是合法版本。 */
const FEED_REVISION_RE = /^r[1-9][0-9]{0,8}$/;
const FEED_PREFIX = '/gw/feed/';
/** 烘焙卡片的固定根：HANA_HOME/feed/items/<id>/card/r<N>。 */
const FEED_ITEMS_ROOT = path.join(HANA_HOME, 'feed', 'items');

function refuse(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
}

/**
 * 解析 feed 卡片目录：先按字面路径过白名单，再核对 realpath 是否正好落在
 * 「这个 itemId 的 card/rN」。返回 { ok:true, dirReal } 或 { ok:false, status, message }。
 */
async function resolveFeedCardDirectory(itemId, revision) {
  const requested = path.join(FEED_ITEMS_ROOT, itemId, 'card', `r${revision}`);
  const dirCheck = await resolveInsideRoots(requested, [FEED_ITEMS_ROOT], 'feed card root not allowed');
  if (!dirCheck.realPath) return { ok: false, status: dirCheck.status, message: dirCheck.message };

  const rootReal = await realpathOrNull(FEED_ITEMS_ROOT);
  if (!rootReal) return { ok: false, status: 404, message: '404' };
  // 别名判定：软链接把别人的 card/rN 挂到本条目的路径下时，真实路径还在 feed 根里，
  // 但已经不是这个 itemId 的目录——只有完全相等才放行。
  const expected = pathKey(path.join(rootReal, itemId, 'card', `r${revision}`));
  if (pathKey(dirCheck.realPath) !== expected) {
    return { ok: false, status: 403, message: 'feed card root not allowed' };
  }
  return { ok: true, dirReal: dirCheck.realPath };
}

/**
 * /gw/feed/ 的入口：只收 fi_ ULID 与 r<正整数>，其余一律 400。
 * 路径先同步解析，再交给共享内核（内核在任何 await 之前捕获 logout epoch）。
 */
export async function serveFeedCard(req, res, pathname) {
  const rest = pathname.startsWith(FEED_PREFIX) ? pathname.slice(FEED_PREFIX.length) : '';
  const parts = rest.split('/');
  const itemId = parts[0] || '';
  const revisionSegment = parts[1] || '';
  if (!FEED_ITEM_ID_RE.test(itemId) || !FEED_REVISION_RE.test(revisionSegment)) {
    refuse(res, 400, 'bad feed card id');
    return;
  }
  const revision = Number(revisionSegment.slice(1));
  const resourcePath = parts.slice(2).join('/');

  return serveCardDirectory(req, res, {
    routeBase: `${FEED_PREFIX}${itemId}/${revisionSegment}/`,
    resourcePath,
    resolveDirectory: () => resolveFeedCardDirectory(itemId, revision),
  });
}
