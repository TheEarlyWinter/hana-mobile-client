/* tests/pptx_preview.test.mjs — web/pptx-preview.js 的回归
 *
 * 全部自己造：最小 zip（store 方式，不压缩，不联网）+ 最小假 DOM。
 * 假 DOM 故意不提供 classList.toggle、不提供任何布局量（尺寸/位置/offsetTop），
 * 所以「拿 toggle 偷懒」「靠 offsetTop 算当前页」这类写法在这里会直接崩。
 *
 * 覆盖：
 *   - 页序跟 ppt/presentation.xml 的 sldIdLst + presentation.xml.rels 走，不按文件名
 *   - 标题（ph type=title/ctrTitle）与正文要点（含层级）提取，页码占位符不算正文
 *   - 备注经 slideN.xml.rels → notesSlide 找到；没有备注就不出现折叠区
 *   - 空页显示「（这一页没有文字内容）」
 *   - 120 页上限、每页 60 段上限都带截断提示
 *   - destroy() 清节点、摘事件
 *
 * 用例先全部登记，再统一跑：历史事故是把用例写在跑测循环之后，从未执行却照样打 ALL PASS。
 */

import assert from 'node:assert/strict';
import { openZip } from '../web/zip-reader.js';
import {
  MAX_POINTS,
  MAX_SLIDES,
  mountPptx,
  parseNotesXml,
  parseSlideOrder,
  parseSlideXml,
  readDeck,
} from '../web/pptx-preview.js';

/* ------------------------------ 最小 zip ------------------------------ */

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

/** entries: { 'ppt/presentation.xml': '<xml/>' } → 未压缩（method 0）的最小 zip。 */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entries[name]) ? entries[name] : Buffer.from(String(entries[name]), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // method 0 = store
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(0, 38);
    head.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, data);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ------------------------------ 假 DOM ------------------------------ */

const splitClasses = (value) => String(value || '').split(/\s+/).filter(Boolean);

function createFakeDom() {
  function makeNode(tag) {
    const listeners = new Map();
    let ownText = '';
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      ownerDocument: doc,
      className: '',
      dataset: {},
      attributes: {},
      disabled: false,
      type: '',
      scrollCalls: [],
      classList: {
        add(...names) {
          const set = new Set(splitClasses(node.className));
          for (const name of names) if (name) set.add(name);
          node.className = Array.from(set).join(' ');
        },
        remove(...names) {
          const drop = new Set(names);
          node.className = splitClasses(node.className).filter((name) => !drop.has(name)).join(' ');
        },
        contains(name) {
          return splitClasses(node.className).includes(name);
        },
        // 故意不提供 toggle：真代码不该依赖它
      },
      get firstChild() {
        return node.children[0] || null;
      },
      get textContent() {
        if (!node.children.length) return ownText;
        return node.children.map((child) => child.textContent).join('');
      },
      set textContent(value) {
        for (const child of node.children) child.parentNode = null;
        node.children.length = 0;
        ownText = String(value ?? '');
      },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        node.children.push(child);
        child.parentNode = node;
        return child;
      },
      removeChild(child) {
        const at = node.children.indexOf(child);
        if (at !== -1) node.children.splice(at, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value);
        if (name === 'class') node.className = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners.has(type)) return;
        listeners.set(type, listeners.get(type).filter((item) => item !== fn));
      },
      dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event?.type;
        for (const fn of [...(listeners.get(type) || [])]) fn({ type, target: node });
      },
      click() {
        node.dispatchEvent('click');
      },
      scrollIntoView(options) {
        node.scrollCalls.push(options || {});
      },
    };
    return node;
  }

  const doc = {
    createElement(tag) {
      return makeNode(tag);
    },
  };
  return doc;
}

const doc = createFakeDom();

