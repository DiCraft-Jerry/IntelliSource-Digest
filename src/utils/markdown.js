/**
 * Markdown → HTML 渲染模块
 * 将 AI 返回的 Markdown 文本转换为安全的 HTML
 */

/**
 * HTML 转义（防 XSS）
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 过滤危险 URL 协议，防止 XSS
 * @param {string} url
 * @returns {string} 安全 URL 或空字符串
 */
function sanitizeUrl(url) {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return '';
  }
  return trimmed;
}

/** 处理行内 Markdown（粗斜体、链接、图片、代码、删除线） */
function processInline(text) {
  return text
    // 行内代码
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // 图片（在链接之前）
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      const safe = sanitizeUrl(url);
      return safe ? '<img src="' + safe + '" alt="' + alt + '" style="max-width:100%">' : '[图片: ' + alt + ']';
    })
    // 链接 [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
      const safe = sanitizeUrl(url);
      return safe ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + linkText + '</a>' : linkText;
    })
    // 粗斜体（必须在粗体/斜体之前）
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // 粗体
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // 斜体
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // 删除线
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}

/**
 * 将 AI 返回的 Markdown 文本转换为 HTML（分块处理，避免块级元素嵌套在 <p> 内）
 * @param {string} text - Markdown 格式文本
 * @returns {string} HTML 字符串
 */
export function renderMarkdown(text) {
  // 1. 转义 HTML 特殊字符
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 2. 提取并保护围栏代码块，避免内部内容被后续处理干扰
  const codeBlocks = [];
  escaped = escaped.replace(/```\w*\n([\s\S]*?)```/g, (_match, code) => {
    codeBlocks.push(code);
    return `\n\n<!--CODEBLOCK_${codeBlocks.length - 1}-->\n\n`;
  });

  // 3. 按空行分割为段落块
  const rawBlocks = escaped.split(/\n\n+/);
  const blocks = rawBlocks.filter((b) => b.trim() !== '');

  // 4. 逐块判断类型并处理
  const processed = blocks.map((block) => {
    const trimmed = block.trim();

    // 代码块占位符 → 还原
    const codeMatch = trimmed.match(/^<!--CODEBLOCK_(\d+)-->$/);
    if (codeMatch) {
      return '<pre><code>' + codeBlocks[parseInt(codeMatch[1])] + '</code></pre>';
    }

    const lines = trimmed.split('\n');
    const firstLine = lines[0];

    // 表格（以 | 开头且第二行为分隔线）
    if (firstLine.startsWith('|') && lines.length >= 2 && /^\|[-:\s|]+\|\s*$/.test(lines[1].trim())) {
      const headers = firstLine.split('|').map((h) => h.trim()).filter(Boolean);
      const dataLines = lines.slice(2);
      const rows = dataLines.map((row) => {
        const cells = row.split('|').map((c) => c.trim());
        if (cells[0] === '') cells.shift();
        if (cells[cells.length - 1] === '') cells.pop();
        return cells;
      });
      const thead = '<thead><tr>' + headers.map((h) => '<th>' + processInline(h) + '</th>').join('') + '</tr></thead>';
      const tbody = '<tbody>' + rows.map((row) => {
        while (row.length < headers.length) row.push('');
        return '<tr>' + row.slice(0, headers.length).map((c) => '<td>' + processInline(c) + '</td>').join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<div class="table-wrap"><table>' + thead + tbody + '</table></div>';
    }

    // 标题（# → h2, ## → h3, ### → h4, #### → h5）
    const headingMatch = firstLine.match(/^(#{1,5}) (.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag = 'h' + (level + 1);
      return '<' + tag + '>' + processInline(headingMatch[2]) + '</' + tag + '>';
    }

    // 水平分割线
    if (/^(---|\*\*\*|___)\s*$/.test(firstLine)) {
      return '<hr>';
    }

    // 引用块（> 已被转义为 &gt;）
    if (firstLine.startsWith('&gt; ')) {
      const content = lines.map((l) => l.replace(/^&gt; /, '')).join('<br>');
      return '<blockquote>' + processInline(content) + '</blockquote>';
    }

    // 有序列表（以 "数字. " 开头）
    if (/^\d+\. /.test(firstLine)) {
      return lines.map((l) => {
        const m = l.match(/^\d+\. (.+)/);
        return m ? '<!--OL--><li>' + processInline(m[1]) + '</li>' : '<p>' + processInline(l) + '</p>';
      }).join('');
    }

    // 无序列表（以 "- " 或 "* " 开头）
    if (/^[*-] /.test(firstLine)) {
      return lines.map((l) => {
        const m = l.match(/^[*-] (.+)/);
        return m ? '<li>' + processInline(m[1]) + '</li>' : '<p>' + processInline(l) + '</p>';
      }).join('');
    }

    // 普通段落：行内换行用 <br>，包裹 <p>
    const content = lines.join('<br>');
    return '<p>' + processInline(content) + '</p>';
  });

  // 5. 合并所有块
  let result = processed.join('');

  // 6. 将连续有序列表项包入 <ol>
  result = result.replace(/((?:<!--OL--><li>.*?<\/li>)+)/g, (match) => {
    return '<ol>' + match.replace(/<!--OL-->/g, '') + '</ol>';
  });
  // 将连续无序列表项包入 <ul>
  result = result.replace(/((?:<li>.*?<\/li>)+)/g, (match) => {
    return '<ul>' + match + '</ul>';
  });

  return result;
}
