// server/src/__tests__/qa-layer-recurrence-remediation.test.ts
//
// [purpose] [qa layer feedback loop] 재발 승격 항목이 기계적 remediation 을 차단하는지 검증.
//   tryQaRemediationPass 에 들어가는 findingsByQaStepId 매핑에 유효 계층 findings 가 전달되므로,
//   선언은 artifact 지만 재발 승격된 항목이 있으면 not_applicable 이 발동해 생산자 재작업 경로로
//   폴백한다(선언 source_data 와 동일 취급 — 설계 §4.2.2). 대조군: 재발 없는 동일 시드은 remediation 이
//   그대로 적용된다(원인이 승격임을 인과적으로 증명).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueWorkProducts,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa recurrence remediation tests: ${support.reason ?? "unsupported"}`);

const PRODUCER = "produce";
const QA = "qa-validate";
const MAX_ITER = 2;

/** 재발 대상 finding — 선언 계층은 artifact(승격 전에는 기계적 수정 대상이 될 수 있는 계층). */
const RECURRING_FINDING = { id: "term-exposure", summary: "internal term exposed in index.html", layer: "artifact" as const };

function buildSteps(agentId: string) {
  return [
    {
      id: PRODUCER,
      name: "Produce",
      agentId,
      dependencies: [],
      conditionalDependencies: [{ stepId: QA, when: "qa_request_changes" as const, isBackEdge: true, maxIterations: MAX_ITER }],
    },
    { id: QA, name: "QA validate", agentId, dependencies: [PRODUCER] },
  ];
}

interface Seed {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowRunId: string;
  producerIssueId: string;
  qaIssueId: string;
}

async function seedScenario(db: Db, opts: {
  readonly artifactUrl: string;
  readonly findings: unknown[];
  readonly priorFindings?: unknown[] | null;
}): Promise<Seed> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: `RecCo-${companyId.slice(0, 8)}`, issuePrefix: `RC${companyId.slice(0, 8)}`, requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: `worker-${agentId.slice(0, 8)}`, role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  // oversight 이슈 없음 — source_only 승격이어도 오너 카드 확보가 실패해 기존 재작업 경로로 폴백한다(fail-closed).
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: `recurrence mission ${missionId.slice(0, 8)}`, status: "active" });

  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  await db.insert(issues).values({ id: producerIssueId, companyId, missionId, title: "produce-report", description: "Produce the final report HTML.", status: "done", assigneeAgentId: agentId });
  await db.insert(issues).values({ id: qaIssueId, companyId, missionId, title: "qa-validate", description: "Validate the report.", status: "done", assigneeAgentId: agentId });
  await db.insert(issueWorkProducts).values({
    companyId, issueId: producerIssueId, type: "file", provider: "local", title: "report", status: "active", url: opts.artifactUrl,
  });

  const steps = buildSteps(agentId);
  const workflowId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "recurrence-remediation-wf", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, missionId, status: "running", triggeredBy: "test" });

  const producerCompletedAt = new Date(Date.now() - 60_000);
  await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: PRODUCER, companyId, issueId: producerIssueId, status: "completed", iterationIndex: 0, completedAt: producerCompletedAt,
  });
  const [qaRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: QA, companyId, issueId: qaIssueId, status: "failed", completedAt: new Date(Date.now() - 20_000),
  }).returning();

  // 직전 세대 반려 이벤트(선택) — 생산자 완료 이전 관측(정상 재발 시나리오), 같은 stepRun 행에 누적.
  if (opts.priorFindings) {
    const priorHeartbeatId = randomUUID();
    const priorObservedAt = new Date(Date.now() - 600_000);
    await db.insert(heartbeatRuns).values({
      id: priorHeartbeatId, companyId, agentId, issueId: qaIssueId, status: "succeeded",
      startedAt: new Date(priorObservedAt.getTime() - 60_000), finishedAt: priorObservedAt,
    });
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun!.id, issueId: qaIssueId,
      heartbeatRunId: priorHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      createdAt: priorObservedAt,
      idempotencyKey: `recurrence-verdict-prior:${qaRun!.id}`,
      payload: {
        kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaRun!.id, issueId: qaIssueId,
        verdict: "request_changes", reason: "prior generation rejection.", findings: opts.priorFindings,
      },
    });
  }

  // 이번 세대 판정 — findings + 적용 가능한 remediations(재발이 없으면 적용되어야 하는 정상 계약).
  const wakeupId = randomUUID();
  const verdictHeartbeatId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "workflow.dispatch", workflowStepRunId: qaRun!.id });
  const hbAt = new Date(Date.now() - 25_000);
  await db.insert(heartbeatRuns).values({
    id: verdictHeartbeatId, companyId, agentId, issueId: qaIssueId, status: "succeeded",
    wakeupRequestId: wakeupId, startedAt: hbAt, finishedAt: hbAt, createdAt: hbAt,
  });
  await db.insert(workflowTransitionEvents).values({
    companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun!.id, issueId: qaIssueId,
    heartbeatRunId: verdictHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `recurrence-verdict:${qaRun!.id}:${verdictHeartbeatId}`,
    payload: {
      kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaRun!.id, issueId: qaIssueId,
      verdict: "request_changes", reason: "internal term exposure in index.html",
      findings: opts.findings,
      remediations: { items: [{ op: "string_replace", file: opts.artifactUrl, find: "leads/evidence.json", replace: "선별 근거 요약" }] },
    },
  });

  return { companyId, agentId, missionId, workflowRunId: runId, producerIssueId, qaIssueId };
}

