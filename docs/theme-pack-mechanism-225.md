# 主题包机制与反 FOUC（#225 交付）

对应 Theme Epic 冻结契约：issue #221 的 G3/G5/G6/G9/G12、设计集 `02`（主题包机制与反 FOUC）、
`00` §5.2/§5.3、`05` §4.5；实现口径以 **issue #225「设计补充与原文更正」（2026-10-03 冻结）** 为准。

> **A-3 口径**：本批的「首发 2 套内置主题」= 既有 `light` / `dark` **迁移为 `builtin:light` / `builtin:dark`**，
> **不新增主题 CSS 文件**（其载体仍是 `src/App.css` 的二值变量块，由 `data-theme` 驱动）。
> 自研主题扩充（`src/themes/*.css`）归 `#226`；预装第三方主题归 `#308`。

## 1. 数据模型与身份（§3/§3.1/§3.2/C3）

| 项 | 实现 |
|---|---|
| 权威源 | `themeId`（`src/theme/registry.ts`） |
| 派生 | `data-theme` = `descriptor.mode`（`App.css` 的 20 处依赖它）；**同一次同步写**落盘 `data-theme` + `data-theme-id` |
| 身份规则 | 内置基线 `builtin:light` / `builtin:dark`；自研 `builtin:<slug>`；预装 `bundled:<slug>`；用户 `user:<归一化文件名>`（明暗成对 → 2 个 id + `variantOf` 互指） |
| 归一化 | **复用** `#306` 已落地的 G11 实现（`src/theme/typora/metadata.ts`），不另立规则 |
| `data-theme-id` | 仅作元数据/调试属性（P2-5：**不是选择器锚点**，不作首帧必需断言） |

## 2. 层与优先级（G5/G6，`@layer base, theme, user`）

- 层序声明唯一落点 = `index.html` 内联（N1，`#223` 已交付，S12 断言）；
- **base**：18 个样式入口（`#223`/`#224` 已交付）；
- **theme**：主题注入 `<style id="inkling-theme">`，内容包 `@layer theme { … }`（`src/theme/inject.ts`）；
- **user**：自定义 CSS 注入 `<style id="inkling-custom-theme">`，内容包 `@layer user { … }`（**最高，必须最终胜出**；**不剥 `!important`**，N3）。

实现细节（都进了断言）：

| 细节 | 处置 | 依据 |
|---|---|---|
| 注入时机 | **推迟到一个微任务**（`queueMicrotask`）——微任务时 `base` 层块已就绪，层序天然正确 | N8 |
| 写入方式 | `textContent`（唯一写 CSS 的函数 `writeStyle`；禁 `innerHTML`/拼接，防 `</style><script>` 逃逸） | N11-2 / S15 |
| 插入位置 | `<head>` 末尾；**不引入** `#inkling-style-host` 与 `MutationObserver` | N5 |
| 幂等 | 内容相同则不动 DOM；`null` = 卸载（移除元素）；已存在的元素**原地更新**（不重新 append） | §4.2 / S7 |
| 自定义 CSS 的 `@import` | 提到 layer 包裹**之外**（`@import` 属表首限定，包进 layer 会被浏览器忽略） | 本轮实测补充 |

## 3. 反 FOUC 边界（G3/§4.3，**写入文档**）

`main.tsx` **顶部静态 import** `./theme/session`（禁懒加载）；其模块顶层副作用就是首帧路径：
读 `inkling-theme` → 解析 `themeId` → **同步写** `data-theme`/`data-theme-id` → 快照适用且命中时注入主题样式。

| 路径 | 期望 | 复现步骤 |
|---|---|---|
| 正常重启（快照命中） | **零闪烁** | 选一个带 CSS 的主题（`bundled:*`/`user:*`）→ 关闭应用 → 重新打开：内容出现时已是该主题（E2E `S8` 断言「应用内容首帧 `data-theme` 已正确」） |
| 首装 / 清缓存（快照缺失） | 允许**一次**可见切换（回落内置基线 → 读盘后切换） | 清 `localStorage` 后打开并选择带 CSS 的主题：先看到内置基线，随后切到目标主题一次 |
| 快照超预算（> 256 KB）/ 写入失败（配额耗尽） | 同「快照缺失」，并**记录状态位**（不得静默） | 造一个 > 256 KB 主题导入后观察 `inkling-theme-snapshot-state.last ∈ {oversize, quota}` |
| 未知 `themeId`（清单/快照未就绪） | 本帧**不切换**，回落内置基线 + 状态位 `invalid`；清单/快照到达后重试 | 手改 `inkling-theme` 为不存在的 id → 打开应用：不切到「半主题」，状态位留痕 |

