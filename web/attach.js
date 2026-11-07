/* attach.js — 图片附件 + 会话文件附件 *
 * 协议事实（从 hana-server bundle 逆向，别凭直觉改）：
 *   WS `prompt` 帧接受 images: [{ mimeType, data }]，data 是**裸 base64**（不带 data: 前缀）。
 *   上限：一次最多 10 张；单张 base64 字符串 ≤ 20MB；mimeType 只认
 *   png / jpeg / gif / webp；服务端会按文件头重新嗅探格式，声明的值只做粗筛。
 *   图片不走上传接口，直接内联在帧里发，省一次往返。
 *
 *   非图片附件只有一条路：先 POST /api/upload-blob 传成一个**会话文件**（拿 fileId），
 *   再把 fileId 放进帧的 `sessionFileRefs`。宿主会把它展开成 prompt 正文里的
 *   `[SessionFile] {"fileId":…}` 行，模型再用 fileId 去读。帧里**没有** documents 字段，
 *   也没有别的内联文档通道——所以这里必须是「先上传再引用」，不能把字节塞进 text。
 *   视频只有内联通道（videos，≤3 个、每个 base64 ≤20MB），没有上传接口，这条不接。
 *
 * 所以本模块干三件事：
 *   1. 把手机相册里的大图压到能接受的大小（长边 1568、JPEG），别把 6MB 的原图塞进 WS；
 *   2. 把文档/音频传成会话文件，交回 fileId；
 *   3. 从历史消息的 content 块里把图片和文件引用挑出来，统一成能显示的形式。
 */

// 引用块解析是个叶工具（自己不 import 任何模块）；这里只借它拆文本，
// 不构成「功能模块互相依赖」——装配仍只在 app.js。
import { parseReferenceBlocks } from './reference-block.js';

export const MAX_IMAGES = 10;
export const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_BASE64_CHARS = 20 * 1024 * 1024;


/* ------------------------------------------------------------------ */
/* 会话文件（文档 / 音频）                                              */
/* ------------------------------------------------------------------ */

/** 一条消息最多带几个文件。宿主 upload-blob 单次也是 9 个 blob，取同一个数。 */
export const MAX_FILES = 9;
/** 宿主对文档/压缩包的 base64 上限：12MB **字符**（不是字节）。 */
export const MAX_FILE_BASE64_CHARS = 12 * 1024 * 1024;
/** 12MB 字符的 base64 正好装 9MB 原始字节（4*ceil(n/3) ≤ 12582912 ⇔ n ≤ 9437184）。 */
export const MAX_FILE_BYTES = 9 * 1024 * 1024;
/** 字节 → 会话文件的上传入口。 */
export const UPLOAD_BLOB_PATH = '/api/upload-blob';

/**
 * 文件项在托盘里的「已就绪」标记。
 *
 * 为什么占着 base64 这个字段：发送管线（send-controller 的 ready/stillWorking、
 * app.js 首页流程的 homeReady）都用 `a.base64` 判「这条附件处理完没有」。文件不收
 * 字节，但不给真值就会被当成「还在处理」而把整条消息拦下来。真正的发送依据是
 * fileId：buildPromptFrame 只看 fileId，没上传完的文件不会被放进 sessionFileRefs。
 */
export const FILE_READY_FLAG = 'file';

/**
 * 宿主 upload-blob 认的文件类型（bundle 里 bIn 那张表 + 音频白名单）。
 * 一种都不多：宿主对表外的 mimeType 直接返回 `unsupported mimeType`。
 */
export const ALLOWED_FILE_MIMES = Object.freeze([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/json',
  'application/rtf',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
]);

/** 宿主按 mime 反查的规范扩展名：对不上就会把文件名改掉，所以拿它判「能不能原样报这个 mime」。 */
const MIME_EXT = Object.freeze({
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'application/json': '.json',
  'application/rtf': '.rtf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
});

/** 扩展名 → 上传时用的 mime（浏览器给空 type / octet-stream 时靠它）。 */
const EXT_MIME = Object.freeze({
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  xml: 'text/xml',
  json: 'application/json',
  rtf: 'application/rtf',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
});

/**
 * 宿主不认、或认了会把文件名改成 .txt 的常见文本/代码/配置/压缩包扩展名。
 * 统一按 application/octet-stream 上传：宿主对兜底类型保留原文件名，模型也拿得到扩展名。
 */
