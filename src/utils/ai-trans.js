/**
 * AI 接口调用模块
 * 支持 OpenAI 兼容 API 格式，用于分析网页抓取信息并生成总结
 */

// 系统提示词：引导 AI 进行网页内容与数据分析
const SYSTEM_PROMPT = `你是一个专业的网页内容与数据分析助手。请根据用户提供的网页信息，提取其中最有价值的内容。

## 输出要求
1. **一句话总结**：用一句话说清楚这个页面是干什么的
2. **关键信息**：列出 2-4 条最有价值的信息点（如核心数据、价格、结论、趋势等），每条不超过一行。不要复述标题或描述导航结构
3. **数据呈现**：仅当正文或表格中存在值得关注的数字、价格、统计、趋势等数据时，用表格列出。无实质数据则完全跳过此节

## 原则
- 中文回复，数据保留原始数值
- 只输出有价值的信息，不要描述页面布局、导航、链接
- 如果页面确实没有实质内容（如登录页、404页），直接回复「该页面无实质分析内容」，不要强行编造
- 禁止输出"关键要点包括："之类的引导语，直接给内容`;


/**
 * 根据页面信息构建 AI 提示词
 * @param {{ title: string, description: string, links: Array }} pageInfo
 * @returns {string}
 */
function buildPrompt(pageInfo) {
  const { title, description, bodyText, tables, links } = pageInfo;

  // 正文文本（截断以防 token 超限）
  const bodySection = bodyText
    ? `## 网页正文文本\n${bodyText.substring(0, 4000)}`
    : '## 网页正文文本\n(无正文内容)';

  // 表格数据
  let tablesSection = '## 表格数据\n(无表格数据)';
  if (tables && tables.length > 0) {
    const tablesText = tables.map((t, i) => {
      let tStr = `### 表格 ${i + 1}`;
      if (t.headers && t.headers.length > 0) {
        tStr += `\n表头: ${t.headers.join(' | ')}`;
      }
      tStr += '\n' + t.rows.map((row) => row.join(' | ')).join('\n');
      return tStr;
    }).join('\n\n');
    tablesSection = `## 表格数据（共 ${tables.length} 个表格）\n${tablesText}`;
  }

  // 取前 60 个链接以防 token 超限
  const topLinks = links.slice(0, 60);
  const linksText = topLinks
    .map((l, i) => `${i + 1}. [${l.text || '无文字'}](${l.href})`)
    .join('\n');

  return [
    '## 网页标题',
    title || '(无标题)',
    '',
    '## 网页描述',
    description || '(无描述)',
    '',
    bodySection,
    '',
    tablesSection,
    '',
    `## 页面链接列表（总计 ${links.length} 个链接，以下展示前 ${topLinks.length} 个）`,
    linksText,
  ].join('\n');
}

/**
 * 校验 API URL 基本格式（不校验具体路径，第三方 API 路径格式各异）
 * @param {string} apiUrl
 * @throws {Error} URL 不合法时抛出
 */
function validateApiUrl(apiUrl) {
  let url;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error('API 地址格式不正确，请输入完整的 URL（如 https://api.openai.com/v1/chat/completions）');
  }

  if (!url.protocol.startsWith('http')) {
    throw new Error('API 地址必须以 http:// 或 https:// 开头');
  }
}

/**
 * 解析 API 错误响应，提取有用信息
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function parseErrorResponse(response) {
  const status = response.status;
  const statusText = response.statusText;

  const text = await response.text().catch(() => '');

  // 尝试解析 JSON 错误体（OpenAI 格式）
  try {
    const body = JSON.parse(text);
    if (body.error?.message) {
      return `API 返回错误 (${status}): ${body.error.message}`;
    }
  } catch {
    // 非 JSON，直接使用文本内容
  }

  const preview = text.substring(0, 300);

  // 针对常见 HTTP 状态码给出排查建议
  let hint = '';
  switch (status) {
    case 401:
      hint = '\n\n可能原因：API Key 无效或已过期，请检查 Key 是否正确';
      break;
    case 403:
      hint = '\n\n可能原因：API Key 没有访问该模型的权限，或账户余额不足';
      break;
    case 404:
      hint = '\n\n可能原因：API 地址不正确，请检查域名和路径是否完整无误';
      break;
    case 429:
      hint = '\n\n可能原因：请求频率超限，请稍后重试';
      break;
    case 500:
    case 502:
    case 503:
      hint = '\n\n可能原因：AI 服务端暂时故障，请稍后重试';
      break;
  }

  return `API 返回错误 (${status} ${statusText}): ${preview}${hint}`;
}

/**
 * 流式调用 AI 模型分析网页信息（SSE 流式输出，避免长文本超时）
 * @param {{ title: string, description: string, bodyText: string, tables: Array, links: Array }} pageInfo
 * @param {{ apiUrl: string, apiKey: string, model: string }} config
 * @param {(delta: string, fullText: string) => void} onChunk - 每收到一段内容时回调
 * @returns {Promise<string>} 完整的 AI 分析结果文本
 */
