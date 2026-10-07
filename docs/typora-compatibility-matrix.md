# Typora 主题兼容性矩阵（#306 交付物，活文档）

> 版本：v1（2026-10-07）｜对应：Epic **#221** / 子 Issue **#306**（Typora 兼容层）
> 权威链：`issue 正文 > 设计集 tmp/00–07/99 > 本文`。本文只做**登记**，口径以 issue/设计集为准。
> **复算方式**（任何真实主题目录都可重跑，结果应与下表一致）：
> ```bash
> node node_modules/vite-node/vite-node.mjs scripts/theme-compat-report.ts <主题目录> --md
> ```

## 1. 「兼容」的验收口径

对选定的**基线主题集**、**原样未改动**的 `.css`：核心 Markdown 元素视觉与 Typora 一致，
或差异**已在本文登记**。「完全兼容」不代表「所有 Typora 主题都完美」。
非目标（Epic 明文）：**不实现 Typora 窗口级 UI 皮肤**（侧边栏 / 文件树 / 偏好设置 / 菜单 / 弹层），
不引入 Typora 编辑器内核行为（源码模式、CodeMirror 5 编辑行为）。

## 2. 选择器映射表（逐条状态）

状态口径：**原生** = 原样可用；**映射** = 兼容层改写后落到本应用等价节点；**降级** = 部分生效/需登记差异；**不支持** = 明确丢弃并登记。

