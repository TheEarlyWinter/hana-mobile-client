/* tests/xlsx_preview.test.mjs — 手机端 Excel 预览（web/xlsx-preview.js）
 *
 * 自己现造 xlsx 字节（store 方式的 zip，不压缩、不联网、不落盘），
 * 覆盖：多表名称与顺序（按 rels 映射，不假设 sheet1.xml）、共享字符串（富文本 / 注音 / 越界）、
 * inlineStr / 数值 / 布尔 / 公式文本 / 错误串、空单元格与稀疏行列、列数超限、行数超限被截断，
 * 以及挂载后的 DOM 结构、工作表切换、destroy() 清场。
 *
 * 假 DOM 来自 tests/support/app_harness.mjs（没有布局、没有 classList.toggle 依赖），
 * 断言只看结构、文案与节点树；样式不在这里测。
 */

import assert from 'node:assert/strict';
import { createHarness } from './support/app_harness.mjs';
import { openZip } from '../web/zip-reader.js';
import {
  MAX_COLS,
  MAX_ROWS,
  columnIndex,
  columnLabel,
  createTable,
  parseSharedStrings,
  parseWorkbook,
  parseWorksheet,
  parseXlsx,
  resolveSheetPath,
  truncationMessage,
  mountXlsx,
} from '../web/xlsx-preview.js';

const h = createHarness();

/* ---------------------------- 造 xlsx 字节 ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** store（method 0）方式的最小 zip：只有中央目录 + 本地头，够 openZip 读。 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entries[name]) ? entries[name] : Buffer.from(entries[name], 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function worksheet(rowsXml) {
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

function workbookXml(sheets) {
  const body = sheets
    .map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${body}</sheets></workbook>`;
}

function relsXml(targets) {
  const body = targets
    .map((target, i) => '<Relationship Id="rId' + (i + 1) + '"'
      + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
      + ` Target="${target}"/>`)
    .join('');
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `${body}</Relationships>`;
}

/** 造一个最小可用 xlsx：sheets = [{ name, xml }]，每张表的内容放在 relTargets 指定的文件里。 */
function buildXlsx({ sheets, sharedStrings, relTargets }) {
  const targets = relTargets || sheets.map((_s, i) => `worksheets/sheet${i + 1}.xml`);
  const files = {
    'xl/workbook.xml': workbookXml(sheets),
    'xl/_rels/workbook.xml.rels': relsXml(targets),
  };
  if (sharedStrings) files['xl/sharedStrings.xml'] = sharedStrings;
  sheets.forEach((sheet, i) => {
    files[resolveSheetPath(targets[i])] = sheet.xml;
  });
  return openZip(makeZip(files));
}

function cellRef(col, row) {
  return `${columnLabel(col)}${row}`;
}

/* ---------------------------- 断言小工具 ---------------------------- */

function rowsOfTable(table) {
  const tbody = table.children.find((node) => node.tagName === 'TBODY');
  assert.ok(tbody, '表格必须有 tbody');
  return tbody.children
    .filter((node) => node.tagName === 'TR')
    .map((tr) => tr.children.filter((node) => node.tagName === 'TD').map((td) => td.textContent));
}

function headerOfTable(table) {
  const thead = table.children.find((node) => node.tagName === 'THEAD');
  assert.ok(thead, '表格必须有 thead');
  return thead.children[0].children.map((th) => th.textContent);
}

function bodyRowNumbers(table) {
  const tbody = table.children.find((node) => node.tagName === 'TBODY');
  return tbody.children
    .filter((node) => node.tagName === 'TR')
    .map((tr) => tr.children.find((node) => node.tagName === 'TH').textContent);
}

let bad = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

/* ------------------------------- 解析 ------------------------------- */

await t('列字母与列号互转（含 AA / AB）', () => {
  assert.equal(columnLabel(0), 'A');
  assert.equal(columnLabel(25), 'Z');
  assert.equal(columnLabel(26), 'AA');
  assert.equal(columnLabel(27), 'AB');
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('C7'), 2);
  assert.equal(columnIndex('AA1'), 26);
  assert.equal(columnIndex('$AB$3'), 27);
  assert.equal(columnIndex('没有列号'), -1);
});

