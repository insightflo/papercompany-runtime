// server/src/__tests__/qa-remediation-pass.test.ts
//
// [purpose] End-to-end tests for QA structured mechanical remediations:
//   when a semantic QA submits an official request_changes verdict carrying
//   schema-validated `remediations` (string_replace items scoped to the producer's
//   registered artifact directory), the back-edge pass applies the deterministic
//   patch WITHOUT resetting/re-running the producer, records an auditable
//   qa_remediation_applied transition event, and re-fires ONLY the QA step.
//   Any non-applicable case falls back to the existing producer rework path.
//
// Covers: applied path, idempotent hold (same verdict), wake-failure fallback,
// find-not-found fallback, boundary violation fallback, missing remediations
// (legacy regression), attempt-cap fallback, execution-freshness fallback,
// and the ledger loader (loadLatestQaRemediations).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals, workflowTerminalDecisions, workflowRecoveryAuthorities,
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
import { loadLatestQaRemediations } from "../services/workflow/validation-verdict-ledger.js";
import { computeDefectSignature } from "../services/workflow/control-flow/knowledge-draft-capture.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`skip qa-remediation tests: ${support.reason ?? "unsupported host"}`);

type StepRun = typeof workflowStepRuns.$inferSelect;

const PRODUCER = "produce";
const QA = "qa-validate";
const MAX_ITER = 2;

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

interface SeedOptions {
  /** verdict payload `remediations` value (already-shaped object); omit for legacy verdicts. */
  remediations?: Record<string, unknown> | null;
  /** absolute path registered as the producer's active work product. */
  artifactUrl?: string;
  /** newer heartbeat (after the verdict heartbeat) bound to the QA step run — breaks execution freshness. */
  newerHeartbeatAfterVerdict?: boolean;
  /** number of pre-existing qa_remediation_applied events for the QA step run. */
  priorRemediationEvents?: number;
  /** 재사용 회사(P1 캡처 등 회사 스코프 집계 테스트용). 미지정 시 신규 회사. */
  companyId?: string;
}

interface Seed {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowRunId: string;
  producer: StepRun;
  qa: StepRun;
  producerIssueId: string;
  qaIssueId: string;
  verdictEventId: string;
  verdictHeartbeatId: string;
}

