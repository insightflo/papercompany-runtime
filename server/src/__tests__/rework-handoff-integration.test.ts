// server/src/__tests__/rework-handoff-integration.test.ts
//
// [purpose] End-to-end source-to-retry tests for native workflow QA rework.
//   Proves the persisted producer issue rework contract + comment contain:
//   (1) producer issue title + description,
//   (2) producer's own active workProduct refs,
//   (3) exact coalesced REQUEST_CHANGES feedback,
//   (4) upstream dependency artifacts in a SEPARATE section.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, heartbeatRuns, issueComments, issueWorkProducts, issues,
  missions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyBackEdgeReworkPass } from "../services/workflow/control-flow/loop-driver.js";
import { applyStructuralGatePass } from "../services/workflow/control-flow/structural-gate-rework.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip rework handoff integration tests: ${support.reason ?? "unsupported"}`);

type StepRun = typeof workflowStepRuns.$inferSelect;

function readContract(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  const c = m.workflowReworkContract;
  return c && typeof c === "object" && !Array.isArray(c) ? c as Record<string, unknown> : null;
}

describeDb("loop-driver back-edge rework: source-to-retry handoff", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-loop-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("persists producer instruction, own products, QA feedback, and separate upstream artifacts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "LoopCo", issuePrefix: "LP", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "loop mission", status: "active" });

    const collectIssue = await db.insert(issues).values({ companyId, missionId, title: "collect-sources", description: "Collect all source articles.", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id });
    const producerIssue = await db.insert(issues).values({ companyId, missionId, title: "produce-report", description: "Produce the final report HTML.", status: "in_progress", assigneeAgentId: agentId }).returning({ id: issues.id });
    const qaIssue = await db.insert(issues).values({ companyId, missionId, title: "qa-validate", description: "Validate the report.", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id });

    // Upstream dependency workProduct on collect issue.
    await db.insert(issueWorkProducts).values({ companyId, issueId: collectIssue[0]!.id, type: "file", provider: "local", title: "sources.json", status: "active", url: "/srv/out/sources.json" });
    // Producer's own active workProduct.
    await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue[0]!.id, type: "file", provider: "local", title: "report-v1", status: "active", url: "/srv/out/report.html" });
    // Inactive product should be excluded.
    await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue[0]!.id, type: "file", provider: "local", title: "report-draft", status: "superseded", url: "/srv/out/draft.html" });

    const steps = [
      { id: "collect", name: "Collect", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: "produce", name: "Produce", agentId, dependencies: ["collect"], graphWorkProductRequired: true,
        conditionalDependencies: [{ stepId: "qa-validate", when: "qa_request_changes" as const, isBackEdge: true, maxIterations: 2 }] },
      { id: "qa-validate", name: "QA", agentId, dependencies: ["produce"] },
    ];
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "loop-wf", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const oldCompleted = new Date(Date.now() - 120_000);
    await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "collect", companyId, issueId: collectIssue[0]!.id, status: "completed", completedAt: oldCompleted });
    await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "produce", companyId, issueId: producerIssue[0]!.id, status: "completed", iterationIndex: 0, completedAt: new Date(Date.now() - 60_000) });
    const [qaStepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: "qa-validate", companyId, issueId: qaIssue[0]!.id, status: "failed",
    }).returning({ id: workflowStepRuns.id });
    // Official workflow_api verdict feedback (comments are never rework authority).
    const qaHeartbeatId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: qaHeartbeatId, companyId, agentId, issueId: qaIssue[0]!.id, status: "succeeded",
      startedAt: new Date(Date.now() - 30_000), finishedAt: new Date(Date.now() - 20_000),
    });
    await db.insert(workflowTransitionEvents).values({
      companyId, missionId, workflowRunId: runId, workflowStepRunId: qaStepRun.id, issueId: qaIssue[0]!.id,
      heartbeatRunId: qaHeartbeatId, eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reason: "workflow_api", reasonCode: "workflow_api",
      idempotencyKey: `rework-feedback:${qaStepRun.id}`,
      payload: {
        kind: "workflow_validation_verdict",
        workflowRunId: runId,
        stepRunId: qaStepRun.id,
        issueId: qaIssue[0]!.id,
        verdict: "request_changes",
        reason: "table column counts are wrong in section 3.",
      },
    });

    const stepRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    const predsByStepId = new Map([
      ["qa-validate", { status: "failed" as const, isQaGate: true, verdict: "request_changes" as const }],
    ]);

    await applyBackEdgeReworkPass({
      db,
      run: { id: runId, companyId, status: "running", missionId },
      steps: steps as Parameters<typeof applyBackEdgeReworkPass>[0]["steps"],
      stepRuns,
      predsByStepId,
    });

    // Verify persisted contract in producer step run metadata.
    const [resetProducer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.stepId, "produce"));
    expect(resetProducer.status).toBe("pending");
    expect(resetProducer.iterationIndex).toBe(1);
    const contract = readContract(resetProducer.metadata);
    expect(contract).not.toBeNull();
    // (1) title + description in instruction.
    expect(contract!.producerIssueInstruction).toContain("produce-report");
    expect(contract!.producerIssueInstruction).toContain("Produce the final report HTML.");
    // (2) own active workProduct present, inactive excluded.
    const wps = contract!.producerWorkProducts as readonly { title: string; ref: string }[];
    expect(wps.some((wp) => wp.title === "report-v1" && wp.ref.includes("report.html"))).toBe(true);
    expect(wps.every((wp) => !wp.title.includes("draft"))).toBe(true);
    // (3) exact QA feedback.
    const fbs = contract!.qaFeedbacks as readonly { feedback: string | null }[];
    expect(fbs.some((f) => f.feedback?.includes("table column counts are wrong"))).toBe(true);
    // (4) upstream artifacts separate.
    expect(contract!.dependencyArtifacts).toContain("collect");
    expect(contract!.dependencyArtifacts).toContain("sources.json");
    expect(contract!.dependencyArtifacts).toContain("upstream artifacts");

    // Verify issue comment on producer issue.
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, producerIssue[0]!.id));
    const commentBody = comments.map((c) => c.body).join("\n");
    expect(commentBody).toContain("produce-report");
    expect(commentBody).toContain("Produce the final report HTML.");
    expect(commentBody).toContain("report-v1 → /srv/out/report.html");
    expect(commentBody).toContain("table column counts are wrong");
    expect(commentBody).toContain("Current upstream artifacts");
    expect(commentBody).toContain("sources.json");
  });
});

