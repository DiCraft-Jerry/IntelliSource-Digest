/**
 * 全局常量 & 共享配置
 * 所有模块从这里导入常量，避免魔法数字和重复定义
 */

// ========== 默认配置 ==========
export const DEFAULTS = {
  temperature: 0.7,
  maxTokens: 2000,
  model: 'gpt-4o',
  provider: 'openai',
  systemPrompt: '',
};

// ========== 超时时间（毫秒） ==========
export const TIMEOUTS = {
  extraction: 15000,
  aiStream: 120000,
  connectTest: 10000,
  storageListener: 120000,
};

// ========== 尺寸/截断限制 ==========
export const SIZES = {
  bodyTextMax: 4000,
  selectedTextDisplayMax: 800,
  selectedTextPromptMax: 6000,
  linkDisplayMax: 100,
  linkExtractionMax: 200,
  tableMax: 5,
  tableHeaderCellMax: 80,
  tableBodyRowMax: 20,
  tableCellMax: 120,
  linkTextMax: 150,
  titlePrefixMax: 80,
  summaryPreviewMax: 80,
  domainMax: 60,
  linkFallbackMax: 200,
  historyMax: 10,
  systemPromptMax: 4000,
  promptLinkMax: 60,
  errorPreviewMax: 300,
};

// ========== 存储键 ==========
export const STORAGE_KEYS = {
  apiConfig: 'apiConfig',
  cachedResult: 'cachedResult',
  contextMenuResult: 'contextMenuResult',
  contextMenuSelectionResult: 'contextMenuSelectionResult',
  analysisHistory: 'analysisHistory',
  panelMode: 'panelMode',
};

// ========== 右键菜单 ID ==========
export const MENU_IDS = {
  page: 'analyze-with-intellisource',
  selection: 'analyze-selection-with-intellisource',
};

// ========== UI 常量 ==========
export const UI = {
  badgeColor: '#6366f1',
  buttonFeedbackMs: 1500,
};

// ========== 受限 URL 前缀 ==========
const RESTRICTED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'about:'];

/**
 * 判断 URL 是否为 Chrome 受限页面（不能执行脚本）
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

// ========== AI 供应商预设 ==========
export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    model: 'gpt-4o',
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    modelsUrl: 'https://api.deepseek.com/v1/models',
    model: 'deepseek-chat',
  },
  qwen: {
    name: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    model: 'qwen-plus',
  },
  moonshot: {
    name: 'Moonshot',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    modelsUrl: 'https://api.moonshot.cn/v1/models',
    model: 'moonshot-v1-8k',
  },
  zhipu: {
    name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    model: 'glm-4',
  },
  custom: {
    name: '自定义',
    url: '',
    modelsUrl: '',
    model: '',
  },
};
