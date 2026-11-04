// Real producer registration, actual cleanup and official QA verdict precede public same-run resume.
// Preserve products and the producer attempt across recovery; native v2 publication is atomic.
// The failure scenario denies directory writes because atomic rename can replace a read-only file.

import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests, createDb, instanceSettings,
  issueWorkProducts, workflowRecoveryAuthorities, workflowRuns,
  workflowStepOutputBindings, workflowStepRuns, workflowTerminalDecisions, workflowTransitionEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { readQaRemediationActualDrain } from "../services/heartbeat-actual-drain.js";
import { recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { prepareQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import { errorHandler } from "../middleware/index.js";
import { workflowRoutes } from "../routes/workflows.js";
import { QA_REMEDIATION_COMPLETION_EVENT_TYPE } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";
import { seedInternalAdmissionWorld, executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";

import { waitForHeartbeatExecutionsToDrain } from "../services/heartbeat-execution-tracker.js";

// External adapter boundary ONLY (established fixture pattern): native wake/claim/DB stay real;
// no real CLI/provider can spawn from any dispatch this test triggers.
const adapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: adapter }),
  runningProcesses: new Map(),
}));
const seededWorlds: Array<{ close(): Promise<void>; file: string }> = [];

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip concept native recovery stage A: ${support.reason ?? "unsupported host"}`);

const FINDS: ReadonlyArray<readonly [find: string, replace: string]> = [
  ["에이전트 팀을 직접 운영하려는 독자에게 쓸모가 있다.", "에이전트 팀을 직접 운영하려는 독자에게 유용하다."],
  ["이후 3.03배에 도달했다.", "이후 3.03배에 도달했다(2026-10-29 기준)."],
  ["의 두 배가 넘는 속도다.", "의 두 배가 넘는 속도다(2026-10-29 기준)."],
];
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface World {
  companyId: string; missionId: string; runId: string; producerStepRunId: string; qaStepRunId: string;
  producerIssueId: string; contentPath: string; originalContent: string; imagePaths: string[]; originalImages: string[];
  refireKey: string; producerWakeCount: number; producerIteration: number; authorityVersion: number;
  originalProducts: Array<{ id: string; url: string; status: string; metadata: unknown }>;
}

async function seedWorld(db: Db, dir: string, label: string, opts: { readonlyContent?: boolean } = {}): Promise<World> {
  const originalContent = JSON.stringify({ blocks: FINDS.map(([find], i) => ({ id: i, text: `서론 ${i}. ${find} 수치 블록 ${i}.` })) });
  const originalImages = Array.from({ length: 3 }, (_, i) => JSON.stringify({ figure: i, bytes: `img-${label}-${i}` }));
  const seeded = await seedInternalAdmissionWorld(db, dir, dir, {
    file: join(dir, label, "content.json"), bytes: Buffer.from(originalContent), find: FINDS[0]![0], replace: FINDS[0]![1],
    replacements: FINDS.map(([find, replace]) => ({ find, replace })),
    products: originalImages.map((bytes, i) => ({ name: `figure-${i}.json`, bytes: Buffer.from(bytes) })),
  });
  const u = seeded.unit;
  seededWorlds.push({ close: seeded.close, file: u.file });
  await db.update(instanceSettings).set({ experimental: { enableHeartbeatFinalizationV1: true, enableRunReopenGuardV1: true,
    enableRunRecoveryServiceV1: true, enableWorkProductBindingV1: true } }).where(eq(instanceSettings.singletonKey, "default"));
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, u.runId));
  await db.update(workflowRuns).set({ status: "failed", completedAt: new Date() }).where(eq(workflowRuns.id, u.runId));
  await db.insert(workflowTerminalDecisions).values({ companyId: u.companyId, workflowRunId: u.runId,
    decidedAuthorityVersion: run!.dispatchAuthorityVersion, decision: "failed", policyCause: "recovery_deadline_hard",
    discoveryPath: "test-seed", origin: "deadlock_reconciler", reason: "existing-run resume after actual producer cleanup" });
  // Native publication uses atomic rename, so deny directory writes as well as direct file writes.
  if (opts.readonlyContent) { await chmod(u.file, 0o444); await chmod(dirname(u.file), 0o555); }
  const originalProducts = await db.select({ id: issueWorkProducts.id, url: issueWorkProducts.url, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts).where(eq(issueWorkProducts.companyId, u.companyId));
  const producerWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, u.producerIssueId));
  return { companyId: u.companyId, missionId: u.missionId, runId: u.runId, producerStepRunId: u.producer.id,
    qaStepRunId: u.qa.id, producerIssueId: u.producerIssueId, contentPath: u.file, originalContent,
    imagePaths: originalImages.map((_, i) => join(dirname(u.file), `figure-${i}.json`)), originalImages, originalProducts,
    refireKey: `qa-remediation-refire-v2:${u.companyId}:${u.runId}:${u.producer.id}:${u.qa.id}:${u.verdictEventId}`,
    producerWakeCount: producerWakes.length, producerIteration: u.producer.iterationIndex!, authorityVersion: run!.dispatchAuthorityVersion };

}

function createApp(db: Db, companyId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "board-stage-a", companyIds: [companyId], isInstanceAdmin: false } as typeof req.actor;
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}

describeDb("concept existing-run native recovery — Stage A public resume branch", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-concept-stage-a-");
    db = createDb(tempDb.connectionString);
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableRunReopenGuardV1: true, enableRunRecoveryServiceV1: true, enableWorkProductBindingV1: true } });
    dir = await realpath(await mkdtemp(join(tmpdir(), "concept-stage-a-")));
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT", dir);
    vi.stubEnv("PAPERCLIP_QA_FILE_OWNER_PYTHON", PYTHON!);
    adapter.mockImplementation(executeAdmissionFixtureAdapter);
  }, 120_000);
  afterAll(async () => {
    for (const world of seededWorlds) { await chmod(dirname(world.file), 0o755); await chmod(world.file, 0o644); await world.close(); }
    vi.unstubAllEnvs();
    await waitForHeartbeatExecutionsToDrain(db, 20_000).catch(() => {});
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 30_000);

  it("links only the official resumed producer actual and holds missing authority or changed bytes", async () => {
    const w = await seedWorld(db, dir, "proof");
    expect((await recoverTerminalRun(db, { companyId: w.companyId, runId: w.runId,
      expectedAuthorityVersion: w.authorityVersion, recoveryKind: "manual_resume", requestedBy: "board-stage-a", now: new Date() })).kind).toBe("recovered");
    const reservation = await prepareQaRemediationReservation(db, { companyId: w.companyId, missionId: w.missionId,
      workflowRunId: w.runId, producerStepRunId: w.producerStepRunId, qaStepRunIds: [w.qaStepRunId] });
    expect(reservation.outcome).toBe("prepared");
    if (reservation.outcome !== "prepared") throw new Error("resume reservation missing");
    const [producer] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producerStepRunId));
    const read = (connection: Db) => readQaRemediationActualDrain(connection, reservation.preparation, producer!);
    expect((await read(db)).kind).toBe("proven");
    const rollback = new Error("restore authority after negative read");
    await expect(db.transaction(async tx => {
      await tx.delete(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.runId));
      expect(await read(tx as unknown as Db)).toMatchObject({ kind: "held", reason: "resume_actual_authority_unproven" });
      throw rollback;
    })).rejects.toBe(rollback);
    try {
      await writeFile(w.contentPath, w.originalContent + "changed");
      expect(await read(db)).toMatchObject({ kind: "held", reason: "resume_actual_product_hash_mismatch" });
    } finally { await writeFile(w.contentPath, w.originalContent); }
    expect((await read(db)).kind).toBe("proven");
  }, 120_000);

  it("applies the 3 mechanical remediations via the existing branch without producer re-dispatch", async () => {
    const w = await seedWorld(db, dir, "main");
    const res = await request(createApp(db, w.companyId)).post(`/api/workflow-runs/${w.runId}/resume`).send({});
    expect(res.status).toBe(200);
    // Durable observations FIRST (logged snapshot) so any later assertion failure still leaves
    // the complete native-branch evidence in the run log. No OR-matching, no accepting false completion.
    const [runAfter] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, w.runId));
    const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.runId));
    const remediationEvents = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    const refireWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, w.refireKey));
    const producerWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, w.producerIssueId));
    const productsAfter = await db.select({ id: issueWorkProducts.id, url: issueWorkProducts.url, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata }).from(issueWorkProducts).where(eq(issueWorkProducts.companyId, w.companyId));
    const [producerAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producerStepRunId));
    const runsForMission = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.missionId, w.missionId));
    const bindings = await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.workflowRunId, w.runId));
    const patched = await readFile(w.contentPath, "utf8");
    const snapshot = {
      run: { status: runAfter?.status, version: runAfter?.dispatchAuthorityVersion, completedAt: runAfter?.completedAt },
      authorities: authorities.map((a) => ({ kind: a.recoveryKind, targetVersion: a.targetAuthorityVersion })),
      remediation: remediationEvents.map((e) => ({ decision: e.decision, payload: e.payload })),
      refireWakeCount: refireWakes.length, producerWakeCount: producerWakes.length,
      productCount: productsAfter.length, producerStep: { status: producerAfter?.status, iteration: producerAfter?.iterationIndex, reworkContract: (producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract !== undefined },
      runsForMission: runsForMission.length, bindings: bindings.length,
      patchCounts: FINDS.map(([find, replace]) => [occurrences(patched, find), occurrences(patched, replace)]),
    };
    console.log(`STAGE-A-CORRECTION3-SNAPSHOT ${JSON.stringify(snapshot)}`);
    expect(runAfter?.status).toBe("running");
    expect(runAfter?.dispatchAuthorityVersion).toBe(w.authorityVersion + 1);
    expect(authorities).toHaveLength(1);
    expect(authorities[0]?.recoveryKind).toBe("manual_resume");
    expect(remediationEvents).toHaveLength(1);
    expect(remediationEvents[0]?.payload).toMatchObject({ schemaVersion: "workflow.qa-remediation.complete.v2", producer: { iterationIndex: w.producerIteration }, wakes: [{ wakeupRequestId: refireWakes[0]?.id }] });
    const preparations = await db.select().from(workflowTransitionEvents).where(and(
      eq(workflowTransitionEvents.workflowRunId, w.runId), eq(workflowTransitionEvents.eventType, "qa_remediation_prepared")));
    expect(preparations).toHaveLength(1);
    const preparation = preparations[0]!.payload as { verdicts: Array<{ items: unknown[] }> };
    expect(preparation.verdicts[0]?.items).toHaveLength(3);
    expect(refireWakes).toHaveLength(1);
    // EXACT oracle: sequential single replacement of each (once-occurring) find — F2/F3 replaces
    // embed their find (date append), so zero-find counts are impossible for a correct patch.
    const expected = FINDS.reduce((acc, [find, replace]) => acc.replace(find, replace), w.originalContent);
    expect(patched).toBe(expected);
    for (const [, replace] of FINDS) {
      expect(occurrences(patched, replace)).toBe(occurrences(w.originalContent, replace) + 1);
    }
    expect(FINDS.reduceRight((acc, [find, replace]) => acc.split(replace).join(find), patched)).toBe(w.originalContent);
    for (const [i, p] of w.imagePaths.entries()) expect(await readFile(p, "utf8")).toBe(w.originalImages[i]);
    expect(productsAfter).toHaveLength(w.originalProducts.length);
    for (const before of w.originalProducts) {
      const after = productsAfter.find((row) => row.id === before.id);
      expect(after).toMatchObject({ url: before.url, status: before.status, metadata: before.metadata });
    }
    expect(producerAfter?.status).toBe("completed");
    expect(producerAfter?.iterationIndex).toBe(w.producerIteration);
    expect((producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeUndefined();
    expect(producerWakes.length - w.producerWakeCount).toBe(0);
    expect(runsForMission).toHaveLength(1);
    expect(bindings).toHaveLength(0);
  });

  it("red: post-effect write failure must NOT fall through to producer rework (fail-closed contract)", async () => {
    const w = await seedWorld(db, dir, "readonly", { readonlyContent: true });
    const res = await request(createApp(db, w.companyId)).post(`/api/workflow-runs/${w.runId}/resume`).send({});
    expect(res.status).toBe(200);
    const remediationEvents = await db.select().from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.workflowRunId, w.runId), eq(workflowTransitionEvents.eventType, QA_REMEDIATION_COMPLETION_EVENT_TYPE)));
    expect(remediationEvents).toHaveLength(0);
    const refireWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, w.refireKey));
    expect(refireWakes).toHaveLength(0);
    expect(res.body).toMatchObject({ status: "running" });
    const [producerAfter] = await db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, w.producerStepRunId));
    expect(producerAfter?.status).toBe("completed");
    expect(producerAfter?.iterationIndex).toBe(w.producerIteration);
    expect((producerAfter?.metadata as Record<string, unknown> | null)?.workflowReworkContract).toBeUndefined();
    const producerWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.issueId, w.producerIssueId));
    expect(producerWakes.length - w.producerWakeCount).toBe(0);
    const content = await readFile(w.contentPath, "utf8");
    expect(content).toBe(w.originalContent);
    for (const [find] of FINDS) expect(occurrences(content, find)).toBe(1);
  });
});
