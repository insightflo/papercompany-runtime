import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../services/workflow/resume/reviewed-policy.js", async () => {
  const helper = await import("./helpers/workflow-resume-apply-fixture.js");
  return { REVIEWED_RESUME_POLICIES: helper.TEST_REVIEWED_POLICIES };
});
import type { Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import {
  applySigner,
  seedResumeApplyScenario,
  startExecutionDefinitionFixture,
  TEST_REVIEWED_POLICIES,
  type ExecutionDefinitionFixture,
  type RawSql,
} from "./helpers/workflow-resume-apply-fixture.js";
import { applyResumeForOperatorDecision } from "../services/workflow/resume/apply.js";
import { kindOf } from "../services/workflow/resume/preview-graph.js";
import { resumePreviewEligibleForRun } from "../services/missions/resume-signals.js";
import { deriveResumeStartStep } from "../services/missions/terminal-resume-from-decision.js";
import { randomUUID } from "node:crypto";

// [재개 약속 정직화 2026-10-23] 가용성 판정은 실제 프리뷰와 일치해야 한다 — 정책 등록만으로
//   참을 돌려주면 카드가 프리뷰가 거절할 경로를 약속한다(dsh-purge 사례).

describe("kindOf maps PAQO materialized step types", () => {
  it("action/qa with tools resolve as tool, without tools as agent", () => {
    expect(kindOf({ id: "a", type: "action", toolNames: ["manual-onboarding-verify"] } as never)).toBe("tool");
    expect(kindOf({ id: "b", type: "qa", toolNames: ["manual-onboarding-qa"] } as never)).toBe("tool");
    expect(kindOf({ id: "c", type: "action" } as never)).toBe("agent");
    expect(kindOf({ id: "d", type: "qa" } as never)).toBe("agent");
    expect(kindOf({ id: "e", type: "mystery" } as never)).toBeNull();
  });
});

const describeEP = (await getEmbeddedPostgresTestSupport()).supported ? describe : describe.skip;
const SIGNING_KEY_ENV = "PAPERCLIP_WORKFLOW_RESUME_SIGNING_KEY";

describeEP("resumePreviewEligibleForRun matches the real preview verdict", () => {
  let fixture: ExecutionDefinitionFixture;
  let db: Db;
  let sql: RawSql;
  let previousKey: string | undefined;

  beforeAll(async () => {
    fixture = await startExecutionDefinitionFixture("resume-eligibility-");
    if (!fixture.supported) throw new Error(fixture.reason);
    db = fixture.db;
    sql = fixture.sql;
    previousKey = process.env[SIGNING_KEY_ENV];
    process.env[SIGNING_KEY_ENV] = "a".repeat(64);
  }, 60_000);
  afterAll(async () => {
    if (previousKey === undefined) delete process.env[SIGNING_KEY_ENV];
    else process.env[SIGNING_KEY_ENV] = previousKey;
    if (fixture?.supported) await fixture.cleanup();
  });

  it("returns true only while the real preview is eligible, and false without a policy", async () => {
    const scenario = await seedResumeApplyScenario(db, sql, "eligibility-ok-");
    expect(await deriveResumeStartStep(db, scenario.runId)).toBe("gate");
    expect(await resumePreviewEligibleForRun(db, {
      companyId: scenario.companyId, missionId: scenario.missionId, workflowRunId: scenario.runId,
    })).toBe(true);
    // 정책 제거 — 프리뷰가 거절하면 가용성도 거짓이어야 한다(약속 정직화).
    const policies = [...TEST_REVIEWED_POLICIES];
    TEST_REVIEWED_POLICIES.length = 0;
    expect(await resumePreviewEligibleForRun(db, {
      companyId: scenario.companyId, missionId: scenario.missionId, workflowRunId: scenario.runId,
    })).toBe(false);
    TEST_REVIEWED_POLICIES.push(...policies);
    // 적용 후에도(런 running 전환 등) 판정은 프리뷰를 따라간다.
    const decisionId = randomUUID();
    const applied = await applyResumeForOperatorDecision(db, {
      companyId: scenario.companyId, missionId: scenario.missionId, workflowRunId: scenario.runId,
      startStepId: "gate", reason: "eligibility probe", idempotencyKey: decisionId,
      authorization: { kind: "operator_decision", operatorDecisionId: decisionId, resolvedByUserId: "local-board" },
    }, applySigner(new Date()));
    expect(applied.id).toBeTruthy();
  });
});
