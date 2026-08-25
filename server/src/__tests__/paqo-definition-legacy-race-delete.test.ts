import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionPlanQaVerdicts,
  missions,
  workflowDefinitions,
  workflowRuns,
} from "@paperclipai/db";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import {
  computePaqoDefinitionHash,
  findOrCreateImmutablePaqoWorkflowDefinition,
} from "../services/workflow/paqo-definition-identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildPaqoDecision,
  cleanupPaqoImmutabilityTables,
  materializePaqoPlan,
  paqoDefinitionsFor,
  seedPaqoMissionFixture,
} from "./helpers/paqo-immutability.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PAQO legacy/race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// [Stage 4] Legacy compatibility, concurrent-insert race, and mission-delete
// semantics for immutable PAQO definitions.
describeEmbeddedPostgres("PAQO definition immutability — legacy, race, mission delete (Stage 4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-paqo-legacy-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupPaqoImmutabilityTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("leaves legacy null-hash definitions untouched and never matches them by lookup", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Legacy coexist");
    const legacyDefinitionId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: legacyDefinitionId,
      companyId: fixture.companyId,
      name: "PAQO WBS: Legacy coexist",
      source: "native",
      sourceKind: "workflow",
      stepsJson: [
        { id: "action-stale", name: "[ACTION] Stale action", agentId: fixture.ownerAgentId, dependencies: [] },
        { id: "qa-stale", name: "[QA] Verify mission result", agentId: fixture.ownerAgentId, dependencies: ["action-stale"] },
      ],
    });
    const legacyBefore = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, legacyDefinitionId)))[0]!;

    const decision = buildPaqoDecision(fixture, "Legacy coexist", ["Research A", "Synthesize B"]);
    const result = await materializePaqoPlan(db, { ...fixture, decision });
    expect(result.status).toBe("recorded");

    const legacyAfter = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, legacyDefinitionId)))[0]!;
    expect(legacyAfter.stepsJson).toEqual(legacyBefore.stepsJson);
    expect(legacyAfter.missionId).toBeNull();
    expect(legacyAfter.definitionHash).toBeNull();
    expect(legacyAfter.sourceKind).toBe("workflow");
    expect(legacyAfter.updatedAt.getTime()).toBe(legacyBefore.updatedAt.getTime());

    const hashed = await paqoDefinitionsFor(db, fixture.companyId);
    expect(hashed).toHaveLength(1);
    expect(hashed[0]!.id).not.toBe(legacyDefinitionId);
    expect(hashed[0]!.missionId).toBe(fixture.missionId);
  });

  it("concurrent duplicate inserts resolve to exactly one immutable definition", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Race guard");
    const steps = [
      { id: "action-race", name: "[ACTION] Race action", agentId: fixture.ownerAgentId, dependencies: [] },
      { id: "qa-race", name: "[QA] Verify mission result", agentId: fixture.ownerAgentId, dependencies: ["action-race"] },
    ] as never[];

    const [first, second] = await Promise.all([
      findOrCreateImmutablePaqoWorkflowDefinition(db, {
        companyId: fixture.companyId,
        missionId: fixture.missionId,
        name: "PAQO WBS: Race guard",
        steps,
      }),
      findOrCreateImmutablePaqoWorkflowDefinition(db, {
        companyId: fixture.companyId,
        missionId: fixture.missionId,
        name: "PAQO WBS: Race guard",
        steps,
      }),
    ]);
    expect(first?.id).toBe(second?.id);
    const defs = await paqoDefinitionsFor(db, fixture.companyId);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.missionId).toBe(fixture.missionId);
    expect(defs[0]!.definitionHash).toBe(computePaqoDefinitionHash(steps));
  });

  it("mission delete nulls mission_id on both new and legacy definitions and later lookups fail closed", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Delete set null");
    const legacyDefinitionId = randomUUID();
    await db.insert(workflowDefinitions).values({
      id: legacyDefinitionId,
      companyId: fixture.companyId,
      name: "PAQO WBS: Delete set null",
      source: "native",
      sourceKind: "workflow",
      missionId: fixture.missionId,
      stepsJson: [{ id: "legacy", name: "[ACTION] Legacy", agentId: fixture.ownerAgentId, dependencies: [] }],
    });
    const decision = buildPaqoDecision(fixture, "Delete set null", ["Research A"]);
    await materializePaqoPlan(db, { ...fixture, decision });
    const hashedDef = (await paqoDefinitionsFor(db, fixture.companyId))[0]!;

    await db.delete(issueComments).where(eq(issueComments.companyId, fixture.companyId));
    await db.delete(missionPlanQaVerdicts).where(eq(missionPlanQaVerdicts.companyId, fixture.companyId));
    await db.delete(missionPlanDecisionSubmissions).where(eq(missionPlanDecisionSubmissions.companyId, fixture.companyId));
    await db.delete(issues).where(eq(issues.missionId, fixture.missionId));
    await db.delete(missionPlanArtifacts).where(eq(missionPlanArtifacts.missionId, fixture.missionId));
    await db.delete(missions).where(eq(missions.id, fixture.missionId));

    const legacyRow = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, legacyDefinitionId)))[0]!;
    const hashedRow = (await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, hashedDef.id)))[0]!;
    expect(legacyRow.missionId).toBeNull();
    expect(hashedRow.missionId).toBeNull();
    expect(hashedRow.definitionHash).not.toBeNull();
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, hashedDef.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.missionId).toBeNull();

    const definitionCountBefore = (await db.select({ id: workflowDefinitions.id }).from(workflowDefinitions).where(eq(workflowDefinitions.companyId, fixture.companyId))).length;
    const runCountBefore = (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, fixture.companyId))).length;
    const result = (await recordLatestAuthorizedMissionOwnerPlanDecision({ db, companyId: fixture.companyId, missionId: fixture.missionId })) as { status: string; reason?: string };
    // Fail closed: the mission row is gone, so the recorder refuses before any
    // definition/run mutation can happen (no cross-matching on hash lookups).
    expect(result.status).toBe("invalid");
    expect(result.reason).toContain("mission_not_found");
    const definitionCountAfter = (await db.select({ id: workflowDefinitions.id }).from(workflowDefinitions).where(eq(workflowDefinitions.companyId, fixture.companyId))).length;
    const runCountAfter = (await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, fixture.companyId))).length;
    expect(definitionCountAfter).toBe(definitionCountBefore);
    expect(runCountAfter).toBe(runCountBefore);
  });
});
