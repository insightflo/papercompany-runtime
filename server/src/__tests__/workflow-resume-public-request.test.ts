import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowResumeRequests, type Db } from "@paperclipai/db";
import {
  seedPreviewGraph, seedPreviewResumeRequest, startExecutionDefinitionFixture,
  type ExecutionDefinitionFixture, type PreviewGraph,
} from "./helpers/workflow-resume-preview-fixture.js";
import { publicRequestSchema, publicResumeApp, publicResumePath } from "./helpers/workflow-resume-public-fixture.js";

// Real persisted corruption at the HTTP readback boundary; no apply/policy bypass.
describe("public request persisted validation", () => {
  let fixture: Extract<ExecutionDefinitionFixture, { supported: true }>;
  let db: Db;
  let graph: PreviewGraph;
  beforeAll(async () => {
    const started = await startExecutionDefinitionFixture("public-request-");
    if (!started.supported) throw new Error(started.reason);
    fixture = started; db = fixture.db;
    graph = await seedPreviewGraph(fixture.sql, db, {
      stepsJson: [{ id: "frozen-start", name: "Frozen start", agentId: "", dependencies: [] }],
    });
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(state = "pending_delivery", change: Record<string, unknown> = {}) {
    const { requestId } = await seedPreviewResumeRequest(db, { ...graph, workflowRunId: graph.runId, state });
    const body = { schemaVersion: 1, mode: "resume_from_step", companyId: graph.companyId,
      missionId: graph.missionId, workflowRunId: graph.runId, startStepId: "frozen-start",
      idempotencyKey: randomUUID(), snapshotToken: "PRIVATE_TOKEN", reason: "PRIVATE_REASON", ...change };
    await db.update(workflowResumeRequests).set({ requestBody: body }).where(eq(workflowResumeRequests.id, requestId));
    return requestId;
  }
  function get(id: string) {
    return request(publicResumeApp(db)).get(publicResumePath(graph, `requests/${id}`));
  }

  it.each(["pending_delivery", "accepted", "blocked", "cancelled"])("preserves approved persisted state %s", async (state) => {
    const id = await seed(state);
    const response = await get(id);
    expect(response.status).toBe(200);
    expect(publicRequestSchema.parse(response.body)).toEqual({ id, workflowRunId: graph.runId,
      startStepId: "frozen-start", state, acceptanceId: null, code: null, createdAt: expect.any(String) });
    expect(response.text).not.toContain("PRIVATE_");
  });

  it.each<[string, Record<string, unknown>]>([
    ["extra field", { secret: "PRIVATE_SECRET" }],
    ["malformed start", { startStepId: 123 }],
    ["missing token", { snapshotToken: undefined }],
    ["company mismatch", { companyId: randomUUID() }],
    ["mission mismatch", { missionId: randomUUID() }],
    ["run mismatch", { workflowRunId: randomUUID() }],
  ])("%s gives fixed 500 without raw fields", async (_name, change) => {
    const id = await seed("pending_delivery", change);
    const response = await get(id);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "invalid_resume_record" });
    expect(response.text).not.toContain("PRIVATE_");
  });

  it("unapproved legacy stored state gives fixed 500 (isolated test DB corruption)", async () => {
    const id = await seed();
    const sql = fixture.sql;
    // Current schema rejects invalid states. Simulate legacy corruption only in this disposable DB.
    await sql`ALTER TABLE workflow_resume_requests DROP CONSTRAINT workflow_resume_requests_state_check`;
    try {
      await db.update(workflowResumeRequests).set({ state: "PRIVATE_INVALID_STATE" }).where(eq(workflowResumeRequests.id, id));
      const response = await get(id);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "invalid_resume_record" });
      expect(response.text).not.toContain("PRIVATE_");
    } finally {
      await db.update(workflowResumeRequests).set({ state: "pending_delivery" }).where(eq(workflowResumeRequests.id, id));
      await sql`ALTER TABLE workflow_resume_requests ADD CONSTRAINT workflow_resume_requests_state_check
        CHECK (state in ('pending_delivery', 'accepted', 'blocked', 'cancelled'))`;
    }
  });
});
