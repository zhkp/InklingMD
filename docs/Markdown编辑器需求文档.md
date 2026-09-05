# Markdown 所见即所得编辑器 —— 产品需求文档（PRD）

> 对标产品：Typora
> 文档版本：v3.0.0
> 用途：作为 AI 辅助编程（vibe coding）的开发依据

---

## 1. 项目背景与目标

Typora 是一款"所见即所得"（WYSIWYG）的 Markdown 编辑器，核心卖点是**编辑与预览融为一体**——不需要左右分栏、不需要切换模式，输入 Markdown 语法后立即渲染成排版好的富文本样式，但底层保存的仍是标准 Markdown 文本。目前 Typora 采用买断制付费（约 $14.99，15 天试用），本项目目标是自研一款功能对等、可自由定制的替代品，供个人使用。

**核心目标：**
- 完全私有部署，不依赖任何账号/联网激活
- 功能覆盖 Typora 90% 以上高频使用场景
- 可按自己喜好扩展（如接入 AI 辅助写作、自定义快捷键等）

---

## 2. 产品定位

一款跨平台（至少支持桌面端，Windows/macOS，可选 Web 版）的本地 Markdown 文件编辑器，核心理念："所见即所写"——用户看到的排版效果就是最终效果，无需在"源码模式"和"预览模式"之间切换。

---

## 3. 核心功能模块

### 3.1 编辑器内核（最核心，优先级最高）

这是整个项目技术难度最大的部分，决定产品体验上限。

- **实时所见即所得渲染**：光标所在行/块显示 Markdown 源码语法符号（如 `**`、`#`、`- `），光标离开后该块自动渲染为富文本样式（如加粗、标题、列表）
- **富文本操作映射到 Markdown**：用户在渲染后的文本上直接选中加粗、插入链接等操作，需自动生成对应的 Markdown 语法并写回文本
- **底层数据始终是标准 Markdown 纯文本**，不产生任何私有格式，保证可移植性
- **撤销/重做**、**多光标编辑**（可选，进阶功能）
- 自动补全：输入 `**` 自动补全为 `****` 并把光标放在中间；输入 `[` 自动补全 `]`；反引号、括号、引号自动配对（可在设置中开关）

### 3.2 Markdown 语法支持范围

