/* pptx-preview.js — 手机端 .pptx 内置预览（文本级）
 *
 * WebView 没有 Office 渲染，手机上看幻灯只能给「读字」这一层：
 * 按演示文稿自己的页序逐页取标题、正文要点、备注，排成一面纵向的纸。
 * 不做版式还原（没有颜色、位置、图片），也不做 .ppt 老二进制。
 *
 * 两个容易被想当然的地方：
 *  1. 页序不是文件名顺序。真页序在 ppt/presentation.xml 的 <p:sldIdLst> 里，
 *     每条 <p:sldId r:id="…"> 再经 ppt/_rels/presentation.xml.rels 的 Target 落到文件。
 *     用户拖动过幻灯片之后 slide3.xml 完全可能是第 1 页，所以必须走 rels。
 *  2. 备注不在幻灯片自己的 xml 里，要靠 ppt/slides/_rels/slideN.xml.rels 的 notesSlide 关系找。
 *
 * 解析（纯函数，只吃字符串）与渲染（mountPptx，吃 zip + 容器）分开，前者可单独测。
 */

/** 最多显示多少页（超出截断，不静默丢） */
export const MAX_SLIDES = 120;
/** 每页最多显示多少段正文 */
export const MAX_POINTS = 60;
/** 缩进层级上限：再深也只缩到这里，360px 宽的屏上再多缩就没字了 */
const MAX_LEVEL = 3;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const SLIDE_REL_TYPE = /\/slide$/i;
const NOTES_REL_TYPE = /\/notesSlide$/i;

/* ------------------------------ 小工具 ------------------------------ */

function decodeXml(value) {
  return String(value ?? '').replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, name) => {
    if (name.charAt(0) === '#') {
      const hex = name.charAt(1) === 'x' || name.charAt(1) === 'X';
      const code = parseInt(hex ? name.slice(2) : name.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) attrs[m[1]] = m[2];
  return attrs;
}

/** 遍历正则的全局匹配（比拿 matchAll 少一层 array）。 */
function eachMatch(text, re, visit) {
  let m;
  while ((m = re.exec(text))) visit(m);
}

function clampLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_LEVEL, Math.floor(n));
}

