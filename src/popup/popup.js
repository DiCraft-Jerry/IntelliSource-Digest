/**
 * Popup 主逻辑
 * 主视图展示抓取结果，齿轮图标进入二级设置页，同弹窗内切换不消失
 * 优先通过消息通信提取，失败时自动降级为 chrome.scripting.executeScript 注入
 * 使用 chrome.storage.session 缓存结果，同页面重复打开不重抓
 */
import { summarizePageInfoStream, validateApiUrl } from '../utils/ai-trans.js';
import { renderMarkdown, escapeHtml } from '../utils/markdown.js';
import { extractPageInfo } from '../utils/page-extractor.js';
import { STORAGE_KEYS, TIMEOUTS, SIZES, UI, DEFAULTS, isRestrictedUrl, PROVIDERS } from '../utils/constants.js';

// 当前 AI 总结原始文本（供复制按钮使用）
let currentSummaryText = '';
let abortController = null;

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
  temperatureRange: document.getElementById('temperatureRange'),
  temperature: document.getElementById('temperature'),
  maxTokens: document.getElementById('maxTokens'),
  systemPrompt: document.getElementById('systemPrompt'),
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
  exportBtn: document.getElementById('exportBtn'),
  reExtractBtn: document.getElementById('reExtractBtn'),
  historyDetails: document.getElementById('historyDetails'),
  historyCount: document.getElementById('historyCount'),
  historyList: document.getElementById('historyList'),
  cancelBtn: document.getElementById('cancelBtn'),
  // 欢迎引导
  welcomeCard: document.getElementById('welcomeCard'),
  welcomeStartBtn: document.getElementById('welcomeStartBtn'),
  // 历史记录提示条
  historyBanner: document.getElementById('historyBanner'),
  backToCurrentBtn: document.getElementById('backToCurrentBtn'),
  // Token 计数
  tokenCount: document.getElementById('tokenCount'),
  // Toast
  toast: document.getElementById('toast'),
  // 展示方式切换
  panelModeToggle: document.getElementById('panelModeToggle'),
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  const config = await loadConfig();
  applyConfigToForm(config);
  // 标记当前面板模式（侧边栏模式下隐藏自定义 header，Chrome 自带标题）
  document.body.dataset.panelMode = config.panelMode || 'side_panel';

  // 清除当前标签页 Badge（用户已打开 popup 查看结果）
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.action.setBadgeText({ text: '', tabId: tab.id }).catch(() => {});
  }
  // 清除所有通知
  chrome.notifications.getAll((notifications) => {
    Object.keys(notifications).forEach((id) => chrome.notifications.clear(id));
  });

  // 优先检查右键菜单预计算结果（来自 Service Worker 后台分析）
  const contextResult = await loadContextMenuResultRaw();
  if (contextResult) {
    if (contextResult.status === 'analyzing') {
      hideAll();
      showLoading('正在 AI 分析中，请稍候...');
      listenForStorageResult(STORAGE_KEYS.contextMenuResult, displayContextMenuResult);
      await renderHistoryList();
      return;
    }
    if (contextResult.status === 'done') {
      displayContextMenuResult(contextResult);
      await chrome.storage.session.remove([STORAGE_KEYS.contextMenuResult]).catch(() => {});
      await renderHistoryList();
      return;
    }
  }

  // 检查选中文字右键菜单预计算结果
  const selectionResult = await loadSelectionResultRaw();
  if (selectionResult) {
    if (selectionResult.status === 'analyzing') {
      hideAll();
      showLoading('正在 AI 分析中，请稍候...');
      listenForStorageResult(STORAGE_KEYS.contextMenuSelectionResult, displaySelectionResult);
      await renderHistoryList();
      return;
    }
    if (selectionResult.status === 'done') {
      displaySelectionResult(selectionResult);
      await chrome.storage.session.remove([STORAGE_KEYS.contextMenuSelectionResult]).catch(() => {});
      await renderHistoryList();
      return;
    }
  }

  // 提前渲染历史记录，避免等待 AI 分析期间显示为空
  await renderHistoryList();

  if (config.apiUrl && config.apiKey) {
    await runExtraction({ forceRefresh: false });
  } else {
    // 未配置 API → 显示欢迎引导卡片
    hideAll();
    els.welcomeCard.style.display = '';
  }
});

