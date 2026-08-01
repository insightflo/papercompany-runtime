import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentToolGrants, agents, companies, createDb, toolDefinitions,
  workflowDefinitions, workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";
import { executeWorkflowRun, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";
import { STRUCTURAL_VALIDATION_CAPABILITY } from "../services/workflow/control-flow/structural-gate-readiness.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping readiness enforcement tests: ${support.reason ?? "unsupported"}`);
}

// [ purpose ] Structural gates fail closed at the direct workflow entry points
//   (createDefinition — also used by updateDefinition/trigger/resumeRun via the
//   shared assertWorkflowToolReadiness) and at persisted runtime execution
//   (executeWorkflowRun). Ordinary tool/agent steps are unaffected.
describeEP("hybrid QA — structural gate readiness enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-readiness-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Readiness Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Producer Agent", role: "engineer",
      status: "active", adapterType: "process", adapterConfig: {},
    });
    // executeWorkflowRun/createDefinition require a configured tool executor.
    setWorkflowToolStepExecutor(() => Promise.resolve({ accepted: true }));
  }, 60_000);

  afterEach(async () => {
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
  });
  afterAll(async () => {
    setWorkflowToolStepExecutor(null);
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  async function seedTool(opts: { name: string; capabilities?: string[]; enabled?: boolean; grant?: boolean }) {
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId, companyId, name: opts.name, description: "",
      adapterType: "builtin",
      adapterConfig: { capabilities: opts.capabilities ?? [] },
      enabled: opts.enabled ?? true,
    });
    if (opts.grant) {
      await db.insert(agentToolGrants).values({ id: randomUUID(), companyId, agentId, toolId, grantedBy: "test" });
    }
  }

  const gateStep = (toolName: string) => ({
    id: "gate-1", name: "[QA] Structural gate", agentId: "",
    type: "tool", qaType: "structural", toolNames: [toolName], assigneeAgentId: agentId,
    dependencies: ["producer-1"], graphWorkProductRequired: false,
  });
  const producerStep = () => ({
    id: "producer-1", name: "[ACTION] Produce", agentId,
    dependencies: [], graphWorkProductRequired: true,
  });

  it("createDefinition accepts a ready structural gate", async () => {
    await seedTool({ name: "ready-a", capabilities: [STRUCTURAL_VALIDATION_CAPABILITY], grant: true });
    const def = await workflowService.createDefinition(db, {
      companyId, name: `ready-wf-${randomUUID()}`,
      steps: [producerStep(), gateStep("ready-a")],
    });
    expect(def.id).toBeTruthy();
  });

  it("createDefinition is unaffected by ordinary (non-gate) steps", async () => {
    const def = await workflowService.createDefinition(db, {
      companyId, name: `plain-wf-${randomUUID()}`,
      steps: [producerStep()],
    });
    expect(def.id).toBeTruthy();
  });

  it("createDefinition rejects a gate whose tool lacks the capability", async () => {
    await seedTool({ name: "no-cap-a", capabilities: [], grant: true });
    // Fail-closed: the create must be rejected (any rejected error), not gated
    // on a specific error-message phrase.
    await expect(workflowService.createDefinition(db, {
      companyId, name: `nocap-wf-${randomUUID()}`,
      steps: [producerStep(), gateStep("no-cap-a")],
    })).rejects.toThrow();
  });

  it("createDefinition rejects a gate whose assignee lacks a grant", async () => {
    await seedTool({ name: "no-grant-a", capabilities: [STRUCTURAL_VALIDATION_CAPABILITY], grant: false });
    await expect(workflowService.createDefinition(db, {
      companyId, name: `nogrant-wf-${randomUUID()}`,
      steps: [producerStep(), gateStep("no-grant-a")],
    })).rejects.toThrow();
  });

  it("executeWorkflowRun fails closed on a persisted unregistered gate (plugin-only bypass blocked)", async () => {
    // Persist a definition+run directly, bypassing the engine create path, then
    // execute: the runtime readiness gate must reject the unregistered tool.
    const wfId = randomUUID();
    const runId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: wfId, companyId, name: `runtime-wf-${randomUUID()}`,
      stepsJson: [producerStep(), gateStep("plugin-only-ghost-tool")],
    });
    await db.insert(workflowRuns).values({
      id: runId, companyId, workflowId: wfId, triggeredBy: "test",
    });
    await expect(executeWorkflowRun(db, runId)).rejects.toThrow();
  });
});
