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
   - 提交后会自动触发 CI：`Build` 的 **test** job 在 Windows + Linux 双平台跑单测 / Rust 单测 / E2E
     （打包 job 仅在 `main` 推送、`v*` tag 与手动 dispatch 时运行）；`Benchmark` quick 档只提示、不阻断合并。
     请等 CI 全绿后再请人 review。

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
  **小基数计数指标（`longFrameCount` / `jankCount` / `longTaskCount`，参考值 <10）另有一层
  由历史散布推导的地板下限**：生效地板取「登记常数」与「`1.5 × 历史极差`」的**较大者**
  （`judgment.effectiveAbsMin`）。依据：这类指标的参考值只有个位数，百分比规则等于把小差异
  无限放大（0.75 → 4 就是 +433%），而手写常数又常比该指标**自身**的跨运行散布小
  （实测 `scroll-M-rich.longFrameCount` 的 history 极差就是 3，登记地板也是 3 → 门槛贴着噪声走，
  0.64 个计数的差就能顶出 FAIL，见 issue #270）。该推导**只收紧不放松**，被抬高的行会在报告里
  单独列出；大基数场景（full 档 L/XL，计数可达 100+）不启用——那里的百分比规则本就有效。
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
  `jankRatePct` / `cls` / `heapDeltaMB` 等，以及未登记的新指标）需要**同一场景内有主指标同样被判 FAIL
  （即参与判定的每一轮都超阈值）**才判 FAIL，否则降级为 WARN 并标注「派生指标无主指标佐证（疑似运行抖动）」。
  依据：同一份代码在共享 runner 上，派生标量能自然波动 35%，没有主指标佐证的"回归"不可行动；
  而真正影响用户可感知耗时的退化必然会体现在主指标上。新增指标想获得"单独判 FAIL"的能力，
  必须显式加进 `tests/perf/judgment.js` 的 `PRIMARY_METRICS`。
  ⚠️ **佐证必须与终判同证据基础**（#270）：终判用的是「参与判定的每一轮」证据，所以佐证基准也必须是
  「主指标**最终**被判 FAIL」。曾把佐证写成「首轮有主指标动过」——结果一个「首轮超、复测回落」
  已被判 WARN 的主指标行仍能给全场景的派生指标发豁免券，出现「零主指标 FAIL 的场景产出 FAIL、exit 1」
  （`scroll-M-rich` 实录：`frameMs.p95` 复测差 0.05ms 未过阈值判 WARN，`longFrameCount` 因复测微升被判 FAIL）。
  **#294 把这条扩到三轮**：确认轮存在时，主指标必须「每一轮都超」才算复现——否则一个末轮已回落的
  主指标仍会发豁免券，在三段路径上重演 #270。
  `check` 阶段「值不值得复测」仍按首轮判断（那时只有首轮数据），不参与结论。
