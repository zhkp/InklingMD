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
- 绝对判定（不依赖基线，首次运行也生效）：滚动场景的帧间隔 p95 不得超过 `2 × 帧预算`，
  掉帧率不得超过 10%（`PERF_JANK_RATE_LIMIT` 可调整）。
  **默认只在定向模式下启用**：`PERF_HEADED=1`（vsync 跟随显示器）或 `PERF_UNCAPPED=1`
  （解除帧率上限，帧间隔反映单帧真实工作耗时）。
  headless（本地默认，与 CI 一致）**不产出绝对判定**——此时 vsync 锁 60Hz，帧间隔反映的是
  显示器节拍而非单帧工作耗时，判定衡量的是"这台机器此刻忙不忙"而不是代码质量；
  若默认启用，无 baseline 的首次运行就会因掉帧率贴线而打印「回归确认」并以 exit 1 结束，
  与真实回归无法区分。`PERF_ABSOLUTE=1` 可强制开启（调试/复现用），`=0` 可强制关闭。
  绝对判定所依赖的模式会随采样一起落盘，因此事后单独复算不会改变结论。
- 每次运行都会在报告与控制台打印 **判定覆盖：N/M 个场景参与相对判定**——它与 FAIL 计数同等重要：
  没参与判定的场景既不算 PASS 也不算 FAIL（基线缺失或不可比），只看「FAIL：0」会误读成"没有回归"。
- **判定分层**：只有主指标（`ttiMs` / `frameMs` / `switchMs` / `searchMs` / `saveMs` / `inputSyncMs` /
  `inputPaintMs`，含其 `.p95`）可以**单独**判 FAIL；派生指标（`longTaskMs` / `longTaskCount` /
  `jankRatePct` / `cls` / `heapDeltaMB` 等，以及未登记的新指标）需要**同一场景内有主指标同样超阈值**才判 FAIL，
  否则降级为 WARN 并标注「派生指标无主指标佐证（疑似运行抖动）」。
  依据：同一份代码在共享 runner 上，派生标量能自然波动 35%，没有主指标佐证的"回归"不可行动；
  而真正影响用户可感知耗时的退化必然会体现在主指标上。新增指标想获得"单独判 FAIL"的能力，
  必须显式加进 `tests/perf/judgment.js` 的 `PRIMARY_METRICS`。
- **噪声门槛（3σ）**：变化的幅度必须超过**基线自身历史散布的 3σ**才算超阈值。
  基线（schemaVersion 2）为每个指标保留最近 8 次运行的聚合值，σ 由此估计；
  比较用的参考值也改为**历史中位数**（滚动参考），不再依赖单次运行的偶然快慢。
  实测同一份代码的 5 次 CI 运行：`inputSyncMs` 3σ≈1.25ms（占基线 66%）、
  `ttiMs` 3σ≈241ms（27%）、`longTaskMs` 3σ≈161ms（53%），
  而 vsync 量化的 `frameMs.p95` 只有 3σ≈0.39ms——**能分辨多大差异是环境属性**，
  靠人给固定百分比必然出错。各行的 3σ 会打印在报告表格里，且**同时给出占参考值的百分比**。
- **分辨率提醒（3σ 占参考值 ≥ 30%）**：表格的 `3σ（占参考）` 列形如 `145.25（52%）`，
  它就是这个指标在当前环境的**检出下限**——52% 意味着小于一半的变化在统计上与抖动不可分。
  汇总会单独列出所有 ≥30% 的行，并提示「行上的 PASS 不等于"没问题"」。
  **假 FAIL 会被人发现，静默漏检不会**，所以宁可把"测不出来"说清楚，也不给一个看起来正常的 PASS。
  实测分布（**统计时点 2026-09-14，quick 基线 8 点**）：36 个主指标行（median + p95）里
  **16 行 ≥30%、12 行 ≥50%**，最差 `tab-switch-M-rich` 的 `switchMs.p95` 达 **129%**；
  把派生标量也算进来则 57 行里 33 行 ≥30%（最差 `scroll-M-rich` 的 `longFrameCount` 717%——
  该量级极小，另有绝对地板与「需主指标佐证」双重约束）。
  重算方法：对每行 `3×sampleSd(history)/median(history)`（即 `judgment.resolutionPct`），
  基线文件里读 `history` / `historyP95` 即可复现。
