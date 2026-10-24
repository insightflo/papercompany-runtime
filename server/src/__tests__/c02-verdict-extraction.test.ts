import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issues,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import type { WorkflowVerdictSubmit } from "@paperclipai/shared/validators/workflow-agent-api";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createFrozenRun } from "./helpers/workflow-frozen-execution-fixture.js";
import { errorHandler } from "../middleware/index.js";
import { workflowAgentApiRoutes } from "../routes/workflow-agent-api.js";
import { issueService } from "../services/issues.js";
import {
  hasWorkflowValidationCompletionLedger, heartbeatRunScopedToIssue,
  loadLatestNonblockingAcceptance, loadLatestQaRemediations,
  loadWorkflowApiFeedback, loadWorkflowApiFindings,
} from "../services/workflow/validation-verdict-ledger.js";

describe("C02 stage 5: public verdict submission and current readers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("c02-verdict-extraction-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    try {
      if (db) await db.$client.end({ timeout: 5 });
    } finally {
      await tempDb?.cleanup();
    }
  });

  // C02/C12 revision37 preserves duplicate submission, latest-official classification and abstention.
  // Independent expectations: workflow-agent-api-service.test.ts:491-529 (completion states),
  // workflow-frozen-validation.test.ts:155-174 (real scoped write), qa-remediation-pass.test.ts
  // and workflow-qa-cap-acceptance.test.ts (a newer PASS invalidates earlier classifications).
  // The route, DB, ledger, context loader, sync and extracted helpers are all real.
  it("deduplicates a rejection, supersedes its classifications with PASS, then blocks on insufficient evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "C02VerdictCo", issuePrefix: "C02V",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Verdict Validator", role: "qa", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowId, companyId, name: "c02-verdict-extraction",
      stepsJson: [{ id: "qa-review", name: "[QA] Review", type: "qa", agentId, dependencies: [] }],
    });
    const run = await createFrozenRun(db, { workflowId, companyId });
    await db.update(workflowRuns).set({ status: "running", startedAt: new Date() })
      .where(eq(workflowRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId, companyId, identifier: "C02V-" + randomUUID().slice(0, 8),
      title: "[QA] Review", status: "todo", assigneeAgentId: agentId,
      originKind: "workflow_execution", originRunId: run.id,
    });
    const [step] = await db.insert(workflowStepRuns).values({
      workflowRunId: run.id, stepId: "qa-review", issueId, status: "running", startedAt: new Date(),
    }).returning();
    if (!step) throw new Error("QA step was not inserted");

    const actor = {
      type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId: "",
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { ...actor }; next(); });
    app.use("/api", workflowAgentApiRoutes(db));
    app.use(errorHandler);
    const svc = issueService(db);

    async function checkoutHeartbeat(previousRunId?: string) {
      if (previousRunId) {
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, previousRunId));
      }
      const heartbeatRunId = randomUUID();
      const wakeId = randomUUID();
      const attempt = {
        schemaVersion: 1, companyId, agentId, issueId, missionId: null,
        workflowRunId: run.id, stepRunId: step!.id,
        executionGeneration: step!.executionGeneration, retryCount: step!.retryCount,
        iterationIndex: step!.iterationIndex, wakeupRequestId: wakeId, parentHeartbeatRunId: null,
      };
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId, source: "assignment", triggerDetail: "system",
        reason: "workflow_step_runnable", requestKind: "workflow_step_runnable",
        issueId, workflowRunId: run.id, workflowStepRunId: step!.id,
        workflowExecutionGeneration: step!.executionGeneration,
        status: "claimed", runId: heartbeatRunId, requestedAt: new Date(),
        requestedByActorType: "system", requestedByActorId: "c02-verdict-test",
        payload: {
          issueId, workflowRunId: run.id, workflowStepRunId: step!.id,
          __paperclipWorkflowProducerAttempt: attempt,
        },
      });
      await db.insert(heartbeatRuns).values({
        id: heartbeatRunId, companyId, agentId, issueId, status: "running",
        startedAt: new Date(), wakeupRequestId: wakeId,
        workflowStepRunId: step!.id, workflowExecutionGeneration: step!.executionGeneration,
      });
      const issue = await svc.checkout(issueId, agentId, ["todo", "in_progress"], heartbeatRunId);
      expect(issue).toMatchObject({
        status: "in_progress", assigneeAgentId: agentId,
        checkoutRunId: heartbeatRunId, executionRunId: heartbeatRunId,
      });
      actor.runId = heartbeatRunId;
      return { heartbeatRunId, issue };
    }

    const events = () => db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.issueId, issueId),
      eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"),
    ));
    const submit = (body: WorkflowVerdictSubmit) =>
      request(app).post(`/api/issues/${issueId}/workflow/verdict`).send(body).expect(200);
    // Pin only the observation timestamp after the real POST in the owned DB. Every event is
    // created by the API; distinct times make newest selection independent of random UUID ordering.
    async function observe(heartbeatRunId: string, observedAt: Date) {
      const rows = (await events()).filter((row) => row.heartbeatRunId === heartbeatRunId);
      expect(rows).toHaveLength(1);
      const [row] = await db.update(workflowTransitionEvents).set({ createdAt: observedAt })
        .where(eq(workflowTransitionEvents.id, rows[0]!.id)).returning();
      return row!;
    }
    const query = { db, companyId, issueId };
    const boundQuery = { ...query, workflowRunId: run.id, workflowStepRunId: step.id };
    const rejection = {
      verdict: "request_changes" as const, reason: "Fix the report typo.",
      nonblockingAcceptance: { classification: "nonblocking" as const, limitations: ["Minor typo"] },
      findings: [{ id: "typo", layer: "artifact" as const, summary: "Correct the report typo" }],
      remediations: { items: [{
        op: "string_replace" as const, file: "/srv/c02/report.md", find: "teh", replace: "the",
      }] },
    };

    const first = await checkoutHeartbeat();
    const startedAt = first.issue.startedAt!;
    const rejectedAt = new Date(startedAt.getTime() + 1000);
    const passedAt = new Date(startedAt.getTime() + 2000);
    const insufficientAt = new Date(startedAt.getTime() + 3000);
    for (let i = 0; i < 2; i++) {
      expect((await submit(rejection)).body).toMatchObject({
        isCandidate: true, satisfied: true, verdict: "request_changes",
        workflowRunId: run.id, workflowStepRunId: step.id, stepId: "qa-review",
        insufficientEvidence: false, insufficientEvidenceReason: null,
      });
    }
    expect(await events()).toHaveLength(1);
    const rejected = await observe(first.heartbeatRunId, rejectedAt);
    expect(rejected).toMatchObject({
      companyId, issueId, workflowRunId: run.id, workflowStepRunId: step.id,
      heartbeatRunId: first.heartbeatRunId, reason: "workflow_api",
      idempotencyKey: `workflow-validation-verdict:${companyId}:${issueId}:${step.id}:run:${first.heartbeatRunId}`,
      payload: {
        verdict: "request_changes", reason: rejection.reason,
        nonblockingAcceptance: rejection.nonblockingAcceptance,
        findings: rejection.findings, remediations: rejection.remediations,
      },
    });
    expect(await loadLatestNonblockingAcceptance(query)).toEqual({
      acceptance: rejection.nonblockingAcceptance, observedAt: rejectedAt,
      workflowStepRunId: step.id, heartbeatRunId: first.heartbeatRunId,
    });
    expect(await loadLatestQaRemediations(query)).toEqual({
      remediations: rejection.remediations, observedAt: rejectedAt,
      workflowStepRunId: step.id, heartbeatRunId: first.heartbeatRunId,
      sourceVerdictEventId: rejected.id,
    });

    const second = await checkoutHeartbeat(first.heartbeatRunId);
    expect(second.heartbeatRunId).not.toBe(first.heartbeatRunId);
    expect((await submit({ verdict: "pass", reason: "Typo checked." })).body)
      .toMatchObject({ satisfied: true, verdict: "pass", insufficientEvidence: false });
    await observe(second.heartbeatRunId, passedAt);
    expect(await events()).toHaveLength(2);
    expect(await loadLatestNonblockingAcceptance(query)).toBeNull();
    expect(await loadLatestQaRemediations(query)).toBeNull();
    expect(await hasWorkflowValidationCompletionLedger({ db, issue: second.issue })).toMatchObject({
      isCandidate: true, satisfied: true, verdict: "pass",
      insufficientEvidence: false, insufficientEvidenceReason: null,
    });
    // The scope helper still accepts this issue's prior terminal heartbeat after checkout moves.
    expect(await heartbeatRunScopedToIssue(db, first.heartbeatRunId, { companyId, issueId })).toBe(true);

    const third = await checkoutHeartbeat(second.heartbeatRunId);
    expect(new Set([first.heartbeatRunId, second.heartbeatRunId, third.heartbeatRunId]).size).toBe(3);
    const reason = "Need the registered source dataset. " + "x".repeat(4100);
    expect((await submit({ verdict: "insufficient_evidence", reason })).body).toMatchObject({
      isCandidate: true, satisfied: true, verdict: "insufficient_evidence",
      insufficientEvidence: false, insufficientEvidenceReason: null,
    });
    const insufficient = await observe(third.heartbeatRunId, insufficientAt);
    expect(insufficient.payload).toMatchObject({ verdict: "insufficient_evidence", reason: reason.slice(0, 4000) });
    expect((await events()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => [row.verdict, row.createdAt])).toEqual([
      ["request_changes", rejectedAt], ["pass", passedAt], ["insufficient_evidence", insufficientAt],
    ]);
    expect(await hasWorkflowValidationCompletionLedger({ db, issue: third.issue })).toMatchObject({
      isCandidate: true, satisfied: false, verdict: null,
      insufficientEvidence: true, insufficientEvidenceReason: reason.slice(0, 2000),
    });
    expect(await loadLatestNonblockingAcceptance(query)).toBeNull();
    expect(await loadLatestQaRemediations(query)).toBeNull();
    // Feedback/findings intentionally retain their request_changes prefilter, unlike current classification.
    expect(await loadWorkflowApiFeedback(boundQuery))
      .toBe(`### QA feedback at ${rejectedAt.toISOString()}\n${rejection.reason}`);
    expect(await loadWorkflowApiFindings(boundQuery)).toEqual(rejection.findings);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(3);
  });
});