- **噪声门槛（3σ）**：变化的幅度必须超过**基线自身历史散布的 3σ**才算超阈值。
  基线（schemaVersion 2）为每个指标保留最近 8 次运行的聚合值，σ 由此估计；
  比较用的参考值取「**全历史中位数**」与「**最近 4 点中位数**」中的**较高者**（#270）：
  参考值只跟随"环境变慢"上抬，不因近况偶然偏低而下压——实测 quick 档基线里后者会让 46 行参考值
  下压（最多 -50%）、仅 2 行上抬，等于把判定**系统性推向偏严**（同一轮里把 `frameMs.p95` 从 WARN
  翻成 FAIL）。要让"环境变快"也安全地反映到参考值上，前提是会话标定归一化（见下），那是独立议题。
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
  环境异常时应用指标的恶化很可能来自 runner（请换 runner 重跑确认）；**环境正常 ≠ 排除环境**
  （见下条覆盖边界：范围内的偏慢会话同样能顶出假 FAIL），FAIL 最终以换 runner 重跑为准。
  - **判定门槛用「是否超出历史范围」，而不是 3σ**：标定值的分布就是**机器档位的分布**
    （实测两档 ≈31ms / ≈50ms；同一次运行内 16 个场景彼此只差 ~2ms），σ 自然很大 → 3σ 会几乎永不触发。
    因此：落在历史范围内 = 与历史档位一致（报告会写明本次比基线参考快/慢多少，供判断 FAIL 是否只是档位差异）；
    **超出历史上限 10%** 才判「会话环境异常」。
  - **每轮都对账，不只是首轮与复测**（#294 扩到三轮）：只看首轮会得出与事实相反的结论
    ——首轮慢（超范围）触发复测、复测在另一台机器上仍超阈值时，说「请换 runner 重跑确认」
    而这一步其实已经做过了。确认轮是**唯一**能确认 FAIL 的那一轮，它自己越界时更必须显式说明
    （此时结论落 UNCONFIRMED，不会出 FAIL）。报告因此披露 `首轮 / 复测 / 确认` 三段偏差。
  - **越界只决定「要不要再验一轮」，不 suppress FAIL**（#294 D2）：复测轮越界的场景会被**强制并入
    确认轮候选**；确认轮越界则**不确认 FAIL**（落 UNCONFIRMED）。但**不能**反过来把越界当成
    FAIL 抑制门禁——实测它**既非必要也非充分**（两例假 FAIL 落在范围内、两例高偏差核验会话结果正常），
    拿它抑制会把真回归一起放过。
  - **标定值的「基线参考」同样取 `max(全历史中位数, 最近 4 点中位数)`**（`judgment.referenceValue`，
    与相对判定层同一口径，#270 方案 C；本条由 #276 补记文档）：标定值的 history 就是**机器档位分布**
    （双峰 ≈31ms / ≈50ms），窗口上抬等价于「以当前档位为基准」；副作用是 probe 近况偏慢时
    「首轮/复测比基线参考慢 X%」的分母变大、百分比随之缩小。这是**有意行为**而非疏漏——
    probe 只做归因披露、不参与 FAIL/WARN 判定，与判定层共用一套参考值定义可以避免出现两套口径。
  - **覆盖边界**：标定负载覆盖 **CPU 与 DOM 构建/样式/布局**两条路径（探针是离屏隐藏子树，
    **不产生 paint/光栅化**），**不含 IO / 网络**。
    所以"环境在历史范围内"只排除了这两条路径**超出历史范围**的机器差异——若应用指标同时变差，
    代码侧或 IO 侧是**候选**方向而不是结论（实测有一轮：标定显示机器比参考快 19%，`open-L-rich` 的
    ttiMs 仍 +42%，说明那次恶化不在 CPU/布局路径上）。**反向不成立**：范围内偏慢的会话同样能顶出
    假 FAIL（#259 实录：代码零差异、首轮 +7.7% / 复测 +20%，两轮均落在双峰范围内，retest 仍判 FAIL；
    #261 实录：`tab-switch-M-rich` 首轮 runner 假 FAIL，换 runner 重跑 `switchMs.p95` -5.8% PASS）——
    报告会打印每轮各自相对基线参考的偏差；**#294 之后这类"范围内双超"由确认轮拦下**
    （实测 3 例的核验轮全部回落），但**范围内不等于排除环境**，FAIL 是否成立最终仍以换 runner 重跑为准。
  - **启用条件**：标定指标必须先进基线——新建基线与补播种都会自动带上；老基线没有该指标时这一行
    **不出现**（缺失就不判，**不伪造 0**——否则会伪装成"机器变快了"）。
  - **归一化刻意未做**：用标定值去"折算"其它指标的变化需要先积累标定基线、并验证其与各指标的关系
    稳定；当前只做**归因披露**。等两套基线的标定历史达到 `HISTORY_MAX`（8 点）且观察到稳定比例关系，
    再单独评估归一化。
  过了相对阈值但被地板或噪声挡下的行不是 PASS，而是 WARN 并标注原因
  （变化低于该指标的绝对地板 / 变化在运行噪声内（3σ=…））。
  历史不足 3 次运行时门槛不启用，报告头部会显式说明并回退到「百分比 + 绝对地板」。
  积累历史：每次 `--update-baseline`（本地或 CI 的 update_baseline 勾选）都会追加一次运行。
