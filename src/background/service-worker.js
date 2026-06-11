/**
 * Service Worker - 右键菜单后台处理
 * 注册右键菜单、提取页面信息、调用 AI 分析、存储结果供 popup 展示
 */
import { summarizePageInfoStream, summarizeSelectionStream } from '../utils/ai-trans.js';
import { extractPageInfo } from '../utils/page-extractor.js';
import { STORAGE_KEYS, MENU_IDS, TIMEOUTS, SIZES, UI, isRestrictedUrl } from '../utils/constants.js';

// ========== 面板模式管理 ==========
let currentPanelMode = 'side_panel';

function configurePanelBehavior(mode) {
  if (mode === 'popup') {
    chrome.action.setPopup({ popup: 'src/popup/popup.html' }).catch(() => {});
  } else {
    // 侧边栏模式：清除 popup，显式关闭 openPanelOnActionClick
    // 这样图标点击会触发 onClicked，由 SW 调用 sidePanel.open()
    // 走 onClicked 路径才能正确传播用户手势，确保 tab.url 可解析
    chrome.action.setPopup({ popup: '' }).catch(() => {});
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  currentPanelMode = mode;
}

function openPanel(tab) {
  if (!tab?.windowId) return;
  if (currentPanelMode === 'popup') {
    chrome.action.openPopup({ windowId: tab.windowId }).catch(() => {});
  } else {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
}

// 启动时读取偏好并配置
(async () => {
  try {
    const { [STORAGE_KEYS.panelMode]: mode } = await chrome.storage.local.get([STORAGE_KEYS.panelMode]);
    configurePanelBehavior(mode === 'popup' ? 'popup' : 'side_panel');
  } catch {
    configurePanelBehavior('side_panel');
  }
})();

// 监听面板模式变更（用户在设置页切换后立即生效）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[STORAGE_KEYS.panelMode];
  if (change?.newValue) {
    configurePanelBehavior(change.newValue === 'popup' ? 'popup' : 'side_panel');
  }
});

// ========== 点击工具栏图标 → 打开 Side Panel（安全回退） ==========
chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

// ========== 注册右键菜单（顶层执行，确保 SW 重启后菜单仍存在） ==========
// 先移除再创建，避免 SW 重启后因 ID 已存在而报错
chrome.contextMenus.remove(MENU_IDS.page, () => {
  if (chrome.runtime.lastError) {
    // 首次安装时菜单不存在，忽略
  }
  chrome.contextMenus.create({
    id: MENU_IDS.page,
    title: '用智源摘读分析此页面',
    contexts: ['page'],
  });
});
chrome.contextMenus.remove(MENU_IDS.selection, () => {
  if (chrome.runtime.lastError) {
    // 首次安装时菜单不存在，忽略
  }
  chrome.contextMenus.create({
    id: MENU_IDS.selection,
    title: '用智源摘读分析选中内容',
    contexts: ['selection'],
  });
});

