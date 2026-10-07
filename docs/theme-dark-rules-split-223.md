# dark 散落覆盖规则拆分清单（#223 交付 → #225 归并输入）

对应 Theme Epic 冻结契约 `01 §5.3 / 02 §C6 / issue #223 §5.3`。

口径（P3-3/P3-4）：以**规则**计数（多行选择器算 1 条）。`#223` 已将下列规则中的颜色值全部 token 化（S9），规则本身**原样保留**——纯颜色覆盖规则的删除归并属于 `#225`（目标：变量块保留 2 个、纯颜色散落规则降为 0；非颜色规则保留）。

基准：迁移前实测 `src/App.css` 中 `[data-theme="dark"]` 出现 20 行 = 2 个变量块（light 共用选择器块 1 个 + dark 变量块 1 个）+ 约 15 条散落规则（含 2 组多行选择器）。下表行号为 **#223 改造后**的位置。

| # | 规则（简写） | 行号 | 位于文件尾部 | 二维分类（保留规则? / 值 token 化?） | #225 处置 |
|---|---|---|---|---|---|
| 1 | `[data-theme="dark"] ::selection` | 196 | 否（中部，全局基础区） | 保留规则（伪元素）/ 是（`--shell-selection-bg`） | **保留**；值已随 token 翻转，规则可删（非颜色属性无），#225 删 |
| 2 | `[data-theme="dark"] .inkling-block-handle` | 536 | 否（编辑区中部） | 纯颜色 / 是（`--content-block-handle`） | 删除（token dark 值 #555 已入变量块） |
| — | `[data-theme="dark"]` 变量块 | 1247–1348 | 是 | 两个变量块之一 | **保留 2 个变量块**（结构不动） |
| 3 | `… .save-indicator.save-ok` | 1354 | 是 | 纯颜色（`--success`，冗余）/ 是 | 删除（token 自身翻转；现状规则即冗余） |
| 4 | `… .save-indicator.save-error` | 1357 | 是 | 纯颜色（`--danger`，冗余）/ 是 | 删除 |
| 5 | `… .milkdown blockquote` | 1361 | 是 | 纯颜色（border/bg）/ 是（`--content-quote-*`） | 删除（a 项语义不一致保留，视觉差异另立 issue） |
| 6 | `… .milkdown hr` | 1366 | 是 | 纯颜色 / 是（`--border`，冗余） | 删除 |
| 7 | `… ::-webkit-scrollbar-thumb` | 1371 | 是 | 保留规则（伪元素，含 background-clip/border 结构属性）/ 是（`--shell-scrollbar-thumb`） | **保留**（结构属性不进变量块） |
| 8 | `… ::-webkit-scrollbar-thumb:hover` | 1376 | 是 | 保留规则 / 是（`--shell-scrollbar-thumb-hover`） | **保留** |
| 9 | `… .milkdown th` | 1382 | 是 | 纯颜色 / 是（`--content-table-head-bg`） | 删除 |
| 10 | `… .milkdown .column-resize-handle` | 1386 | 是 | 纯颜色 / 是（`--content-table-handle`=accent） | 删除 |
| 11 | `… .milkdown .selectedCell::after` | 1390 | 是 | 纯颜色 / 是（`--content-table-selection-bg`） | 删除 |
| 12 | `… .milkdown .frontmatter-label, .milkdown .toc-label`（多行选择器，1 条规则） | 1394–1397 | 是 | 纯颜色 / 是（frontmatter→`--content-frontmatter-label-bg`；toc→`--content-toc-label-bg`，light=transparent 保真） | 删除（两 token 均随主题翻转） |
| 13 | `… .toc-item a, sup.footnote-ref a, .footnote-backref`（多行选择器，1 条规则） | 1399–1403 | 是 | 纯颜色 / 是（`--content-link`） | 删除 |
| 14 | `… .frontmatter-cm .cm-gutters` | 1405 | 是 | 纯颜色（border-right-color）/ 是（`--content-frontmatter-gutter-border`） | 删除 |
| 15 | `… .split-pane` | 1659 | 是（v0.9 区分屏区，文件末段） | 保留规则 / 是（仅 `border-left-color: var(--border)`，值随 token） | **保留**（split-pane 规则含结构声明；本覆盖规则已纯 var，可删，#225 决定；保守保留） |

计数核对：散落规则 15 条（#1–#15，其中 #1/#2 在文件中部，#3–#15 在尾部）；另含 1 条组件侧 dark 规则 `[data-theme="dark"] .tt-btn:hover`（`TableToolbar.css`，值已 token 化为 `--content-table-toolbar-hover`）、1 条 `ShortcutsCustomize.css` 的 `.sc-binding-capturing` dark 覆盖、1 条 `SearchPanel.css` 的 `.search-match` dark 覆盖、2 条 `ConflictDialog.css` diff 文字色覆盖——组件侧规则同样在 #225 复核，值均已随 token 翻转。

#225 归并完成后预期：App.css 尾部（变量块之后）纯颜色散落规则 = 0；保留规则仅限伪元素/结构属性（::selection、::-webkit-scrollbar-*、.split-pane 视实现决定）。