const EXT_OCTET = new Set([
  // 代码
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'php', 'lua', 'pl', 'r', 'm', 'mm',
  'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'vue', 'svelte', 'astro',
  // 脚本 / 标记 / 配置
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss',
  'sass', 'less', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
  'gradle', 'lock', 'log', 'diff', 'patch', 'proto', 'graphql', 'gql', 'tex', 'bib',
  'srt', 'vtt', 'ass', 'vtt', 'webmanifest', 'plist',
  // 压缩包 / 办公文档（宿主只认 zip，其余按二进制兜底，文件名不变）
  '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'odt', 'ods', 'odp',
]);

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/** 宿主 upload-blob 收不收这个 mimeType（只做表比对，不做文件头嗅探）。 */
export function isAllowedFileMime(mime) {
  return ALLOWED_FILE_MIMES.includes(normalizeMime(mime));
}

/** 托盘里的文件项：kind === 'file'。图片项没有 kind。 */
export function isFileAttachment(a) {
  return !!a && typeof a === 'object' && a.kind === 'file';
}

/**
 * 决定上传时报什么 mimeType。
 * 浏览器给的 type 常常是空串、application/octet-stream，或者宿主不认的值
 * （text/javascript、text/x-markdown、application/x-zip-compressed…）；而宿主会按 mime
 * 反查扩展名重命名文件（text/plain 的 a.py 进去就成 a.py.txt），所以只有「浏览器给的
 * 类型和扩展名对得上」时才原样用，其余一律按扩展名查表。
 * @returns {{ok: true, mimeType: string}|{ok: false, reason: string}}
 */
export function resolveFileMime(file) {
  const name = typeof file?.name === 'string' ? file.name : '';
  const ext = extOf(name);
  const declared = normalizeMime(file?.type);

  if (declared && isAllowedFileMime(declared)) {
    const canonical = (MIME_EXT[declared] || '').replace('.', '');
    if (!ext || canonical === ext) return { ok: true, mimeType: declared };
  }
  if (EXT_MIME[ext]) return { ok: true, mimeType: EXT_MIME[ext] };
  if (EXT_OCTET.has(ext)) return { ok: true, mimeType: 'application/octet-stream' };
  if (!ext) return { ok: false, reason: '认不出这是什么文件' };
  return { ok: false, reason: `不支持这种文件类型（.${ext}）` };
}

/** 单文件体积校验。返回 null 表示可以发，否则给用户看一句话。 */
export function fileSizeProblem(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0 || n <= MAX_FILE_BYTES) return null;
  return `文件超过 ${formatBytes(MAX_FILE_BYTES)}，换个小一点的再发`;
}

/** 文件角标文字：report.pdf → PDF */
export function fileBadge(name) {
  const ext = extOf(name);
  return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
}

/**
 * 把托盘里的文件项整理成帧里的 sessionFileRefs。
 * 只收已有 fileId 的（没上传成功的文件绝不能出现在帧里）；同一 fileId 只留一条。
 */
export function buildSessionFileRefs(attachments, { sessionId = null, sessionPath = null } = {}) {
  const refs = [];
  const seen = new Set();
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!isFileAttachment(a)) continue;
    const fileId = typeof a.fileId === 'string' ? a.fileId.trim() : '';
    if (!fileId || seen.has(fileId)) continue;
    seen.add(fileId);
    const sp = a.sessionPath || sessionPath;
    const si = a.sessionId || sessionId;
    refs.push({
      fileId,
      label: a.name || fileId,
      kind: 'attachment',
      ...(sp ? { sessionPath: sp } : {}),
      ...(si ? { sessionId: si } : {}),
    });
    if (refs.length >= MAX_FILES) break;
  }
  return refs;
}

/** File → 裸 base64（不带 data: 前缀）。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = dataUrlToBase64(String(reader.result || ''));
      if (b64) resolve(b64);
      else reject(new Error('读不出文件内容'));
    };
    reader.onerror = () => reject(new Error('读文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 宿主 upload-blob 的错误串（英文）→ 给用户看的中文。 */
function uploadErrorMessage(raw) {
  const msg = typeof raw === 'string' ? raw : '';
  if (!msg) return '上传失败，宿主没有说明原因';
  if (/unsupported mimeType/i.test(msg)) return '宿主不接受这种文件格式';
  if (/too large/i.test(msg)) return `文件超过 ${formatBytes(MAX_FILE_BYTES)}`;
  if (/empty blob/i.test(msg)) return '文件是空的，没有内容可传';
  if (/base64Data required/i.test(msg)) return '读不出文件内容';
  return `上传失败：${msg}`;
}

