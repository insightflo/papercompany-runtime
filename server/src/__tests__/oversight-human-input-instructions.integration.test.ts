import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  workflowTransitionEvents,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { issueService } from "../services/issues.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import {
  HUMAN_INPUT_INSTRUCTIONS_END_MARKER,
  HUMAN_INPUT_INSTRUCTIONS_START_MARKER,
  MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS,
} from "../services/missions/oversight-human-input-instructions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let db!: ReturnType<typeof createDb>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("oversight-human-input-instructions-");
  db = createDb(tempDb.connectionString);
}, 60_000);
afterAll(async () => {
  if (db) await db.$client.end({ timeout: 5 });
  await tempDb?.cleanup();
});

describeEP("main executor oversight human-input instructions", () => {
  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(workflowTransitionEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedMission() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Oversight instructions",
      issuePrefix: `OI${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission owner",
      role: "operator",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [mission] = await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Human decision mission",
      status: "active",
    }).returning();
    await db.insert(missionPlanArtifacts).values({
      companyId,
      missionId,
      ownerAgentId,
      missionGoal: "Exercise oversight description refresh",
      status: "active",
      refs: {},
    });
    return { companyId, ownerAgentId, mission: mission! };
  }

  async function seedOversightIssue(input: {
    companyId: string;
    ownerAgentId: string;
    missionId: string;
    description: string;
    status?: "todo" | "in_progress" | "done" | "cancelled";
  }) {
    const issue = await issueService(db).create(input.companyId, {
      assigneeAgentId: input.ownerAgentId,
      description: input.description,
      missionId: input.missionId,
      originKind: "mission_main_executor_oversight",
      priority: "medium",
      status: input.status ?? "in_progress",
      title: "[OVERSIGHT] Previous workflow",
    });
    await db.update(issues).set({ description: input.description }).where(eq(issues.id, issue.id));
    return issue;
  }

  it("includes the approved instructions on newly generated oversight descriptions", async () => {
    const fixture = await seedMission();
    const issue = await createOwnerActions({ db, deps: {} })
      .ensureMainExecutorOversightIssue(fixture.mission, "Current workflow");

    expect(issue.description).toContain(MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS);
    expect(issue.description).toContain(HUMAN_INPUT_INSTRUCTIONS_START_MARKER);
    expect(issue.description).toContain(HUMAN_INPUT_INSTRUCTIONS_END_MARKER);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("refreshes an existing non-terminal issue once and preserves every byte outside the marker block", async () => {
    const fixture = await seedMission();
    const prefix = "Existing instructions preserve CRLF\r\n\nHuman-edited context before.\n";
    const suffix = "\n\nHuman-added context after the generated block.  \r\nKeep spacing.";
    const previous = `${prefix}${HUMAN_INPUT_INSTRUCTIONS_START_MARKER}\nOld display wording\n${HUMAN_INPUT_INSTRUCTIONS_END_MARKER}${suffix}`;
    const issue = await seedOversightIssue({
      companyId: fixture.companyId,
      ownerAgentId: fixture.ownerAgentId,
      missionId: fixture.mission.id,
      description: previous,
    });
    const [storedBefore] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    const actions = createOwnerActions({ db, deps: {} });

    await actions.ensureMainExecutorOversightIssue(fixture.mission, "Current workflow");
    const [refreshed] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    const refreshedDescription = refreshed?.description ?? "";
    expect(refreshedDescription.slice(0, prefix.length)).toBe(prefix);
    const endIndex = refreshedDescription.indexOf(HUMAN_INPUT_INSTRUCTIONS_END_MARKER);
    expect(refreshedDescription.slice(endIndex + HUMAN_INPUT_INSTRUCTIONS_END_MARKER.length)).toBe(suffix);
    expect(refreshedDescription).toContain(MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS);
    expect(refreshedDescription.split(HUMAN_INPUT_INSTRUCTIONS_START_MARKER)).toHaveLength(2);

    await actions.ensureMainExecutorOversightIssue(fixture.mission, "Current workflow");
    const [refreshedAgain] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    expect(refreshedAgain?.description).toBe(refreshed?.description);
    expect(storedBefore?.description).toBe(previous);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(workflowTransitionEvents)).toHaveLength(0);
  });

  it("appends the block to a legacy description without changing its existing text", async () => {
    const fixture = await seedMission();
    const previous = "Legacy oversight prose.\r\n\nHuman-added note stays as written.  ";
    const issue = await seedOversightIssue({
      companyId: fixture.companyId,
      ownerAgentId: fixture.ownerAgentId,
      missionId: fixture.mission.id,
      description: previous,
    });
    const actions = createOwnerActions({ db, deps: {} });

    await actions.ensureMainExecutorOversightIssue(fixture.mission, "Current workflow");
    const [refreshed] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    expect(refreshed?.description?.startsWith(previous)).toBe(true);
    expect(refreshed?.description).toContain(MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS);
    expect(refreshed?.description?.split(HUMAN_INPUT_INSTRUCTIONS_START_MARKER)).toHaveLength(2);

    await actions.ensureMainExecutorOversightIssue(fixture.mission, "Current workflow");
    const [refreshedAgain] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    expect(refreshedAgain?.description).toBe(refreshed?.description);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("leaves other origin descriptions unchanged", async () => {
    const fixture = await seedMission();
    const description = "Keep this other owner-action description byte-for-byte.";
    const issue = await createOwnerActions({ db, deps: {} }).createMissionOwnerActionIssue(fixture.companyId, {
      assigneeAgentId: fixture.ownerAgentId,
      description,
      missionId: fixture.mission.id,
      originId: randomUUID(),
      originKind: "mission_main_executor_unblock",
      priority: "high",
      status: "todo",
      title: "[Unblock] Source issue",
    });

    expect(issue.description).toBe(description);
    expect(issue.description).not.toContain(HUMAN_INPUT_INSTRUCTIONS_START_MARKER);
  });

  it.each(["completed", "cancelled"] as const)("does not refresh instructions for a %s mission", async (status) => {
    const fixture = await seedMission();
    const previous = "Terminal mission description remains untouched.";
    const issue = await seedOversightIssue({
      companyId: fixture.companyId,
      ownerAgentId: fixture.ownerAgentId,
      missionId: fixture.mission.id,
      description: previous,
    });
    const [terminalMission] = await db.update(missions)
      .set({ status })
      .where(eq(missions.id, fixture.mission.id))
      .returning();
    if (!terminalMission) throw new Error("Expected the seeded mission to be updated");

    await createOwnerActions({ db, deps: {} }).ensureMainExecutorOversightIssue(terminalMission, "Current workflow");
    const [stored] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issue.id));
    expect(stored?.description).toBe(previous);
    expect(stored?.description).not.toContain(MISSION_OWNER_HUMAN_INPUT_INSTRUCTIONS);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
});
