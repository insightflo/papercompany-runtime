// server/src/__tests__/validation-verdict-prior-findings.test.ts
//
// [purpose] [qa layer feedback loop] validation-verdict-ledger 의 loadPriorRejectedFindings 단위 검증.
//   QA stepRun 행은 재작업 세대 간 재사용되므로 같은 stepRunId 의 공식 request_changes 판정 이벤트가
//   세대별로 누적된다 — 헬퍼는 최신(=이번 세대) 이벤트를 제외한 직전 1건의 findings 를 반환해야 한다.
//   커버: 2건 누적 시 직전 1건 반환 / 1건뿐이면 null / 세대 경계 가드(notAfter 이후 관측 직전 판정은
//   같은 생산자 세대에 대한 중복 반려 — 재발 근거 부인) / 파싱·스코프 규칙은 loadWorkflowApiFindings 와 동일.

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowStepRuns } from "@paperclipai/db";import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  loadPriorRejectedFindings,
  loadWorkflowApiFindings,
} from "../services/workflow/validation-verdict-ledger.js";
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip prior-rejected-findings tests: ${support.reason ?? "unsupported"}`);

const CURRENT_FINDINGS = [
  { id: "f-current-1", summary: "current generation defect", layer: "artifact" as const },
];
const PRIOR_FINDINGS = [
  { id: "f-prior-1", summary: "prior generation defect", layer: "artifact" as const },
  { id: "f-prior-2", summary: "prior generation source defect", layer: "source_data" as const },
];

async function loadQaStepRunId(db: ReturnType<typeof createDb>, runId: string): Promise<string> {
  // 시드는 collect/produce/qa-validate 스텝을 insert 한다 — qa-validate 행이 QA stepRun(세대 간 재사용)이다.
  const rows = await db.select({ id: workflowStepRuns.id, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, runId));
  expect(rows.length).toBeGreaterThan(0);
  const qa = rows.find((row) => row.stepId === "qa-validate");
  expect(qa).toBeDefined();
  return qa!.id;
}

describeDb("loadPriorRejectedFindings (qa layer feedback loop)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-prior-findings-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  it("returns the previous generation findings when two request_changes events accumulate on the same step run", async () => {
    const seed = await seedQaSourceDefectScenario(db, CURRENT_FINDINGS, { priorFindings: PRIOR_FINDINGS });
    const qaStepRunId = await loadQaStepRunId(db, seed.runId);
    const base = {
      db,
      companyId: seed.companyId,
      issueId: seed.qaIssueId,
      workflowRunId: seed.runId,
      workflowStepRunId: qaStepRunId,
    };

    // 최신 이벤트(이번 세대)는 기존 로더가 그대로 반환한다.
    const current = await loadWorkflowApiFindings(base);
    expect(current?.map((finding) => finding.id)).toEqual(["f-current-1"]);

    // 직전 이벤트(직전 세대) findings 를 반환한다 — 최신과 동일한 파싱/스코프 규칙.
    const prior = await loadPriorRejectedFindings(base);
    expect(prior?.map((finding) => finding.id)).toEqual(["f-prior-1", "f-prior-2"]);
    expect(prior?.[1]?.layer).toBe("source_data");
  });

  it("returns null when only one verdict event exists (no previous generation)", async () => {
    const seed = await seedQaSourceDefectScenario(db, CURRENT_FINDINGS);
    const qaStepRunId = await loadQaStepRunId(db, seed.runId);
    const prior = await loadPriorRejectedFindings({
      db,
      companyId: seed.companyId,
      issueId: seed.qaIssueId,
      workflowRunId: seed.runId,
      workflowStepRunId: qaStepRunId,
    });
    expect(prior).toBeNull();
  });

  it("generation guard: a prior event observed AFTER this producer generation completed is not recurrence evidence", async () => {
    // 직전 판정이 생산자 완료(now-60s) 이후(now-30s)에 관측됐다면 같은 세대 산출물에 대한 중복 반려다.
    const seed = await seedQaSourceDefectScenario(db, CURRENT_FINDINGS, {
      priorFindings: PRIOR_FINDINGS,
      priorObservedAt: new Date(Date.now() - 30_000),
    });
    const qaStepRunId = await loadQaStepRunId(db, seed.runId);
    const [producer] = await db.select({ completedAt: workflowStepRuns.completedAt })
      .from(workflowStepRuns)
      .where(and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce")));
    const producerCompletedAt = producer!.completedAt!;    // notAfter 미지정(원시 조회)에는 findings 가 보이지만,
    const raw = await loadPriorRejectedFindings({
      db, companyId: seed.companyId, issueId: seed.qaIssueId,
      workflowRunId: seed.runId, workflowStepRunId: qaStepRunId,
    });
    expect(raw?.map((finding) => finding.id)).toEqual(["f-prior-1", "f-prior-2"]);

    // 세대 경계 가드 적용 시 재발 근거로 인정하지 않는다(null).
    const guarded = await loadPriorRejectedFindings({
      db, companyId: seed.companyId, issueId: seed.qaIssueId,
      workflowRunId: seed.runId, workflowStepRunId: qaStepRunId,
      notAfter: producerCompletedAt,
    });
    expect(guarded).toBeNull();
  });
});