| # | Typora 侧 | InklingMD 落点 | 状态 | 说明 |
|---|---|---|---|---|
| 1 | `#write`（文档根） | `.editor-scroll .milkdown`（**恒 2 段**） | 映射 | `#write` 单独出现即整体收敛（G6-I1：禁止 3–4 段） |
| 2 | `#write h1..h6` / `p` / `ul,ol,li` / `blockquote` / `hr` / `strong` | 同名前缀化 | 映射 | 剥离 `#write` 后加 2 段前缀 |
| 3 | 裸标签（`table` / `code` / `img` / `a` / `input` …） | 前缀化 | 映射 | **隔离关键**：不加前缀会命中外壳同名元素 |
| 4 | `tt` | `code` | 映射 | Typora 时代的行内代码标签 |
| 5 | `#write table` / `th,td` / 斑马纹 | 前缀化 | 映射 | 表头底色 / 单元格 padding 生效 |
| 6 | `.md-fences`（代码块容器） | `.code-block` | 映射 | **容器归主题**（G1） |
| 7 | `.md-lang`（代码块语言标签） | `.code-block-lang` | 映射 | 本应用是 `<select>`，字体/padding 生效，下拉箭头外观**降级** |
| 8 | `.md-fences .CodeMirror` / `.cm-s-inner` / `.CodeMirror-*` / `.cm-*` | — | **不支持** | **一律丢弃**：语法高亮归 `codeBlockTheme`（G1，A2 修正） |
| 9 | `.md-inline-math` | `.math-inline` | 映射 | 配色 / 字号 |
| 10 | `.md-math-block` / `.mathjax-block` / `.md-mathjax-midline` | `.math-display` | 映射 | 块级公式容器 |
| 11 | `.md-diagram-panel` / `.md-diagram` | `.mermaid-block` | 映射 | 与 #226 的 Mermaid 跟随联动 |
| 12 | `.md-toc` | `.toc-block` | 映射 | `[TOC]` 目录块 |
| 13 | `.md-meta-block`（YAML 前置块）/ `#write pre.md-meta-block` | `.frontmatter-block` | 映射 | 前置块容器 |
| 14 | `.md-image` | `.milkdown-image-wrap`（内含 `.milkdown-image`） | 映射 | 圆角/边框/居中 |
| 15 | `.md-image > .md-meta`（图片 alt 文本） | — | 降级 | 本应用不渲染独立 alt 节点（该规则不命中，已登记） |
| 16 | `sup.md-footnote` / `#write .md-footnote` | `sup.footnote-ref` / `.footnote-definition` | 映射 | 脚注上下标 + 定义块 |
| 17 | `.md-task-list-item` | `[data-item-type=task]` | 映射 | 本应用任务项**无类名**，改用属性选择器 |
| 18 | `.md-task-list-item > input`（复选框） | — | **不支持** | 本应用任务项不含 `input`（勾选态由 `li[data-checked]` 承载）→ 主题的复选框样式不生效（登记，见 §5 后续项） |
| 19 | `.task-list`（任务列表容器） | — | 降级 | CSS 无「父选择器」，容器样式不生效（登记） |
| 20 | `.md-tag`（`#tag` 语法） | — | 不支持 | 本应用无 tag 语法 |
| 21 | `.md-attr`（属性块） | — | 不支持 | 本应用无属性块 |
| 22 | `.md-rawblock*`（源码/HTML 块内部结构） | `.html-block` / `.html-inline` | 降级 | 本应用 HTML 块结构不同，只有容器级样式可能命中 |
| 23 | `.md-alert` | `.callout-block`（`[data-callout]`） | 映射 | 仅 `[!TYPE]` callout 语法产生的块命中 |
| 24 | `.md-focus` / `.md-focus-container` / `.on-focus-mode` | — | 不支持 | 专注模式状态（本应用无此 UI 状态）；实测 `.md-focus` 全部出现在 `#write > h3.md-focus:before` 这类**专注模式装饰**上 |
| 25 | `.anchor`（标题锚点） | — | 不支持 | 本应用无锚点节点 |
| 26 | `body` / `html` / `:root` / 裸 `*` | `.editor-scroll .milkdown` | 映射 | 根级收敛：背景/字体作用于编辑区容器，**不外溢**到外壳 |
| 27 | `.typora-export` / `.enable-diagrams` / `.html-for-mac` / `.mac-seamless-mode` / `.typora-node` | 剥离后前缀化 | 映射 | 文档根别名：剥掉条件，保留文档元素规则（`.enable-diagrams` 语义上恒真：本应用总启用图表） |
| 28 | 窗口级 UI：`#typora-sidebar` / `#top-titlebar` / `#megamenu-*` / `.outline-*` / `.file-node-*` / `.btn*` / `.dropdown*` / `.modal*` / `.code-tooltip` / `.ty-table-edit` / `#md-searchpanel` … | — | 不支持 | **Epic 非目标**；实测 6 款基线主题合计 **约 520 条**此类规则被丢弃（见 §4） |
| 29 | `:is()` / `:not()` / `:where()` / `:has()` 内层参数 | 递归加前缀 | 映射 | 每个内层参数单独前缀化；`:where()` 特异性仍为 0（与 Typora 行为一致） |
| 30 | `@media` / `@supports` / `@container` | 递归改写内部规则 | 映射 | 含 `@media print`（PDF 跟随主题，#226 验收溢出容器） |
| 31 | `@include-when-export`（**Typora 专有**） | `@media print` | 映射 | 该块语义即「仅导出时生效」；本层翻译为 `@media print` 并递归改写 |
| 32 | 原生嵌套 / `&` | — | 降级 | 本层不展开 → 整条丢弃并登记（6 款基线主题实测**未使用**） |
| 33 | `@charset` / BOM | 剥除 | 映射 | 流水线第 0 步（N11-1/N12）；内容 hash 基于规范化文本 |
| 34 | 本地 `@import "x.css"` | 读取并**内联** | 映射 | 不得重写为 asset URL（`style-src` 不含 asset，P1-6）；递归深度上限 8 + 循环保护 |
| 35 | 远程 `@import` / 远程字体 / 远程背景图 | — | 降级 | CSP **不含** `https:`（有意取舍：不放开远程字体）；被拦**不报错、不白屏**；远程背景图提示见 #307 §9（P1-7） |
| 36 | 相对 `url()`（字体/背景图） | `convertFileSrc()` 绝对 URL | 映射 | 按**主题目录**解析（G7-b）；`local()` 保留；多候选 `src` + `format()` 保留；`image-set()` 多分辨率覆盖 |
| 37 | `data:` / `http(s):` / `blob:` / 绝对路径 `url()` | 原样 | 原生 | §C9 边界：不重写（`data:` 内联字体由 `font-src data:` 放行） |
| 38 | `:root { --私有变量 }` | 原样保留 + 收敛到 `.editor-scroll .milkdown` | 映射 | **不改名、不删除**（P0-5）；引用侧无需改写 |
| 39 | 对基础变量 / `--shell-*` 的赋值 | **拒绝**（删声明） | 映射 | G8 拒绝集 = 白名单 `base` + `shell`；主题内 `var()` 自动落到应用基线值 |
| 40 | 对 `--content-*` / `--code-block-*` 的赋值 | 允许覆盖 | 原生 | G4 |
| 41 | `!important` | 剥离 | 降级 | G12/N3：**仅 theme 层**剥离（`@layer user` 的自定义 CSS 不剥）；登记为已知差异 |
| 42 | `@keyframes <name>` | `<前缀>-<name>` + 同步重写 `animation` / `animation-name` | 映射 | I3/N7：同名按文档顺序夺名，layer 不保护 |
| 43 | `@font-face { font-family: X }` | `<前缀>-X` + 同步重写 `font-family` / `font` 引用 | 映射 | 只改**主题自身声明**的名字；通用族 / 系统族 / `local()` 永不改名（N9） |
| 44 | `@property --x` | **整个丢弃** | 不支持 | N10：全局注册、无作用域，与 G8「私有变量不改名」互斥 |
| 45 | `@counter-style <name>` | `<前缀>-<name>` | 映射 | 同类全局名称风险 |
| 46 | 主题自带 `@layer` | 丢弃 | 不支持 | 会注入应用的层命名空间、破坏 `base/theme/user` 层序 |
| 47 | `@page` / `@namespace` / 其它未登记 at-rule | 丢弃 | 不支持 | 保守丢弃并登记（不做猜测映射） |

