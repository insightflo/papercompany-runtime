// server/src/__tests__/qa-layer-recurrence-remediation.test.ts
//
// [purpose] Verify recurrence preserves cause, remediation idempotency, and explicit-source guards.

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

/** Recurrence must not change this declared cause. */
const RECURRING_FINDING = { id: "term-exposure", summary: "internal term exposed in index.html", layer: "artifact" as const };
const SOURCE_FINDING = { id: "source-missing", summary: "source rows are absent", layer: "source_data" as const };

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
  // No oversight issue: an explicit source-only finding cannot create an owner card without a linked issue.
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

describeEP("qa layer feedback loop — cause-preserving remediation", () => {
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

  it("recurring artifact keeps its cause, applies the official correction once, then waits", async () => {
    const artifactPath = path.join(tempRoot, "recurrence", "index.html");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "<html>내부 용어 leads/evidence.json 노출됨</html>", "utf8");
    const seed = await seedScenario(db, {
      artifactUrl: artifactPath,
      findings: [RECURRING_FINDING],
      priorFindings: [RECURRING_FINDING],
    });

    const refireLog: Array<{ stepRunId: string }> = [];
    const result = await runPass(seed, refireLog);

    expect(result.remediatedCount).toBe(1);
    expect(result.reworkedCount).toBe(0);
    expect(refireLog).toHaveLength(1);
    expect(await readFile(artifactPath, "utf8")).toBe("<html>내부 용어 선별 근거 요약 노출됨</html>");
    const applied = () => db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, seed.companyId),
      eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    ));
    expect(await applied()).toHaveLength(1);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.workflowRunId));
    const second = await runPass(seed, refireLog);
    expect(second.remediatedCount).toBe(0);
    expect(second.reworkedCount).toBe(0);
    expect(refireLog).toHaveLength(1);
    expect(await applied()).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowRunId, seed.workflowRunId))).toEqual(wakeups);

    const [producer] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, seed.workflowRunId),
      eq(workflowStepRuns.stepId, PRODUCER),
    ));
    expect(producer!.status).toBe("completed");
    expect(producer!.iterationIndex).toBe(0);
    expect(producer!.metadata ?? {}).not.toHaveProperty("qaReworkCapBoost");
  });

  it("explicit source_data still blocks mechanical correction and stays within the producer cap", async () => {
    const artifactPath = path.join(tempRoot, "source", "index.html");
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, "<html>source-dependent output</html>", "utf8");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, findings: [SOURCE_FINDING] });
    const refireLog: Array<{ stepRunId: string }> = [];
    const result = await runPass(seed, refireLog);

    expect(result.remediatedCount).toBe(0);
    expect(result.reworkedCount).toBe(1);
    expect(refireLog).toHaveLength(0);
    expect(await readFile(artifactPath, "utf8")).toBe("<html>source-dependent output</html>");
    const [producer] = await db.select().from(workflowStepRuns).where(and(
      eq(workflowStepRuns.workflowRunId, seed.workflowRunId), eq(workflowStepRuns.stepId, PRODUCER),
    ));
    expect(producer!.status).toBe("pending");
    expect(producer!.iterationIndex).toBe(1);
  });
});
