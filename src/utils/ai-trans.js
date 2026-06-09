/**
 * AI 接口调用模块
 * 支持 OpenAI 兼容 API 格式，用于分析网页抓取信息并生成总结
 */
import { TIMEOUTS, DEFAULTS, SIZES } from './constants.js';

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
    ? `## 网页正文文本\n${bodyText.substring(0, SIZES.bodyTextMax)}`
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
export function validateApiUrl(apiUrl) {
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

  // 检测是否为 HTML 响应（API 地址可能指向了网页而非 API 端点）
  const isHtml = text.trim().startsWith('<!') || text.trim().startsWith('<html');
  const preview = isHtml
    ? '服务器返回了网页而非 API 响应，请检查 API 地址是否正确'
    : text.substring(0, SIZES.errorPreviewMax || 300);

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
  const systemPrompt = config.systemPrompt || SYSTEM_PROMPT;
  return _streamFromApi(systemPrompt, buildPrompt(pageInfo), config, onChunk, signal);
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
  const textSection = selectedText.length > SIZES.selectedTextPromptMax
    ? selectedText.substring(0, SIZES.selectedTextPromptMax) + '\n...(文字过长已截断)'
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
  const systemPrompt = config.systemPrompt || SELECTION_SYSTEM_PROMPT;
  return _streamFromApi(systemPrompt, buildSelectionPrompt(selectedText, pageTitle), config, onChunk, signal);
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
  const { apiUrl, apiKey, model, temperature, maxTokens } = config;

  if (!apiUrl || !apiKey) {
    throw new Error('请先在设置中配置 AI API 地址和密钥');
  }

  validateApiUrl(apiUrl);

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('当前无网络连接，请检查网络后重试');
  }

  // 流式输出总超时 2 分钟，支持外部 AbortSignal
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUTS.aiStream);
  let onExternalAbort = null;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener('abort', onExternalAbort);
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULTS.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: temperature ?? DEFAULTS.temperature,
        max_tokens: maxTokens ?? DEFAULTS.maxTokens,
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
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