function findAllByClass(root, className) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (splitClasses(child.className).includes(className)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function textOf(node) {
  return String(node?.textContent ?? '');
}

const newContainer = () => doc.createElement('div');

/* ------------------------------ pptx 夹具 ------------------------------ */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function titleSp(text) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>'
    + `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function bodySp(paragraphs) {
  const body = paragraphs
    .map((p) => `<a:p><a:pPr lvl="${p.level || 0}"/><a:r><a:t>${escapeXml(p.text)}</a:t></a:r></a:p>`)
    .join('');
  return '<p:sp><p:nvSpPr><p:cNvPr id="3" name="内容占位符 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>'
    + `<p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`;
}

/** 页码占位符：真文件里每页都有，解析时必须当噪音丢掉。 */
function numberSp() {
  return '<p:sp><p:nvSpPr><p:cNvPr id="9" name="灯片编号占位符 5"/><p:cNvSpPr/><p:nvPr>'
    + '<p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>'
    + '<a:p><a:fld id="{B4E1}" type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>';
}

function slideXml({ title = '', bullets = [], withNumber = true } = {}) {
  const parts = [];
  if (title) parts.push(titleSp(title));
  const normalized = bullets.map((b) => (typeof b === 'string' ? { text: b } : b));
  if (normalized.length) parts.push(bodySp(normalized));
  if (withNumber) parts.push(numberSp());
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>`
    + `${parts.join('')}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(paragraphs) {
  const body = paragraphs.map((text) => `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`).join('');
  return `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符"/><p:cNvSpPr/><p:nvPr>'
    + `<p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`
    + `${numberSp()}</p:spTree></p:cSld></p:notes>`;
}

/**
 * 造一本 pptx。
 * @param {{ slides: Record<string,string>, order: string[], notes?: Record<string,{name:string,xml:string}> }} spec
 *   order 是演示文稿里的页序（zip 条目名），可以和 slide1.xml / slide2.xml 的文件名顺序正相反。
 */
function buildPptx({ slides, order, notes = {} }) {
  const entries = {};
  const sldIds = [];
  const rels = [];
  order.forEach((name, index) => {
    const rid = `rId${index + 1}`;
    sldIds.push(`<p:sldId id="${256 + index}" r:id="${rid}"/>`);
    rels.push(`<Relationship Id="${rid}" Type="${REL_BASE}/slide" Target="slides/${name}"/>`);
    entries[`ppt/slides/${name}`] = slides[name];
    if (notes[name]) {
      const notesName = notes[name].name;
      entries[`ppt/notesSlides/${notesName}`] = notes[name].xml;
      entries[`ppt/slides/_rels/${name}.rels`] = `${XML_HEAD}<Relationships ${REL_NS}>`
        + `<Relationship Id="rId1" Type="${REL_BASE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`
        + `<Relationship Id="rId2" Type="${REL_BASE}/notesSlide" Target="../notesSlides/${notesName}"/>`
        + '</Relationships>';
    }
  });
  entries['ppt/presentation.xml'] = `${XML_HEAD}<p:presentation ${NS}>`
    + `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst></p:presentation>`;
  entries['ppt/_rels/presentation.xml.rels'] = `${XML_HEAD}<Relationships ${REL_NS}>`
    + `${rels.join('')}</Relationships>`;
  return makeZip(entries);
}

const deckOf = async (bytes) => openZip(bytes);

/* ------------------------------ 用例登记 ------------------------------ */

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* 1. 纯函数：页序由 sldIdLst + rels 决定，文件名的先后无关 */
test('parseSlideOrder：页序取 sldIdLst，经 rels 映射到文件，不按文件名', () => {
  const presentationXml = `${XML_HEAD}<p:presentation ${NS}><p:sldIdLst>`
    + '<p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId1"/>'
    + '</p:sldIdLst></p:presentation>';
  const relsXml = `${XML_HEAD}<Relationships ${REL_NS}>`
    + `<Relationship Id="rId1" Type="${REL_BASE}/slide" Target="slides/slide1.xml"/>`
    + `<Relationship Id="rId3" Type="${REL_BASE}/slide" Target="slides/slide7.xml"/>`
    + '</Relationships>';

  assert.deepEqual(
    parseSlideOrder(presentationXml, relsXml),
    ['ppt/slides/slide7.xml', 'ppt/slides/slide1.xml'],
    '第一个 sldId 指向 slide7，就必须先出 slide7（按文件名排序会先出 slide1）',
  );
});

