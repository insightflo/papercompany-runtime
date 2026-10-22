import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies, createDb, workflowDefinitions, workflowRuns, workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { completeWorkflowToolStepFromResult } from "../services/workflow/dag-engine.js";
import { settleToolQueueMetadata } from "../services/workflow/tool-queue-settle.js";

/**
 * [purpose] 종료 시 toolQueue 정리(재발 방지). (1) settleToolQueueMetadata 순수 계약 —
 *   기존 큐 기록만 settled 로 바꾸고 없던 큐는 만들지 않는다. (2) 실제 완료/실패 전이가
 *   종료 행에 queued/claimed 를 남기지 않는지 임베디드 PostgreSQL 로 검증한다.
 *   배경: 2026-10-22 실측 — 종료 step run 4,751건이 toolQueue queued/claimed 잔여를 보유했고
 *   종료 시마다 계속 누적 중이었다(완료 경로가 settled 로 바꾸지 않았다).
 */

describe("settleToolQueueMetadata — 순수 계약", () => {
  it("기존 toolQueue 를 settled 로 바꾸고 다른 필드는 보존한다", () => {
    const out = settleToolQueueMetadata(
      { toolQueue: { status: "claimed", queuedAt: "q", claimedAt: "c", heartbeatRunId: "h" }, other: 1 },
      "2026-10-22T00:00:00.000Z",
    );
    expect(out.toolQueue).toEqual({
      status: "settled", settledAt: "2026-10-22T00:00:00.000Z",
      queuedAt: "q", claimedAt: "c", heartbeatRunId: "h",
    });
    expect(out.other).toBe(1);
  });

  it("toolQueue 기록이 없으면 키를 만들지 않는다", () => {
    const out = settleToolQueueMetadata({ other: 1 }, "2026-10-22T00:00:00.000Z");
    expect(out).toEqual({ other: 1 });
    expect(Object.prototype.hasOwnProperty.call(out, "toolQueue")).toBe(false);
  });

  it("malformed toolQueue(배열/null)는 그대로 둔다", () => {
    expect(settleToolQueueMetadata({ toolQueue: ["x"] }, "t").toolQueue).toEqual(["x"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip integration tests: ${support.reason ?? "unsupported"}`);

describeEP("tool step 종료 전이 — toolQueue settled 잔여 방지", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("tool-queue-settle-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settle Co", status: "active" });
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => { await db.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function seedRunningToolStep() {
    const wfId = randomUUID();
    const runId = randomUUID();
    const stepId = `t-${randomUUID().slice(0, 8)}`;
    const reqId = `req-${randomUUID()}`;
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: "Settle WF",
      stepsJson: [{ id: stepId, name: "Tool", agentId: "", type: "tool", toolNames: ["v"], dependencies: [] }],
    });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, status: "running", triggeredBy: "test" });
    const inserted = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId, status: "running", issueId: null,
      lastDispatchRequestId: reqId,
      metadata: {
        toolInvocation: { requestId: reqId, toolName: "v", args: {} },
        toolQueue: { status: "claimed", queuedAt: "2026-10-22T00:00:01.000Z", claimedAt: "2026-10-22T00:00:02.000Z" },
      },
    }).returning();
    return { runId, stepId, reqId, stepRunId: inserted[0].id };
  }

  it("성공 완료 전이가 toolQueue 를 settled 로 남긴다", async () => {
    const seeded = await seedRunningToolStep();
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: seeded.stepRunId, success: true,
      requestId: seeded.reqId, workflowRunId: seeded.runId, stepId: seeded.stepId,
      toolName: "v", exitCode: 0, data: { ok: true },
    });
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seeded.stepRunId));
    expect(row.status).toBe("completed");
    expect((row.metadata as Record<string, unknown>).toolQueue).toMatchObject({ status: "settled" });
  });

  it("실패 완료 전이도 toolQueue 를 settled 로 남긴다", async () => {
    const seeded = await seedRunningToolStep();
    await completeWorkflowToolStepFromResult(db, {
      companyId, stepRunId: seeded.stepRunId, success: false,
      requestId: seeded.reqId, workflowRunId: seeded.runId, stepId: seeded.stepId,
      toolName: "v", exitCode: 1, error: "boom",
    });
    const [row] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, seeded.stepRunId));
    expect(row.status).toBe("failed");
    expect((row.metadata as Record<string, unknown>).toolQueue).toMatchObject({ status: "settled" });
  });
});
