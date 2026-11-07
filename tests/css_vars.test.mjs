/* tests/css_vars.test.mjs — web/**\/*.css 的 CSS 变量引用审计
 *
 * 起因：web/style.css 的 .chat-skeleton 写了 `gap: var(--space-20);`，而间距刻度里
 * 只有 2/4/6/8/10/12/14/16/24/32/40，从来没有 --space-20，也没写 fallback。
 * 这种写法在浏览器里是**静默失效**：var() 引用一个未定义的自定义属性、又没给 fallback 时，
 * 声明的值变成 guaranteed-invalid，整条声明在计算值阶段被丢弃，属性回到初始值
 * （gap 初始是 normal，flex 列里等于 0）。样式表照样 200、解析器照旧不报错，
 * 只是骨架屏的行距静默归零 —— 肉眼只能看到「看着怪」，现有测试一条都测不到。
 *
 * 这里把它变成可执行的断言：除显式豁免名单外，任何 `var(--x)`（**无 fallback** 形态）
 * 的 --x 都必须能在某个 CSS 文件里找到 `--x: ...` 的声明。
 *
 * 判定边界（故意这么收窄，宁可少报也不误报）：
 *   - 只看 web/ 下的 .css，不看 JS 里拼出来的字符串；声明也只在 CSS 里找。
 *   - 「声明」= 任意选择器块里出现的 `--name:`，不要求一定在 :root：
 *     dark.css 的令牌全部在 `:root[data-theme='dark']` 下，workspace.css 的
 *     --workspace-safe-top 也在自己的 :root 里，它们都是合法定义，不许被当成缺失。
 *   - 深色专属令牌（--on-accent / --text-main / --surface ...）只在 dark.css 里声明，
 *     在浅色样式里引用时都带了 fallback，因此天然落在断言之外，不会被误报。
 *   - 带 fallback 的 `var(--x, 5px)` 不查：即使 --x 未定义，浏览器也用 fallback，
 *     不会有静默失效，最多是「刻度外的散值」，不属于本测试管的故障类型。
 *
 * 先剥注释与字符串再扫：warm-paper.css 里 47KB 的 base64 与内联 SVG 都躺在引号里。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = path.join(ROOT, 'web');

/* 显式豁免名单：`--name` -> 理由（必须非空）。
 *
 * 当前为空，且是**真的**空：没有任何「引用时没 fallback、CSS 里也没声明」的令牌值得放过。
 * 两类常见的该进这里的候选，在本次体检里都不需要豁免：
 *   - 运行时注入：--kb（mobile-lifecycle.js / message-search.js 用 setProperty 改写根节点）、
 *     --chat-message-font-size（settings-view.js 同上）。它们虽然是被 JS 写的，
 *     但在 style.css 的 :root 里都有初值声明，正常断言就能过，不该进豁免。
 *   - 宿主注入：本项目的 Android WebView / 网关模板都不往页面里塞自定义属性，没有这一类。
 *
 * 以后如果真出现「只在 JS/宿主里给值、CSS 里一个初值都没有」的令牌，把名字加在这里，
 * 理由写清楚是谁注入的、为什么不能给它补一个 CSS 初值。下面的用例会检查：
 * 名单里的名字必须**确实**在 CSS 里找不到声明（否则是腐烂的豁免），理由不能为空。
 */
const EXEMPT = Object.freeze({});

/* ---------------- 扫描 ---------------- */

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