## 3. 主题元数据（G11 首落地口径）

| 项 | 口径 |
|---|---|
| 归一化 | 去空白 → 小写 → 空格/下划线/`#`/路径分隔符等标点 → `-`（折叠）→ 保留中文与字母数字、**剔除 emoji 与其它符号** → 超长截断（>64 → 48 + `-<hash8>`）→ 全空回落 `theme-<hash8>` |
| `themeId` | `user:<slug>` / `bundled:<slug>`（**不依赖路径**；`vue.css` 与 `vue-dark.css` 是两个 id） |
| 成对识别 | `-dark` / `-light` 后缀 → `variantOf` 互指；`<name>-dark.css` 而 `<name>.css` 不存在 → 独立主题（登记）；`<name>-dark-dark.css` → 只剥一层 |
| `mode` 判定 | 文件名后缀 > 主题内声明（清单字段 / `/* inkling-mode: dark */` 标记）> 启发式（`prefers-color-scheme: dark` 或 `color-scheme: dark`）；用户可覆盖（`modeOverride`，归 #225） |
| 扫描范围 | **不递归**；只识别 `.css`（`.scss` 等跳过并登记）；与主题同名的目录视为资源目录（大小写不敏感） |
| 大小写冲突 | 同目录两个文件归一化后同名 → 取先出现者，其余登记（Windows/macOS 文件名不敏感） |

## 4. 基线主题集实测（复算记录，2026-10-07）

输入：6 款真实 Typora 主题（`github` / `newsprint` / `night` / `pixyll` / `vue` / `vue-dark`，合计 666 条规则，其中 51 处 `!important`）。
运行 `scripts/theme-compat-report.ts` 的结论：

| 主题 | themeId | 规则（入→出） | 改写中位耗时 | 根级收敛 | 选择器丢弃 | 变量拒绝 | 名称前缀（**声明侧**） | 引用重写 | URL 重写 | `@import` 内联 / 丢弃 | `!important` 剥离 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| github.css | `user:github` | 81 → 63 | 5.03 ms | 10 | 44 | 0 | 4 | 1 | 4 | 0 / 0 | 1 |
| newsprint.css | `user:newsprint` | 115 → 74 | 4.52 ms | 8 | 95 | 0 | 4 | 2 | 4 | 0 / 0 | 0 |
| night.css | `user:night` | 182 → 92 | 7.92 ms | 20 | 228 | 0 | 0 | 0 | 0 | 3 / 1 | 0 |
| pixyll.css | `user:pixyll` | 91 → 72 | 4.69 ms | 8 | 47 | 0 | 8 | 4 | 8 | 0 / 0 | 0 |
| vue-dark.css | `user:vue-dark` | 155 → 79 | 4.59 ms | 26 | 172 | 0 | 0 | 0 | 0 | 1 / 12 | 0 |
| vue.css | `user:vue` | 85 → 67 | 3.49 ms | 27 | 45 | 0 | 0 | 0 | 0 | 1 / 15 | 0 |

**§D1 体积与耗时（实测，非估算）**：

| 项 | 数值 |
|---|---|
| 兼容层模块打包（postcss + selector/value parser + 本层全量，min） | **146 KB**（**42.3 KB gzip**） |
| 单主题改写（7–17 KB 真实主题，含 `@import` 预读 I/O） | 中位 **3.5–7.9 ms** |
| 大主题外推（256 KB 合成主题，仅解析） | 约 38 ms |

