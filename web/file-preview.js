/* file-preview.js — 会话文件预览面板
 *
 * 手机上点一张文件卡，原来什么都发生不了：WebView 没有原生 docx/pdf 渲染。
 * 这里做一个全屏抽屉，按类型给最合适的读法：
 *
 *   图片  → 直接 <img>
 *   文本  → Markdown 渲染（.md）或等宽文本（代码/日志/CSV）
 *   docx  → 解 zip 读 word/document.xml，按段落还原成可读正文
 *   其它  → 元信息 + 下载并交给系统应用
 *
 * 不引第三方库：docx 的压缩包用浏览器自带的 DecompressionStream('deflate-raw') 解，
 * inflate 之外的部分（中央目录、条目名）自己按 zip 规范读。
 */

import { isMobileDownloadUrl, startDownload } from './download.js';

const TEXT_EXTS = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'css',
  'js', 'mjs', 'ts', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'sh', 'ps1', 'sql', 'ini', 'conf',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'pptx', 'ppt', 'pdf']);

export function previewKind(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'docx') return 'docx';
  if (TEXT_EXTS.has(e)) return 'text';
  if (SHEET_EXTS.has(e)) return 'unsupported';
  return 'unknown';
}

/* ------------------------------ zip（只读） ------------------------------ */

function findEocd(view) {
  // End of central directory：签名 0x06054b50，注释最长 65535，从尾部往前找
  const max = Math.min(view.byteLength, 66_000);
  for (let i = view.byteLength - 22; i >= view.byteLength - max; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function listZipEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('不是有效的 zip');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(buffer, meta) {
  const view = new DataView(buffer);
  const at = meta.localOffset;
  if (view.getUint32(at, true) !== 0x04034b50) throw new Error('zip 条目头损坏');
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, meta.compressedSize);
  if (meta.method === 0) return new TextDecoder('utf-8').decode(raw);
  if (meta.method !== 8) throw new Error('不支持的压缩方式');
  if (typeof DecompressionStream !== 'function') throw new Error('浏览器不支持解压');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/* ------------------------------ docx ------------------------------ */

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]);
}

/**
 * docx → 段落数组 [{ text, heading }]。
 * 只读正文：w:p 分段，w:t 取字，w:tab 补制表，w:br 换行；表格按行拍平成文本。
 */
export function docxToParagraphs(xml) {
  const out = [];
  const paras = xml.split(/<w:p[ >]/).slice(1);
  for (const chunk of paras) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(chunk);
    const body = chunk.split(/<w:p[ /]/)[0];
    const text = decodeXml(
      body
        .replace(/<w:tab\s*\/>/g, '\t')
        .replace(/<w:br\s*\/>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    ).replace(/\u00a0/g, ' ');
    const trimmed = text.replace(/[ \t]+\n/g, '\n').trim();
    if (!trimmed) continue;
    const name = style ? style[1].toLowerCase() : '';
    out.push({ text: trimmed, heading: name.includes('heading') || name === 'title' });
  }
  return out;
}

async function loadDocx(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('文件读取失败（' + res.status + '）');
  const buffer = await res.arrayBuffer();
  const entries = listZipEntries(buffer);
  const target = entries.get('word/document.xml');
  if (!target) throw new Error('这个 docx 里没有正文');
  const xml = await readZipEntry(buffer, target);
  return docxToParagraphs(xml);
}

/* ------------------------------ 面板 ------------------------------ */

let sheet = null;

/* 预览代次：每次 open 换一个号，close 也递增。
 * 异步读取（fetch / 解 docx）回来时先核对代次：A 的响应晚于 B 返回不能盖掉 B 的正文，
 * 面板关掉之后迟到的响应也不能再往隐藏面板里写东西。 */
let previewGeneration = 0;

function ensureSheet() {
  if (sheet) return sheet;
  const root = document.createElement('div');
  root.className = 'file-preview';
  root.hidden = true;
  root.innerHTML = ''
    + '<div class="file-preview-backdrop"></div>'
    + '<div class="file-preview-sheet" role="dialog" aria-modal="true">'
    + '  <div class="file-preview-head">'
    + '    <div class="file-preview-title-wrap"><span class="file-preview-title"></span>'
    + '      <span class="file-preview-sub"></span></div>'
    + '    <button class="file-preview-close" type="button" aria-label="关闭">✕</button>'
    + '  </div>'
    + '  <div class="file-preview-body"></div>'
    + '</div>';
  document.body.appendChild(root);

  const close = () => {
    previewGeneration += 1;   // 在途读取全部作废，迟到响应不再写隐藏面板
    root.hidden = true;
    root.querySelector('.file-preview-body').innerHTML = '';
    document.body.classList.remove('file-preview-open');
  };
  root.querySelector('.file-preview-close').addEventListener('click', close);
  root.querySelector('.file-preview-backdrop').addEventListener('click', close);

  sheet = { root, close, title: root.querySelector('.file-preview-title'), sub: root.querySelector('.file-preview-sub'), body: root.querySelector('.file-preview-body') };
  return sheet;
}

