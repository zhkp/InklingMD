// #225 评审阻塞 1 的回归护栏：dark 归并删除覆盖后，语义 token 必须**仍有 var() 消费点**。
//
// 背景：被删的 dark 覆盖里，有 3 条的基础规则消费的是**另一个 token**（例如 `.tt-btn:hover`
// 基础用 `--btn-hover-bg`，覆盖用 `--content-table-toolbar-hover`；两者在 dark 下取值不同）。
// 直接删覆盖 → 静默改色，且语义 token 变成「只有定义、没有消费者」的死值。
// 现有守卫（S9 硬编码色 / S16 产物 / S17 CM 宿主）都不检查「token 有没有消费者」，故需要本断言。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** 为 dark 专门调过值、且必须由**基础规则**（@layer base）消费的语义 token */
const MUST_BE_CONSUMED = [
  "--content-table-toolbar-hover",
  "--shell-diff-remove-fg",
  "--shell-diff-add-fg",
  "--shell-capture-bg",
  "--shell-capture-border",
  "--shell-capture-fg",
  "--content-search-match-bg",
] as const;

function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectSources(full, out);
    else if (/\.(css|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("#225：dark 归并后的语义 token 消费点护栏", () => {
  const sources = collectSources(resolve(process.cwd(), "src"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it.each(MUST_BE_CONSUMED)("%s 至少有一个 var() 消费点", (token) => {
    // 只数 `var(--token…)`：token **定义**（`--token: …`）不算消费点
    const consumers = sources.match(new RegExp(`var\\(\\s*${token}\\s*[,)]`, "g")) ?? [];
    expect(
      consumers.length,
      `${token} 已无 var() 消费点：删 dark 覆盖会静默改色，并留下只有定义没有消费者的死值`,
    ).toBeGreaterThan(0);
  });
});
