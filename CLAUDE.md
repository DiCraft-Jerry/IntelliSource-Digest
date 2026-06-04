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
- 扩展各部分（popup、content script、service worker）之间通信统一使用 `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`
- 所有异步通信调用必须检查 `chrome.runtime.lastError`，不允许静默忽略错误
- 消息格式统一为 `{ action: string, payload?: any }` 结构，便于路由和扩展

### Content Script 规范
- 在 `manifest.json` 中通过 `content_scripts` 字段声明注入规则
- content script 与页面共享 DOM，但 JS 环境隔离（isolated world），不得依赖页面全局变量
- 如需与页面内 JS 通信，使用 `window.postMessage` + 自定义事件，并在接收端做好来源校验

### API 使用规范
- 所有 Chrome API 调用推荐使用 Promise 封装或直接使用 `async/await`（Manifest V3 原生支持 Promise 风格调用）
- 敏感权限（如 `tabs`、`storage`、`activeTab` 等）遵循最小权限原则，仅声明实际使用的权限
- 禁止在 `permissions` 中申请不必要的 `host_permissions`，优先使用 `activeTab` + 用户手势触发

## 代码风格

### 模块化
- 每个功能模块独立文件，通过 ES Modules (`import`/`export`) 组织代码
- 文件命名使用 kebab-case（如 `content-script.js`、`api-handler.js`）
- 公共工具函数抽取到 `utils/` 目录，禁止跨模块复制粘贴代码

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

### 目录结构建议
```
search-web-info/
├── manifest.json          # 扩展清单文件
├── src/
│   ├── background/
│   │   └── service-worker.js   # Service Worker 入口
│   ├── content/
│   │   └── content-script.js   # 内容脚本
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   ├── utils/
│   │   ├── storage.js          # chrome.storage 封装
│   │   ├── message.js          # 消息通信封装（含 lastError 检查）
│   │   └── api.js              # AI API 调用封装
│   └── assets/
│       └── icons/
├── CLAUDE.md
└── README.md
```

## 约束

- 不可引入 jQuery、lodash 等大型第三方库，优先使用原生 API
- 不可在 content script 中直接操作 `window.postMessage` 不做来源校验就信任数据
- 所有网络请求使用 `fetch` API，并做好超时和错误处理
- 代码需兼容 Chrome 最新稳定版（向前兼容 2 个大版本即可）