/**
 * 把一个文件传成会话文件，返回它的 fileId。
 * 上传是**必须**的：prompt 帧里没有内联文档通道，模型只能靠 fileId 去读。
 * @param {File|Blob} file
 * @param {{ api: Function, sessionPath: string, name?: string, mimeType?: string }} options
 * @returns {Promise<{fileId: string, name: string, mimeType: string, bytes: number}>}
 */
export async function uploadSessionFile(file, { api, sessionPath, name, mimeType } = {}) {
  if (typeof api !== 'function') throw new TypeError('uploadSessionFile requires { api }');
  const session = typeof sessionPath === 'string' ? sessionPath.trim() : '';
  if (!session) throw new Error('还没有会话，文件得等发送时再传');

  const fileName = name || file?.name || 'file';
  const resolved = mimeType || resolveFileMime(file).mimeType;
  if (!isAllowedFileMime(resolved)) throw new Error(`宿主不接受这种文件格式：${resolved || '未知'}`);

  const tooBig = fileSizeProblem(file?.size);
  if (tooBig) throw new Error(tooBig);

  const base64Data = await fileToBase64(file);
  if (base64Data.length > MAX_FILE_BASE64_CHARS) throw new Error(`文件超过 ${formatBytes(MAX_FILE_BYTES)}`);

  const body = await api(UPLOAD_BLOB_PATH, {
    method: 'POST',
    body: JSON.stringify({
      sessionPath: session,
      name: fileName,
      base64Data,
      mimeType: resolved,
      presentation: 'attachment',
    }),
  }).catch((err) => {
    // 超时不是宿主的拒绝，别把它报成「宿主不接受」
    if (err?.code === 'timeout') {
      throw new Error(`上传超时（${formatBytes(Number(file?.size) || 0)}），换个网络或换小一点的再试`);
    }
    throw err;
  });

  const upload = Array.isArray(body?.uploads) ? body.uploads[0] : null;
  if (!upload || upload.error) throw new Error(uploadErrorMessage(upload?.error));
  const fileId = typeof upload.fileId === 'string' ? upload.fileId.trim() : '';
  if (!fileId) throw new Error('宿主没有返回文件 ID，这次上传不算成功');

  return {
    fileId,
    name: upload.name || fileName,
    mimeType: upload.mime || resolved,
    bytes: Number(upload.size) || Number(file?.size) || 0,
  };
}

/** 长边上限。再大模型侧也会压，先压省带宽。 */
export const MAX_EDGE = 1568;
/** 小于这个体积且尺寸不超标就原样发，避免二次编码掉画质。 */
export const KEEP_BELOW_BYTES = 1.2 * 1024 * 1024;
export const JPEG_QUALITY = 0.86;

const MIME_ALIAS = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

/* ------------------------------------------------------------------ */
/* 纯函数（tests/attach.test.mjs 覆盖）                                 */
/* ------------------------------------------------------------------ */

export function normalizeMime(mime) {
  const s = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
  if (!s) return '';
  return MIME_ALIAS[s] || s;
}

export function isAllowedImageMime(mime) {
  return ALLOWED_IMAGE_MIMES.includes(normalizeMime(mime));
}

/** 等比缩放到长边不超过 maxEdge。返回整数像素，最小的边保底 1px。 */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return { width: 0, height: 0, scale: 1, resized: false };
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: Math.round(w), height: Math.round(h), scale: 1, resized: false };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
    resized: true,
  };
}

/** base64 的字符数换算回字节数（用于和 20MB 上限对比）。 */
export function base64Bytes(b64) {
  if (typeof b64 !== 'string' || !b64) return 0;
  let end = b64.length;
  while (end > 0 && b64[end - 1] === '=') end -= 1;
  return Math.floor((end * 3) / 4);
}

/** data:image/png;base64,xxx → xxx */
export function dataUrlToBase64(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  return dataUrl.slice(comma + 1);
}

/** 从 data URL 里取 mimeType，取不到给空串。 */
export function dataUrlMime(dataUrl) {
  const m = /^data:([^;,]+)[;,]/.exec(typeof dataUrl === 'string' ? dataUrl : '');
  return m ? normalizeMime(m[1]) : '';
}

/** 服务端要的是裸 base64，历史里可能存成 data URL，统一一下。 */
export function toBareBase64(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s) return '';
  return s.startsWith('data:') ? dataUrlToBase64(s) : s;
}

