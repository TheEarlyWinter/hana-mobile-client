/* file-card.js — 会话文件卡片
 *
 * 宿主把 stage_files 的结果推成两路，形状不一样：
 *   实时：content_block 事件，block.type === 'file'
 *   历史：blocks 里的 {type:'file'} 投影（锚在 afterIndex 上）
 *
 * 桌面端拿到就画一张文件卡（图标 + 文件名 + 类型 + 大小 + 打开）。手机端原来只画了
 * 折叠的工具行，文件本身没有落点，用户看到助手写「已经推给你了」，却找不到那个文件。
 *
 * 卡片两个可点区域：
 *   左侧正文 → 预览（file-preview.js）
 *   右侧箭头 → 下载（href 由调用方解析，晚到也能补上）
 *
 * 本模块只管「一份文件描述 → 一个 DOM 卡片」，不碰网络也不读写全局状态。
 */

import { formatBytes } from './attach.js';

/* 扩展名 → 人话。没有的就不显示类型，不硬编「未知文件」。 */
const TYPE_LABEL = {
  doc: 'Word', docx: 'Word', rtf: 'Rich Text',
  pdf: 'PDF',
  xls: 'Excel', xlsx: 'Excel', csv: 'CSV',
  ppt: 'PowerPoint', pptx: 'PowerPoint',
  md: 'Markdown', txt: '文本', log: '日志',
  json: 'JSON', yml: 'YAML', yaml: 'YAML',
  js: '代码', mjs: '代码', ts: '代码', py: '代码', java: '代码', ps1: '脚本', sh: '脚本',
  png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', bmp: '图片', svg: '图片',
  mp4: '视频', mov: '视频', mp3: '音频', wav: '音频',
  zip: '压缩包', '7z': '压缩包', rar: '压缩包',
  apk: 'Android 包', exe: '程序',
};

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/></svg>';

/** 从 toolResult 条目的 details.files 取文件描述；不是这种形状就返回空数组。 */
export function fileCardsOf(entry) {
  const files = entry?.details?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((f) => f && typeof f === 'object' && (f.fileId || f.id));
}

/** 这份文件的一行说明：类型 · 大小。缺什么就不写什么，不留空的分隔点。 */
export function fileMetaText(file) {
  const ext = String(file?.ext || '').toLowerCase();
  const parts = [];
  if (TYPE_LABEL[ext]) parts.push(TYPE_LABEL[ext]);
  if (ext) parts.push(ext.toUpperCase());
  if (Number.isFinite(file?.size) && file.size > 0) parts.push(formatBytes(file.size));
  return parts.join(' · ');
}

/**
 * 一份文件 → 一张卡片。
 *
 * @param {object} file  宿主的文件描述（fileId/label/ext/size）
 * @param {object} opts
 * @param {string} [opts.href]    下载地址；没有就先不显示下载按钮
 * @param {Function} [opts.onOpen] 点卡片正文时的回调（打开预览）
 */
export function renderFileCard(file, { href = null, onOpen = null, onDownload = null } = {}) {
  const label = String(file?.label || file?.filename || '未命名文件');
  const ext = String(file?.ext || '').toLowerCase();

  const card = document.createElement('div');
  card.className = 'file-card';
  card.title = label;

  const icon = document.createElement('span');
  icon.className = 'file-card-icon';
  // 有扩展名就把缩写在图标里写出来，比一个通用文档图标好认
  icon.textContent = ext ? ext.slice(0, 4).toUpperCase() : '?';
  card.appendChild(icon);

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'file-card-main';
  const name = document.createElement('span');
  name.className = 'file-card-name';
  name.textContent = label;
  main.appendChild(name);
  const metaText = fileMetaText(file);
  if (metaText) {
    const meta = document.createElement('span');
    meta.className = 'file-card-meta';
    meta.textContent = metaText;
    main.appendChild(meta);
  }
  main.addEventListener('click', () => {
    if (typeof onOpen === 'function') onOpen();
  });
  card.appendChild(main);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'file-card-action';
  action.innerHTML = DOWNLOAD_ICON;
  action.setAttribute('aria-label', '下载 ' + label);
  action.hidden = !href;
  if (href) card.dataset.href = href;
  action.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = card.dataset.href;
    if (target && typeof onDownload === 'function') onDownload(target);
  });
  card.appendChild(action);

  return card;
}

/** 地址晚到（要先查工作区根）：把下载地址补进已经渲染好的卡片。 */
export function setFileCardHref(card, href) {
  const action = card?.querySelector?.('.file-card-action');
  if (!action || !href) return;
  card.dataset.href = href;
  action.hidden = false;
}
