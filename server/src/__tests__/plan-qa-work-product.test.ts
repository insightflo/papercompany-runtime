import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueWorkProducts,
  issues,
  missionPlanArtifacts,
  missions,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ensurePlanQaWorkProduct } from "../services/missions/plan-qa-work-product.js";
import {
  cleanupTempDirs,
  DECISION_HASH_A,
  makeTempDir,
  seedActivePlan,
} from "./plan-qa-work-product-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("PLAN-QA work product projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-qa-work-product-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(missionPlanArtifacts);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    cleanupTempDirs();
  });

  async function seedCompany(workProductRoot: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plan QA Work Product",
      workProductRoot,
      issuePrefix: `QA${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner" });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Research mission",
      status: "active",
    });
    return { companyId, ownerAgentId, missionId };
  }

  async function seedPlanQaIssue(companyId: string, missionId: string) {
    const reviewerAgentId = randomUUID();
    const planQaIssueId = randomUUID();
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Reviewer" });
    await db.insert(issues).values({
      id: planQaIssueId,
      companyId,
      missionId,
      title: "[PLAN-QA] Review",
      originKind: "mission_plan_qa",
      originId: `plan-qa:${missionId}:${DECISION_HASH_A}`,
      status: "todo",
      assigneeAgentId: reviewerAgentId,
    });
    return { planQaIssueId };
  }

  it("projects the accepted plan to a deterministic JSON path and registers one work product", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    const plan = await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    const result = await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });

    expect(result).not.toBeNull();
    const expectedPath = path.join(root, "missions", missionId, "plan-qa", DECISION_HASH_A, "plan.json");
    expect(result!.filePath).toBe(expectedPath);
    expect(result!.fileDirectory).toBe(path.dirname(expectedPath));
    expect(existsSync(expectedPath)).toBe(true);

    const projected = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(projected).toEqual({
      schemaVersion: 1,
      missionId,
      missionPlanArtifactId: plan.id,
      revision: plan.revision,
      decisionHash: DECISION_HASH_A,
      missionGoal: "Ship the research report",
      refs: {
        selectedExecutionUnits: [{ id: "unit-1", title: "Draft report", selectionState: "selected" }],
        planTemplates: { selectionSource: "explicit", items: [] },
        ownerPlanDecision: { decisionHash: DECISION_HASH_A },
        dynamicMissionPlanning: { missionInvariant: [] },
      },
      steps: [{ id: "step-1", title: "Draft" }],
      requiredInputs: [{ label: "Source data" }],
      successCriteria: [{ label: "Report passes review" }],
      risks: [{ label: "Data gap" }],
    });

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe("local_file");
    expect(rows[0]!.externalId).toBe(expectedPath);
    expect(rows[0]!.status).toBe("active");
  });

  it("is idempotent: repeated calls keep exactly one active row", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });
    await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });
    await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("ignores a non-active same-path row and creates a fresh active row", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    // Pre-create the projection file so registration validation passes, then
    // insert a superseded same-path row that must NOT count as existing.
    const expectedPath = path.join(root, "missions", missionId, "plan-qa", DECISION_HASH_A, "plan.json");
    await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });
    await db
      .update(issueWorkProducts)
      .set({ status: "superseded" })
      .where(eq(issueWorkProducts.issueId, planQaIssueId));

    await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });

    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    const activeRows = rows.filter((row) => row.status === "active");
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]!.externalId).toBe(expectedPath);
  });

  it("rejects cross-issue, cross-mission, superseded plans (isolation)", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);

    await seedActivePlan(db, companyId, missionId, ownerAgentId, randomUUID(), DECISION_HASH_A);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A, {
      status: "superseded",
      revision: 2,
    });

    const result = await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });
    expect(result).toBeNull();
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    expect(rows).toHaveLength(0);
  });

  it("rejects cross-company plans", async () => {
    const companyA = await seedCompany(makeTempDir());
    const companyB = await seedCompany(makeTempDir());
    const { planQaIssueId } = await seedPlanQaIssue(companyA.companyId, companyA.missionId);

    await seedActivePlan(
      db,
      companyB.companyId,
      companyB.missionId,
      companyB.ownerAgentId,
      planQaIssueId,
      DECISION_HASH_A,
    );

    const result = await ensurePlanQaWorkProduct({
      db,
      companyId: companyA.companyId,
      planQaIssueId,
      missionId: companyA.missionId,
    });
    expect(result).toBeNull();
  });

  it("returns null (no widening) when no workProductRoot is configured", async () => {
    const { companyId, ownerAgentId, missionId } = await seedCompany(makeTempDir());
    await db.update(companies).set({ workProductRoot: null }).where(eq(companies.id, companyId));
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    const result = await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });
    expect(result).toBeNull();
  });

  it("fails closed (throws) when the filesystem write cannot complete", async () => {
    const blocker = path.join(makeTempDir(), "blocker-file");
    writeFileSync(blocker, "x", "utf8");
    const { companyId, ownerAgentId, missionId } = await seedCompany(path.join(blocker, "produced_work"));
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, DECISION_HASH_A);

    await expect(ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId })).rejects.toThrow();
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, planQaIssueId)));
    expect(rows).toHaveLength(0);
  });

  it("rejects a path-traversal decisionHash ('..') as an explicit miss with no file or work product", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    // Active plan whose refs.planQa.decisionHash would collapse plan-qa/.. if
    // used unsanitized: <missionOutputDir>/plan-qa/../plan.json.
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, "..");

    const result = await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });

    expect(result).toBeNull();
    // The traversal target file must NOT be created anywhere under the root.
    expect(existsSync(path.join(root, "missions", missionId, "plan.json"))).toBe(false);
    expect(existsSync(path.join(root, "missions", missionId, "plan-qa"))).toBe(false);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    expect(rows).toHaveLength(0);
  });

  it("rejects a non-hex / wrong-length decisionHash as an explicit miss", async () => {
    const root = makeTempDir();
    const { companyId, ownerAgentId, missionId } = await seedCompany(root);
    const { planQaIssueId } = await seedPlanQaIssue(companyId, missionId);
    await seedActivePlan(db, companyId, missionId, ownerAgentId, planQaIssueId, "not-a-real-hash");

    const result = await ensurePlanQaWorkProduct({ db, companyId, planQaIssueId, missionId });

    expect(result).toBeNull();
    expect(existsSync(path.join(root, "missions", missionId, "plan-qa"))).toBe(false);
    const rows = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, planQaIssueId));
    expect(rows).toHaveLength(0);
  });
});
