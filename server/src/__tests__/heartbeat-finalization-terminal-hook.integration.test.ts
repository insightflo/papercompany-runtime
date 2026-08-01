import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunFinalizations,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { maybeRecordTerminalFinalization } from "../services/heartbeat-finalization/shadow-terminal-hook.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip terminal hook tests: ${support.reason ?? "unsupported"}`);

describeEP("heartbeat finalization shadow terminal hook", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-hook-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "HookCo", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Hook agent", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
  });
  afterAll(() => { tempDb = null; });

  async function seedV1Run(status: string, overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId, agentId, invocationSource: "on_demand", status,
      finalizationVersion: 1, executionEpoch: 0, executionToken: randomUUID(),
      executorOwnerId: "default", executorOwnerLeaseEpoch: 1, executorOwnerLeaseToken: randomUUID(),
      executorOwnerReleasedAt: new Date(), processPid: null, ...overrides,
    } as never);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    return run!;
  }

  async function flagOn(): Promise<void> {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: true } } as never);
  }
  async function flagOff(): Promise<void> {
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({ singletonKey: "default", general: {}, experimental: { enableHeartbeatFinalizationV1: false } } as never);
  }

  it("flag ON: records finalization parent + first-wins terminal outcome for a v1 terminal run", async () => {
    await flagOn();
    const run = await seedV1Run("succeeded");
    await maybeRecordTerminalFinalization(db, run, new Date());
    const fin = await db.select().from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id)).then((r) => r[0] ?? null);
    expect(fin).not.toBeNull();
    expect(fin!.terminalOutcome).toBe("succeeded");
    const after = await db.select({ terminalOutcome: heartbeatRuns.terminalOutcome }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).then((r) => r[0]!);
    expect(after.terminalOutcome).toBe("succeeded");
  });

  it("flag OFF: writes no finalization record (legacy behavior)", async () => {
    await flagOff();
    const run = await seedV1Run("failed");
    await maybeRecordTerminalFinalization(db, run, new Date());
    const fin = await db.select().from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id)).then((r) => r[0] ?? null);
    expect(fin).toBeNull();
  });

  it("never throws and never changes status when the run is not v1", async () => {
    await flagOn();
    const run = await seedV1Run("succeeded", { finalizationVersion: 0 });
    await expect(maybeRecordTerminalFinalization(db, run, new Date())).resolves.toBeUndefined();
    const fin = await db.select().from(heartbeatRunFinalizations).where(eq(heartbeatRunFinalizations.heartbeatRunId, run.id)).then((r) => r[0] ?? null);
    expect(fin).toBeNull();
  });
});