async function seedScenario(db: Db, opts: SeedOptions): Promise<Seed> {
  const companyId = opts.companyId ?? randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  if (!opts.companyId) {
    await db.insert(companies).values({ id: companyId, name: `RemCo-${companyId.slice(0, 8)}`, issuePrefix: `RM${companyId.slice(0, 8)}`, requireBoardApprovalForNewAgents: false });
  }
  await db.insert(agents).values({ id: agentId, companyId, name: `worker-${agentId.slice(0, 8)}`, role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: `remediation mission ${missionId.slice(0, 8)}`, status: "active" });

  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  await db.insert(issues).values({ id: producerIssueId, companyId, missionId, title: "produce-report", description: "Produce the final report HTML.", status: "done", assigneeAgentId: agentId });
  await db.insert(issues).values({ id: qaIssueId, companyId, missionId, title: "qa-validate", description: "Validate the report.", status: "done", assigneeAgentId: agentId });

  if (opts.artifactUrl) {
    await db.insert(issueWorkProducts).values({
      companyId, issueId: producerIssueId, type: "file", provider: "local", title: "report", status: "active", url: opts.artifactUrl,
    });
  }

  const steps = buildSteps(agentId);
  const workflowId = randomUUID();
  const runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "remediation-wf", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId, missionId, status: "running", triggeredBy: "test" });

  const producerCompletedAt = new Date(Date.now() - 60_000);
  const [producer] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: PRODUCER, companyId, issueId: producerIssueId, status: "completed", iterationIndex: 0, completedAt: producerCompletedAt,
  }).returning();
  const [qaRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: runId, stepId: QA, companyId, issueId: qaIssueId, status: "failed", completedAt: new Date(Date.now() - 20_000),
  }).returning();

  // Official workflow_api verdict event bound to a heartbeat run scoped to the QA issue
  // and joined (via wakeup) to this exact QA step run — mirrors production dispatch.
  const wakeupId = randomUUID();
  const verdictHeartbeatId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId, agentId, source: "workflow.dispatch", workflowStepRunId: qaRun.id });
  const hbAt = new Date(Date.now() - 25_000);
  await db.insert(heartbeatRuns).values({
    id: verdictHeartbeatId, companyId, agentId, issueId: qaIssueId, status: "succeeded",
    wakeupRequestId: wakeupId, startedAt: hbAt, finishedAt: hbAt, createdAt: hbAt,
  });
  const [verdictEvent] = await db.insert(workflowTransitionEvents).values({
    companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun.id, issueId: qaIssueId,
    heartbeatRunId: verdictHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `verdict:${qaRun.id}:${verdictHeartbeatId}`,
    payload: {
      kind: "workflow_validation_verdict",
      workflowRunId: runId,
      stepRunId: qaRun.id,
      issueId: qaIssueId,
      verdict: "request_changes",
      reason: "internal term exposure in index.html",
      ...(opts.remediations ? { remediations: opts.remediations } : {}),
    },
  }).returning({ id: workflowTransitionEvents.id });

  if (opts.newerHeartbeatAfterVerdict) {
    const newerWakeup = randomUUID();
    const newerHb = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: newerWakeup, companyId, agentId, source: "workflow.dispatch", workflowStepRunId: qaRun.id });
    await db.insert(heartbeatRuns).values({
      id: newerHb, companyId, agentId, issueId: qaIssueId, status: "succeeded",
      wakeupRequestId: newerWakeup, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(),
    });
  }

  for (let i = 0; i < (opts.priorRemediationEvents ?? 0); i += 1) {
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: qaRun.id, issueId: qaIssueId,
      eventType: "qa_remediation_applied", layer: "workflow_validation",
      verdict: "request_changes", decision: "mechanical_remediation_applied", reason: "workflow_api", reasonCode: "qa_remediation",
      idempotencyKey: `qa-remediation-applied:${companyId}:${qaRun.id}:prior-${i}`,
      payload: { kind: "qa_remediation_applied", outcome: "applied" },
    });
  }

  return {
    companyId, agentId, missionId, workflowRunId: runId,
    producer: producer!, qa: qaRun!,
    producerIssueId, qaIssueId,
    verdictEventId: verdictEvent!.id, verdictHeartbeatId,
  };
}

interface Harness {
  db: Db;
  tempRoot: string;
}

async function runPass(h: Harness, seed: Seed, refire: (qa: { stepId: string; stepRunId: string; issueId: string | null }) => Promise<boolean>) {
  const stepRuns = await h.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.workflowRunId));
  await applyBackEdgeReworkPass({
    db: h.db,
    run: { id: seed.workflowRunId, companyId: seed.companyId, status: "running", missionId: seed.missionId },
    steps: buildSteps(seed.agentId) as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
    stepRuns,
    predsByStepId: new Map([[QA, { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }]]),
    validationVerdictsByIssueId: new Map([[seed.qaIssueId, { observedAt: new Date() }]]),
    refireQaStep: refire,
  });
}

async function reloadRuns(h: Harness, seed: Seed): Promise<{ producer: StepRun; qa: StepRun }> {
  const rows = await h.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, seed.workflowRunId));
  return {
    producer: rows.find((r) => r.stepId === PRODUCER)!,
    qa: rows.find((r) => r.stepId === QA)!,
  };
}

async function remediationEvents(h: Harness, seed: Seed) {
  return h.db.select({ id: workflowTransitionEvents.id, payload: workflowTransitionEvents.payload })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, seed.companyId),
      eq(workflowTransitionEvents.workflowStepRunId, seed.qa.id),
      eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    ));
}

