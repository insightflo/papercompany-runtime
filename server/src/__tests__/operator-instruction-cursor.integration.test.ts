import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { successfulAdapterResult, waitForRunTerminal } from "./heartbeat-raw-provider-session-rotation.helpers.js";
import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

const executeSpy = vi.fn();
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Embedded PostgreSQL unavailable: ${support.reason}`);
const describeDb = support.supported ? describe : describe.skip;

describeDb("operator instruction cursor: adapter-boundary consumption, not model-receipt proof", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let now: Date;
  let deliveries: Array<{ context: Record<string, unknown>; cursor: typeof issues.$inferSelect }>;

  beforeAll(async () => {
    home = await mkdtemp(path.resolve(".operator-cursor-test-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    tempDb = await startEmbeddedPostgresTestDatabase("operator-instruction-cursor-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (db) { await waitForHeartbeatExecutionsToDrain(db); await db.$client.end({ timeout: 5 }); }
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  afterEach(async () => { await waitForHeartbeatExecutionsToDrain(db); executeSpy.mockReset(); });
  beforeEach(async () => {
    now = new Date();
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID(); deliveries = [];
    await db.insert(companies).values({ id: companyId, name: "Cursor", issuePrefix: `C${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Cursor agent", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: { cwd: home }, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Cursor issue", status: "todo", assigneeAgentId: agentId });
    executeSpy.mockImplementation(async ({ context }) => {
      const [cursor] = await db.select().from(issues).where(eq(issues.id, issueId));
      deliveries.push({ context: structuredClone(context), cursor });
      return successfulAdapterResult();
    });
  });

  async function comment(body: string, ageMs = 1_000, authorUserId: string | null = "board", id = randomUUID()) {
    const createdAt = new Date(now.getTime() - ageMs);
    await db.insert(issueComments).values({ id, companyId, issueId, body, createdAt, authorUserId, authorAgentId: authorUserId ? null : agentId });
    return { id, body, createdAt: createdAt.toISOString() };
  }
  async function invoke() {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual", { actorType: "system", actorId: "test" });
    expect(run).not.toBeNull();
    const result = await waitForRunTerminal(heartbeat, run!.id);
    await waitForHeartbeatExecutionsToDrain(db);
    return result;
  }

  it("includes two recent user comments with a null cursor and advances before adapter entry", async () => {
    const first = await comment("first", 2_000);
    const second = await comment("second");
    expect((await invoke()).status).toBe("succeeded");
    expect(deliveries[0].context.paperclipOperatorInstructionsUnconsumed).toEqual([second, first]);
    expect(deliveries[0].cursor).toMatchObject({ lastOperatorInstructionAt: new Date(second.createdAt), lastOperatorInstructionCommentId: second.id });
  });

  it("includes only the new comment after the previous cursor", async () => {
    await comment("already consumed", 2_000);
    await invoke();
    const next = await comment("new instruction");
    await invoke();
    expect(deliveries[1].context.paperclipOperatorInstructionsUnconsumed).toEqual([next]);
  });

  it("excludes agent comments and older-than-24h user comments with a null cursor", async () => {
    await comment("agent reply", 1_000, null);
    await comment("old instruction", 25 * 60 * 60 * 1_000);
    await invoke();
    expect(deliveries[0].context.paperclipOperatorInstructionsUnconsumed).toEqual([]);
    expect(deliveries[0].cursor).toMatchObject({ lastOperatorInstructionAt: null, lastOperatorInstructionCommentId: null });
  });

  it("delivers oldest ten first without losing the eleventh at the same timestamp", async () => {
    const comments = [];
    for (let i = 1; i <= 11; i++) comments.push(await comment(`instruction ${i}`, 1_000, "board", `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`));
    await invoke();
    expect(deliveries[0].context.paperclipOperatorInstructionsUnconsumed).toEqual(comments.slice(0, 10).reverse());
    expect(deliveries[0].cursor).toMatchObject({ lastOperatorInstructionCommentId: comments[9].id });
    await invoke();
    expect(deliveries[1].context.paperclipOperatorInstructionsUnconsumed).toEqual([comments[10]]);
    await invoke();
    expect(deliveries[2].context.paperclipOperatorInstructionsUnconsumed).toEqual([]);
  });

  it("does not consume when context-budget preflight blocks adapter entry", async () => {
    await comment("must remain pending");
    await db.update(agents).set({ adapterConfig: { cwd: home, promptTemplate: "x".repeat(400) }, runtimeConfig: { heartbeat: { contextBudgetPreflight: { maxEstimatedTokens: 5 } } } }).where(eq(agents.id, agentId));
    expect((await invoke()).errorCode).toBe("context_budget_exceeded");
    expect(deliveries).toEqual([]);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ lastOperatorInstructionAt: null, lastOperatorInstructionCommentId: null });
  });
});