> 内置基线 `builtin:*` **不走快照**（P2-4）：它们的零闪烁由「同步写 `data-theme` + `App.css` 变量块」保证。

## 4. 快照存储契约（G9/§4.4）

| 项 | 实现 |
|---|---|
| key | ① 当前主题 `inkling-theme`（值 = `themeId`，旧值 `light`/`dark` 读取侧容忍一版）② 快照 `inkling-theme-snapshot:<themeId>:<hash>`（`themeId` 自带 `:` → 以**最后**一个 `:` 切分）③ 用户主题清单 `inkling-themes-index`；payload 带 `v: 1` |
| 体积 | 单主题 ≤ **256 KB**（`MAX_SNAPSHOT_BYTES`）；同步注入耗时预算 ≤ **8 ms**（超预算记 `slow`） |
| 一致性 | 读取时比对 `themeId + hash`，不符即**弃用并清理**该 key（防串味） |
| 回收 | 单 `themeId` 只保留最新一份（写入前删旧 hash）；启动时 GC 清单里已不存在的 `themeId` |
| 原子性 | 接收方拿到未知 `themeId` **不切换**，等清单 + 快照就绪后重试（`pendingRemoteThemeId`） |
| 适用性 | 仅 `bundled:*` / `user:*`（磁盘）走快照 |
| 状态位 | `inkling-theme-snapshot-state` = `{v,last,themeId?,hash?,at,ms?,detail?}`，`last ∈ hit/slow/missing/invalid/oversize/quota/inapplicable/gc/written` |

## 5. 多窗口同步收敛（C4 **方案 A：全量收敛**）

`src/store/storageSyncRegistry.ts` 是**唯一注册点**：`window.addEventListener("storage")` 只安装一次，
所有 key 通过 `registerStorageSync` / `registerStorageSyncPrefix` 登记（前缀用于快照这类动态 key）。

已迁移的监听（原 5 处，均删除各自 `addEventListener`）：

| 原位置 | 登记 owner | key |
|---|---|---|
| `src/store/settings.ts` | `settings` | `inkling-settings` |
| `src/store/shortcuts.ts` | `shortcuts` | 快捷键 key |
| `src/components/Sidebar/DeletedSnapshots.tsx` | `deleted-snapshots` | 已删快照 key（组件级订阅 → 返回取消注册） |
| `src/store/theme.ts` | `theme:current` / `theme:index` / `theme:snapshot` | `inkling-theme` / `inkling-themes-index` / `inkling-theme-snapshot:*` |
| `src/store/workspace/storageSync.ts` | `workspace:recentFiles` 等 | 最近文件 / 书签 / 展开目录 |

约定保持不变：`e.key === null`（`localStorage.clear()`）**不抹除**本窗口状态。

## 6. 迁移路径（C7，不丢既有状态）

| 旧 | 新 | 规则 |
|---|---|---|
| `inkling-theme = "light"\|"dark"` | `themeId` | 读取侧（含**跨窗口**路径）容忍旧格式一版 → 映射为 `builtin:light`/`builtin:dark`；写回新格式 |
| `inkling-custom-css-path` | 自定义 CSS 槽位（④ 层） | **不丢**（`#307` 负责迁移为最高优先级层并保留路径） |
| `prefers-color-scheme` | 仅决定**首次默认** | 用户选定具体主题后不持续跟随 |

## 7. dark 覆盖归并（C6，输入 = `#223` 的逐条清单）

