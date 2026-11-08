/* xlsx-preview.js — 手机端 Excel（.xlsx）内置预览
 *
 * 手机上要直接看表格：解开 OOXML 的 zip，读 workbook.xml 拿工作表名与顺序，
 * 读 workbook.xml.rels 拿「名字 → 具体 xml 文件」（不能假设 sheet1.xml），
 * 读 sharedStrings.xml 拿共享字符串，再逐张读 worksheets/*.xml 的 <row>/<c>。
 *
 * 第一约束是「不把整张表塞进 DOM」：每张表最多 200 行 × 30 列，超出的行列只数不建节点，
 * 由界面上一条「已截断」提示兜住。解析与渲染是分开的两步，都能单独测。
 *
 * 不引第三方库：zip 解压交给 zip-reader.js（浏览器原生 DecompressionStream），
 * xml 只用正则按已知的扁平结构扫，不建完整 DOM 树（工作表 xml 动辄几 MB）。
 *
 * 用法：
 *   const { destroy } = await mountXlsx({ zip: openZip(bytes), container });
 * 导出里除 mountXlsx 以外都是纯函数/独立渲染步骤，方便测试。
 */

export const MAX_ROWS = 200;
export const MAX_COLS = 30;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** 解 xml 实体：命名实体 + 数字引用（&#10; / &#x4E2D;）。 */
function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body) => {
    const named = ENTITIES[body];
    if (named) return named;
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    return whole;
  });
}

/** 从属性串里取一个属性（`r="A1"` / `r:id="rId1"`），取不到返回 null。 */
function attr(attrs, name) {
  const safe = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|\\s)${safe}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(String(attrs || ''));
  if (!found) return null;
  return decodeXml(found[1] != null ? found[1] : (found[2] || ''));
}