| 类别 | 具体语法 |
|---|---|
| 基础 | 标题 H1-H6、加粗、斜体、删除线、行内代码、引用块、分割线、软换行/硬换行 |
| 列表 | 有序列表、无序列表、任务列表（`- [ ]` / `- [x]`）、多级嵌套列表（Tab/Shift+Tab 缩进） |
| 链接与图片 | 普通链接、引用式链接、图片插入、图片自定义宽度/缩放（`<img>` 标签方式）、内部锚点跳转（链接到标题） |
| 表格 | GFM 表格语法，鼠标拖拽调整列宽、快速插入指定行列数的表格、行列快速增删排序 |
| 代码块 | 围栏代码块 ```` ``` ````、语言标注、语法高亮（覆盖主流 ~100 种语言）、显示行号 |
| 数学公式 | 行内公式 `$...$`、块级公式 `$$...$$`，基于 MathJax/KaTeX 渲染，支持化学方程式（mhchem）、公式自动编号 |
| 图表 | Mermaid（流程图、时序图、甘特图、类图等）、可选 flowchart.js / sequence diagram |
| 其他 | 脚注、YAML Front Matter（文档元数据）、目录 `[TOC]` 自动生成、表情符号 `:emoji:` 自动补全、HTML 内嵌标签渲染 |

### 3.3 文件与工作区管理

- **文件树侧边栏**：以文件夹为单位打开工作区，树状展示所有 `.md` 文件及子目录
- **大纲面板**：根据文档内标题自动生成目录结构，点击可跳转到对应位置
- **多标签页**：同时打开多个文件
- **自动保存** + 手动保存，文件变更监听（外部修改后提示重新加载）

### 3.4 导入导出

- 导出：PDF（保留书签）、HTML（含内嵌样式）、Word（.docx）、图片（长图）
- 导入：Word、HTML 转 Markdown（可选，优先级较低）
- 复制为富文本（粘贴到其他软件时保留样式）、复制为纯 Markdown 源码

### 3.5 样式与主题

- **内置多套主题**，主题本质是一份 CSS 文件
- **支持用户自定义 CSS**，允许通过覆盖 CSS 变量自由调整字体、字号、行距、配色
- 明暗模式切换（跟随系统 / 手动）
- 代码块语法高亮主题独立可配置

### 3.6 辅助写作功能

- **字数统计**：字数、字符数、行数、预计阅读时长，实时显示在状态栏
- **专注模式（Focus Mode）**：非当前段落做模糊/弱化处理
- **打字机模式（Typewriter Mode）**：当前编辑行始终保持在视窗垂直居中
- **大纲/侧边导航同步高亮**：编辑到某处，大纲面板自动高亮对应标题
- 查找与替换（支持正则）

### 3.7 图片处理

- 粘贴截图/拖拽图片自动插入并复制到本地图片文件夹（相对路径管理），避免图片丢失
- 图片相对路径与绝对路径切换
- 可选：接入图床（如 GitHub、七牛云、自建 S3）实现自动上传并替换为在线链接

### 3.8 快捷键与偏好设置

- 完整的快捷键体系（加粗 Ctrl/Cmd+B、斜体 Ctrl/Cmd+I 等），支持自定义
- 偏好设置面板：字体、主题、自动保存间隔、Markdown 语法细节开关（如是否严格遵循 CommonMark）

---

## 4. 非功能性需求

| 维度 | 要求 |
|---|---|
| 性能 | 万字长文档编辑无明显卡顿；大文件（图片较多）打开时间 < 2s |
| 跨平台 | 优先 Windows + macOS，技术选型建议使用 Electron 或 Tauri 保证跨平台一致性 |
| 数据安全 | 本地优先，不强制联网、不上传用户内容；自动备份/崩溃恢复 |
| 可扩展性 | 插件机制预留（如未来接入 AI 续写/润色能力） |
| 兼容性 | 生成的 Markdown 需兼容 GitHub/主流静态博客引擎（Hugo、Hexo 等）的解析规则 |

---

## 5. 技术方案建议（供 vibe coding 参考）

考虑到是个人独立开发，建议技术栈：

- **应用框架**：Tauri（更轻量、包体小、性能好）或 Electron（生态成熟、开发更快）
- **编辑器内核**：这是最关键也最难的部分，两个方向：
  1. 基于 **ProseMirror** 或 **Milkdown**（已经是基于 ProseMirror 封装的所见即所得 Markdown 方案，开源，可大幅降低开发难度，强烈建议优先调研）
  2. 基于 **CodeMirror 6** 做"半所见即所得"（语法高亮+实时局部渲染，比纯 WYSIWYG 简单很多，是很多轻量编辑器的折中方案，如 Obsidian Live Preview 的思路）
- **公式渲染**：KaTeX（比 MathJax 快，功能略少但够用）
- **图表渲染**：Mermaid.js（直接引入其官方库即可）
- **代码高亮**：Shiki 或 highlight.js
- **文件系统操作**：Tauri/Electron 原生 API
- **导出 PDF/Word**：可调用 Pandoc（命令行工具，功能强大，社区成熟，避免自己写转换逻辑）

> 建议：Milkdown 是目前开源生态中最接近 Typora 所见即所得体验的方案，先花时间验证它能否覆盖 3.2 节中列出的语法需求，可以省去自研编辑器内核的巨大工作量。

---

## 6. MVP 优先级划分

**P0（必须，第一版）**
- 基础语法所见即所得（标题/加粗/斜体/列表/引用/代码块/表格/链接图片）
- 文件树 + 打开/保存/自动保存
- 基础主题（1套即可）+ 字数统计

**P1（第二版）**
- 数学公式、Mermaid 图表、大纲面板、导出 PDF/HTML
- 自定义 CSS 主题、明暗模式

**P2（后续迭代）**
- 专注模式/打字机模式、脚注/TOC、图床集成、导出 Word、快捷键自定义、正则查找替换

---

## 7. 差异化机会（自研的额外价值）

既然是自己开发，可以在功能对等的基础上加入 Typora 没有的能力，例如：
- 接入 AI 能力（选中文字润色/翻译/续写、根据大纲自动生成初稿）
- 双向链接/知识库能力（借鉴 Obsidian）
- 免费开源、无需买断付费

---

*本文档可作为向 AI 编程工具（如 Claude Code）拆解开发任务的输入依据，建议按第 6 节的优先级逐步实现并验证。*

---

## 8. 实现进度（截至 v1.0.0）

> 本节用于对照 PRD 需求与实际落地情况，方便后续迭代决策。详细技术方案与任务拆解见 `技术方案与任务拆解.md`。

### 8.1 已实现功能

| PRD 章节 | 需求 | 状态 | 落地版本 | 说明 |
|---|---|---|---|---|
| 3.1 编辑器内核 | 模式切换内容锚点还原阅读位置与光标 | ✅ | v2.8.0 | issue #136：进入方向采集视口顶部块内容锚点（code_block 吸附），退出方向 resolveAnchorProsePos 精确文本匹配；单一写者 + settle 收敛 + rAF 合帧 |
| 3.1 编辑器内核 | 模式切换视口与滚动比例映射还原 | ✅ | v2.7.0 | issue #121：恢复 sourceMode 快照守卫，缓存 wysiwygScrollTopRef，退出模式按两端 scrollHeight 用 mapScrollTop 比例映射恢复 |
| 3.1 编辑器内核 | Ctrl+K 应用内插入链接对话框 | ✅ | v2.7.0 | issue #122：新增 LinkDialog.tsx，文本与 URL 双输入、选中预填、Esc/backdrop 关闭，替换原生 window.prompt |
| 3.3 文件与工作区 | 删除快照配额告警与写入失败用户提示 | ✅ | v2.7.0 | issue #123：probeSnapshotStorageHealth 健康探测 + 快照写入失败 showMessage error 告警（不再静默）+ DeletedSnapshots 面板展示 |
| 3.3 文件与工作区 | 外部修改盲区与 switchTab 重载/冲突 | ✅ | v2.7.0 | issue #124：监听全量 openTabs，switchTab 核验 mtime，外部修改非 dirty→reloadFile、dirty→conflictPending + 冲突对话框 |
| 3.1 快捷键体系 | 自定义快捷键冲突黑名单补全 | ✅ | v2.7.0 | issue #125：RESERVED_SHORTCUTS 补齐 mod+s/n/shift+f/r/k/alt+0/0/f11 硬编码组合 |
| 3.5 搜索 | 全局搜索异步竞态守卫 | ✅ | v2.7.0 | issue #126：GlobalSearchPanel 递增 seq 序列号，丢弃过期请求结果 |
| 3.2 导出 | 源码模式导出 Word (.docx) 解绑 | ✅ | v2.7.0 | issue #127：移除 exportDocx 的 blockedBySourceMode 拦截 |
| 3.5 搜索 | 全部替换完成提示非阻塞化 | ✅ | v2.7.0 | issue #128：search-notice 状态徽章替代阻塞模态 |
| 3.3 文件与工作区 | 清空删除快照二次确认 | ✅ | v2.7.0 | issue #129：DeletedSnapshots 清空操作 askConfirmation 警告确认 |
| 3.5 样式 | 设置面板 Esc 键关闭 | ✅ | v2.7.0 | issue #130：SettingsPanel 增加 Escape 监听触发 onClose |
| 3.2 图片 | 图片插入与上传异常反馈 | ✅ | v2.7.0 | issue #131：image-upload 捕获保存/写入异常弹出带文件名的错误提示 |
| 3.3 文件与工作区 | 自动保存冲突状态呈现 | ✅ | v2.7.0 | issue #132：冲突时置 conflictPending，SaveIndicator 展示"已暂停"并可拉起冲突对话框 |
| 3.5 跨端 | 多窗口 Storage 同步 E2E | ✅ | v2.7.0 | issue #133：重写 multi-window-sync.spec.ts，原生 storage 事件 + DOM 断言 |
| 3.2 图片 | 未命名草稿内联大图体积护栏 | ✅ | v2.7.0 | issue #134：未命名草稿图片超 512KB 输出体积警告 |
| 3.1 | 实时所见即所得渲染 | ✅ | v0.1.0 | 基于 Milkdown 7 / ProseMirror |
| 3.1 | 撤销/重做 | ✅ | v0.1.0 | Milkdown 内置 |
| 3.2 基础 | 标题/加粗/斜体/删除线/行内代码/引用/分割线 | ✅ | v0.1.0 | commonmark + gfm preset |
| 3.2 列表 | 有序/无序/任务列表/嵌套 | ✅ | v0.1.0 | |
| 3.2 表格 | GFM 表格、行列增删、对齐 | ✅ | v0.2.0 | `TableToolbar.tsx`；列宽拖拽未实现 |
| 3.2 代码块 | 围栏代码块、语言标注、语法高亮 | ✅ | v0.2.0 | CodeMirror 6（替代初版 Shiki），含行号 |
| 3.2 数学公式 | 行内 `$...$` / 块级 `$$...$$` | ✅ | v0.3.0 | KaTeX；含 mhchem 化学方程式、公式自动编号（v0.5.0） |
| 3.2 图表 | Mermaid | ✅ | v0.3.0 | 流程图/时序图/甘特图等 |
| 3.2 其他 | 脚注 / `[TOC]` / YAML Front Matter | ✅ | v0.5.0 | GFM 脚注 + 自定义 NodeView；TOC 自动生成；Front Matter 走 remark-frontmatter + CodeMirror 视图 |
| 3.3 | 文件树侧边栏 | ✅ | v0.1.0 | 支持显隐切换（v0.5.0） |
| 3.3 | 大纲面板（点击跳转 + 高亮） | ✅ | v0.3.0 | `OutlinePanel.tsx` + `outline-tracker.ts`；支持显隐切换（v0.5.0） |
| 3.3 | 多标签页 | ✅ | v0.4.0 | `Tabs/TabsBar.tsx` |
| 3.3 | 自动保存 + 手动保存 | ✅ | v0.1.0 | 防抖 2 秒 + Ctrl/Cmd+S |
| 3.3 | 文件变更监听（外部修改提示重载） | ✅ | v0.5.0 | `useFileWatcher` 轮询 mtime，仅桌面端 |
| 3.4 | 导出 HTML | ✅ | v0.3.0 | 含内嵌样式 |
| 3.4 | 导出 PDF | ✅ | v0.3.0 | 浏览器打印（未用 Pandoc） |
| 3.4 | 导出 Word | ✅ | v0.6.0 | 走 Pandoc（Rust command 调用本地 pandoc），未安装时给出引导提示 |
| 3.4 | 复制为富文本 / 纯 Markdown | ✅ | v0.5.0 | `exporter.ts` 中 `copyRichText` / `copyMarkdown` |
| 3.5 | 主题系统 + 自定义 CSS | ✅ | v0.3.0 | `theme.ts`，加载自定义 CSS 文件 |
| 3.5 | 明暗模式切换 | ✅ | v0.3.0 | |
| 3.5 | 代码块语法高亮主题独立配置 | ✅ | v0.5.0 | `settings.ts` + `code-block-view.ts` 动态重配 |
| 3.6 | 字数统计 | ✅ | v0.1.0 | 字数/字符数/行数/阅读时长 |
| 3.6 | 专注模式 / 打字机模式 | ✅ | v0.5.0 | `editor-modes.ts`，运行时切换 |
| 3.6 | 查找替换（正则） | ✅ | v0.5.0 | `search.ts` + `SearchPanel.tsx`，Ctrl/Cmd+F |
| 3.7 | 图片拖拽/粘贴自动入库 | ✅ | v0.2.0 | 相对路径引用 `assets/` |
| 3.7 | 图床集成 | ❌ | — | 可选，未规划 |
| 3.8 | 快捷键体系 | ✅ | v0.5.0 | Milkdown 预设 + 应用级快捷键 + 帮助面板（Ctrl/Cmd+/） |
| 3.8 | 快捷键自定义面板 | ✅ | v0.6.0 | `shortcuts.ts` + `ShortcutsCustomize.tsx`，支持捕获式绑定、冲突检测、一键恢复默认 |
| 3.8 | 偏好设置面板 | ✅ | v0.5.0 | `SettingsPanel.tsx`，含专注/打字机/公式编号/代码主题 |
| 3.2 其他 | callout 提示框 | ✅ | v0.7.0 | `callout.ts`，支持 `> [!NOTE/WARNING/TIP/IMPORTANT]` GFM 语法，自定义 NodeView 配色 |
| 3.2 其他 | 斜杠菜单 `/` | ✅ | v0.7.0 | `slash-menu.ts` ProseMirror 插件，空行输入 `/` 弹出块类型菜单 |
| 3.3 | 全局搜索 | ✅ | v0.7.0 | `search.rs` + `GlobalSearchPanel.tsx`，`Ctrl+Shift+F` 跨工作区搜索 |
| 3.3 | 标签页右键菜单 + 拖拽重排 | ✅ | v0.7.0 | `TabContextMenu.tsx` + `reorderTabs`/`closeOthers`/`closeToRight` |
| 3.3 | 文件树重命名/删除/新建 | ✅ | v0.7.0 | `rename_path`/`delete_path`/`create_file`/`create_dir` Rust 命令 + 行内重命名 |
| 3.3 | 最近打开文件列表 | ✅ | v0.7.0 | `recentFiles` 持久化到 localStorage，侧边栏顶部展示 |
| 3.3 | 编辑位置记忆 | ✅ | v0.7.0 | `saveCursorState`/`getActiveCursorState`，关闭重开恢复光标与滚动 |
| 3.8 | 编辑器错误边界 | ✅ | v0.7.0 | `EditorErrorBoundary.tsx`，渲染异常时降级 UI 而非白屏 |
| 3.2 | 自动配对补全 | ✅ | v0.8.0 | `auto-pair.ts`，括号/引号配对，含中文引号/书名号，可在设置开关 |
| 3.2 | 图片缩放/对齐 | ✅ | v0.8.0 | `image-node-view.ts`，拖拽手柄缩放，右键菜单对齐，width/align 编码进 title 持久化 |
| 3.2 | 行内图片格式 | ✅ | v0.8.0 | NodeView 改用 inline-block span，图片在文字流行内显示 |
| 3.3 | 禅模式 | ✅ | v0.8.0 | `ui.ts` zenMode，F11 进入 / Esc 退出，隐藏所有 UI |
| 3.3 | 文件夹折叠状态记忆 | ✅ | v0.8.0 | `collapsedDirs` 持久化到 localStorage，重启恢复 |
| 3.3 | 书签/收藏 | ✅ | v0.8.0 | `bookmarks` 持久化，侧边栏书签区块，文件右键加入/取消，删除文件自动清理 |
| 3.2 | 表格列宽拖拽 | ✅ | v0.8.0 | `columnResizingPlugin`（已引入），当次会话内有效（markdown 不携带列宽，无法跨会话持久化） |
| 3.8 | 拼写检查开关 | ✅ | v0.8.4 | `settings.ts` spellcheck 字段（默认关闭），Editor root div 绑定 spellCheck，ProseMirror contentEditable 继承，运行时切换 |
| 3.3 | 单文件模式 | ✅ | v0.8.4 | `workspaceMode`（folder/file/null）+ `openFileStandalone`，不建文件树但设 rootPath 为父目录便于图片相对路径解析，支持散落多 md 作为标签页 |
| 3.3 | 多面板分屏 | ✅ | v0.9.0 | workspace store 新增 `splitFile`/`splitContent` 及 `splitOpen`/`splitClose`/`splitSwap`/`setSplitContent`；标签页右键「在分屏打开」启动右侧第二面板，双编辑器实例独立编辑，支持左右交换 |
| 3.1 | 拖拽块排序 | ✅ | v0.9.0 | `block-drag.ts` ProseMirror 插件，顶层块左侧 ⋮⋮ 手柄（Decoration.widget），HTML5 DnD 整块移动，drop 指示器高亮目标位置 |
| 3.4 | 导出长图（PNG） | ✅ | v0.9.0 | `exporter.ts` `exportPNG`，html2canvas 离屏渲染编辑器内容为 2x PNG，桌面端写文件/浏览器端下载 |
| 3.4 | 文档大纲导出 | ✅ | v0.9.0 | `exporter.ts` `exportOutline`，基于 `parseOutline` 提取标题层级，生成带缩进列表 + 原始标题结构的 md 文件 |
| 3.3 | 多窗口 | ✅ | v0.9.0 | `newWindow.ts` 用 `WebviewWindow` 创建独立窗口，文件路径经 URL 查询参数传递，新窗口启动时自动 `openFileStandalone`；文件树/标签页右键「在新窗口打开」 |
| 3.1 | 多光标/块选 | ❌ | — | 调研后不做：ProseMirror 作者确认 Sublime 式多光标「very hard」，需自定义 Selection 子类 + 重写输入处理，无现成实现；现有多范围选择仅表格 CellSelection（已支持）。详见 9.3 |
| 3.7 | 内置图床 | ❌ | — | 调研后 defer：需后端存储（S3/OSS）或第三方云服务账号，与本地优先/绿色理念冲突且引入安全与依赖。现有 `image-upload.ts` 本地 assets 方案为推荐工作流，详见 9.3 |
| — | 品牌重命名 | ✅ | v1.0.0 | Inkling → InklingMD（productName/窗口标题/README/Cargo 包名等用户可见处），规避与 Inkling Systems 公司重名；localStorage key 等内部标识符保留不动避免丢用户数据 |
| — | 开源化 | ✅ | v1.0.0 | MIT 许可证、CONTRIBUTING.md 贡献指南、issue/PR 模板、README 徽章与贡献者章节 |
| 9.1 | 中文句号字形修复 | ✅ | v1.0.0 | issue #9：`index.html` `lang="zh-CN"` + 全局字体栈增加简体中文字体（Noto Sans CJK SC / Microsoft YaHei / PingFang SC），修复 Linux 下 U+3002 回退到 CJK JP 居中字形 |
| 3.2 | 本地图片相对路径 | ✅ | v1.0.0 | PR #8：`EditorProps` 增加 `filePath`，`imageUploadPlugin`/`imageView` 据此解析本地图片相对路径；切换文件由外层 `key` 触发编辑器重建刷新闭包 |
| 3.3 | 文件关联双击打开 | ✅ | v1.0.1 | 双击 .md 文件启动程序自动打开该文件；Rust 端 `md_file_from_args` 从 argv 提取路径存 `PendingFile` state，前端 `take_pending_file` 拉取（避免事件早于监听器注册丢失）；`tauri-plugin-single-instance` 单实例转发，程序已运行时双击不开新实例，`emit_to("main")` 定向到主窗口 |
| 3.3 | 新建未命名草稿 | ✅ | v1.1.0 | `Ctrl+N` 新建未关联磁盘文件的草稿 tab（`OpenTab.isUntitled`，虚拟路径 `untitled-N`）；`Ctrl+S` 弹另存为对话框选保存位置，保存后转为普通文件 tab 并加入最近列表；未命名草稿不自动保存（`useAutoSave` 跳过） |
| 3.8 | 插入工具栏 | ✅ | v1.1.0 | 工具栏从编辑器内部提升到标题栏下方固定非滚动行（修复 sticky 在 flex 滚动容器内失效导致下滑消失）；把斜杠菜单支持的块类型全部做成按钮（H1-3/列表/引用/代码块/分割线/表格/公式/Mermaid/提示框/目录/元数据），`block-commands.ts` 复用插入逻辑；表格内时显示行列增删/对齐上下文按钮 |
| 3.2 | 斜杠菜单表格可填写 | ✅ | v1.1.0 | 修复：slash-menu 手动构造 table_cell 时塞了 `schema.text(" ")`，但 cell contentSpec 是 block 级，结构非法导致无法编辑；改为 `schema.nodes.paragraph.create()` 空段落 |
| 3.2 | Mermaid 图表可编辑 | ✅ | v1.1.1 | `mermaid-view.ts` 加「编辑」按钮 + 双击入口，切 textarea 编辑源码，失焦/Ctrl+Enter 提交重新渲染；非编辑态 `stopEvent` 改为 `() => editing` 允许选中删除 |
| 3.2 | 块级/行内公式可编辑 | ✅ | v1.1.1 | `math.ts` createMathView 加双击内联编辑 LaTeX，失焦提交；编辑态 `stopEvent` 拦截事件防抢焦点 |
| 3.2 | 列表插入报错修复 | ✅ | v1.1.3 | 修复 `content does not fit in gap`：`bullet_list`/`ordered_list` 的 content 为 `list_item+`，wrap 时漏包 `list_item` 这一层导致 paragraph 直接进 list 违反 content 规范；斜杠菜单与工具栏均改为 `wrap(range, [list, list_item])` |
| 3.2 | 表格列宽调整报错修复 | ✅ | v1.1.1 | 修复 `invalid content for node table_row`：GFM 把 table_row 拆成 `table_header_row`（content `(table_header)*`）与 `table_row`（content `(table_cell)*`），斜杠菜单误把 table_header 塞进 table_row；改为第一行用 `table_header_row`，其余行用 `table_row` |
| 3.2 | 块插入位置修复 | ✅ | v1.1.1 | 修复分割线/表格/公式/callout/TOC 落在下一行：新增 `insertBlockAtCursor`/`insertBlockHere`，当前段落为空时直接替换，非空才插在当前块之后 |
| 3.2 | 列表/引用 wrap 修复 | ✅ | v1.1.1 | 修复 `content does not fit in gap`：合并到单个 transaction，用 `tr.selection` 算 blockRange，避免 deleteRange 后的 stale selection 问题 |
| 3.1 | Ctrl+A 全选全文 | ✅ | v1.1.1 | ProseMirror 默认 `Mod-a` 只选当前块文本；新增 `inkling-select-all` 插件拦截 Mod-a，用 `AllSelection` 选中整个文档 |
| 3.1 | 点击空白处可编辑 | ✅ | v1.1.1 | 监听编辑器根 mousedown，`posAtCoords` 返回 null（点击落在内容节点之外）时在文档末尾追加空段落并定位光标，无需手动换行。v1.1.4 修复：点击右侧 padding 区不再跳到文档最底部，改为把 x 夹到内容区内重查 `posAtCoords`，光标落在点击 y 对应的行附近；仅点击 y 超出所有内容时才追加末尾段落 |
| 3.3 | 新建草稿自动聚焦 | ✅ | v1.1.1 | `Ctrl+N` 新建未命名草稿后编辑器重建完成时自动 `view.focus()`，无需手动点击 |
| 3.8 | 块删除能力 | ✅ | v1.1.3 | 工具栏新增「删除块」按钮，`deleteCurrentBlock` 命令删除光标所在的整个顶层块（引用/代码块/Mermaid/提示框/元数据/列表/公式/TOC/分割线）；mermaid/frontmatter 的 `stopEvent` 优化为仅拦截编辑区内事件，非编辑态可点击选中后 Backspace 删除 |
| — | 应用图标更新 | ✅ | v1.1.2 | 用 `tauri icon` 命令从用户提供的源图重新生成全平台图标（Windows ico/StoreLogo、macOS icns、iOS、Android 全套） |
| 3.8 | 快捷键系统修复 | ✅ | v1.1.5 | 修复 `matchBinding` 的致命 bug：`MODIFIER_KEYS` 漏了 `"mod"`，导致 `parts.find` 把 `"mod"` 当作最终按键，`e.key === "mod"` 永远 false，所有走 shortcuts store 的快捷键（Ctrl+F/Ctrl+\/Ctrl+'/Ctrl+\/Ctrl+,）全部失效；加入 `"mod"` 后修复 |
| 3.8 | Ctrl+K 插入链接 | ✅ | v1.1.5 | Typora 标准快捷键：选中文本按 Ctrl+K 弹输入框填 URL，给选中文本加 link mark；无选中则先填 URL 再填文本，插入 `[文本](url)` |
| 3.8 | Ctrl+Alt+0 转普通段落 | ✅ | v1.1.5 | Typora 标准快捷键：清除当前块格式，标题/引用/代码块等转回普通段落 |
| 3.6 | Ctrl+滚轮缩放文档 | ✅ | v1.2.2 | `Ctrl/Cmd+滚轮` 等比放大/缩小整个文档（50%~300%，步进 10%），`Ctrl/Cmd+0` 重置 100%；缩放级别持久化到 localStorage；状态栏右侧显示当前百分比，点击可重置 |
| 3.2 其他 | HTML 嵌入/行内标签渲染 | ✅ | v1.2.3 | 白名单渲染 `<span>/<kbd>/<mark>/<details>/<blockquote>` 等标签；DOMParser 解析 + LRU 缓存保性能；过滤 script/on*/javascript: 等危险内容 |
| 3.2 其他 | 脚注（footnote） | ✅ | v1.2.3 | GFM 脚注语法 `[^1]` 引用 + `[^1]: 定义`；点击引用跳转定义，点击返回链接跳回首个引用 |
| 3.2 图表 | Mermaid 下载与缩放 | ✅ | v1.2.3 | 「下载」按钮导出 SVG 文件（桌面端弹保存对话框）；图表上 `Ctrl/Cmd+滚轮` 缩放 SVG（0.5~3x），不触发文档缩放 |
| 3.6 | Ctrl+滚轮缩放文档（性能修复） | ✅ | v1.2.4 | 修复万行 MD 文档滚轮失效：wheel 监听器改为仅在 Ctrl/Cmd 按下时挂载（passive:false），普通滚动时 window 上无任何 wheel 监听器走浏览器合成线程快速路径；逻辑抽到 `useCtrlWheelZoom` hook 便于测试 |
| 3.2 表格 | 表格删列/删行按钮修复 | ✅ | v1.2.4 | 修复工具栏「删列/删行」按钮无效（原依赖 CellSelection 但未先选中列）；改用 `prosemirror-tables` 的 `deleteColumn`/`deleteRow` 直接基于光标位置删除，无需先选列 |
| 3.2 图表 | Mermaid 图表拖动平移 | ✅ | v1.2.5 | 缩放大于 100% 时按住鼠标拖动平移图表查看各区域（无需调滚动条）；双击重置缩放与平移；重新渲染图表时重置平移；`destroy` 清理 window 监听器避免泄漏 |
| 3.3 公式 | 块级公式插入修复 | ✅ | v1.2.6 | 修复斜杠菜单和工具栏插入块级公式「不能用」：插入空 atom 节点后 KaTeX 渲染空字符串无可见内容；改为插入后自动选中节点并触发双击进入编辑模式，且空值显示虚线占位框「双击编辑公式」 |
| 3.4 工具栏 | 删除块/列表/引用多项边界 bug 修复 | ✅ | v1.2.7 | 修复5个 bug：①光标在元数据上点删除块误删底部块（NodeSelection 未识别）；②点击目录块再点删除块无反应（同上）；③工具栏点两次删除线报错 "there is no position after the top-level node"（insertBlockHere 在文档末尾块 $from.after 越界）；④点两次列表报错 "invalid content for node list_item"（列表内重复 wrap）；⑤代码块内点列表/引用报错 "content does not fit in gap"（code_block content 不允许 wrap） |
| 3.2 数学公式 | 行内公式插入入口 | ✅ | v1.2.8 | `insertInlineMath` 命令在光标处插入 `math_inline` atom 节点并自动进入编辑态；工具栏 `$ 行内` 按钮 + 斜杠菜单 `/行内` 双入口；空值显示「公式」占位提示 |
| 3.4 工具栏 | frontmatter 删除块误删彻底修复 | ✅ | v1.2.8 | v1.2.7 的 mousedown 监听被 CodeMirror focus 事务冲掉仍失效；`deleteCurrentBlock` 增加 DOM 焦点回退（`document.activeElement` 反查 atom 顶层块）；删除块按钮 `onMouseDown preventDefault` 防止抢走 CM 焦点 |
| 3.2 列表 | 列表内点代码块/表格/标题报错修复 | ✅ | v1.2.8 | 修复 `invalid content for node list_item`：list_item content 要求首子节点为 paragraph；新增 `exitListIfNeeded` 在列表后插入空段落移出光标，`setBlockType`/`insertTable` 调用前先退出列表 |
| 3.6 表格 | 列宽拖拽手柄不可见修复 | ✅ | v1.2.9 | `columnResizingPlugin` 装配正确但 `App.css` 把 `.column-resize-handle` 设为 `opacity:0` 且无 `:hover` 显形规则导致手柄永久不可见；补 `th/td:hover .column-resize-handle { opacity:0.5 }` 和拖拽中 `opacity:0.8`；`table overflow:hidden` 改 `visible` 避免裁掉最右列手柄 |
| 3.8 桌面端 | 全部替换/保存报错 `message not allowed by acl` 修复 | ✅ | v1.2.9 | Tauri v2 ACL 对自定义 command 强制校验，app command 不会自动生成权限标识符；新增 `permissions/app-commands.toml` 用 `[[permission]]` 块为 13 个 command 显式定义权限，`capabilities/default.json` 引用 `allow-write-text-file` 等，修复全部替换→自动保存→`write_text_file` 被拦截链路（同时修复打开文件/工作区/导出等所有 fs 功能） |
| 3.2 代码块 | 点击第一行光标跳到 9-11 行修复 | ✅ | v1.2.9 | `CodeBlockNodeView.setSelection` 直接把 PM 绝对位置当 CM 本地位置传给 `cm.dispatch`，`forwardUpdate` 反馈闭环导致光标跳到 `getPos()+1` 对应的 CM 本地位置（约第 10 行）；改为 `localAnchor = anchor - getPos() - 1` 做位置翻译（与 `forwardUpdate` 的 `offset = getPos()+1` 互逆）+ 边界夹紧；`selectNode` 清空 CM 选区；`update` 的 `scrollIntoView` 改 `false` 避免外部更新乱滚动 |
| 3.8 桌面端 | 全部替换 alert 报错 `dialog\|message not allowed acl` 修复 | ✅ | v1.2.10 | Tauri webview 自动拦截 `window.alert()` 映射为 `dialog.message`、`window.confirm()` 映射为 `dialog.ask`，但 capabilities 只授权了 `dialog:allow-open`/`dialog:allow-save` 缺 `dialog:allow-message`/`dialog:allow-ask`；补齐这两个权限，修复全项目 20 处 alert/confirm 调用的 ACL 拦截（全部替换、删除确认、重命名失败提示等） |
| 3.5 样式 | 设计令牌系统（design token） | ✅ | v2.0.0 | 全应用通过 CSS 变量统一管理品牌强调色（`--accent` 浅色 `#0969da` / 深色 `#2f81f7`，统一原先散落的近似值）、三级文字色阶、分层阴影（`--shadow-sm/md/lg`）、圆角梯度（`--radius-sm/md/lg`）、动效曲线（`--ease` / `--duration`）、键盘聚焦环（`--ring`）；主题切换只改一处 |
| 3.5 样式 | 统一 SVG 图标库 | ✅ | v2.0.0 | `icons.tsx` 线性风格（`stroke=currentColor` 随文字颜色继承），默认 16px / 24×24 viewBox，替代原先混用的 emoji / Unicode 符号，跨平台渲染一致；覆盖 18 个图标（Folder/File/FileText/Star/StarFilled/Sun/Moon/Maximize/PanelLeft/Settings/HelpCircle/X/ArrowLeftRight/ChevronDown/ChevronRight/Download/AlertTriangle/Palette） |
| 3.5 样式 | 现代化滚动条 / 聚焦环 / 动效 / 活跃状态 | ✅ | v2.0.0 | 细半透明滚动条（10px，hover 加深，标签页栏 3px）；`:focus-visible` 键盘聚焦环（鼠标点击不触发）；菜单弹入 `menu-in`（0.12s）、模态弹入 `modal-in`（0.18s）、遮罩淡入 `backdrop-in`、空状态淡入 `fade-in`；ghost 风格顶栏按钮；渐变品牌标题（`background-clip:text`）；活跃 tab 卡片样式（顶部强调色指示条 + 底部连通编辑区）；活跃文件左侧指示条（`inset box-shadow`）；iOS 风格 Toggle 开关；模态毛玻璃遮罩（`backdrop-filter:blur(2px)`）；文本选择色跟随强调色；全应用过渡曲线统一引用令牌 |
| 3.5 样式 | Mermaid 流程图多行节点文字底部裁切修复 | ✅ | v2.0.1 | 根因三因素叠加：`:root line-height:1.6` 继承进 mermaid `nodeLabel` 使渲染行高 ≈ 测量行高（~1.2）1.33 倍、`flowchart.useMaxWidth` 默认 true 触发长文本回流高度重算偏差、`style stroke-width:2px` 加粗边框侵占内部高度；修复：`mermaid-view.ts` 提取 `MERMAID_CONFIG`（`flowchart.htmlLabels:true` + `padding:20` + `useMaxWidth:false` + `themeVariables.fontSize:"14px"`），`App.css` 锁定 `.mermaid`/`.mermaid-render` 的 `.nodeLabel`/`.edgeLabel` `line-height:1.25` + `font-size:14px` + 字体，使测量阶段与渲染阶段文字高度一致 |
| 3.3 工作区 | 大型工作区按需加载与文件树渲染优化 | ✅ | v2.1.0 | issue #11/PR #15：Rust `list_dir` 改为单层浅扫并迁入 `spawn_blocking` 线程池避免阻塞 Tauri 异步运行时，跳过隐藏项/依赖构建目录（node_modules、target、dist、build、out）/目录符号链接；前端目录树按需逐层加载（默认只展开根目录）、大目录窗口化渲染；工作区切换竞态、目录请求去重、局部刷新保留已加载子树；新增 `src/lib/fileTree.ts` |
| 3.5 样式 | 原生控件跟随主题配色 | ✅ | v2.1.0 | issue #14/PR #16：为浅色/深色主题及代码块 `data-code-theme` 补 `color-scheme` CSS 属性，使下拉框/滚动条等原生控件跟随主题（修复 Linux 上原生控件不随主题切换） |
| 3.3 工作区 | 打开文件时保留侧边栏文件树 | ✅ | v2.1.0 | issue #12/PR #17：不再用全局加载态替换文件树，改为行内 spinner/错误图标局部提示并保留文件树 DOM 与滚动位置；文件读取去重、标签页/分屏/工作区上下文竞态处理，读取失败保留编辑器并允许重试 |
| — | Release 增加 Linux amd64 构建 | ✅ | v2.1.0 | issue #13/PR #18：CI 由 `build-windows.yml` 整合为统一 `build.yml`（共享 test + build-windows + build-linux + 独立 release job），`v*` tag 同一 Release 同时发布 Windows 安装包/便携包与 amd64 AppImage + deb |
| 3.2 编辑 | 源代码模式（整页 Markdown 源码编辑） | ✅ | v2.2.0 | issue #19：`SourceModeEditor.tsx` CodeMirror 6 + GFM 高亮 + 行号；顶栏按钮 + `Ctrl/Cmd+Alt+S` 可自定义；按标签页记忆；与专注/打字机互斥；WYSIWYG 隐藏不卸载 |
| 3.2 编辑 | 源码模式查找替换 | ✅ | v2.3.0 | issue #29：`Ctrl/Cmd+F` / `Ctrl/Cmd+R` 在源码模式路由到 CM 内置查找/替换面板（`@codemirror/search`），替换框内建在面板中 |
| 3.2 编辑 | 源代码模式光标/滚动映射增强 | ✅ | v2.3.0 | issue #26：`markdownOffsetToProsePos` 按源行权重（围栏代码块内部折权、空行归零）映射到 PM 位置，`prosePosToMarkdownOffset` 增加光标行片段匹配回退 |
| 3.2 编辑 | Markdown 往返保真单测 | ✅ | v2.3.0 | issue #25：无头 Milkdown（同款 schema/remark 插件）驱动 parserCtx/serializerCtx，覆盖 callout/frontmatter/mermaid/math/toc/混合文档/GFM 基线共 9 用例；顺带发现并修复 toc 节点序列化静默丢失 `[TOC]` 的真 bug |
| 3.2 编辑 | 退出源码模式重置撤销历史 | ✅ | v2.3.0 | issue #27：re-parse 整文档替换后灌入 history 插件初始空状态，避免 Ctrl+Z 退回与当前 markdown 不一致的旧文档 |
| 3.2 编辑 | 源码模式可访问性 | ✅ | v2.3.0 | issue #28：源码编辑区补 `role="textbox"` / `aria-multiline` / `aria-label` 等 ARIA 属性 |
| 3.6 辅助写作 | 打开文件不再误判 dirty | ✅ | v2.3.0 | `markdown-publisher` 以「解析后 doc 的序列化结果」为同步基线而非原始文件内容，消除序列化规范化差异导致的误脏、关闭 tab 误弹未保存确认 |
| 3.3 工作区 | 多标签滚动/光标位置防串扰 | ✅ | v2.3.0 | issue #30/PR #35（@TomGoh）：滚动/光标位置按文件路径读写，切 tab 不再互相串扰 |
| 3.3 工作区 | 自动保存链路稳健性 | ✅ | v2.3.0 | PR #34：保存路径 flush 跳过 idle 编辑器、防抖窗口内编辑到点先 flush 落盘、异步发布绑定文件路径修复 tab 切换串写、关闭/swap 路径先 flush、dirty 状态镜像同步 |
| 3.6 辅助写作 | macOS E2E 平台按键兼容 | ✅ | v2.3.0 | issue #36/PR #37（@TomGoh）：光标到文档首/尾的 E2E 按键在 macOS 上改用 `Cmd+↑/↓` |
| — | CI 测试增加 Linux runner | ✅ | v2.3.0 | `test` job 改为 windows-latest + ubuntu-latest 矩阵，Linux 下单独 `sudo` 装 Playwright 系统依赖 |
| 3.2 其他 | Mermaid 图表视口懒渲染 | ✅ | v2.3.1 | 打开万行多图文档不再同步渲染全部图表：IntersectionObserver（300px 预载边距）延迟到进入视口才渲染，视口外保留占位容器；打开时长任务 ~7s → ~2s，滚动最长单任务 2s+ → 179ms |
| 3.2 其他 | Mermaid 空闲预渲染 | ✅ | v2.3.2 | 修复懒渲染把开销转移到滚动时的逐张卡顿：视口外图表按文档顺序排入队列，requestIdleCallback 每个空闲槽后台渲染一张，滚动停歇 250ms 内自动暂停；全文滚动 51 长任务/4.2s → 27/2.8s（90fps） |
| 3.2 其他 | Mermaid 渲染缓存 + 高度预留 + 空闲队列跳过视口上方 | ✅ | v2.3.3 | 修复大文档窗口抖动：按源码 LRU 缓存 SVG+实测高度（压测文档 60 图 8 种源码，重复图 ~150ms → ~2ms），创建即预留精确高度令后台预渲染零布局位移（CLS 0.00），空闲队列跳过视口上方图表消除滚动锚定补偿抖动 |
| 3.2 其他 | 大纲滚动采样重构（去 posAtCoords） | ✅ | v2.3.3 | 修复引用块区域滚动掉帧：v2.2 的 posAtCoords 采样在万行文档线性扫描子节点 rect 单次 55-67ms；改为缓存标题滚动坐标 + scrollTop 二分比较（120ms 节流，总高/宽度变化自动重建），滚动路径零 JS 长任务 |
| 3.2 其他 | 代码块纯文本占位 | ✅ | v2.3.4 | 修复打开大文档瞬间抖动（文件越大越久）：CodeMirror 挂载前 cmHost 为空 div（高度≈0）挂载后撑开数百 px，首屏逐块挂载连续跳变；改为挂载前用同字体/行高/max-height 的 `<pre>` 占位显示源码，挂载前后高度差≈0 |
| 3.6 辅助写作 | 切 tab 后大纲高亮自动定位 | ✅ | v2.3.4 | 修复切 tab 后大纲高亮停在顶部、需手动滚动才恢复：重灌文档后选区被钳到文档头，重算按选区推导高亮错误；改为重算完成后按恢复的 scrollTop 采样定位，防抖窗口内跳过采样避免旧文档标题集产出错误高亮 |
| 3.6 辅助写作 | 专注模式复合块高亮 | ✅ | v2.3.5 | issue #56：修复专注模式下点击列表/表格当前块不高亮——装饰目标从「最内层块」改为「文档顶层块」（`.ProseMirror` 直接子节点），与 CSS 高亮粒度一致，列表→`bullet_list`/`ordered_list`、表格→`table` 均正确点亮 |
| 3.2 其他 | 全局搜索 Rust 单测 | ✅ | v2.3.5 | issue #47：为 `search.rs` 的 `search_in_workspace` 补 10 个单测（空查询/工作区不存在/大小写/非法正则/跨文件行号与路径/隐藏目录/非 UTF-8 跳过/UTF-8 列号/元字符转义/超大文件跳过），复用既有临时目录模式 |
| 3.2 其他 | Pandoc 导出 Rust 单测 | ✅ | v2.3.5 | issue #48：`pandoc.rs` 拆「参数拼装与执行」并补 6 个单测，注入假脚本覆盖 `--resource-path` 追加/非目录忽略/pandoc 缺失/非零退出码/成功分支，无需 CI 装 pandoc |
| — | 版本号同步 | ✅ | v2.3.5 | 同步 Cargo.toml/Cargo.lock 至 2.3.5，与 package.json/tauri.conf.json 一致（此前 Cargo 滞后在 2.2.0）；CI `test` job 增加 Rust `cargo test` 步骤 |
| — | workspace store 领域拆分 | ✅ | v2.3.6 | issue #49：1025 行 `workspace.ts` 拆为 `src/store/workspace/` 下 4 个 Zustand slice——fileTree（工作区/目录树/按需加载）、tabs（标签页/保存/分屏/位置记忆）、bookmarks、recents，共享工具收进 shared.ts/types.ts，`workspace.ts` 仅保留 slice 组合导出，对外 API 不变 |
| — | 巨型组件拆分 | ✅ | v2.3.6 | issue #50：Sidebar 912→128 行（抽出 WorkspaceFileTree/FileTreeNode/TreeContextMenu/RecentFiles/Bookmarks/FileOpenStatus + useRename/useNewItem/treeShared）；Editor 741→472 行（抽出 cursor-saver/table-tracker/select-all 插件 + useSourceModeTransition + editor-root-click）；App 734→281 行（抽出 Topbar/EditorTopbar/ExportMenu/ThemeMenu/SaveIndicator + SplitPane + useGlobalShortcuts/useStartupFile） |
| — | 版本历史迁移 | ✅ | v2.3.6 | issue #51：将 README 中 42 条版本记录迁移到独立 `CHANGELOG.md`（Keep a Changelog 风格），README 精简为最近 5 个版本摘要并链接 |
| — | 架构文档 | ✅ | v2.3.6 | issue #52：新增 `ARCHITECTURE.md`，覆盖整体分层、关键模块职责、数据流与目录约定，链接 `docs/` 深度设计文档 |
| 3.3 文件与工作区 | 外部修改冲突对话框 | ✅ | v2.3.7 | 用户口头反馈（未建 issue）：本地 dirty 且磁盘被外部修改时弹冲突对话框（保留本地另存 `.backup.md` 副本 / 行级差异对比 / 丢弃修改重载 / 继续编辑），替代原 confirm 二选一，消除「取消后保存静默覆盖外部修改」的数据丢失风险 |
| — | 发版前置校验 | ✅ | v2.3.7 | CI `release-guard` job（仅 v* tag 触发）：校验 4 处版本号一致且与 tag 一致（`scripts/check-version.mjs`）+ 自上一 tag 有代码变更时文档（CHANGELOG/README/docs）至少一处更新（`scripts/check-docs-updated.mjs`），失败阻止 Release；日常提交不受影响 |
| 3.3 文件与工作区 | 保存前磁盘基线比对 | ✅ | v2.3.8 | issue #59：`OpenTab` 记录 `diskContent` 基线，Ctrl+S 保存前直读磁盘与基线比对，外部已改则弹确认（拒绝即中止），消除轮询窗口期静默覆盖外部修改；新增 `reloadFile` 强制重读磁盘（openFile 对已打开 tab 只切缓存，此前重载是假重载） |
| 3.2 编辑 | 未命名草稿贴图 | ✅ | v2.3.8 | issue #60：草稿虚拟路径（`untitled-N`）检测，跳过目录解析/写盘，图片以 Data URL 内联插入，另存后随文档自带不产生失效相对路径 |
| 3.7 设置 | 多窗口状态同步 | ✅ | v2.3.8 | issue #61：主题/偏好设置/快捷键覆盖三个 store 监听 `storage` 事件（仅其他窗口触发，无回环），一窗修改全部窗口实时同步 |
| 3.4 搜索 | 全局搜索精确定位 | ✅ | v2.3.8 | issue #62：点击结果按「本文件第 N 处匹配」定位光标（ProseMirror 块节点无换行符，按出现次序累计），正则模式先提取实际匹配文本，未命中回退块级定位 |
| 3.5 导出 | Pandoc 临时文件并发安全 | ✅ | v2.3.8 | issue #63：临时导出文件名加纳秒时间戳 + 原子自增序号，并发导出不再互相覆盖 |
| 3.1 安全 | asset 协议权限收敛 | ✅ | v2.3.8 | issue #64：静态 scope 从 `**` 收敛到用户目录，新增 Rust `allow_asset_dir` 命令按需动态放行文档所在目录（前端去重避免重复 IPC），最小权限 |
| 3.2 编辑 | 嵌套列表删块精准化 | ✅ | v2.3.8 | issue #65：多级列表子项内删块只删当前 `list_item`（父列表仅剩该项时删整个列表），不再误删顶级列表 |
| 3.5 导出 | PNG 长图导出样式对齐 | ✅ | v2.3.8 | issue #67：离屏容器复刻真实编辑器三层嵌套 `[data-theme] > .editor-scroll > .milkdown`（后代选择器全部命中），等待图片 decode/load（3s 超时），导出图与编辑器所见一致（含深色主题） |
| — | 开发文档完善 | ✅ | v2.3.8 | issue #66：CONTRIBUTING 补 Linux 系统依赖清单、Pandoc 安装指引（三平台）、本地测试命令 |
| 3.3 文件与工作区 | 外部修改热重载与多Tab状态同步 | ✅ | v2.3.9 | issue #68：`reloadFile` 支持多标签页并发安全刷新，同步更新激活状态与未保存标记 |
| 3.2 编辑 | Mermaid XSS 与富文本白名单安全 | ✅ | v2.3.9 | issue #69：`html-view.ts` 强化 XSS 过滤（拦截 script、javascript 伪协议、内联事件等），放行合法 SVG 结构 |
| 3.3 文件与工作区 | 打开失败 Loading 状态清理 | ✅ | v2.3.9 | issue #70：打开损坏或无权限文件时全面清理 loading/pending 状态，防止 UI 卡死 |
| 3.3 文件与工作区 | 保存冲突磁盘基线对齐 | ✅ | v2.3.9 | issue #71：冲突覆盖或另存后强制刷新 `diskContent` 基线，避免重复误报冲突 |
| 3.3 文件与工作区 | Windows 盘符路径标准化 | ✅ | v2.3.9 | issue #72：全链路统一 Windows 盘符大小写与斜杠（`normalizePath`），杜绝因盘符大小写不一致导致的重复打开和缓存穿透 |
| 3.2 编辑 | 编辑器渲染与分屏容器解耦 | ✅ | v2.4.0 | issue #73：提取独立 `EditorBody` 组件，降低 App 根组件渲染频次并保障分屏各自独立的生命周期 |
| 3.2 编辑 | Markdown 序列化防抖与切页 Flush | ✅ | v2.4.0 / v2.5.1 | issue #74：引入 200ms 防抖发布机制，并在 `switchTab`/`closeTab` 时主动 Flush，彻底消除大文档每键全量序列化卡顿与切页数据丢失 |
| — | 构建优化与 Rollup 分包 | ✅ | v2.4.0 | issue #75：配置 `manualChunks` 拆分 Mermaid、CodeMirror、KaTeX，主包体积下降 60%+（仅 ~197KB） |
| 3.3 文件与工作区 | 本地图片流式 Asset 缓存与 LRU | ✅ | v2.4.0 / v2.5.1 | issue #76：`resolveImageSrc` 引入 500 条容量的 LRU 缓存与动态 asset 放行机制，快速连续翻页零卡顿 |
| 3.2 编辑 | Mermaid 渲染中断令牌与命名空间修复 | ✅ | v2.4.0 / v2.5.1 | issue #77：引入 Render Counter 异步中断令牌，修复 `document.createElementNS` 矢量图形渲染与 SVG 滤镜支持 |
| 3.4 搜索 | Rust BufReader 流式搜索与排序 | ✅ | v2.4.0 / v2.5.1 | issue #78：Rust 端采用 `BufReader` 流式逐行扫描超大文件，文件列表严格排序保证 5000 条截断上限下结果确定性 |
| 3.5 样式 | 全局 Design Tokens 与排版节奏 | ✅ | v2.5.0 | issue #79/#80：统一 16px 基础网格系统与语义化变量，标题/段落/列表垂直韵律对齐，提升呼吸感 |
| 3.5 样式 | 顶部 Command Bar 与 MoreMenu 整合 | ✅ | v2.5.0 / v2.5.1 | issue #81：顶栏收窄为 44px Command Bar，低频功能统一收纳进 `···`（更多操作）菜单，去除冗余设置按钮 |
| 3.3 文件与工作区 | 文件树 Subtle Pill 选中态 | ✅ | v2.5.0 | issue #82：采用内嵌胶囊状 Subtle Pill 高亮选中态，配合 4px 安全边距与圆角，提升现代感 |
| 3.5 样式 | 统一 Modal 对话框浮层体系 | ✅ | v2.5.0 | issue #83：封装 `Modal.tsx`，统一快捷键帮助、冲突提示、偏好设置的遮罩、动效、边框与暗色适配 |
| 3.5 样式 | 响应式断点与深色模式打磨 | ✅ | v2.5.0 | issue #84：优化侧边栏与大纲在窄屏下的响应式表现，修正深色模式下滚动条与高亮对比度 |

