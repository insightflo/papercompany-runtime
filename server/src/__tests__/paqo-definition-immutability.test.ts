import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, workflowRuns } from "@paperclipai/db";
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
    `Skipping embedded Postgres PAQO immutability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// [Stage 4] Immutable PAQO definition lifecycle — creation, idempotent reuse,
// and revision splitting on content change.
describeEmbeddedPostgres("PAQO workflow definition immutability (Stage 4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-paqo-immutability-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await cleanupPaqoImmutabilityTables(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates an immutable hashed definition on first materialization", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Immutable first");
    const decision = buildPaqoDecision(fixture, "Immutable first", ["Research A", "Synthesize B"]);
    const result = await materializePaqoPlan(db, { ...fixture, decision });
    expect(result.status).toBe("recorded");

    const defs = await paqoDefinitionsFor(db, fixture.companyId);
    expect(defs).toHaveLength(1);
    const def = defs[0]!;
    expect(def.missionId).toBe(fixture.missionId);
    expect(def.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.name).toBe("PAQO WBS: Immutable first");
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, def.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.missionId).toBe(fixture.missionId);
  });

  it("re-materializing the same content reuses the same definition and run (idempotent)", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Idempotent reuse");
    const decision = buildPaqoDecision(fixture, "Idempotent reuse", ["Research A", "Synthesize B"]);
    await materializePaqoPlan(db, { ...fixture, decision });
    const firstDefs = await paqoDefinitionsFor(db, fixture.companyId);
    const firstRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, firstDefs[0]!.id));

    const result = await materializePaqoPlan(db, { ...fixture, decision });
    // Identical re-submission is decision-level idempotent: the ledger already
    // holds this decision hash, so the recorder reports noop and re-runs nothing.
    expect(["recorded", "noop"]).toContain(result.status);

    const defs = await paqoDefinitionsFor(db, fixture.companyId);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe(firstDefs[0]!.id);
    expect(defs[0]!.definitionHash).toBe(firstDefs[0]!.definitionHash);
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, defs[0]!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(firstRuns[0]!.id);
  });

  it("changed content creates a new definition+run and leaves the old definition rows unchanged", async () => {
    const fixture = await seedPaqoMissionFixture(db, "Revision split");
    const decisionA = buildPaqoDecision(fixture, "Revision split", ["Research A", "Synthesize B"]);
    await materializePaqoPlan(db, { ...fixture, decision: decisionA });
    const defsA = await paqoDefinitionsFor(db, fixture.companyId);
    expect(defsA).toHaveLength(1);
    const snapshotA = { ...defsA[0]!, stepsJson: JSON.parse(JSON.stringify(defsA[0]!.stepsJson)) };

    const decisionB = buildPaqoDecision(fixture, "Revision split", ["Research A", "Synthesize B", "Hardening C"]);
    const result = await materializePaqoPlan(db, { ...fixture, decision: decisionB });
    expect(result.status).toBe("recorded");

    const defs = await paqoDefinitionsFor(db, fixture.companyId);
    expect(defs).toHaveLength(2);
    const oldDef = defs.find((row) => row.id === snapshotA.id)!;
    const newDef = defs.find((row) => row.id !== snapshotA.id)!;
    expect(oldDef.stepsJson).toEqual(snapshotA.stepsJson);
    expect(oldDef.updatedAt.getTime()).toBe(snapshotA.updatedAt.getTime());
    expect(newDef.missionId).toBe(fixture.missionId);
    expect(newDef.definitionHash).not.toBe(oldDef.definitionHash);
    const oldRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, oldDef.id));
    const newRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, newDef.id));
    expect(oldRuns).toHaveLength(1);
    expect(newRuns).toHaveLength(1);
  });
});