- **三轮判定：末轮仍超才确认 FAIL**（#294）：
  `首轮超阈值 → 复测该场景一轮（换 runner）→ 仍超阈值 → 再上**第三个 runner** 确认一轮 → 末轮仍超才判 FAIL`。
  只有"可行动"的超阈值才触发复测（派生指标无佐证时不复测，避免为抖动多跑一轮）。
  注意两个阶段的佐证基准不同：`check` 阶段（决定复测谁）只有首轮数据，按首轮判断；
  `final` 阶段（出结论）必须按「主指标**最终**被判 FAIL」判断（#270，#294 扩到三轮）。
  FAIL 摘要区分「相对回归确认」与「绝对目标未达标」，两者成因不同。
  **复测在独立 job（新 runner）上执行**（issue #234）：同 runner 顺序复测无法过滤
  「整台 runner 变慢」的会话——两轮会一起超阈值、穿过本过滤（实测一次慢会话里 88% 的相对行
  同时变差、中位 Δ +18.7%，而同一份代码在安静时段完全正常）。拆 job 后两轮统计独立，
  慢会话通常不会在另一台 VM 上重现 → 正确落成 WARN「复测回落」。
  - **两个 runner 还不够，故有第三轮**（#294）：共享 runner 池内的并发来源是**跨工作流**的
    （自家 Build 的 test job、main 打包、其他 Benchmark），#291/#293 的 workflow 级串行管不到它们。
    2026-09-30 实证 3 例「首轮 + 复测双双超阈值 → 判 FAIL」，换 runner 静默复跑**全部证伪**。
    根治口径：**FAIL 必须由第三个独立 runner 上的会话确认**；确认轮自身不可信时**不允许**产出 FAIL。
  - 逐行判定表：

    | 条件 | 判定 |
    |---|---|
    | `R1` 未超 / 被地板噪声抑制 | `PASS` / `WARN`（沿用现有语义） |
    | `R1` 超、无 `R2` | `WARN（未复测）` |
    | `R1` 超、`R2` 未超 | `WARN（复测回落（抖动））`（**不进 R3**） |
    | `R1∧R2` 超、`R3` 存在且超 | **`FAIL`** |
    | `R1∧R2` 超、`R3` 存在但未超 | `WARN（末轮回落（抖动））` |
    | `R1∧R2` 超、`R3` 缺失 | `WARN（未确认：确认轮未测量）` → UNCONFIRMED |
    | `R1∧R2` 超、`R3` 标定越界 | `WARN（未确认：确认轮环境不可信）` → UNCONFIRMED |
    | `R1∧R2` 超、`R3` 缺该指标 | `WARN（未确认：确认轮缺该指标）` → UNCONFIRMED |

  - **确认轮候选（两条并列）**：① `R1 ∧ R2` 双超阈值（口径与 `check` 一致）；
    ② **复测轮标定越界**（`probeMs` 超基线历史上限 10%）——环境不可信，不许就地确认。
  - **标定越界只决定「要不要再验一轮」，不 suppress FAIL**：#294 实证它**既非必要也非充分**
    （范围内照样出假 FAIL 两例、高偏差的核验会话照样正常两例）。拿它当抑制门禁会把真回归一起放过。
  - **UNCONFIRMED** = 「本来会确认 FAIL、但确认轮没能给出可信结论」的场景集合。
    PR 运行：披露 + 逐行 WARN（不阻断）；tag 运行（`PERF_REQUIRE_COMPARISON=1`）：**exit 2**。
    ⚠️ **它与「有没有双超」是两件事**：判据是「场景进了 `retest2.json`（编排要求确认）
    却没拿到可信的第三轮」。仅因**复测标定越界**进候选、而该行 R2 并未超的场景，
    同样算「确认轮未给出可信结论」——它也编排了、也被要求给结论。
    报告因此分两行披露：`确认轮未给出可信结论`（编排层面）与 `未确认`（判定层面）。
  - **退出码 2 优先于 exit 1**：`UNMEASURED`（场景没测到）→ exit 2；否则 UNCONFIRMED 且要求完整比较
    → exit 2；否则有确认 FAIL → exit 1；否则 exit 0。**确认轮整轮没测到**（有候选但零采样）
    属链路故障，PR 与 tag **一律** exit 2——判据只认「有候选 + 零采样」，不看 UNCONFIRMED 列表。
  - 只在**有嫌疑 / 有确认候选**时才起对应 job；无嫌疑的常规运行仍只有 1 个 job（零额外开销）。
  - ⚠️ **`benchmark`（测量）与 `retest`（复测）两个 job 必须传 `PERF_SPLIT_RETEST=1`**
    （#294 评审 P0 的教训）：
    复测 job 漏了它 → `planConfirmPhases` 永不 handoff → **确认轮跑在与 R2 同一台 runner 上**，
    tag 运行因此以「同 runner 三轮」的假 FAIL 收尾、而 retest2 job 又因上游非零被 skip
    （`needs.retest` 的 `if` 不带 `always()`）——**根治手段在 tag 路径上被整体旁路**。
    指纹很好认：日志出现「⚠️ 本地为单进程，与 R1/R2 同 runner」，且 retest job 产物里
    **出现了 `report.md`**（移交时本不该有）。`tests/unit/perf-orchestration.test.ts`
    直接读 `benchmark.yml` 断言这一行存在，就是为挡住这个回归。
    `retest2`（确认轮）是**最后一个 job**，不参与任何移交决策，**不要**给它加这个变量——
    加了既无作用，又与守卫测试的断言相矛盾。
  - 手工甄别同样有效：命中 FAIL 后换 runner 重跑一次工作流即可——代码性回归不会因换 runner 消失。
  - 本地演练三段路径（不需要真实回归）：
    ```bash
    # ① 测量 job（移交）
    PERF_SPLIT_RETEST=1 PERF_FORCE_SUSPECTS=search-M-rich pnpm run benchmark
    # ② 复测 job（产出 retest2.json 后移交确认轮）
    PERF_RETEST_ONLY=1 PERF_SPLIT_RETEST=1 PERF_FORCE_SUSPECTS=search-M-rich \
      PERF_FORCE_SUSPECTS2=search-M-rich pnpm run benchmark
    # ③ 确认轮 job（出三轮 final 报告）
    PERF_RETEST2_ONLY=1 pnpm run benchmark
    ```
    CI 上用 `workflow_dispatch` 的 `force_suspects` + `force_suspects2` 同样可确定性演练
    （两个都填才会走到确认轮）。`PERF_FORCE_SUSPECTS2` 单独存在时也能强制产出候选清单。
  - ⚠️ **本地（非 split）三段路径的 R2/R3 与 R1 同 runner**：独立性不足，FAIL 结论请以 CI 拆 job
    的运行为准。这与 #234 对本地 R2 的既有口径一致，不为本地引入假独立性。