// ========== 事件绑定 ==========
function bindEvents() {
  // 齿轮按钮 → 打开设置
  els.gearBtn.addEventListener('click', () => switchToSettings());

  // 返回按钮 → 回到主视图
  els.backBtn.addEventListener('click', () => switchToMain());

  // 欢迎引导 → 开始配置
  els.welcomeStartBtn.addEventListener('click', () => {
    els.welcomeCard.style.display = 'none';
    switchToSettings();
  });

  // 历史记录提示条 → 返回当前页面
  els.backToCurrentBtn.addEventListener('click', async () => {
    els.historyBanner.style.display = 'none';
    await runExtraction({ forceRefresh: false });
  });

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
      els.urlHint.textContent = `✓ 已自动填充 ${provider.name} 的 API 地址，可直接修改`;
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

  // 保存设置 → 回主视图，不强制重抓（防抖避免重复点击）
  els.saveSettingsBtn.addEventListener('click', async () => {
    if (els.saveSettingsBtn.disabled) return;
    clearFieldErrors();
    const config = getConfigFromForm();
    const error = validateConfig(config);
    if (error) {
      showFieldError(error.field, error.msg);
      return;
    }
    els.saveSettingsBtn.disabled = true;
    try {
      const oldConfig = await loadConfig();
      const modeChanged = oldConfig.panelMode !== config.panelMode;
      await saveConfig(config);
      switchToMain();
      // 尝试展示缓存；若无缓存则显示空状态
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const cached = await checkCache(tab);
        if (cached) {
          hideAll();
          renderPageInfo(cached.pageInfo);
          els.pageInfoCard.style.display = '';
          renderSummary(cached.summary);
          els.aiCard.style.display = '';
          showToast(modeChanged ? '展示方式已更新，重新打开扩展后生效' : '设置已保存');
        } else {
          hideAll();
          showToast(modeChanged ? '展示方式已更新，重新打开扩展后生效' : '设置已保存，点击"重新抓取"开始分析', modeChanged ? undefined : '重新抓取', modeChanged ? undefined : () => {
            runExtraction({ forceRefresh: true });
          });
        }
      } else {
        showToast(modeChanged ? '展示方式已更新，重新打开扩展后生效' : '设置已保存');
      }
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

  // 取消分析
  els.cancelBtn.addEventListener('click', () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  });

  // 小眼睛切换 Key 明文/密文
  els.toggleApiKey.addEventListener('click', () => {
    const isPassword = els.apiKey.type === 'password';
    els.apiKey.type = isPassword ? 'text' : 'password';
    els.toggleApiKey.querySelector('.eye-on').style.display = isPassword ? 'none' : '';
    els.toggleApiKey.querySelector('.eye-off').style.display = isPassword ? '' : 'none';
  });

  // 复制 AI 总结到剪贴板
  els.copyBtn.addEventListener('click', async () => {
    if (!currentSummaryText) return;
    try {
      await navigator.clipboard.writeText(currentSummaryText);
      showTemporaryButtonFeedback(els.copyBtn, '复制', '已复制', 'copied');
    } catch {
      // 降级：用 textarea fallback
      const ta = document.createElement('textarea');
      ta.value = currentSummaryText;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      const copied = document.execCommand('copy');
      ta.remove();
      if (copied) {
        showTemporaryButtonFeedback(els.copyBtn, '复制', '已复制', 'copied');
      }
    }
  });

  // 导出 AI 总结为 Markdown 文件
  els.exportBtn.addEventListener('click', () => {
    handleExport();
  });

  // temperature 滑块与数字输入双向同步
  els.temperatureRange.addEventListener('input', () => {
    els.temperature.value = els.temperatureRange.value;
  });
  els.temperature.addEventListener('input', () => {
    const val = parseFloat(els.temperature.value);
    if (!isNaN(val) && val >= 0 && val <= 2) {
      els.temperatureRange.value = val;
    }
  });

  // 输入框聚焦时清除该字段的内联错误
  const clearFieldErrorOnInput = (fieldName) => {
    const errorEl = document.querySelector(`.field-error[data-field="${fieldName}"]`);
    if (errorEl) errorEl.classList.remove('visible');
    const inputMap = { apiUrl: '#apiUrl', customUrl: '#customBaseUrl', apiKey: '#apiKey', model: '#model', temperature: '#temperature', maxTokens: '#maxTokens', systemPrompt: '#systemPrompt' };
    const inputSel = inputMap[fieldName];
    if (inputSel) {
      const input = document.querySelector(inputSel);
      if (input) input.classList.remove('has-error');
    }
  };

  els.apiUrl.addEventListener('input', () => clearFieldErrorOnInput('apiUrl'));
  els.customBaseUrl.addEventListener('input', () => clearFieldErrorOnInput('customUrl'));
  els.apiKey.addEventListener('input', () => clearFieldErrorOnInput('apiKey'));
  els.model.addEventListener('input', () => clearFieldErrorOnInput('model'));
  els.temperature.addEventListener('input', () => clearFieldErrorOnInput('temperature'));
  els.maxTokens.addEventListener('input', () => clearFieldErrorOnInput('maxTokens'));
  els.systemPrompt.addEventListener('input', () => clearFieldErrorOnInput('systemPrompt'));
}

// ========== 视图切换（带动画） ==========

/**
 * 带动画切换视图
 * @param {HTMLElement} fromEl - 当前视图
 * @param {HTMLElement} toEl - 目标视图
 */
function switchView(fromEl, toEl) {
  if (!fromEl || !toEl || fromEl === toEl) return;

  // 第一阶段：当前视图淡出
  fromEl.classList.add('leaving');
  const onTransitionEnd = () => {
    fromEl.removeEventListener('transitionend', onTransitionEnd);
    fromEl.style.display = 'none';
    fromEl.classList.remove('leaving');

    // 第二阶段：目标视图淡入
    toEl.style.display = '';
    toEl.classList.add('entering');
    // 强制回流以触发 transition
    toEl.offsetHeight;
    toEl.classList.remove('entering');
  };
  fromEl.addEventListener('transitionend', onTransitionEnd);

  // 安全兜底：250ms 后强制完成（transitionend 可能不触发）
  setTimeout(() => {
    if (fromEl.style.display !== 'none') {
      fromEl.style.display = 'none';
      fromEl.classList.remove('leaving');
      toEl.style.display = '';
      toEl.classList.remove('entering');
    }
  }, 250);
}

function switchToSettings() {
  clearFieldErrors();
  switchView(els.mainView, els.settingsView);
}

function switchToMain() {
  switchView(els.settingsView, els.mainView);
}

// ========== 配置管理 ==========

async function loadConfig() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.apiConfig]);
  const base = result[STORAGE_KEYS.apiConfig] || {
    provider: DEFAULTS.provider, apiUrl: '', apiKey: '', model: DEFAULTS.model,
  };
  if (base.temperature === undefined) base.temperature = DEFAULTS.temperature;
  if (base.maxTokens === undefined) base.maxTokens = DEFAULTS.maxTokens;
  if (base.systemPrompt === undefined) base.systemPrompt = DEFAULTS.systemPrompt;
  if (base.panelMode === undefined) base.panelMode = 'side_panel';
  return base;
}