| 3.2 编辑 | CSS 转义安全清洗与 SVG 协议白名单 | ✅ | v2.6.1 | issue #86：反转义解析 CSS Unicode/16 进制转义（unescapeCss），拦截恶意外联，SVG xlink:href 严格协议校验 |
| 3.3 文件与工作区 | 保存死锁防御与冲突安全退出 | ✅ | v2.6.1 | issue #91/#100：对话框与插件加载移入 try 块，finally 必释放 saving 锁；冲突弹窗取消或异常时安全退出拒绝静默覆盖 |
| 3.3 文件与工作区 | 自动保存指数退避与非阻塞模式 | ✅ | v2.6.1 | issue #100：自动保存失败指数退避（最高 60s），非阻塞模式遇到外部冲突静默跳过不弹窗打扰 |
| 3.3 文件与工作区 | Rust 物理落盘 (fsync) 与 Pandoc 异步化 | ✅ | v2.6.1 | issue #89：临时文件写入后强制 sync_all 物理落盘再 rename，Pandoc 命令卸载至 spawn_blocking 避免阻塞 |
| 3.1 编辑器内核 | 源码模式大纲解析与双向联动 | ✅ | v2.6.3 | 支持源码模式下大纲实时提取、阅读高亮跟随与点击定位跳转（#118） |
| 3.1 编辑器内核 | 模式切换视口与滚动位置无损还原 | ✅ | v2.6.3 | 多帧 RAF 布局沉降与精确重试，彻底解决富文本与源码模式切换时的滚动漂移（#117） |
| 3.3 文件与工作区 | 外部删除快照恢复面板 | ✅ | v2.6.2 | 在侧边栏新增误删文件快照管理与一键恢复为未命名标签页面板 |
| 3.3 文件与工作区 | Rust 强原子写盘与 Nonce 隔离 | ✅ | v2.6.2 | write_binary/text 与 pandoc 加入 PID+时间戳+原子自增 Nonce 与 fsync 强制物理落盘 |
| 3.3 文件与工作区 | 二进制 IPC 分块 Base64 传输 | ✅ | v2.6.2 | 修复大文件二进制 Uint8Array 传输导致的 JSON 膨胀与栈溢出 |
| 3.3 文件与工作区 | 毫秒级 mtime 精度与保存 Fast-Path | ✅ | v2.6.2 | Rust 与前端对齐 Unix 毫秒时间戳，保存支持 diskMtime 快速比对跳过冲突确认 |
| 3.5 样式 | 自定义 CSS 持久化与静默降级 | ✅ | v2.6.2 | customCSS 配置路径持久化保存并在启动时优雅降级 |
| 3.5 样式 | 菜单边界钳制与闪烁消除 | ✅ | v2.6.1 | issue #108：图片右键菜单接入 clampMenuPosition，useContextMenuClamping 改用 useLayoutEffect 杜绝闪烁 |
| 3.3 文件与工作区 | 严格 CSP 与 Asset 权限最小化 | ✅ | v2.6.1 | issue #111：配置严格 CSP 白名单，assetProtocol 静态 scope 收敛至应用数据目录 |
| 3.3 文件与工作区 | 路径工具标准化与 UNC 支持 | ✅ | v2.6.1 | issue #115：全工程统一收敛使用 path-utils 的 baseName 并支持 Windows UNC 路径 |
| 3.1 编辑器内核 | 查找装饰增量更新（DecorationSet.map） | ✅ | v3.0.0 | issue #192：单步事务走增量路径，旧匹配经 `tr.mapping` 平移、仅重扫变更窗口，扫描量与文档规模解耦；多步事务回退全量 |
| 3.1 编辑器内核 | Mermaid / KaTeX 按需动态加载 | ✅ | v3.0.0 | issue #168：首次遇到对应节点才 `import()`，约 3.1MB vendor 不再进入启动加载图，KaTeX 以 seq 守卫丢弃过期渲染 |
| 3.1 编辑器内核 | 慢启动监督与卸载安全读数 | ✅ | v3.0.0 | issue #172 / #174：区分「工厂抛错 / create 在途 / 异步失败」三种成因，慢启动只提示不卸载；卸载快照改用脱链安全读数 |
| 3.3 文件与工作区 | 跨盘移动与 TOCTOU 防护 | ✅ | v3.0.0 | issue #161：文件移动优先「硬链接 + 删源」原子占用目标名闭合 TOCTOU 窗口；跨卷回退递归复制，失败保留源原件 |
| 3.3 文件与工作区 | 写入回退原子重试与原件保留 | ✅ | v3.0.0 | issue #146：4 次 × 50ms 退避重试，全部失败保留原文件并报错，杜绝「先删后建」的数据丢失窗口 |
| 3.3 文件与工作区 | 读取大小护栏与结构化编码错误 | ✅ | v3.0.0 | issue #159：10MB 大小上限 + `ENCODING_UNSUPPORTED` / `FILE_TOO_LARGE` 结构化错误标记 |
| 3.3 文件与工作区 | 保存与冲突状态按标签页隔离 | ✅ | v3.0.0 | issue #148 / #149 / #164：`saving` 与退避计数下沉到 tab / 文件级，冲突解决后统一清除 `conflictPending` |
| 3.3 文件与工作区 | 全局搜索取消、并行与内存护栏 | ✅ | v3.0.0 | issue #163 / #176 / #160：代次取消在途扫描、按 CPU 分片并行、命中预览改字符级窗口防 OOM、截断可见且恰好达上限不误报 |
| 3.3 文件与工作区 | 多窗口同步与标签页一致性 | ✅ | v3.0.0 | issue #147 / #150 / #165 / #187：`storage` 事件驱动多窗口同步、另存为重复 tab 合并、激活 tab 滚入视野、单实例 open-file 定向存活窗口 |
| 3.5 样式与主题 | 键盘可操作性与 ARIA 语义补齐 | ✅ | v3.0.0 | issue #188：搜索开关 / 保存指示器 / 标签页 / 菜单 / 文件树共 5 处，附源级静态断言防视觉修复被回退 |
| 3.5 样式与主题 | 链接对话框主题与自定义配色生效 | ✅ | v3.0.0 | @TomGoh 贡献：恢复链接对话框主题样式，让自定义链接配色真正生效 |
| 3.6 辅助写作功能 | 大纲标题扫描防抖与实时刷新 | ✅ | v3.0.0 | @TomGoh 贡献：标题扫描防抖、标题变化即刷新大纲、节点身份保持稳定 |
| 3.7 图片处理 | asset scope 二次收缩与远程图 no-referrer | ✅ | v3.0.0 | issue #162：`$DATA` / `$TEMP` 收缩为应用专属目录，远程 `<img>` 加 `referrerpolicy` 防跟踪泄露 |
| 3.8 快捷键与偏好设置 | 崩溃兜底良性错误过滤 | ✅ | v3.0.0 | issue #171：ResizeObserver 噪音与空 message 不再触发整页崩溃，未捕获 rejection 只记日志不换界面 |

