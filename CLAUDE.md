# 网页关键信息抓取AI总结器

基于 Manifest V3 标准的 Chrome 浏览器扩展，用于抓取网页关键信息并通过 AI 进行智能总结。

## 技术规范

### Manifest V3 标准
- 所有代码必须严格遵守 Manifest V3 规范，不得使用任何已在 V3 中废弃或移除的 API
- `manifest.json` 中 `manifest_version` 必须为 `3`
- 禁止使用 `eval()`、`new Function()` 等违反 CSP 的写法
- 所有资源引用使用相对路径，外部资源需在 `content_security_policy` 中声明

### Background 规范
- **必须使用 Service Worker**，禁止使用 `background.page` 或 `background.scripts`（V2 遗留写法）
- Service Worker 中不能使用 DOM API、`window`、`localStorage` 等浏览器全局对象
- 持久化数据使用 `chrome.storage.session`（会话级）或 `chrome.storage.local`（持久级）
- Service Worker 会在空闲时自动休眠，不要在内存中保存需要持久化的状态；所有状态变更必须立即写入 storage
- 定时任务使用 `chrome.alarms` API，禁止在 Service Worker 中使用 `setInterval`/`setTimeout` 做长周期轮询

### 通信规范
- 页面信息提取统一使用 `chrome.scripting.executeScript` 直接注入函数执行，不使用 content script 的消息通道
- Popup 与 Service Worker 之间通过 `chrome.storage.session` 传递预计算结果（如右键菜单分析结果），通过 `chrome.storage.onChanged` 监听变更
- 所有异步调用必须检查 `chrome.runtime.lastError`，不允许静默忽略错误

### 右键菜单规范
- 两个菜单项：全页分析（`contexts: ['page']`）和选中文字分析（`contexts: ['selection']`），通过不同菜单 ID 和存储键隔离
- Service Worker 中 `chrome.action.openPopup()` 必须在任何 `await` 之前调用（用户手势在 await 后丢失）
- 全页分析结果通过 `contextMenuResult` 键传递：`{ status, url, pageInfo, summary, error }`
- 选中文字分析结果通过 `contextMenuSelectionResult` 键传递：`{ status, url, selectedText, summary, error }`
- 菜单注册使用先 `remove` 再 `create` 的模式，防止 SW 重启后 ID 冲突

### 历史记录规范
- 历史记录存储在 `chrome.storage.session` 的 `analysisHistory` 键，数组最多 10 条
- 每次分析成功后（全页/选中文字）自动写入，同内容去重
- 关闭浏览器后自动清空（session 级别存储）
- 条目格式：`{ type, url, title, summary, pageInfo?, selectedText?, timestamp }`

### 常量管理规范
- 所有跨模块共享的默认值、超时时间、尺寸限制、存储键、菜单 ID 必须定义在 `src/utils/constants.js`
- 禁止在业务代码中硬编码魔法数字或裸字符串（如 storage key、超时毫秒数、截断长度）
- 新增常量时先检查 constants.js 中是否有语义相近的可复用
- 唯一例外：`extractPageInfoFunc` 中的硬编码限制（该函数被序列化注入目标页面，无法 import）

### AI 参数规范
- `apiConfig` 对象包含：`provider`、`apiUrl`、`apiKey`、`model`、`temperature`、`maxTokens`、`systemPrompt`
- `temperature` 默认 0.7（0-2），`maxTokens` 默认 2000（正整数），`systemPrompt` 默认空（空 = 使用内置提示词）
- Service Worker 中 `chrome.storage.local.get(['apiConfig'])` 透传整个 config 给 summarize 函数，无需单独处理新字段
- 自定义 systemPrompt 优先于内置 SYSTEM_PROMPT / SELECTION_SYSTEM_PROMPT

### Badge 与通知规范
- 后台分析期间使用 `chrome.action.setBadgeText` 在图标上显示 `...`，颜色 `#6366f1`（常量 `UI.badgeColor`）
- 分析完成后调用 `chrome.notifications.create` 弹出桌面通知，内容截断使用 `SIZES` 常量
- `chrome.action.openPopup()` 必须在任何 `await` 之前调用（用户手势在 await 后丢失）
- Popup 打开后立即清除当前标签页 Badge 和所有通知

### API 使用规范
- 所有 Chrome API 调用推荐使用 Promise 封装或直接使用 `async/await`（Manifest V3 原生支持 Promise 风格调用）
- 敏感权限（如 `tabs`、`storage`、`activeTab` 等）遵循最小权限原则，仅声明实际使用的权限
- 禁止在 `permissions` 中申请不必要的 `host_permissions`，优先使用 `activeTab` + 用户手势触发

## 代码风格

### 模块化
- 每个功能模块独立文件，通过 ES Modules (`import`/`export`) 组织代码
- 文件命名使用 kebab-case（如 `content-script.js`、`api-handler.js`）
- 公共工具函数抽取到 `utils/` 目录，禁止跨模块复制粘贴代码
- 新增功能模块时优先复用 constants.js 中的常量、markdown.js 中的渲染、page-extractor.js 中的 extractPageInfo

### 现代化
- 统一使用 `const`/`let`，禁止 `var`
- 优先使用箭头函数、模板字符串、解构赋值、可选链 (`?.`) 等 ES2020+ 语法
- 异步操作统一使用 `async/await`，避免回调嵌套
- 错误处理使用 `try/catch`，不允许未捕获的 Promise rejection

### 注释规范
- 所有模块、核心函数、复杂逻辑处添加简短的中文注释，说明意图而非复述代码
- 注释格式示例：
  ```js
  // 从当前标签页提取正文内容
  async function extractPageContent(tabId) { ... }

  // 检查 runtime.lastError 并统一处理通信错误
  function checkRuntimeError() { ... }
  ```

### 目录结构
```
search-web-info/
├── manifest.json               # 扩展清单文件
├── src/
│   ├── background/
│   │   └── service-worker.js   # Service Worker（右键菜单、后台分析）
│   ├── popup/
│   │   ├── popup.html          # 弹窗界面（主视图 + 设置视图）
│   │   ├── popup.js            # 弹窗逻辑（抓取、配置、缓存、历史、右键结果检测）
│   │   └── popup.css           # 样式（含暗色模式）
│   ├── utils/
│   │   ├── constants.js        # 全局常量（默认值、超时、存储键、供应商预设、工具函数）
│   │   ├── ai-trans.js         # AI API 流式调用（SSE 全页/选中文字分析）
│   │   ├── markdown.js         # Markdown → HTML 安全渲染（XSS 防护）
│   │   └── page-extractor.js   # 页面提取注入函数 + executeScript 包装（popup/SW 共享）
│   └── assets/
│       └── icons/
├── CLAUDE.md
└── README.md
```

## 约束

- 不可引入 jQuery、lodash 等大型第三方库，优先使用原生 API
- 页面提取直接使用 `chrome.scripting.executeScript` 注入纯函数，不走 content script
- 所有网络请求使用 `fetch` API，并做好超时和错误处理（2 分钟流式超时）
- 代码需兼容 Chrome 最新稳定版（向前兼容 2 个大版本即可）
- `navigator` 等浏览器全局对象在 Service Worker 中不可用，需加 `typeof` 守卫