async function saveConfig(config) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.apiConfig]: config,
    [STORAGE_KEYS.panelMode]: config.panelMode || 'side_panel',
  });
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

  const temperature = parseFloat(els.temperature.value);
  const maxTokens = parseInt(els.maxTokens.value, 10);

  return {
    provider,
    apiUrl,
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    temperature: isNaN(temperature) ? DEFAULTS.temperature : temperature,
    maxTokens: isNaN(maxTokens) ? DEFAULTS.maxTokens : maxTokens,
    systemPrompt: els.systemPrompt.value.trim(),
    panelMode: document.querySelector('input[name="panelMode"]:checked')?.value || 'side_panel',
  };
}

function applyConfigToForm(config) {
  els.provider.value = config.provider || DEFAULTS.provider;
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
      els.urlHint.textContent = `✓ 已自动填充 ${provider.name} 的 API 地址，可直接修改`;
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

  // 高级参数
  const temperature = config.temperature ?? DEFAULTS.temperature;
  els.temperature.value = temperature;
  els.temperatureRange.value = temperature;
  els.maxTokens.value = config.maxTokens ?? DEFAULTS.maxTokens;
  els.systemPrompt.value = config.systemPrompt || '';
  // 展示方式切换
  const modeRadio = document.querySelector(`input[name="panelMode"][value="${config.panelMode || 'side_panel'}"]`);
  if (modeRadio) modeRadio.checked = true;
}