await t('Relationship Target 相对 xl/ 解析，也认包内绝对路径', () => {
  assert.equal(resolveSheetPath('worksheets/sheet2.xml'), 'xl/worksheets/sheet2.xml');
  assert.equal(resolveSheetPath('/xl/worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.equal(resolveSheetPath('./worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.equal(resolveSheetPath('../xl/worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml');
  assert.equal(resolveSheetPath(''), null);
});

await t('多表：名称与顺序按 workbook.xml，文件映射按 rels（不假设 sheet1.xml）', async () => {
  const zip = buildXlsx({
    sheets: [
      { name: '封面', xml: worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>封面-A1</t></is></c></row>') },
      { name: '明细 表', xml: worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>明细-A1</t></is></c></row>') },
      { name: '空表', xml: worksheet('') },
    ],
    // 故意让关系顺序跟文件顺序相反：rId1 → sheet2.xml，rId2 → sheet1.xml
    relTargets: ['worksheets/sheet2.xml', 'worksheets/sheet1.xml', 'worksheets/sheet3.xml'],
  });

  const sheets = await parseXlsx(zip);
  assert.deepEqual(sheets.map((s) => s.name), ['封面', '明细 表', '空表'], '表名与顺序必须按工作簿');
  assert.equal(sheets[0].path, 'xl/worksheets/sheet2.xml', '封面应映射到 rels 指定的 sheet2.xml');
  assert.equal(sheets[0].rows[0][0], '封面-A1', '读到的必须是映射后的那张表，不能想当然读 sheet1.xml');
  assert.equal(sheets[1].rows[0][0], '明细-A1');
  assert.equal(sheets[2].rows.length, 0, '空表没有行');
  assert.equal(sheets[2].truncated, false);
});

await t('解析 workbook.xml：缺关系时 path 为空，而不是瞎指一张表', () => {
  const sheets = parseWorkbook(
    `${XML_HEAD}<workbook><sheets><sheet name="图表页" sheetId="7" r:id="rId9"/><sheet name="数据" sheetId="8" r:id="rId1"/></sheets></workbook>`,
    `${XML_HEAD}<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  assert.deepEqual(sheets.map((s) => s.name), ['图表页', '数据']);
  assert.equal(sheets[0].path, null, '没有关系的表不能猜文件');
  assert.equal(sheets[1].path, 'xl/worksheets/sheet1.xml');
});

await t('共享字符串：富文本拼 run、排除 rPh 注音、保留空格', () => {
  const shared = parseSharedStrings(`${XML_HEAD}<sst count="4" uniqueCount="4">`
    + '<si><r><rPr><b/></rPr><t>富</t></r><r><t>文本</t></r></si>'
    + '<si><rPh sb="0" eb="1"><t>ふ</t></rPh><t>漢字</t></si>'
    + '<si><t xml:space="preserve"> 前后空格 </t></si>'
    + '<si><t/></si>'
    + '</sst>');
  assert.deepEqual(shared, ['富文本', '漢字', ' 前后空格 ', '']);
});

await t('单元格类型：共享字符串 / inlineStr / 数值 / 布尔 / 公式文本 / 错误串 / 越界索引', () => {
  const shared = parseSharedStrings('<sst><si><t>共享甲</t></si></sst>');
  const parsed = parseWorksheet(worksheet(
    '<row r="2">'
    + '<c r="A2" t="inlineStr"><is><t>内联</t></is></c>'
    + '<c r="B2" t="s"><v>0</v></c>'
    + '<c r="C2"><v>42.5</v></c>'
    + '<c r="D2" t="b"><v>1</v></c>'
    + '<c r="E2" t="b"><v>0</v></c>'
    + '<c r="F2" t="str"><f>A1</f><v>公式文本</v></c>'
    + '<c r="G2" t="e"><v>#DIV/0!</v></c>'
    + '<c r="H2" t="s"><v>99</v></c>'
    + '<c r="I2"/>'
    + '<c r="J2"><v>45000</v></c>'
    + '</row>',
  ), shared);

  assert.deepEqual(parsed.rows[0], [
    '内联', '共享甲', '42.5', 'TRUE', 'FALSE', '公式文本', '#DIV/0!', '', '', '45000',
  ]);
  assert.equal(parsed.rowNumbers[0], 2, '行号沿用原表');
  assert.equal(parsed.colCount, 10);
  assert.equal(parsed.truncated, false);
});

await t('稀疏行列：列跳位补空、缺列号按顺序、空行不丢行号', () => {
  const parsed = parseWorksheet(worksheet(
    '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>'
    + '<row r="4"><c><v>无列号</v></c><c t="inlineStr"><is><t>第二</t></is></c></row>',
  ));
  assert.deepEqual(parsed.rows[0], ['1', '', '3'], 'B1 是空的，但要占位');
  assert.deepEqual(parsed.rows[1], ['无列号', '第二'], '没有 r 属性的单元格按出现顺序排');
  assert.deepEqual(parsed.rowNumbers, [1, 4], '第 4 行不能被重新编号成 2');
  assert.equal(parsed.totalRows, 2);
});

await t('列数超 30：只留前 30 列并标记 truncatedCols', () => {
  const cells = Array.from({ length: 35 }, (_v, i) => `<c r="${cellRef(i, 1)}"><v>${i}</v></c>`).join('');
  const parsed = parseWorksheet(worksheet(`<row r="1">${cells}</row>`));
  assert.equal(parsed.colCount, MAX_COLS, '只保留前 30 列');
  assert.equal(parsed.rows[0].length, 30);
  assert.equal(parsed.rows[0][29], '29');
  assert.equal(parsed.truncatedCols, true);
  assert.equal(parsed.truncated, true);
});

await t('行数超 200：只解析 200 行，总行数仍然数准，标记 truncated', () => {
  const rows = Array.from({ length: 250 }, (_v, i) => {
    const row = i + 1;
    return `<row r="${row}"><c r="A${row}"><v>${row}</v></c></row>`;
  }).join('');
  const parsed = parseWorksheet(worksheet(rows));

  assert.equal(parsed.rows.length, MAX_ROWS, '最多 200 行进 DOM');
  assert.equal(parsed.totalRows, 250, '总行数要数准，提示里要用');
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.truncatedRows, true);
  assert.equal(parsed.rowNumbers[199], 200);
  assert.equal(parsed.rows[199][0], '200');
  assert.equal(truncationMessage(parsed), '已截断，仅显示前 200 行（原表 250 行）');
});

/* ------------------------------- 渲染 ------------------------------- */

const RICH_SHEET = {
  name: '汇总',
  rows: [['项目', '数量'], ['苹果', '12'], ['梨', '', ]],
  rowNumbers: [1, 2, 3],
  colCount: 2,
  totalRows: 3,
  truncated: false,
  truncatedRows: false,
  truncatedCols: false,
  maxRows: MAX_ROWS,
  maxCols: MAX_COLS,
  missing: false,
};

await t('渲染结构：thead 列字母 + tbody 行号与单元格，数字靠右类名', () => {
  const table = createTable(h.doc, RICH_SHEET);
  assert.equal(table.tagName, 'TABLE');
  assert.equal(table.className, 'xlsx-table');
  assert.deepEqual(headerOfTable(table), ['', 'A', 'B'], '表头是列字母，左上角留空格');
  assert.deepEqual(bodyRowNumbers(table), ['1', '2', '3']);
  assert.deepEqual(rowsOfTable(table), [['项目', '数量'], ['苹果', '12'], ['梨', '']]);
  const numericCell = table.children
    .find((node) => node.tagName === 'TBODY')
    .children[1].children.filter((node) => node.tagName === 'TD')[1];
  assert.equal(numericCell.className, 'xlsx-cell xlsx-num', '数字要能靠右显示');
});

await t('渲染：长文本套定宽 span（否则一格把整张表撑出屏幕），短文本不套', () => {
  const longText = '很长的内容'.repeat(8);
  const table = createTable(h.doc, { ...RICH_SHEET, rows: [[longText, '短']], rowNumbers: [1], colCount: 2, totalRows: 1 });
  const tbody = table.children.find((node) => node.tagName === 'TBODY');
  const cells = tbody.children[0].children.filter((node) => node.tagName === 'TD');

  const span = cells[0].children.find((node) => node.className === 'xlsx-cell-text');
  assert.ok(span, '长文本要套 .xlsx-cell-text');
  assert.equal(span.textContent, longText, '文字本身不能被截，截的只是显示宽度');
  assert.equal(cells[0].getAttribute('title'), longText, '完整内容留在 title 里');
  assert.equal(cells[1].querySelector('.xlsx-cell-text'), null, '短文本不套额外节点');
  assert.equal(cells[1].textContent, '短');
});

await t('挂载：多表出标签、首表先渲染、切换后换表、destroy() 清空容器', async () => {
  const zip = buildXlsx({
    sheets: [
      { name: '汇总', xml: worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>汇总表</t></is></c></row>') },
      { name: '明细', xml: worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>明细表</t></is></c></row>') },
    ],
  });

  const container = h.makeNode('div', '');
  const mounted = await mountXlsx({ zip, container });

  assert.equal(container.children.length, 1, '容器里只放自己的根节点');
  const root = container.children[0];
  assert.equal(root.className, 'xlsx-preview');

  const tabs = root.querySelector('.xlsx-tabs').children;
  assert.deepEqual(tabs.map((node) => node.textContent), ['汇总', '明细'], '标签按工作簿顺序');
  assert.equal(tabs[0].className, 'xlsx-tab xlsx-tab-active');

  const table = root.querySelector('.xlsx-table');
  assert.deepEqual(rowsOfTable(table), [['汇总表']], '默认显示第一张表');
  assert.equal(root.querySelector('.xlsx-note').hidden, true, '没截断就不出提示');

  tabs[1].dispatchEvent('click');
  assert.equal(root.querySelector('.xlsx-tab-active').textContent, '明细');
  assert.deepEqual(rowsOfTable(root.querySelector('.xlsx-table')), [['明细表']], '点标签要换表');

  mounted.destroy();
  assert.equal(container.children.length, 0, 'destroy() 后容器必须清空');
  tabs[0].dispatchEvent('click'); // 事件也得摘掉：销毁后再点不能复活节点
  assert.equal(container.children.length, 0, '销毁后的点击不能再往容器里写东西');
  mounted.destroy(); // 幂等
});

await t('挂载：单表不出现标签条，超 200 行出「已截断」提示', async () => {
  const rows = Array.from({ length: 250 }, (_v, i) => {
    const row = i + 1;
    return `<row r="${row}"><c r="A${row}"><v>${row}</v></c></row>`;
  }).join('');
  const zip = buildXlsx({ sheets: [{ name: '长表', xml: worksheet(rows) }] });

  const container = h.makeNode('div', '');
  const mounted = await mountXlsx({ zip, container });
  const root = container.children[0];

  assert.equal(root.querySelector('.xlsx-tabs'), null, '只有一张表时不占标签条的位置');
  const table = root.querySelector('.xlsx-table');
  assert.equal(rowsOfTable(table).length, MAX_ROWS, 'DOM 里最多 200 行');

  const note = root.querySelector('.xlsx-note');
  assert.equal(note.hidden, false, '截断提示要显示出来');
  assert.ok(
    note.textContent.includes('已截断，仅显示前 200 行'),
    `提示文案要对，实际：${note.textContent}`,
  );

  mounted.destroy();
  assert.equal(container.children.length, 0);
});

await t('挂载：没有工作簿结构时报错，不留下半个节点', async () => {
  const zip = openZip(makeZip({ 'xl/worksheets/sheet1.xml': worksheet('') }));
  const container = h.makeNode('div', '');
  await assert.rejects(() => mountXlsx({ zip, container }), /工作簿/);
  assert.equal(container.children.length, 0);
});

/* ------------------------------- 收尾 ------------------------------- */

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