- 掉帧定义：帧间隔 > `1.5 × 帧预算`（60Hz → >25ms），避免把 vsync 抖动当卡顿。

### 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 跑完且无确认回归（含仅 WARN） | 正常 |
| 1 | 回归确认（**参与判定的每一轮都超阈值**，#294 至少三轮） | 看 `.perf-output/report.md` 定位 |
| 2 | 没测到 / 结论不完整 —— ①infra 故障（server 起不来、场景缺失等）；②**判定覆盖不足**（`PERF_REQUIRE_COMPARISON=1` 下部分场景无基线 / 不可比 / **基线里没有可用指标**，tag 运行会红着报出来）；③**部分场景未测量**（单场景超时 / 失败、无采样落盘：已测场景照常判定，未测量场景在报告里单列 `UNMEASURED`）；④**确认轮整轮未测量**（有确认候选但 `raw-retest2/` 零采样，属链路故障，PR 与 tag 一律 exit 2）；⑤**UNCONFIRMED**（本来会确认 FAIL，但确认轮缺失 / 环境不可信 / 缺该指标；仅 `PERF_REQUIRE_COMPARISON=1` 时升级为 exit 2） | 先修测量链路、补齐该档位基线，或换 runner 重跑，别当成"没回归" |

> **exit 2 优先于 exit 1**（沿用「更根本的结论优先」）：
> `UNMEASURED` → exit 2；否则 UNCONFIRMED 且要求完整比较 → exit 2；否则有确认 FAIL → exit 1；否则 exit 0。
> 若同时存在回归复现与结论不完整，stderr 会先列出更根本的那条再点名 FAIL 场景——
> 否则 CI 只看到"回归"，看不出这次验证本身没跑全。