### 8.2 发布版本

- **v3.0.0** 主版本质量攻坚——数据安全、竞态治理、崩溃兜底、性能、安全与可访问性六大方向（#146~#192 共 33 个 issue + 7 个 PR，61 个提交 / 113 文件 +8486−722）。**三条贯穿原则**：①失败要留下完整数据（宁可报错保留原件，不做「先删后建」的赌博）；②状态按最小粒度隔离（保存 / 退避 / 冲突从工作区级下沉到标签页与文件级）；③降级只针对真失败（慢启动不等于失败，良性错误不等于崩溃）。**数据安全（Rust 侧）**：#146 写入回退改为 4 次 × 50ms 原子重试、全败保留原件，消灭「先删目标再 rename」的数据丢失窗口；#161 文件移动优先「硬链接 + 删源」原子占用目标名闭合 TOCTOU 窗口（目标已存在时 `AlreadyExists` 原子失败），跨卷回退递归复制且失败保留源原件；#159 读取加 10MB 护栏与 `ENCODING_UNSUPPORTED`/`FILE_TOO_LARGE` 结构化错误；#166/#177/#200 收敛删除快照、重命名与在途读取的竞态链（读取完成后按落定路径归属 tab，堵住幽灵 tab）。**保存与冲突**：#148 `saving` 下沉到 `OpenTab`，只拦本 tab 重入，另存为挂起期间其他 tab 不再被静默吞掉；#149 `conflictPending` 期间暂停自动保存、退避计数按文件隔离；#164 `reloadFile` 统一清除冲突态；#170 重载决策前 flush 防抖、弹窗后复核 dirty；#186 冲突对话框补层级、Esc 与焦点管理。**编辑器与查找**：#178 空替换串改走 `tr.delete` 修复 `RangeError` 崩溃；#185 面板卸载 dispatch clear 清高亮残留；#151 `replace` 移出 effect 依赖 + 装饰按引用缓存；#192 单步事务走 `DecorationSet.map` 增量路径（窗外区间 mapping 平移、仅重扫变更窗口、坍缩空区间丢弃），多步回退全量；#152 选区非空输入右符号不再被吞；#172 重构 `useEditorFallback` 区分工厂抛错 / create 在途 / 异步失败，慢启动只提示不卸载（消除卸载—重建闪烁与双倍初始化）；#173 代码块语言加载竞态守卫；#174 卸载快照改用脱链安全读数。**性能**：#176 搜索预览改命中点字符级窗口（前后 120 + 片段封顶 200 字符），内嵌 base64 长行不再整行克隆 OOM；#163 引入搜索代次实现取消、去掉逐目录 canonicalize、按 CPU 分片并行且按片序合并保确定性；#160 截断对前端可见且恰好 5000 条不误报；#168 Mermaid/KaTeX 改为首次遇到节点才动态 `import()`，约 3.1MB vendor 移出启动加载图；#153 DeletedSnapshots 健康探测改 1 字节哨兵键、刷新改事件驱动，空列表零开销。**工作台**：#165 新增 `storageSync` 为 recents/bookmarks/expandedDirs 注册 storage 事件实现多窗口同步；#167 侧边栏折叠记忆与低窗口挤压；#147 单实例 open-file 从存活窗口寻址并 unminimize+set_focus；#150 另存为到已打开路径走 tab 合并（目标有未保存内容先确认、写盘窗口期新编辑不丢弃）；#187 激活 tab 滚入视野。**稳定性与安全**：#171 新增 `crash-guard.ts`，`isBenignGlobalError` 过滤 ResizeObserver 噪音与空 message，rejection 只记日志不换崩溃页；#162 asset scope 从 `$DATA`/`$TEMP` 收缩为 `$APPDATA`/`$APPLOCALDATA`，远程图加 `referrerpolicy="no-referrer"`。**可访问性**：#188 一次补齐 5 处（搜索开关 visually-hidden、保存指示器改真实 button、标签页 tablist 语义与方向键、菜单 `useMenuA11y` 与 Esc、文件树 `aria-level`），并加源级静态断言防回退。**交互**：#158 文件树非 md 行改用 `aria-disabled` 恢复 contextmenu 可达；#184 图片右键菜单幂等清理 + 模块级单例防泄漏叠加。**社区贡献**：@TomGoh（Haoze Wu）9 个提交完成大纲扫描防抖与实时刷新、链接对话框主题与自定义配色、动态图片目录 ACL 权限，并为二进制编解码 / 桌面图片源 / PNG 导出 / 退出保存（新增 `useExitHandler.ts`）/ 工作区存储与 Rust 命令补上关键路径测试。**测试**：Vitest 115 文件 745 用例、E2E 169 用例、Rust 59 用例、`tsc` 零错误、CI 双平台全绿，每个修复均配套变异验证。已知环境限制：3 个需符号链接权限的 Rust 用例在未开 Windows 开发者模式的机器上会失败，CI 59/59 全绿。详见 `docs/v3.0.0 设计文档.md`
- **v2.8.1** 自身自动保存写盘不再被文件监听误判为外部修改（#144）：①**根因**——`useFileWatcher` 保存忽略窗只推迟检查、从不刷新 `knownMtimesRef` 基线，而 `tabs.ts` 的 `saveCurrent` 已把写盘后读回的 `savedMtime` 存进 `tab.diskMtime`，两套 mtime 记录互不通信，窗口一过轮询必然对比出新旧差异；②**三道防线**——A 主修（store 订阅保存事件时把 `tab.diskMtime` 主动登记为 watcher 基线）、B 兜底（轮询中 mtime 与 `tab.diskMtime` 在 5ms 容差内判定为自家写盘，静默登记基线，覆盖后台 tab 保存时 store 级 `lastSavedAt` 未变化的竞态）、C 语义修正（忽略窗内不再整体跳过检查，改为刷新基线但跳过弹窗，使窗口一过不补误报且窗内删除检测不再被跳过）；③新增 `tests/unit/file-watcher-save-mtime.test.tsx`（5 例 + 2 回归），全套 82 单测文件（542 用例）/ Build / 27 Rust 全绿。详见 `docs/v2.8.1 设计文档.md`
- **v2.8.0** 富文本↔源码切换的阅读位置与光标统一保持方案（#136）：①**内容锚点映射**替代比例映射——进入方向采集视口顶部块内容锚点（code_block 吸附，规避代码块解析浮动漂移），退出方向 `resolveAnchorProsePos` 用锚点行纯文本在 PM doc 精确定位（重复行取权重最近处 + 二分、最多 8 条候选行兜底）；②**稳定性机制**——单一写者原则（`useCursorStateRestore` 翻转帧跳过恢复消除双写竞态）、settle 收敛循环（处理 CM 首帧高度估算）、滚动热路径 rAF 合帧 + flush（评审 B1）；③**附带修复**——源码模式 CM 补 `defaultKeymap` 标准导航键、更多菜单文案统一为「禅模式」；④**评审 N1~N8** 全部落地（真实路径单测注入、注释修正、`markdownNormLine` 去重、fixture 迁移、tsconfig 恢复 E2E 类型门禁、`waitScrollConverged` 轮询替固定 sleep、冲突检测对默认值放行）；⑤修掉来源为 remount 异步滚动恢复竞态的回归 E2E 锚点漂移 flaky。全套 81 个单测文件（537 用例）与 161 个 E2E、27 个 Rust 用例 Build 100% 通过，E2E 零 flaky。详见 `docs/v2.8.0 设计文档.md`
- **v2.7.0** 多领域可靠性、交互体验与数据安全批量修复（#121~#134）：①模式切换视口与滚动比例映射还原（#121）与 Ctrl+K 应用内插入链接对话框（#122）；②数据安全防线——删除快照配额告警与写入失败用户可见提示（#123）、外部文件修改盲区与 switchTab 重载/冲突（#124）、清空删除快照二次确认（#129）、自动保存冲突状态呈现（#132）；③工程体验——快捷键冲突黑名单补全（#125）、全局搜索异步竞态守卫（#126）、源码模式导出 Word 解绑（#127）、全部替换提示非阻塞化（#128）、设置面板 Esc 关闭（#130）、图片插入异常反馈与草稿大图护栏（#131/#134）；④测试——重写多窗口 Storage 同步真实断言（#133）。全套 79 个单测文件（518 用例）与 154 个 E2E、27 个 Rust 用例 Build 100% 通过。详见 `docs/v2.7.0 设计文档.md`
- **v2.6.3** 源码模式大纲联动与模式切换滚动精确同步修复（#117, #118）：①修复 #117 模式切换滚动位置漂移与视口丢失——在富文本与源码模式双向切换链路中引入连续 RAF 布局沉降检测与渐进重试机制，待 DOM 排版与高度完全稳定后精确还原 `scrollTop` 与光标选择区；②实现 #118 源码模式大纲点击跳转与阅读定位联动——重构纯 Markdown 大纲解析器 `extractMarkdownOutline`（过滤 YAML Front Matter 与围栏代码块内部伪标题，具备 100 行异常中断防御），基于 CodeMirror 滚动通道实现点击大纲平滑居中滚动与光标定位，并在源码滚动与选区更新时实时高亮大纲对应阅读层级；③测试与质量——新增 2 个源码模式导航与大纲追踪单元测试套件，扩充 Playwright 端到端测试用例，全套测试与类型检查 100% 通过。详见 `docs/v2.6.3 设计文档.md`
- **v2.6.2** 评审遗留深度加固、数据可靠性与工程质量修复：①P0 级别写盘与数据恢复防线：Rust 端底层原子写盘（`write_binary_file`/`write_text_file`/`pandoc`）采用 `PID + 时间戳 + AtomicU64` 生成全局唯一临时文件，并在 `rename` 前调用 `file.sync_all()` 强制物理刷盘；前端重构二进制 IPC，采用 32KB 分块 Base64 编解码，彻底杜绝大文件 JSON 膨胀与调用栈溢出；侧边栏新增外部删除文件快照恢复面板（`DeletedSnapshots.tsx`），支持误删内容一键无损还原为未命名标签页。②P1 级别稳定性与精度对齐：Rust `file_mtime` 升级对齐为 Unix 毫秒时间戳，FileWatcher 容差过滤收紧至 `< 5ms`；`saveCurrent` 引入 `diskMtime` 内存比对 Fast-Path，消除无外部篡改时的冗余冲突弹窗；自定义 CSS 路径持久化并在启动初始化时静默容错；`tsconfig.json` 覆盖全部测试目录并修复全量测试代码类型报错。③P2 级别规范与体验收敛：统一前后端搜索忽略列表并引入 `MAX_SEARCH_DEPTH = 64` 防递归溢出；封装统一原生对话框模块（`src/lib/dialogs.ts`），全面替代项目内散落的 `window.confirm` 与 `alert`。详见 `docs/v2.6.2 设计文档.md`
- **v2.6.1** 架构加固、缺陷修复与测试质量重构：①P0 缺陷彻底修复：解决 #91 保存死锁漏洞，修复 #100/#91 冲突弹窗取消吞咽覆盖风险，修复 #86 CSS 16进制转义注入与 SVG 协议检查，配置 #111 严格 CSP 策略并收紧 asset scope，按需动态导入 mockFs 隔离生产包；②P1 稳定性与性能优化：实现 #100 自动保存失败指数退避与非阻塞模式，#89 Rust 原子写盘物理落盘（`file.sync_all()`）与 Pandoc 异步化（`spawn_blocking`），#92 跨 Tab saveError 状态隔离，#93 删除未保存文件内存快照保护，#98 修复 fileRequests 重命名泄漏，#96 useFileWatcher 监听容差精度提升至毫秒级，#97 Store 校验与死 mock 清理，#108 图片菜单边界防溢出与 `useLayoutEffect` 消除闪烁；③P2 工程与规范：全量收敛 `baseName` 至 `path-utils` 兼容 UNC 路径，补充主题同步存储说明，重写真实测试套件（并发保存、斜杠菜单、Diff 算法、HTML 安全转义、跨 Tab 隔离、导出 Flush）。详见 `docs/v2.6.1 设计文档.md`
- **v2.6.0** 32 项 GitHub Issues 全面攻坚与架构安全性能加固（#85 ~ #116）：①数据安全（#85/#89/#91/#92/#93/#100/#102）：Rust 端实现原子写盘（`write_text_file` 临时文件 + 原子替换）与大目录异步非阻塞 I/O，前端保存增加 `saving` 防重入与快照隔离；②交互与编辑（#94/#95/#98/#99/#103）：导出与复制操作前全量 flush 发布器，斜杠菜单 Esc 范围精准删除，重命名原子化迁移，菜单边缘防溢出钳制；③安全防御（#86/#87/#96/#111）：收紧 DOM-based Sanitizer 白名单过滤 style 块与外联 CSS，全局安全重载与异常捕获，动态放行 asset 范围；④架构与规范（#105/#106-#116）：$O(N)$ 空间优化 LCS diff，通用 `loadJSON`/`writeJSON` 与统一 `path-utils` 模块；⑤全量测试套件扩充至 470 个单元/集成测试与 152 个 E2E 测试全部 100% 通过。详见 `docs/v2.6.0 设计文档.md`
- **v2.5.8** 全链路测试场景深度补齐与防护网加固：①补齐 Rust 后端底层文件原子写入边界与异常回退（`save_file_atomic` 父目录不存在自动递归创建）、目录安全扫描与 `search.rs` 超大文件跳过/结果上限截断集成测试；②补齐前端扩展插件与核心状态机单元测试（`footnotes.ts` 双向跳转定位、`formula-numbering.ts` 公式动态重编与清除、`workspace/bookmarks.ts` 与 `workspace/recents.ts` LRU 淘汰与持久化、`useAutoSave` 防抖写盘与草稿跳过、`useStartupFile` 参数启动与单实例唤醒、`useCtrlWheelZoom` 滚轮缩放限制）；③补齐 Playwright 端到端深度场景测试（Tab 鼠标中键关闭与拖拽重排、Tab 右键完整菜单、外部文件变动冲突对话框 Diff/重载/保留全分支、分屏双栏独立渲染、禅模式全屏与段落专注模式样式生效）；全套 26 个 Rust 测试 + 52 个前端单测文件（450 用例）+ 152 个 E2E 测试全部通过。详见 `docs/v2.5.8 设计文档.md`
- **v2.5.7** 修复 Tauri 2 窗口销毁 ACL 权限报错：为 `src-tauri/capabilities/default.json` 补齐 `core:window:allow-destroy` 与 `core:window:allow-close` 权限，消除退出时的全局 ErrorBoundary 报错弹窗，新增 ACL 防回归单测。详见 `docs/v2.5.7 设计文档.md`
- **v2.5.6** 退出体验与测试强化（活跃标签页还原 / 批量保存单测防护）：①`App.tsx` 记录退出前初始 `activeTabPath`，若用户取消退出留在应用中，自动还原切回初始标签页，保持多文件编辑上下文连贯；②新增 `tests/unit/exit-save.test.ts`，为多 Tab 状态下的退出遍历保存、dirty 清理与标签页还原逻辑提供可靠单元测试保障。详见 `docs/v2.5.6 设计文档.md`
- **v2.5.5** 深度闭环加固（DOMParser 安全解析 / 全量 Dirty Tab 退出落盘 / Fail-Safe 容错与 Pan 平移重置）：①Mermaid SVG 清洗器采用 `new DOMParser().parseFromString(..., "text/html")` 进行惰性安全解析 + `document.importNode` 导入，消除 `innerHTML` 活跃解析期执行窗口，杜绝注释与实现矛盾并保持 `foreignObject` 原生 HTML 兼容；②`App.tsx` 窗口关闭拦截真正遍历所有处于 `dirty` 状态的 Tab 并逐项执行保存，避免后台 dirty tab 静默丢失；③`ask()` 异常时采用 fail-safe（中止退出）策略；④Mermaid 图表重渲染时重置 `panX = 0, panY = 0` 避免偏移出视口，并保留用户当前 `zoom` 缩放倍数。详见 `docs/v2.5.5 设计文档.md`
- **v2.5.4** Review 深度闭环与硬约束加固（R1~R3 / 退出多Tab落盘 / SMIL与单测硬化）：①修复 Mermaid 空闲预渲染守卫（`firstRenderDone || !container.isConnected || container.offsetParent === null`），防止脱落节点渲染与高度 0 污染缓存；②修复首渲染占位高度覆盖顺序，先读 `estimateRenderHeight` 确保 `Math.max(height, reserved)` 真实生效防缩；③恢复 `DOMParser` 解析 `image/svg+xml`，杜绝 `innerHTML` 解析期 XSS 执行窗口；④`App.tsx` 窗口关闭拦截按序落盘所有 dirty 的 Tab，取消保存/失败时弹窗确认，避免数据丢失；⑤补充 `<set>` 标签 `attributeName` 过滤，强化 SMIL 安全；⑥`imageSrcCache.test.ts` 补齐旧项刷新 LRU 顺序免淘汰真实测试。详见 `docs/v2.5.4 设计文档.md`
- **v2.5.3** 深度 Review 缺陷彻底修复与安全/测试硬化（H3/H2/M4/Hardening）：①`App.tsx` 使用 `@tauri-apps/api/window` 的 `onCloseRequested` 拦截原生窗口关闭，同步执行 `flushAllMarkdownPublishers()` 并异步 `await saveCurrent()` 真正写回磁盘后退出，根除最后 150ms 编辑丢失隐患；②`saveCurrent` 执行体首行增加 `flushAllMarkdownPublishers()`，确保入口快照与磁盘写入始终为最新内容；③重写 `imageSrcCache.test.ts`，打桩调用计数器真实验证 500 容量淘汰与 LRU 顺序调整；④消除 `renderMermaidWithSeq` 孪生实现，`NodeView.render()` 与单测统一复用核心渲染与中断机制；⑤强化 SVG 清洗器防御，拦截 SMIL `<animate attributeName="onload/on*">` 注入。详见 `docs/v2.5.3 设计文档.md`
- **v2.5.2** 深度 Code Review 缺陷修复与安全防线加固（H1~H3 / M1~M4）：①加固 Mermaid SVG 清洗器防线——剥离属性值中 `\t`/`\n`/`\r` 控制字符，拦截 `javascript:`/`vbscript:`/`data:(?!image/)` 及嵌套 `iframe/embed/object/form/base` 标签；②`saveCurrent` 异步读盘与弹窗期间采用最小 Patch 机制更新 store，防止分屏并发发布或新输入被陈旧快照静默回退；③应用窗口 `beforeunload` 时同步 Flush 待发布变更；④Store 层全标签页操作（`switchTab`/`closeTab`/`closeOthers`/`closeToRight`/`closeAll`/`newTab`/`splitSwap`）统一收口 Flush 契约；⑤优化源码模式下 Mermaid 空闲预渲染（`offsetParent === null` 时直接跳过避免计算与高度 0 污染）；⑥重构单测套件，移除伪测试并补齐真实的 SVG 命名空间、控制字符 XSS 绕过与异步竞争中断验证。详见 `docs/v2.5.2 设计文档.md`
- **v2.5.1** 专项缺陷修复与体验完善（Review 意见闭环）：①修复 Mermaid 矢量图表渲染失效——在 HTML/SVG 白名单清洗中正确使用 `document.createElementNS("http://www.w3.org/2000/svg", tag)`，并补充 `linearGradient`/`radialGradient`/`filter` 等 SVG 标签与属性大小写支持；②移除顶栏冗余的设置直达按钮，全面统一收纳至 `···` 更多操作菜单与 `Ctrl+,` 快捷键，同步解耦 E2E 自动化测试定位器；③修复防抖序列化状态丢失风险——在 `switchTab` 与 `closeTab` 关键路径前主动执行 `flushAllMarkdownPublishers()`；④优化本地图片缓存 LRU 淘汰策略——`get` 命中时重新置入末尾；⑤Rust 工作区全局搜索确定性排序——文件列表执行 `files.sort()` 保证多端与 5000 条截断上限下的绝对确定性。详见 `docs/v2.5.1 设计文档.md`
- **v2.5.0** 落地 UI/UX 全面重构（#79-#84）：①统一 Design Tokens 语义化变量（颜色、圆角、阴影、层级）；②重塑排版垂直节奏，正文/标题间距系统化；③顶栏升级为 44px 紧凑 Command Bar，新增 `···` 更多操作收纳浮层；④文件树 Subtle Pill 内嵌胶囊选中态与安全边距；⑤统一 Modal 浮层遮罩规范；⑥响应式断点与深色模式细节打磨。详见 `docs/v2.5.0 设计文档.md`
- **v2.4.0** 架构拆分与性能专项攻坚（#73-#78）：①拆分独立 `EditorBody` 降低 App 根组件渲染负担；②Markdown 序列化 200ms 防抖发布，打字零卡顿；③Vite manualChunks 分包（Mermaid、CodeMirror、KaTeX），主包体积下降 60%+；④本地图片流式 Asset 缓存与动态放行；⑤Mermaid 渲染中断 Cancellation Token；⑥Rust 流式逐行扫描工作区搜索。详见 `docs/v2.4.0 设计文档.md`
- **v2.3.9** 批量修复稳定性与安全问题（#68-#72）：①`reloadFile` 多标签页并发安全刷新与未保存标记同步；②`html-view.ts` 强化 XSS 过滤与白名单；③打开失败时全面清理 loading/pending 状态；④保存冲突覆盖后强制同步 `diskContent` 磁盘基线；⑤跨平台 Windows 盘符与斜杠标准化（`normalizePath`）。详见 `docs/v2.3.9 设计文档.md`

