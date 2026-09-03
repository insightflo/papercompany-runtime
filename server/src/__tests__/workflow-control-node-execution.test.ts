import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
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
  toolDefinitions,
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
import { buildWorkflowReworkContract } from "../services/workflow/control-flow/rework-contract.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("native workflow control-node execution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let artifactRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-control-node-");
    db = createDb(tempDb.connectionString);
    artifactRoot = await mkdtemp(path.join(tmpdir(), "paperclip-control-node-artifacts-"));
    await db.insert(instanceSettings).values({
      singletonKey: "default",
      general: {},
      experimental: { enableHeartbeatFinalizationV1: true },
    } as never);
  }, 60_000);

  afterEach(async () => {
    heartbeatWakeup.mockClear();
    // Allow async heartbeat side-effects to settle before FK-sensitive deletes.
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
    // Straggler run events can appear while runs are torn down.
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

  async function seedRun(status: "selected" | "empty" | "invalid-json") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Control Node Company",
      issuePrefix: `CN${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const definition = await workflowService.createDefinition(db, {
      companyId,
      name: `Control node ${status}`,
      steps: [
        { id: "producer", name: "Producer", agentId, dependencies: [], graphWorkProductRequired: true },
        {
          id: "if-decision",
          name: "Has selected target?",
          type: "if",
          dependencies: ["producer"],
          conditionGroup: {
            combinator: "all",
            conditions: [{
              source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
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
      runDate: "2026-07-20",
    });

    await executeWorkflowRun(db, runId);
    const producerRun = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId))
      .then((rows) => rows.find((row) => row.stepId === "producer")!);
    await issueService(db).update(producerRun.issueId!, { status: "in_progress" });
    await syncWorkflowRunForIssue(db, producerRun.issueId!);
    const artifactPath = path.join(artifactRoot, `${runId}.json`);
    await writeFile(
      artifactPath,
      status === "invalid-json" ? "{raw-secret-not-json" : JSON.stringify({ status }),
      "utf8",
    );
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: producerRun.issueId!,
      type: "file",
      provider: "local",
      externalId: artifactPath,
      title: "decision.json",
      status: "active",
      isPrimary: true,
      metadata: { path: artifactPath },
    });
    await issueService(db).update(producerRun.issueId!, { status: "done" });
    const result = await syncWorkflowRunForIssue(db, producerRun.issueId!);
    const stepRuns = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, runId));
    return { companyId, runId, artifactPath, result, stepRuns };
  }

  it("evaluates IF true synchronously, launches only the true branch, and reuses the persisted result", async () => {
    const seeded = await seedRun("selected");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    const selectedRun = seeded.stepRuns.find((row) => row.stepId === "selected-work")!;
    const completeRun = seeded.stepRuns.find((row) => row.stepId === "complete-empty")!;

    expect(ifRun).toMatchObject({ status: "completed", issueId: null });
    expect(ifRun.dispatchReadyAt).not.toBeNull();
    expect(ifRun.metadata).toMatchObject({ controlNodeResult: { nodeType: "if", outcome: "condition_true" } });
    // Selected branch is issued and launched (running) on the true edge; false Complete stays skipped.
    expect(selectedRun).toMatchObject({ status: "running" });
    expect(selectedRun.issueId).toBeTruthy();
    expect(completeRun).toMatchObject({ status: "skipped", issueId: null });

    await writeFile(seeded.artifactPath, JSON.stringify({ status: "empty" }), "utf8");
    await syncWorkflowRunState(db, seeded.runId);
    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, ifRun.id)).then((rows) => rows[0]!);
    expect(reloaded.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_true" } });
  });

  it("routes false to Complete with no control-node issue or wakeup and completes the run", async () => {
    const seeded = await seedRun("empty");
    const byStep = new Map(seeded.stepRuns.map((row) => [row.stepId, row]));
    expect(byStep.get("if-decision")).toMatchObject({ status: "completed", issueId: null });
    expect(byStep.get("if-decision")?.dispatchReadyAt).not.toBeNull();
    expect(byStep.get("if-decision")?.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_false" } });
    expect(byStep.get("selected-work")).toMatchObject({ status: "skipped", issueId: null });
    expect(byStep.get("complete-empty")).toMatchObject({ status: "completed", issueId: null });
    expect(byStep.get("complete-empty")?.dispatchReadyAt).not.toBeNull();
    expect(byStep.get("complete-empty")?.metadata).toMatchObject({ controlNodeResult: { nodeType: "complete", outcome: "completed", reason: "No processing target" } });
    expect(seeded.result?.status).toBe("completed");
    const controlRunIds = [byStep.get("if-decision")!.id, byStep.get("complete-empty")!.id];
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups.filter((row) => controlRunIds.includes(row.workflowStepRunId ?? ""))).toEqual([]);
  });

  it("fails closed on invalid JSON without persisting raw source content", async () => {
    const seeded = await seedRun("invalid-json");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    expect(ifRun.status).toBe("failed");
    expect(ifRun.lastDispatchErrorSummary).toContain("not valid JSON");
    expect(JSON.stringify(ifRun.metadata)).not.toContain("raw-secret-not-json");
    expect(seeded.result?.status).toBe("failed");
  });

  it("turns a completed IF with a missing result into a failed run", async () => {
    const seeded = await seedRun("selected");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    await db.update(workflowStepRuns).set({ metadata: {}, status: "completed" })
      .where(eq(workflowStepRuns.id, ifRun.id));
    const result = await syncWorkflowRunState(db, seeded.runId);
    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, ifRun.id)).then((rows) => rows[0]!);
    expect(reloaded.status).toBe("failed");
    expect(result.status).toBe("failed");
  });

  it("Fix1: rework 재완료 시 producer startedAt 을 rework 계약 createdAt 으로 잡아 현 시도 산물이 stale 처리되지 않는다", async () => {
    const seeded = await seedRun("selected");
    const producerRun = seeded.stepRuns.find((row) => row.stepId === "producer")!;
    const issueId = producerRun.issueId!;

    // rework 시작 하한. 현 시도 산물은 이보다 뒤에 생산된다.
    const reworkStartedAt = new Date("2026-07-20T10:00:00Z");
    const priorCompletedAt = new Date("2026-07-20T09:50:00Z"); // 직전(반려된) 시도 완료
    const issueCompletedAt = new Date("2026-07-20T10:05:00Z"); // 현 시도 issue 완료(> prior)
    const workProductUpdatedAt = new Date("2026-07-20T10:02:00Z"); // 현 시도 산물(> reworkStartedAt)

    // rework 리셋 상태 시뮬레이션: pending, startedAt=null, iteration+1, 직전 시도 archive + rework 계약.
    const reworkContract = buildWorkflowReworkContract({
      producerStepId: "producer",
      qaFeedbacks: [{ qaStepId: "if-decision", qaIssueId: null, feedback: "needs update" }],
      currentIteration: 0,
      maxIterations: 3,
      createdAt: reworkStartedAt,
    });
    await db.update(workflowStepRuns).set({
      status: "pending",
      startedAt: null,
      completedAt: null,
      iterationIndex: 1,
      metadata: {
        controlFlowAttempts: [{ iteration: 0, verdict: "request_changes", completedAt: priorCompletedAt.toISOString() }],
        workflowReworkContract: reworkContract,
      },
    }).where(eq(workflowStepRuns.id, producerRun.id));

    // 현 시도 issue 완료 + 산물 갱신. issue.startedAt=null 로 둬 reworkStartedAt 폴백을 유도한다.
    await db.update(issues).set({
      status: "done",
      startedAt: null,
      completedAt: issueCompletedAt,
    }).where(eq(issues.id, issueId));
    await db.update(issueWorkProducts).set({ updatedAt: workProductUpdatedAt })
      .where(eq(issueWorkProducts.issueId, issueId));

    await syncWorkflowRunState(db, seeded.runId);

    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, producerRun.id)).then((rows) => rows[0]!);
    expect(reloaded.status).toBe("completed");
    // 핵심: startedAt 이 완료 시각(now)이 아니라 rework 계약 createdAt 이다.
    expect(reloaded.startedAt?.toISOString()).toBe(reworkStartedAt.toISOString());
    // 그래서 현 시도 산물(updatedAt)이 startedAt 보다 뒤 → IF 신선도 검사 통과 조건.
    expect(workProductUpdatedAt.getTime()).toBeGreaterThanOrEqual(reloaded.startedAt!.getTime());
  });

  it("Fix2: resume 이 failed control node(IF) 를 pending 리셋 후 재평가해 복구한다", async () => {
    const seeded = await seedRun("invalid-json");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    expect(ifRun.status).toBe("failed");
    expect(seeded.result?.status).toBe("failed");

    // 원인(잘못된 JSON) 수정 + 산물 갱신해 IF 신선도/파싱이 통과하게 한다.
    await writeFile(seeded.artifactPath, JSON.stringify({ status: "selected" }), "utf8");
    const producerIssueId = seeded.stepRuns.find((r) => r.stepId === "producer")!.issueId!;
    await db.update(issueWorkProducts).set({ updatedAt: new Date() })
      .where(eq(issueWorkProducts.issueId, producerIssueId));

    const result = await workflowService.resumeRun(db, { runId: seeded.runId, companyId: seeded.companyId });

    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, ifRun.id)).then((rows) => rows[0]!);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.metadata).toMatchObject({ controlNodeResult: { nodeType: "if", outcome: "condition_true" } });
    expect(reloaded.lastDispatchErrorSummary).toBeNull();
    expect(result.status).not.toBe("failed");
  });

  it("Fix3: resume 은 소스 산물이 verdict 보다 새로워진 완료된 IF 를 stale 리셋 후 재평가한다 (skip 스티키 해소)", async () => {
    const seeded = await seedRun("empty");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    expect(ifRun.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_false" } });
    expect(seeded.result?.status).toBe("completed");
    const selectedRun = seeded.stepRuns.find((row) => row.stepId === "selected-work")!;
    expect(selectedRun.status).toBe("skipped");

    // run9 시나리오: producer 증거가 수정되어 재등록된다(verdict 평가 시점보다 새로움).
    await writeFile(seeded.artifactPath, JSON.stringify({ status: "selected" }), "utf8");
    const producerIssueId = seeded.stepRuns.find((r) => r.stepId === "producer")!.issueId!;
    await db.update(issueWorkProducts).set({ updatedAt: new Date() })
      .where(eq(issueWorkProducts.issueId, producerIssueId));

    const result = await workflowService.resumeRun(db, { runId: seeded.runId, companyId: seeded.companyId });

    // resume 1회차에 stale IF 가 재평가된다. skip 부활·launch 는 기존 엔진 계약대로 다음
    // resume/sync 패스에서 진행된다(런8 표준 복구 절차: resume 은 한 레벨씩 반복).
    await workflowService.resumeRun(db, { runId: seeded.runId, companyId: seeded.companyId });

    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.workflowRunId, seeded.runId));
    const reloadedIf = reloaded.find((row) => row.stepId === "if-decision")!;
    expect(reloadedIf.status).toBe("completed");
    expect(reloadedIf.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_true" } });
    const reloadedSelected = reloaded.find((row) => row.stepId === "selected-work")!;
    expect(["pending", "running", "completed"]).toContain(reloadedSelected.status);
    expect(result.status).not.toBe("failed");
  });

  it("Fix3b: resume 은 신선한 완료된 IF verdict 를 건드리지 않는다 (무의미한 재평가 금지)", async () => {
    const seeded = await seedRun("empty");
    const ifRun = seeded.stepRuns.find((row) => row.stepId === "if-decision")!;
    const completedBefore = ifRun.completedAt;
    expect(completedBefore).not.toBeNull();

    await workflowService.resumeRun(db, { runId: seeded.runId, companyId: seeded.companyId });

    const reloaded = await db.select().from(workflowStepRuns)
      .where(eq(workflowStepRuns.id, ifRun.id)).then((rows) => rows[0]!);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_false" } });
    expect(reloaded.completedAt?.getTime()).toBe(completedBefore!.getTime());
  });

  it("P1 anti-fabrication: tool_json 이 스토리지 실측 현실을 게이트에 강제한다 (가짜 results 차단)", async () => {
    // Storage webhook 대역: 스토리지의 실제 객체 수를 응답한다(에이전트가 쓸 수 없는 기계 진실).
    let storageCount = 0;
    const server: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result: { ok: true, count: storageCount, total_bytes: storageCount * 2400 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Anti Fabrication Co",
        issuePrefix: `AF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Clip Runner",
        role: "researcher",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const secret = await secretService(db).create(companyId, {
        name: `webhook-key-${companyId}`,
        provider: "local_encrypted",
        value: "test-webhook-key",
      });
      await db.insert(toolDefinitions).values({
        id: randomUUID(),
        companyId,
        name: "shorts-storage-list",
        description: "storage object counter (test stand-in)",
        adapterType: "http",
        adapterConfig: {
          url: `http://127.0.0.1:${port}/webhook/shorts-storage`,
          method: "POST",
          allowInsecureUrl: true,
          timeoutMs: 5000,
          auth: { type: "header", headerName: "X-Papercompany-Webhook-Key", secretId: secret.id, version: "latest" },
          response: { resultField: "result", assertions: [{ field: "ok", equals: true }] },
        },
        enabled: true,
      });
      const definition = await workflowService.createDefinition(db, {
        companyId,
        name: "Anti fabrication gate",
        steps: [
          { id: "producer", name: "Clip producer", agentId, dependencies: [], graphWorkProductRequired: true },
          {
            id: "clips-gate",
            name: "Clips gate",
            type: "if",
            dependencies: ["producer"],
            conditionGroup: {
              combinator: "all",
              conditions: [
                {
                  source: { kind: "work_product_json", stepId: "producer", title: "clips-result.v1.json", path: "$.status" },
                  dataType: "string",
                  operator: "equals",
                  rightValue: "ok",
                },
                {
                  source: {
                    kind: "tool_json",
                    stepId: "producer",
                    toolName: "shorts-storage-list",
                    parameters: { action: "list", prefix: "shorts/runs/run9/clips/" },
                    path: "$.count",
                  },
                  dataType: "number",
                  operator: "greater_than",
                  rightValue: 0,
                },
              ],
            },
          },
          { id: "publish-work", name: "Publish", agentId, dependencies: [], conditionalDependencies: [{ stepId: "clips-gate", when: "condition_true" }] },
          {
            id: "complete-blocked",
            name: "Blocked",
            type: "complete",
            dependencies: [],
            conditionalDependencies: [{ stepId: "clips-gate", when: "condition_false" }],
            completionReason: "Storage objects missing",
          },
        ] as never,
      });
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId: definition.id,
        companyId,
        triggeredBy: "board",
        status: "pending",
        runDate: "2026-07-20",
      });

      await executeWorkflowRun(db, runId);
      const producerRunRow = (await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, runId)))
        .find((row) => row.stepId === "producer")!;
      await issueService(db).update(producerRunRow.issueId!, { status: "in_progress" });
      await syncWorkflowRunForIssue(db, producerRunRow.issueId!);

      // 에이전트가 스토리지에 실물 없이 "22 clips ok" results JSON 을 등록(위조 시나리오).
      const fabricatedPath = path.join(artifactRoot, `${runId}-fabricated.json`);
      await writeFile(fabricatedPath, JSON.stringify({ status: "ok", clip_count: 22 }), "utf8");
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: producerRunRow.issueId!,
        type: "file",
        provider: "local",
        externalId: fabricatedPath,
        title: "clips-result.v1.json",
        status: "active",
        isPrimary: true,
        metadata: { path: fabricatedPath },
      });
      await issueService(db).update(producerRunRow.issueId!, { status: "done" });
      await syncWorkflowRunForIssue(db, producerRunRow.issueId!);

      const stepRunsAfterFabrication = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
      const gateRun = stepRunsAfterFabrication.find((row) => row.stepId === "clips-gate")!;
      // work_product 조건은 ok 통과지만 스토리지 실측 count=0 → 게이트는 반드시 false.
      expect(gateRun.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_false" } });
      expect(stepRunsAfterFabrication.find((row) => row.stepId === "publish-work")!.status).toBe("skipped");

      // 복구: 스토리지에 실물 22개 생성 + 실제 증거 재등록(더 새로운 updatedAt) → resume 재평가.
      storageCount = 22;
      const realPath = path.join(artifactRoot, `${runId}-real.json`);
      await writeFile(realPath, JSON.stringify({ status: "ok", clip_count: 22 }), "utf8");
      await db.update(issueWorkProducts).set({
        externalId: realPath,
        metadata: { path: realPath },
        updatedAt: new Date(),
      }).where(eq(issueWorkProducts.issueId, producerRunRow.issueId!));

      const result = await workflowService.resumeRun(db, { runId, companyId });
      // resume 1회차에 stale gate 가 재평가된다(아래에서 검증). 실제 publish 분기 부활은
      // 다음 resume/sync 패스(표준 복구 절차)에서 진행된다.
      await workflowService.resumeRun(db, { runId, companyId });

      const reloaded = await db.select().from(workflowStepRuns)
        .where(eq(workflowStepRuns.workflowRunId, runId));
      const reloadedGate = reloaded.find((row) => row.stepId === "clips-gate")!;
      expect(reloadedGate.status).toBe("completed");
      expect(reloadedGate.metadata).toMatchObject({ controlNodeResult: { outcome: "condition_true" } });
      const publishRun = reloaded.find((row) => row.stepId === "publish-work")!;
      expect(["pending", "running", "completed"]).toContain(publishRun.status);
      expect(result.status).not.toBe("failed");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