export async function summarizePageInfoStream(pageInfo, config, onChunk, signal) {
  return _streamFromApi(SYSTEM_PROMPT, buildPrompt(pageInfo), config, onChunk, signal);
}

// 选中文字分析专用系统提示词
const SELECTION_SYSTEM_PROMPT = `你是一个专业的文字内容分析助手。请根据用户选中的网页文字，进行简明扼要的分析。

## 输出要求
1. **核心内容**：用 1-2 句话概括选中文字的主要内容
2. **关键要点**：提炼 2-4 个关键信息点，每条不超过一行
3. **补充分析**（可选）：如果有值得注意的细节、背景或数据，简要说明

## 原则
- 中文回复
- 不要使用"这段文字""作者认为""该选段"等元描述，直接给分析结果
- 如果选中文字过短或无实质内容，如实说明`;

/**
 * 为选中文字构建 AI 提示词
 * @param {string} selectedText - 用户选中的文字
 * @param {string} pageTitle - 页面标题（提供上下文）
 * @returns {string}
 */
function buildSelectionPrompt(selectedText, pageTitle) {
  const textSection = selectedText.length > 6000
    ? selectedText.substring(0, 6000) + '\n...(文字过长已截断)'
    : selectedText;

  return [
    `## 页面标题（供参考上下文）`,
    pageTitle || '(未知页面)',
    '',
    `## 用户选中的文字`,
    textSection,
  ].join('\n');
}

/**
 * 流式调用 AI 分析用户选中的文字
 * @param {string} selectedText - 用户选中的文字
 * @param {string} pageTitle - 页面标题（提供上下文）
 * @param {{ apiUrl: string, apiKey: string, model: string }} config
 * @param {(delta: string, fullText: string) => void} onChunk
 * @returns {Promise<string>} 完整的 AI 分析结果文本
 */
export async function summarizeSelectionStream(selectedText, pageTitle, config, onChunk, signal) {
  if (!selectedText || !selectedText.trim()) {
    throw new Error('未获取到选中的文字');
  }
  return _streamFromApi(SELECTION_SYSTEM_PROMPT, buildSelectionPrompt(selectedText, pageTitle), config, onChunk, signal);
}

// ========== 内部：通用 SSE 流式调用 ==========

/**
 * 通用 SSE 流式 AI 调用
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userPrompt - 用户提示词
 * @param {{ apiUrl: string, apiKey: string, model: string }} config
 * @param {(delta: string, fullText: string) => void} onChunk
 * @returns {Promise<string>}
 */
async function _streamFromApi(systemPrompt, userPrompt, config, onChunk, externalSignal) {
  const { apiUrl, apiKey, model } = config;

  if (!apiUrl || !apiKey) {
    throw new Error('请先在设置中配置 AI API 地址和密钥');
  }

  validateApiUrl(apiUrl);

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('当前无网络连接，请检查网络后重试');
  }

  // 流式输出总超时 2 分钟，支持外部 AbortSignal
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 2000,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorMsg = await parseErrorResponse(response);
      throw new Error(errorMsg);
    }

    if (!response.body) {
      throw new Error('AI 服务返回了空响应体，请检查 API 地址是否正确');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let streamDone = false;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') { streamDone = true; break; }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta, fullContent);
          }
        } catch {
          // 跳过无法解析的数据行
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:') && trimmed.slice(5).trim() !== '[DONE]') {
        try {
          const parsed = JSON.parse(trimmed.slice(5).trim());
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta, fullContent);
          }
        } catch {
          // 忽略
        }
      }
    }

    if (!fullContent) {
      throw new Error('AI 未返回任何内容，请确认模型名称是否正确');
    }

    return fullContent;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AI 请求超时（2分钟），请检查网络连接或尝试减少分析内容');
    }
    if (error.name === 'TypeError' && error.message === 'Failed to fetch') {
      throw new Error(
        `网络请求失败，无法连接到 API 服务器。\n请检查：\n1. API 地址是否正确\n2. 网络连接是否正常\n3. 是否需要代理/VPN`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

    // 有序列表（以 "数字. " 开头，仅匹配 1-99）
    if (/^(?:[1-9]|[1-9]\d)\. /.test(firstLine)) {
      return lines.map((l) => {
        const m = l.match(/^(?:[1-9]|[1-9]\d)\. (.+)/);
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
      return safe ? '<a href="' + safe + '" target="_blank">' + linkText + '</a>' : linkText;
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
