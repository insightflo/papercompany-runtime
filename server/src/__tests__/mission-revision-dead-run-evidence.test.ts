// [purpose] 종결된 원본 런의 수정 실패 증거 읽기 — 종결 울타리가 세대를 올려도
//   마지막 실제 시도의 공식 판정/디스패치 실패를 읽을 수 있는지 검증한다.
//   실제 finalizeRunTerminal 로 울타리를 재현한다 (fixture 가 세대를 직접 바꾸지 않는다).
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, issues, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedWorld } from "./helpers/workflow-seed-world.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { checkMissionRevisionSteps } from "../services/missions/mission-revision-guard.js";

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Awaited<ReturnType<typeof createDb>>;
let root: string;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("revision-dead-run-");
  db = createDb(tempDb.connectionString);
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "revision-dead-run-")));
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await rm(root, { recursive: true, force: true });
  await tempDb.cleanup();
});

const FAILED_CAUSE = {
  policy: "recovery_deadline_hard",
  discovery: "stuck_diagnostic",
  origin: "reconciler",
  reason: "terminal fence",
} as const;

/** seedWorld 는 런을 직접 failed 로 표시하므로, 실제 종결 경계가 울타리를 치게 한다. */
async function fenceWithRealTerminal(companyId: string, runId: string) {
  await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, runId));
  const result = await finalizeRunTerminal(db, {
    runId, companyId, expectedAuthorityVersion: 0, decision: "failed",
    cause: { ...FAILED_CAUSE }, gatePolicy: "immediate", now: new Date(), stepRuns: [],
  });
  expect(result.kind).toBe("finalized");
}

it("accepts the official verdict of the last real attempt after the terminal fence advanced the step generation", async () => {
  const f = await seedWorld(db, root);
  const [issue] = await db.update(issues).set({ originKind: "workflow_execution" })
    .where(eq(issues.id, f.sourceStep.issueId!)).returning();
  const [heartbeat] = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  await recordWorkflowValidationVerdict({ db, issue, verdict: "request_changes",
    source: "workflow_api", heartbeatRunId: heartbeat.id });
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await fenceWithRealTerminal(f.companyId, f.sourceRun.id);
  const [step] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, f.sourceStep.id));
  expect(step.executionGeneration).toBeGreaterThan(heartbeat.workflowExecutionGeneration ?? -1);
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: f.steps }))
    .resolves.toBeUndefined();
});

it("recognizes a typeless judgment step's current-request dispatch failure as evidence", async () => {
  const judgment = () => [{ id: "gate", name: "Gate", agentId: "", dependencies: [], toolNames: ["judgment"] }];
  const f = await seedWorld(db, root, judgment);
  const corrective = [{ id: "gate2", name: "Gate", agentId: "", dependencies: [],
    toolNames: ["judgment"], toolArgs: { mode: "fixed" } }];
  await db.update(workflowStepRuns).set({ status: "failed", issueId: null, lastDispatchRequestId: "request-1",
    metadata: { toolInvocation: { requestId: "request-1", dispatchError: "workproduct_selector_provenance_missing" } } })
    .where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: corrective }))
    .resolves.toBeUndefined();
  for (const toolInvocation of [
    { requestId: "stale", dispatchError: "workproduct_selector_provenance_missing" },
    { requestId: "request-1" },
    { requestId: "request-1", dispatchError: "" },
  ]) {
    await db.update(workflowStepRuns).set({ metadata: { toolInvocation } }).where(eq(workflowStepRuns.id, f.sourceStep.id));
    await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: corrective }))
      .rejects.toThrow("mission_revision_failure_evidence_missing");
  }
});

it("still finds no evidence in an admitted-but-successful older heartbeat without a verdict after the fence", async () => {
  const f = await seedWorld(db, root);
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await fenceWithRealTerminal(f.companyId, f.sourceRun.id);
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: f.steps }))
    .rejects.toThrow("mission_revision_failure_evidence_missing");
});

it("prefers the newest attempt's failure over an older generation verdict (no attempt mixing)", async () => {
  const f = await seedWorld(db, root);
  const [issue] = await db.update(issues).set({ originKind: "workflow_execution" })
    .where(eq(issues.id, f.sourceStep.issueId!)).returning();
  const [oldHeartbeat] = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.workflowStepRunId, f.sourceStep.id));
  await recordWorkflowValidationVerdict({ db, issue, verdict: "request_changes",
    source: "workflow_api", heartbeatRunId: oldHeartbeat.id });
  await fenceWithRealTerminal(f.companyId, f.sourceRun.id);
  const newerId = randomUUID();
  await admittedProducer(db, { companyId: f.companyId, agentId: f.agentId,
    issueId: f.sourceStep.issueId, stepRunId: f.sourceStep.id, heartbeatId: newerId, status: "failed" });
  await db.update(heartbeatRuns).set({ errorCode: "current_timeout" }).where(eq(heartbeatRuns.id, newerId));
  await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, f.sourceStep.id));
  await expect(checkMissionRevisionSteps(db, { companyId: f.companyId, missionId: f.revision.id, steps: f.steps }))
    .rejects.toMatchObject({ details: expect.objectContaining({ errorCode: "current_timeout" }) });
});