- **v2.3.8** 批量修复 issue #59-#67：①#59 保存前磁盘基线比对——`OpenTab` 记录 `diskContent` 基线，Ctrl+S 前直读磁盘比对，外部已改弹确认（拒绝即中止），消除 3 秒轮询窗口期静默覆盖；新增 `reloadFile` 强制重读磁盘（openFile 对已打开 tab 只切缓存，此前冲突对话框/watcher 的重载是假重载）。②#60 未命名草稿贴图——检测 `untitled-N` 虚拟路径，跳过目录解析/写盘，Data URL 内联插入。③#61 多窗口同步——主题/偏好/快捷键三 store 监听 `storage` 事件实时同步。④#62 全局搜索定位——按本文件第 N 处匹配定位光标（正则先提取实际匹配文本），不再总跳第一处。⑤#63 Pandoc 临时文件加纳秒时间戳 + 原子序号防并发覆盖。⑥#64 asset 协议收敛——静态 scope 从 `**` 收敛到用户目录，Rust `allow_asset_dir` 按需动态放行文档目录，最小权限。⑦#65 嵌套列表删块只删当前 `list_item`（单元素列表删整列表），不再误删顶级列表。⑧#66 CONTRIBUTING 补 Linux 系统依赖/Pandoc 安装/测试命令。⑨#67 PNG 导出离屏容器复刻真实编辑器三层嵌套（`[data-theme] > .editor-scroll > .milkdown`，后代选择器全部命中）+ 等待图片 decode/load（3s 超时），导出图与编辑器所见一致。新增 13 个前端单测 + 1 个 Rust 单测，全套 411 测试通过。详见 `docs/v2.3.8 设计文档.md`
- **v2.3.7** 外部文件变动冲突对话框 + 发版前置校验：①用户口头反馈（未建 issue）排查确认原实现「静默重载丢失内容」不成立（dirty 时有 confirm 明确提示丢弃），但「忽略外部变动后保存会静默覆盖磁盘修改、无备份无 diff」成立——升级为冲突对话框四选项：保留本地另存副本（`*.backup.md` 自动递增编号，存后重载磁盘）、行级差异对比（自研 LCS diff：公共前后缀修剪 + 超 4000 行降级整块替换，unified 视图区分「本地未保存/磁盘外部修改」）、丢弃本地修改重载、继续编辑（明示覆盖风险）；非 dirty 保持 confirm。新增 `src/lib/diff.ts`、`src/store/conflict.ts`、`src/components/FileConflict/`，22 个新单测（diff 14 + 组件 8），全套 398 测试通过。②CI 新增 `release-guard` job（仅 v* tag 触发，日常提交不受影响）：`scripts/check-version.mjs` 校验 4 处版本号一致且与 tag 一致，`scripts/check-docs-updated.mjs` 校验自上一 tag 有代码变更时 CHANGELOG/README/docs 至少一处更新，失败阻止 Release。详见 `docs/v2.3.7 设计文档.md`
- **v2.3.5** 专注模式复合块高亮修复 + Rust 命令单测补全 + 版本号同步：①issue #56 修复专注模式下点击列表/表格当前块不高亮——`editor-modes.ts` 装饰原先取光标所在「最内层块」（`findParentNodeClosestToPos(n => n.isBlock)`），列表（`bullet_list > list_item > paragraph`）/表格（`table > table_row > table_cell > paragraph`）内命中内部 paragraph，而 `App.css` 只高亮 `.ProseMirror` 直接子节点（`.focus-mode .ProseMirror > *` 弱化、`.focus-mode .ProseMirror > .inkling-focused` 高亮），装饰粒度与 CSS 粒度不一致导致列表/表格停在弱化态点不亮；改为取「文档顶层块」（`$head.node(1)`，即 `.ProseMirror` 直接子节点），与 CSS 高亮粒度对齐，列表→`bullet_list`/`ordered_list`、表格→`table` 均正确点亮，新增 `tests/unit/editor-modes.test.ts` 5 用例；②issue #47 为 `search.rs` 全局搜索补 10 个单测（空查询/工作区不存在/大小写切换/非法正则/跨文件行号与路径/隐藏目录跳过/非 UTF-8 静默跳过/UTF-8 列号计数/纯文本转义/超大文件跳过），复用 `mod.rs` 临时目录模式；③issue #48 为 `pandoc.rs` 补单测并做「参数拼装与执行分离」重构（`build_pandoc_command`/`build_pandoc_locate_command`/`run_pandoc`），注入假脚本覆盖 `--resource-path` 追加/非目录忽略/pandoc 缺失/非零退出码/成功 6 分支，无需 CI 装 pandoc；④CI `test` job 增加 Rust `cargo test` 步骤（双平台矩阵）；⑤同步 Cargo.toml/Cargo.lock/tauri.conf.json/package.json 版本号至 2.3.5（此前 Cargo 滞后在 2.2.0）。前端 376 单测 + `tsc --noEmit` 全绿。详见 `docs/v2.3.5 设计文档.md`
- **v2.3.4** 打开瞬间抖动根治 + 切 tab 大纲定位修复：v2.3.3 后用户实测仍有两个问题——①打开文件瞬间抖动一下且文件越大抖动越久；②切 tab 后大纲高亮停在顶部，需手动滑动文档一下才恢复。问题①根因是打开路径上三个"渐进改变高度"环节都在首帧绘制后发生、浏览器滚动锚定逐次补偿：代码块懒挂载前 `cmHost` 为空 div（高度≈0，挂载 CodeMirror 后撑开数百 px，首屏短代码块越多跳得越久，主因）；Mermaid 未缓存首渲染从粗估占位高度跳到实测高度并强制收缩 min-height；滚动位置恢复被未撑开的 scrollHeight 钳制且 rAF 仅重试一次。修复：①代码块挂载前在 cmHost 内放与 CodeMirror 基础主题同字体（等宽族）/行高 1.5/字号 0.85rem/上下 padding 0.4rem/max-height 32rem/不折行的 `<pre class="code-block-placeholder">` 纯文本占位，挂载前后高度差接近 0（附带挂载前即可见代码内容），视口外内容变更同步占位文本；②Mermaid 首渲染 min-height 取 max(粗估占位, 实测) 只增不减，实测偏矮时注入零布局跳变，编辑重渲染仍用实测；③位置记忆恢复 scrollTop 改为逐帧重试直到到位（30 帧上限，占位修复后通常 1-2 帧收敛）。问题②为 v2.3.3 采样重构引入：切 tab 重灌文档（replaceWith 整文档替换）后选区被 ProseMirror 钳到文档头，大纲重算回调按选区推导高亮跳回顶部，且 scrollTop 已恢复到位无新 scroll 事件触发采样。修复：重算完成后按当前 scrollTop 采样定位（阅读位置才是大纲高亮语义），防抖窗口（150ms）内标记 stale 跳过滚动采样与选区推导（避免旧文档标题集/位置缓存产出错误高亮闪现），插件创建后追加 rAF 初始采样兜底 scrollTop=0 场景。实测（1.8 万行/398KB 压测文档，缓存冷启动）：打开全程编辑器零布局位移（layout-shift 仅 4 次且全部来自文件树虚拟滚动）、scrollTop 零漂移，scrollHeight 初始 381,884px 与最终 384,451px 偏差 0.67%，仅有的 2 次增高均在视口外；滚至中部（scrollTop=150,000，高亮第 109 项）→ 切到 intro.md → 切回，scrollTop 与大纲高亮均自动恢复正确定位，无需任何滚动。全套单元/组件测试 370 passed（outline-tracker 新增切 tab 用例）。详见 `docs/v2.3.4 设计文档.md`
- **v2.3.3** 大文档窗口抖动 + 引用块滚动掉帧根治：用户实测 v2.3.2 反馈打开大文件后窗口一直抖动、引用块区域滚动仍明显掉帧（v2.1.0 丝滑）。两个独立根因：①视口上方的图表后台预渲染后变高，浏览器滚动锚定为稳定可见内容反复补偿 scrollTop，逐张渲染令跳动持续数秒（抖动）；且压测文档 60 张图表仅 8 种源码，重复图表每张仍 ~150ms 全量渲染，形成打开后 ~9s 预渲染风暴与滚轮操作撞车（掉帧）。②v2.2.0 大纲自动跟随引入的滚动 `posAtCoords` 采样在 ProseMirror 内部需线性扫描文档级子节点 rect（万行文档 ~1.8 万个块级子节点），引用块深层嵌套区域单次采样 55-67ms（PerformanceObserver 实测 6 个长任务、周期 183ms 恰为 120ms 节流 + 60ms 采样耗时；静置 0 长任务排除定时器；v2.1.0 无大纲面板故无此开销）。修复：①`mermaid-view.ts` 按源码 LRU 缓存（上限 32 条）SVG + 实测渲染高度——重复图表命中缓存仅 ~2ms DOM 注入；NodeView 创建时即按缓存高度预留 min-height，占位→渲染高度跳变为 0，后台预渲染不再引起布局位移；空闲队列任务执行时跳过整体位于视口上方（rect.bottom < 0）的图表，交给视口路径滚回时渲染（缓存命中即时），上方布局不再变化、锚定补偿消失。②`outline-tracker.ts` 滚动采样重构——`nodeDOM(heading.pos)` 批量缓存标题元素在滚动坐标系中的位置（同帧批量读取仅一次布局），采样退化为 scrollTop 与缓存数组的二分比较（微秒级）+ 120ms 节流 + 尾随采样，彻底移除 posAtCoords；缓存随文档变更防抖重建，采样时检测滚动总高/宽度变化（图表渲染、窗口缩放、布局列切换）自动重建。实测（1.8 万行/398KB/60 图表/371 引用块压测文档，生产构建）：预渲染 60 张 ~9s → ≤5s（8 次真实渲染 + 52 次缓存命中），打开至预渲染完成 scrollHeight 全程稳定 347,115px（CLS 0.00、静置 scrollTop 零漂移）；引用块密集区滚动（200k→225k px，80px/帧）94fps/15 帧 >34ms/6 个 55-67ms 长任务 → 105fps/2 帧 >34ms/0 长任务（p95 35→25ms）；向上滚动（346k→303k px，120px/帧）119fps/0 帧 >34ms/p95 11ms；大纲高亮按位置正确更新。全套单元/组件测试 369 passed（mermaid-render 新增缓存回归用例、outline-tracker 按 v2.3.3 契约重写）。详见 `docs/v2.3.3 设计文档.md`
- **v2.3.2** 万行多图文档滚动掉帧修复：用户实测 v2.3.1 反馈打开已明显改善，但滚轮滚动仍掉帧，体感与 v2.2 相当、远不如 v2.1。Chrome DevTools trace 定位：滚动期强制回流大头全是 Mermaid 渲染内部（addHtmlSpan 933ms、sequenceDiagram drawText 257ms、insertEdge 150ms 等）——v2.3.1 的视口懒渲染把渲染开销从"打开时"转移到"滚动时"，滚到未渲染图表处逐张 ~150ms 卡顿；而 v2.1.0 打开时同步全量渲染（冻结 ~10s）后滚动反而全程顺滑。纯文本区滚动实测 0 长任务、getBoundingClientRect 仅 ~2 次/帧，证明 outline 自动跟随（v2.2 引入的滚动 posAtCoords 采样）与 cursor-saver（v2.3.0 引入的滚动落盘）开销均可忽略，非元凶。修复：`mermaid-view.ts` 新增空闲预渲染队列——打开文档后视口外图表按创建（文档）顺序排入模块级队列，`requestIdleCallback` 每个空闲槽渲染一张（每张 ~150ms 超出单帧预算，逐张让出主线程），document 级捕获滚动监听 + 停歇 250ms 内暂停预渲染避免与滚动争抢主线程，滚得快落在未预渲染图表时仍由视口即时渲染兜底，容器销毁（切文档）后队列任务自动跳过。实测：打开时长任务保持 ~1.9s 不变；打开后静止 16s 视口外图表 59/60 张后台渲染完成；全文滚动（0→末尾 3000px/350ms）长任务 51 个/4195ms → 27 个/2780ms（平均 90fps，剩余长任务为 170 个代码块 CodeMirror 懒挂载，v2.1.0 同样存在非回归）；快速滚动多图区仅 1 个长任务/50ms。全套单元/组件测试 367 passed。详见 `docs/v2.3.2 设计文档.md`
- **v2.3.1** 万行多图文档打开卡顿修复：用户对比 v2.1.0 反馈打开万行复杂文档（60 张 Mermaid 图 + 170 代码块 + 455 行内公式，398KB，约 1.8 万行）明显更卡。经 git worktree 双版本基准（核心引擎 parse ~750ms / serialize ~200ms 无差异）+ Chrome DevTools 长任务剖析定位：打字路径 v2.3.0 反而更优（publisher 防抖后 1 个 220ms 长任务 vs v2.1.0 的 68 个共 5.2s），真正瓶颈是 Mermaid 图表打开即同步渲染全部图表——每张 ~150ms 阻塞主线程，60 张合计 ~9s 长任务、期间滚动/输入全程冻结；此问题两版本共有，v2.3.0 因 publisher 基线序列化等叠加冻结窗口更长故体感更差。修复：`mermaid-view.ts` 图表改为 IntersectionObserver 视口懒渲染（300px 预载边距），视口外仅保留占位容器（与 v1.2.0 代码块懒挂载同模式），`update` 在进入视口前跳过渲染、`destroy` 断开观察；`mermaid-render/pan` 单测补 happy-dom 下 IO stub（`observe` 即进入视口，保持创建即渲染契约）。实测：打开时长任务 6.5~7.4s（49~51 个）→ 1.9s（4 个），打开时预渲染图表 60/60 → 0/60，全文滚动最长单任务 2s+ → 179ms，视口内图表正常渲染（滚动到位置即出图）。全套单元/组件测试 367 + E2E 138 passed。详见 `docs/v2.3.1 设计文档.md`
- **v2.3.0** 性能回退修复 + 源码模式增强 + 保存链路稳健性 + 社区修复：①issue #31 修复万行文档编辑/滚动掉帧（v2.2.0 性能回退，`markdown-publisher` 保存路径 flush 跳过 idle 编辑器，避免对每个挂载编辑器重复全文序列化）；②issue #29 源码模式查找替换——`Ctrl/Cmd+F` / `Ctrl/Cmd+R` 在源码模式路由到 CM 内置查找/替换面板（`@codemirror/search`，替换框内建在面板中），替代原先「提示退出源码模式」的 alert；③issue #26 光标/滚动映射增强——`markdownOffsetToProsePos` 按源行权重（围栏代码块内部行折权、空行归零）映射 PM 位置，`prosePosToMarkdownOffset` 增加光标行片段匹配回退；④issue #27 退出源码模式重置 PM 撤销历史——re-parse 整文档替换后灌入 history 插件初始空状态，避免 Ctrl+Z 退回与当前 markdown 不一致的旧文档；⑤issue #28 源码模式可访问性——`role="textbox"` / `aria-multiline` / `aria-label` 等 ARIA 属性；⑥打开文件不再误判 dirty——publisher 以「解析后 doc 的序列化结果」为同步基线，消除规范化差异导致的误脏、关闭 tab 误弹未保存确认；⑦issue #25 Markdown 往返保真单测——无头 Milkdown 驱动真实 parser/serializer 覆盖 callout/frontmatter/mermaid/math/toc 等自定义块，并据此修复 toc 节点序列化静默丢失 `[TOC]` 的真 bug；⑧PR #34 保存链路——异步发布绑定文件路径修复 tab 切换串写、防抖窗口内编辑到点先 flush 落盘、手动保存/关闭/swap 路径先 flush、dirty 状态镜像同步；⑨issue #30/PR #35（@TomGoh）多标签滚动/光标位置按文件路径读写防串扰；⑩issue #36/PR #37（@TomGoh）macOS E2E 平台按键兼容；⑪CI `test` job 改为 windows-latest + ubuntu-latest 矩阵，Linux 下单独 `sudo` 装 Playwright 系统依赖。单元/组件测试 367 + E2E 138 passed。详见 `docs/v2.3.0 设计文档.md`
- **v2.2.0** 新增源代码模式（issue #19）：整页切换为 CodeMirror 6 编辑原始 Markdown（GFM 语法高亮 + 行号，主题/缩放与 WYSIWYG 一致）；顶栏 `</>` 按钮 + 默认 `Ctrl/Cmd+Alt+S` 快捷键（可在快捷键面板自定义）；按标签页独立记忆模式；进入时自动关闭专注/打字机模式；退出时 re-parse 回 ProseMirror；分屏面板独立切换；富文本导出/查找替换在源码模式下提示退出后再用。新增 `SourceModeEditor.tsx`、`codemirror-shared.ts`、`source-mode-cursor.ts` 及 E2E/单元测试。详见 `docs/v2.2.0 设计文档.md`
- **v2.1.0** 合并社区贡献者 @TomGoh 的三项工作区/主题修复并新增 Linux 发行版：①issue #11/PR #15 大型工作区按需加载与文件树渲染——Rust `list_dir` 改为单层浅扫并迁入 `spawn_blocking` 线程池避免阻塞 Tauri 异步运行时，跳过隐藏项/依赖构建目录/目录符号链接，前端按需逐层加载 + 大目录窗口化渲染 + 工作区切换竞态/目录请求去重/局部刷新保留已加载子树，新增 `src/lib/fileTree.ts`；②issue #14/PR #16 同步原生控件与主题配色——为浅色/深色主题及代码块 `data-code-theme` 补 `color-scheme`，使原生控件跟随主题（修复 Linux 上原生控件不随主题切换）；③issue #12/PR #17 打开文件时保留侧边栏文件树——行内 spinner/错误图标局部提示并保留 DOM 与滚动位置，文件读取去重、标签页/分屏/工作区上下文竞态处理、读取失败保留编辑器可重试；④issue #13/PR #18 Release 增加 Linux amd64 构建——CI 整合为统一 `build.yml`（共享 test + build-windows + build-linux + 独立 release job），`v*` tag 同一 Release 同时发布 Windows 安装包/便携包与 amd64 AppImage + deb。单元/组件测试 299 passed。详见 `docs/v2.1.0 设计文档.md`
- **v2.0.2** 补全 E2E 测试覆盖并修复测试驱动发现的三个生产 bug：①`auto-pair.ts` 无选区配对补全崩溃（`view.state.doc.resolve` 应为 `tr.doc.resolve`，Selection 指向旧文档触发 `RangeError`，输入任意括号即白屏）；②`callout.ts` 解析器不兼容 Obsidian 常见写法 `> [!NOTE]\n> 内容`（正则 `^\[!(\w+)\]$` 要求首段完全等于 `[!TYPE]`，改为 `^\[!(\w+)\]` 开头即匹配，后续文本作为内容保留）；③`frontmatter.ts` NodeView 漏设 `data-value` 属性。新增 8 个 E2E 测试文件 67 个用例（auto-pair/callout/editor-modes/frontmatter/link-follow/math/shortcuts-customize/toc），修复 4 个既有 flaky 测试，`fs.ts` mock 增强。全套 262 单元 + 127 E2E 测试通过。详见 `docs/v2.0.2 设计文档.md`
- **v2.0.1** 修复 Mermaid 流程图多行节点文字底部被边框裁切：渲染含 `<br/>` 多行 + 长中文文本 + `style stroke-width:2px` 加粗边框的纵向流程图时，多个矩形节点文字下沉、最后一行被 rect 底边遮挡，单行菱形判断框正常。根因为三因素叠加——①`:root line-height:1.6` 被 CSS 继承进 mermaid `nodeLabel`，使实际渲染行高 ≈ mermaid 测量行高（~1.2）的 1.33 倍，多行文字溢出底边；②`flowchart.useMaxWidth` 默认 true，长文本回流触发高度重算偏差；③`stroke-width:2px` 加粗边框向内侵占内部高度。修复：①`mermaid-view.ts` 提取 `MERMAID_CONFIG` 常量，补 `flowchart.htmlLabels:true`（保留 `<br/>` 换行）、`padding:20`（默认 15，加大内边距补偿）、`useMaxWidth:false`（关闭宽度回流）、`themeVariables.fontSize:"14px"`（锁定字号）；②`App.css` 新增 `.mermaid .nodeLabel/.edgeLabel` 与 `.mermaid-render .nodeLabel/.edgeLabel` 样式，同时作用于 mermaid 测量阶段（临时 `.mermaid` 容器）与最终渲染阶段，锁定 `line-height:1.25` + `font-size:14px` + 字体，使两阶段文字高度一致。新增 9 个测试用例（`tests/unit/mermaid-render.test.ts`，含用户报告原始流程图代码作回归 fixture），全套 262 个测试通过。详见 `docs/v2.0.1 设计文档.md`
- **v2.0.0** UI 视觉与交互体验全面优化：①建立设计令牌（design token）系统——全应用通过 CSS 变量统一管理品牌强调色（`--accent` 浅色 `#0969da` / 深色 `#2f81f7`，统一原先散落的近似值）、三级文字色阶、分层阴影（`--shadow-sm/md/lg` 替代生硬单层阴影）、圆角梯度（`--radius-sm/md/lg`）、动效曲线（`--ease` / `--duration`）、键盘聚焦环（`--ring`），主题切换只改一处；②统一 SVG 图标库（`icons.tsx`，线性 `stroke=currentColor` 随文字颜色继承，默认 16px / 24×24 viewBox，替代原先混用的 emoji / Unicode 符号，跨平台渲染一致）；③现代化滚动条（10px 细半透明滑块 + 透明轨道 + 内缩 `background-clip`，hover 加深，标签页栏收窄至 3px）；④`:focus-visible` 键盘聚焦环（Tab 键触发蓝环，鼠标点击不干扰）；⑤菜单 / 模态弹入动效（`menu-in` 上移缩放淡入 0.12s、`modal-in` 上浮缩放淡入 0.18s、`backdrop-in` 遮罩淡入、`fade-in` 空状态淡入）；⑥ghost 风格顶栏按钮（无边框、hover 灰底，VSCode / Typora 式）；⑦渐变品牌标题（`background-clip: text` 实现正文色到强调色 135° 渐变）；⑧活跃 tab 卡片样式（顶部 2px 强调色指示条 + 底部连通编辑区 + 关闭按钮 hover 显现）；⑨活跃文件左侧指示条（`box-shadow: inset 2px 0 0`）；⑩iOS 风格 Toggle 开关（`appearance:none` 自定义胶囊轨道 + 圆形滑块，`:checked` 强调色 + 右移过渡）；⑪模态毛玻璃遮罩（`backdrop-filter: blur(2px)`）；⑫文本选择色跟随强调色；⑬全应用过渡曲线统一引用令牌。纯样式重构，编辑器逻辑与功能不变。详见 `docs/v2.0.0 设计文档.md`
- **v1.2.10** 修复全部替换 alert 报错：Tauri webview 自动拦截 `window.alert()` 映射为 `dialog.message` command、`window.confirm()` 映射为 `dialog.ask`，但 `capabilities/default.json` 只授权了 `dialog:allow-open`/`dialog:allow-save` 缺 `dialog:allow-message`/`dialog:allow-ask`，导致全部替换后的 `alert('已替换 N 处')` 报 `command plugin: dialog|message not allowed acl`；补齐两个 dialog 权限修复全项目 20 处 alert/confirm 调用（全部替换、删除确认、重命名失败提示等）；新增 10 个测试用例（search.ts replaceAll/replaceCurrent 6 个 + capabilities 配置防回归 4 个），全套 253 个测试通过
- **v1.2.9** 三项回归修复：①表格列宽拖拽手柄不可见（`columnResizingPlugin` 装配正确但 `App.css` 把手柄 `opacity:0` 且无 `:hover` 显形规则导致永久不可见，补 hover 显形 + `table overflow` 改 `visible`）；②全部替换/保存报错 `message not allowed by acl`（Tauri v2 ACL 对自定义 command 强制校验，`capabilities/default.json` 缺 13 个 app command 权限，补齐 `allow-write-text-file` 等修复自动保存链路及所有 fs 功能）；③代码块点击第一行光标跳到 9-11 行（`CodeBlockNodeView.setSelection` 未做 PM 绝对位置→CM 本地位置翻译，`forwardUpdate` 反馈闭环导致光标跳到 `getPos()+1` 对应位置，改为 `anchor - getPos() - 1` + 边界夹紧，`selectNode` 清空选区，`update` 的 `scrollIntoView` 改 `false`）；新增 6 个 code-block-view 测试用例，全套 243 个测试通过
- **v1.2.8** 三项改进：①新增行内公式插入入口（`insertInlineMath` 命令在光标处插入 `math_inline` atom 节点并自动进入编辑态，工具栏 `$ 行内` 按钮 + 斜杠菜单 `/行内` 双入口，空值显示「公式」占位提示）；②彻底修复 frontmatter 删除块误删底部块（v1.2.7 的 mousedown 监听被 CodeMirror focus 事务冲掉仍失效，`deleteCurrentBlock` 增加 DOM 焦点回退路径——读 `document.activeElement` 反查所属 atom 顶层块，删除块按钮 `onMouseDown preventDefault` 防止抢走 CM 焦点）；③修复列表内点代码块/表格/标题按钮报错 `invalid content for node list_item`（list_item content 要求首子节点为 paragraph，新增 `exitListIfNeeded` 在列表后插入空段落移出光标，`setBlockType`/`insertTable` 调用前先退出列表，嵌套列表场景下新段落落到外层 list_item 的 block* 位置仍合法）；新增 7 个测试用例，全套 237 个测试通过
- **v1.2.7** 修复工具栏 5 个边界 bug：①光标在元数据（frontmatter）上点「删除块」误删文档底部块（原 `$head.before(1)` 在 atom 节点 NodeSelection 上返回错误位置，改为优先识别 NodeSelection 直接拿选中节点）；②点击目录块（toc）再点「删除块」无反应（同上，toc 是 atom 节点）；③工具栏点两次删除线（hr）报错 `there is no position after the top-level node`（`insertBlockHere` 在文档最后一个块调用 `$from.after()` 越界，改用 try/catch + 夹值到文档末尾）；④点两次有序/无序列表报错 `invalid content for node list_item`（列表内重复 wrap 产生非法嵌套，改为检测 `range.parent` 已是 list_item 时跳过）；⑤代码块内点列表/引用报错 `content does not fit in gap`（code_block content 是 `text*` 不允许被 wrap，改为检测 code_block 和 atom 节点时跳过，并加 try/catch 兜底）；新增 14 个 block-commands 测试用例覆盖上述场景，全套 230 个测试通过
- **v1.2.6** 修复块级公式插入「不能用」：斜杠菜单 `/公式` 和工具栏「∑ 公式」插入空 `math_display` atom 节点后，KaTeX 渲染空字符串无可视内容，用户以为没插入；改为插入后自动 `NodeSelection` 选中节点并通过 `dblclick` 事件触发 NodeView 编辑模式（直接弹出 textarea 输入），空值时显示虚线占位框「双击编辑公式」；新增 6 个 block-commands 测试用例，全套 216 个测试通过
- **v1.2.5** 新增 Mermaid 图表拖动平移：缩放大于 100% 时按住鼠标拖动图表查看各区域（放大后无需调横向/纵向滚动条），双击重置缩放与平移，重新渲染图表时重置平移，`destroy` 钩子清理 window 监听器避免泄漏；新增 11 个测试用例覆盖平移/缩放/双击重置/destroy 清理，全套 210 个测试通过
- **v1.2.4** 修复万行 MD 文档滚轮失效（Ctrl+滚轮的 passive:false 监听器常驻导致主线程被阻塞，改为仅在 Ctrl/Cmd 按下时动态挂载/卸载，普通滚动走浏览器合成线程快速路径；逻辑抽到 `useCtrlWheelZoom` hook）；修复工具栏表格「删列/删行」按钮无效（原依赖 CellSelection 未先选中列，改用 `prosemirror-tables` 的 `deleteColumn`/`deleteRow` 基于光标位置直接删除）；新增 24 个测试用例覆盖上述修复（scroll-performance 15 个 + TableToolbar 9 个），全套 199 个测试通过
- **v1.2.3** 新增 HTML 嵌入/行内标签渲染（白名单 + DOMParser + LRU 缓存保性能，过滤 XSS）；新增脚注支持（GFM `[^1]` 语法，点击跳转）；Mermaid 图表新增下载按钮（导出 SVG）和 Ctrl+滚轮缩放（0.5~3x）；补充 mock 示例文件
- **v1.2.2** 新增 `Ctrl/Cmd+滚轮` 缩放文档（50%~300%，`Ctrl/Cmd+0` 重置 100%，状态栏显示百分比可点击重置，缩放级别持久化）；修复 GitHub Action 中 `actions/upload-artifact@v5` 仍声明 `node20` 导致的 Node.js 20 弃用警告（升级到 v7）
- **v1.2.1** 修复 GitHub Action E2E 测试全部失败（断言假设一启动就有 mock 文件树，实际浏览器版需先点击「打开文件夹」按钮加载 mock 工作区）；修复 Node.js 20 弃用警告（actions/checkout、pnpm/action-setup、actions/setup-node、actions/upload-artifact 从 v4 升级到 v5）
- **v1.2.0** 性能优化（插件回调加 `docChanged` 守卫消除每键全树遍历、cursor-saver 防抖落 store、TabsBar/useAutoSave 精准订阅、代码块 NodeView 视口懒挂载、查找面板输入防抖）；新增 Ctrl+R 替换快捷键（逐个/全部替换）；建立自动化测试体系（169 个用例：单元/store/组件/E2E 四层，GitHub Action 测试失败阻断构建）
- **v1.1.5** 修复快捷键系统致命 bug（`matchBinding` 的 `MODIFIER_KEYS` 漏了 `"mod"`，导致 Ctrl+F/Ctrl+\/Ctrl+'/Ctrl+\/Ctrl+, 全部失效）；新增 Ctrl+K 插入链接、Ctrl+Alt+0 转普通段落
- **v1.1.4** 修复点击文档右侧空白区会跳到文档最底部的问题：原逻辑在 `posAtCoords` 返回 null 时直接在文档末尾追加段落，现改为把 x 坐标夹到编辑器内容区内重查 `posAtCoords`，让光标落在点击 y 对应的行附近
- **v1.1.3** 修复无序/有序列表插入报错 `content does not fit in gap`（wrap 漏包 `list_item` 层）；工具栏新增「删除块」按钮统一删除引用/代码块/Mermaid/提示框/元数据等块；优化 mermaid/frontmatter 的 `stopEvent` 使非编辑态可选中删除
- **v1.1.2** 更换应用图标（`tauri icon` 重新生成全平台图标）
- **v1.1.1** 修复块插入位置（落在下一行）、列表/引用 wrap 报错、表格列宽调整报错（`invalid content for node table_row`）；Mermaid/公式支持双击编辑；Ctrl+A 全选；点击空白处可编辑；Ctrl+N 新建草稿自动聚焦
- **v1.1.0** 新建文件（Ctrl+N 未命名草稿 + Ctrl+S 另存为对话框，保存后才自动保存）、工具栏重构（提升到标题栏下方固定，斜杠菜单支持的块类型全部做成按钮）、修复斜杠菜单插入的表格无法填写
- **v0.1.0** 骨架与基础编辑（Milkdown 集成、文件树、保存、字数统计）
- **v0.2.0** 图片渲染与拖拽/粘贴上传、表格工具栏、代码块语法高亮、链接跟随
- **v0.3.0** 主题系统与明暗模式、导出 HTML/PDF、大纲面板、Mermaid 图表、KaTeX 公式
- **v0.4.0** 多标签页编辑（标签页切换、关闭确认、文件树已打开标记）
- **v0.5.0** 专注模式 / 打字机模式、查找替换（正则）、偏好设置面板、YAML Front Matter、脚注、`[TOC]` 目录自动生成、文件外部修改监听、快捷键体系与帮助面板、复制为富文本/Markdown
- **v0.6.0** 导出 Word（.docx，走 Pandoc）、应用级快捷键自定义面板（含冲突检测、一键恢复默认）
- **v0.7.0** 全局搜索（`Ctrl+Shift+F`）、斜杠菜单 `/`、callout 提示框、标签页右键菜单 + 拖拽重排、文件树重命名/删除/新建、最近打开文件列表、编辑位置记忆、编辑器错误边界（修复打开部分 md 文件白屏问题）
- **v0.8.0** 禅模式（F11）、文件夹折叠状态记忆、书签/收藏、自动配对补全、图片缩放/对齐、行内图片、表格列宽拖拽验证
- **v0.8.1** 修复打开 md 文件白屏（Editor 工厂 try/catch + 超时降级 + 全局错误捕获 + 侧边栏关闭后无法打开文件死锁）
- **v0.8.2** 定位并修复白屏根因：`remark-frontmatter` 缺少 `"yaml"` options 导致 `editor.create()` 抛 `Missing type in matter {}`，错误被 Milkdown React 集成层 `.catch(console.error)` 静默吞掉；同步加固降级检测（loading=false 后验证 editor 实例）
- **v0.8.3** 修复专注模式无效果：CSS 选择器层级写反（`.focus-mode .editor-scroll ...` 实际 DOM 是 `.editor-scroll > .md-editor-root.focus-mode > .ProseMirror`），改为 `.focus-mode .ProseMirror > *`
- **v0.8.4** 拼写检查开关（偏好设置）、单文件模式（打开散落 md 不绑定文件夹，可继续打开新 md 作为标签页）
- **v1.0.1** 修复文件关联：双击 .md 文件启动程序后自动打开该文件；新增单实例（程序已运行时双击不开新实例，转发文件路径到主窗口打开）
- **v1.0.0** 🎉 首个正式版。品牌重命名 Inkling → InklingMD 并开源（MIT 许可证 + 贡献指南 + issue/PR 模板）；修复中文句号字形（issue #9）、合并 PR #8 本地图片相对路径；侧边栏打开按钮改为图标样式
- **v0.9.0** 多面板分屏（标签页右键「在分屏打开」，双编辑器左右对照 + 交换）、拖拽块排序（⋮⋮ 手柄整块重排）、导出长图 PNG（html2canvas）、文档大纲导出、多窗口（文件/标签页右键「在新窗口打开」，Tauri WebviewWindow）；多光标/块选与内置图床经调研后 defer（见 9.3）

