# InklingMD 架构总览

本文档描述 InklingMD **当前**的整体架构，面向想快速建立心智模型的开发者。历史演进与各版本深入设计见 [docs/](docs/) 下对应的设计文档；详细的工程规范与贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 整体分层

InklingMD 是一个 Tauri 2 桌面应用：前端（React + TypeScript）负责全部 UI 与编辑器交互，Rust 后端通过 Tauri 命令桥提供文件系统、搜索与 Pandoc 导出能力。

```
┌────────────────────────────────────────────────────────────┐
│  前端（src/）  React 19 + TypeScript                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 组件层    │  │ 状态层    │  │ 工具层    │  │ 编辑器内核 │   │
│  │ components│  │ store    │  │ lib      │  │ Milkdown │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
└───────┼─────────────┼─────────────┼─────────────┼─────────┘
        │   invoke(command, args)   │  事件(emit/listen)      │
┌───────┼─────────────┼─────────────┼─────────────┼─────────┐
│  Tauri 桥接层（capabilities 权限 ACL + IPC + 事件）        │
│  ┌────────────────────────────────────────────────────┐   │
│  │ Rust 命令层（src-tauri/src/commands/*）              │   │
│  │  - mod.rs：文件系统命令（list_dir/read/write/rename…）│   │
│  │  - search.rs：全局搜索                               │   │
│  │  - pandoc.rs：Word(.docx) 导出                       │   │
│  └────────────────────────────────────────────────────┘   │
│  外部：文件系统 / Pandoc 可执行文件                          │
└────────────────────────────────────────────────────────┘
```

### 分层职责

| 层 | 位置 | 职责 |
|---|---|---|
| 组件层 | `src/components/` | 纯展示与交互：编辑区、侧边栏、标签页、大纲、顶栏、面板等；大型组件按职责拆分子组件与 hooks |
| 状态层 | `src/store/` | Zustand store，全局状态与领域逻辑（见下） |
| 工具层 | `src/lib/` | 无 UI 的纯逻辑：文件读写封装、导出、大纲解析、自动保存、全局快捷键、启动文件等 |
| 编辑器内核 | `src/components/Editor/` | Milkdown（ProseMirror）封装、插件与自定义 NodeView |
| Rust 命令层 | `src-tauri/src/commands/` | 所有文件系统、搜索、Pandoc 操作，前端不直接拼路径 |

## 状态层（Zustand）

全局状态按领域拆分为多个 store，组件通过 `useStore((s) => s.xxx)` 精准订阅，避免无关更新引发整树重渲染。

| Store | 文件 | 职责 |
|---|---|---|
| `workspace` | `src/store/workspace/` | 核心工作区状态，由 4 个 slice 组合（见下） |
| `theme` | `src/store/theme.ts` | 明暗模式、自定义 CSS |
| `settings` | `src/store/settings.ts` | 编辑器行为开关、缩放、拼写检查等 |
| `ui` | `src/store/ui.ts` | 面板显隐（侧边栏/大纲/禅模式） |
| `shortcuts` | `src/store/shortcuts.ts` | 应用级快捷键绑定与自定义 |
| `outline` | `src/store/outline.ts` | 大纲快照（独立 store 避免滚动时整树重渲染） |

### workspace slice（#49 拆分）

`src/store/workspace.ts` 仅组合导出，实际逻辑在 `src/store/workspace/`：

| Slice | 文件 | 职责 |
|---|---|---|
| `fileTree` | `fileTree.ts` | 工作区根、目录树、按需展开/加载、重命名/删除/新建 |
| `tabs` | `tabs.ts` | 打开标签页、当前文件与内容、保存、分屏、编辑位置记忆 |
| `bookmarks` | `bookmarks.ts` | 书签增删与持久化 |
| `recents` | `recents.ts` | 最近打开文件列表 |
| 共享 | `shared.ts` / `types.ts` | localStorage 持久化工具、路径工具、并发的目录/文件请求去重、公共类型 |

## 编辑器内核（Milkdown / ProseMirror）

编辑器是核心，`src/components/Editor/` 下按职责组织：