function setBody(node) {
  const s = ensureSheet();
  s.body.innerHTML = '';
  s.body.appendChild(node);
  s.body.scrollTop = 0;
}

function note(text, action) {
  const box = document.createElement('div');
  box.className = 'file-preview-note';
  const p = document.createElement('p');
  p.textContent = text;
  box.appendChild(p);
  if (action) box.appendChild(action);
  return box;
}

function downloadButton(label, url) {
  const a = document.createElement('a');
  a.className = 'file-preview-download';
  a.href = url;
  a.setAttribute('download', label);
  a.textContent = '下载文件';
  // 下载只走 download.js：WebView 不认 <a download>，得靠导航 + Content-Disposition，
  // 而且地址必须在壳的下载白名单里。
  a.addEventListener('click', (e) => {
    e.preventDefault();
    startDownload(url);
  });
  return a;
}

/**
 * 打不开时的兜底块。只有壳认的下载地址才给下载按钮，否则只说「下不了」；
 * 正文能不能读跟下载无关：readUrl 有用时这里已经被读出来了。
 */
function fallbackNotice(message, label, downloadUrl) {
  if (!isMobileDownloadUrl(downloadUrl)) {
    return note(`${message}\n这个文件在 App 里没有可下载的地址。`);
  }
  return note(message, downloadButton(label, downloadUrl));
}

/**
 * 打开预览。
 *
 * 「读」和「下载」是两个地址：readUrl 可以是 /api/resources/<id>/content（fetch 读，壳不拦），
 * downloadUrl 只能是壳白名单里的工作区地址；没有就不渲染下载按钮，而不是给一个点了必错的入口。
 *
 * @param {object} opts
 * @param {object} opts.file       { label, ext, size }
 * @param {string} opts.readUrl    读取用的同源地址（必填，没有就不应调本函数）
 * @param {string|null} [opts.downloadUrl] 下载用的白名单地址
 * @param {(md: string) => string} [opts.renderMarkdown]
 */
export async function openFilePreview({ file, readUrl, downloadUrl = null, renderMarkdown }) {
  const s = ensureSheet();
  // 本次打开的代次：后面每个 await 回来都要核对，晚到的不能盖掉新的。
  const generation = ++previewGeneration;
  const isCurrent = () => generation === previewGeneration;
  const label = String(file?.label || '文件');
  const kind = previewKind(file?.ext);
  s.title.textContent = label;
  s.sub.textContent = [String(file?.ext || '').toUpperCase(), file?.size ? Math.round(file.size / 1024) + ' KB' : '']
    .filter(Boolean).join(' · ');
  s.root.hidden = false;
  document.body.classList.add('file-preview-open');

  const loading = document.createElement('div');
  loading.className = 'file-preview-loading';
  loading.textContent = '正在打开…';
  setBody(loading);

  try {
    if (kind === 'image') {
      const img = document.createElement('img');
      img.className = 'file-preview-image';
      img.src = readUrl;
      img.alt = label;
      if (!isCurrent()) return;
      setBody(img);
      return;
    }

    if (kind === 'markdown' || kind === 'text') {
      const res = await fetch(readUrl, { credentials: 'same-origin' });
      if (!isCurrent()) return;
      if (!res.ok) throw new Error('读取失败（' + res.status + '）');
      const text = await res.text();
      if (!isCurrent()) return;
      if (kind === 'markdown' && typeof renderMarkdown === 'function') {
        const doc = document.createElement('div');
        doc.className = 'file-preview-doc markdown';
        doc.innerHTML = renderMarkdown(text);
        setBody(doc);
      } else {
        const pre = document.createElement('pre');
        pre.className = 'file-preview-text';
        pre.textContent = text;
        setBody(pre);
      }
      return;
    }

    if (kind === 'docx') {
      const paragraphs = await loadDocx(readUrl);
      if (!isCurrent()) return;
      const doc = document.createElement('div');
      doc.className = 'file-preview-doc';
      for (const p of paragraphs) {
        const node = document.createElement(p.heading ? 'h3' : 'p');
        node.textContent = p.text;
        doc.appendChild(node);
      }
      setBody(doc);
      return;
    }

    if (!isCurrent()) return;

    if (kind === 'unsupported') {
      setBody(fallbackNotice('这个格式没法在手机里直接渲染。下载后用系统应用打开。', label, downloadUrl));
      return;
    }

    setBody(fallbackNotice('没有内置预览。可以下载后查看。', label, downloadUrl));
  } catch (err) {
    if (!isCurrent()) return;
    setBody(fallbackNotice('打不开：' + (err.message || String(err)), label, downloadUrl));
  }
}

export function closeFilePreview() {
  if (!sheet || sheet.root.hidden) return false;
  sheet.close();
  return true;
}