> 结论：一次性改写成本可忽略（主题切换/启动时一次），体积 42.3 KB gzip 相对现有 `vendor_mermaid`（935 KB gzip）可接受；#225 需要时可按主题块做动态导入。


**诊断分类合计**：`dropped-selector` 631 · `scoped-root` 99 · `private-token-scoped` 46 · `stripped-important` 29 · **`prefixed-name` 16**（声明侧重命名：`Open Sans`×4 / `PT Serif`×4 / `Merriweather`×4 / `Lato`×4）· `rewritten-ref` 7（引用侧：`font-family` 用法）· `rewritten-url` 16 · `dropped-import` 5 · `dropped-at-rule` 4。

> 3 款带自定义字体的基线主题（github / newsprint / pixyll）**实测覆盖了 D9 的字体侧**：`@font-face` family 全部改名为 `t<themeHash8>-<原名>`，引用侧同步；通用族 / 系统族 / `local()` 一律不改名（单测负例③）。`@keyframes` / `@counter-style` 在 6 款基线主题中**未出现**，由自研合成主题 + 单测/E2E 覆盖（`sample-theme.css`：`fade-in` / `sample-dots`）。

**丢弃构成**（矩阵行来源）：窗口级 UI 规则 ≈ 520 条、CodeMirror 专有规则 ≈ 45 条、专注模式装饰（`.md-focus`）38 条、其余为混合列表里不可映射项。

**产物不变量（脚本强校验，6 款主题全部通过）**：无 `@import` 残留 · 无指向 asset 的样式表 · 无 `.cm-*`/`.CodeMirror*` 选择器（注释文本除外）· 前缀恒为 2 段 `.editor-scroll .milkdown`。

> 说明：主题 CSS 只到**编辑区容器**级（`.editor-scroll .milkdown`），外壳（顶栏/标签栏/侧边栏/状态栏/弹层）无主题规则命中 —— 这是「作用域不外溢」的机器可查证据（E2E 亦断言三层一致，见 §6）。

### 4.1 基线主题集（设计集 `99` §5「实施时填入实际名称与来源」→ 本表回填）

设计集预留 B1/B2/B3 三档（明色 / 暗色 / **自带自定义字体**）。本轮实际纳入 **6 款**（来源：`theme.typora.io` 社区主题，实测时以原始未改动 `.css` 直接喂流水线；**第三方 CSS 不入库**，许可合规归 #308）：

| 槽位 | 主题 | 明/暗 | 自带字体 | 体积 | 事实（实测） |
|---|---|---|---|---|---|
| B1 | `github` | light | 否 | 8.0 KB | `@font-face`×4（`Open Sans`，远程）；`url()`×5 |
| B1 | `newsprint` | light | 否 | 10.3 KB | `@font-face`×4（`PT Serif`）；远程 `url()`×3 |
| B1 | `pixyll` | light | 否 | 10.2 KB | `@font-face`×8（`Merriweather`+`Lato`）；本地+远程 `url()`×10 |
| B2 | `night` | dark | 否 | 16.3 KB | `@import`×3（含**目标缺失**的 `night/mermaid.dark.css` → 降级路径实测） |
| B2 | `vue-dark` | dark | 否 | 12.9 KB | `@import`×1；`!important`×12 |
| B1 | `vue` | light | 否 | 6.8 KB | `@import`×1；`!important`×15 |
| B3 | —— **待补** | —— | **是** | —— | 6 款均无「随包字体文件」（字体或远程、或 `local()` 系统族）→ 本轮以自研 `sample-theme.css`（`url("fonts/sample.woff2")` + `local()` 回退链）覆盖字体**文件**侧的单测，真机样本由 #307 主题包补齐 |

**验收口径**：上述主题**未经任何修改**放入主题目录后，核心 Markdown 元素视觉与 Typora 一致，或差异已登记于 §5。

## 5. 已知差异登记（编号沿用设计集 `99` §4；本表为**实施回填**）

