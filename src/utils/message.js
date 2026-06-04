/**
 * 消息通信工具模块
 * 封装 chrome.runtime 消息传递，统一处理 chrome.runtime.lastError
 */

/**
 * 向指定标签页发送消息（Promise 封装）
 * @param {number} tabId - 目标标签页 ID
 * @param {object} message - 消息体，格式 { action: string, payload?: any }
 * @returns {Promise<any>} 对方返回的响应数据
 */
export async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    // Manifest V3 Promise 风格下，发送失败会自动 reject
    // 此处显式检查 lastError 作为双重保障
    if (chrome.runtime.lastError) {
      console.error('消息发送失败:', chrome.runtime.lastError.message);
      throw new Error(chrome.runtime.lastError.message);
    }
    return response;
  } catch (error) {
    // 内容脚本未注入或标签页不可访问时抛出
    if (error.message?.includes('Could not establish connection')) {
      throw new Error('无法连接到当前页面，请刷新页面后重试');
    }
    throw error;
  }
}

/**
 * 向扩展自身发送消息（popup / content script → service worker 等场景）
 * @param {object} message - 消息体
 * @returns {Promise<any>}
 */
export async function sendToExtension(message) {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (chrome.runtime.lastError) {
      console.error('扩展消息发送失败:', chrome.runtime.lastError.message);
      throw new Error(chrome.runtime.lastError.message);
    }
    return response;
  } catch (error) {
    throw error;
  }
}