// ========== 右键菜单点击处理 ==========
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  // 在任何 await 之前打开 panel（用户手势在 await 后丢失）
  openPanel(tab);

  if (info.menuItemId === MENU_IDS.page) {
    handleMenuClick(tab, {
      storageKey: STORAGE_KEYS.contextMenuResult,
      extractAndSummarize: async (tab) => {
        const { apiConfig } = await chrome.storage.local.get([STORAGE_KEYS.apiConfig]);
        if (!apiConfig?.apiUrl || !apiConfig?.apiKey || !apiConfig?.model) {
          throw new Error('请先点击扩展图标配置 AI API 参数');
        }
        const pageInfo = await extractPageInfo(tab.id);
        const summary = await summarizePageInfoStream(pageInfo, apiConfig, () => {});
        return { pageInfo, summary };
      },
      buildResult: (tab, data) => data,
      getExisting: () => getStorageResult(STORAGE_KEYS.contextMenuResult),
      storeAnalyzing: (tab) => storeStorageResult(STORAGE_KEYS.contextMenuResult, { status: 'analyzing', url: tab.url }),
      storeSuccess: (tab, data) => storeStorageResult(STORAGE_KEYS.contextMenuResult, { status: 'done', url: tab.url, ...data }),
      storeError: (tab, error) => storeStorageResult(STORAGE_KEYS.contextMenuResult, { status: 'done', url: tab.url, pageInfo: null, summary: null, error: error.message }),
      getNotificationTitle: (data) => data.pageInfo?.title || tab.title,
    });
  } else if (info.menuItemId === MENU_IDS.selection) {
    handleMenuClick(tab, {
      storageKey: STORAGE_KEYS.contextMenuSelectionResult,
      extractAndSummarize: async (tab, selectedText) => {
        const { apiConfig } = await chrome.storage.local.get([STORAGE_KEYS.apiConfig]);
        if (!apiConfig?.apiUrl || !apiConfig?.apiKey || !apiConfig?.model) {
          throw new Error('请先点击扩展图标配置 AI API 参数');
        }
        if (!selectedText || !selectedText.trim()) {
          throw new Error('未获取到选中的文字');
        }
        let pageTitle = tab.title || '';
        if (!pageTitle) {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => document.title || '',
            });
            pageTitle = results?.[0]?.result || '';
          } catch { /* 获取标题失败，继续执行 */ }
        }
        const summary = await summarizeSelectionStream(selectedText, pageTitle, apiConfig, () => {});
        return { selectedText, summary };
      },
      buildResult: (tab, data) => ({ selectedText: data.selectedText, summary: data.summary }),
      getExisting: () => getStorageResult(STORAGE_KEYS.contextMenuSelectionResult),
      storeAnalyzing: (tab, selectedText) => storeStorageResult(STORAGE_KEYS.contextMenuSelectionResult, { status: 'analyzing', url: tab.url, selectedText }),
      storeSuccess: (tab, data) => storeStorageResult(STORAGE_KEYS.contextMenuSelectionResult, { status: 'done', url: tab.url, ...data }),
      storeError: (tab, error) => storeStorageResult(STORAGE_KEYS.contextMenuSelectionResult, { status: 'done', url: tab.url, selectedText: null, summary: null, error: error.message }),
      getNotificationTitle: () => '选中文字分析',
      selectedText: info.selectionText,
    });
  }
});

// ========== 通用右键菜单处理 ==========

async function handleMenuClick(tab, opts) {
  const { storageKey, extractAndSummarize, buildResult, getExisting, storeAnalyzing, storeSuccess, storeError, getNotificationTitle, selectedText } = opts;

  // 过滤受限页面
  if (isRestrictedUrl(tab.url)) {
    await storeStorageResult(storageKey, { error: '无法在 Chrome 内部页面使用，请在普通网页上使用右键菜单', url: tab.url });
    return;
  }

  // 防止重复点击
  const existing = await getExisting();
  if (existing?.status === 'analyzing' && existing.url === tab.url) return;

  // 标记分析中
  await storeAnalyzing(tab, selectedText);
  setBadge(tab.id, '...', UI.badgeColor);

  try {
    const data = await extractAndSummarize(tab, selectedText);
    await storeSuccess(tab, data);
    clearBadge(tab.id);
    notifyComplete(tab, getNotificationTitle(data), data.summary || '');
  } catch (error) {
    await storeError(tab, error);
    clearBadge(tab.id);
    notifyError(tab, error.message);
  }
}

// ========== 通用存储辅助 ==========

async function storeStorageResult(key, data) {
  try {
    await chrome.storage.session.set({ [key]: data });
  } catch { /* 写入失败静默忽略 */ }
}

async function getStorageResult(key) {
  try {
    const result = await chrome.storage.session.get([key]);
    return result[key] || null;
  } catch {
    return null;
  }
}

// ========== Badge 辅助函数 ==========

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
}

function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
}

// ========== 通知辅助函数 ==========

function notifyComplete(tab, title, summary) {
  const preview = (summary || '').replace(/\n/g, ' ').substring(0, SIZES.summaryPreviewMax);
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'assets/icons/icon128.png',
    title: '智源摘读 · 分析完成',
    message: `${title ? title.substring(0, SIZES.domainMax) : '页面'}${preview ? '\n' + preview : ''}`,
  }).catch(() => {});
}

function notifyError(tab, errorMsg) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'assets/icons/icon128.png',
    title: '智源摘读 · 分析失败',
    message: errorMsg ? errorMsg.substring(0, 100) : '未知错误',
  }).catch(() => {});
}

// 点击通知 → 打开 Panel
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
  if (notificationId) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.windowId) {
        openPanel(tab);
      }
    }).catch(() => {});
  }
});
