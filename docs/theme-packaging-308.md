# #308 预装 Typora 主题：选型、许可合规与署名（实施说明）

> 对应设计集 `07-预装主题与许可合规.md` 与 issue #308（Theme Epic 关键路径终点）。前置：`#223` / `#225` / `#306` / `#307`。
> 本文件写**实施口径与实测数字**；设计取舍原文见设计集。发版登记见 `docs/theme-licenses.json`，署名见 `THIRD-PARTY.md`。

## 1. 选型结果（3 款 / 3 对明暗 / 随包 108 KB）

| 预装 themeId | 上游 | 版本 / commit | 许可 | 随包 CSS |
|---|---|---|---|---|
| `bundled:drake` / `bundled:drake-dark` | `liangjingkanji/DrakeTyporaTheme`（3552★） | `2.9.6` / `93187ff893a5…` | MIT | `drake.css`(25.7 KB) + `drake-dark.css`(27.0 KB) |
| `bundled:lapis` / `bundled:lapis-dark` | `YiNNx/typora-theme-lapis`（565★） | `v1.2.1` / `697a9c4f53e6…` | MIT | `lapis.css`(16.6 KB) + `lapis-dark.css`(6.9 KB) |
| `bundled:notion` / `bundled:notion-dark` | `adrian-fuertes/typora-notion-theme`（301★） | `v1.2.1` / `e3d9a5052437…` | MIT | `notion.css`(17.1 KB) + `notion-dark.css`(17.2 KB) |

- **只收许可证明确允许再分发**的作品：候选池里 `typora/theme.typora.io`、`Theigrams/My-Typora-Themes`、`sumruler/typora-theme-phycat` 等热门仓库**无 LICENSE 文件** → 按 `07` §3.2 **一律不得内置**（可用 `#307` 的导入链路「一键安装」，但不由我们再分发）。
- **明暗成对**优先 ✓（三款都是 pair，菜单支持一键切换变体）；`≤256 KB` 体积 → **保住「零闪烁」**（走快照，`E4` 只对 ≤256 KB 成立 ✓）。
- 文件命名归一：Drake 上游是 `drake-light.css`，为让「`<name>.css` ↔ `<name>-dark.css`」的成对命名规则（`#306` G11-3 / `variantOf`）成立，**仅重命名**为 `drake.css`；Notion 取 `classic` 变体并同理重命名。**CSS 内容逐字节未改**（sha256 见登记与门禁）。
- 与 `#226`（自研内置主题扩充 ≥4）**并行不重复**：本批只做「第三方预装」；合计 ≥6 由两者相加达成。

## 2. 许可合规（硬门槛，脚本保证而非口头约定）

- **登记**：`docs/theme-licenses.json`（`07` §3.1 字段：`slug` / `id` / `name` / `upstream` / `version` / `commit` / `license` / `licenseFile` / `attribution` + 实施追加的 `shippedCss` / `upstreamPath` / `bytes` / `sha256` / `assets`），**per 随包 CSS 一条**（与运行时清单可直接做集合比较）。
- **许可全文归档**：`docs/licenses/<slug>-LICENSE`（三份 MIT 全文，逐字节来自上游对应 tag）。
- **署名**：`THIRD-PARTY.md`（与项目贡献者名单**分列**），逐款给上游、版本/commit、许可、Copyright、随包文件与 sha256、修改说明、未随包资源。
- **与运行时清单分列**（`07` 新-2）：许可字段**不进** `src-tauri/resources/themes/manifest.json`（那边只有 `{slug,css,dir?,name,mode,hiddenByDefault?}`）；两份清单**唯一共享字段是 `slug`**，由脚本校验集合一致。
- **门禁**：`npm run check:theme-licenses`（`scripts/check-theme-licenses.mjs`，**引入第一款第三方主题之前就先落地**）：
  1. `licenseFile` 存在；2. `license` ∈ 白名单（MIT / Apache-2.0 / BSD-2·3 / ISC / CC0 / CC-BY(-SA) / Unlicense）；3. `upstream`(https) + `version` + 40 位 `commit` 完整；
  4. `THIRD-PARTY.md` 的署名锚点存在（明暗变体指向同一上游小节）；5. **两侧 slug 集合一致**（注册没打包 / 打包没注册都拦）；
  6. **实物完整性**：随包 CSS 的字节数与 sha256 必须与登记一致（防「登记与实物漂移」）；7. **体积预算**（见 §3）。
  任一不满足 → `exit 1`；CI 的 `test` job 已在 `pnpm test` 之后加入 `check:theme-licenses` + `check:theme-manifest` 两步。
- 负例自验（本地跑过）：篡改 `license` 为 GPL / 把 `commit` 写成短 sha / 指向不存在的 LICENSE / 删掉署名小节 / 给随包 CSS 追加一个字节 → **均 exit 1**；还原后 exit 0。

## 3. 体积与字体策略（本 Issue 为唯一 owner，G2/G7）

