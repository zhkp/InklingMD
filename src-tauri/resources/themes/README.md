# 预装主题运行时光源副本（`$RESOURCE/themes`）

本目录是**随安装包分发的只读清单与主题源副本**，落地口径见 `docs/theme-import-307.md` 与设计集 `06`：

- `manifest.json`：预装清单（**最小字段集**），`{ v: 1, themes: [{ slug, css, dir?, name, mode, hiddenByDefault? }] }`。
  - 与**用户主题的运行时索引** `inkling-themes-index`（`localStorage`，可写）**严格区分**：这里是只读发版产物。
  - **身份识别（N15）**：扫描主题目录时先按 `css` / `dir` 的相对路径匹配清单 → `bundled:<slug>`；未命中才 `user:*`（因此清单名与文件名不一致时不会被误判）。
- **幂等补齐（N13）**：首次启动（以及每次启动）把清单里的主题按源副本复制到 `$APPDATA/inklingmd/themes/`；缺失或不一致才复制，一致则不动；用户改动只落 `user:*`。
- 预装条目在 UI 中**不允许原地编辑**（提供「复制为我的主题」），「移除」= 隐藏（持久化隐藏位，不物理删除）。
- **许可字段不进运行时清单**：`upstream` / `commit` / `license` / `attribution` 等登记在 #308 的发版登记里。

新增预装主题时：把 `<name>.css`（与同名资源目录 `<name>/`）放进本目录，并在 `manifest.json` 里登记一条；随后跑
`node scripts/check-theme-manifest.mjs` 校验字段、slug 唯一性与文件是否存在。
