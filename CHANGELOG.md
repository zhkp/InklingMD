# Changelog

本项目所有值得记录的变更都汇入本文件，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本语义遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [3.0.0] - 2026-09-05

> **主版本发布**：自 v2.8.1 以来最大规模的一次质量攻坚，共关闭 **33 个 GitHub Issues**、合入 **7 个 PR**，涉及 61 个提交、113 个文件（+8486 / −722 行）。本版本不含新功能，全部投入于**数据安全、竞态治理、崩溃兜底、性能优化、安全加固与可访问性**六个方向，使应用的可靠性基线整体抬升一个层级。

### 数据安全与文件操作（Rust 侧加固）

- **Windows 写入回退路径非原子（#146）**：原子替换失败后的回退分支原本「先删目标再 rename」，中间存在进程被杀即永久丢失文件的数据窗口。改为最多 4 次 × 50ms 退避的原子替换重试，全部失败则**保留原文件并报错**，绝不留下已删未建的中间态。新增 `replace_with_retry` 3 例 Rust 单测（可替换 / 独占占用保留原件 / 临时文件缺失保留原件）。
- **跨盘移动失败 + 目标存在性检查 TOCTOU（#161）**：`rename_path` 不支持跨卷移动，且 `exists()` 检查与替换式 `fs::rename` 之间存在「目标被并发创建后静默覆盖」的窗口。改为文件移动优先走**「硬链接 + 删源」原子占用目标名**（目标已存在时以 `AlreadyExists` 原子失败，闭合 TOCTOU 窗口；硬链接跨卷不支持时回落）；`fs::rename` 跨卷失败（`ERROR_NOT_SAME_DEVICE`/`EXDEV`）回退为**递归复制 + 删源**，复制失败时源原件保持完整、文件残块尽力清理，不再把裸 OS 错误抛给用户。
- **读取编码错误生硬 + 无大小上限（#159）**：`read_text_file` 增加 **10MB 大小护栏**（先元数据判断，防止数百 MB 文件整体读入内存并经 JSON IPC 传输）；非 UTF-8 与超限场景返回**结构化错误标记**（`ENCODING_UNSUPPORTED` / `FILE_TOO_LARGE`），前端可据此给出可读提示而非原始 `FromUtf8Error`。
- **删除文件快照的两处竞态（#166）**：快照早于序列化防抖发布采集、在途读取在删除后生成漏网 tab，两处时序缺陷一并修复。
- **重命名与在途文件读取竞态（#177）**：重开文件可能拿到陈旧内容、加载状态永久卡死。修复后重命名期间的在途读取能正确收敛。
- **读取在途重命名产生幽灵 tab（#200，PR #200/#199）**：#177 修复后的已知边界——读取在途时重命名，完成后 `ensureTab` 仍按旧路径创建幽灵 tab。改为读取完成后按**当前路径**归属 tab；共享在途请求的「加入方」也能拿到落定路径（PR #200 评审项），堵住并发幽灵 tab 与黑名单漏拦。

### 保存与冲突链路

- **全局 saving 标志按整个工作区生效（#148）**：任一保存挂在对话框期间，其他标签页的保存被静默吞掉。改为 `OpenTab` 各自持有 `saving` 标志，`saveCurrent` 只拦本 tab 重入；`switchTab` / 写盘完成 / 异常路径的顶层 `saving` 镜像统一从活跃 tab 派生。
- **自动保存遇非交互冲突后无限 2s 重试（#149）**：无退避、无错误态、每轮全量读盘。`conflictPending` 期间**暂停自动保存**，消除空转；失败退避计数 `failCount` **按文件隔离**，A 文件的失败不再拖慢 B 文件。
- **conflictPending 冲突解决后不清除（#164）**：`reloadFile` 统一清除 tab 与镜像的 `conflictPending`，冲突经重载 / 另存副本解决后状态栏不再误报、指示器点击恢复有效。
- **文件监听重载决策竞态（#170）**：`useFileWatcher` 重载决策前 flush 发布防抖、弹窗后复核 dirty，消除「丢编辑」与「重载失效」两类竞态（PR #170 评审项：冲突流读盘往返后再次 flush，把 `localContent` 收进尾部输入）。
- **冲突对话框层级与键盘可达性（#186）**：层级低于全局搜索 / 快捷键面板导致被遮挡，补 Esc 关闭与打开时的焦点管理。

### 编辑器与查找替换

- **空替换串点击替换直接崩溃（#178）**：`schema.text("")` 会抛 `RangeError: Empty text nodes are not allowed`。改走 `tr.delete`，`replaceCurrent` / `replaceAll` 显式接收替换串参数。
- **关闭查找面板后高亮残留（#185）**：`SearchPanel` 卸载时 dispatch `clear`，关闭 / 切源码模式后高亮立即清除（此前需切换文件才消失）。
- **查找面板打开时编辑性能劣化（#151）**：`replace` 移出搜索 effect 依赖（不再每敲一字符全文重扫并拽动视口）；`SearchOpts` 移除仅面板使用的 `replace` 字段；`DecorationSet` 按 `(matches, current, doc)` 引用缓存，无关 transaction 不再全量重建装饰。
- **编辑器内查找每键全文重扫（#192）**：`docChanged` 且为单步事务（按键形态）时走增量路径——变更窗口外的旧匹配区间经 `tr.mapping` 平移到新文档位置，仅对变更波及的文本节点窗口重扫，装饰集经 `DecorationSet.map` 平移后移除窗内旧装饰、补入新装饰；旧匹配整体被删除坍缩为空区间时直接丢弃（防 `{n,n}` 幽灵空匹配）。多步事务（如全部替换）回退全量重算。新增 8 例增量单测。
- **auto-pair 选区非空时输入被吞（#152）**：选区非空时输入右符号不再吞掉输入，选区不再意外塌缩。
- **编辑器慢启动被误判为失败（#172）**：旧的 3 秒超时一律 `setFallback(true)` 卸载 `<Milkdown/>`，而卸载会对仍在 `create()` 的 editor 调 `destroy()`，create 随后完成又重挂重建，形成加载失败闪烁 + 双倍初始化。重构为 `useEditorFallback` 监督器，区分「工厂同步抛错」（立即降级）与「`create()` 在途慢启动」（超阈值只亮提示、**不卸载**），`loading=false` 后 `getEditor()` 仍为空才判定异步失败降级。
- **代码块语言异步加载竞态（#173）**：快速切换语言可能应用过期的高亮配置，加竞态守卫使过期结果不覆盖最新语言。
- **源码模式卸载快照 scrollTop 现场读取（#174）**：直接读 `view.scrollDOM.scrollTop` 依赖元素仍挂 DOM，React 卸载时序下不可靠（`clientHeight` 可能为 0 导致 `scrollTop` 被钳制）。改用 `readDetachSafeScrollMetrics`：`clientHeight > 1` 时取现场读数，否则回退组件内缓存的最近一次有效快照。

### 全局搜索与启动性能

- **命中行整行克隆导致 OOM（#176）**：含内嵌 base64 图片的文档搜索时整行克隆可直接 OOM 崩溃。preview 改为命中点附近**字符级窗口**（前后 120 字符 + 命中片段封顶 200 字符），5000 条命中的预览总量常数级封顶。
- **5000 条截断对前端不可见（#160/#163）**：返回结构改为 `{ hits, truncated }`，前端状态栏明确提示「已达 5000 条上限，结果已截断」；`scan_files` 返回 `exceeded` 标记，仅在确认存在第 `MAX_TOTAL_HITS+1` 条命中时置 `truncated`，**命中数恰好 5000 不再误报截断**。
- **全局搜索无取消机制、单线程全量扫描（#163）**：引入搜索代次（generation），代次推进时在途旧任务在检查点提前退出，面板卸载即取消（cleanup 发起空查询 + 新代次让命令入口登记新代次，空查询立即返回）；目录符号链接不跟随后去掉逐目录 `canonicalize`；文件扫描按 CPU 数分片并行，按片序合并保持结果确定性。
- **Mermaid 与 KaTeX 静态导入（#168）**：应用启动即加载约 1.1MB（gzip）与编辑器无关的大依赖。改为**首次遇到对应节点才动态 `import()`** 并 Promise 缓存复用：`mermaid-view.ts` / `math.ts` 移除模块级静态导入（约 3.1MB vendor 不再进入启动加载图），KaTeX 的 JS + 样式 + mhchem 首次渲染公式节点时一并加载，render 回调以 `seq` 守卫丢弃过期结果。新增 `mermaid-lazy-load` / `math-lazy-load` 单测。
- **DeletedSnapshots 每 2 秒重写全部快照（#153）**：健康探测改为只写 1 字节哨兵键，不再 `JSON.stringify` 整个快照列表；区块刷新改事件驱动（挂载读一次 + 同窗口变更事件 + 跨窗口 `storage` 事件），删除 2 秒轮询定时器，**空列表时零开销**。