/** 从 start（指向 `(`）开始找配对的 `)`，返回内部文本的结束下标。 */
function matchParen(clean, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 扫一份（已 sanitize 的）CSS，返回：
 *   decls: [{ name, line }]  —— 所有 `--name:` 声明
 *   refs:  [{ name, line, hasFallback, text }] —— 所有 var(--name…) 引用
 */
function scan(clean) {
  const lineAt = (idx) => clean.slice(0, idx).split('\n').length;
  const decls = [];
  const refs = [];

  const declRe = /(--[a-zA-Z0-9_-]+)\s*:/g;
  let m;
  while ((m = declRe.exec(clean)) !== null) {
    decls.push({ name: m[1], line: lineAt(m.index) });
  }

  const refRe = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  while ((m = refRe.exec(clean)) !== null) {
    const openIndex = m.index + 3; // 指向 `(`
    const closeIndex = matchParen(clean, openIndex);
    const innerEnd = closeIndex === -1 ? clean.length : closeIndex;
    const inner = clean.slice(openIndex + 1, innerEnd);
    // 顶层逗号 = 有 fallback；嵌套括号里的逗号不算（var(--a, var(--b, 1px))）
    let depth = 0;
    let hasFallback = false;
    for (const ch of inner) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        hasFallback = true;
        break;
      }
    }
    const lineNo = lineAt(m.index);
    refs.push({
      name: m[1],
      line: lineNo,
      hasFallback,
      text: clean.split('\n')[lineNo - 1].trim(),
    });
  }

  return { decls, refs };
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

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

const CSS_FILES = walkCss(WEB_DIR).sort();

/** name -> Set(声明它的相对路径) */
const DECLARED = new Map();
/** 全部引用：[{ file, name, line, hasFallback, text }] */
const REFERENCES = [];
for (const file of CSS_FILES) {
  const clean = sanitize(fs.readFileSync(file, 'utf8'));
  const { decls, refs } = scan(clean);
  for (const d of decls) {
    if (!DECLARED.has(d.name)) DECLARED.set(d.name, new Set());
    DECLARED.get(d.name).add(rel(file));
  }
  for (const r of refs) REFERENCES.push({ file: rel(file), ...r });
}

/** 无 fallback 且（除豁免外）没有任何声明的引用。 */
function danglingRefs(exempt = EXEMPT) {
  return REFERENCES.filter(
    (r) => !r.hasFallback && !DECLARED.has(r.name) && !Object.hasOwn(exempt, r.name),
  );
}

let bad = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    bad += 1;
    const detail = String(err.message || err).split('\n').slice(0, 40).join('\n      ');
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

t('扫描器能找到 web/ 下的 CSS 文件', () => {
  assert.ok(CSS_FILES.length >= 20, `只扫到 ${CSS_FILES.length} 个 .css，路径或过滤条件不对`);
  const names = CSS_FILES.map(rel);
  assert.ok(names.includes('web/style.css'), '缺少 web/style.css');
  assert.ok(names.includes('web/themes/warm-paper.css'), '缺少 web/themes/warm-paper.css');
  assert.ok(names.includes('web/themes/dark.css'), '缺少 web/themes/dark.css');
  assert.ok(names.includes('web/feed/feed.css'), '缺少 web/feed/feed.css（子目录要递归）');
});

t('声明表读得到 :root 里的刻度，也读不到不存在的 --space-20', () => {
  assert.ok(DECLARED.size >= 80, `只读到 ${DECLARED.size} 个自定义属性声明，抽取逻辑不对`);
  for (const real of ['--space-16', '--space-24', '--fs-body', '--radius-page']) {
    assert.ok(DECLARED.has(real), `${real} 应该在 style.css 的 :root 里被声明`);
  }
  // 这次事故的形状：刻度里没有 20，所以它必须查不到声明。
  assert.ok(!DECLARED.has('--space-20'), '--space-20 居然有声明了？间距刻度里本来没有 20');
  // 深色专属令牌要能在 dark.css 里找到，不能被当成「从没定义」。
  for (const darkOnly of ['--on-accent', '--surface', '--text-main']) {
    assert.ok(
      DECLARED.get(darkOnly)?.has('web/themes/dark.css'),
      `${darkOnly} 应在 web/themes/dark.css 里有声明（深色专属令牌，不许当缺失）`,
    );
  }
});