- **σ 高不等于样本不够**：补播种**不能**改善这些比例——根因是 **runner 之间存在结构性双峰**
  （例：`input-M-rich` 的 `inputSyncMs` history `[9.2, 5.9, 5.4, 10.1, 6.9, 10.15, 11.1, 12.7]`
  明显分成两簇，对应两类机器/两种负载状态）。σ 收敛的是"这台 runner 群落的真实散布"，
  所以正确做法是**如实披露检出下限**，而不是继续加样本或放宽阈值。
- **会话标定（与代码无关的固定工作量，#236）**：每次运行在页面内跑一段**写死工作量**的合成负载
  （1500 个节点的 DOM 合成 + 强制布局、2000 万步纯计算，实测本机约 36ms），落到
  `scalars.probeMs` / `probeLayoutMs` / `probeCpuMs`，与其它指标一同进基线。
  它**不参与 FAIL/WARN 判定**（机器变慢不是代码回归），只用于把「机器慢」从「代码回归」里分开：
  报告给出「会话标定：N 个场景的中位变化 x%」并判 **环境异常 / 环境正常**——
  环境异常时应用指标的恶化很可能来自 runner（请换 runner 重跑确认），环境正常则恶变更可能出自代码。
  - **判定门槛用「是否超出历史范围」，而不是 3σ**：标定值的分布就是**机器档位的分布**
    （实测两档 ≈31ms / ≈50ms；同一次运行内 16 个场景彼此只差 ~2ms），σ 自然很大 → 3σ 会几乎永不触发。
    因此：落在历史范围内 = 与历史档位一致（报告会写明本次比基线参考快/慢多少，供判断 FAIL 是否只是档位差异）；
    **超出历史上限 10%** 才判「会话环境异常」。
  - **覆盖边界**：标定负载覆盖 **CPU 与布局/绘制**两条路径，**不含 IO / 网络**。
    所以"环境在历史范围内"只排除了这两条路径的机器差异——若应用指标同时变差，
    该去代码侧或 IO 侧找原因（实测有一轮：标定显示机器比参考快 19%，`open-L-rich` 的 ttiMs 仍 +42%，
    说明那次恶化不在 CPU/布局路径上）。
  - **启用条件**：标定指标必须先进基线——新建基线与补播种都会自动带上；老基线没有该指标时这一行
    **不出现**（缺失就不判，**不伪造 0**——否则会伪装成"机器变快了"）。
  - **归一化刻意未做**：用标定值去"折算"其它指标的变化需要先积累标定基线、并验证其与各指标的关系
    稳定；当前只做**归因披露**。等两套基线的标定历史达到 `HISTORY_MAX`（8 点）且观察到稳定比例关系，
    再单独评估归一化。
  过了相对阈值但被地板或噪声挡下的行不是 PASS，而是 WARN 并标注原因
  （变化低于该指标的绝对地板 / 变化在运行噪声内（3σ=…））。
  历史不足 3 次运行时门槛不启用，报告头部会显式说明并回退到「百分比 + 绝对地板」。
  积累历史：每次 `--update-baseline`（本地或 CI 的 update_baseline 勾选）都会追加一次运行。
- 「连续 2 次复现」：首轮超阈值 → 自动只复测该场景 → 仍超阈值判 FAIL，回落判 WARN（抖动）。
  只有"可行动"的超阈值才触发复测（派生指标无佐证时不复测，避免为抖动多跑一轮）。
  FAIL 摘要区分「相对回归确认」与「绝对目标未达标」，两者成因不同。
  **复测在独立 job（新 runner）上执行**（issue #234）：同 runner 顺序复测无法过滤
  「整台 runner 变慢」的会话——两轮会一起超阈值、穿过本过滤（实测一次慢会话里 88% 的相对行
  同时变差、中位 Δ +18.7%，而同一份代码在安静时段完全正常）。拆 job 后两轮统计独立，
  慢会话通常不会在另一台 VM 上重现 → 正确落成 WARN「复测回落」。
  - 只在**有嫌疑**时才起第二个 job；无嫌疑的常规运行仍只有 1 个 job（不付额外启动/安装成本）。
  - 手工甄别同样有效：命中 FAIL 后换 runner 重跑一次工作流即可——代码性回归不会因换 runner 消失。
  - 本地演练两条路径（不需要真实回归）：
    `PERF_SPLIT_RETEST=1 PERF_FORCE_SUSPECTS=input-S-rich pnpm run benchmark`（移交，只测+check）
    → 再跑 `PERF_RETEST_ONLY=1 PERF_PROFILE=quick pnpm run benchmark`（复测 job：复测+final）。