function validateConfig(config) {
  if (!config.apiUrl) return { field: config.provider === 'custom' ? 'customUrl' : 'apiUrl', msg: '请输入 API 地址' };
  if (!config.apiKey) return { field: 'apiKey', msg: '请输入 API Key' };
  if (!config.model) return { field: 'model', msg: '请输入模型名称' };
  if (config.provider === 'custom') {
    try {
      validateApiUrl(config.apiUrl);
    } catch (e) {
      return { field: 'customUrl', msg: e.message };
    }
  }
  if (typeof config.temperature === 'number' && (config.temperature < 0 || config.temperature > 2)) {
    return { field: 'temperature', msg: 'Temperature 必须在 0 到 2 之间' };
  }
  if (config.maxTokens !== undefined && config.maxTokens !== '' && (!Number.isInteger(config.maxTokens) || config.maxTokens < 1)) {
    return { field: 'maxTokens', msg: '最大输出长度必须为正整数' };
  }
  if (config.systemPrompt && config.systemPrompt.length > SIZES.systemPromptMax) {
    return { field: 'systemPrompt', msg: '自定义系统提示词不能超过 4000 字符' };
  }
  return null;
}

/**
 * 在指定字段下方显示内联错误提示
 * @param {string} fieldName - data-field 属性值
 * @param {string} msg - 错误信息
 */
function showFieldError(fieldName, msg) {
  const errorEl = document.querySelector(`.field-error[data-field="${fieldName}"]`);
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.classList.add('visible');
  }
  // 给对应输入框添加红色边框
  const inputMap = {
    apiUrl: '#apiUrl', customUrl: '#customBaseUrl', apiKey: '#apiKey',
    model: '#model', temperature: '#temperature', maxTokens: '#maxTokens',
    systemPrompt: '#systemPrompt',
  };
  const inputSel = inputMap[fieldName];
  if (inputSel) {
    const input = document.querySelector(inputSel);
    if (input) input.classList.add('has-error');
  }
}

/**
 * 清除所有内联错误提示
 */
function clearFieldErrors() {
  document.querySelectorAll('.field-error').forEach((el) => {
    el.textContent = '';
    el.classList.remove('visible');
  });
  document.querySelectorAll('.has-error').forEach((el) => {
    el.classList.remove('has-error');
  });
}

// ========== 缓存管理 ==========

async function checkCache(tab) {
  try {
    const { [STORAGE_KEYS.cachedResult]: cachedResult } = await chrome.storage.session.get([STORAGE_KEYS.cachedResult]);
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
      [STORAGE_KEYS.cachedResult]: { tabId: tab.id, url: tab.url, pageInfo, summary },
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
    const { [STORAGE_KEYS.contextMenuResult]: result } = await chrome.storage.session.get([STORAGE_KEYS.contextMenuResult]);
    return result || null;
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
  // 保存到历史记录（异步，不阻塞 UI）
  if (result.summary) {
    saveToHistory({
      type: 'page', url: result.url, title: result.pageInfo?.title || result.url,
      summary: result.summary, pageInfo: result.pageInfo, timestamp: Date.now()
    }).then(() => renderHistoryList()).catch(() => {});
  }
}

/**
 * 通用：监听 storage.session 中指定键的变更
 * Service Worker 写入结果后 popup 自动更新 UI
 * @param {string} storageKey - storage.session 中的键名
 * @param {(result: object) => void} displayFn - 展示结果的回调
 */
function listenForStorageResult(storageKey, displayFn) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    chrome.storage.onChanged.removeListener(handler);
  };
  const handler = async (changes, areaName) => {
    if (areaName !== 'session') return;
    const change = changes[storageKey];
    if (!change?.newValue) return;

    cleanup();

    const result = change.newValue;
    // 校验是否匹配当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url !== result.url) return;

    if (result.status === 'done') {
      displayFn(result);
      await chrome.storage.session.remove([storageKey]).catch(() => {});
    }
  };
  chrome.storage.onChanged.addListener(handler);
  // 安全超时，防止 SW 崩溃导致监听器永久泄漏
  setTimeout(cleanup, TIMEOUTS.storageListener);
}

