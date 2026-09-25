import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
  agents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { rearmBlockedQaIssuesForResume } from "../services/workflow/engine.js";

// [2026-09-25 락 순환 사고] failed run + 게이트 반려(request_changes verdict) + blocked 이슈의
//   재무장 계약: resume CAS 에서 verdict 있는 blocked 이슈만 in_progress 로 되돌려 재작업
//   루프가 살아나게 한다. verdict 없는 blocked 는 건드리지 않는다.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeDb = embeddedPostgresSupport.supported ? describe : describe.skip;

describeDb("workflow resume QA rework re-arm", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let assigneeId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("resume-qa-rearm-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });
  beforeEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowTransitionEvents);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rearm Co", issuePrefix: `R${companyId.slice(0, 4)}` });
    assigneeId = randomUUID();
    await db.insert(agents).values({ id: assigneeId, companyId, name: "Step Agent" });
  });

  async function seedBlockedFailedStepWithVerdict(input: { withVerdict: boolean; issueStatus?: string }) {
    const definitionId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: definitionId, companyId, name: "rearm-wf",
      stepsJson: [{ id: "keyframe-review", name: "Keyframe review" }],
      source: "native", sourceKind: "workflow",
    });
    const runId = randomUUID();
    await db.insert(workflowRuns).values({
      id: runId, workflowId: definitionId, companyId, status: "running", triggeredBy: "task5a1", metadata: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "keyframe-review",
      status: input.issueStatus ?? "blocked", originKind: "workflow_execution",
      assigneeAgentId: assigneeId,
    });
    const stepRunId = randomUUID();
    await db.insert(workflowStepRuns).values({
      id: stepRunId, workflowRunId: runId, stepId: "keyframe-review", status: "failed", issueId,
    });
    if (input.withVerdict) {
      await db.insert(workflowTransitionEvents).values({
        companyId, workflowRunId: runId, workflowStepRunId: stepRunId, issueId,
        eventType: "workflow_validation_verdict", layer: "workflow_validation",
        verdict: "request_changes", decision: "request_changes",
        reason: "workflow_api", reasonCode: "workflow_api",
        idempotencyKey: `wf-verdict:${stepRunId}:${randomUUID()}`,
        payload: { kind: "workflow_validation_verdict", verdict: "request_changes" },
      });
    }
    return { runId, issueId, stepRunId };
  }

  it("re-arms a blocked gate issue when a request_changes verdict exists on the failed step run", async () => {
    const { runId, issueId, stepRunId } = await seedBlockedFailedStepWithVerdict({ withVerdict: true });

    const rearmed = await rearmBlockedQaIssuesForResume(db, { companyId, runId });

    expect(rearmed).toEqual([{ issueId, stepRunId }]);
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, issueId),
    ));
    expect(issue.status).toBe("in_progress");
    expect((await db.select().from(activityLog)).map((row) => row.action))
      .toContain("workflow_run.qa_rework_rearmed");
  });

  it("leaves a blocked gate issue untouched when no request_changes verdict exists", async () => {
    const { runId, issueId } = await seedBlockedFailedStepWithVerdict({ withVerdict: false });

    const rearmed = await rearmBlockedQaIssuesForResume(db, { companyId, runId });

    expect(rearmed).toEqual([]);
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, issueId),
    ));
    expect(issue.status).toBe("blocked");
  });

  it("leaves non-blocked issues untouched even when a verdict exists", async () => {
    const { runId, issueId } = await seedBlockedFailedStepWithVerdict({ withVerdict: true, issueStatus: "in_progress" });

    const rearmed = await rearmBlockedQaIssuesForResume(db, { companyId, runId });

    expect(rearmed).toEqual([]);
    const [issue] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, issueId),
    ));
    expect(issue.status).toBe("in_progress");
  });
});
