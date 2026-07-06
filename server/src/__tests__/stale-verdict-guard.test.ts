import { describe, expect, it } from "vitest";
import { filterFreshRejectedQas, isStaleQaVerdict } from "../services/workflow/control-flow/stale-verdict-guard.js";

// [목적] RES-995 — 같은 stale QA verdict 가 producer rework cap 을 두 번 소모하지 않도록
//   isStaleQaVerdict 가 producer 완료 시점보다 이전에 관측된 verdict 를 stale 으로 판정하는지 검증.
describe("isStaleQaVerdict (RES-995 stale verdict 재소비 차단)", () => {
  const producerCompletedAt = new Date("2026-07-05T06:44:41.274Z"); // RES-995 producer rework run finished

  it("treats a verdict observed before producer completion as stale", () => {
    const verdicts = new Map([["qa-issue-1", { observedAt: new Date("2026-07-05T06:37:25.526Z") }]]);
    // iteration 1 reset 보고 41ms 앞선 stale verdict(실측 패턴) — observedAt < producerCompletedAt.
    expect(isStaleQaVerdict({
      qaIssueId: "qa-issue-1",
      producerCompletedAt,
      validationVerdictsByIssueId: verdicts,
    })).toBe(true);
  });

  it("treats a verdict observed at/after producer completion as fresh", () => {
    const verdicts = new Map([["qa-issue-1", { observedAt: new Date("2026-07-05T06:50:00.000Z") }]]);
    expect(isStaleQaVerdict({
      qaIssueId: "qa-issue-1",
      producerCompletedAt,
      validationVerdictsByIssueId: verdicts,
    })).toBe(false);
  });

  it("is conservative (not stale) when producer completion time is unknown", () => {
    const verdicts = new Map([["qa-issue-1", { observedAt: new Date("2026-07-05T06:37:25.526Z") }]]);
    expect(isStaleQaVerdict({
      qaIssueId: "qa-issue-1",
      producerCompletedAt: null,
      validationVerdictsByIssueId: verdicts,
    })).toBe(false);
  });

  it("is conservative (not stale) when verdict timing is unknown", () => {
    const verdicts = new Map<string, { observedAt: Date | null }>([["qa-issue-1", { observedAt: null }]]);
    expect(isStaleQaVerdict({
      qaIssueId: "qa-issue-1",
      producerCompletedAt,
      validationVerdictsByIssueId: verdicts,
    })).toBe(false);
    expect(isStaleQaVerdict({
      qaIssueId: "qa-issue-2", // verdict map 에 없는 QA
      producerCompletedAt,
      validationVerdictsByIssueId: verdicts,
    })).toBe(false);
  });

  it("is conservative (not stale) when QA issue id is missing", () => {
    const verdicts = new Map([["qa-issue-1", { observedAt: new Date("2026-07-05T06:37:25.526Z") }]]);
    expect(isStaleQaVerdict({
      qaIssueId: null,
      producerCompletedAt,
      validationVerdictsByIssueId: verdicts,
    })).toBe(false);
  });
});

describe("filterFreshRejectedQas (RES-995 back-edge integration)", () => {
  const producerCompletedAt = new Date("2026-07-05T06:44:41.274Z");

  it("drops only stale verdicts and keeps fresh ones so a single sync tick cannot double-consume the cap", () => {
    const rejectedQas = [
      // stale: observed before producer completed (RES-995 pattern, 41ms ahead of rework reset)
      { qaRun: { issueId: "qa-stale" } },
      // fresh: observed after producer completed (new QA run on the new generation)
      { qaRun: { issueId: "qa-fresh" } },
    ];
    const verdicts = new Map<string, { observedAt: Date | null }>([
      ["qa-stale", { observedAt: new Date("2026-07-05T06:37:25.526Z") }],
      ["qa-fresh", { observedAt: new Date("2026-07-05T06:50:00.000Z") }],
    ]);

    const fresh = filterFreshRejectedQas(rejectedQas, producerCompletedAt, verdicts);

    expect(fresh.map((q) => q.qaRun?.issueId)).toEqual(["qa-fresh"]);
  });

  it("returns all when producer completion time is unknown (preserves prior behavior)", () => {
    const rejectedQas = [{ qaRun: { issueId: "qa-1" } }];
    const verdicts = new Map([["qa-1", { observedAt: new Date("2026-07-05T06:37:25.526Z") }]]);
    expect(filterFreshRejectedQas(rejectedQas, null, verdicts)).toEqual(rejectedQas);
  });

  it("returns all rejected when no verdict timing is available", () => {
    const rejectedQas = [{ qaRun: { issueId: "qa-1" } }];
    expect(filterFreshRejectedQas(rejectedQas, producerCompletedAt, undefined)).toEqual(rejectedQas);
  });
});
