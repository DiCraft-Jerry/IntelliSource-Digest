/**
 * Popup 主逻辑
 * 主视图展示抓取结果，齿轮图标进入二级设置页，同弹窗内切换不消失
 * 优先通过消息通信提取，失败时自动降级为 chrome.scripting.executeScript 注入
 * 使用 chrome.storage.session 缓存结果，同页面重复打开不重抓
 */
import { summarizePageInfoStream, renderMarkdown } from '../utils/ai-trans.js';
import { extractPageInfoFunc } from '../utils/page-extractor.js';

// 当前 AI 总结原始文本（供复制按钮使用）
let currentSummaryText = '';

// 主流 AI 供应商的默认配置
const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
  },
  deepseek: {
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
  },
  qwen: {
    name: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
  },
  moonshot: {
    name: 'Moonshot',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
  },
  zhipu: {
    name: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4',
  },
  custom: {
    name: '自定义',
    url: '',
    model: '',
  },
};

// DOM 元素引用
const els = {
  // 视图
  mainView: document.getElementById('mainView'),
  settingsView: document.getElementById('settingsView'),
  // 头部
  gearBtn: document.getElementById('gearBtn'),
  // 设置页
  backBtn: document.getElementById('backBtn'),
  provider: document.getElementById('provider'),
  apiUrl: document.getElementById('apiUrl'),
  presetUrlGroup: document.getElementById('presetUrlGroup'),
  customUrlGroup: document.getElementById('customUrlGroup'),
  customBaseUrl: document.getElementById('customBaseUrl'),
  customApiPath: document.getElementById('customApiPath'),
  apiPathPreset: document.getElementById('apiPathPreset'),
  urlHint: document.getElementById('urlHint'),
  customUrlHint: document.getElementById('customUrlHint'),
  apiKey: document.getElementById('apiKey'),
  toggleApiKey: document.getElementById('toggleApiKey'),
  model: document.getElementById('model'),
  fetchModelsBtn: document.getElementById('fetchModelsBtn'),
  modelSelect: document.getElementById('modelSelect'),
  modelHint: document.getElementById('modelHint'),
  testConnGroup: document.getElementById('testConnGroup'),
  testConnBtn: document.getElementById('testConnBtn'),
  testResult: document.getElementById('testResult'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  // 主视图
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  errorMsg: document.getElementById('errorMsg'),
  pageInfoCard: document.getElementById('pageInfoCard'),
  pageTitle: document.getElementById('pageTitle'),
  pageDesc: document.getElementById('pageDesc'),
  linkCount: document.getElementById('linkCount'),
  linkDetails: document.getElementById('linkDetails'),
  linkList: document.getElementById('linkList'),
  aiCard: document.getElementById('aiCard'),
  summaryContent: document.getElementById('summaryContent'),
  copyBtn: document.getElementById('copyBtn'),
  reExtractBtn: document.getElementById('reExtractBtn'),
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  const config = await loadConfig();
  applyConfigToForm(config);

  // 优先检查右键菜单预计算结果（来自 Service Worker 后台分析）
  const contextResult = await loadContextMenuResultRaw();
  if (contextResult) {
    if (contextResult.status === 'analyzing') {
      // 后台正在 AI 分析中，展示加载态，等待结果写入后自动更新
      hideAll();
      showLoading('正在 AI 分析中，请稍候...');
      listenForContextMenuResult();
      return;
    }
    if (contextResult.status === 'done') {
      displayContextMenuResult(contextResult);
      await chrome.storage.session.remove(['contextMenuResult']).catch(() => {});
      return;
    }
  }

  if (config.apiUrl && config.apiKey) {
    await runExtraction({ forceRefresh: false });
  } else {
    // 未配置 API → 直接打开设置页
    switchToSettings();
  }
});

