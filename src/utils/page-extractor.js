import { TIMEOUTS, SIZES } from './constants.js';

/**
 * 从指定标签页提取页面信息（在 popup 和 SW 中复用）
 * 使用 chrome.scripting.executeScript 注入 extractPageInfoFunc 并设置超时
 * @param {number} tabId
 * @returns {Promise<{ title: string, description: string, bodyText: string, tables: Array, links: Array }>}
 */
export async function extractPageInfo(tabId) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('页面提取超时，请刷新页面后重试')), TIMEOUTS.extraction)
  );
  const injection = chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageInfoFunc,
  });
  const results = await Promise.race([injection, timeout]);
  if (results?.[0]?.result) return results[0].result;
  throw new Error('无法从当前页面提取信息，请刷新页面后重试');
}

/**
 * 页面信息提取函数（被注入到目标页面中执行）
 * 独立声明，确保 Chrome scripting.executeScript 可正确序列化
 *
 * 注意：此函数被序列化注入，无法 import 常量。
 * 以下硬编码数字对应 constants.js 中的 SIZES：
 *   bodyTextMax(4000) tableMax(5) tableHeaderCellMax(80)
 *   tableBodyRowMax(20) tableCellMax(120) linkTextMax(150) linkExtractionMax(200)
 */
export function extractPageInfoFunc() {
  // ---- 标题 ----
  const title = document.title?.trim() || '';

  // ---- 描述 ----
  const metaDesc = document.querySelector('meta[name="description"]');
  const description = metaDesc?.getAttribute('content')?.trim() || '';

  // ---- 正文文本（优先 main/article，清理噪音标签） ----
  const contentEl = document.querySelector('main') || document.querySelector('article') || document.body;
  const clone = contentEl.cloneNode(true);
  // 移除脚本、样式、导航、页脚等噪音
  clone.querySelectorAll('script, style, nav, footer, header, aside, noscript, iframe, form, svg, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]').forEach((el) => el.remove());
  const bodyText = (clone.textContent || '')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 4000);

  // ---- 表格数据 ----
  const tables = [];
  const tableEls = document.querySelectorAll('table');
  for (let i = 0; i < Math.min(tableEls.length, 5); i++) {
    const table = tableEls[i];
    const headers = [];
    // 优先从 thead 提取表头，否则从第一行提取
    const theadHeaders = table.querySelectorAll('thead th, thead td');
    if (theadHeaders.length > 0) {
      theadHeaders.forEach((th) => {
        headers.push((th.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80));
      });
    } else {
      table.querySelectorAll('tr:first-child th, tr:first-child td').forEach((th) => {
        headers.push((th.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80));
      });
    }
    const rows = [];
    const bodyRows = table.querySelectorAll('tbody tr, tr');
    // 如果第一行包含 th，说明是表头行，跳过以避免与 headers 重复
    let startIdx = 0;
    if (bodyRows.length > 0 && bodyRows[0].querySelector('th')) {
      startIdx = 1;
    }
    for (let j = startIdx; j < Math.min(bodyRows.length, 20 + startIdx); j++) {
      const cells = [];
      bodyRows[j].querySelectorAll('td, th').forEach((td) => {
        cells.push((td.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120));
      });
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) {
      tables.push({ headers, rows });
    }
  }

  // ---- 链接 ----
  const allLinks = Array.from(document.querySelectorAll('a[href]'));
  const seen = new Set();
  const links = allLinks
    .map((a) => ({
      href: a.href || '',
      text: (a.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 150),
    }))
    .filter((link) => {
      if (!link.href || link.href.startsWith('javascript:')) return false;
      if (seen.has(link.href)) return false;
      seen.add(link.href);
      return true;
    })
    .slice(0, 200);

  return { title, description, bodyText, tables, links };
}
