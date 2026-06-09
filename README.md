# 智源摘读 · IntelliSource Digest

智能提取网页关键信息，AI 驱动的一键摘要 Chrome 扩展（Manifest V3）。

## 功能

- **一键抓取**：点击扩展图标即可提取当前网页的标题、描述、正文、表格和链接
- **右键菜单**：在任意网页右键选择「用智源摘读分析此页面」，后台自动分析，打开弹窗即看结果
- **选中文字分析**：选中网页文字后右键选择「用智源摘读分析选中内容」，直接对选中文字进行 AI 分析
- **AI 智能分析**：支持 OpenAI 兼容 API，流式输出网页内容摘要与数据分析
- **多供应商支持**：预设 OpenAI、DeepSeek、通义千问、Moonshot、智谱 GLM，支持自定义 API
- **AI 参数可配**：Temperature（随机性）、最大输出 token 数、自定义系统提示词均可调整
- **历史记录**：自动保存最近 10 次分析结果，点击回看，支持单条删除，关闭浏览器后自动清空
- **流式输出**：SSE 实时渲染 AI 生成内容，取消按钮可随时中断
- **桌面通知**：后台分析完成后弹出 Chrome 桌面通知，点击通知打开弹窗
- **Badge 提示**：后台分析期间工具栏图标显示"..."，完成后自动消失
- **导出 Markdown**：一键将 AI 分析结果导出为 `.md` 文件下载
- **本地存储**：API Key 仅保存在浏览器本地，不上传任何第三方

## 安装

1. 克隆本仓库或下载 ZIP 解压
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目根目录
5. 扩展图标出现在工具栏，点击即可使用

## 使用

### 配置 API

首次使用需要配置 AI 接口：

1. 点击扩展图标，自动跳转设置页
2. 选择 AI 供应商（或选「自定义」输入自建 API 地址）
3. 填入 API Key
4. 输入模型名称（可点击「获取模型」自动拉取列表）
5. （可选）调整 Temperature、最大输出长度、自定义系统提示词
6. 点击「保存设置」

### 分析网页

**方式一：工具栏图标**
1. 打开任意网页
2. 点击工具栏中的扩展图标（或按 `Ctrl+Shift+S` / `MacCtrl+Shift+S`）
3. 等待抓取和分析完成，结果实时展示
4. 可点击「重新抓取」强制刷新

**方式二：右键全页分析**
1. 在任意网页空白处点击右键
2. 选择「用智源摘读分析此页面」
3. 后台自动分析，稍后点击扩展图标即可直接查看结果

**方式三：选中文字分析**
1. 在网页中选中需要分析的文字
2. 右键选择「用智源摘读分析选中内容」
3. 后台 AI 分析选中内容，弹窗展示选中原文与 AI 分析结果

## 项目结构

```
search-web-info/
├── manifest.json              # Chrome 扩展清单
├── src/
│   ├── background/
│   │   └── service-worker.js  # Service Worker（右键菜单后台处理）
│   ├── popup/
│   │   ├── popup.html         # 弹窗界面
│   │   ├── popup.js           # 主逻辑（抓取、配置、缓存、右键结果检测、历史记录）
│   │   └── popup.css          # 样式（含暗色模式）
│   ├── utils/
│   │   ├── constants.js       # 全局常量（默认值、超时、存储键、供应商预设等）
│   │   ├── ai-trans.js        # AI API 流式调用（SSE 全页/选中文字分析）
│   │   ├── markdown.js        # Markdown → HTML 安全渲染（XSS 防护）
│   │   └── page-extractor.js  # 页面信息提取函数 + executeScript 注入包装
│   └── assets/
│       └── icons/             # 扩展图标
```

## 技术栈

- Chrome Manifest V3
- Service Worker（ES Module）+ `chrome.contextMenus` 右键菜单
- `chrome.scripting.executeScript` 直接注入提取
- `chrome.storage.session` / `chrome.storage.local` 缓存与持久化
- SSE 流式响应解析
- 原生 JavaScript（无第三方依赖）
- 暗色模式适配（`prefers-color-scheme: dark`）

## 隐私

- API Key 仅存储在 `chrome.storage.local`，完全在浏览器本地
- 网页数据仅发送给你配置的 AI API 端点
- 不收集任何使用数据或遥测信息

## 更新日志

### 2026-06-09

- **功能**：AI 参数可配置（Temperature / maxTokens / 自定义系统提示词）、扩展图标 Badge 状态提示、AI 分析完成 Chrome 桌面通知（点击打开弹窗）、Markdown 导出下载、历史记录单条删除、右键选中文字 AI 分析
- **架构重构**：新增 constants.js 集中管理全局常量、新增 markdown.js 解耦 Markdown 渲染、消除 popup 与 SW 间重复代码（通用监听器/处理器/存储函数）、提取共享 extractPageInfo
- **UX 优化**：取消按钮可中断分析、密码小眼睛切换明文/密文、暗色模式适配、复制降级、预设供应商 URL 可编辑
- **Bug 修复**：Markdown 渲染器重构为分块处理、表格表头数据重复、rAF 流式竞态、storage 监听器泄漏、SW 页面提取缺超时、HTML 转义未处理双引号、未捕获 Promise rejection、链接缺少 noopener、AbortSignal 监听器泄漏、历史记录加载时序
