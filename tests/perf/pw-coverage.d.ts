/** 一个从 playwright 报告里读出的场景条目（id = spec.title） */
export interface PwScenario {
  /** 场景 id */
  id: string;
  /** 结果状态：passed / failed / timedOut / interrupted（skipped 已被排除） */
  status: string;
}

/**
 * 递归展开 playwright 报告的嵌套 suites，收集应被测量的场景（skipped 排除）。
 * 畸形/缺失形状返回 []，绝不抛异常。
 */
export function expectedScenarioIds(pwReport: unknown): PwScenario[];

/** 差集：expected 里存在、但 rawIds 里没有落盘 raw 的场景（保留 status 供归因）；非数组输入返回空/原样，不抛异常 */
export function unmeasuredScenarios(expected: unknown, rawIds: unknown): PwScenario[];

export interface ParsedScenarioId {
  /** 场景名（可含连字符，如 tab-switch） */
  scenario: string;
  /** 档位：S / M / L / XL / C … */
  tier: string;
  /** 类型：rich / plain / custom */
  kind: string;
}

/** 从 id 尾部解析 scenario / tier / kind；不足三段或非字符串返回 null */
export function parseScenarioId(id: unknown): ParsedScenarioId | null;