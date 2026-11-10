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
import { openZip } from './zip-reader.js';
import { mountXlsx } from './xlsx-preview.js';
import { mountPptx } from './pptx-preview.js';

const TEXT_EXTS = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'css',
  'js', 'mjs', 'ts', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'sh', 'ps1', 'sql', 'ini', 'conf',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const OFFICE_EXTS = new Set(['xlsx', 'pptx', 'pdf']);
// 老二进制格式（doc/xls/ppt）和 CSv 以外的表格都不在这里：它们没有 OOXML 结构可解。
const UNSUPPORTED_EXTS = new Set(['xls', 'ppt', 'doc']);

export function previewKind(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'docx') return 'docx';
  if (OFFICE_EXTS.has(e)) return e;
  if (TEXT_EXTS.has(e)) return 'text';
  if (UNSUPPORTED_EXTS.has(e)) return 'unsupported';
  return 'unknown';
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
  const zip = openZip(await res.arrayBuffer());
  const xml = await zip.text('word/document.xml');
  if (!xml) throw new Error('这个 docx 里没有正文');
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
    dropMounted();            // 表格/幻灯/PDF 的渲染要收尾（监听、定时器、canvas 内存）
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

/* 当前挂载的预览器（xlsx / pptx / pdf）。换文件、关闭都要先销毁上一个，
 * 否则 PDF 的 canvas 与滚动监听会跟着面板一直留着。 */
let mounted = null;

function dropMounted() {
  const handle = mounted;
  mounted = null;
  if (handle && typeof handle.destroy === 'function') {
    try {
      handle.destroy();
    } catch {
      // 销毁失败不能影响关闭：面板已经要关了，没东西值得为它停下来
    }
  }
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
 * @param {string} opts.readUrl    读取用的同源地址；空/缺失时只给一句提示，不发任何请求
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

  // 地址为空就没什么可发的：以前图片分支会 `img.src = null`（真浏览器里变成一次对 “null” 的请求，
  // 必然失败还应答不了），文本分支会 fetch 空串。这里提前收口：不发请求，直接给人话和下载入口。
  const readTarget = typeof readUrl === 'string' ? readUrl.trim() : '';
  if (!readTarget) {
    setBody(fallbackNotice('这个文件暂时拿不到可读地址，先下载到本地再看。', label, downloadUrl));
    return;
  }

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

    if (kind === 'xlsx' || kind === 'pptx' || kind === 'pdf') {
      // 换文件时先把上一个预览器收掉：它的 canvas / 监听不能跟着新文件继续活着。
      dropMounted();
      const box = document.createElement('div');
      box.className = 'file-preview-doc file-preview-embed';
      setBody(box);

      if (kind === 'pdf') {
        // pdf.js 是 1MB 级，故意用动态 import：它必须留在按需分块里，不能进主包。
        const { mountPdf } = await import('./pdf-preview.js');
        if (!isCurrent()) return;
        mounted = await mountPdf({ url: readUrl, container: box });
        if (!isCurrent()) { dropMounted(); return; }
        return;
      }

      const res = await fetch(readUrl, { credentials: 'same-origin' });
      if (!isCurrent()) return;
      if (!res.ok) throw new Error('文件读取失败（' + res.status + '）');
      const zip = openZip(await res.arrayBuffer());
      if (!isCurrent()) return;
      mounted = kind === 'xlsx'
        ? await mountXlsx({ zip, container: box })
        : await mountPptx({ zip, container: box });
      if (!isCurrent()) { dropMounted(); return; }
      return;
    }

    if (!isCurrent()) return;

    if (kind === 'unsupported') {
      setBody(fallbackNotice('这是 Office 97-2003 的老格式，手机里解不了。下载后用系统应用打开。', label, downloadUrl));
      return;
    }

    setBody(fallbackNotice('没有内置预览。可以下载后查看。', label, downloadUrl));
  } catch (err) {
    if (!isCurrent()) return;
    dropMounted();
    setBody(fallbackNotice('打不开：' + (err.message || String(err)), label, downloadUrl));
  }
}

export function closeFilePreview() {
  if (!sheet || sheet.root.hidden) return false;
  sheet.close();
  return true;
}