> 首次运行无基线时退出码仍是 `0`（NEW 场景不参与相对判定，也不构成"没测到"）；
> 只有显式要求比较的 tag 运行（`PERF_REQUIRE_COMPARISON=1`）才把覆盖不足与 UNCONFIRMED 升级为 `exit 2`。
> 任何情况下都先看报告里的 `判定覆盖：N/M`：M 个场景里只有 N 个真正参与了判定，
> 以及 `判定轮次：首轮 ✓ 复测 ✓ 确认 ✓`——**两轮判出来的结论与三轮判出来的证据强度不同**。

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
  ⚠️ **产物名要对**：基线更新发生在**跑到 `final` 的那个 job**，而它取决于本次走到第几段：
  - 该次运行若**检出疑似回归**（起了复测 job），基线在 **retest job** 更新
    → 取 **`perf-benchmark-<profile>-retest`**；
  - 若复测后**仍有确认候选**（起了 retest2 job，#294），基线在 **retest2 job** 更新
    → 取 **`perf-benchmark-<profile>-retest2`**；
  - 无嫌疑时基线在 job1 更新 → 取 `perf-benchmark-<profile>`。

  取错等于本次播种**静默丢失**（下一轮从旧基线继续累积，不报任何错）。
  **每个移交 job 的 Job Summary 都会写明该取哪个**——播种场景下操作者看到的正是那个 Summary，
  所以提示必须就在那里。确认轮的 source 优先级是 `R3 > R2 > R1`（用最新一轮的采样写基线）。
  ⚠️ **必须串行**：下一轮要在**提交了上一轮产物之后**触发，历史才会逐次累积
  （并行跑只会各写各的单点）。
- **播种深度与节奏**：目标是把每套基线补到上限 `HISTORY_MAX = 8` 点——
  σ 由历史估计，点数越多估计越稳（相对误差 ≈ 1/√(2(n-1))：3 点约 50%、8 点约 27%）。
  **tag 运行不追加历史**（发版只做比较，不写仓库），所以 σ 变准完全依赖手动播种：
  建议**每次发版后补 1 次播种**，凑满 8 点后新点会自动顶掉最旧的点，保持窗口新鲜。
  低于 3 点时门槛不启用，报告头部会显式说明。
  ⚠️ **quick 档同样要按这个节奏播种**（#270）：发版验证只用 full 档，但 PR 与 main 的每次运行
  都拿 quick 档判定——quick 档基线陈旧（`updatedAt` 停在几天前）正是"参考值停留在更快旧环境、
  每轮都顶出假 FAIL"的温床（`scroll-M-rich` 的 `longFrameCount` 全历史中位数 0.75 而近况 1.25，
  就是这种状态）。两套基线各自维护、互不覆盖，播种时别只补 full。
  ⚠️ **播种不要与 PR / 发版检查并发**：共享 runner 争用会让当次测量整体变慢（实测同一份代码
  在并发播种的时间窗里 88% 的相对行同时变差、被误判成回归）。补播种请在流水线静默时**串行**做。
  该纪律已由流水线强制（#291）：`Benchmark` 用全局 `concurrency` 组（`group: benchmark`）串行化
  本工作流的**所有**运行——跨 PR / main / tag 排队执行（`queue: max` 队列深度 100、FIFO，
  排队中的运行不会被顶掉；`cancel-in-progress: false`），消除运行之间的并发争用窗口。
  重要运行（发版 tag / 播种）仍建议在安静窗口触发，避免排在长队之后。
  ⚠️ **播种遇 `exit 2`（部分场景未测量）**：已测场景的基线会**逐场景照常更新**，缺的只是未测量场景的本轮点位；
  整轮以 `exit 2` 结束提示这次播种**不完整**——先修超时 / 失败，再补一次完整播种，
  不要把不完整的产物直接当成播种结果（否则该场景的点位永久少一次）。
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
- **单测超时按档位**：`tests/perf/scenarios/*.spec.ts` 的用例入口统一调用
  `test.setTimeout(testTimeoutMs(tier))`（档位表在 `tests/perf/runner.ts`）——S/M 180s、L 300s、
  XL / 自定义档（`PERF_DOC_FILE` 的 C 档）600s，`PERF_TEST_TIMEOUT_MS` 可整体覆盖；
  config 里的全局 `180_000` 保留为兜底（新场景忘调用会显式撞线，而不是静默放行）。
  （Playwright 1.62 的 `test(title, details, fn)` 只接受 `tag` / `annotation`，不接受 `timeout` 选项，
  故用官方等价的 `test.setTimeout`。）
  依据：L 档（2 万行）在 CI 的 wall 实测 114–174s、中位 ≈138s，贴 180s 线是结构性风险。