// ========== 事件绑定 ==========
function bindEvents() {
  // 齿轮按钮 → 打开设置
  els.gearBtn.addEventListener('click', () => switchToSettings());

  // 返回按钮 → 回到主视图
  els.backBtn.addEventListener('click', () => switchToMain());

  // 供应商切换 → 自动填充 URL 和模型
  els.provider.addEventListener('change', () => {
    const providerKey = els.provider.value;
    const provider = PROVIDERS[providerKey];

    if (providerKey === 'custom') {
      // 切换到自定义：显示基础地址 + 路径字段，隐藏预设只读 URL
      els.presetUrlGroup.style.display = 'none';
      els.customUrlGroup.style.display = '';
      els.customBaseUrl.value = '';
      els.apiPathPreset.value = '/v1/chat/completions';
      els.customApiPath.style.display = 'none';
      els.customApiPath.value = '';
      els.model.value = '';
      els.modelSelect.style.display = 'none';
      els.modelHint.textContent = '';
      els.urlHint.textContent = '';
      els.urlHint.className = 'field-hint';
      els.testConnGroup.style.display = '';
      clearTestResult();
    } else {
      // 预设供应商：显示只读完整 URL，隐藏自定义字段
      els.presetUrlGroup.style.display = '';
      els.customUrlGroup.style.display = 'none';
      els.apiUrl.value = provider.url;
      els.model.value = provider.model;
      els.modelSelect.style.display = 'none';
      els.modelHint.textContent = '';
      els.urlHint.textContent = `✓ 已自动填充 ${provider.name} 的 API 地址`;
      els.urlHint.className = 'field-hint success';
      els.testConnGroup.style.display = 'none';
      clearTestResult();
    }
  });

  // 路径预设切换：选「自定义路径...」时显示手动输入框
  els.apiPathPreset.addEventListener('change', () => {
    if (els.apiPathPreset.value === '__custom__') {
      els.customApiPath.style.display = '';
      els.customApiPath.value = '';
      els.customApiPath.focus();
    } else {
      els.customApiPath.style.display = 'none';
      els.customApiPath.value = '';
    }
  });

  // 测试连接按钮
  els.testConnBtn.addEventListener('click', () => testConnection());

  // 获取模型列表
  els.fetchModelsBtn.addEventListener('click', () => fetchModels());

  // 从下拉列表选模型 → 填入输入框
  els.modelSelect.addEventListener('change', () => {
    if (els.modelSelect.value) {
      els.model.value = els.modelSelect.value;
    }
  });

  // 保存设置 → 回主视图并强制重抓（防抖避免重复点击）
  els.saveSettingsBtn.addEventListener('click', async () => {
    if (els.saveSettingsBtn.disabled) return;
    const config = getConfigFromForm();
    const error = validateConfig(config);
    if (error) {
      showError(error);
      return;
    }
    els.saveSettingsBtn.disabled = true;
    try {
      await saveConfig(config);
      switchToMain();
      await runExtraction({ forceRefresh: true });
    } finally {
      els.saveSettingsBtn.disabled = false;
    }
  });

  // 重新抓取（强制刷新，防抖避免重复触发）
  els.reExtractBtn.addEventListener('click', async () => {
    if (els.reExtractBtn.disabled) return;
    els.reExtractBtn.disabled = true;
    try {
      await runExtraction({ forceRefresh: true });
    } finally {
      els.reExtractBtn.disabled = false;
    }
  });

  // 小眼睛切换 Key 明文/密文
  els.toggleApiKey.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });

  // 复制 AI 总结到剪贴板
  els.copyBtn.addEventListener('click', async () => {
    if (!currentSummaryText) return;
    try {
      await navigator.clipboard.writeText(currentSummaryText);
      els.copyBtn.querySelector('span').textContent = '已复制';
      els.copyBtn.classList.add('copied');
      setTimeout(() => {
        els.copyBtn.querySelector('span').textContent = '复制';
        els.copyBtn.classList.remove('copied');
      }, 1500);
    } catch {
      // 降级：用 textarea fallback
      const ta = document.createElement('textarea');
      ta.value = currentSummaryText;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      els.copyBtn.querySelector('span').textContent = '已复制';
      els.copyBtn.classList.add('copied');
      setTimeout(() => {
        els.copyBtn.querySelector('span').textContent = '复制';
        els.copyBtn.classList.remove('copied');
      }, 1500);
    }
  });
}

// ========== 视图切换 ==========

function switchToSettings() {
  els.mainView.style.display = 'none';
  els.settingsView.style.display = '';
}

function switchToMain() {
  els.settingsView.style.display = 'none';
  els.mainView.style.display = '';
}

// ========== 配置管理 ==========

async function loadConfig() {
  const result = await chrome.storage.local.get(['apiConfig']);
  return result.apiConfig || { provider: 'openai', apiUrl: '', apiKey: '', model: 'gpt-4o' };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ apiConfig: config });
  showError('');
}

function getConfigFromForm() {
  const provider = els.provider.value;

  // 自定义模式：基础地址 + 路径拼接成完整 URL
  let apiUrl;
  if (provider === 'custom') {
    const base = els.customBaseUrl.value.trim().replace(/\/+$/, ''); // 去掉末尾斜杠
    const presetPath = els.apiPathPreset.value;
    const path = presetPath === '__custom__'
      ? els.customApiPath.value.trim()
      : presetPath;
    apiUrl = path ? `${base}${path.startsWith('/') ? '' : '/'}${path}` : base;
  } else {
    apiUrl = els.apiUrl.value.trim();
  }

  return {
    provider,
    apiUrl,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
  };
}

