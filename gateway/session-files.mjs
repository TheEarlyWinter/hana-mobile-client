/**
 * 会话文件托管：历史消息里的图片可能只存了路径，前端需要取回原图。
 *
 * 只读 HANA_HOME 下三个白名单目录，且只放行图片扩展名；路径一律先 realpath 再比，
 * 防止软链接/junction 把「看着在白名单里」的路径指到外面。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HANA_HOME } from './config.mjs';
import { checkReadAuth, denyRead } from './upstream-access.mjs';
import { MIME, b64urlDecode, resolveInsideRoots, streamFileResponse } from './file-utils.mjs';

/** 只允许读这几个目录，且只放行图片。 */
const FILE_ALLOWED_ROOTS = [
  path.join(HANA_HOME, 'session-files'),
  path.join(HANA_HOME, 'uploads'),
  // 服务端把用户上传的原图存在 attachments/，历史消息里的
  // `[attached_image: <path>]` 标记指的就是这里。
  path.join(HANA_HOME, 'attachments'),
];

const FILE_ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']);

export async function serveSessionFile(req, res, pathname) {
  const auth = await checkReadAuth(req);
  if (!auth.ok) return denyRead(res, auth);

  let decoded;
  try {
    decoded = decodeURIComponent(pathname.slice('/gw/file/'.length));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad path');
    return;
  }

  let requested;
  try {
    requested = path.resolve(b64urlDecode(decoded.replace(/\/$/, '')));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad file id');
    return;
  }

  const fileCheck = await resolveInsideRoots(requested, FILE_ALLOWED_ROOTS, 'file root not allowed');
  if (!fileCheck.realPath) {
    res.writeHead(fileCheck.status, { 'content-type': 'text/plain; charset=utf-8' }).end(fileCheck.message);
    return;
  }
  const realPath = fileCheck.realPath;

  const ext = path.extname(realPath).toLowerCase();
  if (!FILE_ALLOWED_EXT.has(ext)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('only image files are served here');
    return;
  }

  // 会话图片也可能很大：GET 直接流式发出，HEAD 只回元数据，不把整张图读进内存。
  let stat;
  try {
    stat = await fsp.stat(realPath);
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  await streamFileResponse(res, realPath, headers, stat.size);
}