- **`Editor.tsx`**：对外组件，负责装配所有插件与 NodeView，同步外部 `value`（受控），发布 markdown 变更回调。
- **两种模式**：所见即所得（Milkdown）与**源代码模式**（`SourceModeEditor.tsx`，CodeMirror 6）。切换逻辑在 `useSourceModeTransition.ts`（采集/恢复光标滚动、重置撤销历史、失败回退）。
- **插件**（`src/components/Editor/*.ts`）：markdown 发布、图片上传、链接跟随、大纲跟踪、公式编号、专注/打字机、查找替换、目录生成、斜杠菜单、自动配对、光标记忆等，均为 ProseMirror 插件。
- **NodeView**：代码块（CodeMirror 高亮）、Mermaid 图表（视口懒渲染 + 空闲预渲染）、数学公式（KaTeX）、Front Matter、脚注、HTML 嵌入、callout 等自定义节点。

> 性能约束：Mermaid 用 IntersectionObserver 懒渲染（300px 预载边距），SVG 预置精确高度避免布局位移；大纲跟踪用 scrollTop 二分采样替代 `posAtCoords`。详见 `docs/` 对应设计文档。

## 关键数据流

### 打开文件 → 渲染

1. 文件树点击 / 最近文件 / 书签 → `workspace.tabs.openFile` 调 `lib/fs.readTextFile`（Rust `read_text_file`）。
2. 内容写入 `currentContent`，按 `currentFile` 作为 `key` 传入 `<MarkdownEditor>`。
3. Editor 初始化时用 `defaultValueCtx` 解析 markdown → ProseMirror doc → 渲染。

### 编辑 → 保存

1. 用户输入产生 transaction → `markdownPublisherPlugin` 防抖 150ms 序列化整篇 doc → `onChange` 写回 store。
2. `lib/useAutoSave` 订阅内容并在防抖 2s 后调 `write_text_file` 落盘；`Ctrl+S` 立即保存。
   保存已有文档带 `mustExist`：文件已被删除 / 移动 / 所在目录不存在时 Rust 端拒写（`TARGET_MISSING` / `PARENT_MISSING` / `NOT_A_FILE` / `PARENT_NOT_DIR`，替换前紧贴 rename 复检），tab 标记 `deletedOnDisk` 并暂停自动保存，由用户在 `Ctrl+S` 时选择重新创建或另存为（#363）。写盘默认不补建父目录。
3. 剪贴板/拖拽图片 → 写入文稿同目录 `assets/`（只补建 `assets/` 这一层），markdown 内保持相对路径。

### 源码模式 ↔ 所见即所得

1. 进入：采集 WYSIWYG 光标与滚动位置 → 渲染 `SourceModeEditor` 恢复之；互斥专注/打字机。
2. 退出：`parser(value)` 重建 doc → 重置撤销历史 → 尽量恢复光标/滚动位置。

### 全局搜索

`Ctrl+Shift+F` → `lib` 调 Rust `search_in_workspace`（`search.rs`，UTF-8 感知、隐藏目录/超大文件跳过）→ 结果按文件分组展示 → 点击跳转对应行。

### 导出

`lib/exporter`：HTML/PDF/长图直接从编辑器 DOM 生成；Word(.docx) 走 Rust `pandoc.rs`（本地 Pandoc）；大纲导出提取标题层级。

## 目录约定

- `src/components/` 按功能域分目录（Editor / Sidebar / Tabs / Outline / Settings / Shortcuts / StatusBar / GlobalSearch / Topbar）；一个目录内可含子组件、hooks 与共享类型文件。
- `src/store/` 一个领域一个 store 文件；复杂领域拆 slice 子目录。
- `src/lib/` 放无 UI 的纯逻辑，命名 `useXxx` 表示 hook。
- `src-tauri/src/commands/` 集中所有 Rust 命令，逻辑按域分 `mod`。
- 测试：`tests/unit`（纯逻辑）、`tests/components`（组件）、`tests/e2e`（Playwright）；Rust 单测内嵌在 `src-tauri` 各模块。

## 深度文档

各版本的设计文档位于 `docs/`（如 `docs/v2.3.5 设计文档.md`），覆盖性能优化、编辑器插件、状态拆分等具体实现细节。版本历史见 [CHANGELOG.md](CHANGELOG.md)。