/* 2. 纯函数：标题 + 要点层级；页码占位符不进正文 */
test('parseSlideXml：标题取 ctrTitle，要点按 lvl 分层，页码占位符不算正文', () => {
  const xml = `${XML_HEAD}<p:sld ${NS}><p:cSld><p:spTree>`
    + `${titleSp('季度回顾 & 计划')}`
    + `${bodySp([
      { text: '营收增长 12%', level: 0 },
      { text: '其中新客户贡献一半', level: 1 },
      { text: '续费率 93%', level: 0 },
    ])}`
    + `${numberSp()}`
    + '</p:spTree></p:cSld></p:sld>';

  const parsed = parseSlideXml(xml);
  assert.equal(parsed.title, '季度回顾 & 计划', '标题要取出并解实体');
  assert.deepEqual(
    parsed.points.map((p) => [p.text, p.level]),
    [
      ['营收增长 12%', 0],
      ['其中新客户贡献一半', 1],
      ['续费率 93%', 0],
    ],
    `要点顺序与层级要保留，实际：${JSON.stringify(parsed.points)}`,
  );
  assert.ok(
    !parsed.points.some((p) => p.text === '7'),
    '页码占位符的数字不能被当成正文要点',
  );
});

/* 3. 纯函数：备注只取正文，sldNum 照样丢掉 */
test('parseNotesXml：备注取正文段落，页码占位符跳过', () => {
  assert.deepEqual(
    parseNotesXml(notesXml(['讲的时候补一句数据来源', '下一页是财务细节'])),
    ['讲的时候补一句数据来源', '下一页是财务细节'],
  );
  assert.deepEqual(parseNotesXml(null), [], '读不到备注 xml 要返回空数组，不能抛');
});

/* 4. zip + 解析：真页序不按文件名 */
test('readDeck：页序跟 rels 走（文件名顺序与页序相反时也必须对）', async () => {
  const zip = await deckOf(buildPptx({
    slides: {
      'slide1.xml': slideXml({ title: '第一页（文件 slide1）', bullets: ['文件名最小的反而在最后'] }),
      'slide2.xml': slideXml({ title: '第二页（文件 slide2）', bullets: ['文件名更大的排第一'] }),
    },
    // 页序：先 slide2.xml 再 slide1.xml —— 按文件名排序就会反过来
    order: ['slide2.xml', 'slide1.xml'],
  }));

  const deck = await readDeck(zip);
  assert.equal(deck.total, 2);
  assert.deepEqual(
    deck.slides.map((s) => s.title),
    ['第二页（文件 slide2）', '第一页（文件 slide1）'],
    '演示文稿页序是 rId→slide2 再 rId→slide1，不能按名字排序',
  );
  assert.deepEqual(deck.slides.map((s) => s.pageNo), [1, 2], '页码要按页序重编');
});

/* 5. 渲染：页序与正文都要真的出现在对应页上 */
test('mountPptx：渲染顺序与 rels 页序一致，标题与要点落在同一页', async () => {
  const zip = await deckOf(buildPptx({
    slides: {
      'slide1.xml': slideXml({ title: '末页标题', bullets: [{ text: '末页要点', level: 0 }] }),
      'slide2.xml': slideXml({ title: '首屏标题', bullets: [{ text: '首屏要点', level: 0 }, { text: '层级二要点', level: 2 }] }),
    },
    order: ['slide2.xml', 'slide1.xml'],
  }));

  const container = newContainer();
  const view = await mountPptx({ zip, container });

  const pages = findAllByClass(container, 'pptx-page');
  assert.equal(pages.length, 2, '一页一片');
  assert.deepEqual(
    findAllByClass(container, 'pptx-page-title').map(textOf),
    ['首屏标题', '末页标题'],
    '渲染顺序必须和 rels 页序一致',
  );
  assert.ok(textOf(pages[0]).includes('首屏要点'), '第一片里要有首屏要点');
  assert.ok(textOf(pages[1]).includes('末页要点'), '第二片里要有末页要点');
  const levels = findAllByClass(pages[0], 'pptx-point').map((node) => node.className);
  assert.ok(
    levels.some((name) => splitClasses(name).includes('pptx-lv-2')),
    `层级 2 的要点要带 pptx-lv-2 缩进类，实际：${JSON.stringify(levels)}`,
  );
  assert.equal(textOf(findAllByClass(container, 'pptx-nav-count')[0]), '1 / 2', '顶部要有 1/N 指示');

  view.destroy();
});