### 多窗口、持久化与工作台

- **多窗口 localStorage 后写覆盖先写（#165）**：新增 `storageSync` 模块，为 `recents` / `bookmarks` / `expandedDirs` 三个持久化 key 注册原生 `storage` 事件，他窗口写入后本窗口立即重读合并，与既有 `settings` / `theme` / `shortcuts` 模式一致；删除快照 key 的跨窗口变更同样经 `storage` 事件刷新。
- **侧边栏折叠状态不记忆 + 低窗口文件树被挤没（#167）**：区块折叠状态持久化记忆，并修复低窗口高度下三区块把文件树完全挤没的问题。
- **单实例 open-file 固定发往主窗口（#147）**：主窗口关闭后单实例回调的 `emit` 落到不存在的窗口上静默失效。改为 `pick_open_file_target_label` 从**存活窗口**中选择（主窗口存活优先，否则字典序首个），并对目标窗口 `unminimize` + `set_focus`；emit 失败显式 `eprintln`。前端 `useStartupFile` 同步重构：所有窗口（含派生窗口）都注册 open-file 监听，主窗口负责拉取 pending，派生窗口打开自身路径。
- **另存为到已打开路径产生重复 tab（#150）**：未命名草稿另存为时，从取到对话框路径到构造 `nextTabs` 之间无重复路径校验，草稿被直接改名为已存在的 path → TabsBar key 重复、按 path `find`/`filter` 的编辑写错项、关闭同时删掉两个。修复：写盘前检测目标路径是否已有「其他」tab（排除正在保存的自身），命中则走合并路径——草稿内容写入目标文件、并入已有 tab 并关闭草稿、激活目标；目标 tab 有未保存内容时先经 `ask` 确认，拒绝则双方原样保留；**写盘窗口期草稿又新增编辑则保留草稿不丢弃新编辑**。
- **激活的 tab 不滚入视野（#187）**：`TabsBar` 按 path 登记 tab 元素，监听 `activeTabPath` 变化执行 `scrollIntoView({ inline: "nearest", block: "nearest" })`，并让此前被隐藏的滚动条可见。

### 稳定性与崩溃兜底

- **全局崩溃兜底过于激进（#171）**：良性错误 / 未捕获 rejection 会把整个应用替换成永久崩溃页。新增 `src/lib/crash-guard.ts`，`isBenignGlobalError` 纯分类函数过滤 `ResizeObserver loop` 噪音、空 message 与跨域 `Script error`；`main.tsx` 的 window error **仅对致命错误**触发崩溃页；`unhandledrejection` 改为只记日志不替换界面（异步链断裂多可恢复）；`useStartupFile` 的 `take_pending_file` 补 `.catch`，启动不再因单个命令异常直接进崩溃页。

### 安全加固

- **asset 静态 scope 过宽 + 远程跟踪图（#162）**：`tauri.conf.json` 的 `assetProtocol.scope` 原含 `$DATA/**` 与 `$TEMP/**`，而 Tauri v2.11 中 `$DATA` 展开为通用数据目录（Windows 即整个 `%APPDATA%`，覆盖所有应用）、`$TEMP` 为系统临时目录，静态放行面远超图片加载所需。收缩为 `$APPDATA/**` + `$APPLOCALDATA/**`（图片实际存放于文档同目录 `assets/`，经运行时 `allow_asset_dir` 按需放行）。远程图片（http/https）经 `image-node-view` 渲染 `<img>` 时加 `referrerpolicy="no-referrer"`，避免文档被打开时把页面上下文经 Referer 头泄露给外部图床（跟踪像素场景）。CSP `img-src` 保留 `https:` 以维持「文档内远程图片可显示」的功能。

### 可访问性（Accessibility）

- **键盘可操作性与 ARIA 语义系统性缺口（#188）**，共 5 处：
  1. 全局搜索「区分大小写 / 正则」开关：checkbox 从 `display:none` 改为 `visually-hidden`（保留原生聚焦与切换），补 `:focus-visible` 焦点环。
  2. 冲突态保存指示器：`role=button` 的 `<span>` 改为真实 `<button>`（Tab 聚焦 + Enter/Space 原生触发），补按钮样式重置与焦点环——该入口是自动保存已暂停状态下的关键操作点。
  3. 标签页：`tabs-list` 声明 `role=tablist`；每个 tab 带 `role=tab` / `aria-selected` / roving `tabIndex`；Enter/Space 激活、左右方向键与 Home/End 切换并把焦点移到新激活 tab；`.tab-close` 补 `:focus-within` 与 `:focus-visible` 显形（原 `opacity:0` 时键盘聚焦不可见）。
  4. 菜单系统：新增 `useMenuA11y` hook（打开聚焦首项 + 方向键 / Home/End 导航），接入三个下拉菜单（导出 / 主题 / 更多）与两个右键菜单；菜单项补 `role=menuitem`、下拉容器 `role=menu`；触发器补 `aria-haspopup` / `aria-expanded`；顶栏任一菜单打开时 Esc 统一关闭。
  5. 文件树：`role=treeitem` 补 `aria-level={depth+1}`（此前运行时实测全为 `null`，屏幕阅读器无法感知层级）。

  新增 4 个组件测试文件 + TabsBar 键盘用例 + 源级静态断言（`aria-a11y-static`，读 CSS/TSX 防止 `display:none` / `opacity` 等纯视觉修复被反向回退）。

### 交互细节

- **文件树非 Markdown 行右键菜单无法唤起（#158）**：原生 `disabled` 表单控件被 Chromium/WebView2 抑制 `contextmenu` 等鼠标事件，txt/png 等文件失去重命名 / 删除 / 复制路径等唯一可用操作。改用 `aria-disabled` 表达禁用态（保留视觉弱化类名），`onClick` 内拦截打开，`contextmenu` 事件恢复可达。
- **图片右键菜单泄漏与叠加（#184）**：实例持有当前菜单与 document 级 close 监听引用，新增幂等 `closeContextMenu` 统一清理（DOM + 监听 + 单例游标）；模块级单例保证同一时间只有一份菜单，打开新菜单先关旧菜单（含其他图片节点残留）；`destroy()` 清理打开中的菜单；`setTimeout` 注册监听加存活守卫。

### 社区贡献（@TomGoh）