function applyConfigToForm(config) {
  els.provider.value = config.provider || 'openai';
  els.apiKey.value = config.apiKey || '';

  if (config.provider && config.provider !== 'custom') {
    // 预设供应商：显示只读完整 URL
    els.presetUrlGroup.style.display = '';
    els.customUrlGroup.style.display = 'none';
    const provider = PROVIDERS[config.provider];
    if (provider) {
      els.apiUrl.value = provider.url;
      els.model.value = config.model || provider.model;
      els.modelSelect.style.display = 'none';
      els.modelHint.textContent = '';
      els.urlHint.textContent = `✓ 已自动填充 ${provider.name} 的 API 地址`;
      els.urlHint.className = 'field-hint success';
      els.testConnGroup.style.display = 'none';
      clearTestResult();
      return;
    }
  }

  // 自定义模式：从完整 URL 反拆分出基础地址和路径
  els.presetUrlGroup.style.display = 'none';
  els.customUrlGroup.style.display = '';
  const fullUrl = config.apiUrl || '';
  let base = fullUrl;
  let path = '/v1/chat/completions';
  try {
    const url = new URL(fullUrl);
    base = `${url.protocol}//${url.host}`;
    path = url.pathname + url.search + url.hash;
    if (!path || path === '/') path = '/v1/chat/completions';
  } catch {
    // URL 解析失败，把整个字符串当基础地址
  }
  els.customBaseUrl.value = base;
  // 匹配预设路径
  const presetOption = els.apiPathPreset.querySelector(`option[value="${path}"]`);
  if (presetOption) {
    els.apiPathPreset.value = path;
    els.customApiPath.style.display = 'none';
  } else {
    els.apiPathPreset.value = '__custom__';
    els.customApiPath.style.display = '';
    els.customApiPath.value = path;
  }
  els.model.value = config.model || '';
  els.modelSelect.style.display = 'none';
  els.modelHint.textContent = '';
  els.customUrlHint.textContent = '';
  els.customUrlHint.className = 'field-hint';
  els.testConnGroup.style.display = '';
  clearTestResult();
}

function validateConfig(config) {
  if (!config.apiUrl) return '请输入 API 地址';
  if (!config.apiKey) return '请输入 API Key';
  if (!config.model) return '请输入模型名称';
  if (config.provider === 'custom') {
    try {
      const url = new URL(config.apiUrl);
      if (!url.protocol.startsWith('http')) {
        return 'API 地址必须以 http:// 或 https:// 开头';
      }
    } catch {
      return 'API 地址格式不正确，请检查基础地址和路径';
    }
  }
  return null;
}

// ========== 缓存管理 ==========

async function checkCache(tab) {
  try {
    const { cachedResult } = await chrome.storage.session.get(['cachedResult']);
    if (
      cachedResult &&
      cachedResult.tabId === tab.id &&
      cachedResult.url === tab.url
    ) {
      return { pageInfo: cachedResult.pageInfo, summary: cachedResult.summary };
    }
  } catch {
    // storage.session 不可用时静默降级
  }
  return null;
}

async function saveCache(tab, pageInfo, summary) {
  try {
    await chrome.storage.session.set({
      cachedResult: { tabId: tab.id, url: tab.url, pageInfo, summary },
    });
  } catch {
    // 写入失败静默忽略
  }
}

/**
 * 读取右键菜单预计算结果原始数据（不消费，由调用方决定是否清除）
 * @returns {Promise<object | null>}
 */
async function loadContextMenuResultRaw() {
  try {
    const { contextMenuResult } = await chrome.storage.session.get(['contextMenuResult']);
    if (!contextMenuResult) return null;
    return contextMenuResult;
  } catch {
    return null;
  }
}

/**
 * 展示右键菜单预计算结果
 * @param {{ pageInfo: object, summary: string, error: string }} result
 */
function displayContextMenuResult(result) {
  hideAll();
  if (result.pageInfo) {
    renderPageInfo(result.pageInfo);
    els.pageInfoCard.style.display = '';
  }
  if (result.summary) {
    renderSummary(result.summary);
    els.aiCard.style.display = '';
  }
  if (result.error) {
    showError(result.error);
  }
}

/**
 * 监听 storage.session 中 contextMenuResult 的变更
 * Service Worker 写入结果后 popup 自动更新 UI
 */
