// RES-1318 regression: workproduct-reuse bounded registration with downstream QA gate.
// live QA recovery(downstream QA chain) → dispatch 0; stalled+artifact → registration wake 1;
// non-QA(downstream QA 없음) → 허용; missing artifact → dispatch 0.
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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { missionService } from "../services/missions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const sup = await getEmbeddedPostgresTestSupport();
const describeEP = sup.supported ? describe : describe.skip;
if (!sup.supported) console.warn(`skip workproduct reuse regression: ${sup.reason ?? "unsupported"}`);

type Mode = "live-qa" | "stalled-qa" | "non-qa" | "missing" | "two-unblock-live";
const tmpRoots: string[] = [];

async function seed(db: ReturnType<typeof createDb>, mode: Mode) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const wdId = randomUUID();
  const runId = randomUUID();
  const producerIssueId = randomUUID();
  const qaIssueId = randomUUID();
  const unblockIssueId = randomUUID();
  const suffix = companyId.slice(0, 8);
  const workProductRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wp-reuse-"));
  tmpRoots.push(workProductRoot);
  const withQa = mode !== "non-qa";

  await db.insert(companies).values({ id: companyId, name: "WR Co", issuePrefix: `WR${suffix.toUpperCase()}`, requireBoardApprovalForNewAgents: false, workProductRoot });
  await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "ceo", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "WR mission", status: "active" });
  const steps = withQa
    ? [
        { id: "produce", name: "Produce", dependencies: [], type: "tool", graphWorkProductRequired: true },
        { id: "qa", name: "QA", dependencies: ["produce"], type: "qa" },
      ]
    : [{ id: "produce", name: "Produce", dependencies: [], type: "tool", graphWorkProductRequired: true }];
  await db.insert(workflowDefinitions).values({ id: wdId, companyId, name: "p+qa", stepsJson: steps });
  await db.insert(workflowRuns).values({ id: runId, workflowId: wdId, companyId, missionId, status: "running", triggeredBy: "system" });
  const issueRows = [
    { id: producerIssueId, companyId, missionId, identifier: `WRP${suffix}`, title: "Producer", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId },
    { id: unblockIssueId, companyId, missionId, identifier: `WRU${suffix}`, title: "[Unblock]", status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: producerIssueId },
  ];
  if (withQa) issueRows.splice(1, 0, { id: qaIssueId, companyId, missionId, identifier: `WRQ${suffix}`, title: "QA gate", status: "blocked", assigneeAgentId: agentId, originKind: "workflow_execution", originId: runId, originRunId: runId });
  await db.insert(issues).values(issueRows as never);
  await db.insert(workflowStepRuns).values([
    { id: randomUUID(), workflowRunId: runId, stepId: "produce", issueId: producerIssueId, status: "failed", startedAt: new Date("2026-07-12T08:00:00.000Z"), metadata: { graphWorkProductRequired: true } },
    ...(withQa ? [{ id: randomUUID(), workflowRunId: runId, stepId: "qa", issueId: qaIssueId, status: "pending", startedAt: new Date("2026-07-12T08:10:00.000Z") }] : []),
  ]);
  if (mode !== "missing") {
    const stepOutputDir = path.join(workProductRoot, "missions", missionId, "runs", runId, "steps", "produce");
    fs.mkdirSync(stepOutputDir, { recursive: true });
    fs.writeFileSync(path.join(stepOutputDir, "index.html"), "<html>artifact</html>");
  }
  // stalled recovery: timed_out run on unblock(recovery 죽음).
  await db.insert(heartbeatRuns).values({
    id: randomUUID(), companyId, agentId, issueId: unblockIssueId, invocationSource: "assignment", triggerDetail: "system", status: "timed_out", startedAt: new Date("2026-07-12T08:30:00.000Z"), errorCode: "execution_stale_timeout",
  });
  if (mode === "live-qa") {
    // live QA recovery: claimed wakeup on unblock(downstream QA chain live).
    await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId, source: "test", reason: "mission_validation_request_changes", status: "claimed", claimedAt: new Date(), issueId: unblockIssueId, payload: { issueId: unblockIssueId } });
  }
  if (mode === "two-unblock-live") {
    // 동일 chain 두 unblock: 두 번째 unblock 신규 + 이전 unblock 에 claimed wakeup → multi-unblock live(codex).
    await db.insert(issues).values({ id: randomUUID(), companyId, missionId, identifier: `WRU2${suffix}`, title: "[Unblock2]", status: "todo", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: producerIssueId });
    await db.insert(agentWakeupRequests).values({ id: randomUUID(), companyId, agentId, source: "test", reason: "mission_validation_request_changes", status: "claimed", claimedAt: new Date(), issueId: unblockIssueId, payload: { issueId: unblockIssueId } });
  }
  return { companyId, missionId, producerIssueId, qaIssueId, unblockIssueId };
}

describeEP("RES-1318 workproduct-reuse bounded registration", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeEach(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wp-reuse-"); db = createDb(tempDb.connectionString); }, 60_000);
  afterEach(async () => { await tempDb?.cleanup(); });
  afterAll(async () => { await tempDb?.cleanup(); for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true }); });

  async function run(mode: Mode) {
    const s = await seed(db, mode);
    const dispatched: Array<Record<string, unknown>> = [];
    const svc = missionService(db, {
      onWorkProductReuseWakeRequested: async (input: Record<string, unknown>) => { dispatched.push(input); },
    } as never);
    const result = await svc.runActiveMissionOwnerSupervision({ staleAfterMinutes: 30, applySafeActions: true, applyOwnerDecisionActions: true, dispatchOwnerDecisionWakeups: true, dispatchStaleSourceIssueWakeups: false, now: new Date("2026-07-12T10:00:00.000Z") });
    void result;
    const producerAfter = await db.select().from(issues).where(eq(issues.id, s.producerIssueId)).then((r) => r[0]);
    return { dispatched, producerAfter, s };
  }

  it("live QA recovery(downstream QA chain) → registration dispatch 0", async () => {
    const r = await run("live-qa");
    expect(r.dispatched.length).toBe(0);
    expect(r.producerAfter?.status).toBe("blocked");
  });

  it("stalled + artifact + downstream QA → registration wake 1, source reopen 0", async () => {
    const r = await run("stalled-qa");
    expect(r.dispatched.length).toBe(1);
    expect(r.producerAfter?.status).toBe("blocked");
    // registration 전용 payload(artifactPath/sourceIssue/stalledRecoveryId 포함).
    const payload = r.dispatched[0];
    expect(payload).toHaveProperty("artifactPath");
    expect(payload).toHaveProperty("sourceIssue");
    expect(payload).toHaveProperty("stalledRecoveryIssueId");
  });

  it("non-QA(downstream QA 없음) → registration 허용(guard 안 막음)", async () => {
    const r = await run("non-qa");
    expect(r.dispatched.length).toBe(1);
  });

  it("missing artifact → dispatch 0", async () => {
    const r = await run("missing");
    expect(r.dispatched.length).toBe(0);
  });

  it("two-unblock chain: claimed wakeup on earlier unblock → qa_recovery_live (dispatch 0)", async () => {
    const r = await run("two-unblock-live");
    expect(r.dispatched.length).toBe(0);
    expect(r.producerAfter?.status).toBe("blocked");
  });
});