| 设计编号 | 差异 | 实施状态与证据 |
|---|---|---|
| D1 | 主题 CM5 语法高亮不生效 | **已实现**：`.cm-*` / `.CodeMirror*` 一律丢弃（G1）；6 款基线主题实测丢弃 CM 专有规则 ≈45 条 |
| D2 | 远程字体/样式表不加载 | **已实现（降级）**：远程 `@import` 直接丢弃（不产生请求）；远程 `url()` 原样保留交由 CSP 拦，E2E 断言「不报错、不白屏」 |
| D3 | 本地字体/背景图加载 | **已实现**：`url()` → `convertFileSrc` 绝对 URL（§C9），`local()` 保留、多候选 `src`/`format()`/`image-set()` 全覆盖；单测 5 类输入 × 全部位置 |
| D4 | 根级背景不透出到外壳 | **已实现**：根级选择器收敛到 `.editor-scroll .milkdown`（6 款主题实测 99 处）；E2E 断言外壳四区计算样式逐项不变 |
| D5 | `!important` 处置（N3 收窄） | **已实现**：仅 theme 层剥离（G12），实测 29 处；`@layer user` 不剥 |
| D5b | 主题私有 `:root` 变量 | **已实现**：原样保留 + 作用域收敛（46 处 `private-token-scoped`），不改名 |
| D5c | 本地 `@import` | **已实现**：读取并内联（实测 5 处）；目标缺失 → 丢弃 + 登记（5 处，见下 D10 追加项） |
| D6 | 表格斑马纹 | 不属本层（#223 现状/#226 侧） |
| D7 | Mermaid 内置色板 | 不属本层（#226） |
| **D8** | 白名单通用名碰撞（N6） | **扫描完成 = 零碰撞**：6 款基线主题全部 `--x` 声明 ∩ 应用白名单 = **0** → G8 默认拒绝足够，**无需例外白名单** |
| D9 | `@keyframes` / `@font-face` / `@property` 名称 | **已实现**：声明侧 16 处改名（`Open Sans`/`PT Serif`/`Merriweather`/`Lato` 实测）+ 引用侧 7 处同步；通用族/系统族/`local()` **不改名**（负例①③）；`@property` 整个丢弃；`@keyframes`/`@counter-style` 由合成主题 + 单测/E2E 覆盖（真实主题未使用） |
| D10 | BOM / `@charset` / `@import` 表首语义 | **已实现**：第 0 步剥 BOM + `@charset`，LF 归一，hash 基于规范化文本；单测覆盖 |
| D11 | `<style>` 写入方式 | 不属本层（#225，S15 兜底） |
| D12 / D13 | 预装主题落地/升级/体积分档 | 不属本层（#307/#308） |
| D14 / D15 | PNG 导出重复注入 / katex 懒加载 | 不属本层（#226 / #224 已交付） |
| D16 / D17 | 预装清单载体 / 覆盖命中的回滚 | 不属本层（#308） |

### 5.1 实施期新增登记（设计集 `99` §4「必须随实施补充」）

| # | 差异 | 原因 | 处置 |
|---|---|---|---|
| D18 | `.md-task-list-item > input`（复选框样式）不生效 | 本应用任务项 DOM **不含 `input`**（勾选态在 `li[data-checked]`） | 登记为不支持；**建议新 issue**：为任务项渲染等价复选框（否则主题的勾选样式永远不命中） |
| D19 | `.task-list`（任务列表**容器**）样式不生效 | CSS 无父选择器，容器节点无对应类 | 登记降级；可选增强：`:has()`（当前未启用，避免对老内核的兼容风险） |
| D20 | `:where()` 参数前缀化后特异性仍为 0 | CSS 语义如此（与 Typora 行为一致） | 无需处置 |
| D21 | 窗口级 UI 选择器（`#typora-sidebar`/`.outline-*`/`.btn*`/`.modal*` …）全部丢弃 | Epic 非目标（不实现窗口级 UI 皮肤） | 登记；实测 ≈520 条规则被丢弃 |
| D22 | 主题内 `@import` 目标缺失（真实主题常见） | 主题包可选资源未随包提供（如 `night/mermaid.dark.css`） | 丢弃该 `@import` + 登记，不报错/不白屏（vue-dark 实测 12 处、vue 15 处、night 1 处） |
| D23 | 主题自带 `@layer` / `@page` / `@namespace` / `@scope` 声明被丢弃 | `@layer` 会注入应用层命名空间、破坏 `base/theme/user` 层序（G5）；`@page`/`@namespace` 无对应宿主；`@scope` 归入「未登记 at-rule」 | 一律丢弃 + 登记（`@layer`/`@page`/`@namespace` 有具名原因，其余走「未登记 at-rule 保守丢弃」分支；实测共 4 处） |

## 6. 自动化边界（哪些能自动、哪些必须真机）

