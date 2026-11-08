/**
 * 静态文件服务的公共部件：MIME 表与路径包含判定。
 *
 * 卡片托管、会话图片、前端静态资源三条路都要回答同一个问题——「这个真实路径还在
 * 白名单目录里吗」。答案只能有一份，否则迟早有一条路忘了 realpath。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  // 会话文件卡里的文档（/gw/file 按路径读）：类型必须说准，预览面板按它分流。
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};

/** 路径里的 base64url 段解码（卡片 id 与会话文件 id 都用它）。 */
export function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

/** 比较用路径键：Windows 大小写不敏感，并去掉尾部反斜杠。 */
export function pathKey(p) {
  let s = path.resolve(p);
  if (process.platform === 'win32') s = s.toLowerCase();
  while (s.length > 1 && s.endsWith(path.sep)) s = s.slice(0, -1);
  return s;
}

export function isInsideRoot(target, root) {
  const t = pathKey(target);
  const r = pathKey(root);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * 流式发一个文件：先打开、再写头，文件打不开时还能回 404（不会发出半个 200）。
 * 客户端中途断开就销毁读取流，fd 随流关闭；读一半出错只能断开连接，
 * 不再改状态码，也不把异常抛回调用方。
 *
 * 调用方负责 stat 与 content-length，这里只发 200；传了 length 就只读这么多字节，
 * 文件在 stat 之后变大也不会发出超过 content-length 的正文；stat 时是 0 字节的，
 * 打开确认可读后直接结束、不读正文（文件在这期间长出来的内容也不能发）。
 * 反过来文件在 stat 之后变短，读流会提前结束；此时断开连接，不能让客户端
 * 按 content-length 干等永远不来的字节。
 * 卡片 HTML 不适用：它要先注入 runtime 并计算源版本，必须整文件读取。
 */
export async function streamFileResponse(res, filePath, headers, length) {
  // 客户端可能在鉴权/排队期间就已经走了；别再为它打开文件。
  if (res.destroyed || res.writableEnded) return false;
  const stream =
    length > 0
      ? fs.createReadStream(filePath, { start: 0, end: length - 1 })
      : fs.createReadStream(filePath, { start: 0 });
  // 常驻 error 监听先挂上：open 之后、pipe 之前没有空窗期，读错误不会变成未捕获异常。
  stream.on('error', () => {
    if (res.headersSent) res.destroy();
  });
  const opened = await new Promise((resolve) => {
    stream.once('open', () => resolve(true));
    stream.once('error', () => resolve(false));
  });
  if (!opened) {
    stream.destroy();
    if (!res.headersSent) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    }
    return false;
  }
  // 客户端关页面/取消下载：立刻停读，不把整个文件读完再丢。
  if (res.destroyed) {
    stream.destroy();
    return false;
  }
  // stat 时是 0 字节：打开成功只用来证明「可读」，不发正文。若在 stat 之后文件长出了
  // 内容，无界读流会把它们发到一个声明 content-length: 0 的响应里，客户端无法解析。
  if (length === 0) {
    stream.destroy();
    res.writeHead(200, headers).end();
    return true;
  }
  res.once('close', () => {
    if (!res.writableFinished) stream.destroy();
  });
  res.writeHead(200, headers);
  // 手动收尾：正常读完才 end；读到的字节少于 stat 声明时直接断开。
  // 若交给 pipe 自动 end，keep-alive 客户端会按 content-length 等永远不来的字节。
  stream.once('end', () => {
    if (res.destroyed) return;
    if (typeof length === 'number' && stream.bytesRead < length) res.destroy();
    else res.end();
  });
  stream.pipe(res, { end: false });
  return true;
}

export async function realpathOrNull(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/**
 * 软链接/junction 能把「看着在白名单里」的路径指到外面，所以必须先 realpath 再比较；
 * 根也要 realpath（root 自己是指向别处的链接时，以它的目标为界）。
 * 返回 { realPath } 或 { status, message }。
 */
export async function resolveInsideRoots(requested, roots, deniedMessage) {
  // 先按字面路径挡一道：不存在的越界路径也回 403，不拿 404/403 泄漏「外面有没有这个文件」
  if (!roots.some((root) => isInsideRoot(requested, root))) {
    return { status: 403, message: deniedMessage };
  }

  const realTarget = await realpathOrNull(requested);
  if (!realTarget) return { status: 404, message: '404' };

  const realRoots = (await Promise.all(roots.map((root) => realpathOrNull(root)))).filter(Boolean);
  if (!realRoots.some((root) => isInsideRoot(realTarget, root))) {
    return { status: 403, message: deniedMessage };
  }
  return { realPath: realTarget };
}