function listenForContextMenuResult() {
  const handler = async (changes, areaName) => {
    if (areaName !== 'session') return;
    const change = changes.contextMenuResult;
    if (!change?.newValue) return;

    const result = change.newValue;
    chrome.storage.onChanged.removeListener(handler);

    // 校验是否匹配当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url !== result.url) return;

    if (result.status === 'done') {
      displayContextMenuResult(result);
      await chrome.storage.session.remove(['contextMenuResult']).catch(() => {});
    }
  };
  chrome.storage.onChanged.addListener(handler);
}

// ========== 页面信息提取（chrome.scripting.executeScript 直接注入执行） ==========

/**
 * 提取页面信息：统一使用 chrome.scripting.executeScript 直接注入函数执行
 * 不走 chrome.tabs.sendMessage 消息通道，彻底避免旧 content script
 * 孤立后 onMessage 监听器 return true 导致的 channel closed 报错
 * @param {number} tabId
 * @returns {Promise<{ title: string, description: string, links: Array }>}
 */
async function extractPageInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageInfoFunc,
  });
  if (results?.[0]?.result) return results[0].result;
  throw new Error('无法从当前页面提取信息，请刷新页面后重试');
}

// ========== 连通性测试 ==========

function clearTestResult() {
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
}

function setTestResult(status, msg) {
  els.testResult.textContent = msg;
  els.testResult.className = `test-result ${status}`;
}

/**
 * 向自定义 API 发送最小化请求以验证连通性
 */
async function testConnection() {
  // 通过 getConfigFromForm 获取拼接后的完整 URL（自定义模式下自动组装）
  const config = getConfigFromForm();
  const apiUrl = config.apiUrl;
  const apiKey = config.apiKey;
  const model = config.model;

  if (!apiUrl) {
    setTestResult('error', '请先填写 API 地址');
    return;
  }
  if (!apiKey) {
    setTestResult('error', '请先填写 API Key');
    return;
  }
  if (!navigator.onLine) {
    setTestResult('error', '✗ 无网络连接');
    return;
  }

  els.testConnBtn.disabled = true;
  setTestResult('loading', '正在测试...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      // 校验响应体是否兼容 OpenAI Response 格式
      let data;
      try {
        data = await response.json();
      } catch {
        setTestResult('error', '✗ 端点返回的不是合法 JSON');
        return;
      }

      if (data.choices?.[0]?.message?.content !== undefined) {
        setTestResult('success', '✓ 连接成功，端点兼容 OpenAI 格式');
      } else if (data.choices) {
        setTestResult('error', '✗ 端点返回了 choices 但缺少 message.content，格式不兼容');
      } else {
        setTestResult('error', '✗ 端点返回了数据但不符合 OpenAI Response 结构（缺少 choices）');
      }
    } else if (response.status === 401 || response.status === 403) {
      setTestResult('error', '✗ API Key 无效或没有权限');
    } else if (response.status === 404) {
      setTestResult('error', '✗ 接口不存在 (404)，请检查 API 地址路径');
    } else if (response.status === 429) {
      setTestResult('error', '✗ 请求过于频繁，请稍后重试');
    } else {
      const text = await response.text().catch(() => '');
      setTestResult('error', `✗ 服务器返回 ${response.status}: ${text.substring(0, 80)}`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      setTestResult('error', '✗ 连接超时，请检查网络或 API 地址');
    } else {
      setTestResult('error', `✗ 网络错误: ${error.message.substring(0, 60)}`);
    }
  } finally {
    clearTimeout(timeout);
    els.testConnBtn.disabled = false;
  }
}