- 任何 fixture 生成规则变更都必须提升 `FIXTURE_VERSION`，旧基线会自动整体作废。
- 可比性校验仍覆盖 **env / profile / mode / rounds / fixture** 五维，作用是**不变量守卫**：
  前四维已由路径保证，若仍不匹配，说明基线文件被手工搬动或路径方案变了（该拦下的异常）；
  真正会命中并触发重建的通常是 fixture。报告里会显式列出
  `未参与相对判定：FIXTURE_CHANGED(...)` 之类的原因。

### 发版验证（tag 运行）

> 发版的五阶段流程与「发版检查清单」见 [`docs/发布流程.md`](./docs/发布流程.md)；本节只覆盖 tag 运行的性能验证口径。

`push: tags: ["v*"]` 会自动触发 Benchmark（档位 **full**，比 PR 的 quick 多一个 2 万行档），
也就是每次发包都会自动跑一次"本次版本 vs 基线"的比较。

**关键：报告必须有「判定覆盖：N/M」这一行，N 必须等于 M。**
基线缺失时所有场景都是 NEW，报告照样会打印「FAIL：0」——那看起来像"没有回归"，
实际是"什么都没比"。因此 tag 运行注入 `PERF_REQUIRE_COMPARISON=1`：
覆盖不足时 report 直接 `exit 2`（infra 故障）并在 stderr 写明
「本次结论**不构成性能验证**」；本工作流对 tag 关闭 `continue-on-error`，所以会红着报出来。
（PR 运行仍是"只提示、不阻断合并"，不做门禁——issue #216 的既定要求。）

**同样要看「判定轮次」这一行**（#294）：`首轮 ✓　复测 ✓　确认 ✓` 才是完整的三轮证据。
tag 运行若因故只走到两轮（例如确认轮候选为空、或 retest2 job 未跑），
那些「本来会确认 FAIL」的场景会落 **UNCONFIRMED** 并让 tag 以 `exit 2` 终止——
**它不会伪装成绿**。此时应换 runner 重跑，而不是把 exit 2 当作"没回归"放行。

- 为什么必须显式失败：`FAIL：0` 与"没比"在绿色勾选下无法区分，而发版验证恰恰是最不能含糊的一次。
- 发版 job 在 `build.yml`（独立工作流），所以 Benchmark 变红**不会**拦住发版产物；
  它是"发版性能信号"，不是发版门禁。若将来要硬门禁，需要把 benchmark 作为 job 并入 `build.yml`
  并加进 `release.needs`。
- 代价与前提：tag 用 full 档，因此必须维护 `.perf-baseline/full/headless/r3/`；
  该基线重建一次约 12-15 分钟（quick 约 3 分钟）。若长期不维护它会退化成"覆盖不足"并显式报错，
  不会静默放过。
- **时间代价**：tag 运行检出疑似回归时会起 2~3 个 job（#294 的三段），比两段时多约 3-4 分钟。
  这是把「人工换 runner 核验」自动化的代价——2026-09-30 一天做了 5 次人工核验。

**发版负责人核对清单**（推 tag 后必做，核对完才算发版完成）：