| 层 | 覆盖 |
|---|---|
| 单测（`tests/theme/*`） | 选择器三分类 / I1 前缀深度不变量 / `:is()`·`@media`·嵌套 / 变量白名单四种输入 / `!important` 剥离 / `@import` 内联（含循环、深度、缺失）/ URL 重写五类输入 × 全部覆盖位置 / I3 全局名称三类 + 三条负例 / BOM·`@charset` 规范化 / `@property` 丢弃 / 元数据（G11 五条）/ 解析失败整包拒绝 |
| 产物级（`scripts/theme-compat-report.ts`） | 6 款真实主题逐条不变量（上文 §4） |
| E2E（`tests/e2e/typora-shim.spec.ts`） | 真实注入：主题生效（标题/表格/行内代码/引用计算样式变化）+ **外壳三层不变**（token 级 / 全局名称级 / 选择器命中级）+ 远程资源被拦**不报错、不白屏** + 主题在 dark 与 `@layer` 下仍覆盖基线 |
| 发版前真机（**本机/CI 测不到**） | ① `@layer` / `@scope` 三平台矩阵（下表）；② release 包实际响应头（`style-src` 不含 nonce）与本地字体/背景图端到端加载；③ `convertFileSrc` 真机返回值形态；④ 多窗口/重启后主题一致性 |

### 增强层平台矩阵（`@layer` 为 G5 必需，`@scope` 仅增强）

| 平台 | WebView | `@layer` | `@scope` | 本层行为 |
|---|---|---|---|---|
| Windows | WebView2（Chromium） | ✅ 实测（Chromium 151：层序/层内规则解析正常） | ✅ | 主路线 |
| macOS | WKWebView（Safari 内核） | 需 Safari 15.4+ → **发版前真机确认** | 需 Safari 17.4+ | 不支持 `@scope` 时静默降级为纯前缀改写（本层不依赖 `@scope`） |
| Linux | WebKitGTK | ≥ 2.36 → **发版前真机确认** | 版本相关 | 若不支持 `@layer`：走设计集 `05` §4.5 预写的**回退方案**（单一样式宿主 + 显式插入协议），此时 `S12`/`S13` 标 N/A、`S7` 恢复优先级证据地位；`S14`（全局名称）仍适用 |

## 7. 行来源：Typora DOM 类名 + 选择器形态清单（实测抽取）

抽取自 6 款基线主题（脚本见 `scripts/theme-compat-report.ts` 的姊妹探针，未入库）：

- **文档内容命名空间**：`#write`（78 次）、`.md-fences` `md-lang` `md-toc` `md-meta-block` `md-image` `md-inline-math` `md-math-block` `mathjax-block` `md-diagram-panel` `md-task-list-item` `task-list` `md-footnote` `md-tag` `md-attr` `md-rawblock*` `md-focus` `md-focus-container` `md-image > .md-meta` `md-toc-item` `md-toc-content`
- **窗口级 UI 命名空间**（非目标）：`#typora-sidebar` `#typora-quick-open` `#top-titlebar` `#md-notification` `#md-searchpanel` `#spell-check-panel` `#toc-dropmenu` `#recent-file-panel` `#file-info-*` `.megamenu-*` `.outline-*` `.file-node-*` `.file-list-item*` `.btn*` `.dropdown*` `.modal*` `.context-menu` `.code-tooltip` `.ty-*` `.typora-*` `.mac-*` `.html-for-mac` `.auto-suggest*` `.nav-group*`
- **代码编辑器命名空间**（G1 丢弃）：`.CodeMirror*`（含 `-gutters` / `-lines` / `-wrap` / `-code` / `-cursor`）、`.cm-s-inner` / `.cm-s-typora-default` / `.cm-header` / `.cm-link` / `.cm-string` / `.cm-atom` / `.cm-error` / `.cm-positive|negative|constant|defined|strong|invalidchar`
- **常用标签**：`table`(56) `a`(55) `h1..h6` `ol/ul/li` `code`(30) `p` `tt`(27) `pre` `blockquote` `th/td/thead` `div` `hr` `strong` `input`(32，多为复选框)
- **常用伪类**：`:hover` `:before` `:first-child` `:not` `:nth-child` `:focus` `:checked` `::selection` `::-webkit-scrollbar*`
- **at-rule**：`@font-face`(16) `@media`(16) `@import`(5) **`@include-when-export`(4，Typora 专有，本层翻译为 `@media print`）**
- **声明高频属性**：`color` `font-size` `background-color` `background` `margin*` `padding*` `line-height` `border*` `font-weight` `font-family` `border-radius` `content` `box-shadow` `-webkit-font-smoothing`