/** 从 Chat API 地址推导出 /v1/models 端点 */
function getModelsUrl(apiUrl) {
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}/v1/models`;
  } catch {
    return null;
  }
}

/** 获取可用模型列表，填充到 <datalist> 供输入框自动补全 */
async function fetchModels() {
  const config = getConfigFromForm();
  const apiUrl = config.apiUrl;
  const apiKey = config.apiKey;

  if (!apiKey) {
    els.modelHint.textContent = '请先填写 API Key';
    els.modelHint.className = 'field-hint warning';
    return;
  }

  const modelsUrl = getModelsUrl(apiUrl);
  if (!modelsUrl) {
    els.modelHint.textContent = '无法解析 API 地址';
    els.modelHint.className = 'field-hint warning';
    return;
  }
  if (!navigator.onLine) {
    els.modelHint.textContent = '无网络连接，请检查网络';
    els.modelHint.className = 'field-hint warning';
    return;
  }

  els.fetchModelsBtn.disabled = true;
  els.modelHint.textContent = '正在获取模型列表...';
  els.modelHint.className = 'field-hint';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      els.modelHint.textContent = `获取失败 (${response.status})，请手动输入模型名`;
      els.modelHint.className = 'field-hint warning';
      return;
    }

    const data = await response.json();
    if (!data.data?.length) {
      els.modelHint.textContent = '未获取到模型，请手动输入';
      els.modelHint.className = 'field-hint warning';
      return;
    }

    // 按 id 排序后填入 <select>，点击即可选
    const models = data.data.map((m) => m.id).sort();
    els.modelSelect.innerHTML = '';
    models.forEach((id) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      els.modelSelect.appendChild(option);
    });
    els.modelSelect.style.display = '';

    els.modelHint.textContent = `✓ 已获取 ${models.length} 个模型，点击下拉列表选择`;
    els.modelHint.className = 'field-hint success';
  } catch (error) {
    if (error.name === 'AbortError') {
      els.modelHint.textContent = '获取超时，请手动输入模型名';
    } else {
      els.modelHint.textContent = `获取失败，请手动输入模型名`;
    }
    els.modelHint.className = 'field-hint warning';
  } finally {
    clearTimeout(timeout);
    els.fetchModelsBtn.disabled = false;
  }
}

// ========== 核心流程 ==========

async function runExtraction({ forceRefresh }) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('about:')) {
      throw new Error('无法在 Chrome 内部页面使用，请打开普通网页');
    }

    // 非强制刷新时优先读缓存
    if (!forceRefresh) {
      const cached = await checkCache(tab);
      if (cached) {
        hideAll();
        renderPageInfo(cached.pageInfo);
        els.pageInfoCard.style.display = '';
        renderSummary(cached.summary);
        els.aiCard.style.display = '';
        return;
      }
    }

    // 缓存未命中或强制刷新 → 重新抓取
    hideAll();
    showLoading('正在抓取网页信息...');

    const pageInfo = await extractPageInfo(tab.id);
    renderPageInfo(pageInfo);
    els.pageInfoCard.style.display = '';

    // AI 分析（流式输出）
    showLoading('正在 AI 分析中，请稍候...');
    const config = getConfigFromForm();

    // 提前展示 AI 卡片，随流式输出逐步填充内容
    els.aiCard.style.display = '';
    els.summaryContent.innerHTML = '';

    // 流式渲染节流：最多每帧更新一次 DOM，避免高频重绘
    let renderPending = false;
    const summary = await summarizePageInfoStream(pageInfo, config, (_delta, fullContent) => {
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
          currentSummaryText = fullContent;
          els.summaryContent.innerHTML = renderMarkdown(fullContent);
          renderPending = false;
        });
      }
      hideLoading();
    });

    currentSummaryText = summary;
    els.aiCard.style.display = '';

    await saveCache(tab, pageInfo, summary);
    hideLoading();
  } catch (error) {
    hideLoading();
    els.summaryContent.innerHTML = '';
    els.aiCard.style.display = 'none';
    showError(error.message);
  }
}

// ========== 视图渲染 ==========

function renderPageInfo(pageInfo) {
  els.pageTitle.textContent = pageInfo.title || '(无标题)';
  els.pageDesc.textContent = pageInfo.description || '(无描述)';
  els.linkCount.textContent = `${pageInfo.links.length} 个`;

  els.linkList.innerHTML = '';
  const linksToShow = pageInfo.links.slice(0, 100);
  linksToShow.forEach((link) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text || link.href;
    a.title = link.href;
    a.target = '_blank';
    li.appendChild(a);
    els.linkList.appendChild(li);
  });

  if (pageInfo.links.length > 100) {
    const note = document.createElement('li');
    note.textContent = `... 还有 ${pageInfo.links.length - 100} 个链接未展示`;
    note.style.cssText = 'color:#94a3b8;list-style:none;';
    els.linkList.appendChild(note);
  }

  els.linkDetails.open = false;
}

function renderSummary(summaryText) {
  currentSummaryText = summaryText;
  els.summaryContent.innerHTML = renderMarkdown(summaryText);
}

// ========== UI 辅助 ==========

function showLoading(text) {
  els.loading.style.display = '';
  els.loadingText.textContent = text || '加载中...';
}

function hideLoading() {
  els.loading.style.display = 'none';
}

function showError(msg) {
  if (msg) {
    els.errorMsg.textContent = msg;
    els.errorMsg.style.display = '';
  } else {
    els.errorMsg.style.display = 'none';
  }
}

function hideAll() {
  hideLoading();
  showError('');
  els.pageInfoCard.style.display = 'none';
  els.aiCard.style.display = 'none';
}