/**
 * 从一条图片内容块里取出 { data, mimeType }。
 * 兼容两种历史写法：
 *   { type:'image', data, mimeType }
 *   { type:'image', source:{ type:'base64', media_type, data } }
 * 取不到数据返回 null。
 */
export function imageBlockData(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'image' && block.type !== 'input_image') return null;
  const raw = block.data || block.source?.data || block.base64 || '';
  const data = toBareBase64(raw);
  if (!data) return null;
  const mimeType = normalizeMime(block.mimeType || block.mime_type || block.source?.media_type) || 'image/png';
  return { data, mimeType };
}

/** 历史消息里的 `[attached_image: <绝对路径>]` 标记：服务端把图存成这个文本占位。 */
const ATTACHED_IMAGE_RE = /\[attached_image:\s*([^\]]+?)\s*\]/gi;

/**
 * 平台塞给模型的机器提示块，桌面端也不展示。
 * 它要么单独成块，要么隔着空行贴在正文后面，两种都要能认。
 */
const HANA_REFERENCE_RE = /^\s*\[hana_reference\][\s\S]*?\[\/hana_reference\]\s*$/;

/**
 * 用户附件的文本标记（从桌面端粘过来的文件引用）：
 *   [SessionFile] {"fileId":"sf_…","label":"粘贴图片.jpg","kind":"attachment"}
 * JSON 必须在行尾闭合；非贪婪，避免一口吃掉后面的正文。
 */
const SESSION_FILE_RE = /^\[SessionFile\]\s+(\{[\s\S]*?\})\s*$/gm;

function parseSessionFileRef(jsonText) {
  let o;
  try { o = JSON.parse(jsonText); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const fileId = typeof o.fileId === 'string' ? o.fileId.trim() : '';
  if (!fileId) return null;
  return {
    fileId,
    label: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : fileId,
    kind: typeof o.kind === 'string' ? o.kind : 'attachment',
  };
}

function mimeFromPath(p) {
  const ext = String(p).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'bmp') return 'image/bmp';
  return '';
}

/**
 * 把一条用户消息的内容拆成文字、图片和文件引用。
 * @param {string|Array} content
 * @param {{ fileUrl?: (p:string)=>string|null, resourceUrl?: (id:string)=>string|null }} [opts]
 * @returns {{ text: string, images: Array<object>, files: Array<{fileId:string,label:string,kind:string}> }}
 */
export function splitUserContent(content, opts = {}) {
  const textParts = [];
  const images = [];
  const blocks = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : []);

  for (const b of blocks) {
    if (!b) continue;
    if (typeof b === 'string') {
      textParts.push(b);
      continue;
    }
    const img = imageBlockData(b);
    if (img) {
      images.push({
        src: `data:${img.mimeType};base64,${img.data}`,
        name: b.name || b.filename || '',
        mimeType: img.mimeType,
        bytes: base64Bytes(img.data),
      });
      continue;
    }
    if (typeof b.text === 'string' && b.type !== 'thinking' && b.type !== 'reasoning') {
      textParts.push(b.text);
    }
  }

  // 引用块不再丢弃：宿主把引用内容以 [hana_reference] … 注入用户消息，
  // 以前这里直接过滤掉，导致桌面看得到的引用在手机上完全不见。
  // 现在摘出来交给渲染器画成卡片，正文里不残留标记。
  const referenceParsed = parseReferenceBlocks(textParts.join('\n'));
  const references = referenceParsed.references;
  let text = referenceParsed.text.trim();

  // 历史里图片可能是 `[attached_image: C:\...\upload-xxx.png]` 这种文本占位，
  // 能取到网关地址就渲染成图，取不到才把标记留在正文里（至少不是静默丢图）。
  // 只删标记本身：正文的换行、缩进、连续空格是用户写的，不能拿 `\s{2,}` 一律压成单个空格
  // （那样会把整条消息的排版铲平，连没映射成功的标记也一起铲）。
  const marked = [...text.matchAll(ATTACHED_IMAGE_RE)];
  if (marked.length) {
    text = text
      .replace(ATTACHED_IMAGE_RE, (whole, rawPath) => {
        const p = String(rawPath).trim();
        const url = typeof opts.fileUrl === 'function' ? opts.fileUrl(p) : null;
        if (!url) return whole;
        images.push({
          src: url,
          name: p.split(/[\\/]/).pop() || '',
          mimeType: mimeFromPath(p) || 'image/png',
          bytes: 0,
        });
        return '';
      })
      .trim();
  }

  const extracted = extractSessionFiles(text, images, opts);
  return { text: extracted.text, images, files: extracted.files, references };
}

