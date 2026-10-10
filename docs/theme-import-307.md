# #307 主题导入、主题目录规范与管理面板（实施说明）

> 对应设计集 `06-主题导入与目录管理.md` 与 issue #307。上游：#225（主题包机制 / 反 FOUC / 层序）、#306（Typora 兼容层）、#223/#224（令牌与回归防线）。
> 本文件只写**实施落地口径与证据**；设计取舍的原文见设计集。

## 1. 主题目录规范

对标 Typora 的应用数据目录（`§2` 已裁决）：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%/inklingmd/themes/` |
| macOS | `~/Library/Application Support/inklingmd/themes/` |
| Linux | `~/.config/inklingmd/themes/` |

- 一个主题 = 一个 `<name>.css` + **同名可选资源目录** `<name>/`（字体/图片）。
- 备份目录 `.backup/<时间戳>/`：**隐藏项**（扫描/清单都不含它），「覆盖 / 移除」时旧文件移入此处**可恢复**。
- 导入暂存目录 `.staging/<时间戳>/`：`.css` / `.zip` 先落暂存再按包结构归一化，成功与否都清理。
- 运行时用 `appDataDir()` 解析（前端 `@tauri-apps/api/path`），`assetProtocol.scope` 已含 `$APPDATA/**`。
- 「打开主题文件夹」= opener 的 `revealItemInDir`（capability 补 `opener:allow-reveal-item-in-dir`）。

## 2. 三条导入路径（`§3`）

| 路径 | 实现 |
|---|---|
| ① 菜单导入单个 `.css` | 复制到 `.staging/` → 归一化 → 落主题目录（**复制而非原地引用**，源文件被删不影响） |
| ② 导入压缩包 / 文件夹 | `.zip` 走 Rust `extract_zip`；文件夹走 `walkThemeDir`（递归列包内相对路径）→ 同一套归一化 |
| ③ 直接扫描主题目录 | 「刷新主题列表」按钮 + 启动时自动扫描（`syncThemes`） |

**包结构归一化（`§3.1`，纯函数 `src/theme/import.ts#normalizePackage`）**：直接接受 `<name>.css`（+ 同名目录）；包内多一层（GitHub zip 形态 `<repo>-<branch>/…`）时**只下探 1 层且要求唯一顶层**，否则不猜测并整包拒绝；`.css` 数量 ≥1；`<name>/` 与 `<name>.css` 同名即绑定；README/LICENSE 保留（署名衔接 #308）；归一化同名（`Vue.css` vs `vue.css`）取先出现者并登记。

## 3. 重名与覆盖策略（`§4` + 新-1）

| 情况 | 行为 |
|---|---|
| 内容 hash 相同 | **跳过**并提示「已存在相同主题」（不重复导入） |
| 目标命中**预装清单**（`bundled:*`） | **「覆盖」禁用** → 「复制为我的主题」（落 `user:<slug>`，占用则 `-2` 序号）或取消。理由：预装主题每次启动按源副本幂等补齐（N13），原地覆盖会被静默回滚 |
| 目标是用户主题（`user:*`） | 覆盖（旧文件移入 `.backup/`，可恢复）/ 重命名（追加序号）/ 取消 |

> 「不允许静默覆盖」是硬约束：`resolveImportConflict` 的每条路径都带人话 `reason`，最终由可见对话框汇总（导入结果 + 每条提示）。

## 4. 安全与体积（`§9`，A-2 分档）

| 项 | 处置 |
|---|---|
| 体积 | `>512 KB` **拒绝**（可读理由）；`256–512 KB` 可用但**不走快照**（恒定降级，UI 提示）；`≤256 KB` 走快照（零闪烁） |
| `url(javascript:…)` / `expression(…)` | **显式拒绝**（大小写/空白容错） |
| 远程资源 | **显式提示**：远程 `@import` 与远程字体不加载（CSP），远程图片可加载但会发网络请求（P1-7 的有意取舍，预留离线开关位） |
| 本地 `@import` | **导入/切换期递归预读并内联**（`preloadLocalImports`，深度上限 8 + 循环保护）→ 产物中不出现指向 asset 的 `@import`；**解析后的目标必须落在允许根内**（`assetRoot`，与 §C9 的 `url()` 同一判据 `isWithinRoot`），越界**丢弃且不读取** + 写 `dropped-import` 诊断（评审阻塞 2 的闭环） |
| zip slip | Rust 侧**先全量校验后落盘**：任一条目越出目标目录 → **整包拒绝**（不留半成品） |
| 压缩炸弹 | 单条 8 MB / 整包 64 MB / 2000 条上限，且**按实际写入字节判定**：zip 头里声明的 uncompressed size **不可信**（可谎报 1024 而实际展开几十 MB），落盘时逐块计数，超限即中止并清理已写文件；`ExtractReport.bytes` 报**实际**写入量（评审阻塞 1 的闭环） |
| 符号链接 | **不跟随**：扫描跳过、复制跳过、解压跳过，且**逐条登记**（不静默） |
| 注入方式 | 一律 `textContent`（`#225` 的 `inject.ts`），禁 `innerHTML` |

## 5. 优先级与旧机制迁移（`§6`）

```
① 内置基线（builtin:light/dark，App.css 变量块）
   < ② 内置/预装主题（bundled:*，兼容层输出）
   < ③ 用户 Typora 主题（user:*，兼容层输出）
   < ④ 自定义 CSS（user 层，最高，必须最终胜出）
```

- ②③ 均经 `#306` 兼容层改写：选择器收敛为 `.editor-scroll .milkdown …`（恒 2 段）、`@layer theme` 包裹、`!important` 剥离、`url()` → `convertFileSrc()` 绝对 URL（`assetRoot` = 应用数据目录，即 scope 根）。
- ④ 旧单槽位自定义 CSS（`inkling-custom-css-path`）**路径与内容都不丢**，仍走 `@layer user`，**不剥离 `!important`**（N3）→ 老用户的覆盖继续生效（`#225` 已落地，本轮保持同构）。
- 旧自定义 CSS 文件被删/移走：清持久化 + 回落默认 + **可见提示**（不再静默）。

## 6. 持久化与多窗口（`§7` / `02 §6`）

| key | 内容 | 写入方 |
|---|---|---|
| `inkling-theme` | 当前 `themeId` | 切换/读盘路径 |
| `inkling-theme-snapshot:<themeId>:<hash>` | 主题 CSS 文本快照（单主题只留最新） | 注入路径（`applyTheme`） |
| `inkling-themes-index` | 用户/预装主题**运行时索引** `{v:1, themes:[{id,name,mode,hash,variantOf,source,file}]}` | **#307 的扫描/导入路径（本轮首次接上生产写入方）** |
| `inkling-themes-hidden` | 被隐藏的预装主题 id 列表（N15） | 「隐藏」动作 |
| `inkling-theme-snapshot-state` | 快照状态位（hit/missing/slow/quota/invalid/gc） | 快照模块 |

- 全部 key 登记进 `storageSyncRegistry` 单一注册点（owner：`theme:current` / `theme:snapshot` / `theme:index` / `theme:hidden`）；`e.key === null` 不抹本窗口状态。
- **跨 key 原子性**：接收方拿到未知 `themeId` 时不切换，等清单/快照就绪（P2-3）；本窗口若能读盘，会主动补 CSS 并落快照，避免远端空等。
- 索引写入**带去抖**（内容相同不写），避免多窗口 storage 事件风暴。
- 快照 GC：启动时按**持久化清单**（不是当刻内存注册表）回收已不存在的 `themeId`。
- `index` 里的 `file` 字段（本轮追加）：slug 由文件名归一化而来，大小写敏感文件系统上无法由 slug 反推文件名；跨窗口读盘与「移除」都依赖它。

## 7. 反 FOUC（`§8`，G3）

1. 主题 CSS 文本**快照**写入 `localStorage`；`main.tsx` 顶部静态 import 主题模块，**首帧前同步**注入 `@layer theme { … }`（`#225` 已落地）；
2. 快照缺失 / 超 256 KB / 写入失败 → 首屏**回落内置基线**，随后异步读盘切换（**允许一次可见切换**，本条即登记）；
3. 层序声明唯一落点 = `index.html` 的内联 `<style>@layer base, theme, user;</style>`；
4. 断言：首帧 `data-theme` 已就位 + 层序三层 + `theme` 先于 `user`（`#225`/`#224` 的 E2E）；本轮新增「**磁盘主题**重启后首帧仍就位」（`tests/e2e/theme-import.spec.ts`）。

## 8. 预装主题机制（`§2 新-2` / N13 / N15）

- **载体**：`$RESOURCE/themes/manifest.json`（随安装包分发的**只读**清单，最小字段集 `{v:1, themes:[{slug, css, dir?, name, mode, hiddenByDefault?}]}`）；与用户运行时索引 `inkling-themes-index` **严格区分**。许可字段留在 #308 的发版登记，**不进运行时清单**。
- **落地**：`bundle.resources` 把 `src-tauri/resources/themes` 映射到 `$RESOURCE/themes`；dev（`tauri dev`）下 `resource_dir()` 指向 `target/debug`，Rust `resource_themes_dir` 回落到仓库内目录，保证开发与 E2E 可用。
- **幂等补齐（N13）**：每次启动按源副本对齐运行时副本——缺失或 hash 不一致才复制，一致则不动；用户改动只落 `user:*`，因此覆盖不伤用户数据。
- **识别（N15）**：扫描时先按清单的 `css` / `dir` 相对路径匹配 → `bundled:<slug>`，未命中才 `user:*`；**不做模糊匹配**（`vue-1.2.css` 不会被认成预装 `vue`）。
- **移除 = 隐藏**：预装条目写隐藏位（不物理删除），下次启动补齐与「用户意志」不冲突；预装不可原地编辑，提供「复制为我的主题」。
- **校验脚本**：`npm run check:theme-manifest`（`scripts/check-theme-manifest.mjs`）校验字段集 / slug 唯一 / `css`·`dir` 真实存在，并在 #308 的许可登记 `docs/theme-licenses.json` 落地后**对账两侧 slug 集合**（当前该文件未落地 → 跳过并提示）。

## 9. 错误与降级（`§10`）

| 场景 | 行为 |
|---|---|
| 主题文件被删/移动/损坏 | 扫描后不在清单 → 清持久化 + 回落默认 + **可见提示**；读盘失败同理（含「整包拒绝」的解析失败） |
| 主题目录不存在 / 无写权限 | 首启 `createDir` 自动创建（幂等）；失败则提示（「打开主题文件夹」保留上级目录入口） |
| 符号链接 | 不跟随 + 登记（扫描结果 `skipped`） |
| 多窗口并发切主题 | 快照幂等，后写者胜（无半成品）；接收方等清单/快照就绪再切 |

## 10. 验收对照与证据

| 验收项 | 证据 |
|---|---|
| 放入主题目录 → 出现在列表并被选中生效 | `tests/e2e/theme-import.spec.ts`（真实浏览器：扫描 → 列表 → 选中 → 注入产物含 `@layer theme` 与 2 段前缀） |
| 重启/新窗口后主题保持、首屏无 FOUC | 同上（reload 首帧 `data-theme-id` 已是磁盘主题；多窗口同 context 一致） |
| 旧自定义 CSS 升级后不丢、`!important` 不被剥 | `#225` 的 `tests/theme/theme-injection.test.ts`（user 层不剥 + `@import` 外提） |
| 预装主题：幂等补齐 / 隐藏 / 不误判为 user | `tests/theme/theme-catalog.test.ts`（N13 缺失/不一致/一致三态、N15 大小写与 `my-vue.css` 反例、资源目录一并补齐） |
| 预装不可被导入覆盖 | `tests/theme/theme-import.test.ts`（`bundled:*` → `duplicate-as-user`，可用选项不含 `overwrite`） |
| 预装清单载体与字段最小集 | `scripts/check-theme-manifest.mjs`（正例通过；幽灵条目 + 许可字段 → 退出码 1） + `src-tauri/resources/themes/{manifest.json,README.md}` |
| zip slip / 符号链接 / 递归复制 | Rust `src-tauri/src/commands/themes.rs` 的 8 条单测（`../evil.css` 整包拒绝且不留半成品） |
| **压缩炸弹（谎报尺寸）** | 同上：`extract_zip_rejects_lying_uncompressed_size`（把 local header / central directory 的 uncompressed size 回填成 1024、真实 12 MB → 必须拒绝且不留半成品）+ `extract_zip_report_bytes_are_actual_not_declared`（报告必须是实际字节） |
| **`@import` 越界读取** | `tests/theme/theme-disk.test.ts`：越界目标**不读取**（`readFile` 桩根本没被调用）+ 产物不含越界内容 + `dropped-import` 诊断含「越出允许根」；对称覆盖「根内 `../shared/x.css` 仍可用」与「同前缀兄弟目录不算根内」 |
| 包结构归一化 / 体积分档 / 显式拒绝 / 远程提示 | `tests/theme/theme-import.test.ts`（4 种包形态 + 三档边界 + `javascript:`·`expression()` + 远程计数） |
| 本地 `@import` 内联、资源 `url()` 重写与越界降级 | `tests/theme/theme-disk.test.ts`（与 `#306` 的解析基准、大小写键、丢弃语义逐项对齐） |

## 11. 本批已知差异与登记

| # | 项 | 说明 |
|---|---|---|
| T1 | 首屏可见切换 | 快照缺失/超 256 KB 时允许**一次**可见切换（G3-③ 既定口径） |
| T2 | 预装主题内容与许可 | 机制本轮落地；**主题内容、许可与署名归 #308**（清单当前为空）。CI 接入 `check:theme-manifest` 随 #308 的许可登记一起做（避免现在只校验空集） |
| T3 | 目录层级 >3 层 | `walkThemeDir` 上限 3 层（导入文件夹时）；§3.1 只要求下探 1 层，更深不猜测并登记 |
| T4 | 导入压缩包仅 `.zip` | 其它归档（`.tar.gz`/`.7z`）不支持，按「不是有效 zip」拒绝并提示 |
| T5 | 浏览器（E2E）无真实文件对话框 | 导入按钮在非桌面端明确提示「仅桌面端支持」；E2E 覆盖「扫描 → 列表 → 生效 → 持久化」主干，真实对话框/解压由 Rust 单测与真机核对 |
| T6 | `copy_path`（文件夹导入 / 备份 / 复制为我的主题）不做体积上限 | 其源是**用户本地目录**（与「下载来的 zip」不同信任级）；zip 解压后的暂存内容已被抽解压上限约束，因此下载路径的放大风险闭环在 `extract_zip`。若后续要收紧，可在 `copy_path` 加同一组计数上限 |
| T7 | 预装清单的 `css` / `dir` 只接受相对路径且不得含 `..` | 清单是随包只读产物，但它驱动「从源副本复制到主题目录」→ 与 zip-slip 同级判据（`parseBundledManifest` 与该条非法即跳过并登记；`check-theme-manifest.mjs` 同判据在发版侧拦截） |