### 8.3 与初版技术方案建议的差异

- **代码高亮**：Shiki → CodeMirror 6。CodeMirror 可嵌入 Milkdown 代码块节点视图，做到代码块内可直接编辑 + 高亮，更符合 WYSIWYG。
- **样式方案**：Tailwind CSS → 纯 CSS + CSS 变量。项目体量不大，CSS 变量已足够支撑主题系统。
- **PDF 导出**：Pandoc → 浏览器打印。零安装、零外部依赖，对个人使用足够。Word 导出仍走 Pandoc（v0.6.0）。
- **前端框架**：React 18 → React 19（跟随生态升级）。
- **脚注方案**：原计划 remark-footnotes，实际改用 GFM 预设自带的 footnote schema（GFM 脚注语法），仅需自定义 NodeView 提供点击跳转交互，无需额外 remark 插件。
- **Word 导出**：通过 Rust command 调用本地 `pandoc` 二进制（`std::process::Command`），未引入 tauri-plugin-shell。未安装 pandoc 时返回明确错误，前端引导用户安装。

---

## 9. 后续迭代规划（v0.7.0+）

> 排除 AI 能力、Pandoc 相关导出、知识库能力（双链/反向链接/标签/图谱等）、命令面板、Minimap、字数目标、文献引用管理、Git 集成、文档历史版本后的剩余功能。

