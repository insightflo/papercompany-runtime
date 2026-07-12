// RES-1318 regression: workproduct-reuse bounded registration.
// live QA recovery → registration dispatch 0; stalled + artifact → registration wake 1(source reopen ❌).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { missionService } from "../services/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip workproduct reuse regression: ${sup.reason ?? "unsupported"}`);

type Mode = "live" | "stalled";
const tmpRoots: string[] = [];

async function seed(db: ReturnType<typeof createDb>, mode: Mode) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const wdId = randomUUID();
  const runId = randomUUID();
  const producerIssueId = randomUUID();
  const unblockIssueId = randomUUID();
  const suffix = companyId.slice(0, 8);
  const workProductRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-reuse-"));
  tmpRoots.push(workProductRoot);

  await db.insert(companies).values({ id: companyId, name: "WR Co", issuePrefix: `WR${suffix.toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "ceo", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "WR mission", status: "active" });
  await db.insert(workflowDefinitions).values({
    id: wdId, companyId, name: "produce",
    stepsJson: [{ id: "produce", name: "Produce", dependencies: [], type: "tool", graphWorkProductRequired: true }],
  });
  await db.insert(workflowRuns).values({ id: runId, workflowId: wdId, companyId, missionId, status: "running", triggeredBy: "system" });
  await db.insert(issues).values([
    { id: producerIssueId, companyId, missionId, identifier: `WRP${suffix}`, title: "Producer", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: unblockIssueId, companyId, missionId, identifier: `WRU${suffix}`, title: "[Unblock]", status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: producerIssueId },
  ]);
  await db.insert(workflowStepRuns).values({
    id: randomUUID(), workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "failed",
    startedAt: new Date("2026-07-12T08:00:00.000Z"), metadata: { graphWorkProductRequired: true },
  });
  // artifact 파일(stepOutputDir/index.html).
  const stepOutputDir = path.join(workProductRoot, "missions", missionId, "runs", runId, "steps", "produce");
  fs.mkdirSync(stepOutputDir, { recursive: true });
  fs.writeFileSync(path.join(stepOutputDir, "index.html"), "<html>artifact</html>");

  if (mode === "live") {
    // live recovery: claimed wakeup on unblock(chain live), no running heartbeat.
    await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId, source: "test", reason: "mission_validation_request_changes", status: "claimed", claimedAt: new Date(), issueId: unblockIssueId, missionId, payload: { issueId: unblockIssueId } });
  } else {
    // stalled: timed_out heartbeat run on unblock(recovery 죽음).
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId, agentId, issueId: unblockIssueId, invocationSource: "assignment", triggerDetail: "system", status: "timed_out", startedAt: new Date("2026-07-12T08:30:00.000Z"), errorCode: "execution_stale_timeout",
    });
  }
  return { companyId, agentId, missionId, producerIssueId, unblockIssueId };
}

describeEP("RES-1318 workproduct-reuse bounded registration", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wp-reuse-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true }); });

  it("live QA recovery → registration dispatch 0 (observe)", async () => {
    await seed(db, "live");
    let dispatched = 0;
    const svc = missionService(db, { onWorkProductReuseWakeRequested: async () => { dispatched += 1; } } as never);
    await svc.runActiveMissionOwnerSupervision({ staleAfterMinutes: 30, applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true, dispatchStaleSourceIssueWakeups: false, now: new Date("2026-07-12T10:00:00.000Z") });
    expect(dispatched).toBe(0);
  });

  it("stalled + artifact → registration wake 1, source reopen 0", async () => {
    const s = await seed(db, "stalled");
    let dispatched = 0;
    const svc = missionService(db, { onWorkProductReuseWakeRequested: async () => { dispatched += 1; } } as never);
    await svc.runActiveMissionOwnerSupervision({ staleAfterMinutes: 30, applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true, dispatchStaleSourceIssueWakeups: false, now: new Date("2026-07-12T10:00:00.000Z") });
    const producerAfter = await db.select().from(issues).where(eq(issues.id, s.producerIssueId)).then((r) => r[0]);
    expect(dispatched).toBe(1);
    expect(producerAfter?.status).toBe("blocked"); // source reopen ❌.
  });
});
