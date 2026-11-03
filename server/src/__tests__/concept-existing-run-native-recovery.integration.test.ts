// server/src/__tests__/concept-existing-run-native-recovery.integration.test.ts
//
// [purpose] Stage A actual-path native integration evidence for the stalled concept-mission
//   recovery contract (/tmp/concept-existing-run-repair-contract-1030.md). On real embedded
//   PostgreSQL and the PUBLIC board resume route, reproduces the exact actual shape — failed
//   run at dispatchAuthorityVersion 0 with a recorded terminal decision, steps at generation 1,
//   registered gen-0 products (iterations 0/1 with workflowProducer metadata), ZERO
//   workflow_step_output_bindings, and a current official request_changes verdict carrying 3
//   mechanical string_replace remediations — and proves the BOUNDED public same-run resume:
//   recovery authority consumed exactly once (0→1), run reopened running (NOT a false
//   completion), and, when the native mechanical remediation qualification holds, its
//   deterministic exactly-once application without producer re-dispatch; same run (no
//   replacement run/cap reset), original product rows and artifact bytes preserved. This is a
//   bounded resume-branch proof, not a mission-completion claim. The second scenario is the
//   failing-first RED assertion: with a controlled boundary failure
//   (read-only artifact file) the remediation WRITE fails AFTER real QA refire wakes were
//   queued, and the fail-closed contract demands NO producer rework reset — today's
//   fall-through is the defect evidence the Stage B typed-disposition gate must close.
//   No fabricated bindings, no fake CAS, no mocked authority: DB, engine, recovery, wakes real.

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, instanceSettings, issues,
  issueWorkProducts, missions, workflowDefinitions, workflowRecoveryAuthorities, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { QA_REMEDIATION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-contract.js";
import { upsertWorkflowIssueExecutionCard } from "../services/issue-execution-cards/workflow-upsert.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

// External adapter boundary ONLY (established fixture pattern): native wake/claim/DB stay real;
// no real CLI/provider can spawn from any dispatch this test triggers.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
  runningProcesses: new Map(),
}));
const completed = { exitCode: 0, signal: null, timedOut: false, usage: null, provider: "test", model: "test", resultJson: null, runtimeServices: [] };

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip concept native recovery stage A: ${support.reason ?? "unsupported host"}`);

const FINDS: ReadonlyArray<readonly [find: string, replace: string]> = [
  ["에이전트 팀을 직접 운영하려는 독자에게 쓸모가 있다.", "에이전트 팀을 직접 운영하려는 독자에게 유용하다."],
  ["이후 3.03배에 도달했다.", "이후 3.03배에 도달했다(2026-10-29 기준)."],
  ["의 두 배가 넘는 속도다.", "의 두 배가 넘는 속도다(2026-10-29 기준)."],
];
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface World {
  companyId: string; missionId: string; runId: string; producerStepRunId: string; qaStepRunId: string;
  producerIssueId: string; contentPath: string; originalContent: string; imagePaths: string[]; originalImages: string[];
  originalProducts: Array<{ id: string; url: string; status: string; metadata: unknown }>;
}

async function seedWorld(db: Db, dir: string, label: string, opts: { readonlyContent?: boolean } = {}): Promise<World> {
  const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID();
  const qaHeartbeatId = randomUUID(), producerHeartbeatId = randomUUID(), imageHeartbeatId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: `ConceptCo ${label}`, issuePrefix: label === "main" ? "CCA" : "CCB", requireBoardApprovalForNewAgents: false });
  await db.insert(agents).values({ id: agentId, companyId, name: "concept-worker", role: "writer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "concept mission", status: "active" });
  // Actual A1 temporal order (main-verified /tmp/concept-native-issue-timestamps-1525.txt):
  // producer done 21:36:43.007Z → QA verdict 21:42:37.591Z → QA done 21:42:42.020Z. Explicit
  // completedAt keeps dag-engine completed-sync deterministic (issue.completedAt ?? now).
  const [producerIssue] = await db.insert(issues).values({ companyId, missionId, title: "Build beginner concept ContentV1", description: "Produce content.json.", status: "done", originKind: "workflow_execution", assigneeAgentId: agentId, startedAt: new Date("2026-10-29T21:31:46.674Z"), completedAt: new Date("2026-10-29T21:36:43.007Z") }).returning({ id: issues.id });
  const [qaIssue] = await db.insert(issues).values({ companyId, missionId, title: "Validate concept ContentV1 draft", description: "Validate content.json.", status: "done", originKind: "workflow_execution", assigneeAgentId: agentId, startedAt: new Date("2026-10-29T21:37:08.683Z"), completedAt: new Date("2026-10-29T21:42:42.020Z") }).returning({ id: issues.id });
  const worldDir = join(dir, label);
  await mkdir(worldDir, { recursive: true });
  const originalContent = JSON.stringify({ blocks: FINDS.map(([find], i) => ({ id: i, text: `서론 ${i}. ${find} 수치 블록 ${i}.` })) });
  const contentPath = join(worldDir, "content.json");
  await writeFile(contentPath, originalContent, "utf8");
  if (opts.readonlyContent) await chmod(contentPath, 0o444);
  const imagePaths: string[] = [];
  const originalImages: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const p = join(worldDir, `figure-${i}.json`);
    const bytes = JSON.stringify({ figure: i, bytes: `img-${label}-${i}` });
    await writeFile(p, bytes, "utf8");
    imagePaths.push(p);
    originalImages.push(bytes);
  }
  const steps = [
    { id: "build-concept-content", name: "Produce", agentId, dependencies: [], graphWorkProductRequired: true,
      conditionalDependencies: [{ stepId: "validate-concept-contentv1", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] },
    { id: "validate-concept-contentv1", name: "QA", agentId, dependencies: ["build-concept-content"], qaType: "action" },
  ];
  const wfId = randomUUID(), runId = randomUUID();
  await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: `concept-wf-${label}`, stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "failed", dispatchAuthorityVersion: 0, triggeredBy: "test", startedAt: new Date("2026-10-29T21:31:00Z"), completedAt: new Date("2026-10-29T22:12:10Z") });
  await db.insert(workflowTerminalDecisions).values({ companyId, workflowRunId: runId, decidedAuthorityVersion: 0, decision: "failed", policyCause: "recovery_deadline_hard", discoveryPath: "test-seed", origin: "deadlock_reconciler", reason: "stage-a fixture" });
  const completedAt = new Date("2026-10-29T21:36:43.007Z");
  const [producerStepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "build-concept-content", companyId, issueId: producerIssue!.id, status: "completed", executionGeneration: 1, iterationIndex: 1, startedAt: new Date("2026-10-29T21:31:46.674Z"), completedAt }).returning({ id: workflowStepRuns.id });
  const [qaStepRun] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "validate-concept-contentv1", companyId, issueId: qaIssue!.id, status: "failed", executionGeneration: 1, startedAt: new Date("2026-10-29T21:37:08.683Z"), completedAt: new Date("2026-10-29T21:42:42.020Z") }).returning({ id: workflowStepRuns.id });
  // Native execution cards via the real builder/upsert — actual A1 contract: QA verdict required
  // (ledger workflow_validation_verdict, PASS/REQUEST_CHANGES/INSUFFICIENT_EVIDENCE), producer
  // workProduct required, both issues originKind workflow_execution.
  for (const [issue, step] of [[producerIssue!, steps[0]], [qaIssue!, steps[1]]] as const) {
    await upsertWorkflowIssueExecutionCard({ db, companyId, issueId: issue.id, title: issue.id === producerIssue!.id ? "Build beginner concept ContentV1" : "Validate concept ContentV1 draft", description: issue.id === producerIssue!.id ? "Produce content.json." : "Validate content.json.", assigneeAgentId: agentId, missionId, workflowDefinitionId: wfId, workflowRunId: runId, step, stepOutputDir: worldDir });
  }
  const producerMeta = (heartbeatRunId: string, contentSha: string, byteSize: number, iterationIndex: number) => ({ schemaVersion: "workflow.work-product-producer.v1", sha256: contentSha, byteSize, companyId, missionId, workflowRunId: runId, stepId: "build-concept-content", stepRunId: producerStepRun!.id, heartbeatRunId, retryCount: 0, iterationIndex, executionGeneration: 0 });
  await db.insert(issueWorkProducts).values([
    { companyId, issueId: producerIssue!.id, type: "file", provider: "local", title: "content.json", status: "active", url: contentPath, metadata: { workflowProducer: producerMeta(producerHeartbeatId, sha(originalContent), Buffer.byteLength(originalContent), 1) } },
    ...imagePaths.map((p, i) => ({ companyId, issueId: producerIssue!.id, type: "file", provider: "local", title: `figure-${i}.json`, status: "active", url: p, metadata: { workflowProducer: producerMeta(imageHeartbeatId, sha(originalImages[i]!), Buffer.byteLength(originalImages[i]!), 0) } })),
  ]);
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", issueId: qaIssue!.id, status: "completed", requestKind: "workflow_resume", idempotencyKey: `seed-verdict-wake:${runId}`, workflowRunId: runId, workflowStepRunId: qaStepRun!.id }).returning({ id: agentWakeupRequests.id });
  await db.insert(heartbeatRuns).values({ id: qaHeartbeatId, companyId, agentId, issueId: qaIssue!.id, status: "succeeded", startedAt: new Date("2026-10-29T21:41:00Z"), finishedAt: new Date("2026-10-29T21:42:30Z"), wakeupRequestId: wake!.id, workflowStepRunId: qaStepRun!.id, workflowExecutionGeneration: null });
  await db.insert(workflowTransitionEvents).values({
    companyId, missionId, workflowRunId: runId, workflowStepRunId: qaStepRun!.id, issueId: qaIssue!.id,
    heartbeatRunId: qaHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
    verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
    idempotencyKey: `seed-verdict:${qaStepRun!.id}`, createdAt: new Date("2026-10-29T21:42:37.591Z"),
    payload: { kind: "workflow_validation_verdict", workflowRunId: runId, stepRunId: qaStepRun!.id, issueId: qaIssue!.id, verdict: "request_changes", reason: "F2/F3 persist unchanged", findings: [
      { id: "F2", layer: "artifact", summary: "blocks[3] still ends with banned phrase '...독자에게 쓸모가 있다.' ('쓸모 있다' wording banned; same defect)." },
      { id: "F3", layer: "artifact", summary: "blocks[13]·[14] figures lack same-sentence '(YYYY-MM-DD 기준)' date (GEO rule 3); 0 occurrences in file." },
    ], remediations: { items: FINDS.map(([find, replace]) => ({ op: "string_replace", file: contentPath, find, replace })) } },
  });
  const originalProducts = await db.select({ id: issueWorkProducts.id, url: issueWorkProducts.url, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata }).from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId));
  return { companyId, missionId, runId, producerStepRunId: producerStepRun!.id, qaStepRunId: qaStepRun!.id, producerIssueId: producerIssue!.id, contentPath, originalContent, imagePaths, originalImages, originalProducts };
}

function createApp(db: Db, companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "board-stage-a", companyIds: [companyId], isInstanceAdmin: false } as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

describeDb("concept existing-run native recovery — Stage A public resume branch", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-concept-stage-a-");
    db = createDb(tempDb.connectionString);
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableRunReopenGuardV1: true, enableRunRecoveryServiceV1: true, enableWorkProductBindingV1: true } });
    dir = await realpath(await mkdtemp(join(tmpdir(), "concept-stage-a-")));
    adapter.mockResolvedValue(completed);
  }, 120_000);
  afterAll(async () => {
    await chmod(join(dir, "readonly", "content.json"), 0o644).catch(() => {});
    await waitForHeartbeatExecutionsToDrain(db, 20_000).catch(() => {});
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 30_000);

  it("applies the 3 mechanical remediations via the existing branch without producer re-dispatch", async () => {
    const w = await seedWorld(db, dir, "main");
    const res = await request(createApp(db, w.companyId)).post(`/api/workflow-runs/${w.runId}/resume`).send({});
    expect(res.status).toBe(200);
    // Durable observations FIRST (logged snapshot) so any later assertion failure still leaves
    // the complete native-branch evidence in the run log. No OR-matching, no accepting false completion.
    const [runAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.runId));
    const remediationEvents = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE)));
    const refireWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `qa-remediation-refire:${w.runId}:${w.qaStepRunId}`));
    const producerWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, w.producerIssueId));
    const productsAfter = await db.select({ id: issueWorkProducts.id, url: issueWorkProducts.url, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata }).from(issueWorkProducts).where(eq(issueWorkProducts.companyId, w.companyId));
    const [producerAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producerStepRunId));
    const runsForMission = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId));
    const bindings = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.workflowRunId, w.runId));
    const patched = await readFile(w.contentPath, "utf8");
    const snapshot = {
      run: { status: runAfter?.status, version: runAfter?.dispatchAuthorityVersion, completedAt: runAfter?.completedAt },
      authorities: authorities.map((a) => ({ kind: a.recoveryKind, targetVersion: a.targetAuthorityVersion })),
      remediation: remediationEvents.map((e) => ({ decision: e.decision, payload: e.payload })),
      refireWakeCount: refireWakes.length, producerWakeCount: producerWakes.length,
      productCount: productsAfter.length, producerStep: { status: producerAfter?.status, iteration: producerAfter?.iterationIndex, reworkContract: (producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract !== undefined },
      runsForMission: runsForMission.length, bindings: bindings.length,
      patchCounts: FINDS.map(([find, replace]) => [occurrences(patched, find), occurrences(patched, replace)]),
    };
    console.log(`STAGE-A-CORRECTION3-SNAPSHOT ${JSON.stringify(snapshot)}`);
    expect(runAfter?.status).toBe("running");
    expect(runAfter?.dispatchAuthorityVersion).toBe(1);
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.recoveryKind).toBe("manual_resume");
    expect(remediationEvents).toHaveLength(1);
    expect(remediationEvents[0]?.decision).toBe("mechanical_remediation_applied");
    expect(remediationEvents[0]?.payload).toMatchObject({ outcome: "applied", producerIteration: 1, items: expect.any(Array) });
    expect((remediationEvents[0]?.payload as { items: unknown[] }).items).toHaveLength(3);
    expect(refireWakes).toHaveLength(1);
    // EXACT oracle: sequential single replacement of each (once-occurring) find — F2/F3 replaces
    // embed their find (date append), so zero-find counts are impossible for a correct patch.
    const expected = FINDS.reduce((acc, [find, replace]) => acc.replace(find, replace), w.originalContent);
    expect(patched).toBe(expected);
    for (const [, replace] of FINDS) {
      expect(occurrences(patched, replace)).toBe(occurrences(w.originalContent, replace) + 1);
    }
    expect(FINDS.reduceRight((acc, [find, replace]) => acc.split(replace).join(find), patched)).toBe(w.originalContent);
    for (const [i, p] of w.imagePaths.entries()) expect(await readFile(p, "utf8")).toBe(w.originalImages[i]);
    expect(productsAfter).toHaveLength(w.originalProducts.length);
    for (const before of w.originalProducts) {
      const after = productsAfter.find((row) => row.id === before.id);
      expect(after).toMatchObject({ url: before.url, status: before.status, metadata: before.metadata });
    }
    expect(producerAfter?.status).toBe("completed");
    expect(producerAfter?.iterationIndex).toBe(1);
    expect((producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeUndefined();
    expect(producerWakes).toHaveLength(0);
    expect(runsForMission).toHaveLength(1);
    expect(bindings).toHaveLength(0);
  });

  it("red: post-effect write failure must NOT fall through to producer rework (fail-closed contract)", async () => {
    const w = await seedWorld(db, dir, "readonly", { readonlyContent: true });
    const res = await request(createApp(db, w.companyId)).post(`/api/workflow-runs/${w.runId}/resume`).send({});
    expect(res.status).toBe(200);
    const remediationEvents = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_EVENT_TYPE)));
    expect(remediationEvents).toHaveLength(1);
    expect(remediationEvents[0]?.decision).toBe("mechanical_remediation_write_failed");
    const payload = remediationEvents[0]?.payload as { outcome?: string; writeError?: string };
    expect(payload?.outcome).toBe("write_failed");
    expect(payload?.writeError).toBeTruthy();
    // Real post-effect state: QA refire wake was dispatched before the write failed.
    const refireWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `qa-remediation-refire:${w.runId}:${w.qaStepRunId}`));
    expect(refireWakes).toHaveLength(1);
    // RED assertion (defect evidence): after effects (wakes queued, write attempted), the loop
    // must fail closed — NO producer rework reset / duplicate producer start. Today loop-driver
    // falls through, so these expectations are expected to FAIL and prove the Stage B gap.
    const [producerAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producerStepRunId));
    expect(producerAfter?.status).toBe("completed");
    expect(producerAfter?.iterationIndex).toBe(1);
    expect((producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeUndefined();
    const content = await readFile(w.contentPath, "utf8");
    for (const [find] of FINDS) expect(occurrences(content, find)).toBe(1);
  });
});
