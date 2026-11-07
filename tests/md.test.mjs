/* Markdown 渲染器测试
 * 之前这版 import 的是 ./md.mjs、样例读的是 ./sample.md，两个文件都不存在，
 * 实际上一直没跑起来。这里改成直接引 ../web/md.js，样例内联。
 */

import { renderMarkdown } from '../web/md.js';

const sample = `# 标题一

段落里有 **粗体**、*斜体*、~~删除线~~ 和 \`行内代码\`，还有 [链接](https://example.com)。

裸链接 https://github.com/Fei2411/DS-Bot 也要能点。

- 无序一
- 无序二

1. 有序一
2. 有序二

> 引用一行

\`\`\`ts
const x: number = 1;
if (x < 2 && "ok") {}
\`\`\`

| 列 A | 列 B |
| --- | --- |
| 1 | 2 |

---
`;

const out = renderMarkdown(sample);

const checks = [
  ['heading', /<h1 class="md-h">标题一<\/h1>/],
  ['bold', /<strong>粗体<\/strong>/],
  ['italic', /<em>斜体<\/em>/],
  ['strike', /<del>删除线<\/del>/],
  ['inline-code', /<code>行内代码<\/code>/],
  ['md-link', /href="https:\/\/example\.com"/],
  ['bare-link', /<a href="https:\/\/github\.com\/Fei2411\/DS-Bot"/],
  ['ul', /<ul class="md-list">/],
  ['ol', /<ol class="md-list">/],
  ['quote', /<blockquote class="md-quote">/],
  ['code-fence', /<pre><code>const x: number = 1;/],
  ['escape-lt', /x &lt; 2 &amp;&amp; &quot;ok&quot;/],
  ['table', /<table class="md-table">/],
  ['hr', /<hr class="md-hr" \/>/],
];

let bad = 0;
for (const [name, re] of checks) {
  const ok = re.test(out);
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// 结构完整性：标签必须闭合
const opens = (out.match(/<a /g) || []).length;
const closes = (out.match(/<\/a>/g) || []).length;
const anchorsOk = opens === closes;
if (!anchorsOk) bad += 1;
console.log(`${anchorsOk ? 'PASS' : 'FAIL'}  anchors balanced (${opens}/${closes})`);

// 不允许原始 HTML 透出
const rawLeak = /<(script|iframe|img\s+src="javascript:)/i.test(out);
if (rawLeak) bad += 1;
console.log(`${rawLeak ? 'FAIL' : 'PASS'}  no raw html leak`);

// 图片只放行安全协议
const imgSrc = renderMarkdown('![a](javascript:alert(1))');
const imgSafe = !/src="javascript:/.test(imgSrc);
if (!imgSafe) bad += 1;
console.log(`${imgSafe ? 'PASS' : 'FAIL'}  image scheme whitelist`);

/* ---- 回归：两个会直接看到的渲染 bug ---- */

// 1. 段落紧跟表格（模型很常这么写，中间不空行）
const afterPara = renderMarkdown('数据如下：\n| a | b |\n|---|---|\n| 1 | 2 |');
const tableAfterPara = /<table class="md-table">/.test(afterPara) && !afterPara.includes('|---|---|');
if (!tableAfterPara) bad += 1;
console.log(`${tableAfterPara ? 'PASS' : 'FAIL'}  table right after paragraph`);

// 2. 列表项里的围栏代码块不能当正文
const listFence = renderMarkdown('- 说明：\n  ```js\n  const a = 1;\n  ```');
const fenceInList = /<pre><code>const a = 1;/.test(listFence) && !listFence.includes('```');
if (!fenceInList) bad += 1;
console.log(`${fenceInList ? 'PASS' : 'FAIL'}  fence inside list item`);

// 3. 段落里的单个 | 不应误伤（不是表格就不能断段）
const pipe = renderMarkdown('管道符写法 a|b 是常见的\n这里接着写同一段');
const pipeOk = /<p class="md-p">管道符写法 a\|b 是常见的<br \/>这里接着写同一段<\/p>/.test(pipe);
if (!pipeOk) bad += 1;
console.log(`${pipeOk ? 'PASS' : 'FAIL'}  literal pipe stays in paragraph`);

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