/* 6. 备注：有则折叠区，无则整块不出现 */
test('mountPptx：备注经 slideN.xml.rels 找到并折叠显示；没有备注就不出现折叠区', async () => {
  const zip = await deckOf(buildPptx({
    slides: {
      'slide1.xml': slideXml({ title: '有备注的一页' }),
      'slide2.xml': slideXml({ title: '没有备注的一页' }),
    },
    order: ['slide1.xml', 'slide2.xml'],
    notes: {
      'slide1.xml': { name: 'notesSlide3.xml', xml: notesXml(['这里是演讲者备注']) },
    },
  }));

  const container = newContainer();
  const view = await mountPptx({ zip, container });
  const pages = findAllByClass(container, 'pptx-page');

  const details = findAllByClass(pages[0], 'pptx-notes');
  assert.equal(details.length, 1, '有备注的页要给一个折叠区');
  assert.equal(String(details[0].tagName).toLowerCase(), 'details', '折叠区用 details，默认收起');
  assert.ok(textOf(details[0]).includes('这里是演讲者备注'), '备注正文要进去');
  assert.ok(textOf(details[0]).includes('备注'), '折叠区要能看出是备注');

  assert.equal(findAllByClass(pages[1], 'pptx-notes').length, 0, '没有备注的页不该出现空的折叠区');

  view.destroy();
});

/* 7. 空页 */
test('mountPptx：整页没有任何文字时给「（这一页没有文字内容）」而不是空白', async () => {
  const zip = await deckOf(buildPptx({
    slides: {
      'slide1.xml': slideXml({ title: '', bullets: [], withNumber: false }),
      'slide2.xml': slideXml({ title: '有字的一页', bullets: ['一句话'] }),
    },
    order: ['slide1.xml', 'slide2.xml'],
  }));

  const container = newContainer();
  const view = await mountPptx({ zip, container });
  const pages = findAllByClass(container, 'pptx-page');

  assert.ok(textOf(pages[0]).includes('（这一页没有文字内容）'), `空页要有提示，实际：${textOf(pages[0])}`);
  assert.equal(findAllByClass(pages[0], 'pptx-page-title').length, 0, '空页不该有标题节点');
  assert.ok(!textOf(pages[1]).includes('（这一页没有文字内容）'), '有字的页不该出现空页提示');

  view.destroy();
});

/* 8. 120 页上限 */
test(`readDeck / mountPptx：超过 ${MAX_SLIDES} 页要截断并说明，不许静默丢`, async () => {
  const total = MAX_SLIDES + 5;
  const slides = {};
  const order = [];
  for (let i = 1; i <= total; i += 1) {
    const name = `slide${i}.xml`;
    slides[name] = slideXml({ title: `页-${i}`, bullets: [`第 ${i} 页要点`] });
    order.push(name);
  }
  const zip = await deckOf(buildPptx({ slides, order }));

  const deck = await readDeck(zip);
  assert.equal(deck.total, total, '总页数要如实报出');
  assert.equal(deck.slides.length, MAX_SLIDES, `最多只解析 ${MAX_SLIDES} 页，实际 ${deck.slides.length}`);
  assert.equal(deck.hiddenSlides, total - MAX_SLIDES, '要算清楚被截掉多少页');

  const container = newContainer();
  const view = await mountPptx({ zip, container });
  assert.equal(findAllByClass(container, 'pptx-page').length, MAX_SLIDES, '渲染的页数也不能超过上限');
  const flat = textOf(container);
  assert.ok(flat.includes(`共 ${total} 页`), `要说明总页数，实际：${flat.slice(-160)}`);
  assert.ok(flat.includes(`只显示前 ${MAX_SLIDES} 页`), '要说明只显示前 120 页');
  view.destroy();
});

