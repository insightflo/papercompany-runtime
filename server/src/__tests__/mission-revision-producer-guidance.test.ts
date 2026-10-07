import { randomUUID } from "node:crypto";
import { agents, companies, createDb, missions, workflowDefinitions, workflowRuns } from "@paperclipai/db";
import { missionRevisionDeltaSchema } from "@paperclipai/shared/validators/mission-revision";
import { missionOwnerPlanDecisionSubmitSchema } from "@paperclipai/shared/validators/workflow-agent-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRevisionMissionPlanningDescription } from "../services/missions/mission-revision-planning.js";
import { validateRevisionPlanDelta } from "../services/missions/revision-plan-delta.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// These are server-rendered producer artifacts, not source-file text or agent output.
function jsonExamples(description: string): Record<string, unknown>[] {
  return [...description.matchAll(/```json\s*\n([\s\S]*?)\n```/g)]
    .map(match => JSON.parse(match[1]!) as unknown)
    .filter(isRecord);
}

function decisionExample(description: string): Record<string, unknown> {
  const example = jsonExamples(description).find(value => isRecord(value.decision));
  expect(example, "planner must expose its structured decision submission shape").toBeDefined();
  if (!example || !isRecord(example.decision)) throw new Error("Missing decision example");
  return example.decision;
}

function deltaExamples(description: string): Record<string, unknown>[] {
  return jsonExamples(description).flatMap(example => {
    const decision = isRecord(example.decision) ? example.decision : example;
    return isRecord(decision.revisionDelta) ? [decision.revisionDelta] : [];
  });
}

describe("revision planner optional delta producer contract", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let sourceMissionId: string;
  let revisionMissionId: string;
  let sourceRunId: string;
  let currentDefinitionId: string;
  let revisionDescription: string;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("revision-producer-guidance-");
    db = createDb(temp.connectionString);
    companyId = randomUUID();
    const ownerAgentId = randomUUID();
    sourceMissionId = randomUUID();
    revisionMissionId = randomUUID();
    currentDefinitionId = randomUUID();
    sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Producer contract", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator", adapterType: "process" });
    await db.insert(missions).values({ id: sourceMissionId, companyId, ownerAgentId, title: "Source" });
    await db.insert(workflowDefinitions).values({ id: currentDefinitionId, companyId, name: "Template", stepsJson: [] });
    await db.insert(workflowRuns).values({ id: sourceRunId, companyId, missionId: sourceMissionId,
      workflowId: currentDefinitionId, triggeredBy: "manual" });
    await db.insert(missions).values({ id: revisionMissionId, companyId, ownerAgentId, title: "Revision",
      sourceMissionId, sourceWorkflowRunId: sourceRunId });
    revisionDescription = await buildRevisionMissionPlanningDescription(db, { companyId, missionId: revisionMissionId,
      title: "Revision", description: null, runnableRosterLines: [] });
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await temp?.cleanup();
  });

  it("teaches an optional top-level revisionDelta using the existing v1 fields and operations", () => {
    // Break caught: the actual revision producer omits delta teaching or teaches a different contract.
    expect(/(?:optional[^\n]*revisionDelta|revisionDelta[^\n]*optional)/i.test(revisionDescription),
      "revision planner must say revisionDelta is optional").toBe(true);
    expect(revisionDescription.includes("mission-revision-delta.v1"), "planner must name the existing version").toBe(true);
    expect(/(?:top[- ]level[^\n]*revisionDelta|revisionDelta[^\n]*top[- ]level)/i.test(revisionDescription),
      "delta belongs on the decision, not inside selectedExecutionUnits").toBe(true);
    const fields = ["schemaVersion", "sourceWorkflowRunId", "workflowDefinitionId", "snapshotHash", "units", "unitId",
      "operation", "sourceStepId", "templateStepId", "instructions", "interpretedInputs", "requiredInputs",
      "fromUnitId", "selector", "capabilityRequirements", "requiredOutcomeId", "toolName", "capability"];
    expect(fields.filter(field => !revisionDescription.includes(field)), "missing existing delta contract fields").toEqual([]);
    const operations = ["reuse", "rerun", "modify", "add", "clone", "blocked"];
    expect(operations.filter(operation => !new RegExp(`\\b${operation}\\b`).test(revisionDescription)),
      "planner must teach the existing operation vocabulary").toEqual([]);
  });

  it("exposes a top-level delta example accepted by the existing schema once real base provenance is supplied", () => {
    // Break caught: planner teaches id instead of unitId, a new version/operation, or a fabricated base.
    const examples = deltaExamples(revisionDescription);
    expect(examples.length, "revision prompt must expose an optional top-level revisionDelta declaration shape")
      .toBeGreaterThan(0);
    for (const example of examples) {
      expect(example.schemaVersion).toBe("mission-revision-delta.v1");
      expect(example.sourceWorkflowRunId).toBe(sourceRunId);
      if (!isRecord(example.base)) throw new Error("Delta example must declare base provenance");
      expect(example.base).toEqual(expect.objectContaining({
        workflowDefinitionId: expect.any(String), snapshotHash: expect.any(String),
      }));
      // No current template selection/hash was supplied to this producer. Use placeholders, not invented evidence.
      expect(example.base.workflowDefinitionId).not.toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      expect(example.base.snapshotHash).not.toMatch(/^[0-9a-f]{64}$/);
      const filled = { ...example, base: { ...example.base,
        workflowDefinitionId: currentDefinitionId, snapshotHash: "a".repeat(64) } };
      const parsed = missionRevisionDeltaSchema.safeParse(filled);
      expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
      // This only validates documentation shape; it never submits or authorizes a fabricated delta.
    }
  });

  it("keeps the ordinary planner decision shape free of revisionDelta", async () => {
    const description = await buildRevisionMissionPlanningDescription(db, { companyId, missionId: sourceMissionId,
      title: "Source", description: null, runnableRosterLines: [] });
    const decision = decisionExample(description);
    expect(Object.hasOwn(decision, "revisionDelta")).toBe(false);
    expect(deltaExamples(description)).toEqual([]);
    expect(missionOwnerPlanDecisionSubmitSchema.safeParse({ decision }).success).toBe(true);
  });

  it("continues accepting a legacy revision decision with no delta", async () => {
    const decision = decisionExample(revisionDescription);
    delete decision.revisionDelta;
    const units = Array.isArray(decision.selectedExecutionUnits) ? decision.selectedExecutionUnits.filter(isRecord) : [];
    expect(units.length).toBeGreaterThan(0);
    expect(missionOwnerPlanDecisionSubmitSchema.safeParse({ decision }).success).toBe(true);
    expect(await validateRevisionPlanDelta({ db, companyId, missionSourceWorkflowRunId: sourceRunId,
      decision, selectedExecutionUnits: units, tools: [] })).toEqual({ ok: true, delta: null });
  });
});
