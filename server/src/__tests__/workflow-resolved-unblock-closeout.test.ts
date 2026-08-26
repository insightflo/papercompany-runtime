import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { closeResolvedWorkflowUnblocks, } from "../services/workflow/resolved-unblock-closeout.js";
import { syncWorkflowRunState } from "../services/workflow/dag-engine.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip resolved-unblock closeout tests: ${support.reason ?? "unsupported"}`);

const ORIGIN_KIND = "mission_main_executor_unblock";
const ACTIVITY_ACTION = "mission.owner_action_settled_from_source";
type Db = ReturnType<typeof createDb>;
type Tenant = { companyId: string; ownerId: string; missionId: string };
type StepSeed = { issueId?: string; status: "completed" | "failed" | "running" };

async function seedTenant(db: Db, label: string): Promise<Tenant> {
  const companyId = randomUUID();
  const ownerId = randomUUID();
  const missionId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: `${label} company`,
    issuePrefix: `UC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: ownerId,
    companyId,
    name: `${label} owner`,
    role: "mission_owner",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  await db.insert(missions).values({
    id: missionId,
    companyId,
    ownerAgentId: ownerId,
    title: `${label} mission`,
    status: "active",
  });
  return { companyId, ownerId, missionId };
}

async function addMission(db: Db, tenant: Tenant, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(missions).values({
    id,
    companyId: tenant.companyId,
    ownerAgentId: tenant.ownerId,
    title: `${label} mission`,
    status: "active",
  });
  return id;
}

async function addIssue(
  db: Db,
  tenant: Pick<Tenant, "companyId" | "missionId">,
  title: string,
  status: string,
  extra: Partial<typeof issues.$inferInsert> = {},
): Promise<string> {
  const [row] = await db.insert(issues).values({
    companyId: tenant.companyId,
    missionId: tenant.missionId,
    title,
    status,
    ...(status === "done" ? { completedAt: new Date() } : {}),
    ...(status === "cancelled" ? { cancelledAt: new Date() } : {}),
    ...extra,
  }).returning({ id: issues.id });
  return row!.id;
}

async function addUnblock(
  db: Db,
  tenant: Pick<Tenant, "companyId" | "missionId">,
  sourceIssueId: string,
  status = "todo",
  extra: Partial<typeof issues.$inferInsert> = {},
): Promise<string> {
  return addIssue(db, tenant, `unblock ${sourceIssueId.slice(0, 6)}`, status, {
    originKind: ORIGIN_KIND,
    originId: sourceIssueId,
    ...extra,
  });
}

async function seedRun(
  db: Db,
  tenant: Tenant,
  steps: StepSeed[],
  runStatus = "running",
): Promise<string> {
  const workflowId = randomUUID();
  const runId = randomUUID();
  const definitionSteps = steps.map((_, index) => ({
    id: `step-${index}`,
    name: `Step ${index}`,
    type: "agent",
    agentId: tenant.ownerId,
    dependencies: [],
  }));
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId: tenant.companyId,
    name: `closeout-${runId}`,
    stepsJson: definitionSteps,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    workflowId,
    companyId: tenant.companyId,
    missionId: tenant.missionId,
    status: runStatus,
    triggeredBy: "test",
    startedAt: new Date(),
  });
  const now = new Date();
  await db.insert(workflowStepRuns).values(steps.map((step, index) => ({
    workflowRunId: runId,
    stepId: `step-${index}`,
    issueId: step.issueId,
    status: step.status,
    startedAt: step.status === "completed" ? null : now,
    completedAt: step.status === "running" ? null : now,
  })));
  return runId;
}

async function statuses(db: Db, ids: string[]) {
  const rows = await db.select({ id: issues.id, status: issues.status, parentId: issues.parentId })
    .from(issues).where(inArray(issues.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

describeDb("workflow resolved-unblock closeout", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workflow-unblock-closeout-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("closes every open unblock for a done current-run child source and is idempotent", async () => {
    const tenant = await seedTenant(db, "happy");
    const parentId = await addIssue(db, tenant, "parent", "done");
    const sourceId = await addIssue(db, tenant, "child source", "done", { parentId });
    const runId = await seedRun(db, tenant, [{ issueId: sourceId, status: "completed" }]);
    const openOne = await addUnblock(db, tenant, sourceId);
    const openTwo = await addUnblock(db, tenant, sourceId, "blocked");
    const alreadyDone = await addUnblock(db, tenant, sourceId, "done");
    const alreadyCancelled = await addUnblock(db, tenant, sourceId, "cancelled");
    const hidden = await addUnblock(db, tenant, sourceId, "todo", { hiddenAt: new Date() });
    const wrongKind = await addIssue(db, tenant, "oversight twin", "todo", {
      originKind: "mission_main_executor_oversight",
      originId: sourceId,
    });

    expect((await statuses(db, [openOne])).get(openOne)?.parentId).toBeNull();
    const result = await syncWorkflowRunState(db, runId);
    expect(result.status).toBe("completed");

    const rows = await statuses(db, [openOne, openTwo, alreadyDone, alreadyCancelled, hidden, wrongKind]);
    expect(rows.get(openOne)?.status).toBe("done");
    expect(rows.get(openTwo)?.status).toBe("done");
    expect(rows.get(alreadyDone)?.status).toBe("done");
    expect(rows.get(alreadyCancelled)?.status).toBe("cancelled");
    expect(rows.get(hidden)?.status).toBe("todo");
    expect(rows.get(wrongKind)?.status).toBe("todo");

    const comments = await db.select().from(issueComments)
      .where(inArray(issueComments.issueId, [openOne, openTwo]));
    expect(comments).toHaveLength(2);
    expect(comments.every((comment) => comment.body.includes(sourceId))).toBe(true);
    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, tenant.companyId),
      eq(activityLog.action, ACTIVITY_ACTION),
    ));
    expect(activities).toHaveLength(2);
    expect(activities.every((activity) => activity.runId === null)).toBe(true);
    expect(activities.map((activity) => activity.details)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceIssueId: sourceId, sourceStatus: "done", workflowRunId: runId }),
    ]));

    await syncWorkflowRunState(db, runId);
    expect(await db.select().from(issueComments).where(inArray(issueComments.issueId, [openOne, openTwo]))).toHaveLength(2);
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, tenant.companyId),
      eq(activityLog.action, ACTIVITY_ACTION),
    ))).toHaveLength(2);
  });

  it("does not close unblocks for a past run, another mission, or another company", async () => {
    const tenant = await seedTenant(db, "scope");
    const currentSource = await addIssue(db, tenant, "current source", "done");
    const pastSource = await addIssue(db, tenant, "past source", "done");
    await seedRun(db, tenant, [{ issueId: pastSource, status: "completed" }]);
    const currentRunId = await seedRun(db, tenant, [{ issueId: currentSource, status: "completed" }]);
    const current = await addUnblock(db, tenant, currentSource);
    const past = await addUnblock(db, tenant, pastSource);

    const otherMissionId = await addMission(db, tenant, "other");
    const otherMission = { companyId: tenant.companyId, missionId: otherMissionId };
    // 같은 originId라도 다른 미션/회사 소속이면 절대 종결되지 않음을 증명한다.
    const otherMissionUnblock = await addUnblock(db, otherMission, currentSource);
    const otherCompany = await seedTenant(db, "other-company");
    const otherCompanyUnblock = await addUnblock(db, otherCompany, currentSource);

    await syncWorkflowRunState(db, currentRunId);
    const rows = await statuses(db, [current, past, otherMissionUnblock, otherCompanyUnblock]);
    expect(rows.get(current)?.status).toBe("done");
    expect(rows.get(past)?.status).toBe("todo");
    expect(rows.get(otherMissionUnblock)?.status).toBe("todo");
    expect(rows.get(otherCompanyUnblock)?.status).toBe("todo");
  });

  it.each([
    ["failed", "running", ["completed", "failed"] as const],
    ["running", "running", ["completed", "running"] as const],
    ["cancelled", "cancelled", ["completed"] as const],
  ])("leaves an unblock open when the run finishes %s", async (expected, initial, stepStatuses) => {
    const tenant = await seedTenant(db, `guard-${expected}`);
    const sourceId = await addIssue(db, tenant, "done source", "done");
    const steps: StepSeed[] = stepStatuses.map((status, index) => ({
      status,
      ...(index === 0 ? { issueId: sourceId } : {}),
    }));
    const runId = await seedRun(db, tenant, steps, initial);
    const unblockId = await addUnblock(db, tenant, sourceId);

    expect((await syncWorkflowRunState(db, runId)).status).toBe(expected);
    expect((await statuses(db, [unblockId])).get(unblockId)?.status).toBe("todo");
  });

  it("leaves an unblock open when its current-run source is not done", async () => {
    const tenant = await seedTenant(db, "source-guard");
    const sourceId = await addIssue(db, tenant, "cancelled source", "cancelled");
    const runId = await seedRun(db, tenant, [{ issueId: sourceId, status: "completed" }]);
    const unblockId = await addUnblock(db, tenant, sourceId);

    expect((await syncWorkflowRunState(db, runId)).status).toBe("failed");
    expect((await statuses(db, [unblockId])).get(unblockId)?.status).toBe("todo");
  });

  it("leaves an unblock open for a non-done source even when the run is completed", async () => {
    const tenant = await seedTenant(db, "source-guard-completed");
    const sourceId = await addIssue(db, tenant, "blocked source", "blocked");
    const runId = randomUUID();
    const unblockId = await addUnblock(db, tenant, sourceId);

    await closeResolvedWorkflowUnblocks({
      db,
      run: { id: runId, status: "completed", companyId: tenant.companyId, missionId: tenant.missionId },
      stepRuns: [{ workflowRunId: runId, issueId: sourceId }],
    });
    expect((await statuses(db, [unblockId])).get(unblockId)?.status).toBe("todo");
  });
});