- 掉帧定义：帧间隔 > `1.5 × 帧预算`（60Hz → >25ms），避免把 vsync 抖动当卡顿。

### 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 跑完且无确认回归（含仅 WARN） | 正常 |
| 1 | 回归复现（连续 2 次超阈值） | 看 `.perf-output/report.md` 定位 |
| 2 | 没测到 —— ①infra 故障（server 起不来、场景缺失等）；②**判定覆盖不足**（`PERF_REQUIRE_COMPARISON=1` 下部分场景无基线 / 不可比 / **基线里没有可用指标**，tag 运行会红着报出来） | 先修测量链路或补齐该档位基线，别当成"没回归" |

> 覆盖不足时 **exit 2 优先于 exit 1**：若同时存在回归复现，stderr 会先列出覆盖不足再点名 FAIL 场景——
> 结论不完整比单个结论更根本，否则 CI 只看到"回归"，看不出这次验证本身没跑全。

> 首次运行无基线时退出码仍是 `0`（NEW 场景不参与相对判定，也不构成"没测到"）；
> 只有显式要求比较的 tag 运行（`PERF_REQUIRE_COMPARISON=1`）才把覆盖不足升级为 `exit 2`。
> 任何情况下都先看报告里的 `判定覆盖：N/M`：M 个场景里只有 N 个真正参与了判定。

CI 上 Benchmark **不阻断合并**，只上传 `.perf-output/` 产物并写入 Job Summary。

### 基线维护

- **基线的身份 = 测量配置**，路径即配置：
  `.perf-baseline/[local/]<profile>/<mode>/r<rounds>/<id>.json`
  （如 `.perf-baseline/quick/headless/r2/open-S-rich.json`、`.perf-baseline/local/quick/uncapped/r2/…`）。
  不同 `mode`（headless / headed / uncapped）与不同轮数**各自维护基线、互不覆盖**——
  所以在「headless 日常回归」与「uncapped 定向验证 120fps」之间来回跑 `--update-baseline`
  也不会破坏另一边的基线（这一点曾是缺陷：两种模式的样本会被混进同一条历史，
  σ 被污染后真实回归反而被判成"运行噪声内"）。
- **fixture（被测对象）不进路径**：换文档 = 同一路径重建历史，并在控制台打印
  `基线历史重新起头（id）：FIXTURE_CHANGED`。
- 本地：`pnpm run benchmark -- --update-baseline`，结果落在
  `.perf-baseline/local/<profile>/<mode>/r<rounds>/`（`local/` 整棵子树已 gitignore）。
- CI：Actions → **Benchmark** → Run workflow，勾选 `update_baseline`，跑完从 artifact 取回
  `.perf-baseline/<profile>/<mode>/r<rounds>/` 并提交；不勾选时 CI 只做比较，不会写仓库。
  仓库里维护**两套** CI 基线（因为触发场景用不同档位）：
  - `.perf-baseline/quick/headless/r2/` —— PR 运行与 main push 用（16 个场景）
  - `.perf-baseline/full/headless/r3/` —— **tag 运行（发版验证）用**（24 个场景，含 2 万行档）

  重建/补充某一套：`workflow_dispatch(profile=<quick|full>, update_baseline=true)` → 取回产物提交。
  ⚠️ **产物名要对**：该次运行若检出疑似回归，基线更新发生在 **retest job**（见「判定」小节的拆 job 编排），
  要取的是 **`perf-benchmark-<profile>-retest`**——job1 的 `perf-benchmark-<profile>` 里仍是**旧基线**，
  取错等于本次播种**静默丢失**（下一轮从旧基线继续累积，不报任何错）。
  **检出疑似回归时**，job1 的移交提示与 retest job 的 Job Summary **都会**写明这一条
  （播种场景下操作者看到的正是 retest job 的 Summary，所以提示必须就在那里）。
  ⚠️ **必须串行**：下一轮要在**提交了上一轮产物之后**触发，历史才会逐次累积
  （并行跑只会各写各的单点）。
- **播种深度与节奏**：目标是把每套基线补到上限 `HISTORY_MAX = 8` 点——
  σ 由历史估计，点数越多估计越稳（相对误差 ≈ 1/√(2(n-1))：3 点约 50%、8 点约 27%）。
  **tag 运行不追加历史**（发版只做比较，不写仓库），所以 σ 变准完全依赖手动播种：
  建议**每次发版后补 1 次播种**，凑满 8 点后新点会自动顶掉最旧的点，保持窗口新鲜。
  低于 3 点时门槛不启用，报告头部会显式说明。
  ⚠️ **播种不要与 PR / 发版检查并发**：共享 runner 争用会让当次测量整体变慢（实测同一份代码
  在并发播种的时间窗里 88% 的相对行同时变差、被误判成回归）。补播种请在流水线静默时**串行**做。
