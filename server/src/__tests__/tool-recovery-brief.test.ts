import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, activityLog, agents, companies, heartbeatRuns, issueComments, issues, missions, operatorDecisions, operatorDecisionContinuations, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { toolRecoveryUrlDiagnostics } from "./helpers/tool-recovery-url-diagnostics.js";
import { ensureToolRecoveryCard } from "../services/missions/tool-recovery-card.js";
import { issueService } from "../services/issues.js";
import { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import { closeOwnerHumanRequest } from "../services/missions/owner-human-request-state.js";
import { lockOwnerHumanRequestAuthority, readOwnerToolIdentity } from "../services/missions/owner-human-request-authority.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Catches: missing authoritative identity, raw env leakage, lost issue/link after optional SQL failure.
describe("tool recovery brief creation (real transaction)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, other: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("tool-brief-"); db = createDb(temp.connectionString); other = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await other?.$client.end(); await db?.$client.end(); await temp?.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
  async function seed(language = "en") {
    const s = await seedToolRecoveryScenario({ db, artifactExists: false }); roots.push(s.tempRoot);
    await db.update(companies).set({ defaultLanguage: language }).where(eq(companies.id, s.companyId));
    const [card] = await db.select().from(issues).where(eq(issues.id, s.recoveryIssueId));
    const [mission] = await db.select().from(missions).where(eq(missions.id, card.missionId!));
    const [oversightIssue] = await db.select().from(issues).where(eq(issues.id, card.originId!));
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await db.update(workflowStepRuns).set({ lastDispatchRequestId: "dispatch-exact", executionGeneration: 7,
      metadata: { toolResult: { artifactPath: "/tmp/result.json", error: "Input contract failed: required source path is absent", exitCode: 2 },
        toolInvocation: { args: { inputPath: "/tmp/input.json", API_TOKEN: "ARG_SENTINEL" } } } }).where(eq(workflowStepRuns.id, s.stepRunId)).returning();
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId));
    return { mission, oversightIssue, run, stepRun, step: (definition.stepsJson as WorkflowStep[])[0], workflowName: definition.name };
  }
  const create = (input: Awaited<ReturnType<typeof seed>>, handle = db) => ensureToolRecoveryCard(handle, {}, input,
    async (tx, companyId, data) => (await tx.insert(issues).values({ ...data, companyId }).returning())[0]);

  it("renders exact target and bounded secret-safe registry/result facts without changing origin, wake or identity", async () => {
    const input = await seed();
    await db.insert(toolDefinitions).values({ companyId: input.mission.companyId, name: "collect-us-stockflow", adapterType: "builtin",
      adapterConfig: { command: "node /tools/run.mjs --api-token=COMMAND_SENTINEL", workingDirectory: "/tools",
        url: "https://user:URL_SENTINEL@example.test/run?token=QUERY_SENTINEL", instructions: "/tools/README.md",
        env: { API_TOKEN: "ENV_SENTINEL", ROOT: "ROOT_SENTINEL" }, headers: { Authorization: "HEADER_SENTINEL" } } });
    const before = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.run.id));
    const result = await create(input);
    const text = result.issue.description!;
    const target = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);
    expect(target).toEqual({ kind: "tool_step", workflowRunId: input.run.id, stepRunId: input.stepRun.id,
      expectedAuthorityVersion: 0, expectedExecutionGeneration: 7, failedDispatchRequestId: "dispatch-exact" });
    for (const value of ["/tools/run.mjs", "/tools/README.md", "/tmp/result.json", "/tmp/input.json", "Input contract failed: required source path is absent", "API_TOKEN", "ROOT"])
      expect(text).toContain(value);
    for (const value of ["ENV_SENTINEL", "ROOT_SENTINEL", "ARG_SENTINEL", "COMMAND_SENTINEL", "URL_SENTINEL", "QUERY_SENTINEL", "HEADER_SENTINEL"])
      expect(text).not.toContain(value);
    const structuredResult = JSON.parse(text.split("\n").find(line => line.startsWith("toolResult: "))!.slice("toolResult: ".length));
    expect(structuredResult.error).toBe("Input contract failed: required source path is absent");
    expect(structuredResult.errorCode).toBe("unavailable"); // Prose is not a machine error code.
    expect(text).toContain("registration_not_applicable");
    expect(text).toContain("restart_from_start");
    expect(text).toContain("board approval");
    // Stage 2(D4): 오너 자가 교체 안내 — 교정 메타데이터 재실행 경로와 필수 필드를 브리프가 알려야 한다.
    expect(text).toContain("POST /api/issues/{this issue id}/owner-recovery/replacement");
    for (const field of ["sourceRunId", "decisionEventId", "metadata", "idempotencyKey"])
      expect(text).toContain(field);
    expect(result.issue.originId).toBe(input.oversightIssue.id);
    expect(result.issue.originKind).toBe("mission_main_executor_unblock");
    const again = await create(input);
    expect(again.created).toBe(false); expect(again.issue.id).toBe(result.issue.id);
    expect(await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, input.run.id))).toEqual(before);
  });

  it.each([
    ["missing", "Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "QWxhZGRpbjpvcGVuIHNlc2FtZQ=="],
    ["unavailable", "Authorization: Basic BASIC_CREDENTIAL_SENTINEL", "BASIC_CREDENTIAL_SENTINEL"],
    ["missing", "postgres://user:DB_PASSWORD_SENTINEL@db.example/test", "DB_PASSWORD_SENTINEL"],
    ["unavailable", "postgres://user:DB_PASSWORD_SENTINEL@db.example/test", "DB_PASSWORD_SENTINEL"],
    ["unavailable", "postgres://user:prefix'DSN_QUOTE_SENTINEL@db.example/test", "DSN_QUOTE_SENTINEL"],
  ])("redacts stored diagnostics with %s registry: %s", async (registry, diagnostic, secret) => {
    const input = await seed();
    // Persist native-shaped result; test both raw diagnostics and the structured error projection.
    const [stepRun] = await db.update(workflowStepRuns).set({ metadata: { toolResult: {
      requestId: "dispatch-exact", toolName: "collect-us-stockflow", success: false,
      stdout: null, stderr: diagnostic, exitCode: 1, error: diagnostic,
      completedAt: "2026-10-03T00:00:00.000Z",
    } } }).where(eq(workflowStepRuns.id, input.stepRun.id)).returning();
    await db.transaction(async tx => {
      if (registry === "unavailable") await tx.execute(sql.raw("alter table tool_definitions rename to tool_definitions_brief_unavailable"));
      const result = await create({ ...input, stepRun }, tx as unknown as typeof db);
      const [stored] = await tx.select().from(issues).where(eq(issues.id, result.issue.id));
      expect(stored.description).not.toContain(secret);
      expect(stored.description).toContain(registry === "unavailable" ? 'registry: "unavailable"' : '"status":"unavailable"');
      if (registry === "unavailable") await tx.execute(sql.raw("alter table tool_definitions_brief_unavailable rename to tool_definitions"));
    });
  });

  it.each(toolRecoveryUrlDiagnostics)("never stores credential suffixes with %s and missing registry", async (_name, diagnostic) => {
    const input = await seed();
    // Isolated registry-free proof: no configured secret list can hide a broken URL boundary.
    expect(await db.select().from(toolDefinitions).where(eq(toolDefinitions.companyId, input.mission.companyId))).toEqual([]);
    const [stepRun] = await db.update(workflowStepRuns).set({ metadata: { toolResult: {
      requestId: "dispatch-exact", toolName: "collect-us-stockflow", success: false,
      stdout: diagnostic, stderr: diagnostic, error: diagnostic, exitCode: 1,
      completedAt: "2026-10-03T00:00:00.000Z",
    } } }).where(eq(workflowStepRuns.id, input.stepRun.id)).returning();
    const result = await create({ ...input, stepRun });
    const [stored] = await db.select().from(issues).where(eq(issues.id, result.issue.id));
    expect(stored.description).toContain('"status":"unavailable"');
    expect(stored.description).not.toMatch(/DSN_\w+_SENTINEL|user:|prefix/);
    expect(stored.description).toContain("[REDACTED_URL]");
  });

  it("uses company language and never another company's registry entry", async () => {
    const input = await seed("ko");
    const foreign = await seed();
    await db.insert(toolDefinitions).values({ companyId: foreign.mission.companyId, name: "collect-us-stockflow", adapterType: "builtin", adapterConfig: { command: "FOREIGN_COMMAND" } });
    const result = await create(input);
    expect(result.issue.description).toContain("구조화된 시스템 사실");
    expect(result.issue.description).toContain("owner-recovery/replacement");
    expect(result.issue.description).toContain("교정 metadata");
    expect(result.issue.description).toContain("unavailable");
    expect(result.issue.description).not.toContain("FOREIGN_COMMAND");
  });

  it.each(["tool_definitions", "company_knowledge_patterns"])("recovers optional %s SQL errors with SAVEPOINT and still commits issue plus link", async table => {
    const input = await seed();
    // Transaction-local rename forces an actual undefined-table SQL error, without affecting other tests.
    await db.transaction(async tx => {
      await tx.execute(sql.raw(`alter table ${table} rename to ${table}_brief_unavailable`));
      const result = await create(input, tx as unknown as typeof db);
      expect(result.issue.description).toContain("unavailable");
      expect(await tx.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.issueId, result.issue.id))).toHaveLength(1);
      await tx.execute(sql.raw(`alter table ${table}_brief_unavailable rename to ${table}`));
    });
  });
  type Input = Awaited<ReturnType<typeof seed>>;
  const events = (input: Input) => db.select().from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.companyId, input.mission.companyId)).orderBy(workflowTransitionEvents.id);
  const snapshot = (input: Input) => Promise.all([events(input),
    db.select().from(issues).where(eq(issues.companyId, input.mission.companyId)).orderBy(issues.id),
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.mission.companyId)),
    db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, input.mission.companyId)).orderBy(operatorDecisions.id),
    db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, input.mission.companyId)),
    db.select().from(issueComments).where(eq(issueComments.companyId, input.mission.companyId)),
    db.select().from(activityLog).where(eq(activityLog.companyId, input.mission.companyId)).orderBy(activityLog.id)]);
  const target = (input: Input) => ({ kind: "tool_step" as const, workflowRunId: input.run.id,
    stepRunId: input.stepRun.id, expectedAuthorityVersion: input.run.dispatchAuthorityVersion,
    expectedExecutionGeneration: input.stepRun.executionGeneration, failedDispatchRequestId: input.stepRun.lastDispatchRequestId });
  async function human(input: Input, decision: "request_input" | "escalate" = "request_input", legacy = false) {
    const first = await create(input), runId = randomUUID(), agentId = input.mission.ownerAgentId!;
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.mission.companyId,
      agentId, issueId: first.issue.id, status: "running" });
    await issueService(db).checkout(first.issue.id, agentId, ["todo"], runId);
    const saved = await submitMissionOwnerDecision({ db, issueId: first.issue.id,
      actor: { actorType: "agent", actorId: agentId, agentId, runId }, data: {
        decision, reason: "Original tool blocker", nextAction: "Ask human", evidence: "Original evidence",
        recoveryTarget: target(input), ...(!legacy ? { humanRequest: { schemaVersion: 1 as const,
          requestKey: randomUUID(), expectedCurrentLifetimeId: null } } : {}),
      } });
    return { first, saved };
  }

  it("preserves the first v1 bytes and converges two connections on one terminal successor v2", async () => {
    const input = await seed(), first = await create(input), original = await events(input);
    expect(original[0]).toMatchObject({ idempotencyKey: `owner-tool-card:${input.stepRun.id}`,
      payload: { schemaVersion: 1, kind: "tool_step", workflowRunId: input.run.id, stepRunId: input.stepRun.id } });
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    const notices: string[] = [];
    const produce = (handle = db) => ensureToolRecoveryCard(handle, { onOwnerActionCreated: async ({ issue }) => {
      expect(await other.select().from(issues).where(eq(issues.id, issue.id))).toHaveLength(1);
      notices.push(issue.id);
    } }, input, async (tx, companyId, data) => (await tx.insert(issues).values({ ...data, companyId }).returning())[0]);
    const [a, b] = await Promise.all([produce(), produce(other)]);
    expect(a.issue.id).toBe(b.issue.id); expect([a.created, b.created].sort()).toEqual([false, true]);
    const rows = await events(input);
    expect(rows.find(row => row.id === original[0].id)).toEqual(original[0]);
    expect(rows.find(row => row.issueId === a.issue.id)).toMatchObject({
      eventType: "owner_tool_recovery_target_v1", layer: "mission_owner_recovery",
      idempotencyKey: `owner-tool-card:v2:${input.stepRun.id}:${a.issue.id}`,
      payload: { schemaVersion: 2, kind: "tool_step", companyId: input.mission.companyId,
        missionId: input.mission.id, anchorIssueId: a.issue.id, sourceIssueId: input.oversightIssue.id,
        workflowRunId: input.run.id, stepRunId: input.stepRun.id } });
    await vi.waitFor(() => expect(notices).toEqual([a.issue.id]));
    expect((await create(input)).issue.id).toBe(a.issue.id);
  });

  it.each([false, true])("renews unresolved human tool scope with fresh pending card and immutable history (legacy=%s)", async legacy => {
    const input = await seed(), { first, saved } = await human(input, "request_input", legacy);
    await operatorDecisionWriteService(db).resolve(saved.operatorDecisionId!,
      { actionId: "approve", selectedOptionIds: ["approve"], comment: "Past approval" }, "board");
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    const before = await snapshot(input), next = await create(input), after = await snapshot(input);
    const pointer = after[0].find(row => row.eventType === "owner_human_current_v1")!;
    expect(pointer.payload).toMatchObject({ anchorIssueId: next.issue.id, recoveryNeeded: true, revision: 2 });
    const fresh = after[3].find(card => card.issueId === next.issue.id)!;
    expect(fresh).toMatchObject({ status: "pending", result: null, resolvedAt: null, cancelledAt: null });
    expect(after[3].find(card => card.id === saved.operatorDecisionId)).toEqual(before[3][0]);
    for (const row of before[0].filter(row => row.eventType !== "owner_human_current_v1"))
      expect(after[0].find(value => value.id === row.id)).toEqual(row);
    for (const row of before[1]) expect(after[1].find(value => value.id === row.id)).toEqual(row);
    expect(after[2]).toEqual(before[2]); expect(after[4]).toEqual(before[4]); expect(after[5]).toEqual(before[5]);
    for (const row of before[6]) expect(after[6].find(value => value.id === row.id)).toEqual(row);
    expect(after[0].filter(row => row.eventType === "mission_owner_decision")).toHaveLength(1);
    expect(after[0].filter(row => row.eventType === "owner_human_lifetime_v1")).toHaveLength(2);
    await create(input, other); expect(await snapshot(input)).toEqual(after);
    const runId = randomUUID(); await db.insert(heartbeatRuns).values({ id: runId, companyId: input.mission.companyId, agentId: input.mission.ownerAgentId!, issueId: next.issue.id, status: "running" });
    await issueService(db).checkout(next.issue.id, input.mission.ownerAgentId!, ["todo"], runId); await submitMissionOwnerDecision({ db, issueId: next.issue.id, actor: { actorType: "agent", actorId: input.mission.ownerAgentId!, agentId: input.mission.ownerAgentId!, runId }, data: { decision: "retry_source_issue", recoveryTarget: target(input) } });
    await issueService(db).update(next.issue.id, { status: "cancelled" }); const kept = await create(input);
    expect(kept).toMatchObject({ created: false, issue: { id: next.issue.id } }); expect((await events(input)).filter(row => row.eventType === "owner_human_lifetime_v1")).toHaveLength(2);
  });

  it("rolls back anchor/link/lifetime/current/card/audit on mandatory card failure", async () => {
    const input = await seed(), { first } = await human(input, "escalate");
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    const before = await snapshot(input);
    await expect(db.transaction(async tx => {
      await tx.execute(sql.raw("alter table operator_decisions rename to tool_card_write_unavailable"));
      await create(input, tx as unknown as typeof db);
    })).rejects.toThrow();
    expect(await snapshot(input)).toEqual(before);
  });

  it.each(["payload", "header", "key", "anchor-owner", "source-hidden", "run-drift", "duplicate", "multiple-open", "hidden", "source", "owner", "mission", "resolved", "drift"])("fails closed on %s without writing", async damage => {
      const input = await seed(), first = await create(input), [link] = await events(input);
      if (["run-drift", "resolved", "drift"].includes(damage)) await issueService(db).update(first.issue.id, { status: "cancelled" });
      if (damage === "payload") await db.update(workflowTransitionEvents).set({ payload: { ...link.payload as object, extra: true } }).where(eq(workflowTransitionEvents.id, link.id));
      if (damage === "header") await db.update(workflowTransitionEvents).set({ layer: "wrong" }).where(eq(workflowTransitionEvents.id, link.id));
      if (damage === "key") await db.update(workflowTransitionEvents).set({ idempotencyKey: `owner-tool-card:v2:${input.stepRun.id}:${first.issue.id}` }).where(eq(workflowTransitionEvents.id, link.id));
      if (damage === "anchor-owner") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, first.issue.id));
      if (damage === "source-hidden") await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, input.oversightIssue.id));
      if (damage === "run-drift") await db.update(workflowRuns).set({ dispatchAuthorityVersion: 1 }).where(eq(workflowRuns.id, input.run.id));
      if (damage === "duplicate") await db.insert(workflowTransitionEvents).values({ ...link, id: randomUUID(), idempotencyKey: randomUUID() });
      if (damage === "multiple-open") {
        const [anchor] = await db.insert(issues).values({ companyId: input.mission.companyId, missionId: input.mission.id,
          title: "Competing anchor", assigneeAgentId: input.mission.ownerAgentId,
          originKind: "mission_main_executor_unblock", originId: input.oversightIssue.id }).returning();
        await db.insert(workflowTransitionEvents).values({ ...link, id: randomUUID(), issueId: anchor.id,
          idempotencyKey: `owner-tool-card:v2:${input.stepRun.id}:${anchor.id}`, payload: { schemaVersion: 2, kind: "tool_step",
            companyId: input.mission.companyId, missionId: input.mission.id, anchorIssueId: anchor.id,
            sourceIssueId: input.oversightIssue.id, workflowRunId: input.run.id, stepRunId: input.stepRun.id } });
      }
      if (damage === "hidden") await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, first.issue.id));
      if (damage === "source") await db.update(issues).set({ originId: first.issue.id }).where(eq(issues.id, first.issue.id));
      if (damage === "owner") {
        const [owner] = await db.insert(agents).values({ companyId: input.mission.companyId, name: "Changed owner", status: "active" }).returning();
        await db.update(missions).set({ ownerAgentId: owner.id }).where(eq(missions.id, input.mission.id));
      }
      if (damage === "mission") await db.update(missions).set({ status: "completed" }).where(eq(missions.id, input.mission.id));
      if (damage === "resolved") await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, input.stepRun.id));
      if (damage === "drift") await db.update(workflowStepRuns).set({ executionGeneration: 8 }).where(eq(workflowStepRuns.id, input.stepRun.id));
      const before = await snapshot(input);
      await expect(create(input)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(input)).toEqual(before);
    });

  it("strict API rejects v2 mismatches/corruption before adopting checkout", async () => {
    const input = await seed(), first = await create(input);
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    const next = await create(input), agentId = input.mission.ownerAgentId!, runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.mission.companyId,
      agentId, issueId: next.issue.id, status: "running" });
    const actor = { actorType: "agent" as const, actorId: agentId, agentId, runId };
    for (const recoveryTarget of [undefined, { ...target(input), stepRunId: randomUUID() }]) {
      const before = await snapshot(input);
      await expect(submitMissionOwnerDecision({ db, issueId: next.issue.id, actor,
        data: { decision: "retry_source_issue", recoveryTarget } })).rejects.toMatchObject({ status: 409 });
      expect(await snapshot(input)).toEqual(before);
    }
    const link = (await events(input)).find(row => row.issueId === next.issue.id)!;
    await db.update(workflowTransitionEvents).set({ payload: { ...link.payload as object, sourceIssueId: next.issue.id } })
      .where(eq(workflowTransitionEvents.id, link.id));
    const before = await snapshot(input);
    await expect(submitMissionOwnerDecision({ db, issueId: next.issue.id, actor,
      data: { decision: "request_input", recoveryTarget: target(input) } })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot(input)).toEqual(before);
    await expect(db.transaction(tx => readOwnerToolIdentity(tx, input.mission.companyId, input.mission.id, next.issue.id)))
      .rejects.toMatchObject({ status: 409 });
  });

  it("creates v2 after official settlement without renewing or moving the closed pointer", async () => {
    const input = await seed(), { first, saved } = await human(input);
    const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, first.issue.id));
    await db.update(workflowStepRuns).set({ status: "completed" }).where(eq(workflowStepRuns.id, input.stepRun.id));
    await db.transaction(async tx => closeOwnerHumanRequest(await lockOwnerHumanRequestAuthority(tx, {
      companyId: input.mission.companyId, missionId: input.mission.id, agentId: input.mission.ownerAgentId!,
      ownerActionIssueId: first.issue.id, heartbeatRunId: heartbeat.id, purpose: "settle",
      recoveryTarget: target(input),
    }), saved.lifetimeId!));
    await issueService(db).update(first.issue.id, { status: "cancelled" });
    await db.update(workflowStepRuns).set({ status: "failed" }).where(eq(workflowStepRuns.id, input.stepRun.id));
    const [stepRun] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, input.stepRun.id));
    const before = await snapshot(input), next = await create({ ...input, stepRun }), after = await snapshot(input);
    expect(next.created).toBe(true); expect(next.issue.id).not.toBe(first.issue.id);
    expect(after[0].find(row => row.eventType === "owner_human_current_v1")).toEqual(before[0].find(row => row.eventType === "owner_human_current_v1"));
    expect(after[0].filter(row => row.eventType === "owner_human_lifetime_v1")).toHaveLength(1);
    expect(after[3]).toEqual(before[3]); expect(after[4]).toEqual(before[4]);
    for (const row of before[0]) expect(after[0].find(value => value.id === row.id)).toEqual(row);
  });
});