/** 0 → "A"，25 → "Z"，26 → "AA"。 */
export function columnLabel(index) {
  let n = Math.floor(Number(index)) + 1;
  if (!Number.isFinite(n) || n < 1) n = 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "C3" → 2（0 基列号），认不出返回 -1。 */
export function columnIndex(ref) {
  const found = /^\s*\$?([A-Za-z]+)/.exec(String(ref || ''));
  if (!found) return -1;
  let index = 0;
  for (const ch of found[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/* ---------------------------- 共享字符串 ---------------------------- */

/**
 * `<si>` 里取文字：拼接所有 `<t>`（富文本是按 run 拆开的），
 * 但排除 `<rPh>`（日文假名注音）——它也在 `<t>` 里，直接拼会多出注音。
 */
function stringItemText(inner) {
  const cleaned = String(inner || '').replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/g, '');
  let out = '';
  for (const found of cleaned.matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t\s*>/g)) {
    out += found[1];
  }
  return decodeXml(out);
}

/** sharedStrings.xml → string[]，下标即 `t="s"` 单元格里的取值。 */
export function parseSharedStrings(xml) {
  const source = String(xml || '');
  if (!source) return [];
  const out = [];
  for (const found of source.matchAll(/<(?:[\w.-]+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?si\s*>)/g)) {
    out.push(found[1] ? stringItemText(found[1]) : '');
  }
  return out;
}

/* ------------------------------ 单元格 ------------------------------ */

/**
 * 一格的值。
 * t="s" 走共享字符串、t="inlineStr" 取 <is><t>、t="str" 是公式结果文本、
 * t="b" 变 TRUE/FALSE、t="e" 保留错误串、t="d" 保留 ISO 日期原文；
 * 没有 t（或 t="n"）就是数值，原样返回——日期在 xlsx 里是序列号，也按原样显示。
 */
function cellText(attrs, inner, sharedStrings) {
  const type = attr(attrs, 't') || 'n';
  if (type === 'inlineStr') {
    const held = /<(?:[\w.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?is\s*>/.exec(inner);
    return held ? stringItemText(held[1]) : stringItemText(inner);
  }
  const value = /<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v\s*>/.exec(inner);
  const raw = value ? value[1] : '';
  switch (type) {
    case 's': {
      const index = Number(String(raw).trim());
      if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) return '';
      const shared = sharedStrings[index];
      return shared == null ? '' : String(shared);
    }
    case 'b':
      return String(raw).trim() === '1' ? 'TRUE' : 'FALSE';
    case 'e':
    case 'd':
    case 'str':
      return decodeXml(raw);
    default:
      return decodeXml(String(raw).trim());
  }
}

/* ------------------------------ 工作表 ------------------------------ */

/**
 * 一张工作表 xml → { rows, rowNumbers, colCount, totalRows, truncated, ... }。
 *
 * 稀疏结构照原样落到网格里：`r="C5"` 用列字母定位置，缺的行/列补空串，
 * 行号也留着（原表第 4 行就是 4，不重新编号）。
 * 超过上限的部分只数不解析：行数靠 `<row>` 标签计数，列超限的单元格直接丢。
 */
export function parseWorksheet(xml, sharedStrings = [], options = {}) {
  const maxRows = options.maxRows || MAX_ROWS;
  const maxCols = options.maxCols || MAX_COLS;
  const source = String(xml || '');
  const rows = [];
  const rowNumbers = [];
  let totalRows = 0;
  let truncatedCols = false;
  let colCount = 0;

  const rowRe = /<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row\s*>)/g;
  const cellRe = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>)/g;

  let rowMatch;
  while ((rowMatch = rowRe.exec(source)) !== null) {
    totalRows += 1;
    if (rows.length >= maxRows) continue; // 已到上限：只数行，不再建格子
    const attrs = rowMatch[1] || '';
    const inner = rowMatch[2] || '';
    const cells = [];
    let next = 0;
    cellRe.lastIndex = 0;

    let cellMatch;
    while ((cellMatch = cellRe.exec(inner)) !== null) {
      const cellAttrs = cellMatch[1] || '';
      const cellInner = cellMatch[2] || '';
      const ref = attr(cellAttrs, 'r');
      let index = next;
      if (ref) {
        const col = columnIndex(ref);
        if (col >= 0) index = col;
      }
      next = index + 1;
      if (index >= maxCols) {
        truncatedCols = true;
        continue;
      }
      const text = cellText(cellAttrs, cellInner, sharedStrings);
      while (cells.length < index) cells.push('');
      cells[index] = text;
    }

    // 行尾的空格不必进模型：渲染时按列宽补齐
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > colCount) colCount = cells.length;

    const declared = Number(attr(attrs, 'r'));
    rows.push(cells);
    rowNumbers.push(Number.isFinite(declared) && declared > 0 ? declared : totalRows);
  }

  const truncatedRows = totalRows > rows.length;
  return {
    rows,
    rowNumbers,
    colCount,
    totalRows,
    truncated: truncatedRows || truncatedCols,
    truncatedRows,
    truncatedCols,
    maxRows,
    maxCols,
  };
}

/* ------------------------------ 工作簿 ------------------------------ */

/** Relationship 的 Target 是相对 `xl/` 的路径，也可能是以 `/` 开头的包内绝对路径。 */
export function resolveSheetPath(target, baseDir = 'xl') {
  const clean = String(target || '').replace(/\\/g, '/').trim();
  if (!clean) return null;
  if (clean.startsWith('/')) {
    const parts = [];
    for (const piece of clean.split('/')) {
      if (!piece || piece === '.') continue;
      if (piece === '..') parts.pop();
      else parts.push(piece);
    }
    return parts.join('/');
  }
  const parts = [];
  for (const piece of `${baseDir}/${clean}`.split('/')) {
    if (!piece || piece === '.') continue;
    if (piece === '..') parts.pop();
    else parts.push(piece);
  }
  return parts.join('/');
}

/**
 * workbook.xml + workbook.xml.rels → [{ name, sheetId, path }]（顺序即工作簿里的顺序）。
 * 对不上关系的表 path 为 null，读的时候再按 sheetId 兜一次。
 */
