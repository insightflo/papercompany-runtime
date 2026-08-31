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

describeEP("QA structured remediation pass (loop-driver integration)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-remediation-");
    db = createDb(tempDb.connectionString);
    tempRoot = await mkdtemp(path.join(tmpdir(), "qa-rem-"));
  }, 60_000);
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("applies the deterministic patch, records an audit event, re-fires only QA, leaves producer untouched", async () => {
    const artifactPath = path.join(tempRoot, "case1", "index.html");
    await writeArtifact(artifactPath, "<html>내부 용어 leads/evidence.json 노출됨</html>");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "leads/evidence.json", "선별 근거 요약") });

    const refireCalls: Array<{ stepId: string; stepRunId: string; issueId: string | null }> = [];
    await runPass({ db, tempRoot }, seed, async (qa) => { refireCalls.push(qa); return true; });

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("completed");
    expect(runs.producer.iterationIndex).toBe(0);
    expect((runs.producer.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeUndefined();

    const patched = await readFile(artifactPath, "utf8");
    expect(patched).toBe("<html>내부 용어 선별 근거 요약 노출됨</html>");

    expect(refireCalls).toHaveLength(1);
    expect(refireCalls[0]!.stepRunId).toBe(seed.qa.id);
    expect(refireCalls[0]!.issueId).toBe(seed.qaIssueId);

    const events = await remediationEvents({ db, tempRoot }, seed);
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.sourceVerdictEventId).toBe(seed.verdictEventId);
    expect(payload.outcome).toBe("applied");
    expect(payload.producerStepId).toBe(PRODUCER);
  });

  it("re-evaluating the same verdict is an idempotent hold: no re-fire, no re-patch", async () => {
    const artifactPath = path.join(tempRoot, "case2", "index.html");
    await writeArtifact(artifactPath, "term X appears once");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "X", "Y") });

    await runPass({ db, tempRoot }, seed, async () => true);
    const eventsAfterFirst = await remediationEvents({ db, tempRoot }, seed);
    expect(eventsAfterFirst).toHaveLength(1);

    const refireCalls: unknown[] = [];
    await runPass({ db, tempRoot }, seed, async (qa) => { refireCalls.push(qa); return true; });

    expect(refireCalls).toHaveLength(0);
    const eventsAfterSecond = await remediationEvents({ db, tempRoot }, seed);
    expect(eventsAfterSecond).toHaveLength(1);
    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("completed");
    expect(runs.producer.iterationIndex).toBe(0);
    expect(await readFile(artifactPath, "utf8")).toBe("term Y appears once");
  });

  it("falls back to producer rework when the QA re-fire is refused", async () => {
    const artifactPath = path.join(tempRoot, "case3", "index.html");
    await writeArtifact(artifactPath, "findme once");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "findme", "fixed") });

    await runPass({ db, tempRoot }, seed, async () => false);

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    expect(await remediationEvents({ db, tempRoot }, seed)).toHaveLength(0);
    expect(await readFile(artifactPath, "utf8")).toBe("findme once");
  });

  it("falls back to producer rework when `find` is not present exactly once", async () => {
    const artifactPath = path.join(tempRoot, "case4", "index.html");
    await writeArtifact(artifactPath, "no such term here");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "NOT-PRESENT", "x") });

    await runPass({ db, tempRoot }, seed, async () => true);

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    expect((runs.producer.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeTruthy();
    expect(await remediationEvents({ db, tempRoot }, seed)).toHaveLength(0);
  });

  it("falls back to producer rework when the target file is outside the producer artifact boundary", async () => {
    const registeredPath = path.join(tempRoot, "case5", "index.html");
    await writeArtifact(registeredPath, "registered artifact");
    const outsidePath = path.join(tempRoot, "case5-outside", "other.html");
    await writeArtifact(outsidePath, "outside findme");
    const seed = await seedScenario(db, { artifactUrl: registeredPath, remediations: remediationsFor(outsidePath, "outside findme", "x") });

    await runPass({ db, tempRoot }, seed, async () => true);

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    expect(await readFile(outsidePath, "utf8")).toBe("outside findme");
    expect(await remediationEvents({ db, tempRoot }, seed)).toHaveLength(0);
  });

  it("keeps the legacy behavior (producer rework) when the verdict carries no remediations", async () => {
    const artifactPath = path.join(tempRoot, "case6", "index.html");
    await writeArtifact(artifactPath, "legacy artifact");
    const seed = await seedScenario(db, { artifactUrl: artifactPath });

    const refireCalls: unknown[] = [];
    await runPass({ db, tempRoot }, seed, async (qa) => { refireCalls.push(qa); return true; });

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    expect(refireCalls).toHaveLength(0);
  });

  it("falls back to producer rework once the per-QA remediation attempt cap is exhausted", async () => {
    const artifactPath = path.join(tempRoot, "case7", "index.html");
    await writeArtifact(artifactPath, "cap findme");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "cap findme", "x"), priorRemediationEvents: 3 });

    await runPass({ db, tempRoot }, seed, async () => true);

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    const events = await remediationEvents({ db, tempRoot }, seed);
    expect(events).toHaveLength(3); // only the seeded prior events, no new one
  });

  it("falls back to producer rework when a newer QA execution supersedes the verdict", async () => {
    const artifactPath = path.join(tempRoot, "case8", "index.html");
    await writeArtifact(artifactPath, "fresh findme");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations: remediationsFor(artifactPath, "fresh findme", "x"), newerHeartbeatAfterVerdict: true });

    await runPass({ db, tempRoot }, seed, async () => true);

    const runs = await reloadRuns({ db, tempRoot }, seed);
    expect(runs.producer.status).toBe("pending");
    expect(runs.producer.iterationIndex).toBe(1);
    expect(await readFile(artifactPath, "utf8")).toBe("fresh findme");
  });
});

