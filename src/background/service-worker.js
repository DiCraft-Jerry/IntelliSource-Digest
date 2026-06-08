/**
 * Service Worker - 右键菜单后台处理
 * 注册右键菜单、提取页面信息、调用 AI 分析、存储结果供 popup 展示
 */
import { summarizePageInfoStream } from '../utils/ai-trans.js';
import { extractPageInfoFunc } from '../utils/page-extractor.js';

const MENU_ID = 'analyze-with-intellisource';
const RESULT_KEY = 'contextMenuResult';

// ========== 注册右键菜单（顶层执行，确保 SW 重启后菜单仍存在） ==========
// 先移除再创建，避免 SW 重启后因 ID 已存在而报错
chrome.contextMenus.remove(MENU_ID, () => {
  chrome.runtime.lastError; // 忽略"菜单不存在"的错误
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '用智源摘读分析此页面',
    contexts: ['page'],
  });
});

// ========== 右键菜单点击处理 ==========
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  if (!tab?.id) return;

  // ★ 在任何 await 之前打开 popup（用户手势在 await 后丢失）
  tryOpenPopup();

  handleContextMenuClick(tab);
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

// ========== 页面信息提取 ==========

async function extractPageInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageInfoFunc,
  });
  if (results?.[0]?.result) return results[0].result;
  throw new Error('无法从当前页面提取信息，请刷新页面后重试');
}

// ========== 存储管理 ==========

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

// ========== 尝试打开 popup ==========

function tryOpenPopup() {
  chrome.action.openPopup().catch(() => {
    // 无法打开时静默失败，用户可手动点击扩展图标
  });
}