t('无 fallback 的 var(--x) 都指向真实存在的声明', () => {
  const failures = danglingRefs().map(
    (r) => `${r.file}:${r.line} 引用未定义的 ${r.name}（且没写 fallback）：${r.text}`,
  );
  assert.deepEqual(failures, [], `引用了从没声明过、也没 fallback 的自定义属性（声明会被浏览器丢弃）：\n${failures.join('\n')}`);
});

t('豁免名单：理由非空，且名字必须真的是 CSS 里查不到的', () => {
  const problems = [];
  for (const [name, reason] of Object.entries(EXEMPT)) {
    if (typeof reason !== 'string' || reason.trim().length < 12) {
      problems.push(`${name} 的豁免理由为空或太短：${JSON.stringify(reason)}`);
    }
    if (DECLARED.has(name)) {
      problems.push(
        `${name} 在 ${[...DECLARED.get(name)].join(', ')} 里其实有声明，这条豁免已经过期，应该删掉`,
      );
    }
  }
  assert.deepEqual(problems, [], `豁免名单有问题：\n${problems.join('\n')}`);
});

t('自检：合成 CSS 里的 var(--nope-xyz) 必须被抓到', () => {
  const clean = sanitize(':root { --real: 1px; }\n.a {\n  gap: var(--nope-xyz);\n}\n');
  const { decls, refs } = scan(clean);
  assert.deepEqual(decls.map((d) => d.name), ['--real']);
  const dangling = refs.filter((r) => !r.hasFallback && !decls.some((d) => d.name === r.name));
  assert.equal(dangling.length, 1, `应抓到 1 条悬空引用，实际 ${dangling.length}`);
  assert.equal(dangling[0].name, '--nope-xyz');
  assert.equal(dangling[0].line, 3, '行号应指到第 3 行');
});

t('自检：带 fallback 的 var(--x, …) 不算悬空（含嵌套 var）', () => {
  const clean = sanitize(
    '.a {\n  gap: var(--nope-a, 4px);\n  color: var(--nope-b, var(--nope-c, red));\n}\n',
  );
  const { refs } = scan(clean);
  assert.equal(refs.length, 3);
  for (const r of refs) assert.equal(r.hasFallback, true, `${r.name} 应被判定为带 fallback`);
});

t('自检：注释与字符串里的 var(--nope-xyz) 不许误报', () => {
  const clean = sanitize(
    [
      '/* .a { gap: var(--nope-in-comment); } */',
      '.a { content: "var(--nope-in-string)"; }',
      '.b { background: url("data:image/svg+xml,%3Csvg/%3E"); }',
      '',
    ].join('\n'),
  );
  const { refs } = scan(clean);
  assert.deepEqual(refs, [], `注释/字符串里的 var() 不该被扫出来：${JSON.stringify(refs)}`);
});

t('自检：事故形态（gap: var(--space-20) 无 fallback）必须被判成悬空', () => {
  // 直接用当前真实文件跑一遍判定函数，但把 --space-20 当成「已存在于某个文件」的反面参照：
  // 这里构造一份只声明到 --space-16 的假 :root，引用 --space-20 必须判成悬空。
  const fake = sanitize(
    [':root {', '  --space-16: 16px;', '}', '.chat-skeleton {', '  gap: var(--space-20);', '}', ''].join(
      '\n',
    ),
  );
  const { decls, refs } = scan(fake);
  const dangling = refs.filter((r) => !r.hasFallback && !decls.some((d) => d.name === r.name));
  assert.equal(dangling.length, 1, '事故形态必须被判成悬空');
  assert.equal(dangling[0].name, '--space-20');
});

console.log(
  `\nfiles=${CSS_FILES.length} declared=${DECLARED.size} refs=${REFERENCES.length} ` +
    `noFallback=${REFERENCES.filter((r) => !r.hasFallback).length} ` +
    `pass=${bad === 0 ? 'yes' : 'no'}${bad === 0 ? '' : ` failing=${bad}`}`,
);
if (bad > 0) process.exitCode = 1;
