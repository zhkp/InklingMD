# 第三方组件与主题署名（THIRD-PARTY）

> 本文件是**第三方作品**的署名与许可清单，与项目贡献者名单分列、不合并。
> 生成与校验：`npm run check:theme-licenses`（`scripts/check-theme-licenses.mjs`）；发版登记见 `docs/theme-licenses.json`。
> 登记对象是**安装包内的只读源副本** `src-tauri/resources/themes/`（不查用户机器上的运行时副本）。

## 预装主题（Typora 生态，未修改内容）

### drake

- 预装主题 id：`bundled:drake`、`bundled:drake-dark`（明暗成对，同一上游作品）
- 上游：https://github.com/liangjingkanji/DrakeTyporaTheme（版本 `2.9.6`，commit `93187ff893a51177fc33421d3810acd37a5a7890`）
- 许可：**MIT**，全文见 `docs/licenses/drake-LICENSE`
- Copyright (c) 2023 劉強東
- 随包文件：`drake.css`（上游 `drake-light.css`，25734 字节，sha256 `ca49fc1c10b47522…`）、`drake-dark.css`（上游 `drake-dark.css`，27003 字节，sha256 `88df57d0125441c6…`）
- 修改说明：仅**文件重命名**（让「`<name>.css` ↔ `<name>-dark.css`」的成对命名规则成立）；CSS 内容逐字节未改（sha256 见 `docs/theme-licenses.json`）。
- **未随包资源**：上游的字体相关文件（drake/font.css（字体声明文件 1 KB，其内 @font-face 引用的字体文件同样未随包））——本应用字体策略为**默认降级系统字体、不内嵌**（尤其中文大字体），故不随包分发；相应字体声明失效后由系统字体接管。

### lapis

- 预装主题 id：`bundled:lapis`、`bundled:lapis-dark`（明暗成对，同一上游作品）
- 上游：https://github.com/YiNNx/typora-theme-lapis（版本 `v1.2.1`，commit `697a9c4f53e6f3653bec0395b2a6da984e41a0c4`）
- 许可：**MIT**，全文见 `docs/licenses/lapis-LICENSE`
- Copyright (c) 2024 YiNN
- 随包文件：`lapis.css`（上游 `lapis.css`，16638 字节，sha256 `fea96d3541e14797…`）、`lapis-dark.css`（上游 `lapis-dark.css`，6926 字节，sha256 `6d0c9498ebcbfe71…`）
- 修改说明：仅**文件重命名**（让「`<name>.css` ↔ `<name>-dark.css`」的成对命名规则成立）；CSS 内容逐字节未改（sha256 见 `docs/theme-licenses.json`）。
- **未随包资源**：上游的字体相关文件（lapis/Cantarell-VF-fixed.otf 0.1 MB、lapis/JetBrainsMono-Regular.ttf 0.3 MB、lapis/SourceHanSerifCN-Medium.ttf 13.4 MB、lapis/SourceHanSerifCN-Bold.ttf 13.5 MB）——本应用字体策略为**默认降级系统字体、不内嵌**（尤其中文大字体），故不随包分发；相应字体声明失效后由系统字体接管。

### notion

- 预装主题 id：`bundled:notion`、`bundled:notion-dark`（明暗成对，同一上游作品）
- 上游：https://github.com/adrian-fuertes/typora-notion-theme（版本 `v1.2.1`，commit `e3d9a50524378a401df7bde792773e71f2a90cd6`）
- 许可：**MIT**，全文见 `docs/licenses/notion-LICENSE`
- Copyright (c) 2022 adrian-fuertes
- 随包文件：`notion.css`（上游 `themes/classic/notion-light-classic.css`，17088 字节，sha256 `57632cb39bf6a1fa…`）、`notion-dark.css`（上游 `themes/classic/notion-dark-classic.css`，17152 字节，sha256 `2110082e05d5815f…`）
- 修改说明：仅**文件重命名**（让「`<name>.css` ↔ `<name>-dark.css`」的成对命名规则成立）；CSS 内容逐字节未改（sha256 见 `docs/theme-licenses.json`）。

## 字体与图标

- 预装主题**不随包分发任何字体文件**；中文字体不内嵌（单个常见 5–20 MB）。
- 应用自身使用的 KaTeX / Mermaid 等依赖按其自身许可分发（见 `package.json` 与各自仓库）。
