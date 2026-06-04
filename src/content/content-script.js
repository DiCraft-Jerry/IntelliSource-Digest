/**
 * Content Script - 网页关键信息提取
 * 负责从当前页面抓取标题、描述及所有 <a> 标签信息
 * 注意：extractPageInfo 是同步操作，不要 return true
 */

// 监听来自 popup 的提取请求
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'extractPageInfo') {
    try {
      const data = extractPageInfo();
      sendResponse({ success: true, data });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    // 同步响应，不返回 true，避免 Chrome 误等异步回复导致通道关闭
  }
});

/**
 * 提取页面关键信息
 * @returns {{ title: string, description: string, links: Array<{href: string, text: string}> }}
 */
function extractPageInfo() {
  // 网页标题
  const title = document.title?.trim() || '';

  // 网页描述（meta description）
  const metaDesc = document.querySelector('meta[name="description"]');
  const description = metaDesc?.getAttribute('content')?.trim() || '';

  // 收集所有有效 <a> 标签
  const allLinks = Array.from(document.querySelectorAll('a[href]'));

  // 去重并过滤无效链接
  const seen = new Set();
  const links = allLinks
    .map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 150),
    }))
    .filter((link) => {
      // 过滤空链接、javascript 伪协议、已见过的 href
      if (!link.href || link.href.startsWith('javascript:')) return false;
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    })
    .slice(0, 200); // 最多取 200 条，避免数据量过大

  return { title, description, links };
}
