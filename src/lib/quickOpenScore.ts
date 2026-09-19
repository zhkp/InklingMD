// Quick Open 的打分与排序（纯函数，#228）
//
// 与渲染完全解耦：输入是「候选文件 + 查询串 + 少量排序依据」，输出是排好序的列表。
// 不读 store、不碰 DOM，因此可以表驱动单测覆盖全部档位。
//
// 公式（#228 原文，一处修正见下）：
//
//   score = 已打开 (+1000)
//         + 最近打开序位权重 (0~100，越近越高)
//         + 文件名匹配类型分 (0~100，取最高档不叠加)
//         - 路径深度惩罚 (depth * 2)
//
// **对 issue 原文的修正**：#228 写作「+ 路径深度惩罚（depth * 2）」。在「分数越高越靠前」
// 的公式里，惩罚必须是**减去**，否则越深的文件反而越靠前，与「优先根附近文件」的目标相反。

/** 已打开标签页的基础加分：必须压过其他所有项之和（100 + 100 - 深度），保证已打开优先 */
export const OPEN_TAB_BONUS = 1000;
/** 最近打开的最高权重（序位 0） */
export const RECENCY_MAX = 100;
/** 每个序位递减的权重 */
export const RECENCY_STEP = 10;
/** 每层目录的惩罚（减去） */
export const DEPTH_PENALTY_PER_LEVEL = 2;

/** 命中档位：分值越高越优先，**取最高档，不叠加** */
export const MATCH_BASENAME_EXACT = 100;
export const MATCH_BASENAME_PREFIX = 80;
export const MATCH_BASENAME_SUBSTRING = 60;
export const MATCH_PATH_SUBSTRING = 50;
export const MATCH_SUBSEQUENCE_MIN = 20;
export const MATCH_SUBSEQUENCE_MAX = 50;

/** 参与排序的候选（相对路径与打开/最近状态由调用方从 store 取出后传入） */
export interface QuickOpenCandidate {
  /** 绝对路径 */
  path: string;
  /** 相对工作区的路径，POSIX 分隔符（调用方负责剥离 rootPath 前缀并归一化） */
  relPath: string;
  /** 是否已在打开的标签页中 */
  isOpen: boolean;
  /** 在 recentFiles 中的 0 基序位；不在列表中传 -1 */
  recentIndex: number;
}

/** 打完分的候选 */
export interface RankedCandidate extends QuickOpenCandidate {
  /** 文件名（relPath 的最后一段） */
  basename: string;
  /** 总分 */
  score: number;
  /** 匹配档位分（不含已打开 / 最近 / 深度） */
  matchScore: number;
}

/** 文件名：取 relPath 最后一段（relPath 已归一为 POSIX 分隔符） */
export function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx < 0 ? relPath : relPath.slice(idx + 1);
}

/** 目录层数：relPath 中 `/` 的个数（工作区根下直接文件为 0） */
export function depthOf(relPath: string): number {
  let depth = 0;
  for (const ch of relPath) {
    if (ch === "/") depth += 1;
  }
  return depth;
}

/** 最近打开权重：序位 0 得满分，逐位递减，超出列表得 0 */
export function recencyScore(recentIndex: number): number {
  if (recentIndex < 0) return 0;
  return Math.max(0, RECENCY_MAX - recentIndex * RECENCY_STEP);
}

/**
 * 模糊匹配：`query` 的字符按序出现在 `text` 中
 *
 * 返回紧凑度得分或 null 表示不匹配。
 * 贪心取每个字符的**首次**出现位置，用首末下标跨度衡量紧凑度。
 *
 * 注：`MATCH_SUBSEQUENCE_MAX` 在实践中不可达——跨度等于查询长度意味着 `text`
 * 连续包含查询串，那种情况已被档位 3/4 先截住，故本档得分恒在 [20, 50) 内。
 * 保留上限只是为了给公式一个明确的钳位，避免未来调参时越界。
 */
function subsequenceScore(text: string, query: string): number | null {
  let first = -1;
  let last = -1;
  let cursor = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, cursor);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
    cursor = found + 1;
  }
  if (first < 0) return null;
  const span = last - first + 1;
  const raw = MATCH_SUBSEQUENCE_MIN + Math.round((30 * query.length) / span);
  return Math.min(MATCH_SUBSEQUENCE_MAX, Math.max(MATCH_SUBSEQUENCE_MIN, raw));
}

/**
 * 匹配档位分：取最高命中档，不叠加；不命中返回 null（该文件不入选）
 *
 * 比较统一走 `toLowerCase()`；查询串先 `trim()`，空查询视为「全部命中」（0 分）。
 */
export function matchScoreOf(relPath: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const lowerPath = relPath.toLowerCase();
  const lowerBase = basenameOf(lowerPath);

  if (lowerBase === q) return MATCH_BASENAME_EXACT;
  if (lowerBase.startsWith(q)) return MATCH_BASENAME_PREFIX;
  if (lowerBase.includes(q)) return MATCH_BASENAME_SUBSTRING;
  if (lowerPath.includes(q)) return MATCH_PATH_SUBSTRING;
  return subsequenceScore(lowerPath, q);
}

/**
 * 候选总分 = 已打开加分 + 最近打开权重 + 档位分 − 深度惩罚
 *
 * `matchScore` 由调用方传入（即 `matchScoreOf` 的结果），**不在这里重算**：
 * `rankQuickOpenFiles` 同时需要档位分与总分，若此处再算一遍，每次按键的
 * 必然成本会直接翻倍（5,000 候选时可见）。
 */
export function scoreCandidate(candidate: QuickOpenCandidate, matchScore: number): number {
  return (
    (candidate.isOpen ? OPEN_TAB_BONUS : 0) +
    recencyScore(candidate.recentIndex) +
    matchScore -
    depthOf(candidate.relPath) * DEPTH_PENALTY_PER_LEVEL
  );
}

/** code-unit 字典序比较（禁用 localeCompare：跨平台 / 跨 locale 结果不一致） */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 打分 + 排序
 *
 * 排序键：score 降序 → relPath（小写）升序 → 绝对路径升序。
 * 后两级保证**同分排序确定**（不依赖输入顺序，也不依赖平台 locale）。
 * 不命中查询的候选被剔除。
 */
export function rankQuickOpenFiles(
  candidates: QuickOpenCandidate[],
  query: string,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const candidate of candidates) {
    const matchScore = matchScoreOf(candidate.relPath, query);
    if (matchScore === null) continue;
    ranked.push({
      ...candidate,
      basename: basenameOf(candidate.relPath),
      score: scoreCandidate(candidate, matchScore),
      matchScore,
    });
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const byRel = compareCodeUnits(a.relPath.toLowerCase(), b.relPath.toLowerCase());
    if (byRel !== 0) return byRel;
    return compareCodeUnits(a.path, b.path);
  });
  return ranked;
}
