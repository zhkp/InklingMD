// #413 防止 workflow 说明与 PR 实际触发条件再次脱节。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

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

  it("compares the Benchmark and Build pull-request filters", () => {
    const benchmarkPR = eventBlock(benchmark, "pull_request");
    const buildPR = eventBlock(build, "pull_request");

    expect(benchmarkPR).toMatch(/^\s{4}branches:\s*\[main\]\s*$/m);
    expect(buildPR).toMatch(
      /^\s{4}types:\s*\[opened, synchronize, reopened\]\s*$/m,
    );
    expect(buildPR).not.toMatch(/^\s{4}branches:/m);
  });

  it("keeps the benchmark comment from claiming PRs do not run CI", () => {
    const header = benchmark.slice(0, benchmark.indexOf("\non:"));
    expect(header).not.toMatch(/PR.{0,16}不跑.{0,16}CI/);
  });

  it("keeps the Build test job active on PRs with its Windows/Linux matrix", () => {
    const testJob = jobBlock(build, "test");
    expect(testJob).toContain("os: [windows-latest, ubuntu-latest]");
    expect(testJob).not.toMatch(/^    if:.*pull_request/im);
  });

  it("skips only the two Tauri packaging jobs for pull requests", () => {
    for (const job of ["build-windows", "build-linux"]) {
      expect(jobBlock(build, job)).toMatch(
        /^    if: github\.event_name != 'pull_request'\s*$/m,
      );
    }
  });
});
