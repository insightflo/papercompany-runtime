import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findAcceptedWorkflowRetryWakeEvidence } from "../services/workflow/retry-execution-state.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip retry wake evidence tests: ${support.reason ?? "unsupported"}`);

describeEP("workflow retry wake evidence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("retry-wake-evidence-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RetryWakeEvidenceCo", status: "active" });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 }); await tempDb?.cleanup();
  });

  it("requires exact company issue run step and idempotency key, and only treats coalesced as live with a linked queued/running run", async () => {
    const issueId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const key = `workflow-step-retry:${stepRunId}:1`;
    const liveRunId = randomUUID();
    const terminalRunId = randomUUID();
    const liveAgentId = randomUUID();
    const terminalAgentId = randomUUID();
    const wakeAgentId = randomUUID();
    await db.insert(agents).values([
      { id: liveAgentId, companyId, name: "Live Agent", role: "worker", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: terminalAgentId, companyId, name: "Terminal Agent", role: "worker", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: wakeAgentId, companyId, name: "Wake Agent", role: "worker", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: liveRunId, companyId, agentId: liveAgentId, issueId: null, invocationSource: "test", status: "queued" },
      { id: terminalRunId, companyId, agentId: terminalAgentId, issueId: null, invocationSource: "test", status: "failed", finishedAt: new Date(), error: "done" },
    ]);
    await db.insert(agentWakeupRequests).values([
      { companyId, agentId: wakeAgentId, issueId, workflowRunId: randomUUID(), workflowStepRunId: stepRunId, idempotencyKey: key, status: "queued", source: "test", requestedAt: new Date() },
      { companyId, agentId: wakeAgentId, issueId, workflowRunId, workflowStepRunId: randomUUID(), idempotencyKey: key, status: "queued", source: "test", requestedAt: new Date() },
      { companyId, agentId: wakeAgentId, issueId, workflowRunId, workflowStepRunId: stepRunId, idempotencyKey: `${key}-other`, status: "queued", source: "test", requestedAt: new Date() },
      { companyId, agentId: wakeAgentId, issueId, workflowRunId, workflowStepRunId: stepRunId, idempotencyKey: key, status: "coalesced", runId: terminalRunId, source: "test", requestedAt: new Date() },
    ]);

    const none = await findAcceptedWorkflowRetryWakeEvidence(db, { companyId, issueId, workflowRunId, stepRunId, idempotencyKey: key });
    expect(none).toBeNull();

    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: wakeAgentId,
      issueId,
      workflowRunId,
      workflowStepRunId: stepRunId,
      idempotencyKey: key,
      status: "coalesced",
      runId: liveRunId,
      source: "test",
      requestedAt: new Date(),
    });

    const accepted = await findAcceptedWorkflowRetryWakeEvidence(db, { companyId, issueId, workflowRunId, stepRunId, idempotencyKey: key });
    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe("coalesced");
    expect(accepted?.runId).toBe(liveRunId);
  });
  it.each([
    ["queued"],
    ["claimed"],
    ["deferred_issue_execution"],
  ])("accepts direct live retry wake status %s", async (status) => {
    const agentId = randomUUID();
    const issueId = randomUUID();
    const workflowRunId = randomUUID();
    const stepRunId = randomUUID();
    const key = `workflow-step-retry:${stepRunId}:1`;
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent-${status}`,
      role: "worker",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      issueId,
      workflowRunId,
      workflowStepRunId: stepRunId,
      idempotencyKey: key,
      status,
      source: "test",
      requestedAt: new Date(),
    });

    const accepted = await findAcceptedWorkflowRetryWakeEvidence(db, {
      companyId,
      issueId,
      workflowRunId,
      stepRunId,
      idempotencyKey: key,
    });
    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe(status);
    expect(accepted?.runId).toBeNull();
  });
});