| 项 | 数值 / 决策 |
|---|---|
| 随包 CSS 总量 | **108.0 KB**（6 个文件；预算 ≤8 MB） |
| 单文件最大 | **27,003 字节**（`drake-dark.css`；预算 ≤512 KB，且**均 ≤256 KB 快照上限**） |
| 同名资源目录 | **无**（`assets: []`）——三款主题都只发 CSS |
| 字体 | **不内嵌、默认降级系统字体**。量化依据：Lapis 上游引用的 4 个字体合计 **28.5 MB**（`SourceHanSerifCN` Medium/Bold 各 **13.4 / 13.5 MB**，即典型中文大字体），Drake 的 `drake/font.css` 声明链同样不随包 → 相应 `@font-face` 失效后由系统字体接管 |
| CSP 前提 | `font-src 'self' data: asset: http://asset.localhost;` 与 `img-src … http://asset.localhost` 已在 `#309`/`#310` 落地；`#306` 的 `url()` 重写（`assetRoot` = 应用数据目录）已落地 → 本地字体/背景图链路前提**齐备** |

## 4. 映射层实测（不是假想可用）

`node node_modules/vite-node/vite-node.mjs scripts/theme-compat-report.ts src-tauri/resources/themes --md`：

| 主题 | 输入块 → 输出规则 | 改写中位耗时 | 根级收敛 | 选择器丢弃 | `!important` 剥离 | `@import` |
|---|---|---|---|---|---|---|
| `drake.css` | 230 → 138 | 9.49 ms | 45 | 213 | 67 | 丢弃 1（`./drake/font.css` 未随包） |
| `drake-dark.css` | 242 → 138 | 11.03 ms | 45 | 236 | 67 | 丢弃 1（同上） |
| `lapis.css` | 145 → 97 | 6.29 ms | 66 | 119 | 4 | — |
| `lapis-dark.css` | 64 → 126 | 8.01 ms | 77 | 204 | 5 | **内联 1**（`@import "lapis.css"` 正常内联） |
| `notion.css` | 132 → 61 | 5.52 ms | 17 | 165 | 2 | — |
| `notion-dark.css` | 132 → 61 | 4.85 ms | 17 | 165 | 2 | — |

- **产物不变量通过**：无 `@import` 残留 / 无 asset 样式表 / 无 `.cm-*` / 前缀恒 2 段 `.editor-scroll .milkdown` ✓。
- 诊断分类合计：`dropped-selector` 1102（多为 CM 语法高亮与 Typora 窗口级 UI，Epic 非目标）、`private-token-scoped` 279、`scoped-root` 267、`stripped-important` 147、`rewritten-ref` 28、`prefixed-name` 8、`rewritten-url` 8、`dropped-import` 2、`dropped-at-rule` 2、`inlined-import` 1。
- 已知差异（沿用矩阵登记，非本批引入）：`!important` 被剥离（D1）、代码语法高亮归 `codeBlockTheme`（D1）、Typora 窗口级 UI 选择器丢弃（D21）、`@page`/`@layer` 等 at-rule 丢弃（D23）。

## 5. 与主题体系打通（N13 / N15 / 新-1）

- **落地模型**：安装包内只读源副本 `$RESOURCE/themes/`（`bundle.resources` 已映射 `resources/themes` → `themes`）→ 首启（及每次启动）**幂等复制**到 `$APPDATA/inklingmd/themes/`（缺失或与源副本不一致才复制）。
- **识别**：扫描时按清单「相对路径 → slug」先匹配 → `bundled:<slug>`，未命中才 `user:*`；**不做模糊匹配**（用户放 `drake-2.css` 不会被误判为预装）。
- **不可原地改**：菜单对预装条目给「复制为我的主题」（落 `user:*` 独立文件）；导入同名时「覆盖」禁用（`#307` §4）。
- **移除 = 隐藏**：写持久化隐藏位（`inkling-themes-hidden`），不物理删除；下次启动补齐不会让它「复活」到可见列表（`#308` E2E 第 4 条断言）。
- **不产生重复条目**：同名用户文件在清单驱动识别下仍归 `bundled:*`（同一条目），不会出现两个同名项。

## 6. 验收对照与证据

| 验收项（`07` §7） | 证据 |
|---|---|
| 预装主题 ≥2（+`#226` 合计 ≥6） | **3 款 / 3 对**（`docs/theme-licenses.json`、`manifest.json`） |
| 每款登记完整（上游 / 版本·commit / 许可 / 署名） | `npm run check:theme-licenses` exit 0（含 7 类负例自验） |
| 第三方清单随包、发版可核查 | `THIRD-PARTY.md` + `docs/licenses/*`；CI `test` job 已接入两步门禁 |
| 包体在预算内、字体策略落地并量化 | §3（108 KB / 单文件 27 KB / 0 资源 / 字体 28.5 MB 不内嵌的量化依据） |
| **无「许可不明 / 禁止再分发」主题被内置** | 白名单校验（GPL 等一律 exit 1）+ 候选池里无 LICENSE 的热门主题全部排除（§1） |
| 落地模型 N13 / 识别 N15 / 不可覆盖 新-1 | `tests/e2e/theme-bundled.spec.ts`（真实预装文件：首启复制 + `bundled:*` 识别 + 变体切换 + 隐藏不复活）；`tests/theme/theme-catalog.test.ts`（N13 三态 / N15 反例） |
| 映射层实际呈现 | §4 实测表 + 产物不变量通过 |
| 全量单测 + E2E + build | 见 PR 门禁结果 |

## 7. 后续

- 上游更新：记录 commit，**手动同步**（不做自动更新）——同步后需重跑 `check:theme-licenses`（sha256/字节会变）与矩阵脚本。
- `#226`（自研主题扩充）与本批并行；两者合计决定「内置主题总数 ≥6」的最终口径。
- 「离线模式」开关位（默认拒绝远程图片）仍未实现，与 `#307` T-登记一致。
