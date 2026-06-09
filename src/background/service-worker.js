/**
 * Service Worker - 右键菜单后台处理
 * 注册右键菜单、提取页面信息、调用 AI 分析、存储结果供 popup 展示
 */
import { summarizePageInfoStream, summarizeSelectionStream } from '../utils/ai-trans.js';
import { extractPageInfoFunc } from '../utils/page-extractor.js';

const MENU_ID = 'analyze-with-intellisource';
const RESULT_KEY = 'contextMenuResult';
const SELECTION_MENU_ID = 'analyze-selection-with-intellisource';
const SELECTION_RESULT_KEY = 'contextMenuSelectionResult';

// ========== 注册右键菜单（顶层执行，确保 SW 重启后菜单仍存在） ==========
// 先移除再创建，避免 SW 重启后因 ID 已存在而报错
chrome.contextMenus.remove(MENU_ID, () => {
  if (chrome.runtime.lastError) {
    // 首次安装时菜单不存在，忽略
  }
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '用智源摘读分析此页面',
    contexts: ['page'],
  });
});
chrome.contextMenus.remove(SELECTION_MENU_ID, () => {
  if (chrome.runtime.lastError) {
    // 首次安装时菜单不存在，忽略
  }
  chrome.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: '用智源摘读分析选中内容',
    contexts: ['selection'],
  });
});

// ========== 右键菜单点击处理 ==========
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  // ★ 在任何 await 之前打开 popup（用户手势在 await 后丢失）
  tryOpenPopup();

  if (info.menuItemId === MENU_ID) {
    handleContextMenuClick(tab);
  } else if (info.menuItemId === SELECTION_MENU_ID) {
    handleSelectionMenuClick(tab, info.selectionText);
  }
});

async function handleContextMenuClick(tab) {
  // 过滤受限页面
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('about:')) {
    await storeResult({ error: '无法在 Chrome 内部页面使用，请在普通网页上使用右键菜单', url: tab.url });
    return;
  }

  // 防止重复点击同一页面
  const existing = await getResult();
  if (existing?.status === 'analyzing' && existing.url === tab.url) return;

  // 标记分析中
  await storeResult({ status: 'analyzing', url: tab.url });

  try {
    // 读取 API 配置
    const { apiConfig } = await chrome.storage.local.get(['apiConfig']);
    if (!apiConfig?.apiUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      await storeResult({ error: '请先点击扩展图标配置 AI API 参数', url: tab.url });
      return;
    }

    // 提取页面信息
    const pageInfo = await extractPageInfo(tab.id);

    // AI 流式分析（Service Worker 中收集完整结果）
    const summary = await summarizePageInfoStream(pageInfo, apiConfig, () => {});

    // 存储成功结果
    await storeResult({ status: 'done', url: tab.url, pageInfo, summary });
  } catch (error) {
    await storeResult({ status: 'done', url: tab.url, pageInfo: null, summary: null, error: error.message });
  }
}

// ========== 选中文字分析处理 ==========

async function handleSelectionMenuClick(tab, selectedText) {
  if (!selectedText || !selectedText.trim()) {
    await storeSelectionResult({ error: '未获取到选中的文字', url: tab.url });
    return;
  }

  // 过滤受限页面
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://') || tab.url?.startsWith('about:')) {
    await storeSelectionResult({ error: '无法在 Chrome 内部页面使用，请在普通网页上使用右键菜单', url: tab.url });
    return;
  }

  // 防止重复点击
  const existing = await getSelectionResult();
  if (existing?.status === 'analyzing' && existing.url === tab.url) return;

  // 标记分析中
  await storeSelectionResult({ status: 'analyzing', url: tab.url, selectedText });

  try {
    // 读取 API 配置
    const { apiConfig } = await chrome.storage.local.get(['apiConfig']);
    if (!apiConfig?.apiUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      await storeSelectionResult({ error: '请先点击扩展图标配置 AI API 参数', url: tab.url, selectedText });
      return;
    }

    // 获取页面标题作为上下文
    let pageTitle = tab.title || '';
    if (!pageTitle) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.title || '',
        });
        pageTitle = results?.[0]?.result || '';
      } catch {
        // 获取标题失败，继续执行
      }
    }

    // AI 流式分析选中文字
    const summary = await summarizeSelectionStream(selectedText, pageTitle, apiConfig, () => {});

    // 存储成功结果
    await storeSelectionResult({ status: 'done', url: tab.url, selectedText, summary });
  } catch (error) {
    await storeSelectionResult({ status: 'done', url: tab.url, selectedText, summary: null, error: error.message });
  }
}

// ========== 页面信息提取 ==========

async function extractPageInfo(tabId) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('页面提取超时，请刷新页面后重试')), 15000)
  );
  const injection = chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageInfoFunc,
  });
  const results = await Promise.race([injection, timeout]);
  if (results?.[0]?.result) return results[0].result;
  throw new Error('无法从当前页面提取信息，请刷新页面后重试');
}

// ========== 存储管理（全页分析） ==========

async function storeResult(data) {
  try {
    await chrome.storage.session.set({ [RESULT_KEY]: data });
  } catch {
    // 写入失败静默忽略
  }
}

async function getResult() {
  try {
    const { [RESULT_KEY]: result } = await chrome.storage.session.get([RESULT_KEY]);
    return result || null;
  } catch {
    return null;
  }
}

// ========== 存储管理（选中文字分析） ==========

async function storeSelectionResult(data) {
  try {
    await chrome.storage.session.set({ [SELECTION_RESULT_KEY]: data });
  } catch {
    // 写入失败静默忽略
  }
}

async function getSelectionResult() {
  try {
    const { [SELECTION_RESULT_KEY]: result } = await chrome.storage.session.get([SELECTION_RESULT_KEY]);
    return result || null;
  } catch {
    return null;
  }
}

// ========== 尝试打开 popup ==========

function tryOpenPopup() {
  chrome.action.openPopup().catch(() => {
    // 无法打开时静默失败，用户可手动点击扩展图标
  });
}
