import "./helpers/workflow-control-node-boundary.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, issueWorkProducts,
  workflowDefinitions, workflowRunDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { createWorkflowDefinition, createWorkflowRun, updateWorkflowDefinition } from "../services/workflow/workflow-store.js";
import { resolveWorkflowToolStepArgs } from "../services/workflow/tool-step-args.js";
import { seedInterpretedInputUsage } from "../services/workflow/seed-interpreted-inputs.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { findOrCreateImmutableQualityWorkflowDefinition } from "../services/quality/native-definition.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("workflow tool reference write/runtime boundaries", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-reference-boundaries-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(workflowStepRuns);
    await db.delete(workflowRuns);
    await db.delete(workflowDefinitions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function world(): Promise<WorkflowStep[]> {
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "References", issuePrefix: "REF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Producer" });
    return [
      { id: "select-novel-concept", name: "Select", agentId, dependencies: [] },
      { id: "if-has-selected-topic", name: "IF", type: "if", agentId: "", dependencies: ["select-novel-concept"],
        conditionGroup: { combinator: "all", conditions: [{
          source: { kind: "work_product_json", stepId: "select-novel-concept", title: "topic.json", path: "$.selected" },
          dataType: "string", operator: "equals", rightValue: "yes",
        }] } },
      { id: "publish", name: "Publish", agentId, dependsOn: [], dependencies: [],
        conditionalDependencies: [{ stepId: "if-has-selected-topic", when: "condition_true" as const }],
        toolArgs: { file: "{$steps.select-novel-concept.workProductPath}" } },
      { id: "no-topic", name: "No topic", type: "complete", agentId: "", dependencies: [],
        conditionalDependencies: [{ stepId: "if-has-selected-topic", when: "condition_false" as const }] },
    ];
  }

  const apiSteps = <T extends { agentId?: string }>(steps: T[]) => steps.map(s => ({ ...s, agentId: s.agentId || undefined }));

  function app() {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", workflowRoutes(db)); app.use(errorHandler);
    return app;
  }

  it.each(["condition_true", "condition_false"] as const)("renders all artifact tokens through %s IF links", async (when) => {
    const steps = await world();
    const consumer = { ...steps[2]!, conditionalDependencies: [{ stepId: "if-has-selected-topic", when }], toolArgs: {
      file: "{$steps.select-novel-concept.workProductPath}",
      dir: "{$steps.select-novel-concept.workProductDir}", assets: "{$steps.select-novel-concept.siblingAssetsDir}",
    } };
    steps[2] = consumer;
    const definition = await createWorkflowDefinition(db, { companyId, name: "radar", steps });
    const [run] = await db.insert(workflowRuns).values({ companyId, workflowId: definition.id, triggeredBy: "board" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Topic" }).returning();
    await db.insert(workflowStepRuns).values({ workflowRunId: run!.id, stepId: steps[0]!.id, issueId: issue!.id, status: "completed" });
    await db.insert(issueWorkProducts).values({ companyId, issueId: issue!.id, title: "topic.json", type: "document",
      provider: "local_file", status: "active", metadata: { path: "/tmp/concept-radar/topic.json" } });
    expect([...seedInterpretedInputUsage(steps[2]!).refs]).toEqual(["select-novel-concept"]);
    expect(await resolveWorkflowToolStepArgs({ db, run: run!, step: steps[2]!, workflowSteps: steps }))
      .toEqual({ file: "/tmp/concept-radar/topic.json", dir: "/tmp/concept-radar", assets: "/tmp/concept-radar/assets" });
  });

  it.each([
    ["post", "missing", "unknown_step"], ["patch", "missing", "unknown_step"],
    ["post", "no-topic", "not_ancestor"], ["patch", "no-topic", "not_ancestor"],
  ] as const)("returns HTTP 422 on %s for %s (%s) without writing steps", async (method, reference, reason) => {
    const steps = await world();
    const definition = await createWorkflowDefinition(db, { companyId, name: "radar", steps });
    const badSteps = steps.map(s => s.id === "publish" ? { ...s, toolArgs: {
      files: [`{$steps.${reference}.workProductPath}`],
    } } : s);
    const url = method === "post" ? `/api/companies/${companyId}/workflows` : `/api/workflows/${definition.id}`;
    const res = await request(app())[method](url).send({ name: "invalid", steps: apiSteps(badSteps) });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("publish");
    expect(res.body.details).toEqual({ code: "workflow_tool_reference_invalid", errors: [
      { stepId: "publish", referencedStepId: reference, reason },
    ] });
    const stored = await db.select({ id: workflowDefinitions.id, steps: workflowDefinitions.stepsJson }).from(workflowDefinitions);
    expect(stored).toEqual([{ id: definition.id, steps }]);
  });

  it("accepts POST and PATCH with forward branch references and no extra dependsOn", async () => {
    const steps = await world();
    const created = await request(app()).post(`/api/companies/${companyId}/workflows`).send({ name: "radar", steps: apiSteps(steps) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const updated = await request(app()).patch(`/api/workflows/${created.body.id}`).send({ steps: apiSteps(steps) });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.steps.find((s: { id: string }) => s.id === "publish").dependencies).toEqual([]);
  });

  it("protects direct store create/update as well as normalized HTTP writes", async () => {
    const steps = await world();
    const definition = await createWorkflowDefinition(db, { companyId, name: "radar", steps });
    const invalid = [{ id: "bad", name: "Bad", agentId, dependencies: [], toolArgs: { file: "{$steps.bad.workProductPath}" } }];
    for (const save of [() => createWorkflowDefinition(db, { companyId, name: "bad", steps: invalid }),
      () => updateWorkflowDefinition(db, definition.id, { steps: invalid })]) {
      await expect(save()).rejects.toMatchObject({ status: 422, details: { errors: [
        { stepId: "bad", referencedStepId: "bad", reason: "not_ancestor" },
      ] } });
    }
    await expect(findOrCreateImmutableQualityWorkflowDefinition(db, { companyId, missionId: randomUUID(), steps: invalid }))
      .rejects.toMatchObject({ status: 422 });
    const [stored] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, definition.id));
    expect(stored!.stepsJson).toEqual(steps);
    expect(await db.select({ id: workflowDefinitions.id }).from(workflowDefinitions)).toEqual([{ id: definition.id }]);
  });

  it("leaves legacy invalid references alone on metadata PATCH and snapshot capture/read", async () => {
    await world();
    const id = randomUUID();
    const legacySteps = [{ id: "consumer", name: "Consumer", agentId, dependencies: [], graphWorkProductRequired: false,
      toolArgs: { file: "{$steps.missing.workProductPath}" } }];
    await db.insert(workflowDefinitions).values({ id, companyId, name: "legacy", stepsJson: legacySteps });
    const run = await createWorkflowRun(db, { workflowId: id, companyId, triggeredBy: "board" });
    const snapshots = () => db.select().from(workflowRunDefinitions).where(eq(workflowRunDefinitions.workflowRunId, run.id));
    const before = await snapshots();
    expect(before).toHaveLength(1);
    expect(before[0]!.steps).toEqual(legacySteps);
    const response = await request(app()).patch(`/api/workflows/${id}`).send({ description: "Metadata only" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.steps).toEqual(legacySteps);
    // A valid replacement edits the definition only; the existing snapshot stays historical.
    expect((await request(app()).patch(`/api/workflows/${id}`).send({ steps: apiSteps(legacySteps.map(({ toolArgs, ...s }) => s)) })).status).toBe(200);
    const loaded = await loadExecutionDefinition(db, run.id, { requireHistorical: true });
    expect(loaded.source).toBe("snapshot");
    expect(loaded.steps).toEqual(legacySteps);
    expect(await snapshots()).toEqual(before);
  });
});