/**
 * 抽走 `[SessionFile] {...}` 标记。能当图片显示的就归到 images，其余变成文件引用。
 * 返回改写后的 text（字符串是不可变的，必须把结果传回去）。
 */
function extractSessionFiles(text, images, opts) {
  const files = [];
  if (!text.includes('[SessionFile]')) return { text, files };

  const refs = [];
  for (const m of text.matchAll(SESSION_FILE_RE)) {
    const ref = parseSessionFileRef(m[1]);
    if (ref) refs.push(ref);
  }
  if (!refs.length) return { text, files };

  text = text.replace(SESSION_FILE_RE, '').replace(/\n{3,}/g, '\n\n').trim();

  for (const ref of refs) {
    const mime = mimeFromPath(ref.label);
    const url = mime && typeof opts.resourceUrl === 'function' ? opts.resourceUrl(ref.fileId) : null;
    // 手上还没有图、而这条引用本身就是图片，就直接当图显示；否则留成文件条
    if (url && !images.length) {
      images.push({ src: url, name: ref.label, mimeType: mime, bytes: 0 });
      continue;
    }
    files.push(ref);
  }
  return { text, files };
}

/**
 * 把消息上的 attachments 数组（服务端存的路径式附件）转成可显示的图片。
 * 有内联 base64 就用内联；只有路径就走网关的文件路由。
 */
export function imagesFromAttachments(attachments, opts = {}) {
  const out = [];
  if (!Array.isArray(attachments)) return out;
  for (const a of attachments) {
    if (!a || typeof a !== 'object') continue;
    if (a.isDirectory || a.isDir) continue;
    const mimeType = normalizeMime(a.mimeType || a.mime || '');
    if (!mimeType.startsWith('image/')) continue;

    const inline = toBareBase64(a.base64Data || a.data || '');
    if (inline) {
      out.push({ src: `data:${mimeType};base64,${inline}`, name: a.name || '', mimeType, bytes: base64Bytes(inline) });
      continue;
    }
    const p = a.path || a.realPath || a.filePath || '';
    const url = p && typeof opts.fileUrl === 'function' ? opts.fileUrl(p) : null;
    if (url) out.push({ src: url, name: a.name || '', mimeType, bytes: Number(a.size) || 0 });
  }
  return out;
}

/**
 * 发送前的整体校验。返回 null 表示没问题，否则返回给用户看的一句话。
 * 图片和文件的额度分开算：图片有宿主的 10 张/20MB 限制，文件是另一套（9 个 + 9MB）。
 * 入参里的文件项只需要 mimeType（发送管线只透传 mimeType + base64）。
 */
export function validateForSend(images) {
  if (!Array.isArray(images) || !images.length) return null;

  const imageList = images.filter((a) => normalizeMime(a?.mimeType).startsWith('image/'));
  const fileList = images.filter((a) => !normalizeMime(a?.mimeType).startsWith('image/'));

  if (fileList.length > MAX_FILES) return `一次最多发 ${MAX_FILES} 个文件`;
  for (const f of fileList) {
    if (!isAllowedFileMime(f?.mimeType)) return `不支持的文件格式：${f?.mimeType || '未知'}`;
  }

  if (!imageList.length) return null;
  if (imageList.length > MAX_IMAGES) return `一次最多发 ${MAX_IMAGES} 张图片`;
  let total = 0;
  for (const img of imageList) {
    if (!isAllowedImageMime(img.mimeType)) return `不支持的图片格式：${img.mimeType || '未知'}`;
    const chars = String(img.data || '').length;
    if (chars > MAX_BASE64_CHARS) return '这张图片太大了（超过 20MB），先裁一下再发';
    total += chars;
  }
  if (total > MAX_BASE64_CHARS) return '图片总量太大了，分两次发吧';
  return null;
}

/** 1.2 MB → "1.2 MB" */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 拼出 WS 的 `prompt` 帧。
 *
 * 字段集是实测定下来的，服务端只认这几个：多加字段没用，少字段会被拒。
 * 图片直接内联在 `images` 里；文档/音频已经在发送前传成了会话文件，这里只放
 * `sessionFileRefs`（fileId），不重传字节。
 * 注意：`displayMessage` 只放 `text`，不放 attachments——图片本身已经在 content
 * 块里了，再塞一份路径只会让别的客户端渲染出空壳附件；文件引用由宿主自己展开成
 * 正文里的 `[SessionFile]` 行（历史回放时 attach.js 的 splitUserContent 再抽回来）。
 */
