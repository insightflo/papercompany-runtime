import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySecrets,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRunFinalizations,
  heartbeatRunFinalizationSteps,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueWorkProducts,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const heartbeatWakeup = vi.fn().mockResolvedValue({ id: "queued" });

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: () => ({ wakeup: heartbeatWakeup }) };
});

import { issueService } from "../services/issues.js";
import {
  executeWorkflowRun,
  syncWorkflowRunForIssue,
  syncWorkflowRunState,
} from "../services/workflow/dag-engine.js";
import { workflowService } from "../services/workflow/engine.js";
import { reconcileGraceWaitingControlNodes } from "../services/workflow/grace-waiting-control-node-reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("gate work-product grace window", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let artifactRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gate-grace-");
    db = createDb(tempDb.connectionString);
    artifactRoot = await mkdtemp(path.join(tmpdir(), "paperclip-gate-grace-artifacts-"));
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockClear();
    delete process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_MINUTES;
    delete process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(missionAgentRuntimes);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null });
    await db.delete(heartbeatRunFinalizationSteps);
    await db.delete(heartbeatRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(artifactRoot, { recursive: true, force: true });
  });

  /** Producer 를 완료시키되 워크프로덕트는 등록하지 않는다(closeout 레이스 시뮬레이션). */
  async function seedUnregisteredRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Gate Grace Company",
      issuePrefix: `GG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assembler",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: `Gate grace ${runId}`,
      steps: [
        { id: "producer", name: "Producer", agentId, dependencies: [] },
        {
          id: "if-decision",
          name: "Has selected target?",
          type: "if",
          dependencies: ["producer"],
          conditionGroup: {
            combinator: "all",
            conditions: [{
              source: { kind: "work_product_json", stepId: "producer", title: "assemble-result.v1.json", path: "$.status" },
              dataType: "string",
              operator: "equals",
              rightValue: "selected",
            }],
          },
        },
        {
          id: "selected-work",
          name: "Selected work",
          agentId,
          dependencies: [],
          conditionalDependencies: [{ stepId: "if-decision", when: "condition_true" }],
        },
        {
          id: "complete-empty",
          name: "Complete without target",
          type: "complete",
          dependencies: [],
          conditionalDependencies: [{ stepId: "if-decision", when: "condition_false" }],
          completionReason: "No processing target",
        },
      ] as never,
    });
    await db.insert(workflowRuns).values({
      id: runId,
      workflowId: definition.id,
      companyId,
      triggeredBy: "board",
      status: "pending",
      runDate: "2026-09-05",
    });

    await executeWorkflowRun(db, runId);
    const producerRun = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "producer")!);
    await issueService(db).update(producerRun.issueId!, { status: "in_progress" });
    await syncWorkflowRunForIssue(db, producerRun.issueId!);
    await issueService(db).update(producerRun.issueId!, { status: "done" });
    const result = await syncWorkflowRunForIssue(db, producerRun.issueId!);
    return { companyId, runId, producerIssueId: producerRun.issueId!, result };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function loadIfRun(runId: string) {
    return db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "if-decision")!);
  }

  it("waits (pending-wait) instead of failing when the producer just completed without registration", async () => {
    const seeded = await seedUnregisteredRun();
    const ifRun = await loadIfRun(seeded.runId);

    expect(ifRun.status).toBe("pending");
    expect(ifRun.issueId).toBeNull();
    const wait = (ifRun.metadata as Record<string, unknown>).controlNodeGraceWait as Record<string, unknown>;
    expect(wait).toBeTruthy();
    expect(wait.attempts).toBe(1);
    expect(wait.reason).toContain("no completed-attempt local work product");
    expect(wait.nextEvaluateAt).toBeTruthy();
    expect(ifRun.lastDispatchErrorSummary).toBeNull();
    expect(seeded.result?.status).toBe("running");
  });

  it("re-evaluates after the retry delay when the work product arrives late, and clears the wait", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS = "1";
    const seeded = await seedUnregisteredRun();
    const ifRun = await loadIfRun(seeded.runId);
    expect(ifRun.status).toBe("pending");

    // 늦은 등록: producer 현 시도 산물이 도착한다.
    const artifactPath = path.join(artifactRoot, `${seeded.runId}.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(artifactPath, JSON.stringify({ status: "selected" }), "utf8");
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: seeded.producerIssueId,
      type: "file",
      provider: "local",
      externalId: artifactPath,
      title: "assemble-result.v1.json",
      status: "active",
      isPrimary: true,
      metadata: { path: artifactPath },
    });

    await sleep(1100); // retry delay 1s 경과 후 재평가
    await syncWorkflowRunState(db, seeded.runId);

    const reloaded = await loadIfRun(seeded.runId);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_true" } });
    expect((reloaded.metadata as Record<string, unknown>).controlNodeGraceWait).toBeUndefined();
    expect(reloaded.lastDispatchErrorSummary).toBeNull();
  });

  it("does not spin: a sync pass before nextEvaluateAt keeps the wait untouched", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS = "30";
    const seeded = await seedUnregisteredRun();

    await syncWorkflowRunState(db, seeded.runId);

    const reloaded = await loadIfRun(seeded.runId);
    expect(reloaded.status).toBe("pending");
    const wait = (reloaded.metadata as Record<string, unknown>).controlNodeGraceWait as Record<string, unknown>;
    expect(wait.attempts).toBe(1);
  });

  it("fails honestly once the grace window since producer completion has passed", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS = "1";
    const seeded = await seedUnregisteredRun();
    expect((await loadIfRun(seeded.runId)).status).toBe("pending");

    // producer 이슈 완료 시각(대기창 근거, 기본 10분)을 창 밖으로 보낸다.
    await db.update(issues)
      .set({ completedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(issues.id, seeded.producerIssueId));

    await sleep(1100); // retry delay 1s 경과 후 재평가
    await syncWorkflowRunState(db, seeded.runId);

    const reloaded = await loadIfRun(seeded.runId);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.lastDispatchErrorSummary).toContain("no completed-attempt local work product");
    expect((reloaded.metadata as Record<string, unknown>).controlNodeGraceWait).toBeUndefined();
  });

  it("WORKFLOW_GATE_WORK_PRODUCT_GRACE_MINUTES=0 disables the wait (legacy fail-fast)", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_MINUTES = "0";
    const seeded = await seedUnregisteredRun();
    const ifRun = await loadIfRun(seeded.runId);

    expect(ifRun.status).toBe("failed");
    expect(ifRun.lastDispatchErrorSummary).toContain("no completed-attempt local work product");
    expect(seeded.result?.status).toBe("failed");
  });

  it("timer reconciler re-evaluates a due grace-waiting control node", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS = "1";
    const seeded = await seedUnregisteredRun();
    expect((await loadIfRun(seeded.runId)).status).toBe("pending");

    // 늦은 등록 + reconciler 타이머 패스로 재평가.
    const artifactPath = path.join(artifactRoot, `reconcile-${seeded.runId}.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(artifactPath, JSON.stringify({ status: "selected" }), "utf8");
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: seeded.producerIssueId,
      type: "file",
      provider: "local",
      externalId: artifactPath,
      title: "assemble-result.v1.json",
      status: "active",
      isPrimary: true,
      metadata: { path: artifactPath },
    });

    await sleep(1100); // nextEvaluateAt 만료
    const results = await reconcileGraceWaitingControlNodes(db);
    expect(results.some((row) => row.runId === seeded.runId && row.action === "recovered")).toBe(true);

    const reloaded = await loadIfRun(seeded.runId);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_true" } });
  });

  it("type-mismatch on a work-product path waits inside the grace window (placeholder race)", async () => {
    process.env.WORKFLOW_GATE_WORK_PRODUCT_GRACE_RETRY_SECONDS = "1";
    // producer 완료 직후 placeholder({}) 가 등록된 레이스: $.status 가 없다.
    const artifactPath = path.join(artifactRoot, `placeholder-${randomUUID()}.json`);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(artifactPath, JSON.stringify({}), "utf8");

    const seeded = await seedUnregisteredRun();
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: seeded.producerIssueId,
      type: "file",
      provider: "local",
      externalId: artifactPath,
      title: "assemble-result.v1.json",
      status: "active",
      isPrimary: true,
      metadata: { path: artifactPath },
    });
    await sleep(1100); // retry delay 1s 경과 후 재평가
    await syncWorkflowRunState(db, seeded.runId);

    const ifRun = await loadIfRun(seeded.runId);
    expect(ifRun.status).toBe("pending");
    const wait = (ifRun.metadata as Record<string, unknown>).controlNodeGraceWait as Record<string, unknown>;
    expect(wait.reason).toContain("is not a string");
  });
});
