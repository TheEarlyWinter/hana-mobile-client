/* tests/md_quote.test.mjs — Markdown 引用（blockquote）专项测试 */

import { renderMarkdown } from '../web/md.js';

let bad = 0;

function assert(name, condition, extra = '') {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    bad += 1;
    console.error(`FAIL  ${name}${extra ? ` -> ${extra}` : ''}`);
  }
}

// 1. 单行引用渲染成 blockquote 且文字完整
{
  const out = renderMarkdown('> 引用的原话');
  const hasBlockquote = /<blockquote[^>]*>引用的原话<\/blockquote>/.test(out);
  assert('单行引用渲染成 blockquote 且文字完整', hasBlockquote, out);
}

// 2. 多行连续引用合并成同一个 blockquote
{
  const src = '> 第一行引用\n> 第二行引用\n> 第三行引用';
  const out = renderMarkdown(src);
  const openCount = (out.match(/<blockquote/g) || []).length;
  const closeCount = (out.match(/<\/blockquote>/g) || []).length;
  const merged = openCount === 1 && closeCount === 1;
  const textRetained = out.includes('第一行引用') && out.includes('第二行引用') && out.includes('第三行引用');
  assert('多行连续引用合并成同一个 blockquote', merged && textRetained, out);
}

// 3. 连续引用中含空引用行（> 独占一行）合并在同一个 blockquote
{
  const src = '> 第一行\n>\n> 第二行';
  const out = renderMarkdown(src);
  const openCount = (out.match(/<blockquote/g) || []).length;
  const closeCount = (out.match(/<\/blockquote>/g) || []).length;
  const merged = openCount === 1 && closeCount === 1;
  const textRetained = out.includes('第一行') && out.includes('第二行');
  assert('连续引用中含空引用行合并在同一个 blockquote', merged && textRetained, out);
}

// 4. 引用里含粗体与链接时，样式标签与文字都对
{
  const src = '> 这里有 **加粗文字** 和 [测试链接](https://example.com/foo)';
  const out = renderMarkdown(src);
  const hasBold = /<strong>加粗文字<\/strong>/.test(out);
  const hasLink = /<a href="https:\/\/example\.com\/foo"[^>]*>测试链接<\/a>/.test(out);
  const inQuote = /<blockquote[^>]*>[\s\S]*<\/blockquote>/.test(out);
  assert('引用里含粗体与链接时，样式标签与文字都对', hasBold && hasLink && inQuote, out);
}

// 5. 引用前后有普通段落，互不干扰
{
  const src = '前置正文段落\n\n> 引用的原话\n\n后置正文段落';
  const out = renderMarkdown(src);
  const hasBefore = /<p class="md-p">前置正文段落<\/p>/.test(out);
  const hasQuote = /<blockquote[^>]*>引用的原话<\/blockquote>/.test(out);
  const hasAfter = /<p class="md-p">后置正文段落<\/p>/.test(out);
  assert('引用前后有普通段落正常分段', hasBefore && hasQuote && hasAfter, out);
}

// 6. 普通 > 出现在行内（比如 a > b）不能被误判成引用
{
  const src = '如果 a > b 且 10 > 5，这是比较操作';
  const out = renderMarkdown(src);
  const noQuote = !out.includes('<blockquote');
  const escaped = out.includes('&gt;');
  assert('普通 > 出现在行内不能被误判成引用', noQuote && escaped, out);
}

// 7. 没有引用时不产生空 blockquote
{
  const cases = [
    ['普通文本', '纯普通文字内容'],
    ['空字符串', ''],
    ['纯空白字符', '   \n  \t  \n   '],
    ['孤立大于号', '>'],
    ['大于号加空格', '>   '],
    ['多行无实质内容的空引用', '>\n>   \n>'],
  ];

  let allClean = true;
  for (const [desc, text] of cases) {
    const out = renderMarkdown(text);
    if (out.includes('<blockquote')) {
      allClean = false;
      console.error(`  空引用泄漏: "${desc}" 渲染出了 blockquote: ${out}`);
    }
  }
  assert('没有引用或纯空引用时不产生空 blockquote', allClean);
}

console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