const remediationsFor = (file: string, find: string, replace: string) => ({
  items: [{ op: "string_replace", file, find, replace }],
});

/** 임시 산출물 파일 생성(중첩 디렉터리 포함). */
async function writeArtifact(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}


import { withQaCorrectionFollowupReconcile } from "../services/workflow/control-flow/qa-correction-followup-reconcile.js";
import { syncWorkflowRunStateWithOutcome } from "../services/workflow/dag-engine.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { workflowRunHasC5AdmissionScope } from "../services/workflow/control-flow/qa-remediation-admission-root.js";

describeEP("main-era official resume remediation scope", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot: string;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-resume-");
    db = createDb(tempDb.connectionString);
    tempRoot = await mkdtemp(path.join(tmpdir(), "legacy-resume-"));
  }, 120_000);
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 30_000);

  it("keeps a manual-only official resume on the main path while replacement authority remains C5", async () => {
    const file = path.join(tempRoot, "artifact.html");
    await writeArtifact(file, "<html>old</html>");
    const seed = await seedScenario(db, { artifactUrl: file, remediations: remediationsFor(file, "old", "new") });
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, seed.workflowRunId));
    await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, seed.workflowRunId));
    await db.insert(workflowTerminalDecisions).values({ companyId: seed.companyId, workflowRunId: seed.workflowRunId,
      decidedAuthorityVersion: run!.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
      discoveryPath: "test-seed", origin: "test" });
    const result = await recoverTerminalRun(db, { companyId: seed.companyId, runId: seed.workflowRunId,
      expectedAuthorityVersion: run!.dispatchAuthorityVersion, recoveryKind: "manual_resume", requestedBy: "test", now: new Date() });
    expect(result.kind).toBe("recovered");
    expect(await workflowRunHasC5AdmissionScope(db, seed.workflowRunId)).toBe(false);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.workflowStepRunId, seed.qa.id));
    await db.update(agentWakeupRequests).set({ payload: { qaRemediationCompletion: { preparationEventId: randomUUID() } } }).where(eq(agentWakeupRequests.id, wake!.id));
    expect(await workflowRunHasC5AdmissionScope(db, seed.workflowRunId)).toBe(true);
    await db.update(agentWakeupRequests).set({ payload: wake!.payload }).where(eq(agentWakeupRequests.id, wake!.id));

    const malformedRollback = new Error("remove malformed legacy fixture");
    await expect(db.transaction(async tx => {
      await tx.insert(workflowTransitionEvents).values({ companyId: seed.companyId, missionId: seed.missionId,
        workflowRunId: seed.workflowRunId, workflowStepRunId: seed.qa.id, issueId: seed.qaIssueId,
        eventType: "qa_remediation_applied", layer: "workflow_validation", verdict: "request_changes",
        reason: "workflow_api", reasonCode: "qa_remediation", payload: {} });
      await expect(workflowRunHasC5AdmissionScope(tx as unknown as Db, seed.workflowRunId)).rejects.toMatchObject({ name: "QaRemediationAdmissionHold" });
      throw malformedRollback;
    })).rejects.toBe(malformedRollback);

    const rollback = new Error("remove replacement fixture");
    await expect(db.transaction(async tx => {
      const [decision] = await tx.insert(workflowTerminalDecisions).values({ companyId: seed.companyId, workflowRunId: seed.workflowRunId,
        decidedAuthorityVersion: run!.dispatchAuthorityVersion + 1, decision: "failed", policyCause: "outcome_convergence",
        discoveryPath: "test-seed", origin: "test" }).returning();
      const [event] = await tx.insert(workflowTransitionEvents).values({ companyId: seed.companyId, missionId: seed.missionId,
        workflowRunId: seed.workflowRunId, eventType: "workflow_replacement_decision_v1", layer: "workflow_replacement", payload: {} }).returning();
      const [approval] = await tx.insert(approvals).values({ companyId: seed.companyId, type: "workflow_replacement",
        status: "approved", requestedByAgentId: seed.agentId, payload: {} }).returning();
      const [target] = await tx.insert(workflowRuns).values({ companyId: seed.companyId, workflowId: run!.workflowId,
        missionId: seed.missionId, status: "running", triggeredBy: "test" }).returning();
      await tx.insert(workflowRecoveryAuthorities).values({ companyId: seed.companyId, workflowRunId: seed.workflowRunId,
        targetAuthorityVersion: run!.dispatchAuthorityVersion + 1, resultingAuthorityVersion: run!.dispatchAuthorityVersion + 1,
        targetDecisionId: decision!.id, recoveryKind: "replacement_from_start_v1", status: "consumed",
        requestedBy: "test", ownerDecisionEventId: event!.id, operatorApprovalId: approval!.id,
        replacementRunId: target!.id, requestHash: "test", requestReference: "test", replacementContract: {} });
      expect(await workflowRunHasC5AdmissionScope(tx as unknown as Db, seed.workflowRunId)).toBe(true);
      expect(await workflowRunHasC5AdmissionScope(tx as unknown as Db, target!.id)).toBe(true);
      throw rollback;
    })).rejects.toBe(rollback);

    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, seed.producerIssueId));
    const refireCalls: string[] = [];
    await withQaCorrectionFollowupReconcile(db, seed.workflowRunId, rootDb =>
      runPass({ db: rootDb, tempRoot }, seed, async qa => { refireCalls.push(qa.stepRunId); return true; }));
    const after = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, seed.producerIssueId));
    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(await readFile(file, "utf8")).toBe("<html>new</html>");
    expect(refireCalls).toEqual([seed.qa.id]);
    expect(after).toHaveLength(before.length);
    expect(runs.producer.status).toBe("completed");
    expect(runs.producer.iterationIndex).toBe(0);
    expect(await remediationEvents({ db, tempRoot }, seed)).toHaveLength(1);
    await withQaCorrectionFollowupReconcile(db, seed.workflowRunId, rootDb =>
      runPass({ db: rootDb, tempRoot }, seed, async qa => { refireCalls.push(qa.stepRunId); return true; }));
    expect(refireCalls).toEqual([seed.qa.id]);
    expect(await remediationEvents({ db, tempRoot }, seed)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, seed.producerIssueId))).toHaveLength(before.length);

    // The QA callback above stands in for a fresh QA execution; persist its result before real workflow synchronization.
    const wakeId = randomUUID(), heartbeatId = randomUUID(), now = new Date();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: seed.companyId, agentId: seed.agentId,
      source: "workflow.dispatch", workflowStepRunId: seed.qa.id });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: seed.companyId, agentId: seed.agentId,
      issueId: seed.qaIssueId, status: "succeeded", wakeupRequestId: wakeId, startedAt: now, finishedAt: now, createdAt: now });
    await db.insert(workflowTransitionEvents).values({ companyId: seed.companyId, missionId: seed.missionId,
      workflowRunId: seed.workflowRunId, workflowStepRunId: seed.qa.id, issueId: seed.qaIssueId, heartbeatRunId: heartbeatId,
      eventType: "workflow_validation_verdict", layer: "workflow_validation", verdict: "pass", decision: "pass",
      reason: "workflow_api", reasonCode: "workflow_api", idempotencyKey: `verdict:${seed.qa.id}:${heartbeatId}`,
      payload: { kind: "workflow_validation_verdict", workflowRunId: seed.workflowRunId, stepRunId: seed.qa.id,
        issueId: seed.qaIssueId, verdict: "pass" } });
    await db.update(workflowStepRuns).set({ status: "completed", completedAt: now }).where(eq(workflowStepRuns.id, seed.qa.id));
    const sync = await syncWorkflowRunStateWithOutcome(db, seed.workflowRunId);
    expect(sync.result.status).toBe("completed");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, seed.producerIssueId))).toHaveLength(before.length);
  }, 120_000);
});
