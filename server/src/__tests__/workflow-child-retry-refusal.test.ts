// @vitest-environment node
// [descope v1 D2] workflow 스텝 retry 정책 거부 전용 스위트(wf-child-fix-round-retry 삭제 대체).
//   policy retry 체인/세대 교체는 삭제됐다 — 남는 계약은 "거부"다:
//   (1) retry 스케줄러(applyWorkflowStepRetryPass)는 workflow-type S 를 어떤 변이 없이 건너뛴다.
//   (2) 수동 issue-less retry(retryIssueLessToolWorkflowStep)는 workflow-type S 를 null 로 거부하며
//       schedule/reset/retry-count 증가가 일어나기 전에 거부된다.
//   두 경우 모두 실행 행 스냅숏이 무변경임을 증명한다(설계 §6 — 무변경 없는 통과는 인정 없음).
//   저장 정의의 retry 옵션은 raw 삽입으로 공유 검증을 우회해 "이미 저장된" 상태를 만든다 —
//   공유 validator 거부 자체는 validators 스위트 소관이고, 여기는 런타임 경계다.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyWorkflowStepRetryPass } from "../services/workflow/workflow-step-retry-pass.js";
import {
  normalizeWorkflowStepsForExecution,
  retryIssueLessToolWorkflowStep,
} from "../services/workflow/dag-engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow child retry-refusal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

describeEmbeddedPostgres("workflow child retry refusal (descope D2)", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-retry-refusal-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * 실패한 workflow S + 저장 정의의 retry 정책(공유 검증 우회 raw 삽입) + 주입된 workflowRetry
   * 대기 상태 — 스케줄러 경계의 입력이다. 런타임 자체는 이 상태를 만들지 않는다(fail-closed 입력).
   */
  async function failedWorkflowStepWithRetryPolicy(name: string) {
    const companyId = await createCompanyFixture(name);
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [{ ...childStep(childDefId), onFailure: "retry", maxRetries: 2, graphRetryDelaySeconds: 0 }],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      stepStatus: "failed",
      metadata: {
        workflowRetry: {
          state: "waiting", retryNumber: 0, maxRetries: 2,
          nextEligibleAt: new Date().toISOString(),
        },
      },
    });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, parentDefId));
    return {
      companyId,
      runId,
      stepRunId,
      run: run!,
      stepRun: stepRun!,
      steps: normalizeWorkflowStepsForExecution(definition!.stepsJson),
    };
  }

  async function executionSnapshot(stepRunId: string) {
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId));
    return JSON.stringify({
      stepRun: stepRun
        ? { status: stepRun.status, retryCount: stepRun.retryCount, metadata: stepRun.metadata }
        : null,
      invocations: await db.select().from(workflowStepInvocations),
      childRuns: await db.select().from(workflowRuns).where(eq(workflowRuns.triggerSource, "workflow")),
    });
  }

  it("retry-pass never schedules a workflow S: returned set and rows are unchanged", async () => {
    const x = await failedWorkflowStepWithRetryPolicy("RetryRefusal Pass Co");
    const snapshotBefore = await executionSnapshot(x.stepRunId);

    const returned = await applyWorkflowStepRetryPass({
      db,
      context: { run: { id: x.runId, companyId: x.companyId, status: x.run.status }, steps: x.steps },
      stepRuns: [x.stepRun],
      validationVerdictsByIssueId: new Map(),
    });

    // 스케줄 대상에서 제외 — 반환 집합에 그대로 남고(재스케줄 마킹 없음), 어떤 행도 바뀌지 않는다.
    expect(returned.map((s) => s.id)).toEqual([x.stepRunId]);
    expect(await executionSnapshot(x.stepRunId)).toBe(snapshotBefore);
    // 자식 run 도 새로 생기지 않는다(스냅숏의 childRuns 가 빈 배열로 유지).
  });

  it("retryIssueLessToolWorkflowStep rejects a workflow-type S before any mutation", async () => {
    const companyId = await createCompanyFixture("RetryRefusal Manual Co");
    const childDefId = await insertDefinition({
      companyId,
      name: "child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const { runId, stepRunId } = await insertRunWithWorkflowStepRun({
      companyId,
      workflowId: parentDefId,
      stepStatus: "pending",
    });
    const snapshotBefore = await executionSnapshot(stepRunId);

    const result = await retryIssueLessToolWorkflowStep(db, {
      companyId,
      runId,
      stepId: "run-child",
    });

    // typed 거부(null) — 리셋/스케줄/retryCount 증가 이전이다.
    expect(result).toBeNull();
    expect(await executionSnapshot(stepRunId)).toBe(snapshotBefore);
  });
});