// ========== 选中文字右键菜单结果处理 ==========

/**
 * 读取选中文字右键菜单预计算结果原始数据
 * @returns {Promise<object | null>}
 */
async function loadSelectionResultRaw() {
  try {
    const { [STORAGE_KEYS.contextMenuSelectionResult]: result } = await chrome.storage.session.get([STORAGE_KEYS.contextMenuSelectionResult]);
    return result || null;
  } catch {
    return null;
  }
}

/**
 * 展示选中文字右键菜单分析结果
 * @param {{ selectedText: string, summary: string, error: string }} result
 */
function displaySelectionResult(result) {
  hideAll();

  if (result.error) {
    showError(result.error);
    return;
  }

  // 展示选中文字原文（引用样式）+ AI 分析结果
  let contentHtml = '';

  if (result.selectedText) {
    const displayText = result.selectedText.length > SIZES.selectedTextDisplayMax
      ? result.selectedText.substring(0, SIZES.selectedTextDisplayMax) + '...'
      : result.selectedText;
    contentHtml += `<blockquote class="selected-quote">${escapeHtml(displayText)}</blockquote>`;
  }

  if (result.summary) {
    contentHtml += renderMarkdown(result.summary);
  }

  els.pageInfoCard.style.display = '';
  els.pageTitle.textContent = '选中文字分析';
  els.pageDesc.textContent = '';
  els.linkCount.textContent = '';
  els.linkDetails.style.display = 'none';
  els.aiCard.style.display = '';
  els.summaryContent.innerHTML = contentHtml;
  currentSummaryText = result.summary || '';

  // 更新字符计数
  if (result.summary) {
    els.tokenCount.textContent = `${result.summary.length} 字符`;
    els.tokenCount.classList.add('visible');
  }

  // 保存到历史记录（异步，不阻塞 UI）
  saveToHistory({
    type: 'selection', url: result.url, title: '选中文字分析',
    summary: result.summary, selectedText: result.selectedText, timestamp: Date.now()
  }).then(() => renderHistoryList()).catch(() => {});
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
  const timeout = setTimeout(() => controller.abort(), TIMEOUTS.connectTest);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULTS.model,
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
  const timeout = setTimeout(() => controller.abort(), TIMEOUTS.connectTest);

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
  abortController = new AbortController();
  let rafId = null;
  // 清除历史/欢迎状态
  els.historyBanner.style.display = 'none';
  els.welcomeCard.style.display = 'none';
  els.tokenCount.textContent = '';
  els.tokenCount.classList.remove('visible');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');
    if (isRestrictedUrl(tab.url)) {
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
    let loadingHidden = false;
    let renderPending = false;
    const summary = await summarizePageInfoStream(pageInfo, config, (_delta, fullContent) => {
      if (!loadingHidden) {
        hideLoading();
        loadingHidden = true;
      }
      // 更新实时字符计数
      els.tokenCount.textContent = `${fullContent.length} 字符`;
      els.tokenCount.classList.add('visible');
      if (!renderPending) {
        renderPending = true;
        rafId = requestAnimationFrame(() => {
          currentSummaryText = fullContent;
          els.summaryContent.innerHTML = renderMarkdown(fullContent);
          renderPending = false;
        });
      }
    }, abortController.signal);

    // 取消未完成的 rAF 并确保最终内容已渲染
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    els.summaryContent.innerHTML = renderMarkdown(summary);

    currentSummaryText = summary;
    els.aiCard.style.display = '';

    await saveCache(tab, pageInfo, summary);
    await saveToHistory({ type: 'page', url: tab.url, title: pageInfo.title, summary, pageInfo, timestamp: Date.now() });
    await renderHistoryList();
    hideLoading();
  } catch (error) {
    if (rafId) cancelAnimationFrame(rafId);
    hideLoading();
    els.summaryContent.innerHTML = '';
    els.aiCard.style.display = 'none';
    if (error.name !== 'AbortError') {
      showError(error.message);
    }
  } finally {
    abortController = null;
  }
}