1. `gh run list --workflow=benchmark.yml --limit 3` 找到本次 tag 的运行（`event=push`、`ref=vX.Y.Z`）。
2. 看 **`判定覆盖：N/M`** —— **N 必须等于 M**；不等就是"没比出结论"，先建基线再重跑。
3. 看 **`判定轮次`** —— 走到确认轮时期望 `首轮 ✓　复测 ✓　确认 ✓`。
   若报告出现 `UNCONFIRMED`，说明确认轮没能给出可信结论 → 换 runner 重跑，**不要**按"没回归"放行。
4. 看 **`FAIL` 计数** —— 大于 0 说明相对回归在**三个 runner** 上复现，需在汇报中写明并判断是否值得拦截；
   `WARN` 读成因，被噪声（3σ）或绝对地板挡下的**不是**回归。
5. 汇报发版结果时**必须一并给出性能结论**，不得只报"发版成功"。

## 样式改动与主题断言（Theme Epic #223/#224，S1–S16）

所有样式都在级联层 `@layer base, theme, user` 内（层序声明在 [index.html](./index.html) 内联，是唯一落点）。改样式前先按下表选择防线：

| 改动性质 | 必需防线 | 理由 |
|---|---|---|
| 变量 / 选择器结构变化（新增 token、拆文件、`data-theme` 块、改层包裹） | **源级静态断言**（`tests/styles/**`、`tests/components/*ThemeTokens`） | 跨平台稳定，结构变化用静态断言可精确表达，且不被运行时环境（dev/打包、浏览器/Tauri）干扰 |
| 主题加载机制（层序、注入顺序、快照、首帧） | **E2E 行为断言**（dev server：S7/S8/S12/S13/S14，见 `tests/e2e/theme-layers.spec.ts`） | 机制正确性只能在真实样式表/DOM 上验证 |
| 构建期分文件 / 压缩（manualChunks、@import 内联、esbuild 压缩、@font-face） | **产物级断言 S16**（`pnpm check:build-layers`，清空 dist → 构建 → `scripts/check-theme-build-assets.mjs`） | dev 与 build 的 CSS 分文件策略不同，产物正确性只在构建后成立 |
| 视觉呈现变化（颜色值微调、间距、观感类） | 截图比对或**人工核对**（无截图基线时，PR 描述中写明人工核对步骤） | 静态断言无法覆盖像素级呈现 |

硬规则（#224 关闭标准）：

1. **任何样式改动至少留一条机器可验证断言**；确实无法机器验证的，必须在 PR 描述中显式声明人工核对步骤，观感类差异不得静默合入。
2. **新增/删除 CSS 入口**必须同步登记 [tests/fixtures/theme-entries.json](./tests/fixtures/theme-entries.json)，未登记守卫会失败；所有应用样式必须在 `@layer base` 内（源码包裹或 `vite.config.ts` 的 `themeBaseLayerPlugin`），禁止残留未分层样式。
3. **零散落硬编码色**：清单内文件剥注释后，`#hex` / `rgba()` 只允许出现在 `--token: <值>` 定义行（S9）；存量色值统一走语义 token，新增组件样式不得直接写色值。token 命名沿用现有名（不改名），新增外壳/内容 token 分别用 `--shell-*` / `--content-*` 前缀，白名单见 [src/theme/token-whitelist.json](./src/theme/token-whitelist.json)（与 App.css 自动对账）。
4. 主题/自定义 CSS 注入 `<style>` 必须 `textContent` 或 CSSOM，**禁止 innerHTML/字符串拼接**（S15，函数级断言）；打包期还需复用层序声明标签上的 CSP nonce（release 下 `style-src` 含 nonce，见 #225）。
5. CI 门禁三段固定为：① 静态/单测（`pnpm test`）→ ② E2E（`pnpm e2e`，dev server）→ ③ 清空 dist 后构建 + S16（`pnpm check:build-layers`）；不得对陈旧 `dist/` 断言。

截图基线：本项目暂不引入截图比对（`@layer` 迁移等纯结构变化以源级断言 + S13/S16 兜底）；若未来引入，限定 chromium + 固定容器尺寸，并在 CI 连续无 flake 后再启用。

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