### 9.1 v0.7.0（P1，搜索 + 编辑体验 + 文件管理）— 已发布

| 功能 | 说明 | 状态 |
|---|---|---|
| 全局搜索 | `Ctrl+Shift+F` 跨工作区所有 `.md` 文件搜内容，列出匹配文件和行号，点击跳转 | ✅ |
| 斜杠菜单 `/` | 输入 `/` 弹出块类型菜单（标题/列表/代码块/表格/引用/分割线/公式/Mermaid 等），键盘上下选择回车插入 | ✅ |
| callout 提示框 | GFM 语法 `> [!WARNING]` / `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]`，渲染成带图标和配色的提示框 | ✅ |
| 标签页右键菜单 + 拖拽重排 | 标签页右键弹出"关闭其他/关闭右侧/全部关闭/复制路径"；按住拖动调整顺序 | ✅ |
| 编辑位置记忆 | 关闭文件时存光标位置和滚动位置，重开自动恢复 | ✅ |
| 文件树重命名/删除/新建 | 侧边栏文件右键支持重命名、删除、新建文件/文件夹 | ✅ |
| 最近打开文件列表 | 侧边栏顶部显示最近 N 个文件，点击直达 | ✅ |
| 编辑器错误边界 | 渲染异常时降级 UI 而非白屏（修复 v0.4 打开部分 md 白屏问题） | ✅ |

