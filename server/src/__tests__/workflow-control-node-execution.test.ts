import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