describeEP("loadLatestQaRemediations ledger loader", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-qa-remediation-ledger-");
    db = createDb(tempDb.connectionString);
    tempRoot = await mkdtemp(path.join(tmpdir(), "qa-rem-ledger-"));
  }, 60_000);
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("returns schema-revalidated remediations bound to the current verdict event", async () => {
    const artifactPath = path.join(tempRoot, "led1.html");
    await writeArtifact(artifactPath, "x");
    const remediations = remediationsFor(artifactPath, "x", "y");
    const seed = await seedScenario(db, { artifactUrl: artifactPath, remediations });

    const loaded = await loadLatestQaRemediations({ db, companyId: seed.companyId, issueId: seed.qaIssueId });
    expect(loaded).not.toBeNull();
    expect(loaded!.remediations).toEqual(remediations);
    expect(loaded!.workflowStepRunId).toBe(seed.qa.id);
    expect(loaded!.heartbeatRunId).toBe(seed.verdictHeartbeatId);
    expect(loaded!.sourceVerdictEventId).toBe(seed.verdictEventId);
    expect(loaded!.observedAt).not.toBeNull();
  });

  it("returns null when the latest official verdict is a PASS (remediations never qualify)", async () => {
    const seed = await seedScenario(db, { remediations: remediationsFor("/srv/x/any.html", "a", "b") });
    // Newer official PASS verdict supersedes the request_changes.
    const wakeupId = randomUUID();
    const passHeartbeatId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeupId, companyId: seed.companyId, agentId: seed.agentId, source: "workflow.dispatch", workflowStepRunId: seed.qa.id });
    await db.insert(heartbeatRuns).values({
      id: passHeartbeatId, companyId: seed.companyId, agentId: seed.agentId, issueId: seed.qaIssueId, status: "succeeded",
      wakeupRequestId: wakeupId, startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.workflowRunId,
      workflowStepRunId: seed.qa.id, issueId: seed.qaIssueId,
      heartbeatRunId: passHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "pass", decision: "pass", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `verdict:${seed.qa.id}:${passHeartbeatId}`,
      payload: { kind: "workflow_validation_verdict", verdict: "pass" },
    });

    const loaded = await loadLatestQaRemediations({ db, companyId: seed.companyId, issueId: seed.qaIssueId });
    expect(loaded).toBeNull();
  });

  it("returns null for malformed payload remediations (untrusted JSON is revalidated)", async () => {
    const seed = await seedScenario(db, { remediations: { items: [{ op: "regex_replace", file: "/x", find: "a", replace: "b" }] } as unknown as Record<string, unknown> });
    const loaded = await loadLatestQaRemediations({ db, companyId: seed.companyId, issueId: seed.qaIssueId });
    expect(loaded).toBeNull();
  });

  // [P1 반복 기계 교정 → 지식 카드 자동 초안] applied 이벤트에 머신 서명이 기록되고,
  //   같은 회사에서 동일 서명 2회째 적용 시에만 draft 초안 카드가 1장 생성된다.
  it("stamps defect signatures on the audit event and auto-drafts a pattern card on the 2nd identical correction", async () => {
    const find = "보고서 요약: 2026-01-01";
    const replace = "보고서 요약: 2026-08-31";
    const signature = computeDefectSignature(find, replace);
    const svc = knowledgePatternsService(db);

    // 1회차 — 이벤트에 서명 기록, 카드는 없다.
    const fileA = path.join(tempRoot, "cap-a", "index.html");
    await writeArtifact(fileA, `<p>${find}</p>`);
    const seedA = await seedScenario(db, { remediations: remediationsFor(fileA, find, replace), artifactUrl: fileA });
    await runPass({ db, tempRoot }, seedA, async () => true);
    const eventsA = await remediationEvents({ db, tempRoot }, seedA);
    expect(eventsA).toHaveLength(1);
    expect((eventsA[0]!.payload as { signatures?: string[] }).signatures).toEqual([signature]);
    expect(await svc.search({ companyId: seedA.companyId, includeDrafts: true })).toHaveLength(0);

    // 2회차(같은 회사, 다른 미션/파일) — 동일 서명 draft 초안 1장.
    const fileB = path.join(tempRoot, "cap-b", "index.html");
    await writeArtifact(fileB, `<p>${find}</p>`);
    const seedB = await seedScenario(db, { companyId: seedA.companyId, remediations: remediationsFor(fileB, find, replace), artifactUrl: fileB });
    await runPass({ db, tempRoot }, seedB, async () => true);
    const drafts = await svc.search({ companyId: seedA.companyId, includeDrafts: true });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.source).toBe("auto_rework_draft");
    expect(drafts[0]!.status).toBe("draft");
    expect(drafts[0]!.defectSignature).toBe(signature);
    expect(drafts[0]!.kind).toBe("failure_mode");
    // 기본 검색(초안 제외)에는 노출되지 않는다.
    expect(await svc.search({ companyId: seedA.companyId })).toHaveLength(0);

    // 3회차 — 초안 중복 없음((company_id, defect_signature) 유일).
    const fileC = path.join(tempRoot, "cap-c", "index.html");
    await writeArtifact(fileC, `<p>${find}</p>`);
    const seedC = await seedScenario(db, { companyId: seedA.companyId, remediations: remediationsFor(fileC, find, replace), artifactUrl: fileC });
    await runPass({ db, tempRoot }, seedC, async () => true);
    expect(await svc.search({ companyId: seedA.companyId, includeDrafts: true })).toHaveLength(1);

    // 다른 결함 서명은 별도 카드 대상 — 1회차라 초안 없다.
    const fileD = path.join(tempRoot, "cap-d", "index.html");
    await writeArtifact(fileD, "<p>다른 결함 텍스트</p>");
    const seedD = await seedScenario(db, { companyId: seedA.companyId, remediations: remediationsFor(fileD, "다른 결함 텍스트", "수정됨"), artifactUrl: fileD });
    await runPass({ db, tempRoot }, seedD, async () => true);
    expect(await svc.search({ companyId: seedA.companyId, includeDrafts: true })).toHaveLength(1);

    // 사람 승인 — draft→active 전이 후 기본 검색에 노출. 재승인은 거부.
    const approved = await svc.approve({ companyId: seedA.companyId, id: drafts[0]!.id });
    expect(approved.status).toBe("active");
    const visible = await svc.search({ companyId: seedA.companyId });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(drafts[0]!.id);
    await expect(svc.approve({ companyId: seedA.companyId, id: drafts[0]!.id })).rejects.toThrow(/draft not found/);
    // 타회사 초안 승인 불가(회사 스코프).
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: `Foreign-${foreignCompanyId.slice(0, 8)}`, issuePrefix: `FX${foreignCompanyId.slice(0, 8)}` });
    const foreignDraft = await knowledgePatternsService(db).createAutoReworkDraft({
      companyId: foreignCompanyId,
      signature: computeDefectSignature("x", "y"),
      title: "외부 초안",
      summary: "타회사 초안 — 회사 스코프 검증용",
    });
    expect(foreignDraft.card).not.toBeNull();
    await expect(svc.approve({ companyId: seedA.companyId, id: foreignDraft.card!.id })).rejects.toThrow(/draft not found/);
  });
});