export function buildPromptFrame({ session, text = '', attachments = [], inputId, sessionId, sessionPath, type = 'prompt', feedItemId, feedRevision } = {}) {
  const list = (attachments || []).filter(Boolean);
  const isInlineImage = (a) => !isFileAttachment(a) && !!a.base64 && (isAllowedImageMime(a.mimeType) || !a.mimeType);
  const images = list
    .filter(isInlineImage)
    .slice(0, MAX_IMAGES)
    .map((a) => ({ mimeType: normalizeMime(a.mimeType) || 'image/jpeg', data: a.base64 }));
  const refs = buildSessionFileRefs(list, {
    sessionId: sessionId ?? session?.sessionId ?? null,
    sessionPath: sessionPath ?? session?.path ?? null,
  });

  return {
    type: type === 'steer' ? 'steer' : 'prompt',
    sessionId: sessionId ?? session?.sessionId ?? null,
    sessionPath: sessionPath ?? session?.path ?? null,
    text,
    displayMessage: { text },
    clientMessageId: inputId,
    inputId,
    ...(typeof feedItemId === 'string' && feedItemId ? { feedItemId } : {}),
    ...(Number.isSafeInteger(feedRevision) && feedRevision > 0 ? { feedRevision } : {}),
    ...(images.length ? { images } : {}),
    ...(refs.length ? { sessionFileRefs: refs } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 浏览器侧：解码 / 缩放 / 编码                                          */
/* ------------------------------------------------------------------ */

function decodeViaImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解不开'));
    img.src = src;
  });
}

async function decodeFile(file) {
  // createImageBitmap 更快，但老 WebView 上对 HEIC/大图会抛，兜一层 <img>
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, bitmap: true };
    } catch { /* 落到 <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const out = await decodeViaImg(url);
    return out;
  } finally {
    // <img> 已把像素解到内存，可以立刻释放 blob URL
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('编码失败'))), mimeType, quality);
      return;
    }
    try {
      const dataUrl = canvas.toDataURL(mimeType, quality);
      const bin = atob(dataUrlToBase64(dataUrl));
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      resolve(new Blob([buf], { type: mimeType }));
    } catch (err) {
      reject(err);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(dataUrlToBase64(String(reader.result || '')));
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 输出格式：png 保持 png（透明背景），其余一律 jpeg。gif 动图在压缩时会退成静帧。 */
function encodeMimeFor(declared) {
  return normalizeMime(declared) === 'image/png' ? 'image/png' : 'image/jpeg';
}

let localSeq = 0;

/**
 * 把用户选的文件变成可以直接发的附件对象。
 * @returns {Promise<{id,name,mimeType,base64,previewUrl,width,height,bytes,resized,originalBytes}>}
 */
export async function prepareImage(file, { maxEdge = MAX_EDGE } = {}) {
  if (!file) throw new Error('没有文件');
  const declared = normalizeMime(file.type);
  if (declared && !declared.startsWith('image/')) throw new Error('不是图片文件');

  const decoded = await decodeFile(file);
  const target = fitWithin(decoded.width, decoded.height, maxEdge);
  const originalBytes = Number(file.size) || 0;

  const canKeep = !target.resized && originalBytes <= KEEP_BELOW_BYTES && isAllowedImageMime(declared);
  let mimeType;
  let blob;

  if (canKeep) {
    mimeType = declared;
    blob = file;
  } else {
    mimeType = encodeMimeFor(declared);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('这个浏览器画不出图');
    ctx.imageSmoothingQuality = 'high';
    if (mimeType === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    blob = await canvasToBlob(canvas, mimeType, JPEG_QUALITY);
  }

  if (decoded.bitmap && typeof decoded.source.close === 'function') decoded.source.close();

  const base64 = await blobToBase64(blob);
  if (!base64) throw new Error('编码结果为空');
  if (base64.length > MAX_BASE64_CHARS) throw new Error('这张图片压完还是太大');

  localSeq += 1;
  const name = (file.name && String(file.name).trim()) || `image-${Date.now()}-${localSeq}.${mimeType.split('/')[1] || 'jpg'}`;

  return {
    id: `att-${Date.now()}-${localSeq}`,
    name,
    mimeType,
    base64,
    previewUrl: `data:${mimeType};base64,${base64}`,
    width: canKeep ? decoded.width : target.width,
    height: canKeep ? decoded.height : target.height,
    bytes: base64Bytes(base64),
    resized: !canKeep,
    originalBytes,
  };
}
