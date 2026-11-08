/**
 * 会话文件托管：历史消息里的图片可能只存了路径，前端需要取回原图；
 * 会话文件卡里的文档（pdf/docx/xlsx/pptx/txt/md/csv/json/log）同样只有绝对路径可读。
 *
 * 可读范围 = HANA_HOME 下三个白名单目录 + 当前 Cookie 对应的工作区根（见 file-roots.mjs）。
 * 路径一律先 realpath 再比根，防止软链接/junction 把「看着在白名单里」的路径指到外面。
 *
 * 为什么文档必须走这条路：宿主对 agent 生成/外部存储的文件（storageKind: "external"）
 * 在 `/api/resources/<fileId>/content` 上回 400，手机端只有按路径读这一种办法。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkReadAuth, denyRead } from './upstream-access.mjs';
import { fileRoots } from './file-roots.mjs';
import { MIME, b64urlDecode, resolveInsideRoots, streamFileResponse } from './file-utils.mjs';

/** 图片原样保留（前端 <img> 直接用）。 */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']);

/** 预览面板能直接读的文档：xlsx/pptx/pdf 有内置预览，其余按文本/兜底处理。 */
const DOC_EXT = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json', '.log']);

const FILE_ALLOWED_EXT = new Set([...IMAGE_EXT, ...DOC_EXT]);

/** 文档下载名：ASCII 兜底 + RFC 5987 的 filename*，中文名不会乱码。 */
function inlineDisposition(name) {
  // encodeURIComponent 之后还留着 ' ( ) * 四个字符，它们不在 RFC 5987 的 attr-char 里。
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // 老客户端只认 filename=：给一个纯 ASCII 的替身，不参与实际解码。
  const ascii = name.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

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

  // 工作区根要带这个请求自己的 Cookie 去问；取不到就只有 HANA_HOME 三个根（不报错、不 500）。
  const roots = await fileRoots(req.headers.cookie);

  const fileCheck = await resolveInsideRoots(requested, roots, 'file root not allowed');
  if (!fileCheck.realPath) {
    res.writeHead(fileCheck.status, { 'content-type': 'text/plain; charset=utf-8' }).end(fileCheck.message);
    return;
  }
  const realPath = fileCheck.realPath;

  const ext = path.extname(realPath).toLowerCase();
  if (!FILE_ALLOWED_EXT.has(ext)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('file type not allowed');
    return;
  }

  // 会话图片/文档也可能很大：GET 直接流式发出，HEAD 只回元数据，不把整份文件读进内存。
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
    // 按扩展名放行的是固定的字节：别让浏览器再猜一次类型。
    'x-content-type-options': 'nosniff',
  };
  if (!IMAGE_EXT.has(ext)) {
    headers['content-disposition'] = inlineDisposition(path.basename(realPath));
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  await streamFileResponse(res, realPath, headers, stat.size);
}
