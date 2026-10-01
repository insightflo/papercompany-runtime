import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, issueWorkProducts,
  missionPlanQaVerdicts, missions, operatorDecisions, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildMissionRevisionContext } from "../services/missions/mission-revision-context.js";
import { buildRevisionMissionPlanningDescription } from "../services/missions/mission-revision-planning.js";
import { buildMissionOwnerPlanningContext } from "../services/missions/mission-owner-planning-context.js";
import { buildStepInputManifest } from "../services/step-input-manifest.js";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils/runtime-brief";

describe("DB-only revision planning context", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-context-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  it("carries scoped attempts, durable verdicts and products through description, owner input, manifest and runtime brief", async () => {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revision context", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
    await db.insert(missions).values({ id: sourceId, companyId, ownerAgentId, title: "Source" });
    const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: "Source", stepsJson: [] }).returning();
    const [run] = await db.insert(workflowRuns).values({ companyId, missionId: sourceId, workflowId: definition.id, triggeredBy: "manual" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, missionId: sourceId, title: "Action", issueNumber: 1, identifier: randomUUID() }).returning();
    const [step] = await db.insert(workflowStepRuns).values({ workflowRunId: run.id, stepId: "produce", issueId: issue.id,
      status: "completed", executionGeneration: 2, retryCount: 1, iterationIndex: 3 }).returning();
    const [heartbeat] = await db.insert(heartbeatRuns).values({ companyId, agentId: ownerAgentId, issueId: issue.id,
      workflowStepRunId: step.id, workflowExecutionGeneration: 2, status: "failed", errorCode: "timeout",
      error: "FORBIDDEN_ERROR_PROSE", stdoutExcerpt: "FORBIDDEN_STDOUT", stderrExcerpt: "FORBIDDEN_STDERR" }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerAgentId, issueId: issue.id,
      workflowStepRunId: step.id, workflowExecutionGeneration: 1, status: "failed", errorCode: "STALE_GENERATION" });
    const foreignCompanyId = randomUUID(), foreignAgentId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Foreign", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Foreign", role: "operator", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ companyId: foreignCompanyId, agentId: foreignAgentId, issueId: issue.id,
      workflowStepRunId: step.id, workflowExecutionGeneration: 2, errorCode: "FOREIGN_HEARTBEAT" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue.id, body: "FORBIDDEN_COMMENT pass retry approve" }).returning();
    await db.insert(missionPlanQaVerdicts).values([
      { companyId, missionId: sourceId, planQaIssueId: issue.id, sourceRunId: heartbeat.id, decisionHash: "official", verdict: "request_changes" },
      { companyId, missionId: sourceId, planQaIssueId: issue.id, sourceRunId: heartbeat.id, sourceCommentId: comment.id,
        decisionHash: "legacy", verdict: "LEGACY_VERDICT" },
    ]);
    await db.insert(workflowTransitionEvents).values({ companyId, missionId: sourceId, workflowRunId: run.id,
      workflowStepRunId: step.id, issueId: issue.id, heartbeatRunId: heartbeat.id, eventType: "workflow_validation_verdict",
      layer: "workflow_validation", reason: "workflow_api", verdict: "request_changes", payload: { kind: "workflow_validation_verdict" } });
    const producer = { schemaVersion: "workflow.work-product-producer.v1", companyId, missionId: sourceId,
      workflowRunId: run.id, stepRunId: step.id, stepId: step.stepId, executionGeneration: 2, retryCount: 1,
      iterationIndex: 3, heartbeatRunId: heartbeat.id };
    const [product] = await db.insert(issueWorkProducts).values({ companyId, issueId: issue.id, title: "Output", type: "artifact",
      provider: "local", status: "active", createdByRunId: heartbeat.id, sourceExecutionGeneration: 2,
      metadata: { sha256: "a".repeat(64), workflowProducer: producer, notes: "FORBIDDEN_METADATA" } }).returning();
    await db.insert(issueWorkProducts).values({ companyId, issueId: issue.id, title: "Unproven", type: "artifact",
      provider: "local", status: "active", metadata: { sha256: "b".repeat(64) } });
    await db.insert(operatorDecisions).values({ companyId, requestKey: randomUUID(), requestHash: randomUUID(),
      interactionType: "single_select", title: "Choose", description: "FORBIDDEN_DECISION_PROSE", sourceType: "mission", sourceId,
      sourceContext: { missionId: sourceId, workflowId: definition.id, workflowRunId: run.id, artifactRefs: [] },
      definition: { options: [{ id: "revise", label: "Revise", description: null, facts: [], evidenceRefs: [] }],
        actions: [], selection: { min: 1, max: 1 }, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 }, approvedScope: [], forbiddenScope: [] } });
    const [revision] = await db.insert(missions).values({ companyId, ownerAgentId, title: "Revision", sourceMissionId: sourceId,
      sourceWorkflowRunId: run.id }).returning();
    const context = await buildMissionRevisionContext(db, { companyId, missionId: revision.id });
    expect(context?.steps[0]).toMatchObject({ stepId: "produce", status: "completed", retryCount: 1, iterationIndex: 3, errorCode: "timeout" });
    expect(context?.workProducts).toEqual([expect.objectContaining({ id: product.id, sha256: "a".repeat(64), producer })]);
    expect(context?.planQaVerdicts.map(v => v.verdict)).toEqual(["request_changes"]);
    expect(context?.workflowQaVerdicts.map(v => v.verdict)).toEqual(["request_changes"]);
    expect(context?.operatorDecisions[0]).toMatchObject({ status: "pending", optionIds: ["revise"] });
    expect(JSON.stringify(context)).not.toMatch(/FORBIDDEN|LEGACY_VERDICT|STALE_GENERATION|FOREIGN_HEARTBEAT|Unproven/);
    const description = await buildRevisionMissionPlanningDescription(db, { companyId, missionId: revision.id,
      title: revision.title, description: null, runnableRosterLines: [] });
    expect(description).toContain("BEGIN MISSION REVISION CONTEXT");
    expect(description).toContain(product.id);
    const owner = await buildMissionOwnerPlanningContext(db, { companyId, missionId: revision.id });
    expect(owner.revisionContext).toEqual(context);
    const manifest = buildStepInputManifest({ taskKey: `issue:${issue.id}`, context: { paperclipMissionOwnerPlanningContext: owner } });
    const brief = buildPaperclipRuntimeBrief({ paperclipStepInputManifest: manifest });
    expect(brief).toContain("BEGIN MISSION REVISION CONTEXT");
    expect(brief).toContain(product.id);
    expect(brief).not.toMatch(/FORBIDDEN|LEGACY_VERDICT/);
    await expect(buildMissionRevisionContext(db, { companyId: randomUUID(), missionId: revision.id })).rejects.toThrow();
    expect(await buildMissionRevisionContext(db, { companyId, missionId: sourceId })).toBeNull();
  });
});
