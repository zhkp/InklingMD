/**
 * Playwright JSON 报告的覆盖核算（issue #247）——纯函数，供 benchmark/report 与本目录单测共用。
 *
 * 拆出来的理由与 retest-plan / cli-env 一致：这部分决定「哪些场景本应被测量」，
 * 是「未测量降级」判定链最上游的输入。做成纯函数，语义就能被单测直接锁死，
 * 而不需要真的起浏览器跑一轮 benchmark。
 *
 * 背景：单场景超时（如 input-L-rich 撞 180s 线）会让 playwright 整轮退出非 0，
 * 旧行为把整轮按 infra 故障作废——`FAIL：0` 与"什么都没比"在退出码层面无法区分。
 * 方向 2 要的是：已测场景照常判定，未测量场景单列于报告并让整轮 exit 2。
 * 本模块负责算出「应测但没落盘 raw」的那批场景。
 */

/**
 * 展开 playwright 报告的嵌套 suites，收集每个 spec 的 `{ id, status }`。
 *
 * - id 取 `spec.title`（= 我们注册时用的场景 id）。
 * - status 取 `tests[0]?.results[0]?.status`，缺失时兜底 `"interrupted"`
 *   （报告被截断 / 老产物没有 results 时，按"没跑完"处理，而不是当它不存在）。
 * - **skipped 排除**：复测过滤是合法跳过（PERF_SCENARIO 只跑嫌疑场景），
 *   它不算「应测未测」，否则每次复测轮都会把没嫌疑的场景误报成未测量。
 * - 畸形/缺失形状一律返回 []，绝不抛异常（报告读不到不能反过来改判定）。
 */
export function expectedScenarioIds(pwReport) {
  const out = [];
  const walk = (suites) => {
    if (!Array.isArray(suites)) return;
    for (const suite of suites) {
      if (!suite || typeof suite !== "object") continue;
      if (Array.isArray(suite.specs)) {
        for (const spec of suite.specs) {
          if (!spec || typeof spec !== "object") continue;
          const id = spec.title;
          if (typeof id !== "string" || id === "") continue;
          const status = spec.tests?.[0]?.results?.[0]?.status ?? "interrupted";
          if (status === "skipped") continue;
          out.push({ id, status });
        }
      }
      walk(suite.suites);
    }
  };
  walk(pwReport?.suites);
  return out;
}

/**
 * 差集：应测（expected）但在本次 raw 里没有落盘（rawIds）的场景。
 *
 * expected 是 `expectedScenarioIds` 的产物（`{ id, status }[]`），返回值保留 status，
 * 供 report.mjs 合成 `UNMEASURED(<status>)` 行时说明成因（超时 / 失败 / 中断）。
 */
export function unmeasuredScenarios(expected, rawIds) {
  const measured = new Set(Array.isArray(rawIds) ? rawIds : []);
  return (Array.isArray(expected) ? expected : []).filter(
    (s) => s && typeof s.id === "string" && !measured.has(s.id),
  );
}

/**
 * 从场景 id 尾部解析 `kind` / `tier`（id 形如 `<scenario>-<tier>-<kind>`）。
 *
 * 用**尾部**而不是 split 全串后再取前两段：场景名本身可能含连字符
 * （`tab-switch-L-rich` → scenario `tab-switch`），固定位置切分会把它读错。
 * 不足三段（无法同时确定 tier 与 kind）视为非法，返回 null。
 */
export function parseScenarioId(id) {
  if (typeof id !== "string") return null;
  const parts = id.split("-");
  if (parts.length < 3) return null;
  const kind = parts[parts.length - 1];
  const tier = parts[parts.length - 2];
  const scenario = parts.slice(0, -2).join("-");
  if (!scenario || !tier || !kind) return null;
  return { scenario, tier, kind };
}