`src/App.css`：**删除 12 条纯颜色散落覆盖规则**（`::selection`、`.inkling-block-handle`、`save-indicator.*`、
`blockquote`、`hr`、`th`、`.column-resize-handle`、`.selectedCell::after`、`frontmatter-label/toc-label`、链接色），
**保留 2 个变量块**与**结构属性规则**（`::-webkit-scrollbar-thumb{,:hover}` 的 border/background-clip、`.split-pane`）。
组件侧 5 条 dark 覆盖（`TableToolbar` / `SearchPanel` / `ShortcutsCustomize` / `ConflictDialog` ×2）同批删除。

计数核对：归并后 `src/App.css` 中 `[data-theme="dark"]` 仅剩 **3 处**（变量块 + 2 条滚动条规则），
组件侧 **0 处**；清单见 `docs/theme-dark-rules-split-223.md`。**非颜色规则未被删除**。

## 8. 断言地图

| 断言 | 位置 | 覆盖 |
|---|---|---|
| S7 DOM 顺序冒烟（dev-only） | `tests/e2e/theme-layers.spec.ts` | statement 在首位；theme 先于 user（两者都在时）；注入次序的确定性部分由 `tests/theme/theme-injection.test.ts` 覆盖 |
| S8 首帧就位 | 同上（`addInitScript` 记录「应用内容首帧」的 `data-theme`） | 预置 `builtin:dark` → 首帧即 dark；首装 → 按 `prefers-color-scheme` 定首次默认 |
| S12 层序 / 行为级 | `theme-layers.spec.ts` | 层序 statement；同属性下 `@layer theme` 胜 `@layer base`（与 DOM 顺序无关） |
| S13 未分层 = 0 | `theme-layers.spec.ts` + `tests/styles/theme-s13-source-layers.test.ts` | 应用源 100% 在层内；未分层只来自登记运行时源 |
| S14 全局名称 | `theme-layers.spec.ts` | 应用侧 `fade-in` 不被夺；主题字体名带前缀 |
| S15 注入函数 | `tests/styles/theme-s15-injection.test.ts` | 登记 `src/theme/inject.ts :: writeStyle`（`textContent`、禁 `innerHTML`） |
| S16 产物级 | `scripts/check-theme-build-assets.mjs` | 3 个 CSS 资产、完全层化、statement 在最前 |
| 机制单测 | `tests/theme/app-registry|theme-snapshot|theme-injection.test.ts`、`tests/store/storage-sync-registry.test.ts` | 身份/迁移、快照契约（含体积/GC/一致性/适用性/状态位）、注入与首帧、唯一注册点与跨窗口语义 |
| 多窗口 | `tests/e2e/multi-window-sync.spec.ts` | 同 context 两 page 联动（正例）+ **不同 context 存储隔离（P1-1 负向）** |

## 9. 已知差异登记（本批新增）

| # | 差异 | 原因 | 处置 |
|---|---|---|---|
| D30 | 内置基线 `builtin:*` 不走快照 | 构建期同步可得，快照无收益（P2-4） | 首帧零闪烁由「同步写 `data-theme` + App.css 变量块」保证；快照状态位记 `inapplicable` |
| D31 | 存储里的**未知 `themeId`**（清单/快照未就绪）时首帧回落内置基线 | P2-3 允许「接受一次可见切换」，但必须留痕 | 写状态位 `invalid` + `needsAsyncLoad`；清单/快照到达后重试切换 |
| D32 | 自定义 CSS 的表首 `@import` 被提到 `@layer user` 之外 | `@import` 属表首限定，包进 layer 块会被浏览器忽略 | 保留在样式表最前（功能保真），规则体仍在 `user` 层内 |
| D33 | `theme` 层的 `<style>` 只在主题**有独立样式表**时存在 | 内置基线的 `css.kind = none`（A-3） | S7 的「theme 先于 user」在两者都在时断言；注入次序另有单测确定性覆盖；`#307/#308` 落地磁盘主题后自动升级为强断言 |
| D34 | S15 的函数体提取正则放宽（容忍 `): void {` 返回类型注解） | 原正则只匹配无返回类型的写法，会把带 `: void` 的注入函数误判为「函数不存在」 | 断言口径未变（仍要求 `textContent`、禁 `innerHTML`）；已在本文件登记 |