describeDb("structural-gate rework: source-to-retry handoff", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-gate-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("persists producer instruction, own products, gate feedback, and separate upstream artifacts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "GateCo", issuePrefix: "GT", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "writer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "gate mission", status: "active" });

    const upstreamIssue = await db.insert(issues).values({ companyId, missionId, title: "collect-data", description: "Collect raw data.", status: "done", assigneeAgentId: agentId }).returning({ id: issues.id });
    const producerIssue = await db.insert(issues).values({ companyId, missionId, title: "produce-html", description: "Generate the HTML dashboard.", status: "in_progress", assigneeAgentId: agentId }).returning({ id: issues.id });

    await db.insert(issueWorkProducts).values({ companyId, issueId: upstreamIssue[0]!.id, type: "file", provider: "local", title: "raw-data.json", status: "active", url: "/srv/out/raw.json" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue[0]!.id, type: "file", provider: "local", title: "dashboard-v1", status: "active", url: "/srv/out/dashboard.html" });

    const steps = [
      { id: "collect", name: "Collect", agentId, dependencies: [], graphWorkProductRequired: true },
      { id: "produce", name: "Produce", agentId, dependencies: ["collect"], graphWorkProductRequired: true },
      { id: "gate", name: "G", agentId: "", type: "tool", qaType: "structural", toolNames: ["check"], dependencies: ["produce"], graphWorkProductRequired: false },
    ];
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({ id: wfId, companyId, name: "gate-wf", stepsJson: steps });
    await db.insert(workflowRuns).values({ id: runId, companyId, workflowId: wfId, missionId, status: "running", triggeredBy: "test" });

    const reqId = `req-${randomUUID()}`;
    const oldCompleted = new Date(Date.now() - 120_000);
    const prodRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: "produce", companyId, issueId: producerIssue[0]!.id,
      status: "completed", iterationIndex: 0, completedAt: oldCompleted, lastDispatchRequestId: `prod-${randomUUID()}`,
    }).returning();
    const gateRun = await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: "gate", companyId, status: "failed",
      lastDispatchRequestId: reqId, metadata: { structuralGateProducerGeneration: 0 },
    }).returning();
    await db.insert(workflowStepRuns).values({
      workflowRunId: runId, stepId: "collect", companyId, issueId: upstreamIssue[0]!.id,
      status: "completed", completedAt: oldCompleted,
    });

    // Exact-current verdict: request_changes for this gate run's requestId.
    await db.insert(workflowTransitionEvents).values({
      companyId, workflowRunId: runId, workflowStepRunId: gateRun[0]!.id,
      eventType: "workflow_validation_verdict", layer: "workflow_validation",
      verdict: "request_changes", decision: "request_changes", reasonCode: "workflow_tool_result",
      reason: "Schema validation failed: missing title element.",
      idempotencyKey: `structural-gate-verdict:${companyId}:${gateRun[0]!.id}:${reqId}`,
      payload: { kind: "structural_gate_verdict", verdict: "request_changes", requestId: reqId, reason: "Schema validation failed: missing title element." },
      createdAt: new Date(Date.now() - 30_000),
    });

    const freshRuns = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId));
    await applyStructuralGatePass({
      db, run: { id: runId, companyId, status: "running", missionId },
      steps: steps as Parameters<typeof applyStructuralGatePass>[0]["steps"],
      stepRuns: freshRuns as Parameters<typeof applyStructuralGatePass>[0]["stepRuns"],
    });

    // Verify persisted contract in producer step run metadata.
    const [resetProducer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, prodRun[0]!.id));
    expect(resetProducer.status).toBe("pending");
    expect(resetProducer.iterationIndex).toBe(1);
    const contract = readContract(resetProducer.metadata);
    expect(contract).not.toBeNull();
    // (1) title + description.
    expect(contract!.producerIssueInstruction).toContain("produce-html");
    expect(contract!.producerIssueInstruction).toContain("Generate the HTML dashboard.");
    // (2) own active product.
    const wps = contract!.producerWorkProducts as readonly { title: string; ref: string }[];
    expect(wps.some((wp) => wp.title === "dashboard-v1" && wp.ref.includes("dashboard.html"))).toBe(true);
    // (3) exact gate feedback.
    const fbs = contract!.qaFeedbacks as readonly { feedback: string | null }[];
    expect(fbs.some((f) => f.feedback?.includes("Schema validation failed"))).toBe(true);
    // (4) upstream separate.
    expect(contract!.dependencyArtifacts).toContain("collect");
    expect(contract!.dependencyArtifacts).toContain("raw-data.json");

    // Verify issue comment on producer issue.
    const comments = await db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, producerIssue[0]!.id));
    const commentBody = comments.map((c) => c.body).join("\n");
    expect(commentBody).toContain("produce-html");
    expect(commentBody).toContain("Generate the HTML dashboard.");
    expect(commentBody).toContain("dashboard-v1 → /srv/out/dashboard.html");
    expect(commentBody).toContain("Schema validation failed");
    expect(commentBody).toContain("Current upstream artifacts");
  });
});