- **未采用的方案（含理由）**：
  - **离群鲁棒 σ（如 MAD）**：实测 history 是**结构性双峰**（例 `input-M-rich` 的
    `[9.2, 5.9, 5.4, 10.1, 6.9, 10.15, 11.1, 12.7]` 明显两簇，对应两类机器/负载状态），
    鲁棒估计会把"另一档机器的正常值"当离群剔除，反而制造假 FAIL。分层建基线需要先能识别
    runner 档位，当前 CI 不提供。**降低检出下限的正确方向是环境无关的标定负载**（见 #236）。
  - **用"锚点场景"判会话异常**：任何应用指标（包括最稳的 `scroll-S-plain` frameMs）
    都同时受"机器慢"与"代码变慢"影响，用它判会话异常会掩盖真实的全局回归。
- **测量偶发**：`input` / `save` 场景有一条"输入必须真的落地"的守卫（`execCommand` 偶发返回
  false，不校验会把"编辑器没接收输入"记成"极快"）。命中时会在日志里出现
  `[perf] … 输入未全部落地…重新加载后重试`，**这是正常的重试、不是失败**；
  重试到上限（`INPUT_LANDING_RETRIES`）仍不落地才按测量故障处理（退出码 2）。
- 任何 fixture 生成规则变更都必须提升 `FIXTURE_VERSION`，旧基线会自动整体作废。
- 可比性校验仍覆盖 **env / profile / mode / rounds / fixture** 五维，作用是**不变量守卫**：
  前四维已由路径保证，若仍不匹配，说明基线文件被手工搬动或路径方案变了（该拦下的异常）；
  真正会命中并触发重建的通常是 fixture。报告里会显式列出
  `未参与相对判定：FIXTURE_CHANGED(...)` 之类的原因。

### 发版验证（tag 运行）

`push: tags: ["v*"]` 会自动触发 Benchmark（档位 **full**，比 PR 的 quick 多一个 2 万行档），
也就是每次发包都会自动跑一次"本次版本 vs 基线"的比较。

**关键：报告必须有「判定覆盖：N/M」这一行，N 必须等于 M。**
基线缺失时所有场景都是 NEW，报告照样会打印「FAIL：0」——那看起来像"没有回归"，
实际是"什么都没比"。因此 tag 运行注入 `PERF_REQUIRE_COMPARISON=1`：
覆盖不足时 report 直接 `exit 2`（infra 故障）并在 stderr 写明
「本次结论**不构成性能验证**」；本工作流对 tag 关闭 `continue-on-error`，所以会红着报出来。
（PR 运行仍是"只提示、不阻断合并"，不做门禁——issue #216 的既定要求。）

- 为什么必须显式失败：`FAIL：0` 与"没比"在绿色勾选下无法区分，而发版验证恰恰是最不能含糊的一次。
- 发版 job 在 `build.yml`（独立工作流），所以 Benchmark 变红**不会**拦住发版产物；
  它是"发版性能信号"，不是发版门禁。若将来要硬门禁，需要把 benchmark 作为 job 并入 `build.yml`
  并加进 `release.needs`。
- 代价与前提：tag 用 full 档，因此必须维护 `.perf-baseline/full/headless/r3/`；
  该基线重建一次约 12-15 分钟（quick 约 3 分钟）。若长期不维护它会退化成"覆盖不足"并显式报错，
  不会静默放过。

**发版负责人核对清单**（推 tag 后必做，核对完才算发版完成）：

1. `gh run list --workflow=benchmark.yml --limit 3` 找到本次 tag 的运行（`event=push`、`ref=vX.Y.Z`）。
2. 看 **`判定覆盖：N/M`** —— **N 必须等于 M**；不等就是"没比出结论"，先建基线再重跑。
3. 看 **`FAIL` 计数** —— 大于 0 说明相对回归复现，需在汇报中写明并判断是否值得拦截；
   `WARN` 读成因，被噪声（3σ）或绝对地板挡下的**不是**回归。
4. 汇报发版结果时**必须一并给出性能结论**，不得只报"发版成功"。

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
