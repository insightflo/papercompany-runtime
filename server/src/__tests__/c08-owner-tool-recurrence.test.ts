import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, heartbeatRuns, issues, missions, operatorDecisions, workflowDefinitions,
  workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { issueService } from "../services/issues.js";
import { ensureToolRecoveryCard } from "../services/missions/tool-recovery-card.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { closeOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

describe("C08 closed tool request recurrence", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("c08-tool-recurrence-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await temp?.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });

  it("reads one v2 recurrence anchor and accepts only a fresh request", async () => {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(s.tempRoot);
    const [mission] = await db.select().from(missions).where(eq(missions.id, s.missionId));
    const [oversightIssue] = await db.select().from(issues).where(eq(issues.id, s.oversightIssueId));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    const step = (definition.stepsJson as WorkflowStep[]).find(value => value.id === stepRun.stepId)!;
    const produce = (currentStep = stepRun) => ensureToolRecoveryCard(db, {}, {
      mission, oversightIssue, run, stepRun: currentStep, step, workflowName: definition.name,
    }, async (tx, companyId, data) => (await tx.insert(issues).values({ ...data, companyId }).returning())[0]);
    const first = await produce(), firstRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: firstRunId, companyId: s.companyId,
      agentId: s.ownerAgentId, issueId: first.issue.id, status: "running" });
    await issueService(db).checkout(first.issue.id, s.ownerAgentId, ["todo"], firstRunId);
    const target = { kind: "tool_step" as const, workflowRunId: s.workflowRunId, stepRunId: s.stepRunId,
      expectedAuthorityVersion: run.dispatchAuthorityVersion, expectedExecutionGeneration: stepRun.executionGeneration,
      failedDispatchRequestId: stepRun.lastDispatchRequestId };
    const originalKey = randomUUID(), actor = { actorType: "agent" as const, actorId: s.ownerAgentId,
      agentId: s.ownerAgentId, runId: firstRunId };
    const original = await submitMissionOwnerDecision({ db, issueId: first.issue.id, actor, data: {
      decision: "request_input", reason: "old tool request", recoveryTarget: target,
      humanRequest: { schemaVersion: 1, requestKey: originalKey, expectedCurrentLifetimeId: null },
    } });
    await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, s.stepRunId));
    await db.transaction(async tx => closeOwnerHumanRequest(await lockOwnerHumanRequestAuthority(tx, {
      companyId: s.companyId, missionId: s.missionId, ownerActionIssueId: first.issue.id,
      agentId: s.ownerAgentId, heartbeatRunId: firstRunId, recoveryTarget: target, purpose: "settle",
    }), original.lifetimeId!));
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    const [failedAgain] = await db.update(workflowStepRuns).set({ status: "failed" })
      .where(eq(workflowStepRuns.id, s.stepRunId)).returning();
    const next = await produce(failedAgain), nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: s.companyId,
      agentId: s.ownerAgentId, issueId: next.issue.id, status: "running" });
    await issueService(db).checkout(next.issue.id, s.ownerAgentId, ["todo"], nextRunId);
    const nextActor = { ...actor, runId: nextRunId };
    const before = await readOwnerHumanRequest({ db, companyId: s.companyId, issueId: next.issue.id, actor: nextActor });
    expect(before).toMatchObject({ lifetimeId: original.lifetimeId, requestKey: null,
      anchorIssueId: next.issue.id, recoveryNeeded: false, card: null, delivery: null, resubmit: null });
    const freshKey = randomUUID();
    const fresh = await submitMissionOwnerDecision({ db, issueId: next.issue.id, actor: nextActor, data: {
      decision: "request_input", reason: "new tool recurrence", recoveryTarget: target,
      humanRequest: { schemaVersion: 1, requestKey: freshKey, expectedCurrentLifetimeId: before.lifetimeId },
    } });
    expect(fresh.eventId).not.toBe(original.eventId); expect(fresh.lifetimeId).not.toBe(original.lifetimeId);
    expect((await db.select().from(operatorDecisions).where(eq(operatorDecisions.issueId, next.issue.id)))[0])
      .toMatchObject({ status: "pending", result: null });
    expect((await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, first.issue.id)))
      .find(row => row.id === original.eventId)).toBeTruthy();
    await expect(submitMissionOwnerDecision({ db, issueId: next.issue.id, actor: nextActor, data: {
      decision: "request_input", reason: "new tool recurrence", recoveryTarget: target,
      humanRequest: { schemaVersion: 1, requestKey: originalKey, expectedCurrentLifetimeId: before.lifetimeId },
    } })).rejects.toMatchObject({ status: 409 });
  });
});