本版本的重要一部分由社区贡献者 **Haoze Wu（[@TomGoh](https://github.com/TomGoh)）** 完成，共 9 个提交：

- **大纲（TOC）实时性与性能**：标题扫描防抖（debounce heading scans）、标题变化时刷新大纲（refresh toc when headings change），并新增「大纲节点身份保持稳定」单测与 TOC E2E——`src/components/Editor/toc.ts`。
- **链接对话框主题一致性**：恢复链接对话框主题样式（restore link dialog theme styles）、让自定义链接配色真正生效（honor custom link dialog colors），配套 `Issue180ThemeTokens` 主题令牌单测与 `link-dialog-theme` 浏览器端 E2E。
- **桌面端能力配置**：开启动态图片目录 ACL 权限（`src-tauri/capabilities/default.json` + `permissions/app-commands.toml`），并重构 `capabilities` 测试覆盖新增权限。
- **关键路径测试补齐**：为桌面端与持久化路径补上真实测试覆盖——二进制编解码 / 二进制写入 / 桌面端图片源 / PNG 导出 / 退出保存（新增 `src/lib/useExitHandler.ts`）/ ACL 能力配置 / 工作区存储，以及 Rust `commands/mod.rs`、`commands/search.rs`、`lib.rs` 的测试用例；并把既有回归测试与运行时真实行为对齐（align regression tests with runtime behavior）。

### 测试与质量

- **Vitest**：115 个单测文件、**745 个用例**全部通过（较 v2.8.1 的 82 文件 / 542 用例大幅增长）。
- **Playwright E2E**：**169 个用例**全部通过，零 flaky。
- **Rust**：`cargo test` **59 个用例**全部通过（较 v2.8.1 的 27 个翻倍）。
- **构建门禁**：`tsc --noEmit` 零错误、`vite build` 通过、CI（windows-latest + ubuntu-latest 双平台矩阵）全绿。
- **变异验证**：本批次每个修复均按项目规范做反向改动验证——确认新测试会失败、还原后恢复，杜绝恒真断言（如 #188 关闭菜单聚焦首项 / 禁用 Enter-Space / 移除 `aria-level` / 指示器回退 `<span>` / `gs-toggle` 改回 `display:none` 均验证到对应用例失败）。

> **已知环境限制（非代码缺陷）**：`cross_device_copy_rejects_directory_containing_symlink`、`cross_device_copy_rejects_symlink_source`、`same_volume_rename_moves_symlink_itself_not_its_target` 三个 Rust 用例需要操作系统支持创建符号链接。在未开启「Windows 开发者模式」的机器上会因权限不足而失败；CI（windows-latest / ubuntu-latest）环境具备该能力，**59/59 全绿**。

## [2.8.1] - 2026-08-30

### 修复与优化

- **自身自动保存写盘被文件监听误判为外部修改（#144）**：桌面端源码模式高频输入时随机弹出「文件已被外部修改」/ ConflictDialog，Diff 两边内容几乎一致。根因：`useFileWatcher` 保存忽略窗只推迟检查、从不刷新 `knownMtimesRef` 基线，而 `tabs.ts` 的 `saveCurrent` 已把写盘后读回的 `savedMtime` 存进 `tab.diskMtime`，两套 mtime 记录互不通信，窗口一过轮询必然对比出新旧差异。三道防线：
  - **A（主修）**：store 订阅中保存事件发生时，把 `tab.diskMtime` 主动登记为 watcher 基线。
  - **B（兜底）**：轮询中 mtime 变化但与 `tab.diskMtime` 在 5ms 容差内判定为自家写盘，静默登记基线，覆盖后台 tab 保存时 store 级 `lastSavedAt` 未变化的竞态。
  - **C（语义修正）**：保存忽略窗内不再整体跳过检查，改为刷新基线但跳过弹窗——窗口一过不补误报，且窗内删除检测不再被整体跳过。

### 测试与质量

- 新增 `tests/unit/file-watcher-save-mtime.test.tsx`（5 例 + 2 回归），覆盖三道防线各自路径与「真实外部修改仍弹窗」回归。
- 全套 82 个单测文件（542 用例）、Build、27 个 Rust 用例 100% PASS。

## [2.8.0] - 2026-08-30

### 新增功能

- **模式切换内容锚点还原阅读位置与光标（#136）**：以「内容锚点」替代 v2.7 的滚动高度**比例映射**，密度不均（表格/代码块/图片密集）文档下切换也不再丢阅读位置。
  - **进入方向（WYSIWYG → CM）双候选锚点采集**：视口顶部块 position → Markdown 偏移；code_block 吸附到块起始避免代码块解析浮动漂移。
  - **退出方向（CM → WYSIWYG）精确文本匹配**：`resolveAnchorProsePos` 用锚点行纯文本在 PM doc 定位（重复行取权重最近处 + 二分），最多 8 条候选行兜底，失败退回比例映射。
  - **视口顶部块定位**：`blockStartAtTop` 对顶层块起始二分 `coordsAtPos`。
- **源码模式标准导航键（移植 #137）**：CM 补齐 `defaultKeymap`，`Ctrl+Home/End`、方向键、词移动等此前全部无效的键恢复可用，同时保留应用级快捷键冲突黑名单。
- **评审 N1~N8 质量加固**：真实路径单测注入、"源码模式"菜单文案统一、`tsconfig` 恢复 `tests/e2e` 类型门禁（补 `@types/node`）、`waitScrollConverged` 轮询替固定 sleep、快捷键冲突对等于默认值的绑定放行等。

### 修复与优化

- **模式切换滚动/光标双写者竞态（#136 稳定性）**：引入 `useCursorStateRestore` 单一写者原则，翻转帧跳过自身恢复；settle 收敛循环处理 CM 首帧高度估算。
- **滚动热路径性能（评审 B1）**：`cacheTopPos` 加 rAF 合帧 + `flushWysiwygTopPosRef`，滚动热路径绝不同步跑 `posAtCoords`。
- **回归 E2E 锚点漂移 flaky（#136 根因）**：定位为退出源码 remount 的异步滚动恢复与下一次 `scrollIntoView` 竞态，将滚动投递改为「滚动 → 收敛 → 校验标题贴顶，不达标重滚」。
- **源码模式冲突黑名单对默认绑定过严（评审 N8）**：捕获值等于快捷键自身默认值时放行（如 `mod+f` 与 CM searchKeymap 共存）。

### 测试与质量

- 新增 `tests/e2e/source-mode-scroll.spec.ts`、`source-mode-table-heavy.spec.ts`、`source-mode-mixed-content.spec.ts`、`tests/unit/source-mode-editor-initial-scroll.test.tsx`、`useCursorStateRestore.test.ts`，扩充 `useSourceModeTransition.test.ts`、`source-mode-cursor.test.ts`。
- 全套 81 个单测文件（537 用例）、161 个 E2E、27 个 Rust 用例与 `npm run build`（含 `tests/e2e` tsc 门禁）100% PASS，E2E 零 flaky。

## [2.7.0] - 2026-08-25

### 新增功能

- **Ctrl+K 应用内插入链接对话框（#122）**：新增 `LinkDialog.tsx`，支持同时输入链接文本与 URL，选中文本预填，Esc / backdrop 关闭，替换原生阻塞 `window.prompt`。
- **外部文件修改盲区与 switchTab 重载/冲突（#124）**：监听范围扩大至全部 `openTabs`，`switchTab` 核验磁盘 mtime，外部修改且本地无改动时以磁盘为准重载、有本地改动时置 `conflictPending` 并拉起冲突对话框。
- **多窗口 Storage 同步 E2E（#133）**：重写 `multi-window-sync.spec.ts`，用浏览器原生 storage 事件驱动，断言窗口 B 应用更新 DOM `data-theme`（真实应用行为）。

### 修复与优化

- **模式切换视口与滚动比例映射还原（#121）**：恢复 `sourceMode && enterSnapshot` 渲染守卫，缓存 `wysiwygScrollTopRef` 规避 `display:none` 重排钳 0，退出源码模式按两端 `scrollHeight` 比例映射还原滚动位置。
- **删除快照配额保护与写入失败用户提示（#123）**：新增 `probeSnapshotStorageHealth` 健康探测，快照写入失败时向用户展示 `showMessage` error 告警（不再静默），`DeletedSnapshots` 面板展示不可写/接近配额状态。
- **快捷键自定义冲突黑名单补全（#125）**：`RESERVED_SHORTCUTS` 补齐全部硬编码组合（`mod+s`/`mod+n`/`mod+shift+f`/`mod+r`/`mod+k`/`mod+alt+0`/`mod+0`/`f11`），杜绝与核心功能冲突。
- **全局搜索异步竞态守卫（#126）**：递增 `seq` 序列号，丢弃过期搜索结果。
- **源码模式导出 Word 解绑（#127）**：移除 `exportDocx` 上的 `blockedBySourceMode` 拦截。
- **全部替换提示非阻塞化（#128）**：以面板内 `search-notice` 状态徽章替代阻塞模态提示。
- **清空删除快照二次确认（#129）**：`DeletedSnapshots` 清空操作接入 `askConfirmation` 警告确认。
- **设置面板 Esc 键关闭（#130）**：`SettingsPanel` 增加 Escape 监听触发 `onClose`。
- **图片插入与上传异常反馈（#131）**：`image-upload` 捕获保存/写入异常并弹出带文件名的错误提示。
- **自动保存冲突状态呈现（#132）**：非交互自动保存遇外部冲突时置 `conflictPending`，`SaveIndicator` 展示"自动保存已暂停"并可点击拉起冲突对话框。
- **未命名草稿内联大图体积护栏（#134）**：未命名草稿粘贴/拖入超 512KB 内联图片输出体积警告。

### 测试与质量

- 新增 `tests/store/filetree-snapshot-feedback.test.ts`，真实 QuotaExceededError 驱动快照写入失败告警与健康探测分支。
- `tests/unit/file-watcher-opentabs.test.tsx` 补齐 #124 switchTab 外部修改 → reload / conflict 两分支用例。
- 全套 79 个单测文件（518 用例）、154 个 E2E、27 个 Rust 用例与 `npm run build` 100% PASS。

## [2.6.3] - 2026-08-23

### 新增功能

- **源码模式大纲双向联动与点击跳转（#118）**：
  - **纯 Markdown 大纲解析引擎**：新增 `extractMarkdownOutline`，精准提取 Markdown 标题级别、行号与字符偏移量；内置防御机制，自动跳过 YAML Front Matter（含最大 100 行异常上限截断保护）以及围栏代码块（``` / ~~~）内部的伪标题行。
  - **CodeMirror 精准滚动定位与光标聚焦**：构建独立源码滚动管理器，支持点击大纲面板项时平滑居中滚动至目标标题行，并同步光标位置与编辑区聚焦；采用三级级联匹配策略彻底杜绝同名/重复标题跳转错位。
  - **阅读位置实时跟随高亮**：在源码模式编辑与滚动过程中，自动基于当前可见视口与光标位置反查最近标题索引，实时同步高亮大纲面板对应项。

### 修复与优化

- **模式切换视口与滚动位置无损还原（#117）**：
  - **RAF 多帧布局沉降与重试机制**：富文本与源码模式双向切换时，引入连续 RAF 帧排版沉降检测，在 DOM 完全重排稳定后再精准恢复 `scrollTop` 与选区快照，彻底根治从富文本切源码从头开始、源码切富文本视口漂移的问题。
  - **卸载时序防御**：源码模式组件销毁时优先清理待执行的滚动 RAF，杜绝并发卸载时的野指针与异步报错。

### 测试与质量

- **全量测试套件补齐**：
  - 新增 `tests/unit/source-mode-outline-tracker.test.ts` 单元测试套件；
  - 新增 `tests/unit/source-mode-navigation.test.ts` 单元测试套件；
  - 扩充 `tests/unit/outline.test.ts` 与 `tests/e2e/source-mode.spec.ts`（SM6 大纲联动）；
  - 全套 68 个单测文件（491 个用例）与 153 个 E2E 用例 100% PASS。

## [2.6.2] - 2026-08-23

### 新增功能与架构加固

- **P0 写入安全与灾难恢复机制**：
  - **Rust 物理落盘与并发临时文件唯一性**：`write_binary_file`、`write_text_file` 与 Pandoc 临时文件生成引入 `PID + 时间戳 + AtomicU64` 绝对唯一 Nonce，并在 `rename` 原子替换前强制执行 `sync_all()` 物理刷盘，杜绝文件损坏与截断为 0 字节风险。
  - **大文件 IPC 二进制分块传输**：前端 `writeBinaryFile` 与 `exporter.ts` 采用 32KB 分块 Base64 编码，Rust 端高效解码落盘，彻底解决超大文件通过 IPC 传递时的 JSON 序列化膨胀与 JavaScript 栈溢出（#2）。
  - **外部删除快照恢复面板与管理**：侧边栏新增 `DeletedSnapshots.tsx` 恢复面板与 Store 动作，支持一键将外部误删文档以未命名标签页形式无损恢复或清理（#3）。

### 修复与优化

- **P1 精度对齐与工程稳定性**：
  - **毫秒级 mtime 精度统一**：Rust `file_mtime` 升级为 Unix 毫秒时间戳，FileWatcher 容差过滤收紧至 `< 5ms`，消除 5 秒漏检盲区（#4）。
  - **保存冲突 Fast-Path**：`saveCurrent` 引入 `diskMtime` 内存缓存比对，无外部修改时直接快速安全覆盖，消除冗余弹窗干扰（#5）。
  - **自定义 CSS 路径持久化**：`customCSS` 路径持久化至本地配置并在启动时通过 `initCustomCSS` 静默容错加载（#6）。
  - **搜索规则双端对齐与深度防御**：前后端统一共享忽略目录列表，Rust 端新增 `MAX_SEARCH_DEPTH = 64` 防递归溢出（#8）。
  - **统一原生对话框封装**：封装 `src/lib/dialogs.ts`（`showMessage` / `askConfirmation`），替换全工程散落的 `window.confirm` 与 `alert`，桌面端无缝接入 Tauri 原生 Dialog，Web 端安全降级（#9）。

### 测试与重构

- **P1 全量 TypeScript 测试类型健全**：
  - `tsconfig.json` 将 `tests/` 目录显式纳入类型检查。
  - 修复全部 50+ 个测试文件中的隐性类型问题与缺失断言，杜绝 `any` 糊弄，`tsc --noEmit` 0 报错通过。
  - 修复 Playwright E2E 大纲面板在多时序下的定位等待逻辑。

## [2.6.1] - 2026-08-23

### 新增功能与架构加固

- **P0 严重缺陷修复与安全防线加固**：
  - **保存死锁根治（#91）**：对话框插件加载与文件另存完全移入 `try` 块内部，确保 `finally` 必定释放 `saving: false` 互斥锁，彻底杜绝全局保存死锁。
  - **冲突弹窗异常防御（#100/#91）**：冲突确认弹窗被取消或异常时明确视为放弃覆盖，立即释放保存锁并安全退出，杜绝数据静默覆盖。
  - **CSS 16 进制转义注入拦截（#86）**：实现 `unescapeCss` 对 CSS 样式值进行反转义还原后匹配过滤，拦截 `u\72 l(...)` 变形注入；给 SVG `xlink:href` 增加 `isSafeUrl` 协议白名单。
  - **严格 CSP 与权限收紧（#111）**：配置严格 CSP 策略，收紧 Tauri `assetProtocol` 静态访问范围为仅应用数据目录。
  - **隔离 Mock 数据（#113）**：`src/lib/fs.ts` 改为按需动态导入 `mockFs`，防止浏览器 Mock 污染生产包。

### 修复与优化

- **P1 架构与稳定性优化**：
  - **自动保存指数退避与非阻塞（#100）**：`useAutoSave` 实现 2s ➔ 4s ➔ 8s ... 最长 60s 指数退避；`saveCurrent` 增加非阻塞模式（遇到冲突静默跳过不弹窗）。
  - **Rust 原子写盘物理落盘与 Pandoc 异步化（#89）**：写入临时文件后强制调用 `file.sync_all()` 确保物理刷盘；`pandoc_check` 与 `pandoc_export_docx` 异步化并卸载至 `spawn_blocking` 线程池。
  - **跨 Tab saveError 隔离（#92）**：保存报错仅在活跃 Tab 一致时更新顶层状态，杜绝切换 Tab 报错漂移。
  - **删除文件内存保护快照（#93）**：删除存在未保存修改的文件时自动写入 `localStorage` 快照备灾。
  - **修复 fileRequests 泄漏（#98）**：文件重命名时同步迁移 `fileRequests` 缓存键。
  - **监听容差精度优化（#96）**：外部修改监听防抖时间容差精度优化至毫秒级（0.001s）。
  - **Store 校验与死 mock 清理（#97）**：`ui.ts` 与 `shortcuts.ts` 补充逐字段防御校验；清理测试中失效的 `resolveAssetUrl` 引用。
  - **右键菜单边界防溢出与防闪烁（#108）**：图片菜单接入 `clampMenuPosition`，`useContextMenuClamping` 升级为 `useLayoutEffect`。
  - **路径工具统一收敛与 UNC 兼容（#115）**：统一使用 `path-utils.ts` 的 `baseName` 并补充 Windows UNC 路径测试。

### 测试与重构

- **真实测试重构与覆盖率提升**：
  - 重写 `tests/unit/issue-91-save-guard.test.ts`（真实测试并发保存互斥与异常释放）。
  - 重写 `tests/unit/issue-95-slash-menu.test.ts`（真实测试斜杠菜单匹配、选择与精确范围回退）。
  - 重写 `tests/unit/issue-105-diff.test.ts`（真实断言 LCS / Diff 行算法对不同修改、新增、删除边界的准确性）。
  - 增强 `tests/unit/issue-86-html-sanitize.test.ts`（转义注入与 SVG `<use xlink:href>` 安全测试）。
  - 增强 `tests/unit/issue-92-tab-save-isolation.test.ts`（跨 Tab 状态隔离测试）。
  - 增强 `tests/unit/issue-94-export-flush.test.ts`（Spy 验证 `flushAllMarkdownPublishers`）。

## [2.6.0] - 2026-08-23

### 新增功能与架构加固

- **32 项 GitHub Issues 全面攻坚与架构加固（#85 ~ #116）**：
  - **数据安全与持久化（#85/#89/#91/#92/#93/#100/#102）**：Rust 端实现原子写盘（临时文件写入 + 原子替换重命名覆盖），消除掉电/崩溃截断损坏；保存期间引入 `saving` 状态防重入与快照隔离；多 Tab 保存回写精准按路径隔离；外部删除带修改文件弹窗确认；自动保存错误指数退避与非阻塞提示。
  - **交互与编辑体验（#94/#95/#98/#99/#103）**：导出与复制（富文本/Markdown/Docx/PNG/大纲）前统一强同步 flush 编辑器发布器；斜杠菜单 Esc 取消仅精准删除关键字范围；文件重命名原子化状态迁移（Tab/书签/展开态/光标位置同步迁移）；右键菜单视口边缘自动翻转与防溢出钳制。
  - **安全与防护（#86/#87/#96/#111）**：收紧 DOM-based Sanitizer 白名单，彻底拦截 `<style>` 注入、外联 CSS `@import` 与追踪信标 `url()`；`reloadFile` 全链路异常捕获与友好通知；Rust 搜索跳过 `node_modules`、`.git`、`target` 等依赖目录并增加符号链接防死循环环路检测。
  - **性能与底层模块（#105/#113/#114/#115/#116）**：Diff 算法优化为 $O(N)$ 空间 Myers / LCS 滚动数组；提取统一的 `path-utils.ts` 与 `storage.ts` 工具；浏览器端 `fs-mock.ts` 独立抽离；修复全部测试 TypeScript 类型定义与全面覆盖。

## [2.5.8] - 2026-08-23

### 测试与重构

- **Rust 后端指令防线补齐**：为 `src-tauri/src/commands/mod.rs` 补充文件原子写入（`save_file_atomic`）在父目录不存在时的自动递归创建能力测试、大文件与并发覆盖 CRUD 测试；为 `commands/search.rs` 补充超大文件（>2MB）跳过、结果上限截断与非法路径的集成单测。
- **前端扩展插件与 Store 单元测试**：新增 `tests/unit/footnotes.test.ts`（脚注双向跳转）、`tests/unit/formula-numbering.test.ts`（公式动态重新编号与禁用清除）、`tests/unit/workspace-bookmarks-recents.test.ts`（书签与最近打开 LRU 淘汰及持久化）、`tests/unit/useAutoSave.test.ts`、`tests/unit/useStartupFile.test.ts`、`tests/unit/useCtrlWheelZoom.test.ts`、`tests/unit/exporter.test.ts`。
- **Playwright 端到端测试扩展**：新增 `tests/e2e/tabs-extended.spec.ts` 与 `tabs-drag-reorder.spec.ts`（覆盖 Tab 右键全菜单、中键点击关闭与原生拖拽重排）、`tests/e2e/sidebar-bookmarks-recents.spec.ts`（书签与最近打开交互）、`tests/e2e/conflict-dialog.spec.ts`（外部变动冲突对话框全分支）、`tests/e2e/split-screen.spec.ts`（分屏双栏独立渲染）、`tests/e2e/zen-focus-mode.spec.ts`（禅模式全屏与段落专注模式）。

## [2.5.7] - 2026-08-22

### 修复与加固

- **修复窗口退出 ACL 权限缺失报错**：在 `src-tauri/capabilities/default.json` 补齐 `core:window:allow-destroy` 与 `core:window:allow-close` 权限，消除退出流程触发 `Command plugin:window|destroy not allowed by ACL` 弹窗报错。
- **ACL 权限防回归单测**：在 `tests/unit/capabilities.test.ts` 中增加窗口关闭与销毁权限的自动化校验断言。

## [2.5.6] - 2026-08-22

### 优化与测试

- **退出取消标签页还原**：`App.tsx` 记录退出前初始 `activeTabPath`，若用户取消退出留在应用中，自动还原切回初始标签页，保持多文件编辑上下文连贯。
- **退出多 Tab 保存逻辑单元测试**：新增 `tests/unit/exit-save.test.ts`，为多 Tab 状态下的退出遍历保存、dirty 清理与标签页还原逻辑提供可靠单元测试保障。

## [2.5.5] - 2026-08-22

### 修复与加固

- **Mermaid DOMParser 惰性安全解析**：使用 `new DOMParser().parseFromString(..., "text/html")` 进行惰性安全解析，消除 `innerHTML` 活跃执行窗口，纠正注释与实现矛盾，并完美兼容 `foreignObject` / `htmlLabels`。
- **全量 Dirty Tab 退出落盘**：`App.tsx` 关窗拦截真正遍历所有处于 `dirty` 状态的标签页依次激活并保存，杜绝后台标签页内容丢失。
- **Fail-Safe 退出容错与重渲染 Pan 重置**：`ask()` 抛出异常时采取 fail-safe（中止退出）策略；图表重渲染时重置平移量 `panX = 0, panY = 0` 避免偏移出视口，并保留用户当前 `zoom` 缩放等级。

## [2.5.4] - 2026-08-22

### 修复与加固

- **Mermaid 空闲预渲染与脱落节点守卫**：修复守卫逻辑为 `firstRenderDone || !container.isConnected || container.offsetParent === null`，防止已销毁容器空闲渲染导致高度被 0 覆盖。
- **Mermaid 首渲染防缩高度保护**：重排高度覆盖顺序，优先读取覆盖前的估算高度保底，确保 `Math.max(height, reserved)` 真实生效。
- **SVG 清洗器恢复 XML DOMParser**：恢复使用 `DOMParser(image/svg+xml)` 解析 SVG，杜绝 `innerHTML` 阶段的 XSS 执行窗口与宽松解析隐患。
- **窗口退出多 Tab 落盘与取消保存保护**：`onCloseRequested` 拦截后按序落盘所有 dirty 的 Tab，取消保存或保存失败时弹窗确认，避免数据意外丢失。
- **SMIL 标签安全硬化**：增加对 `<set>` 标签 `attributeName` 过滤与 `href`/`xlink:href` 清洗。
- **单测真实性加固**：`imageSrcCache.test.ts` 补充旧缓存刷新免淘汰真实用例。

## [2.5.3] - 2026-08-22

### 修复与完善

- **窗口关闭拦截与落盘保障**：在 `App.tsx` 中使用 `@tauri-apps/api/window` 的 `onCloseRequested` 拦截原生窗口关闭，同步执行 `flushAllMarkdownPublishers()` 并在未保存时 `await saveCurrent()` 真正写回磁盘后退出，根除最后 150ms 编辑丢失隐患。
- **`saveCurrent` 入口防抖 Flush 契约**：在 `saveCurrent` 执行体首行调用 `flushAllMarkdownPublishers()`，确保入口快照与磁盘写入始终为最新状态。
- **真实 LRU 缓存测试覆盖**：重写 `imageSrcCache.test.ts`，打桩调用计数器真实验证 500 容量淘汰与命中时的 LRU 顺序调整。
- **消除 Mermaid 渲染孪生实现**：收敛并由 `NodeView.render()` 与单测统一复用 `renderMermaidWithSeq` 核心渲染函数，杜绝双轨逻辑漂移。
- **SMIL `<animate>` 属性名注入硬化**：清洗器拦截 `<animate attributeName="onload/on*">` 注入，安全防线更加完备。

## [2.5.2] - 2026-08-22

### 修复与完善

- **Mermaid XSS 纵深防御与属性清洗**：清洗器支持对属性值去除 `\t\n\r` 控制字符，拦截 `javascript:`、`vbscript:`、非图片 `data:` 及 `expression(`，并清理 `iframe/embed/object/form/base` 等危险嵌入标签。
- **保存并发静默回滚防御**：`saveCurrent` 改为局部 patch 模式，避免 `ask`/`readTextFile` 异步窗口内被旧快照整体覆盖。
- **应用退出 Flush 保护**：在 `beforeunload` 时统一触发 `flushAllMarkdownPublishers()`，防止退出前击键丢失。
- **Tab 管理 Store 层 Flush 闭环**：`closeOthers`、`closeToRight`、`closeAll`、`newTab` 均在 store 入口处统一 flush。
- **源码模式性能优化**：Mermaid 视图在隐藏状态（`offsetParent === null`）下跳过空闲预渲染，避免资源浪费与高度缓存污染。
- **测试套件重构与强化**：删除伪测试，重写 `MermaidSanitize`、`MermaidPerf`、`workspace-reload-tab`、`imageSrcCache` 单测，覆盖真实产品逻辑。

## [2.5.1] - 2026-08-22

### 修复与优化

- **Mermaid 渲染修复**：修复 HTML/SVG 白名单清洗中未对 SVG 节点使用 `createElementNS` 导致图表无法正常显示的问题，并完善渐变、滤镜等 SVG 子标签与属性支持。
- **顶栏交互优化**：移除顶栏外层冗余的设置按钮，统一由 `···` 更多操作菜单收纳，优化 E2E 测试定位器。
- **防抖序列化状态保护**：在切换 Tab 与关闭 Tab 前主动 flush 序列化防抖队列，确保编辑状态实时同步。
- **图片缓存 LRU 策略**：图片缓存命中时更新访问顺序，实现标准 LRU 淘汰机制。
- **工作区全局搜索排序**：Rust 目录文件搜索增加排序，确保截断结果跨平台确定性。

### 测试

- 补充 SVG 命名空间与标签属性过滤单测，单测总数提升至 421 项全部通过。

## [2.5.0] - 2026-08-21

UI/UX 视觉与交互全面重构 issue #79-#84：

### 界面与体验

- **#79** 统一 Design Tokens：在 `App.css` 建立 4px 栅格（`--space-1`~`--space-8`）、三层背景架构（`--bg-canvas` 至 `--bg-elevated`）、四阶文字层级、圆角与超快阻尼动效变量。
- **#80** 编辑器排版垂直节奏（Typography & Rhythm）：正文行高提升至 1.75，H1 篇章大间距与轻边框分割，优化代码块、引用块与表格呼吸感。
- **#81** 顶部工具栏重构：实现轻量 Command Bar，新增 `MoreMenu` 收纳低频设置/搜索/快捷键功能，消除按钮堆叠。
- **#82** 侧边栏与标签栏精细化：文件树采用 Subtle Pill 柔和全圆角胶囊选中态，标签栏交互更平滑。
- **#83** 统一全站弹窗浮层：统一所有 Modal 圆角（10~12px）、阴影与入场微动效。
- **#84** 深色模式校准与响应式适配：精调深色主题对比度，增加 `<960px` 自动折叠大纲与 `<768px` 窄屏适配。

### 测试

- 新增 `tests/components/DesignTokens.test.ts`，验证核心变量体系。

详见 [docs/v2.5.0 设计文档.md](docs/v2.5.0%20设计文档.md)。

## [2.4.0] - 2026-08-21

性能专项攻坚 issue #73-#78：

### 性能

- **#73** 消除 App 根组件击键全量重渲染：抽离 `EditorBody` 独立组件，切断 `App.tsx` 对 `currentContent` / `splitContent` 的全量订阅，杜绝高频按键时的全站 React Reconciliation 开销。
- **#74** Markdown 序列化与大纲提取防抖：ProseMirror AST 序列化与大纲递归扫描增加 200ms 防抖调度，在失焦或存盘时立即强制同步。
- **#75** Vite 代码分包与主包瘦身：配置 `manualChunks` 将 Milkdown、CodeMirror、KaTeX、Mermaid 与 Lucide 独立拆包，主包体积减少约 65%。
- **#76** 本地图片流式 Asset 协议与内存缓存池：引入 `convertFileSrc` 流式二进制读取，建立容量 500 的 WeakMap/Map 本地图片缓存池，避免重复 IPC 与 Base64 内存膨胀。
- **#77** Mermaid 异步渲染防抖与过期请求中断：引入 `renderSeq` 令牌，连续键入时自动作废旧渲染任务，仅执行最新 SVG 计算。
- **#78** Rust 全局搜索流式逐行读取：`search.rs` 改用 `BufReader` 逐行扫描与匹配，避免超大文件全量载入内存。

### 测试

- 新增 `tests/lib/imageSrcCache.test.ts` 与 `tests/components/MermaidPerf.test.ts`，全套 419 个单测全绿。

详见 [docs/v2.4.0 设计文档.md](docs/v2.4.0%20设计文档.md)。

## [2.3.9] - 2026-08-21

批量修复缺陷与安全 issue #68-#72：

### 修复

- **#68** reloadFile 触发后富文本 WYSIWYG 编辑器未同步更新：为 `OpenTab` 增加 `revision` 序号，在 `reloadFile` 成功后自增，并联动编辑器 key，确保磁盘重载时强制卸载重建最新 ProseMirror 文档树，杜绝旧缓存覆盖磁盘。
- **#70** openFile 异常时 openingFiles 状态未被清理：将核心流程包裹在 `try ... finally` 中，确保无论加载成功还是抛出错误，侧边栏对应文件的 loading 态 100% 被清理。
- **#71** 外部文件冲突对话框选择「保留我的修改」后未更新基线导致后续保存重复弹窗：新增 `setTabDiskContent` action，在保留修改时将冲突的磁盘内容同步为新基准。
- **#72** Windows 盘符大小写不一致导致路径判定失效：在 `isPathWithin` 中增加盘符统一大写归一化处理，避免跨盘符和子路径比较误判。

### 安全

- **#69** Mermaid 动态渲染 SVG 缺乏 DOM 清洗存在 XSS 风险：在 `html-view.ts` 中增强 SVG 图形标签与属性白名单，将 Mermaid SVG 插入方式重构为 `diagram.appendChild(sanitizeHTML(svg))`，阻断恶意脚本注入。

### 测试

- 新增 5 个前端测试用例（Mermaid SVG 清洗 2 / revision 自增与 openingFiles 清理 2 / 盘符与基线测试补全），全套 416 个测试通过。

详见 [docs/v2.3.9 设计文档.md](docs/v2.3.9%20设计文档.md)。

## [2.3.8] - 2026-08-21

批量修复 issue #59-#67：

### 修复

- **#59** 外部修改保存保护：`OpenTab` 记录 `diskContent` 磁盘基线，Ctrl+S 保存前直读磁盘与基线比对，外部已改则弹二次确认（拒绝即中止保存），消除 3 秒轮询窗口期内的静默覆盖；新增 `reloadFile` store 方法强制从磁盘重读（`openFile` 对已打开 tab 只切缓存不重读，此前冲突对话框 / 文件监听的重载是假重载）。
- **#60** 未命名草稿粘贴/拖拽图片报错：检测 `untitled-N` 虚拟路径（此前仅判空会漏掉草稿场景，按 CWD 解析出错误路径导致写盘失败），草稿场景跳过目录解析与写盘，图片以 Data URL 内联插入，另存后随文档自带。
- **#62** 全局搜索点击结果总跳到本文件第一处匹配：改为按「点击项是本文件第 N 处命中」定位对应第 N 次出现（ProseMirror 块节点文本不含换行符，行号累计算不出目标位置）；正则模式先从命中行提取实际匹配文本再找；未命中回退块级定位。
- **#65** 多级嵌套列表子项内点删除块误删整个顶级列表：删除前先沿祖先链找最近 `list_item`，只删当前子项；父列表仅剩这一项时删整个列表（不留空列表）。
- **#67** PNG 长图导出丢失 Callout/代码块/Mermaid/表格样式：离屏容器原先把 `editor-scroll`/`milkdown` 挂在同一元素上，无法命中 `App.css` 的后代选择器；改为复刻真实编辑器三层嵌套 `[data-theme] > .editor-scroll > .milkdown`，导出图与编辑器所见一致（含深色主题）；截图前等待全部图片 decode/load（3s 超时保护），背景色取 `.milkdown` 实际计算的主题背景。

### 安全

- **#64** 收敛 Tauri assetProtocol 权限：静态 scope 从 `**`（全盘任意路径）收敛到 `$APPDATA`/`$DOCUMENT`/`$HOME` 等用户目录；新增 Rust `allow_asset_dir` 命令，前端解析图片路径时按需把文档所在目录加入运行时白名单（模块级 Set 去重避免重复 IPC，失败回退静态白名单），只放行用户实际打开的目录，最小权限。

### 变更

- **#61** 多窗口实例间主题 / 偏好设置 / 快捷键覆盖实时同步：三个 store 监听 `storage` 事件（仅在 other 窗口修改时触发，天然无回环），一窗修改全部窗口即时生效。
- **#63** Pandoc 导出 Word 临时文件名固定导致并发导出互相覆盖：改为 `inkling-export-{pid}-{纳秒时间戳}-{原子自增序号}.md` 唯一命名。

### 文档

- **#66** CONTRIBUTING 补 Linux（Ubuntu/Debian）Tauri 系统依赖安装清单、Pandoc 三平台安装指引、本地测试命令；README 导出功能说明同步 Pandoc 安装链接与 PNG 导出样式对齐描述。

### 测试

- 新增 13 个前端用例（草稿贴图 3 / 保存冲突与 reloadFile 7 / 嵌套列表删块 3）+ 1 个 Rust 用例（临时路径唯一性），全套 411 个测试通过。

详见 [docs/v2.3.8 设计文档.md](docs/v2.3.8%20设计文档.md)。

## [2.3.7] - 2026-08-16

### 新增

- **外部文件变动冲突对话框**（用户口头反馈）：本地有未保存修改且磁盘文件被外部修改（Git 切分支/网盘同步）时，不再用 confirm 二选一，改为冲突对话框提供四选项——①保留本地并另存副本（`*.backup.md`，已占用自动递增编号，存后重载磁盘最新）②查看差异对比（自研行级 LCS diff，公共前后缀修剪 + 大差异降级，unified 视图标注「本地未保存 / 磁盘外部修改」两侧）③丢弃本地修改重载磁盘 ④继续编辑（明示稍后保存将覆盖磁盘）。修复原先「取消后直接保存会静默覆盖外部修改，无备份无感知」的数据丢失风险。非脏状态保持原有 confirm 重载询问。

### 工程化

- **发版前置校验（CI release-guard）**：仅 `v*` tag 触发，平时提交不受影响。校验①`package.json`/`tauri.conf.json`/`Cargo.toml`/`Cargo.lock` 四处版本号一致且与 tag 名一致（`scripts/check-version.mjs`）；②自上一 tag 以来有代码变更时 `CHANGELOG.md`/`README.md`/`docs/` 至少一处已更新（`scripts/check-docs-updated.mjs`）。任一失败则阻止 Release 发布。

## [2.3.6] - 2026-08-16

### 重构

- **#49**：将 1025 行的 `src/store/workspace.ts` 拆分为 `src/store/workspace/` 下的 4 个 Zustand slice（`fileTree` / `tabs` / `bookmarks` / `recents`）+ `shared.ts` / `types.ts`，`workspace.ts` 仅保留 slice 组合与导出，对外 API 不变。
- **#50**：拆分三个巨型组件，行为不变：
  - `Sidebar` 912 → 128 行：抽出 `WorkspaceFileTree` / `FileTreeNode` / `TreeContextMenu` / `RecentFiles` / `Bookmarks` / `FileOpenStatus` 子组件 + `useRename` / `useNewItem` hooks + `treeShared` 共享类型；
  - `Editor` 741 → 472 行：抽出 `cursor-saver` / `table-tracker` / `select-all` 三个 ProseMirror 插件 + `useSourceModeTransition` hook + `editor-root-click` 空白点击定位；
  - `App` 734 → 281 行：抽出 `Topbar/`（`EditorTopbar` / `ExportMenu` / `ThemeMenu` / `SaveIndicator`）+ `SplitPane` 分屏组件 + `useGlobalShortcuts` / `useStartupFile` hooks。

### 文档

- **#51**：版本历史从 `README.md` 迁移到独立 `CHANGELOG.md`（Keep a Changelog 风格），`README.md` 仅保留最近 5 个版本摘要并链接本文件。
- **#52**：新增 `ARCHITECTURE.md`，梳理整体分层、关键模块职责与数据流，链接 `docs/` 深度设计文档。

## [2.3.5] - 2026-08-16

专注模式复合块高亮修复 + Rust 命令单测补全 + 版本号同步：

- **#56** 修复专注模式点击列表/表格当前块不高亮——`editor-modes.ts` 装饰原先取光标所在「最内层块」（`findParentNodeClosestToPos(n => n.isBlock)`），列表（`bullet_list > list_item > paragraph`）/表格（`table > table_row > table_cell > paragraph`）内命中内部 paragraph，而 CSS 只高亮 `.ProseMirror` 直接子节点，导致外层列表/表格被整体弱化到 0.35 点不亮；改为取光标所在「文档顶层块」（`$head.node(1)`，即 `.ProseMirror` 直接子节点），装饰粒度与 CSS 高亮粒度一致，列表→`bullet_list`/`ordered_list`、表格→`table` 均正确点亮，新增 `tests/unit/editor-modes.test.ts` 5 个用例验证各块类型。
- **#47** 为 `search.rs` 的 `search_in_workspace` 补 9 个单测（空查询/工作区不存在/大小写切换/非法正则/跨文件行号与路径/隐藏目录跳过/非 UTF-8 静默跳过/UTF-8 列号计数/超大文件跳过），复用 `mod.rs` 既有临时目录模式。
- **#48** 为 `pandoc.rs` 补单测并做「参数拼装与执行分离」重构（`build_pandoc_command`/`run_pandoc`），用注入假脚本覆盖 `--resource-path` 追加/非目录忽略/pandoc 缺失/非零退出码/成功 5 个分支，无需 CI 安装 pandoc。
- CI `test` job 增加 Rust `cargo test` 步骤；同步 Cargo.toml/Cargo.lock/tauri.conf.json/package.json 版本号至 2.3.5（此前 Cargo.toml 滞后在 2.2.0）。

详见 [docs/v2.3.5 设计文档.md](docs/v2.3.5%20设计文档.md)。

## [2.3.4] - 2026-08-14

打开瞬间抖动根治 + 切 tab 大纲定位修复：

- v2.3.3 后用户实测仍有两个问题——打开文件瞬间抖动一下且文件越大越抖；切 tab 后大纲高亮停在顶部需手动滚动才恢复。
- 问题①根因是打开路径上三个「渐进改变高度」环节都在首帧后发生、浏览器滚动锚定逐次补偿：代码块懒挂载前 `cmHost` 为空 div、Mermaid 未缓存首渲染高度跳变、滚动恢复被未撑开的 scrollHeight 钳制。修复：代码块挂载前用与 CodeMirror 同字体/行高/padding/max-height 的 `<pre>` 纯文本占位（挂载前后高度差≈0）；Mermaid 首渲染 min-height 取 max(占位, 实测) 只增不减；滚动恢复逐帧重试到 30 帧上限。
- 问题②为 v2.3.3 采样重构引入：切 tab 重灌文档后选区被钳到文档头，大纲重算按选区推导高亮跳回顶部且此后无 scroll 事件触发采样。修复：重算完成后按当前 scrollTop 采样定位，防抖窗口内标记 stale 跳过采样与选区推导，插件创建后追加 rAF 初始采样兜底。

详见 [docs/v2.3.4 设计文档.md](docs/v2.3.4%20设计文档.md)。

## [2.3.3] - 2026-08-12

大文档窗口抖动 + 引用块滚动掉帧根治：

- ①视口上方图表后台预渲染变高触发滚动锚定反复补偿（抖动），且重复图表每张仍 ~150ms 全量渲染形成 ~9s 预渲染风暴。修复：按源码 LRU 缓存 SVG + 实测高度（命中仅 ~2ms），创建即预留精确高度（占位→渲染跳变为 0），空闲队列跳过视口上方图表（锚定补偿消失）。
- ②`posAtCoords` 采样在万行文档线性扫描文档级子节点 rect，引用块区域单次 55-67ms。修复：批量缓存标题元素滚动坐标，采样退化为 scrollTop 与缓存数组二分比较 + 120ms 节流，彻底移除 posAtCoords，缓存随文档变更防抖重建并在总高/宽度变化时自动重建。

详见 [docs/v2.3.3 设计文档.md](docs/v2.3.3%20设计文档.md)。

## [2.3.2] - 2026-08-10

万行多图文档滚动掉帧修复：v2.3.1 的视口懒渲染把渲染开销从「打开时」转移到「滚动时」——滚到未渲染图表处逐张 ~150ms 卡顿。修复：`mermaid-view.ts` 新增空闲预渲染队列，`requestIdleCallback` 每个空闲槽渲染一张，滚动停歇 250ms 内自动暂停，滚得快落在未预渲染图表时仍由视口即时渲染兜底。实测静止 16s 后 59/60 张后台完成；全文滚动 51 长任务/4.2s → 27/2.8s。详见 [docs/v2.3.2 设计文档.md](docs/v2.3.2%20设计文档.md)。

## [2.3.1] - 2026-08-08

万行多图文档打开卡顿修复：Mermaid 图表打开即同步渲染全部（每张 ~150ms，60 张 ~9s 长任务）。修复：图表改为 IntersectionObserver 视口懒渲染（300px 预载边距），视口外仅保留占位容器，`update` 在进入视口前跳过渲染。实测打开时长任务 6.5~7.4s → 1.9s。详见 [docs/v2.3.1 设计文档.md](docs/v2.3.1%20设计文档.md)。

## [2.3.0] - 2026-08-06

性能回退修复 + 源码模式增强 + 保存链路稳健性 + 社区修复：

- **#31** 修复万行文档编辑/滚动掉帧（保存路径 flush 跳过 idle 编辑器，避免重复全文序列化）。
- **#29** 源码模式查找替换——`Ctrl/Cmd+F`/`Ctrl/Cmd+R` 在源码模式路由到 CodeMirror 内置查找/替换面板。
- **#26** 光标/滚动映射增强——按源行权重映射 PM 位置 + 光标行片段匹配回退。
- **#27** 退出源码模式重置撤销历史；**#28** 源码模式可访问性（ARIA 属性）。
- 打开文件不再误判 dirty（publisher 以解析后 doc 序列化结果为同步基线）。
- **#25** Markdown 往返保真单测——无头 Milkdown 驱动真实 parser/serializer，修复 toc 节点序列化静默丢失 `[TOC]` 的真 bug。
- 保存链路（PR #34）、多标签滚动/光标位置按文件路径读写（#30/PR #35）、macOS E2E 平台按键兼容（#36/PR #37）、CI 双平台矩阵。

详见 [docs/v2.3.0 设计文档.md](docs/v2.3.0%20设计文档.md)。

## [2.2.0] - 2026-07-30

新增源代码模式（#19）：整页切换为 CodeMirror 6 编辑原始 Markdown（GFM 高亮 + 行号）；顶栏按钮 + 默认 `Ctrl/Cmd+Alt+S`；按标签页记忆；与专注/打字机互斥；退出 re-parse 回 WYSIWYG；分屏独立切换。详见 [docs/v2.2.0 设计文档.md](docs/v2.2.0%20设计文档.md)。

## [2.1.0] - 2026-07-20

合并社区贡献者 @TomGoh 的三项工作区/主题修复并新增 Linux 发行版：

- **#11/PR #15** 大型工作区按需加载与文件树渲染（Rust `list_dir` 单层浅扫 + `spawn_blocking`，前端按需加载 + 窗口化渲染）。
- **#14/PR #16** 同步原生控件与主题配色（`color-scheme`）。
- **#12/PR #17** 打开文件保留侧边栏文件树（行内 spinner/错误图标 + 竞态处理）。
- **#13/PR #18** Release 增加 Linux amd64 构建（AppImage + deb）。

详见 [docs/v2.1.0 设计文档.md](docs/v2.1.0%20设计文档.md)。

## [2.0.2] - 2026-07-10

补全 E2E 测试覆盖并修复测试驱动的三个生产 bug：`auto-pair.ts` 无选区配对崩溃；`callout.ts` 解析器不兼容 Obsidian 常见写法；`frontmatter.ts` NodeView 漏设 `data-value`。新增 8 个 E2E 文件 67 用例，修复 4 个 flaky 测试。详见 [docs/v2.0.2 设计文档.md](docs/v2.0.2%20设计文档.md)。

## [2.0.1] - 2026-07-08

修复 Mermaid 多行节点文字底部被边框裁切：三因素叠加（`:root line-height` 继承、`useMaxWidth` 回流、`stroke-width` 向内侵占）。修复：`mermaid-view.ts` 提取 `MERMAID_CONFIG` 常量补 `htmlLabels:true`/`padding:20`/`useMaxWidth:false`/`fontSize:14px`，`App.css` 锁定两阶段 `line-height`/`font-size`，新增 9 个回归用例。详见 [docs/v2.0.1 设计文档.md](docs/v2.0.1%20设计文档.md)。

## [2.0.0] - 2026-07-01

UI 视觉与交互体验全面优化：①设计令牌系统（CSS 变量统一配色/阴影/圆角/动效/聚焦环）；②统一 SVG 图标库（`icons.tsx` 线性风格）；③现代化滚动条；④`:focus-visible` 键盘聚焦环；⑤菜单/模态弹入动效；⑥ghost 顶栏按钮；⑦渐变品牌标题；⑧活跃 tab 卡片样式；⑨活跃文件左侧指示条；⑩iOS 风格 Toggle；⑪模态毛玻璃遮罩；⑫文本选择色；⑬过渡曲线统一令牌。纯样式重构，编辑器逻辑不变。详见 [docs/v2.0.0 设计文档.md](docs/v2.0.0%20设计文档.md)。

## [1.2.10] - 2026-06-20

修复全部替换 alert 报错：Tauri ACL 缺 `dialog:allow-message`/`dialog:allow-ask` 权限，补齐后修复全项目 20 处 alert/confirm 调用；新增 10 个测试用例。

## [1.2.9] - 2026-06-18

三项回归修复：①表格列宽拖拽手柄不可见（补 hover 显形）；②全部替换/保存报错 `message not allowed by acl`（新增 `permissions/app-commands.toml` 为 13 个 command 显式定义权限）；③代码块点击第一行光标跳到 9-11 行（`CodeBlockNodeView.setSelection` 位置翻译修正）。新增 6 个测试用例。

## [1.2.8] - 2026-06-15

三项改进：①新增行内公式插入入口（`insertInlineMath`）；②彻底修复 frontmatter 删除块误删底部块（增加 DOM 焦点回退路径）；③修复列表内点代码块/表格/标题按钮报错（新增 `exitListIfNeeded`）。新增 7 个测试用例。

## [1.2.7] - 2026-06-12

修复工具栏 5 个边界 bug（删除块误删、toc 删除无反应、末尾块越界、列表重复 wrap、代码块内 wrap 报错）。新增 14 个测试用例。

## [1.2.6] - 2026-06-08

修复块级公式插入「不能用」：插入空 `math_display` 节点后自动 `NodeSelection` 选中并 dblclick 进入编辑态，空值显示虚线占位框。新增 6 个测试用例。

## [1.2.5] - 2026-06-05

新增 Mermaid 图表拖动平移：缩放 >100% 时拖动查看、双击重置、重新渲染时重置平移、`destroy` 清理监听器。新增 11 个测试用例。

## [1.2.4] - 2026-06-02

修复万行文档滚轮失效（`passive:false` 监听器改按需挂载，抽到 `useCtrlWheelZoom` hook）；修复表格「删列/删行」按钮无效（改用 `prosemirror-tables` 直接删除）。新增 24 个测试用例。

## [1.2.3] - 2026-05-28

新增 HTML 嵌入/行内标签渲染（白名单 + DOMParser + LRU 缓存，过滤 XSS）；新增脚注支持；Mermaid 新增下载按钮和 Ctrl+滚轮缩放。

## [1.2.2] - 2026-05-25

新增 `Ctrl/Cmd+滚轮` 缩放文档（50%~300%）；修复 GitHub Action 中 actions/upload-artifact@v5 的 node20 弃用警告。

## [1.2.1] - 2026-05-22

修复 GitHub Action E2E 测试全部失败（需先点击「打开文件夹」加载 mock 工作区）；修复 Node.js 20 弃用警告（actions 从 v4 升级到 v5）。

## [1.2.0] - 2026-05-20

性能优化（插件回调 `docChanged` 守卫、cursor-saver 防抖、TabsBar/useAutoSave 精准订阅、代码块视口懒挂载、查找面板防抖）；新增 Ctrl+R 替换快捷键；建立自动化测试体系（169 用例，GitHub Action 阻断构建）。

## [1.1.5] - 2026-05-15

修复快捷键系统致命 bug（`matchBinding` 的 `MODIFIER_KEYS` 漏了 `"mod"`，导致 Ctrl+F/Ctrl+\/Ctrl+'/Ctrl+, 失效）；新增 Ctrl+K 插入链接、Ctrl+Alt+0 转普通段落。

## [1.1.4] - 2026-05-12

修复点击文档右侧空白区跳到文档最底部：把 x 坐标夹到内容区内重查 `posAtCoords`。

## [1.1.3] - 2026-05-10

修复无序/有序列表插入报错（wrap 漏包 `list_item`）；工具栏新增「删除块」按钮；优化 mermaid/frontmatter 的 `stopEvent`。

## [1.1.2] - 2026-05-08

更换应用图标（`tauri icon` 重新生成全平台图标）。

## [1.1.1] - 2026-05-06

修复多个块插入问题（分割线/表格/公式/callout/TOC 落行、列表/引用 wrap 报错、表格列宽调整报错）；Mermaid 与公式支持双击编辑源码；Ctrl+A 全选全文；点击空白追加段落；Ctrl+N 新建草稿自动聚焦。

## [1.1.0] - 2026-05-01

新建文件（Ctrl+N 未命名草稿，Ctrl+S 另存为）；工具栏重构成固定行并把斜杠菜单块类型全部做成按钮；修复斜杠菜单插入表格无法填写。

## [1.0.1] - 2026-04-25

修复文件关联（双击 .md 自动打开）；新增单实例支持（程序已运行时转发文件路径到主窗口）。

## [1.0.0] - 2026-04-20

首个正式版。品牌重命名 Inkling → InklingMD，新增 MIT 开源许可证与贡献者指南；修复中文句号字形（#9）、合并 PR #8 本地图片相对路径；侧边栏打开按钮改为图标样式。

## [0.9.0] - 2026-04-10

多面板分屏（标签页右键「在分屏打开」）、拖拽块排序（⋮⋮ 手柄）、导出长图 PNG、文档大纲导出、多窗口（Tauri WebviewWindow）。

## [0.8.4] - 2026-04-05

拼写检查开关；单文件模式（打开散落 md 不绑定文件夹）。

## [0.8.3] - 2026-04-03

修复专注模式无效果（CSS 选择器层级写反）。

## [0.8.2] - 2026-04-02

定位并修复打开 md 白屏根因（remark-frontmatter 缺少 options）。

## [0.8.1] - 2026-04-01

修复打开 md 白屏 + 侧边栏关闭后无法打开文件死锁（编辑器降级与全局错误捕获）。

## [0.8.0] - 2026-03-28

禅模式（F11）、文件夹折叠状态记忆、书签/收藏、自动配对补全、图片缩放/对齐、行内图片、快捷键帮助补充 F11。

## [0.7.0] - 2026-03-20

全局搜索（`Ctrl+Shift+F`）、斜杠菜单 `/`、callout 提示框、标签页右键菜单 + 拖拽重排、文件树重命名/删除/新建、最近打开文件列表、编辑位置记忆、编辑器错误边界。

## [0.6.0] - 2026-03-12

导出 Word（.docx，走 Pandoc）、应用级快捷键自定义面板（含冲突检测、一键恢复默认）。

## [0.5.0] - 2026-03-05

专注模式 / 打字机模式、查找替换（正则）、偏好设置面板、YAML Front Matter、脚注、`[TOC]` 目录自动生成、文件外部修改监听、快捷键体系与帮助面板、复制为富文本/Markdown。

## [0.4.0] - 2026-02-25

多标签页编辑（标签页切换、关闭确认、文件树已打开标记）。

## [0.3.0] - 2026-02-15

主题系统与明暗模式、导出 HTML/PDF、大纲面板、Mermaid 图表、KaTeX 公式。

## [0.2.0] - 2026-02-05

图片渲染与拖拽/粘贴上传、链接跟随。

## [0.1.0] - 2026-01-20

基础所见即所得编辑器。