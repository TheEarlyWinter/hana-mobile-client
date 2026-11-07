/* tests/css_structure.test.mjs — web/**\/*.css 的花括号结构审计
 *
 * 起因：57aac36 修掉的那处 .message-search-input，坏的是「花括号错位 / 声明掉到规则块外」
 * 这一整类问题。CSS 解析器对它是静默的：多余的 `}` 被丢弃、掉队的声明被当成垃圾跳过，
 * 页面照样加载、样式表照样 200，只是那条声明再也不生效 —— 肉眼看不出，现有测试也测不到。
 * 这里把它变成可执行的断言。
 *
 * 对 web/ 下每个 .css 文件：
 *   a. `{` 与 `}` 数量相等、最终深度为 0、全程不出现负深度（多一个 `}`）；
 *   b. 深度 0 处不存在「声明」：顶层只允许选择器与 at-rule（以 @ 开头）。
 *      判据两条一起用，宁可少报也不误报：
 *      - 词法级：深度 0 的语句以 `标识符:` 开头、并以 `;` 结束 → 裸声明；
 *      - 行级：深度 0 的行匹配 `^\s{2,}[a-zA-Z-]+\s*:` → 缩进形态的裸声明。
 *      `@keyframes` 里的 `from/to/0%` 都在深度 ≥1，天然落在判据之外；判据里仍显式跳过，
 *      免得以后有人把 keyframes 里的百分比帧写得很怪时误报。
 *
 * 先剥掉注释与字符串再数括号：warm-paper.css 里 47KB 的底色 base64 和内联 SVG
 * 都躺在引号里，不剥就会把 url() 的字符当成语法读。
 *
 * 已知盲区（故意不做的）：两个错位互相抵消的「把后面的 } 挪到文件尾」型 ——
 * 括号数仍相等，后续规则只是变成了嵌套子规则。那不是声明掉队，属性依旧生效（只是选择器变成
 * 后代关系），靠文本括号数判断不了，需要真 CSSOM 解析；宁可漏报也不在这里误报。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');

/** 注释与字符串内容换成空格，换行原样保留（行号不变）。 */
function sanitize(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) out += blank(text[k]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) {
          out += blank(text[j]);
          out += blank(text[j + 1]);
          j += 2;
          continue;
        }
        if (text[j] === c) {
          out += c;
          j += 1;
          break;
        }
        out += blank(text[j]);
        j += 1;
      }
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 扫一遍 CSS 源码，返回括号计数、最终深度与结构问题。 */
function analyzeCss(text) {
  const clean = sanitize(text);
  const problems = [];
  const stack = [];
  let open = 0;
  let close = 0;
  let depth = 0;
  let minDepth = 0;

  let line = 1;
  let lineStartDepth = 0;
  let lineStartInKeyframes = false;
  let lineBuf = '';

  let preludeBuf = ''; // 自上次 ; { } 以来的文本，用来认 @keyframes
  let stmtBuf = ''; // 深度 0 的顶层语句
  let stmtLine = 1;

  const inKeyframes = () => stack.some((block) => block.keyframes);

  const endLine = () => {
    if (lineStartDepth === 0 && !lineStartInKeyframes) {
      const m = /^\s{2,}([a-zA-Z-]+)\s*:/.exec(lineBuf);
      if (m) problems.push({ kind: 'indented-declaration', line, text: lineBuf.trim() });
    }
    lineBuf = '';
  };

  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];

    if (c === '\n') {
      endLine();
      line += 1;
      lineStartDepth = depth;
      lineStartInKeyframes = inKeyframes();
      continue;
    }

    lineBuf += c;

    if (c === '{') {
      open += 1;
      stack.push({ line, keyframes: /@(-[a-z]+-)?keyframes\b/.test(preludeBuf) });
      depth += 1;
      preludeBuf = '';
      stmtBuf = '';
      continue;
    }

    if (c === '}') {
      close += 1;
      depth -= 1;
      if (depth < minDepth) minDepth = depth;
      stack.pop();
      preludeBuf = '';
      stmtBuf = '';
      continue;
    }

    if (c === ';') {
      const stmt = stmtBuf.trim();
      if (depth === 0 && !stmt.startsWith('@') && /^[a-zA-Z-][a-zA-Z0-9-]*\s*:/.test(stmt)) {
        problems.push({ kind: 'bare-declaration', line: stmtLine, text: stmt.slice(0, 120) });
      }
      preludeBuf = '';
      stmtBuf = '';
      continue;
    }

    preludeBuf += c;
    if (depth === 0) {
      if (stmtBuf.trim() === '') stmtLine = line;
      stmtBuf += c;
    }
  }

  endLine();

  return { open, close, depth, minDepth, problems, openLines: stack.map((block) => block.line) };
}