describeEP("qa layer feedback loop — recurrence promotion blocks mechanical remediation", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-recurrence-rem-");
    db = createDb(tempDb.connectionString);
    tempRoot = await mkdtemp(path.join(tmpdir(), "qa-rec-rem-"));
  }, 60_000);
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function runPass(seed: Seed, refireLog: Array<{ stepRunId: string }>) {
    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.workflowRunId));
    return applyBackEdgeReworkPass({
      db,
      run: { id: seed.workflowRunId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
      steps: buildSteps(seed.agentId) as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId: new Map([[QA, { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }]]),
      validationVerdictsByIssueId: new Map([[seed.qaIssueId, { observedAt: new Date() }]]),
      refireQaStep: async (qa) => { refireLog.push({ stepRunId: qa.stepRunId }); return true; },
    });
  }

  it("control (no recurrence): the same verdict's remediations still apply deterministically", async () => {
    const artifactPath = path.join(tempRoot, "control", "index.html");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "<html>내부 용어 leads/evidence.json 노출됨</html>", "utf8");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, findings: [RECURRING_FINDING] });

    const refireLog: Array<{ stepRunId: string }> = [];
    const result = await runPass(seed, refireLog);

    expect(result.reworkedCount).toBe(0);
    expect(result.remediatedCount).toBe(1);
    expect(refireLog).toHaveLength(1);
    expect(await readFile(artifactPath, "utf8")).toBe("<html>내부 용어 선별 근거 요약 노출됨</html>");
  });

  it("promoted finding (same id as prior generation) → remediation not_applicable → producer rework with recurrence tag", async () => {
    const artifactPath = path.join(tempRoot, "recurrence", "index.html");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "<html>내부 용어 leads/evidence.json 노출됨</html>", "utf8");
    const seed = await seedScenario(db, {
      artifactUrl: artifactPath,
      findings: [RECURRING_FINDING],
      priorFindings: [RECURRING_FINDING], // 같은 finding id 재발 → 유효 계층 source_data 승격
    });

    const refireLog: Array<{ stepRunId: string }> = [];
    const result = await runPass(seed, refireLog);

    // remediation 미적용(원천 결함은 기계적 산출물 수정으로 해결 불가) → 기존 재작업 경로로 폴백.
    expect(result.remediatedCount).toBe(0);
    expect(result.reworkedCount).toBe(1);
    expect(refireLog).toHaveLength(0);
    expect(await readFile(artifactPath, "utf8")).toBe("<html>내부 용어 leads/evidence.json 노출됨</html>");
    const applied = await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, seed.companyId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    ));
    expect(applied).toHaveLength(0);

    // 재작업 계약 feedback 에 재발 승격 태그가 병기된다.
    const [producer] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, seed.workflowRunId),
      eq(workflowStepRuns.stepId, PRODUCER),
    ));
    expect(producer!.status).toBe("pending");
    expect(producer!.iterationIndex).toBe(1);
    const metadata = (producer!.metadata ?? {}) as Record<string, unknown>;
    const contract = metadata.workflowReworkContract as { qaFeedbacks: Array<{ feedback: string | null }> } | undefined;
    expect(contract).toBeDefined();
    const feedback = contract!.qaFeedbacks[0]!.feedback ?? "";
    expect(feedback).toContain("생산자 범위 밖(재발 승격)");
    expect(feedback).toContain("(term-exposure)");
  });
});