/** `ppt` + `slides/slide1.xml` / `/ppt/slides/slide1.xml` / `../notesSlides/x.xml` → 归一化条目名。 */
function resolvePath(baseDir, target) {
  const raw = String(target || '').replace(/\\/g, '/').trim();
  if (!raw) return null;
  const joined = raw.charAt(0) === '/' ? raw.slice(1) : `${baseDir ? baseDir + '/' : ''}${raw}`;
  const out = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

function baseOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/* ------------------------------ 关系表 ------------------------------ */

/**
 * 解析 .rels：Id → { type, target, external }。
 * @param {string} xml
 * @returns {Map<string, {type: string, target: string, external: boolean}>}
 */
export function parseRels(xml) {
  const map = new Map();
  if (!xml) return map;
  eachMatch(String(xml), /<Relationship\b([^>]*?)\/?>/g, (m) => {
    const attrs = parseAttrs(m[1]);
    const id = attrs.Id;
    if (!id) return;
    map.set(id, {
      type: attrs.Type || '',
      target: attrs.Target || '',
      external: /^external$/i.test(attrs.TargetMode || ''),
    });
  });
  return map;
}

/**
 * 真页序：presentation.xml 的 sldIdLst 顺序 + presentation.xml.rels 的 Target 映射。
 * 不按文件名排序——文件名顺序只在「拖过页」之后就和页序无关了。
 *
 * @param {string} presentationXml
 * @param {string} relsXml
 * @returns {string[]} 条目名数组，例如 ['ppt/slides/slide3.xml', 'ppt/slides/slide1.xml']
 */
export function parseSlideOrder(presentationXml, relsXml) {
  if (!presentationXml) return [];
  const rels = parseRels(relsXml);
  const pres = String(presentationXml);
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(pres);
  const scope = list ? list[1] : pres;
  const order = [];
  eachMatch(scope, /<p:sldId\b[^>]*>/g, (m) => {
    const attrs = parseAttrs(m[0]);
    const rid = attrs['r:id'] || attrs['relationships:id'] || '';
    const rel = rels.get(rid);
    if (!rel || rel.external || !SLIDE_REL_TYPE.test(rel.type || '/slide')) return;
    const path = resolvePath('ppt', rel.target);
    if (path && !order.includes(path)) order.push(path);
  });
  return order;
}

/* ------------------------------ 幻灯片 ------------------------------ */

/** 占位符类型（title / ctrTitle / body / sldNum / ftr / dt …），没有 p:ph 就是空串。 */
function placeholderType(spXml) {
  const ph = /<p:ph\b([^>]*?)\/?>/.exec(spXml);
  if (!ph) return '';
  return String(parseAttrs(ph[1]).type || '').toLowerCase();
}

/** 段落层级：先认 lvl，再退回 marL（PowerPoint 每级默认 342900 EMU）。 */
function paragraphLevel(body) {
  const pPr = /<a:pPr\b([^>]*?)\/?>/.exec(body);
  if (!pPr) return 0;
  const attrs = parseAttrs(pPr[1]);
  if (attrs.lvl !== undefined) return clampLevel(attrs.lvl);
  const marL = parseInt(attrs.marL, 10);
  if (Number.isFinite(marL) && marL > 0) return clampLevel(marL / 342900);
  return 0;
}

/** 一段里的文字：多个 <a:t> 拼起来，<a:br/> 当空格。 */
function paragraphText(body) {
  return String(body)
    .split(/<a:br\s*\/>/)
    .map((segment) => {
      let out = '';
      eachMatch(segment, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (m) => {
        out += m[1];
      });
      return decodeXml(out).replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join(' ');
}

/** 一个 txBody 片段里的段落（空段丢掉，纯格式段不占位置）。 */
function paragraphsOf(xml) {
  const out = [];
  eachMatch(String(xml || ''), /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g, (m) => {
    const text = paragraphText(m[1]);
    if (!text) return;
    out.push({ text, level: paragraphLevel(m[1]) });
  });
  return out;
}

/**
 * 幻灯片 xml → { title, points:[{text, level}] }。
 * 标题取 ph type=title|ctrTitle 的段落；其余形状的段落按出现顺序当要点；
 * 页码 / 页脚 / 日期占位符是噪音，直接跳过。
 *
 * @param {string|null} xml
 */
export function parseSlideXml(xml) {
  const result = { title: '', points: [] };
  if (!xml) return result;
  const titleParts = [];
  eachMatch(String(xml), /<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/g, (m) => {
    const type = placeholderType(m[0]);
    if (type === 'sldnum' || type === 'ftr' || type === 'dt') return;
    const paras = paragraphsOf(m[1]);
    if (!paras.length) return;
    if (type === 'title' || type === 'ctrtitle') {
      for (const p of paras) titleParts.push(p.text);
      return;
    }
    for (const p of paras) result.points.push(p);
  });
  result.title = titleParts.join(' ').trim();
  return result;
}

/**
 * 备注页 xml → 纯文本段落数组。页码占位符（sldNum）与占位图跳过。
 * @param {string|null} xml
 */
export function parseNotesXml(xml) {
  const out = [];
  if (!xml) return out;
  eachMatch(String(xml), /<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/g, (m) => {
    const type = placeholderType(m[0]);
    if (type === 'sldnum' || type === 'sldimg') return;
    for (const p of paragraphsOf(m[1])) out.push(p.text);
  });
  return out;
}

/* ------------------------------ 整本 ------------------------------ */

/** presentation.xml 读不出来时的兜底：按文件名数字序（不理想，但比一片空白强）。 */
function slideNamesFromZip(zip) {
  return zip.match('ppt/slides/')
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** 备注条目名：先走 slideN.xml.rels 的 notesSlide 关系，再退回同名编号。 */
async function readNotes(zip, slidePath) {
  const dir = dirOf(slidePath);
  const relsPath = `${dir}/_rels/${baseOf(slidePath)}.rels`;
  const candidates = [];
  if (zip.has(relsPath)) {
    const rels = parseRels(await zip.text(relsPath));
    for (const rel of rels.values()) {
      if (rel.external) continue;
      if (!NOTES_REL_TYPE.test(rel.type || '')) continue;
      const path = resolvePath(dir, rel.target);
      if (path) candidates.push(path);
    }
  }
  const numbered = /slide(\d+)\.xml$/i.exec(slidePath);
  if (numbered) candidates.push(`ppt/notesSlides/notesSlide${numbered[1]}.xml`);

  for (const path of candidates) {
    if (!zip.has(path)) continue;
    const paragraphs = parseNotesXml(await zip.text(path));
    if (paragraphs.length) return paragraphs;
  }
  return [];
}

async function readSlide(zip, path, pageNo) {
  const parsed = parseSlideXml(await zip.text(path));
  const notes = await readNotes(zip, path);
  return {
    path,
    pageNo,
    title: parsed.title,
    points: parsed.points.slice(0, MAX_POINTS),
    hiddenPoints: Math.max(0, parsed.points.length - MAX_POINTS),
    notes,
    empty: !parsed.title && parsed.points.length === 0,
  };
}

/**
 * 整本解析。
 * @param {{ has(n: string): boolean, match(p: string): string[], text(n: string): Promise<string|null> }} zip
 * @returns {Promise<{ slides: Array<object>, total: number, hiddenSlides: number }>}
 */
export async function readDeck(zip) {
  if (!zip || typeof zip.text !== 'function' || typeof zip.has !== 'function') {
    throw new Error('readDeck 需要 zip-reader 的 zip 对象');
  }
  const [presentationXml, presentationRels] = await Promise.all([
    zip.text('ppt/presentation.xml'),
    zip.text('ppt/_rels/presentation.xml.rels'),
  ]);

  const ordered = parseSlideOrder(presentationXml, presentationRels);
  const paths = (ordered.length ? ordered : slideNamesFromZip(zip)).filter((path) => zip.has(path));

  const slides = [];
  for (const path of paths.slice(0, MAX_SLIDES)) {
    slides.push(await readSlide(zip, path, slides.length + 1));
  }
  return {
    slides,
    total: paths.length,
    hiddenSlides: Math.max(0, paths.length - MAX_SLIDES),
  };
}

/* ------------------------------ 渲染 ------------------------------ */

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function add(parent, ...kids) {
  for (const kid of kids) if (kid) parent.appendChild(kid);
  return parent;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setAttr(node, name, value) {
  if (typeof node.setAttribute === 'function') node.setAttribute(name, value);
}

function renderPage(doc, slide) {
  const page = el(doc, 'section', 'pptx-page');
  setAttr(page, 'data-page', String(slide.pageNo));

  const head = el(doc, 'div', 'pptx-page-head');
  add(head, el(doc, 'span', 'pptx-page-no', `第 ${slide.pageNo} 页`));
  add(page, head);

  if (slide.title) add(page, el(doc, 'h2', 'pptx-page-title', slide.title));

  if (slide.points.length) {
    const list = el(doc, 'ul', 'pptx-points');
    for (const point of slide.points) {
      const item = el(doc, 'li', `pptx-point pptx-lv-${Math.min(point.level || 0, MAX_LEVEL)}`, point.text);
      add(list, item);
    }
    add(page, list);
  }

  if (slide.empty) {
    add(page, el(doc, 'p', 'pptx-page-empty', '（这一页没有文字内容）'));
  }

  if (slide.hiddenPoints > 0) {
    add(
      page,
      el(doc, 'p', 'pptx-page-more', `这一页还有 ${slide.hiddenPoints} 段没显示（每页最多 ${MAX_POINTS} 段）`),
    );
  }

  if (slide.notes.length) {
    const details = el(doc, 'details', 'pptx-notes');
    add(details, el(doc, 'summary', 'pptx-notes-summary', `备注（${slide.notes.length} 段）`));
    const body = el(doc, 'div', 'pptx-notes-body');
    for (const text of slide.notes) add(body, el(doc, 'p', 'pptx-notes-line', text));
    add(details, body);
    add(page, details);
  }

  return page;
}

/**
 * 把一本 pptx 挂到容器里。
 *
 * @param {{ zip: object, container: Element }} opts
 * @returns {Promise<{ destroy(): void, deck: object }>}
 */
export async function mountPptx({ zip, container } = {}) {
  if (!container) throw new Error('mountPptx 需要一个容器节点');
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('mountPptx 需要可用的 document');

  let deck;
  let failure = '';
  try {
    deck = await readDeck(zip);
  } catch (err) {
    failure = '这个 pptx 打不开：' + (err && err.message ? err.message : String(err));
    deck = { slides: [], total: 0, hiddenSlides: 0 };
  }

  clearChildren(container);

  const root = el(doc, 'div', 'pptx-view');
  const nav = el(doc, 'div', 'pptx-nav');
  const prev = el(doc, 'button', 'pptx-nav-btn pptx-prev', '上一页');
  prev.type = 'button';
  const next = el(doc, 'button', 'pptx-nav-btn pptx-next', '下一页');
  next.type = 'button';
  const counter = el(doc, 'span', 'pptx-nav-count', '0 / 0');
  add(nav, prev, counter, next);

  const list = el(doc, 'div', 'pptx-list');
  const pages = deck.slides.map((slide) => {
    const page = renderPage(doc, slide);
    add(list, page);
    return page;
  });

  add(root, nav, list);

  if (failure) {
    add(list, el(doc, 'p', 'pptx-empty', failure));
  } else if (!pages.length) {
    add(list, el(doc, 'p', 'pptx-empty', '这个 pptx 里没有可预览的幻灯片'));
  } else if (deck.hiddenSlides > 0) {
    add(
      list,
      el(doc, 'p', 'pptx-more', `共 ${deck.total} 页，只显示前 ${MAX_SLIDES} 页（还有 ${deck.hiddenSlides} 页没显示）`),
    );
  }

  container.appendChild(root);

  let index = 0;
  let destroyed = false;

  function paint() {
    if (!pages.length) {
      counter.textContent = '0 / 0';
      prev.disabled = true;
      next.disabled = true;
      return;
    }
    counter.textContent = `${index + 1} / ${pages.length}`;
    prev.disabled = index <= 0;
    next.disabled = index >= pages.length - 1;
    pages.forEach((page, i) => {
      // 假 DOM 没有 classList.toggle，这里只用 add/remove。
      if (i === index) page.classList.add('pptx-page-current');
      else page.classList.remove('pptx-page-current');
    });
  }

  function goTo(target) {
    if (!pages.length) return;
    index = Math.max(0, Math.min(pages.length - 1, target));
    paint();
    const page = pages[index];
    if (typeof page.scrollIntoView === 'function') {
      page.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  const onPrev = () => goTo(index - 1);
  const onNext = () => goTo(index + 1);
  prev.addEventListener('click', onPrev);
  next.addEventListener('click', onNext);

  paint();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    prev.removeEventListener('click', onPrev);
    next.removeEventListener('click', onNext);
    if (root.parentNode) root.parentNode.removeChild(root);
    clearChildren(container);
    pages.length = 0;
  }

  return { destroy, deck };
}