// ========== 视图渲染 ==========

function renderPageInfo(pageInfo) {
  els.pageTitle.textContent = pageInfo.title || '(无标题)';
  els.pageDesc.textContent = pageInfo.description || '(无描述)';
  els.linkCount.textContent = `${pageInfo.links.length} 个`;

  els.linkList.innerHTML = '';
  const linksToShow = pageInfo.links.slice(0, SIZES.linkDisplayMax);
  linksToShow.forEach((link) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text || link.href;
    a.title = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.appendChild(a);
    els.linkList.appendChild(li);
  });

  if (pageInfo.links.length > SIZES.linkDisplayMax) {
    const note = document.createElement('li');
    note.textContent = `... 还有 ${pageInfo.links.length - SIZES.linkDisplayMax} 个链接未展示`;
    note.style.cssText = 'color:#94a3b8;list-style:none;';
    els.linkList.appendChild(note);
  }

  els.linkDetails.open = false;
}

function renderSummary(summaryText) {
  currentSummaryText = summaryText;
  els.summaryContent.innerHTML = renderMarkdown(summaryText);
  if (summaryText) {
    els.tokenCount.textContent = `${summaryText.length} 字符`;
    els.tokenCount.classList.add('visible');
  }
}

// ========== UI 辅助 ==========

/**
 * 按钮临时反馈：切换文字和样式，自动恢复
 * @param {HTMLElement} btn - 按钮元素
 * @param {string} originalText - 原始文字
 * @param {string} feedbackText - 反馈文字
 * @param {string} feedbackClass - 反馈时添加的 CSS class
 */
function showTemporaryButtonFeedback(btn, originalText, feedbackText, feedbackClass) {
  btn.querySelector('span').textContent = feedbackText;
  btn.classList.add(feedbackClass);
  setTimeout(() => {
    btn.querySelector('span').textContent = originalText;
    btn.classList.remove(feedbackClass);
  }, UI.buttonFeedbackMs);
}

let toastTimer = null;

/**
 * 显示底部 Toast 提示
 * @param {string} msg - 提示文字
 * @param {string} [actionText] - 操作按钮文字（可选）
 * @param {() => void} [actionCallback] - 操作按钮回调（可选）
 */
function showToast(msg, actionText, actionCallback) {
  if (toastTimer) clearTimeout(toastTimer);

  let html = escapeHtml(msg);
  if (actionText && actionCallback) {
    html += `<span class="toast-action" id="toastAction">${escapeHtml(actionText)}</span>`;
  }

  els.toast.innerHTML = html;
  els.toast.style.display = '';
  // 强制回流后添加 show class 触发动画
  els.toast.offsetHeight;
  els.toast.classList.add('show');

  // 绑定操作按钮事件
  if (actionText && actionCallback) {
    const actionEl = els.toast.querySelector('#toastAction');
    if (actionEl) {
      actionEl.addEventListener('click', () => {
        hideToast();
        actionCallback();
      });
    }
  }

  toastTimer = setTimeout(hideToast, 3000);
}

function hideToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  els.toast.classList.remove('show');
  setTimeout(() => {
    els.toast.style.display = 'none';
  }, 250);
}

// ========== Markdown 导出 ==========

function handleExport() {
  if (!currentSummaryText) return;

  // 构造文件名（去除非法字符）
  const rawTitle = els.pageTitle.textContent || '';
  const filename = (rawTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, SIZES.titlePrefixMax) || 'ai-summary') + '.md';

  try {
    const blob = new Blob([currentSummaryText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // 反馈
    showTemporaryButtonFeedback(els.exportBtn, '导出', '已导出', 'exported');
  } catch {
    // 静默失败
  }
}

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
  els.historyBanner.style.display = 'none';
  els.welcomeCard.style.display = 'none';
  els.tokenCount.textContent = '';
  els.tokenCount.classList.remove('visible');
}