### 9.2 v0.8.0（P2，内容呈现 + 布局专注）— 已发布

| 功能 | 说明 | 状态 |
|---|---|---|
| 自动配对补全 | 输入 `"` `(` `「` 等自动配对，光标放中间；中文引号/书名号支持；可在设置开关 | ✅ |
| 图片缩放/对齐 | 图片节点加 width/align 属性，点击拖拽缩放，右键设置对齐（左/中/右） | ✅ |
| 行内图片格式 | 图片支持行内模式，插入文字流中（而非独占一行） | ✅ |
| 表格列宽拖拽 | 拖拽表格列边界调整宽度，宽度信息持久化 | ✅（会话内有效，markdown 不携带列宽无法跨会话持久化） |
| 全屏/禅模式 | `F11` 隐藏所有 UI（侧边栏/大纲/标签页/状态栏/工具栏），纯编辑，`Esc` 退出 | ✅ |
| 书签/收藏 | 文件右键"加入书签"，侧边栏书签面板列出所有书签，点击跳转 | ✅ |
| 文件夹折叠状态记忆 | 记住侧边栏每个文件夹的展开/折叠状态，重开应用恢复 | ✅ |

### 9.3 v0.9.0（P3，复杂或小众功能）— 已发布

| 功能 | 说明 | 状态 |
|---|---|---|
| 多面板分屏 | 标签页右键「在分屏打开」启动右侧第二面板，双编辑器实例独立编辑，支持左右交换 | ✅ |
| 拖拽块排序 | 段落左侧出现 ⋮⋮ 手柄，按住拖动整段重排 | ✅ |
| 导出长图 | 整篇文档渲染成 PNG 长图，用 html2canvas 实现，方便分享到社交平台 | ✅ |
| 文档大纲导出 | 只导出标题层级，生成只含标题的 md 文件，当目录用 | ✅ |
| 多窗口 | 文件右键"在新窗口打开"，Tauri 多窗口，多显示器场景 | ✅ |
| ~~拼写检查~~ | ✅ v0.8.4 已实现：浏览器原生拼写检查（红波浪线 + 右键修正建议），偏好设置开关 | ✅ |

### 9.3.1 v1.2.0（性能优化 + 自动化测试）— 已发布

| 功能 | 说明 | 状态 |
|---|---|---|
| 插件回调守卫 | formula-numbering / block-drag / outline 等插件加 `docChanged` 守卫，消除纯光标移动时的全树遍历；formula-numbering 额外加 `hasMathDisplay` 短路，无公式节点直接返回 | ✅ |
| cursor-saver 防抖 | 光标位置本地缓存 + 300ms 防抖落 store，避免每次光标移动触发 TabsBar / useAutoSave 全局重渲染 | ✅ |
| 精准订阅 | TabsBar 改为订阅 `path\|dirty\|isUntitled` 字符串快照、useAutoSave 改为订阅「活跃 tab 是否未命名」布尔派生值，打字时 UI 不重渲染 | ✅ |
| 代码块懒挂载 | CodeMirror 实例延迟到代码块进入视口（IntersectionObserver，200px 预加载）时才创建 | ✅ |
| 查找面板防抖 | 查找词 120ms 防抖，连续输入只触发一次全文匹配 | ✅ |
| Ctrl+R 替换快捷键 | 打开查找替换面板并自动展开替换框；支持逐个替换（`replaceCurrent`）和全部替换（`replaceAll`，从后往前避免位置偏移） | ✅ |
| 自动化测试体系 | 169 个用例分四层：纯逻辑单测（stats/slugify/shortcuts/outline）、store 测试（ui/settings/shortcuts）、Tauri 纯函数（fs/newWindow）、组件测试（StatusBar/TabsBar/SearchPanel）、Playwright E2E（编辑器渲染/查找替换/快捷键全流程）；GitHub Action `test` job 阻断 `build` | ✅ |

**性能定位（与主流编辑器对比）**：
- 中小文档（千行内）：与 Typora 体感基本拉平，明显优于 MarkText（Muya + marked.js 全量 re-parse 架构）
- 长文档（万行级）：仍不及 Typora（自研增量渲染 + 懒布局），但输入延迟增长曲线比 MarkText 平缓（增量 transaction vs 全量 re-parse）
- 启动/内存：Tauri 外壳远优于 MarkText（Electron）
- 仍存在的架构限制：ProseMirror 全量 DOM 渲染（无虚拟滚动）；Milkdown `markdownUpdated` 每键全文序列化 O(N)；Mermaid/KaTeX 无渲染缓存

### 9.4 调研后 defer 的功能

> 以下功能在 v0.9.0 规划中经可行性调研后决定**不在本版实现**，记录结论供后续决策。

| 功能 | 调研结论 | 后续方向 |
|---|---|---|
| 多光标编辑 / 块选模式 | ProseMirror 作者 Marijn Haverbeke 明确表示 Sublime 式多光标「very hard」：需自定义 `Selection` 子类并完整重写输入处理逻辑，社区无现成实现。现有多范围选择仅表格的 `CellSelection`（已支持），矩形块选 Markdown 场景几乎用不到，ROI 极低 | 不做。如未来 Milkdown/ProseMirror 上游提供多光标能力再评估 |
| 内置图床 | 需后端对象存储（S3/OSS/COS）或第三方图床（sm.ms/GitHub Issues）账号与凭证管理，与本项目「本地优先、免账号、绿色免安装」理念冲突，且引入网络依赖与凭证安全风险。现有 `image-upload.ts` 已提供完善的本地方案：拖拽/粘贴图片自动存入工作区 `assets/` 并插入相对路径，整个工作区可随文件夹迁移 | defer。未来可作为可选插件接入，由用户自行配置图床凭证 |

### 9.5 不做的功能（已排除）

- AI 相关能力（润色/翻译/续写/对话）
- Pandoc 相关导出（ePub/RTF/OPML 等，已有 docx 导出）
- 知识库能力（双向链接、反向链接、关系图谱、标签系统、嵌入式笔记、每日笔记、模板系统、块引用）
- 命令面板（`Ctrl+P` 跳转文件/执行命令）
- Minimap 缩略图
- 字数目标 + 进度条、文件计数
- 文献引用管理（BibTeX/CSL）
- Git 版本集成
- 文档历史版本
