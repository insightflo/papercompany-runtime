// @vitest-environment node
// [workflow-child fix round] P1-5/6 + P2-9 검증: 부모 취소의 자손 전파, 자식 미션 런타임 격리,
// {$childInputs.*} 토큰 소비.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  processQueuedWorkflowToolStepRuns,
  setWorkflowToolStepExecutor,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { cancelWorkflowRunWithCleanup } from "../services/workflow/dag-engine.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
} from "./helpers/workflow-child-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

async function insertMissionRuntime(companyId: string, missionId: string, agentId: string): Promise<void> {
  await db.insert(missionAgentRuntimes).values({
    companyId,
    missionId,
    agentId,
    adapterType: "codex_local",
    runtimeKey: `rt-${randomUUID()}`,
    status: "idle",
  });
}

describeEmbeddedPostgres("workflow child fix round — cancel/isolation/inputs", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-fix-cancel-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    setWorkflowToolStepExecutor(null);
    await db.delete(missionAgentRuntimes);
    await db.delete(workflowStepInvocations);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("cancels the live descendant and marks the parent step child_run_cancelled; unrelated mission untouched (P1-5)", async () => {
    const companyId = await createCompanyFixture("Fix Cancel Co");
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Extra Owner" });
    const childDefId = await insertDefinition({
      companyId,
      name: "long-child-wf",
      steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId)],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    expect(result.status).toBe("running");

    // 무관한 미션 + 실행 중 run + 활성 런타임 — 취소 전파의 반경 밖이어야 한다.
    const otherMissionId = randomUUID();
    await db.insert(missions).values({
      id: otherMissionId,
      companyId,
      ownerAgentId,
      title: "Other mission",
      status: "active",
      source: "workflow",
    });
    const otherRunId = randomUUID();
    await db.insert(workflowRuns).values({
      id: otherRunId,
      workflowId: parentDefId,
      companyId,
      missionId: otherMissionId,
      status: "running",
      triggeredBy: "board",
    });
    await insertMissionRuntime(companyId, otherMissionId, ownerAgentId);
    expect(result.missionId).toBeTruthy();
    await insertMissionRuntime(companyId, result.missionId!, ownerAgentId);

    const cancelled = await cancelWorkflowRunWithCleanup(db, result.runId, companyId);
    expect(cancelled).toBe(true);

    const [childRun] = await db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));
    expect(childRun?.status).toBe("cancelled");
    const [parentRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(parentRun?.status).toBe("cancelled");
    const [parentStep] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, result.runId));
    expect(parentStep?.status).toBe("failed");
    expect((parentStep?.metadata as Record<string, unknown>).toolResult)
      .toEqual(expect.objectContaining({ error: "child_run_cancelled" }));
    const [otherRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, otherRunId));
    expect(otherRun?.status).toBe("running");
    // 취소 전파 관측 기록(activity): 자손 취소가 전파 사실과 출발점을 남긴다.
    const propagationLog = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "workflow_run.cancelled")));
    const childPropagation = propagationLog.find((row) => row.entityId === childRun?.id);
    expect(childPropagation).toBeTruthy();
    expect((childPropagation?.details as Record<string, unknown>).propagatedFrom).toBe(result.runId);
    const otherRuntime = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, otherMissionId));
    expect(otherRuntime[0]?.status).toBe("idle");
  });

  it("keeps child runs out of the parent mission so child terminal cannot stop mission runtimes (P1-6)", async () => {
    const companyId = await createCompanyFixture("Fix Mission Co");
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Mission Owner" });
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true, ok: true });
    setWorkflowToolStepExecutor(toolExecutor);
    const childDefId = await insertDefinition({
      companyId,
      name: "completing-child-wf",
      steps: [{ id: "t", name: "T", type: "tool", agentId: "", dependencies: [], toolNames: ["ok-tool"], toolArgs: {} }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [
        childStep(childDefId),
        { id: "downstream", name: "D", type: "agent", agentId: "", dependencies: ["run-child"] },
      ],
    });
    const result = await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    expect(result.missionId).toBeTruthy();
    await insertMissionRuntime(companyId, result.missionId!, ownerAgentId);

    // 자식을 완료시킨다(툴 러너 콜백 재현).
    const [invocation] = await db.select().from(workflowStepInvocations);
    const [childStepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, invocation?.childRunId ?? ""));
    await completeChildStep(companyId, invocation!.childRunId!, childStepRun.id, childStepRun.stepId);
    void processQueuedWorkflowToolStepRuns;

    const [childRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, invocation?.childRunId ?? ""));
    expect(childRun?.status).toBe("completed");
    // 자식은 부모 미션을 상속하지 않는다(격리).
    expect(childRun?.missionId).toBeNull();
    // 자식 종말이 부모 미션 런타임을 중단시키지 않는다.
    const runtime = await db.select().from(missionAgentRuntimes).where(eq(missionAgentRuntimes.missionId, result.missionId!));
    expect(runtime[0]?.status).toBe("idle");
  });

  it("child tool step consumes {$childInputs.q} (P2-9, known-key success case)", async () => {
    const companyId = await createCompanyFixture("Fix Inputs Co");
    const toolExecutor = vi.fn().mockResolvedValue({ accepted: true, ok: true });
    setWorkflowToolStepExecutor(toolExecutor);
    const childDefId = await insertDefinition({
      companyId,
      name: "input-child-wf",
      steps: [{
        id: "t",
        name: "T",
        type: "tool",
        agentId: "",
        dependencies: [],
        toolNames: ["echo-tool"],
        // [fix2 P2-7] 알려진 키만 사용 — 미지 키는 이제 enqueue 전 fail-closed 되므로
        // 실행 도달 케이스에서 제외했다(미지 키 0-실행 회귀는 fix2-semantics 스위트).
        toolArgs: { q: "{$childInputs.q}" },
      }],
    });
    const parentDefId = await insertDefinition({
      companyId,
      name: "parent-wf",
      steps: [childStep(childDefId, { inputs: { q: "hello-world" } })],
    });
    await workflowService.trigger(db, {
      workflowId: parentDefId,
      companyId,
      triggeredBy: "board",
      triggerSource: "api",
    });
    await processQueuedWorkflowToolStepRuns(db);

    expect(toolExecutor).toHaveBeenCalledTimes(1);
    const callArgs = toolExecutor.mock.calls[0]?.[0] as { args: Record<string, string> };
    expect(callArgs.args.q).toBe("hello-world");
  });
});

async function completeChildStep(
  companyId: string,
  childRunId: string,
  childStepRunId: string,
  childStepId: string,
): Promise<void> {
  const { completeWorkflowToolStepFromResult } = await import("../services/workflow/dag-engine.js");
  await completeWorkflowToolStepFromResult(db, {
    companyId,
    stepRunId: childStepRunId,
    workflowRunId: childRunId,
    stepId: childStepId,
    toolName: "ok-tool",
    success: true,
    data: { ok: true },
    stdout: "",
    exitCode: 0,
  });
}
