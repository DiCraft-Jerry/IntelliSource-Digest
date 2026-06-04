# 智源摘读 · IntelliSource Digest

智能提取网页关键信息，AI 驱动的一键摘要 Chrome 扩展（Manifest V3）。

## 功能

- **一键抓取**：点击扩展图标即可提取当前网页的标题、描述、正文、表格和链接
- **AI 智能分析**：支持 OpenAI 兼容 API，对流式输出网页内容摘要与数据分析
- **多供应商支持**：预设 OpenAI、DeepSeek、通义千问、Moonshot、智谱 GLM，同时支持自定义 API
- **流式输出**：SSE 实时渲染 AI 生成内容，不再长时间等待
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
5. 点击「保存设置」

### 分析网页

1. 打开任意网页
2. 点击工具栏中的扩展图标
3. 等待抓取和分析完成，结果实时展示
4. 可点击「重新抓取」强制刷新

## 项目结构

```
search-web-info/
├── manifest.json              # Chrome 扩展清单
├── src/
│   ├── popup/
│   │   ├── popup.html         # 弹窗界面
│   │   ├── popup.js           # 主逻辑（抓取、配置、缓存）
│   │   └── popup.css          # 样式
│   └── utils/
│       └── ai-trans.js        # AI API 调用与 Markdown 渲染
└── assets/
    └── icons/                 # 扩展图标
```

## 技术栈

- Chrome Manifest V3
- `chrome.scripting.executeScript` 直接注入提取
- `chrome.storage.session` / `chrome.storage.local` 缓存与持久化
- SSE 流式响应解析
- 原生 JavaScript（无第三方依赖）

## 隐私

- API Key 仅存储在 `chrome.storage.local`，完全在浏览器本地
- 网页数据仅发送给你配置的 AI API 端点
- 不收集任何使用数据或遥测信息
