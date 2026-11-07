/* md.js — 够用的 Markdown 子集渲染器
 *
 * 目标：把 Hana 回复里 95% 的场景渲染对，不引任何依赖。
 * 支持：围栏代码块、标题、粗体/斜体/删除线、行内代码、链接、裸链接、
 *       有序/无序列表（含嵌套一层）、引用、分隔线、表格、换行。
 *
 * 安全：先整体 HTML 转义，再按规则插回标签，绝不让原始 HTML 透出。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

function escapeAttr(s) {
  return escapeHtml(s);
}

/* ------------------------------ 行内 ------------------------------ */

function inline(src) {
  let out = escapeHtml(src);

  // 行内代码优先占位，避免里面的符号被后续规则吃掉
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // 图片 ![alt](src)
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const safe = /^(https?:|\/|data:image\/)/i.test(src) ? src : '';
    if (!safe) return escapeHtml(alt || '');
    return `<img class="md-img" src="${escapeAttr(safe)}" alt="${escapeAttr(alt)}" loading="lazy" />`;
  });

  // 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const ok = /^(https?:|mailto:|\/)/i.test(href);
    const url = ok ? href : '#';
    const ext = /^https?:/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeAttr(url)}"${ext}>${text}</a>`;
  });

  // 裸链接（前面可能是空格、左括号，也可能是中文标点）
  out = out.replace(/(^|[\s(\uFF08\u3010\uFF1A\uFF0C\u3002\uFF1B\u3001])(https?:\/\/[^\s<>")\]]+)/g, (_, pre, url) => {
    return `${pre}<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // 粗体 / 斜体 / 删除线
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 还原行内代码
  out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);

  return out;
}

/* ------------------------------ 表格 ------------------------------ */

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function renderTable(rows) {
  if (rows.length < 2) return '';
  const head = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const tb = body
    .map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

/* ------------------------------ 主函数 ------------------------------ */

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^(\s*)```([\w+-]*)\s*$/);
    if (fence) {
      const indent = fence[1].length;
      const lang = fence[2] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        // 去掉围栅自身的缩进：列表里缩进两格写的代码块，不该带着两格空白进 <pre>
        buf.push(indent ? lines[i].replace(new RegExp(`^\\s{0,${indent}}`), '') : lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      const code = escapeHtml(buf.join('\n'));
      const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      out.push(`<div class="md-code">${label}<pre><code>${code}</code></pre></div>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }

    // 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} class="md-h">${inline(h[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        rows.push(lines[j]);
        j += 1;
      }
      out.push(renderTable(rows));
      i = j;
      continue;
    }

    // 引用
    if (/^\s{0,3}>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      const raw = buf.join('\n');
      if (raw.trim()) {
        out.push(`<blockquote class="md-quote">${inline(raw).replace(/\n/g, '<br />')}</blockquote>`);
      }
      continue;
    }

    // 列表
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const indent = m[1].length;
        items.push({ indent, text: m[3], ordered });
        i += 1;
        // 续行
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
          // 遇围栅就停：列表里嵌代码块没法用一个 li 表达，
          // 让列表到此结束、围栅交给外层按正常代码块渲染，
          // 总比把反引号当正文吐出来强。
          !/^\s*```/.test(lines[i])
        ) {
          items[items.length - 1].text += '\n' + lines[i].trim();
          i += 1;
        }
      }
      const base = Math.min(...items.map((x) => x.indent));
      const html = items
        .map((it) => {
          const nested = it.indent > base ? ' md-li-nested' : '';
          const text = inline(it.text).replace(/\n/g, '<br />');
          return `<li class="md-li${nested}">${text}</li>`;
        })
        .join('');
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="md-list">${html}</${tag}>`);
      continue;
    }

    // 普通段落（吃到空行为止）
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]) &&
      !/^\s{0,3}>\s?/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      // 表头：这一行带 |、下一行是分隔行 → 交给表格分支，别吞进段落。
      // 模型经常不空行就给出表格（“数据如下：”下一行就是表头）。
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) {
      out.push(`<p class="md-p">${inline(para.join('\n')).replace(/\n/g, '<br />')}</p>`);
    } else {
      i += 1;
    }
  }

  return out.join('');
}
