import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agentWikiEntries,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issues,
  operatorDecisions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";
import { operatorApprovalWaitService } from "../services/operator-approval-wait.ts";
import { approvalWaitFixtures } from "./helpers/approval-wait-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// [approval-waiting marker] 로드맵 ④ 표면 (i) — 이슈/워크플로 런 조회 파생 필드.
// pending operator_decisions / 미결 approvals 가 있으면 waiting=true + 대상 id, 해소되면 소멸.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("operator approval wait marker surfaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtures: ReturnType<typeof approvalWaitFixtures>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-wait-");
    db = createDb(tempDb.connectionString);
    fixtures = approvalWaitFixtures(db);
  }, 60_000);

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.delete(workflowTransitionEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueApprovals);
    await db.delete(operatorDecisions);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(agentWikiEntries);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("exposes waitingOnOperatorApproval on issue list and clears it after resolve", async () => {
    const { companyId, issueId } = await fixtures.seedBase();
    const decisionId = await fixtures.seedPendingDecision(companyId, issueId);
    const approvalId = await fixtures.seedPendingApproval(companyId, issueId);

    const row = (await issueService(db).list(companyId)).find((item) => item.id === issueId);
    expect(row?.waitingOnOperatorApproval).toEqual({
      waiting: true,
      operatorDecisionIds: [decisionId],
      approvalIds: [approvalId],
    });

    await db
      .update(operatorDecisions)
      .set({
        status: "resolved",
        result: { actionId: "ok", outcome: "submit", selectedOptionIds: [], comment: null },
        resolvedByUserId: "board",
        resolvedAt: new Date(),
      })
      .where(eq(operatorDecisions.id, decisionId));
    await db
      .update(approvals)
      .set({ status: "approved", decidedByUserId: "board", decidedAt: new Date() })
      .where(eq(approvals.id, approvalId));

    const afterRow = (await issueService(db).list(companyId)).find((item) => item.id === issueId);
    expect(afterRow?.waitingOnOperatorApproval).toEqual({
      waiting: false,
      operatorDecisionIds: [],
      approvalIds: [],
    });
  });

  it("keys the workflow-run marker by sourceContext.workflowRunId and sourceId prefix", async () => {
    const { companyId, issueId } = await fixtures.seedBase();
    await fixtures.seedPendingDecision(companyId, issueId, { workflowRunId: "wf-run-1" });
    await fixtures.seedPendingDecision(companyId, issueId, { sourceId: "wf-run-2:producer:qa" });
    const svc = operatorApprovalWaitService(db);
    expect((await svc.markerForWorkflowRun(companyId, "wf-run-1")).waiting).toBe(true);
    expect((await svc.markerForWorkflowRun(companyId, "wf-run-2")).waiting).toBe(true);
    expect((await svc.markerForWorkflowRun(companyId, "wf-run-3")).waiting).toBe(false);
  });
});