// ========== 历史记录管理 ==========

async function saveToHistory(entry) {
  try {
    const history = await getHistory();
    // 去重：同 URL + 同类型 + 同摘要的视为重复，不重复添加
    const isDuplicate = history.some(
      (h) => h.url === entry.url && h.type === entry.type && h.summary === entry.summary
    );
    if (isDuplicate) return;
    history.unshift(entry);
    if (history.length > SIZES.historyMax) history.length = SIZES.historyMax;
    await chrome.storage.session.set({ [STORAGE_KEYS.analysisHistory]: history });
  } catch {
    // 写入失败静默忽略
  }
}

async function getHistory() {
  try {
    const result = await chrome.storage.session.get([STORAGE_KEYS.analysisHistory]);
    return result[STORAGE_KEYS.analysisHistory] || [];
  } catch {
    return [];
  }
}

async function deleteHistoryEntry(index) {
  try {
    const history = await getHistory();
    if (index >= 0 && index < history.length) {
      history.splice(index, 1);
      await chrome.storage.session.set({ [STORAGE_KEYS.analysisHistory]: history });
    }
  } catch {
    // 删除失败静默忽略
  }
  await renderHistoryList();
}

async function renderHistoryList() {
  const history = await getHistory();
  els.historyCount.textContent = history.length;

  if (history.length === 0) {
    els.historyList.innerHTML = '<div class="history-empty">暂无历史记录</div>';
    return;
  }

  els.historyList.innerHTML = history
    .map((entry, index) => {
      const title = entry.title || entry.url || '未知页面';
      const domain = getDomain(entry.url);
      const time = formatRelativeTime(entry.timestamp);
      const preview = (entry.summary || '').replace(/\n/g, ' ').substring(0, SIZES.summaryPreviewMax);
      return `
        <div class="history-item" data-index="${index}">
          <button class="history-item-delete" data-index="${index}" title="删除此记录">&times;</button>
          <div class="history-item-title">${escapeHtml(title)}</div>
          <div class="history-item-meta">
            <span>${escapeHtml(domain || '')}</span>
            <span>${time}</span>
          </div>
          <div class="history-item-preview">${escapeHtml(preview)}${entry.summary && entry.summary.length > 60 ? '...' : ''}</div>
        </div>
      `;
    })
    .join('');

  // 绑定条目点击事件（加载历史详情）
  els.historyList.querySelectorAll('.history-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const index = parseInt(item.dataset.index, 10);
      const historyArr = await getHistory();
      if (historyArr[index]) {
        loadHistoryEntry(historyArr[index]);
      }
    });
  });

  // 绑定删除按钮事件（阻止冒泡，避免触发条目点击）
  els.historyList.querySelectorAll('.history-item-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index, 10);
      await deleteHistoryEntry(index);
    });
  });
}

function loadHistoryEntry(entry) {
  hideAll();
  els.historyBanner.style.display = '';
  els.welcomeCard.style.display = 'none';
  if (entry.type === 'page' && entry.pageInfo) {
    renderPageInfo(entry.pageInfo);
    els.pageInfoCard.style.display = '';
    renderSummary(entry.summary || '');
    els.aiCard.style.display = '';
  } else if (entry.type === 'selection') {
    let contentHtml = '';
    if (entry.selectedText) {
      const displayText = entry.selectedText.length > SIZES.selectedTextDisplayMax
        ? entry.selectedText.substring(0, SIZES.selectedTextDisplayMax) + '...'
        : entry.selectedText;
      contentHtml += `<blockquote class="selected-quote">${escapeHtml(displayText)}</blockquote>`;
    }
    contentHtml += renderMarkdown(entry.summary || '');
    els.pageInfoCard.style.display = '';
    els.pageTitle.textContent = '选中文字分析';
    els.pageDesc.textContent = '';
    els.linkCount.textContent = '';
    els.linkDetails.style.display = 'none';
    els.aiCard.style.display = '';
    els.summaryContent.innerHTML = contentHtml;
    currentSummaryText = entry.summary || '';
    if (entry.summary) {
      els.tokenCount.textContent = `${entry.summary.length} 字符`;
      els.tokenCount.classList.add('visible');
    }
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}