/* 9. 每页 60 段上限 */
test(`readDeck / mountPptx：单页超过 ${MAX_POINTS} 段要截断并说明`, async () => {
  const bulletCount = MAX_POINTS + 5;
  const bullets = Array.from({ length: bulletCount }, (_v, i) => `要点-${i + 1}`);
  const zip = await deckOf(buildPptx({
    slides: { 'slide1.xml': slideXml({ title: '很长的一页', bullets }) },
    order: ['slide1.xml'],
  }));

  const deck = await readDeck(zip);
  assert.equal(deck.slides[0].points.length, MAX_POINTS, `每页最多 ${MAX_POINTS} 段`);
  assert.equal(deck.slides[0].hiddenPoints, bulletCount - MAX_POINTS, '被截掉的段数要算对');

  const container = newContainer();
  const view = await mountPptx({ zip, container });
  const page = findAllByClass(container, 'pptx-page')[0];
  assert.equal(findAllByClass(page, 'pptx-point').length, MAX_POINTS, '渲染的段数也要受限');
  assert.ok(textOf(page).includes('段没显示'), `要提示截断，实际：${textOf(page)}`);
  assert.ok(!textOf(page).includes(`要点-${bulletCount}`), '被截掉的段落不能出现');
  view.destroy();
});

/* 10. 导航 + destroy */
test('mountPptx：上下页翻动更新 1/N 与当前页；destroy() 清节点并摘掉事件', async () => {
  const zip = await deckOf(buildPptx({
    slides: {
      'slide1.xml': slideXml({ title: '一' }),
      'slide2.xml': slideXml({ title: '二' }),
      'slide3.xml': slideXml({ title: '三' }),
    },
    order: ['slide1.xml', 'slide2.xml', 'slide3.xml'],
  }));

  const container = newContainer();
  const stale = doc.createElement('span');
  stale.textContent = '正在打开…';
  container.appendChild(stale);

  const view = await mountPptx({ zip, container });
  assert.equal(container.children.length, 1, '挂载前要清掉容器里原有的占位内容');
  assert.equal(container.children[0].className, 'pptx-view');

  const counter = findAllByClass(container, 'pptx-nav-count')[0];
  const prev = findAllByClass(container, 'pptx-nav-btn').find((n) => n.classList.contains('pptx-prev'));
  const next = findAllByClass(container, 'pptx-nav-btn').find((n) => n.classList.contains('pptx-next'));
  const pages = findAllByClass(container, 'pptx-page');

  assert.equal(textOf(counter), '1 / 3');
  assert.equal(prev.disabled, true, '第一页的「上一页」要禁用');

  next.click();
  assert.equal(textOf(counter), '2 / 3', '按下「下一页」页码指示要跟着走');
  assert.ok(pages[1].classList.contains('pptx-page-current'), '当前页要标记出来');
  assert.ok(!pages[0].classList.contains('pptx-page-current'), '旧当前页要去掉标记');
  assert.equal(pages[1].scrollCalls.length, 1, '翻页要把目标页滚到视野里');

  next.click();
  next.click();
  assert.equal(textOf(counter), '3 / 3', '翻到末页就停住，不能越界');
  assert.equal(next.disabled, true, '末页的「下一页」要禁用');

  const beforeDestroy = textOf(counter);
  view.destroy();
  assert.equal(container.children.length, 0, 'destroy() 要把节点从容器里摘干净');
  next.dispatchEvent('click');
  assert.equal(textOf(counter), beforeDestroy, 'destroy() 之后事件必须摘掉，点击不能再改状态');
  view.destroy(); // 重复调用不许抛
});

/* ------------------------------ 跑测 ------------------------------ */

// 用例必须全部登记完再跑：写在循环后面的用例永远不会执行，却照样打印 ALL PASS。
assert.ok(cases.length >= 10, `只登记了 ${cases.length} 个用例，用例表被截断了`);
console.log(`cases=${cases.length} slides=${MAX_SLIDES} points=${MAX_POINTS}`);

let bad = 0;
for (const item of cases) {
  try {
    await item.fn();
    console.log(`PASS  ${item.name}`);
  } catch (err) {
    bad += 1;
    console.log(`FAIL  ${item.name}\n      ${err && err.stack ? err.stack : err}`);
  }
}

if (bad > 0) {
  console.log(`\n${bad} TESTS FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
