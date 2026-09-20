import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  instanceSettings,
  issueWorkProducts,
  workflowStepOutputBindings,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupTerminalBoundaryTables, seedBoundaryWorld, type BoundaryWorld } from "./helpers/run-terminal-boundary-fixture.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping workflow tool-arg binding tests: ${support.reason ?? "unsupported host"}`);
}

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let world: BoundaryWorld;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("workflow-tool-arg-binding-");
  db = createDb(tempDb.connectionString);
  world = await seedBoundaryWorld(db, { runStatus: "running" });
});

afterEach(async () => {
  await db.delete(workflowStepOutputBindings);
  await db.delete(issueWorkProducts);
  await db.delete(instanceSettings);
  await cleanupTerminalBoundaryTables(db);
  world = await seedBoundaryWorld(db, { runStatus: "running" });
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

async function setBindingFlag(enabled: boolean) {
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental: { enableWorkProductBindingV1: enabled },
  }).onConflictDoUpdate({
    target: instanceSettings.singletonKey,
    set: { experimental: { enableWorkProductBindingV1: enabled } },
  });
}

async function seedProducerOutputs() {
  const [oldPrimary] = await db.insert(issueWorkProducts).values({
    companyId: world.companyId,
    issueId: world.stepIssueId,
    type: "artifact",
    provider: "local_file",
    title: "Revision A",
    status: "active",
    isPrimary: true,
    metadata: { path: `/tmp/${randomUUID()}.txt` },
  }).returning({ id: issueWorkProducts.id });
  const [newPrimary] = await db.insert(issueWorkProducts).values({
    companyId: world.companyId,
    issueId: world.stepIssueId,
    type: "artifact",
    provider: "local_file",
    title: "Revision B",
    status: "active",
    isPrimary: false,
    metadata: { path: `/tmp/${randomUUID()}.txt` },
  }).returning({ id: issueWorkProducts.id });
  return { oldPrimary: oldPrimary!, newPrimary: newPrimary! };
}

async function seedConsumerStepRun() {
  await db.insert(workflowStepRuns).values({
    workflowRunId: world.runId,
    stepId: "producer",
    status: "completed",
    issueId: world.stepIssueId,
    metadata: {},
  });
  const [stepRun] = await db.insert(workflowStepRuns).values({
    workflowRunId: world.runId,
    stepId: "tool",
    status: "pending",
    issueId: world.stepIssueId,
    metadata: {},
  }).returning({ id: workflowStepRuns.id });
  return stepRun!;
}

function toolInput(stepRunId: string | null) {
  return {
    db,
    run: { id: world.runId, companyId: world.companyId, runDate: new Date().toISOString(), metadata: {} },
    step: {
      id: "tool",
      type: "tool",
      dependencies: ["producer"],
      workProducts: ["producer"],
      toolNames: ["t"],
      toolArgs: { input: "{$steps.producer.workProductPath}" },
    },
    workflowSteps: [
      { id: "producer", type: "tool", dependencies: [] },
      { id: "tool", type: "tool", dependencies: ["producer"] },
    ],
    consumerStepRunId: stepRunId,
  };
}

async function bindings() {
  return db.select().from(workflowStepOutputBindings);
}

describeEP("workflow tool arg output binding", () => {
  it("keeps legacy resolution and writes no pins when disabled", async () => {
    const { oldPrimary } = await seedProducerOutputs();
    const consumer = await seedConsumerStepRun();
    const result = await resolveWorkflowToolStepArgs(toolInput(consumer.id));

    expect(result).toEqual({ input: expect.stringMatching(/\.txt$/) });
    expect(await bindings()).toHaveLength(0);
  });

  it("pins the first primary and keeps it after promotion changes", async () => {
    const { oldPrimary, newPrimary } = await seedProducerOutputs();
    const consumer = await seedConsumerStepRun();
    await setBindingFlag(true);

    const first = await resolveWorkflowToolStepArgs(toolInput(consumer.id));
    expect(first).toEqual({ input: expect.stringMatching(/\.txt$/) });
    expect(await bindings()).toHaveLength(1);
    const oldPath = (first as { input: string }).input;

    await db.update(issueWorkProducts).set({ isPrimary: false }).where(eq(issueWorkProducts.id, oldPrimary.id));
    await db.update(issueWorkProducts).set({
      isPrimary: true,
      updatedAt: new Date(Date.now() + 1_000),
    }).where(eq(issueWorkProducts.id, newPrimary.id));

    const second = await resolveWorkflowToolStepArgs(toolInput(consumer.id));
    expect(second).toEqual({ input: oldPath });
    expect(await bindings()).toHaveLength(1);
  });

  it("a dangling pin (force-delete bypassing FK cascade) fails closed with the identifiable error", async () => {
    const { oldPrimary, newPrimary: newer } = await seedProducerOutputs();
    const consumer = await seedConsumerStepRun();
    await setBindingFlag(true);
    await resolveWorkflowToolStepArgs(toolInput(consumer.id));

    // session_replication_role=replica 는 FK cascade 트리거까지 끈다 — 바인딩이 남은 채
    //   산출물만 강제 삭제된 dangling 핀 상태. 이 유일한 소실 경로는 조용한 재해석이
    //   아니라 식별 오류로 실패해야 한다(정상 삭제는 cascade 로 바인딩도 사라진다 —
    //   workflow-output-binding.test.ts 의 cascade 케이스 참조).
    await db.execute("SET session_replication_role = replica");
    await db.delete(issueWorkProducts).where(eq(issueWorkProducts.id, oldPrimary.id));
    await db.execute("SET session_replication_role = origin");

    await expect(resolveWorkflowToolStepArgs(toolInput(consumer.id)))
      .rejects.toThrow(`workproduct_binding_target_missing: producer → ${oldPrimary.id}`);
    // newer 는 건드리지 않았지만 이 참조의 해석은 이미 핀으로 고정 — 재해석 없음.
    expect(newer).toBeDefined();
  });
});