export function parseWorkbook(xml, relsXml = '') {
  const rels = new Map();
  for (const found of String(relsXml || '').matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(found[1], 'Id');
    const target = attr(found[1], 'Target');
    if (id && target) rels.set(id, target);
  }

  const sheets = [];
  for (const found of String(xml || '').matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?>/g)) {
    const attrs = found[1] || '';
    const name = attr(attrs, 'name');
    if (name == null) continue;
    const relId = attr(attrs, 'r:id');
    const target = relId ? rels.get(relId) : null;
    const declared = Number(attr(attrs, 'sheetId'));
    sheets.push({
      name,
      sheetId: Number.isFinite(declared) && declared > 0 ? declared : null,
      path: target ? resolveSheetPath(target) : null,
    });
  }
  return sheets;
}

async function loadWorkbook(zip) {
  const workbookXml = await zip.text('xl/workbook.xml');
  if (!workbookXml) throw new Error('这个 xlsx 里没有工作簿结构');
  const relsXml = (await zip.text('xl/_rels/workbook.xml.rels')) || '';
  const shared = parseSharedStrings(await zip.text('xl/sharedStrings.xml'));
  const known = new Set(zip.names || []);

  const sheets = parseWorkbook(workbookXml, relsXml).map((sheet) => {
    let path = sheet.path;
    if (!path || !known.has(path)) {
      // 关系缺失或指向没有的文件（例如图表页 chartsheet）：按 sheetId 猜一次，
      // 猜不到就留空，由界面说明「没有可预览的数据」，不瞎指别的表。
      const guess = sheet.sheetId != null ? `xl/worksheets/sheet${sheet.sheetId}.xml` : null;
      path = guess && known.has(guess) ? guess : null;
    }
    return { name: sheet.name, path };
  });
  return { sheets, shared };
}

function emptySheetModel(name, options = {}) {
  return {
    name,
    path: null,
    rows: [],
    rowNumbers: [],
    colCount: 0,
    totalRows: 0,
    truncated: false,
    truncatedRows: false,
    truncatedCols: false,
    maxRows: options.maxRows || MAX_ROWS,
    maxCols: options.maxCols || MAX_COLS,
    missing: true,
  };
}

/** 逐表读出模型（每张表都按上限截断，多表也不会崩）。 */
export async function parseXlsx(zip, options = {}) {
  const { sheets, shared } = await loadWorkbook(zip);
  const out = [];
  for (const sheet of sheets) {
    if (!sheet.path) {
      out.push(emptySheetModel(sheet.name, options));
      continue;
    }
    const parsed = parseWorksheet(await zip.text(sheet.path), shared, options);
    out.push({ ...parsed, name: sheet.name, path: sheet.path, missing: false });
  }
  return out;
}

/* ------------------------------ 渲染 ------------------------------ */

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function isNumeric(text) {
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(String(text).trim());
}

/** 超过这个长度的文字套定宽 span，交给 CSS 省略号收口（见 xlsx-preview.css）。 */
export const LONG_CELL_CHARS = 24;

/** 「已截断」那句话；没截断就是空串。 */
export function truncationMessage(sheet) {
  const parts = [];
  if (sheet.truncatedRows) parts.push(`已截断，仅显示前 ${sheet.maxRows || MAX_ROWS} 行`);
  if (sheet.truncatedCols) parts.push(`仅显示前 ${sheet.maxCols || MAX_COLS} 列`);
  if (parts.length === 0) return '';
  return `${parts.join('；')}${sheet.totalRows ? `（原表 ${sheet.totalRows} 行）` : ''}`;
}

