import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { companies, missions, workflowResumeExecutions, workflowResumeRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { captureHttpError } from "./helpers/workflow-execution-definition-fixture.js";
import {
  countCompanyRuns,
  loadDeliveryExecution,
  loadDeliveryRequest,
  markRunPendingDelivery,
  seedResumeDeliveryGraph,
} from "./helpers/workflow-resume-delivery-fixture.js";
import {
  captureNativeScopedRecords,
  startNativeEntryFixture,
  type NativeEntryFixture,
} from "./helpers/workflow-resume-native-entry-fixture.js";

// External-effect mocks only (agent wakeups). Acceptance storage, engine and sync run on real PG.
const { heartbeatWakeup } = vi.hoisted(() => ({ heartbeatWakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});
vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0]) =>
      actual.queueIssueAssignmentWakeup({ ...input, heartbeat: { wakeup: heartbeatWakeup } }),
  };
});

import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";
import { dispatchAcceptedResumeWork } from "../services/workflow/resume/dispatcher.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping resume acceptance tests: ${embeddedPostgresSupport.reason ?? "unsupported host"}`);
}

describeEP("workflow resume dispatcher acceptance (deliver, block, cancel — never a new run)", () => {
  let fixture: Extract<NativeEntryFixture, { supported: true }>;
  let db: Db;
  const NOW = new Date("2026-09-08T01:00:00.000Z");

  beforeAll(async () => {
    const started = await startNativeEntryFixture("resume-acceptance-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started;
    db = fixture.db;
  }, 60_000);
  afterAll(async () => {
    if (fixture?.supported) await fixture.cleanup();
  });
  beforeEach(async () => {
    // [격리] 공유 PG 인스턴스에서 이전 테스트의 미종결 resume 행 격리(프로덕션 로직 아님).
    await db.update(workflowResumeExecutions).set({
      state: "cancelled",
      code: "mission_cancelled",
      leaseOwner: null,
      leaseUntil: null,
    }).where(inArray(workflowResumeExecutions.state, ["queued", "running"]));
    await db.update(workflowResumeRequests).set({
      state: "blocked",
      code: "scope_changed",
      leaseOwner: null,
      leaseUntil: null,
    }).where(eq(workflowResumeRequests.state, "pending_delivery"));
  });
  afterEach(() => heartbeatWakeup.mockReset());

  it("delivers a pending request: accept → execution completed → sync guard admits the resumed run", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rda-ok" });
    const requestId = await markRunPendingDelivery(db, graph, {});
    heartbeatWakeup.mockResolvedValue({ id: "rda-wake" });

    const result = await dispatchAcceptedResumeWork(db, { now: NOW });

    expect(result.acceptedCount).toBe(1);
    expect(result.completedCount).toBe(1);
    expect(result.blockedCount + result.cancelledCount + result.failedCount).toBe(0);
    const request = await loadDeliveryRequest(fixture.sql, requestId);
    expect(request!.state).toBe("accepted");
    expect(request!.code).toBeNull();
    expect(request!.accepted_at).not.toBeNull();
    expect(request!.delivery_attempts).toBe(1);
    const execution = await loadDeliveryExecution(fixture.sql, requestId);
    expect(execution!.state).toBe("completed");
    expect(execution!.authority_version).toBe(3);
    expect(execution!.generations).toEqual({ [graph.stepId]: 3 });
    expect(execution!.completed_at).not.toBeNull();
    // sync actually launched the resumed step under the SAME generation — the guard passed.
    const [stepRun] = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, graph.runId));
    expect(stepRun!.issueId).not.toBeNull();
    expect(stepRun!.executionGeneration).toBe(3);
    expect((stepRun!.metadata as Record<string, unknown>).resumeRequestId).toBe(requestId);
  });

  it("still refuses sync while the request is pending — the guard admits dispatcher delivery only", async () => {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: "rda-guard" });
    await markRunPendingDelivery(db, graph, {});
    const error = await captureHttpError(syncWorkflowRunState(db, graph.runId, "workflow_sync"));
    expect(error.status).toBe(409);
    expect(error.message).toBe("resume_not_accepted");
    expect((error.details as { reason?: string }).reason).toBe("resume_request_state_pending_delivery");

    heartbeatWakeup.mockResolvedValue({ id: "rda-guard-wake" });
    const result = await dispatchAcceptedResumeWork(db, { now: NOW });
    expect(result.acceptedCount).toBe(1);
    const after = await syncWorkflowRunState(db, graph.runId, "workflow_sync");
    expect(after.status).toBe("running");
  });

  /** blocked/cancelled 공통 단언: 요청 상태+코드, 실행 row 부재, run/step/issues 무변이, 신규 run 없음. */
  async function expectBlockedOutcome(input: {
    prefix: string;
    expectedState: "blocked" | "cancelled";
    expectedCode: string;
    breakScope: (graph: Awaited<ReturnType<typeof seedResumeDeliveryGraph>>) => Promise<void>;
  }) {
    const graph = await seedResumeDeliveryGraph(fixture.sql, db, { prefix: input.prefix });
    const requestId = await markRunPendingDelivery(db, graph, {});
    await input.breakScope(graph);
    const before = await captureNativeScopedRecords(fixture.sql, graph.runId);
    const runsBefore = await countCompanyRuns(fixture.sql, graph.companyId);

    const result = await dispatchAcceptedResumeWork(db, { now: NOW });

    expect(result.blockedCount + result.cancelledCount).toBe(1);
    expect(result.acceptedCount + result.completedCount + result.failedCount).toBe(0);
    const request = await loadDeliveryRequest(fixture.sql, requestId);
    expect(request!.state).toBe(input.expectedState);
    expect(request!.code).toBe(input.expectedCode);
    expect(await loadDeliveryExecution(fixture.sql, requestId)).toBeUndefined();
    expect(await captureNativeScopedRecords(fixture.sql, graph.runId)).toEqual(before);
    expect(await countCompanyRuns(fixture.sql, graph.companyId)).toBe(runsBefore);
  }

  it("blocks authority-stale delivery with zero run/step writes, no execution, no new run", async () => {
    await expectBlockedOutcome({
      prefix: "rda-stale",
      expectedState: "blocked",
      expectedCode: "authority_stale",
      breakScope: async (graph) => {
        await db.update(workflowRuns).set({ dispatchAuthorityVersion: 4 }).where(eq(workflowRuns.id, graph.runId));
      },
    });
  });

  it("cancels delivery when the mission is cancelled — zero run/step writes, no execution", async () => {
    await expectBlockedOutcome({
      prefix: "rda-cancel",
      expectedState: "cancelled",
      expectedCode: "mission_cancelled",
      breakScope: async (graph) => {
        await db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, graph.missionId));
      },
    });
  });

  it("blocks scope-changed delivery (step ownership broken) with zero writes and no execution", async () => {
    await expectBlockedOutcome({
      prefix: "rda-scope",
      expectedState: "blocked",
      expectedCode: "scope_changed",
      breakScope: async (graph) => {
        const [stepRun] = await db.select().from(workflowStepRuns)
          .where(eq(workflowStepRuns.workflowRunId, graph.runId));
        await db.update(workflowStepRuns)
          .set({ metadata: { resumeRequestId: randomUUID() } })
          .where(eq(workflowStepRuns.id, stepRun!.id));
      },
    });
  });

  it("blocks budget hard-stop delivery with zero writes and no execution", async () => {
    await expectBlockedOutcome({
      prefix: "rda-budget",
      expectedState: "blocked",
      expectedCode: "budget_hard_stop",
      breakScope: async (graph) => {
        await db.update(companies)
          .set({ budgetMonthlyCents: 100, spentMonthlyCents: 100 })
          .where(eq(companies.id, graph.companyId));
      },
    });
  });
});
