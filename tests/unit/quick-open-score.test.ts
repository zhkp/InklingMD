// Quick Open 打分与排序单测（#228）
//
// 全部为纯函数，表驱动覆盖 6 个匹配档位与各加权项。

import { describe, expect, it } from "vitest";
import {
  DEPTH_PENALTY_PER_LEVEL,
  MATCH_BASENAME_EXACT,
  MATCH_BASENAME_PREFIX,
  MATCH_BASENAME_SUBSTRING,
  MATCH_PATH_SUBSTRING,
  OPEN_TAB_BONUS,
  RECENCY_MAX,
  basenameOf,
  depthOf,
  matchScoreOf,
  rankQuickOpenFiles,
  recencyScore,
  scoreCandidate,
  type QuickOpenCandidate,
} from "../../src/lib/quickOpenScore";

function cand(relPath: string, overrides: Partial<QuickOpenCandidate> = {}): QuickOpenCandidate {
  return {
    path: `/w/${relPath}`,
    relPath,
    isOpen: false,
    recentIndex: -1,
    ...overrides,
  };
}

const rank = (candidates: QuickOpenCandidate[], query: string) =>
  rankQuickOpenFiles(candidates, query);

describe("quickOpenScore（打分与排序）", () => {
  describe("匹配档位（取最高档，不叠加）", () => {
    it.each<[string, string, string, number]>([
      ["档位 1 文件名全等", "readme.md", "readme.md", MATCH_BASENAME_EXACT],
      ["档位 2 文件名前缀", "readme-old.md", "readme", MATCH_BASENAME_PREFIX],
      ["档位 3 文件名子串", "my-readme-archive.md", "readme", MATCH_BASENAME_SUBSTRING],
      ["档位 4 路径子串", "docs/guide/readme-notes.md", "guide/readme", MATCH_PATH_SUBSTRING],
    ])("%s", (_label, relPath, query, expected) => {
      expect(matchScoreOf(relPath, query)).toBe(expected);
    });

    it("档位 1 命中时不得叠加低档位（全等文件名天然也满足前缀与子串）", () => {
      const score = matchScoreOf("readme.md", "readme.md");
      expect(score).toBe(MATCH_BASENAME_EXACT);
      expect(score).toBeLessThan(
        MATCH_BASENAME_EXACT + MATCH_BASENAME_PREFIX + MATCH_BASENAME_SUBSTRING,
      );
    });

    it("档位 5 模糊子序列：紧凑度越高分越高，且落在 [20, 50]", () => {
      // "ntd" 在 notes/todo-today.md 中贪心首现于 0/2/8 → 跨度 9 → 20 + round(30*3/9) = 30
      expect(matchScoreOf("notes/todo-today.md", "ntd")).toBe(30);
      // 用下划线打断连续性，才真正落到档位 5（文件名/路径连续包含会被档位 2~4 先截）
      expect(matchScoreOf("x/n_t_d.md", "ntd")).toBe(38);
      expect(matchScoreOf("x/n___t___d.md", "ntd")).toBe(30);
      expect(matchScoreOf("x/n_t_d.md", "ntd")!).toBeGreaterThan(
        matchScoreOf("x/n___t___d.md", "ntd")!,
      );
      for (const path of ["notes/todo-today.md", "x/n_t_d.md", "x/n___t___d.md"]) {
        const score = matchScoreOf(path, "ntd")!;
        expect(score).toBeGreaterThanOrEqual(20);
        expect(score).toBeLessThanOrEqual(50);
      }
    });

    it("档位 5 要求字符按序出现：顺序不符则不入选", () => {
      // "dtn"：d 出现在 t 之前，按序匹配失败
      expect(matchScoreOf("notes/todo-today.md", "dtn")).toBeNull();
    });

    it("完全不命中返回 null（该候选被剔除）", () => {
      expect(matchScoreOf("notes/alpha.md", "zzz")).toBeNull();
      expect(rank([cand("notes/alpha.md")], "zzz")).toEqual([]);
    });

    it("路径片段输入（docs/readme）走档位 4", () => {
      expect(matchScoreOf("docs/readme.md", "docs/readme")).toBe(MATCH_PATH_SUBSTRING);
    });

    it("大小写不敏感", () => {
      expect(matchScoreOf("Notes/README.md", "readme")).toBe(MATCH_BASENAME_PREFIX);
    });
  });

  describe("加权项", () => {
    it("已打开标签页固定加 OPEN_TAB_BONUS", () => {
      const closed = rank([cand("a.md")], "")[0];
      const opened = rank([cand("a.md", { isOpen: true })], "")[0];
      expect(opened.score - closed.score).toBe(OPEN_TAB_BONUS);
    });

    it("最近打开权重随序位递减，超出列表与负序位均为 0", () => {
      expect(recencyScore(0)).toBe(RECENCY_MAX);
      expect(recencyScore(3)).toBe(RECENCY_MAX - 30);
      expect(recencyScore(10)).toBe(0);
      expect(recencyScore(99)).toBe(0);
      expect(recencyScore(-1)).toBe(0);
    });

    it("深度惩罚是**减去**：越深越靠后（issue 原文写作 +，属笔误）", () => {
      const shallow = rank([cand("a.md")], "")[0];
      const deep = rank([cand("x/y/z/a.md")], "")[0];
      expect(deep.score).toBe(shallow.score - 3 * DEPTH_PENALTY_PER_LEVEL);
      expect(deep.score).toBeLessThan(shallow.score);
    });

    it("已打开优先压过「浅层 + 最近打开」的组合", () => {
      const openedDeep = cand("a/b/c/d/deep.md", { isOpen: true });
      const recentShallow = cand("shallow.md", { recentIndex: 0 });
      expect(rank([openedDeep, recentShallow], "")[0].relPath).toBe("a/b/c/d/deep.md");
    });
  });

  describe("排序确定性", () => {
    it("同分按 relPath 升序，结果与输入顺序无关", () => {
      const input = [cand("b.md"), cand("a.md"), cand("c.md")];
      const forward = rank(input, "").map((r) => r.relPath);
      const backward = rank([...input].reverse(), "").map((r) => r.relPath);
      expect(forward).toEqual(["a.md", "b.md", "c.md"]);
      expect(backward).toEqual(forward);
    });

    it("relPath 小写后同分时，再由绝对路径兜底（保证任何输入顺序结果一致）", () => {
      // "a.md" 与 "A.md" 小写后相同 → 落到第三级比较："/w/A.md" < "/w/a.md"（code-unit）
      const input = [cand("B.md"), cand("a.md"), cand("A.md")];
      const out = rank(input, "").map((r) => r.relPath);
      expect(out).toEqual(["A.md", "a.md", "B.md"]);
      expect(rank([...input].reverse(), "").map((r) => r.relPath)).toEqual(out);
    });

    it("空查询返回全部候选，按基础分排序（不剔除）", () => {
      const input = [cand("b.md"), cand("a/deep.md")];
      expect(rank(input, "").length).toBe(2);
      // 纯空白同样视为空查询
      expect(rank(input, "   ").length).toBe(2);
    });
  });

  describe("辅助函数", () => {
    it("basenameOf 取最后一段，无分隔符时即自身", () => {
      expect(basenameOf("docs/guide/readme.md")).toBe("readme.md");
      expect(basenameOf("readme.md")).toBe("readme.md");
    });

    it("depthOf 统计目录层数（根下直接文件为 0）", () => {
      expect(depthOf("readme.md")).toBe(0);
      expect(depthOf("docs/readme.md")).toBe(1);
      expect(depthOf("a/b/c/d.md")).toBe(3);
    });

    it("scoreCandidate 与 rankQuickOpenFiles 对同一候选给出一致分数", () => {
      // 「每个候选只算一次档位分」不需要运行时用例守：scoreCandidate 的第二参
      // 就是 matchScore（数值），想在内部重算必须自己再调 matchScoreOf —— 类型
      // 上不禁止但已无传入 query 的入口，属于编译期可见的约束（评审 P3-1）。
      const candidate = cand("docs/readme.md", { isOpen: true, recentIndex: 2 });
      const matchScore = matchScoreOf(candidate.relPath, "readme")!;
      expect(scoreCandidate(candidate, matchScore)).toBe(rank([candidate], "readme")[0].score);
      expect(rank([candidate], "readme")[0].matchScore).toBe(MATCH_BASENAME_PREFIX);
    });
  });
});