/** 一张工作表 → `<table>`（表头是列字母，行首是原表行号）。 */
export function createTable(doc, sheet, options = {}) {
  const maxCols = sheet.maxCols || options.maxCols || MAX_COLS;
  const width = Math.max(1, Math.min(sheet.colCount || 0, maxCols));
  const table = make(doc, 'table', 'xlsx-table');

  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  headRow.appendChild(make(doc, 'th', 'xlsx-corner'));
  for (let col = 0; col < width; col += 1) {
    headRow.appendChild(make(doc, 'th', 'xlsx-col', columnLabel(col)));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  for (let r = 0; r < sheet.rows.length; r += 1) {
    const tr = doc.createElement('tr');
    const number = sheet.rowNumbers && sheet.rowNumbers[r] ? sheet.rowNumbers[r] : r + 1;
    tr.appendChild(make(doc, 'th', 'xlsx-rownum', number));
    const cells = sheet.rows[r] || [];
    for (let col = 0; col < width; col += 1) {
      const text = cells[col] == null ? '' : String(cells[col]);
      const td = make(doc, 'td', isNumeric(text) ? 'xlsx-cell xlsx-num' : 'xlsx-cell');
      if (text.length > LONG_CELL_CHARS) {
        // 长文本套一层定宽 span：table 自动布局里 td 的 max-width 不生效，
        // 靠这一层才能真的省略号收口，不然一格能把整张表撑出去几千像素。
        td.setAttribute('title', text);
        td.appendChild(make(doc, 'span', 'xlsx-cell-text', text));
      } else {
        td.textContent = text;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * 挂到容器上：多表时顶部一排标签，中间一张表，超限时表上方一条截断提示。
 * 全部节点由自己创建、自己摘掉；容器只被追加一个根节点。
 * @returns {{ destroy: () => void }}
 */
export async function mountXlsx({ zip, container, maxRows = MAX_ROWS, maxCols = MAX_COLS } = {}) {
  if (!container) throw new Error('mountXlsx 需要一个容器节点');
  if (!zip) throw new Error('mountXlsx 需要一个 zip');
  const doc = container.ownerDocument || globalThis.document;
  const sheets = await parseXlsx(zip, { maxRows, maxCols });

  const root = make(doc, 'div', 'xlsx-preview');
  container.appendChild(root);

  const tabs = [];
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const tab of tabs) tab.button.removeEventListener('click', tab.onClick);
    tabs.length = 0;
    root.remove();
  };

  if (sheets.length === 0) {
    root.appendChild(make(doc, 'p', 'xlsx-empty', '这个 xlsx 里没有工作表'));
    return { destroy };
  }

  const note = make(doc, 'div', 'xlsx-note');
  note.hidden = true;
  const scroll = make(doc, 'div', 'xlsx-scroll');

  const show = (index) => {
    if (destroyed) return;
    const sheet = sheets[index];
    if (!sheet) return;
    for (let i = 0; i < tabs.length; i += 1) {
      tabs[i].button.className = i === index ? 'xlsx-tab xlsx-tab-active' : 'xlsx-tab';
      tabs[i].button.setAttribute('aria-selected', i === index ? 'true' : 'false');
    }
    scroll.replaceChildren();
    if (sheet.missing || sheet.rows.length === 0) {
      // replaceChildren 已清空，这里只补一句说明
      scroll.appendChild(make(doc, 'p', 'xlsx-empty', sheet.missing ? '这个工作表没有可预览的数据' : '这张表是空的'));
      note.textContent = '';
      note.hidden = true;
      return;
    }
    scroll.appendChild(createTable(doc, sheet, { maxCols }));
    const message = truncationMessage(sheet);
    note.textContent = message;
    note.hidden = message === '';
  };

  if (sheets.length > 1) {
    const bar = make(doc, 'div', 'xlsx-tabs');
    bar.setAttribute('role', 'tablist');
    for (let i = 0; i < sheets.length; i += 1) {
      const button = make(doc, 'button', 'xlsx-tab', sheets[i].name);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', 'false');
      const onClick = () => show(i);
      button.addEventListener('click', onClick);
      tabs.push({ button, onClick });
      bar.appendChild(button);
    }
    root.appendChild(bar);
  }

  root.appendChild(note);
  root.appendChild(scroll);
  show(0);

  return { destroy };
}
