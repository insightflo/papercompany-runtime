import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, companies, issues, missions, toolDefinitions, workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { toolRecoveryUrlDiagnostics } from "./helpers/tool-recovery-url-diagnostics.js";
import { ensureToolRecoveryCard } from "../services/missions/tool-recovery-card.js";
import type { WorkflowStep } from "../services/workflow/dag-engine.js";

// Catches: missing authoritative identity, raw env leakage, lost issue/link after optional SQL failure.
describe("tool recovery brief creation (real transaction)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("tool-brief-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
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
});
