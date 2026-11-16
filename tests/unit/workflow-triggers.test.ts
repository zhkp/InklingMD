// #413 防止 workflow 说明与 PR 实际触发条件再次脱节。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

const topLevelOnHeaders = (workflow: string): RegExpMatchArray[] =>
  Array.from(workflow.matchAll(/^on:[ \t]*$/gm));

const eventBlock = (workflow: string, event: string): string => {
  const jobsIndex = workflow.indexOf("\njobs:");
  const triggers = jobsIndex === -1 ? workflow : workflow.slice(0, jobsIndex);
  const eventHeader = new RegExp(`^  ${event}:\\s*$`, "m").exec(triggers);
  if (!eventHeader) return "";

  const remainingEvents = triggers.slice(eventHeader.index + eventHeader[0].length);
  const nextEvent = /^  [\w-]+:\s*$/m.exec(remainingEvents);
  return nextEvent ? remainingEvents.slice(0, nextEvent.index) : remainingEvents;
};

const jobBlock = (workflow: string, job: string): string => {
  const jobsIndex = workflow.indexOf("\njobs:");
  const jobs = jobsIndex === -1 ? workflow : workflow.slice(jobsIndex);
  const jobHeader = new RegExp(`^  ${job}:\\s*$`, "m").exec(jobs);
  if (!jobHeader) return "";

  const remainingJobs = jobs.slice(jobHeader.index + jobHeader[0].length);
  const nextJob = /^  [\w-]+:\s*$/m.exec(remainingJobs);
  return nextJob ? remainingJobs.slice(0, nextJob.index) : remainingJobs;
};

describe("#413 GitHub Actions PR trigger documentation", () => {
  const benchmark = read(".github/workflows/benchmark.yml");
  const build = read(".github/workflows/build.yml");

  it("requires exactly one valid top-level on key in each workflow", () => {
    for (const workflow of [benchmark, build]) {
      expect(topLevelOnHeaders(workflow)).toHaveLength(1);
    }
  });

  it("compares the Benchmark and Build pull-request filters", () => {
    const benchmarkPR = eventBlock(benchmark, "pull_request");
    const buildPR = eventBlock(build, "pull_request");

    expect(benchmarkPR).toMatch(/^\s{4}branches:\s*\[main\]\s*$/m);
    expect(buildPR).toMatch(
      /^\s{4}types:\s*\[opened, synchronize, reopened\]\s*$/m,
    );
    expect(buildPR).not.toMatch(/^\s{4}branches:/m);
  });

  it("guards both workflows' push filters and manual triggers", () => {
    for (const workflow of [benchmark, build]) {
      const push = eventBlock(workflow, "push");
      expect(push).toMatch(/^\s{4}branches:\s*\[main\]\s*$/m);
      expect(push).toMatch(/^\s{4}tags:\s*\[\"v\*\"\]\s*$/m);
      expect(eventBlock(workflow, "workflow_dispatch")).not.toBe("");
    }
    expect(eventBlock(benchmark, "workflow_dispatch")).toContain("profile:");
  });

  it("keeps the benchmark comment from claiming PRs do not run CI", () => {
    const onHeaders = topLevelOnHeaders(benchmark);
    expect(onHeaders).toHaveLength(1);
    const onIndex = onHeaders[0]?.index ?? -1;
    expect(onIndex).toBeGreaterThan(0);
    const header = benchmark.slice(0, onIndex);
    expect(header).toContain("main 目标分支的 PR");
    expect(header).not.toMatch(
      /(?:PR.{0,16}不(?:会)?(?:跑|运行|执行)|不(?:会)?(?:跑|运行|执行).{0,16}PR|不触发|不在\s*PR\s*上(?:运行|执行))/,
    );
  });

  it("keeps the Build test job active on PRs with its Windows/Linux matrix", () => {
    const testJob = jobBlock(build, "test");
    expect(testJob).toContain("os: [windows-latest, ubuntu-latest]");
    expect(testJob).not.toMatch(/^ {4}if:/m);
  });

  it("explicitly excludes pull requests from both Tauri packaging jobs", () => {
    for (const job of ["build-windows", "build-linux"]) {
      expect(jobBlock(build, job)).toMatch(
        /^    if: github\.event_name != 'pull_request'\s*$/m,
      );
    }
  });

  it("keeps release jobs restricted to tag pushes", () => {
    for (const job of ["release-guard", "release"]) {
      expect(jobBlock(build, job)).toMatch(
        /^    if: startsWith\(github\.ref, 'refs\/tags\/'\)\s*$/m,
      );
    }
  });
});
