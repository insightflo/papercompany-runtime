import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attemptFullSettlement } from "../services/heartbeat-finalization/settlement.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip dispatch-ready tests: ${support.reason ?? "unsupported"}`);

describeEP("dispatch_ready_at set on settle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let workflowRunId: string;
  let stepRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dispatch-ready-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    workflowRunId = randomUUID();
    stepRunId = randomUUID();
    const workflowDefId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "DispatchCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Dispatch agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(workflowDefinitions).values({
      id: workflowDefId, companyId, name: "Dispatch wf", stepsJson: [{ id: "step" }],
    });
    await db.insert(workflowRuns).values({
      id: workflowRunId, companyId, workflowId: workflowDefId, status: "running", triggeredBy: "test",
    });
    await db.insert(workflowStepRuns).values({
      id: stepRunId, workflowRunId, stepId: "step", status: "completed", metadata: {},
    });
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  });
  afterAll(() => { tempDb = null; });

  it("attemptFullSettlement sets dispatch_ready_at on the linked workflow_step_run", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
      finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerReleasedAt: new Date(), processPid: null,
      workflowStepRunId: stepRunId, workflowExecutionGeneration: 0,
    } as never);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const outcome = await attemptFullSettlement(db, run!, new Date());

    expect(outcome).toBe("settled");

    // settled_at set on the heartbeat run
    const settledRun = await db.select({ settledAt: heartbeatRuns.settledAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0]!);
    expect(settledRun.settledAt).not.toBeNull();

    // dispatch_ready_at set on the linked workflow step run
    const stepRun = await db.select({ dispatchReadyAt: workflowStepRuns.dispatchReadyAt }).from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).then((r) => r[0]!);
    expect(stepRun.dispatchReadyAt).not.toBeNull();
  });

  it("dispatch_ready_at is idempotent — second settle does not change it", async () => {
    const runId = randomUUID();
    const now1 = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded",
      finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerReleasedAt: new Date(), processPid: null,
      workflowStepRunId: stepRunId, workflowExecutionGeneration: 0,
    } as never);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    await attemptFullSettlement(db, run!, now1);

    const after1 = await db.select({ dispatchReadyAt: workflowStepRuns.dispatchReadyAt }).from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).then((r) => r[0]!);
    expect(after1.dispatchReadyAt).not.toBeNull();

    // Second settle attempt — dispatch_ready_at must not change
    const now2 = new Date(now1.getTime() + 60000);
    const outcome2 = await attemptFullSettlement(db, run!, now2);
    expect(outcome2).toBe("not_ready"); // already settled

    const after2 = await db.select({ dispatchReadyAt: workflowStepRuns.dispatchReadyAt }).from(workflowStepRuns).where(eq(workflowStepRuns.id, stepRunId)).then((r) => r[0]!);
    expect(after2.dispatchReadyAt).toEqual(after1.dispatchReadyAt);
  });
});