function walkCss(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walkCss(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      acc.push(full);
    }
  }
  return acc;
}

const CSS_FILES = walkCss(WEB_DIR).sort();
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    const detail = String(err.message || err).split('\n').slice(0, 24).join('\n      ');
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

t('扫描器能找到 web/ 下的 CSS 文件', () => {
  assert.ok(CSS_FILES.length >= 20, `只扫到 ${CSS_FILES.length} 个 .css，路径或过滤条件不对`);
  const names = CSS_FILES.map(rel);
  assert.ok(names.includes('web/style.css'), '缺少 web/style.css');
  assert.ok(names.includes('web/themes/dark.css'), '缺少 web/themes/dark.css');
  assert.ok(names.includes('web/feed/feed.css'), '缺少 web/feed/feed.css（子目录要递归）');
});

t('每个 CSS 文件花括号配平且最终深度为 0', () => {
  const failures = [];
  for (const file of CSS_FILES) {
    const r = analyzeCss(fs.readFileSync(file, 'utf8'));
    const balanced = r.open === r.close && r.depth === 0 && r.minDepth === 0;
    if (!balanced) {
      failures.push(
        `${rel(file)}: {=${r.open} }=${r.close} finalDepth=${r.depth} minDepth=${r.minDepth}` +
          (r.openLines.length ? ` 未闭合块起始行=${r.openLines.join(',')}` : ''),
      );
    }
  }
  assert.deepEqual(failures, [], `花括号不配平：\n${failures.join('\n')}`);
});

t('深度 0 处没有裸声明（含缩进形态）', () => {
  const failures = [];
  for (const file of CSS_FILES) {
    const r = analyzeCss(fs.readFileSync(file, 'utf8'));
    for (const p of r.problems) {
      failures.push(`${rel(file)}:${p.line} [${p.kind}] ${p.text}`);
    }
  }
  assert.deepEqual(failures, [], `规则块外出现声明（多半是前面多关了一个 }）：\n${failures.join('\n')}`);
});

t('自检：少一个 } 必须被判成不配平', () => {
  const r = analyzeCss('.a {\n  color: red;\n\n.b {\n  color: blue;\n}\n');
  assert.equal(r.depth, 1, '最终深度应为 1');
  assert.ok(r.open !== r.close, '`{` 与 `}` 数量应不等');
  assert.deepEqual(r.openLines, [1], '未闭合块的起始行应是第 1 行');
});

t('自检：多一个 } 必须被判成负深度', () => {
  const r = analyzeCss('.a { color: red; }\n}\n');
  assert.ok(r.minDepth < 0, '多出来的 } 应让深度变负');
});

t('自检：} 提前关掉之后，后面的声明必须被抓成裸声明', () => {
  // 就是这次事故的形态：块被提前关掉，剩下的声明掉到顶层
  const src = '.x {\n  height: 38px;\n}\n  display: none;\n}\n';
  const r = analyzeCss(src);
  const kinds = r.problems.map((p) => `${p.kind}@${p.line}`);
  assert.ok(
    kinds.includes('bare-declaration@4') || kinds.includes('indented-declaration@4'),
    `第 4 行的 display: none 应被抓到，实际：${JSON.stringify(r.problems)}`,
  );
});

t('自检：正常写法（含 @media / @keyframes / 内联 SVG 字符串）不许误报', () => {
  const src = [
    ':root {',
    '  --arrow: url("data:image/svg+xml,%3Csvg width=\'10\' height=\'6\'/%3E");',
    '}',
    '',
    '@media (max-width: 540px) {',
    '  .grid {',
    '    grid-template-columns: repeat(4, minmax(0, 1fr));',
    '  }',
    '  from { opacity: 0; }',
    '}',
    '',
    '@keyframes k {',
    '  0%, 100% { opacity: 1; }',
    '  50% { opacity: 0.35; }',
    '}',
    '',
    '.a:hover,',
    '.b[data-x="1"] {',
    '  color: red;',
    '}',
    '',
  ].join('\n');
  const r = analyzeCss(src);
  assert.deepEqual(r.problems, [], `不应有结构问题：${JSON.stringify(r.problems)}`);
  assert.equal(r.depth, 0, '正常写法最终深度应为 0');
  assert.equal(r.open, r.close, '正常写法括号应配平');
});

console.log(
  `\nfiles=${CSS_FILES.length} pass=${bad === 0 ? 'yes' : 'no'} ${bad === 0 ? '' : `failing=${bad}`}`.trim(),
);
if (bad > 0) process.exitCode = 1;
