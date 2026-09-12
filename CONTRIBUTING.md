# 贡献指南

感谢你对 InklingMD 的兴趣！无论是提 issue、修 bug、加功能还是改文档，都非常欢迎。

## 行为准则

请保持友善、尊重所有贡献者。技术讨论对事不对人，禁止任何人身攻击或歧视性言论。

## 如何贡献

### 报告问题 / 提建议

1. 先在 [Issues](https://github.com/zhkp/InklingMD/issues) 搜索是否已有人提过，避免重复。
2. 没有的话新建 issue，选择对应模板（Bug 报告 / 功能建议），按模板填写：
   - **Bug**：复现步骤、预期结果、实际结果、环境（OS / InklingMD 版本）、截图或日志。
   - **功能建议**：想解决什么场景、期望的效果、是否有替代方案。

### 提交代码

1. **Fork** 本仓库并 clone 到本地。
2. 基于最新 `main` 创建分支：`git checkout -b fix/xxx` 或 `feat/xxx`。
3. 安装依赖：`pnpm install`。
4. 开发，确保以下检查通过：
   - `npx tsc --noEmit` 无类型错误
   - `pnpm build` 构建成功
5. **提交规范**：commit message 建议用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：
   - `fix: 修复中文句号字形`
   - `feat: 新增导出长图功能`
   - `docs: 更新 README`
   - `refactor: 重构分屏状态管理`
   - `chore: 升级依赖`
6. **Pull Request**：
   - PR 标题同 commit 规范。
   - 在 PR 描述中说明改了什么、为什么改、如何测试。
   - 若关联 issue，写明 `Closes #xxx`，合并后会自动关闭对应 issue。
   - 一个 PR 只做一件事，便于 review 与回滚。

### 开发环境与系统依赖

#### Linux 系统依赖（Ubuntu / Debian）
在 Linux 下编译或运行 Tauri 开发环境需先安装系统依赖库：
```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

#### Pandoc 导出支持（可选）
如需本地调试或使用「导出 Word (.docx)」功能，请确保系统已安装 Pandoc：
- 官方安装指引：[https://pandoc.org/installing.html](https://pandoc.org/installing.html)
- macOS: `brew install pandoc`
- Ubuntu / Debian: `sudo apt-get install pandoc`
- Windows: `winget install JohnMacFarlane.Pandoc` 或 `choco install pandoc`

#### 本地启动与测试命令
```bash
pnpm install      # 安装前端依赖
pnpm dev          # 启动开发服务器（浏览器 + mock 工作区）
pnpm tauri dev    # 启动 Tauri 桌面应用开发模式
pnpm test         # 运行 Vitest 单元与组件测试
pnpm e2e:install  # 安装 Playwright 浏览器内核（首次运行 E2E 时必需）
pnpm e2e          # 运行 Playwright 端到端测试
pnpm benchmark    # 运行编辑器性能 Benchmark（见下节）
pnpm build        # 构建前端资源
pnpm tauri build  # 打包桌面应用
```

> 浏览器 `pnpm dev` 模式下会使用 mock 工作区，方便脱离 Tauri 环境调试 UI。

## 性能 Benchmark（性能回归防线）

一条命令跑完 6 个场景（打开 / 输入 / 滚动 / 编辑内查找 / 标签切换 / 保存），与基线自动比较，
用于回答「这次改动有没有把性能改坏」。详细设计见 `tests/perf/` 目录内的注释。

```bash
pnpm run benchmark                       # quick 档：1k 行 + 5k 行，共 16 个组合
pnpm run benchmark -- --profile=full     # 追加 2 万行档
pnpm run benchmark -- --profile=xl       # 追加 5 万行档（仅本地，CI 不跑）
pnpm run benchmark -- --update-baseline  # 用本次结果重建基线
pnpm run benchmark -- --scenario=open,scroll
PERF_PORT=3000 pnpm run benchmark        # 本机端口冲突时改端口（Windows 保留 1350-2149）
PERF_REPEAT=3 pnpm run benchmark         # 覆盖采样轮数（quick 默认 2、full/xl 默认 3）
```

参数同时支持 argv 与环境变量两种写法（如 `--scenario=a,b` 与 `PERF_SCENARIO=a,b`），
未知参数会直接报错退出而不是静默忽略——静默忽略曾让 `--scenario` 变成"跑了却没过滤"的死参数。

采样轮数决定每个标量指标有几个样本：quick 档从 1 提升到 2，是因为 `rounds=1` 时标量只有
**一个样本、没有任何平均**，共享 runner 的抖动足以让 `longTaskMs` 自然波动 35%（实测）。
轮数同时是基线可比性的一维——**改轮数必须重建基线**（`--update-baseline`）。

### 测量口径（先看这条，避免误读）

- 运行时是 **Playwright chromium + vite dev server（未压缩、含 HMR）**，绝对值不代表生产构建；
- CI 无 GPU，测量值只用于**同环境纵向对比**（基线按 `env` + `profile` 隔离，本地数与 CI 数永不互比）；
- 真机 WebView2 / WKWebView 表现仍需发版前人工验证。

### 高刷与帧预算

headless chromium 的渲染被锁在 60Hz（帧间隔地板 ~16.7ms），**测不出 120fps 目标**。两条路径：

```bash
PERF_HEADED=1 pnpm run benchmark                    # 有头运行，vsync 跟随显示器（需高刷屏）
PERF_UNCAPPED=1 PERF_FRAME_BUDGET_MS=8.3 pnpm run benchmark   # 解除 vsync 上限
```

`PERF_UNCAPPED=1` 会解除帧率上限，此时帧间隔反映**单帧真实工作耗时**，因此可以在任意显示器上
判断「是否装得进 8.3ms（120fps）预算」。`PERF_FRAME_BUDGET_MS` 默认 16.7（60Hz），高刷目标设 8.3。

这两条路径同时也是**绝对阈值判定的启用条件**：headless 下不产出绝对判定（原因见下节「判定规则」）。

### 测自己的压测文档

```bash
PERF_DOC_FILE=md_editor_stress_test.md pnpm run benchmark
```

设置后只跑这一份文档（不再跑生成档位与纯文本对照），内容指纹进入基线——**换文档即基线自动作废**。

生成 fixture 是按"真实压测负载"设计的：除基础 Markdown 结构外，每 10 节含一个 mermaid 块
（本项目最重的渲染元素）、每 5 节含一张真实可解码的图片。这是**有意为之**——负载太轻会测不出
真实卡顿；代价是大档位在无 GPU 的 CI 上更接近帧预算边界，因此 CI 侧只做相对回归判定。

### 判定规则

- 相对判定：耗时/帧间隔的 **median 与 p95 都参与比较**（周期性尖刺在 median 上看不出来）；
  掉帧率、long task 数等标量同时比较；默认劣化阈值 15%，p95 放宽 10 个百分点。
  小量级指标另有**绝对地板**（如 `inputSyncMs` 需 Δ≥1ms、`saveMs` 需 Δ≥8ms）——
  阈值必须高于该指标的实测噪声地板，否则就是在判定抖动；各地板的实测依据写在
  `tests/perf/judgment.js` 的 `METRIC_RULES` 注释里。
  小量级指标另有**绝对地板**（如 `inputSyncMs` 需 Δ≥1ms、`saveMs` 需 Δ≥8ms）——
  阈值必须高于该指标的实测噪声地板，否则就是在判定抖动；各地板的实测依据写在
  `tests/perf/judgment.js` 的 `METRIC_RULES` 注释里。
- 绝对判定（不依赖基线，首次运行也生效）：滚动场景的帧间隔 p95 不得超过 `2 × 帧预算`，
  掉帧率不得超过 10%（`PERF_JANK_RATE_LIMIT` 可调整）。
  **默认只在定向模式下启用**：`PERF_HEADED=1`（vsync 跟随显示器）或 `PERF_UNCAPPED=1`
  （解除帧率上限，帧间隔反映单帧真实工作耗时）。
  headless（本地默认，与 CI 一致）**不产出绝对判定**——此时 vsync 锁 60Hz，帧间隔反映的是
  显示器节拍而非单帧工作耗时，判定衡量的是"这台机器此刻忙不忙"而不是代码质量；
  若默认启用，无 baseline 的首次运行就会因掉帧率贴线而打印「回归确认」并以 exit 1 结束，
  与真实回归无法区分。`PERF_ABSOLUTE=1` 可强制开启（调试/复现用），`=0` 可强制关闭。
  绝对判定所依赖的模式会随采样一起落盘，因此事后单独复算不会改变结论。
- **判定分层**：只有主指标（`ttiMs` / `frameMs` / `switchMs` / `searchMs` / `saveMs` / `inputSyncMs` /
  `inputPaintMs`，含其 `.p95`）可以**单独**判 FAIL；派生指标（`longTaskMs` / `longTaskCount` /
  `jankRatePct` / `cls` / `heapDeltaMB` 等，以及未登记的新指标）需要**同一场景内有主指标同样超阈值**才判 FAIL，
  否则降级为 WARN 并标注「派生指标无主指标佐证（疑似运行抖动）」。
  依据：同一份代码在共享 runner 上，派生标量能自然波动 35%，没有主指标佐证的"回归"不可行动；
  而真正影响用户可感知耗时的退化必然会体现在主指标上。新增指标想获得"单独判 FAIL"的能力，
  必须显式加进 `tests/perf/judgment.js` 的 `PRIMARY_METRICS`。
- 「连续 2 次复现」：首轮超阈值 → 自动只复测该场景 → 仍超阈值判 FAIL，回落判 WARN（抖动）。
  只有"可行动"的超阈值才触发复测（派生指标无佐证时不复测，避免为抖动多跑一轮）。
  FAIL 摘要区分「相对回归确认」与「绝对目标未达标」，两者成因不同。
- 掉帧定义：帧间隔 > `1.5 × 帧预算`（60Hz → >25ms），避免把 vsync 抖动当卡顿。

### 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 跑完且无确认回归（含仅 WARN、首次运行无基线） | 正常 |
| 1 | 回归复现（连续 2 次超阈值） | 看 `.perf-output/report.md` 定位 |
| 2 | 没测到（server 起不来、场景缺失等 infra 故障） | 先修测量链路，别当成"没回归" |

CI 上 Benchmark **不阻断合并**，只上传 `.perf-output/` 产物并写入 Job Summary。

### 基线维护

- 本地：`pnpm run benchmark -- --update-baseline`，结果落在 `.perf-baseline/local/`（已 gitignore）。
- CI：Actions → **Benchmark** → Run workflow，勾选 `update_baseline`（档位选 quick），
  跑完从 artifact 取回 `.perf-baseline/<profile>/` 并提交；不勾选时 CI 只做比较，不会写仓库。
- 任何 fixture 生成规则变更都必须提升 `FIXTURE_VERSION`，旧基线会自动整体作废。
- 可比性校验现在覆盖 **env / profile / mode / rounds / fixture** 五维：改采样轮数、改测量模式
  （headless ↔ headed/uncapped）都会让旧基线整体不可比——报告里会显式列出
  `未参与相对判定：ROUNDS_MISMATCH(...)` 之类的原因，重建即可。

## 代码风格

- TypeScript，优先使用类型而非 `any`。
- React 函数组件 + Hooks，避免 class 组件。
- 样式用 CSS（非 CSS-in-JS），新增样式按现有 `App.css` / 组件 `.css` 的命名风格。
- 注释用中文（与现有代码库保持一致），说明「为什么」而非「是什么」。

## 目录结构概览

```
src/
├── components/      # React 组件（Editor / Sidebar / Tabs / Outline 等）
├── store/           # Zustand 状态管理（workspace / theme / ui / shortcuts）
├── lib/             # 工具库（fs / exporter / outline / newWindow 等）
├── App.tsx          # 主应用入口与布局
└── App.css          # 全局样式
src-tauri/           # Tauri 后端（Rust）
docs/                # 需求文档、设计文档
```

## 关于 License

提交的代码将遵循项目的 [MIT License](./LICENSE)。
