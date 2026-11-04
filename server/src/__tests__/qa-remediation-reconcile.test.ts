// server/src/__tests__/qa-remediation-reconcile.test.ts
//
// Stage B2c1(+correction 3) — 실제 ephemeral Postgres + 실제 임시 파일로 root-only 조정 API 계약 검증.
//   mock DB/lock 없음(B2b fixture 패턴), 동시성은 실제 잠금 대기 관찰(sleep 없음).
//   correction 3(/tmp/b2c-defect-disposition-2317.md): legacy ambiguity pre-IO hold(terminal·payload-only 포함),
//   prior-v2 전 binding, 완전 completion 검증(신규+승계), pending 재진입 실 drain 등록, IO 창구 울타리,
//   completion 게이트 DB 단절(AFTER-IO 회복만 증명 — IO 중 단절 C5 는 미해결로 명시).
//   correction 4(2026-10-30 추가 승인): payload scope·유니크 파일/verdict 커버, prior/승계 공용 wake binding
//   (원본 저장 proof·정확 qa 시도 tuple·의도 대상 agent).
//   correction 5(2026-10-31 추가 승인): completion gate 단절은 patched postgres driver 를 쓰는 실제 DB 시험 안에서
//   barrier 를 먼저 세우고, exact-run INSERT 의 blocker PID 를 관측·종료한 뒤 연결 오류와 두 번의 멱등 재진입을 확인한다.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueWorkProducts, issues, missions,
  startEmbeddedPostgresTestDatabase, workflowDefinitions, workflowRuns, workflowStepRuns,
  workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { seedInternalAdmissionWorld, executeAdmissionFixtureAdapter } from "./helpers/qa-remediation-admission-public-fixture.js";
vi.mock("../adapters/index.js", async original => ({ ...await original<typeof import("../adapters/index.js")>(),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute: executeAdmissionFixtureAdapter }) }));
const fixtureClosers = new Set<() => Promise<void>>();
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { prepareQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-prepare.js";
import { parseQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import {
  parseQaRemediationCompletion, qaRemediationRefireV2WakeKey, legacyQaRemediationRefireWakeKey,
} from "../services/workflow/control-flow/qa-remediation-completion.js";
import { createQaFileOwnerRuntime, QaFileOwnerUnavailableError, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { PYTHON } from "./helpers/qa-remediation-parent-death-harness.js";

const BEFORE = "old flawed draft\n", AFTER = "old polished draft\n";
const BEFORE2 = "old rough notes\n", AFTER2 = "old neat notes\n";
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
const tempDirs: string[] = [];

interface World {
  companyId: string; missionId: string; runId: string; verifier: string; file: string; file2: string | null;
  fileOwnerRuntime: QaFileOwnerRuntime; ownerLockWaits: string[];
  producer: typeof workflowStepRuns.$inferSelect; qa: typeof workflowStepRuns.$inferSelect;
  qaIssue: typeof issues.$inferSelect; verdictId: string; verdictHeartbeatId: string;
}
const req = (w: World) => ({ companyId: w.companyId, missionId: w.missionId, workflowRunId: w.runId,
  producerStepRunId: w.producer.id, qaStepRunIds: [w.qa.id] });
/** 미래 main wrapper 역할: 실제 root notification mapping 등록 — after-commit drain 은 테스트가 소유. */
const reconcile = (w: World, db: Db = owned.db, runtime: QaFileOwnerRuntime = w.fileOwnerRuntime,
  notifications = createReplacementRootNotifications()) =>
  withReplacementRootNotificationDb(db, notifications, () => reconcileQaRemediationReservation(db, req(w), runtime));
const rowsOf = async (w: World, eventType: string, db: Db = owned.db) => (await db.select().from(workflowTransitionEvents)
  .where(eq(workflowTransitionEvents.workflowRunId, w.runId))).filter((r) => r.eventType === eventType);
const v2Wakes = async (w: World, db: Db = owned.db) => (await db.select().from(agentWakeupRequests)
  .where(eq(agentWakeupRequests.companyId, w.companyId))).filter((r) => String(r.idempotencyKey).startsWith("qa-remediation-refire-v2:"));
/** v2 wake 로 실제 실행(heartbeat run)이 없음을 보는 검사 — fixture 의 verdict/admission wake 는 제외. */
const wakeHeartbeatRuns = async (w: World, db: Db = owned.db) => {
  const wakes = await v2Wakes(w, db);
  if (wakes.length === 0) return [];
  return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
    .where(and(eq(agentWakeupRequests.companyId, w.companyId), inArray(agentWakeupRequests.id, wakes.map((r) => r.id))));
};
const asCompleted = (r: { outcome: string; detail?: string }) => {
  if (r.outcome !== "completed") throw new Error(`expected completed, got ${r.outcome}: ${"detail" in r ? r.detail : ""}`);
  return r as { outcome: "completed"; completionEventId: string; created: boolean;
    completion: ReturnType<typeof parseQaRemediationCompletion>;
    publication: { status: string }[]; notifications: { agentIds: readonly string[]; wakeupRequestIds: readonly string[] } };
};
const expectUnknownHold = (result: unknown) => {
  expect(result).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
  return result as { detail?: string };
};
function errorGraph(value: unknown, seen = new Set<object>()): unknown[] {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return [value];
  const object = value as object;
  if (seen.has(object)) return [];
  seen.add(object);
  const nested: unknown[] = [];
  if (value instanceof AggregateError) for (const cause of value.errors) nested.push(...errorGraph(cause, seen));
  if (value instanceof Error) {
    const cause = (value as Error & { readonly cause?: unknown }).cause;
    if (cause !== undefined) nested.push(...errorGraph(cause, seen));
  }
  return [value, ...nested];
}

async function seedWorld(db: Db = owned.db, files: 1 | 2 = 1) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-remediation-reconcile-")));
  tempDirs.push(dir);
  const lockRoot = path.join(dir, ".locks");
  await mkdir(lockRoot, { mode: 0o700 });
  const nativeRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const ownerLockWaits: string[] = [];
  const fileOwnerRuntime: QaFileOwnerRuntime = {
    capability: nativeRuntime.capability,
    begin: (targets, options = {}) => nativeRuntime.begin(targets, { ...options,
      onEvent: (event) => { ownerLockWaits.push(event.target); options.onEvent?.(event); } }),
  };
  const file = path.join(dir, "report.md");
  await writeFile(file, BEFORE, "utf8");
  const file2 = files === 2 ? path.join(dir, "notes.md") : null;
  if (file2) await writeFile(file2, BEFORE2, "utf8");
  const seeded = await seedInternalAdmissionWorld(db, dir, lockRoot,
    { file, bytes: Buffer.from(BEFORE), find: "flawed", replace: "polished",
      ...(file2 ? { second: { bytes: Buffer.from(BEFORE2), find: "rough", replace: "neat" } } : {}) });
  fixtureClosers.add(seeded.close);
  const u = seeded.unit;
  return { companyId: u.companyId, missionId: u.missionId, runId: u.runId, verifier: u.verifierId,
    file: u.file, file2: file2 ? path.join(path.dirname(u.file), "notes.md") : null,
    fileOwnerRuntime, ownerLockWaits, producer: u.producer, qa: u.qa, qaIssue: u.qaIssue,
    verdictId: u.verdictEventId, verdictHeartbeatId: u.verdictHeartbeatId } as World;
}

/**
 * legacy refire wake 흔적 fixture — 실제 legacy enqueueWakeup 산출물의 두 형태:
 *   "queued"/"finished": Task 1C typed columns 를 갖춘 행. "payload_only": typed columns 없이 payload 만
 *   갖는 과거행(마이그레이션 전) — 키 자체가 run+stepRun 을 묶는다. 어느 쪽도 verdict/시도 binding 은 없다.
 */
async function seedLegacyRefireWake(w: World, mode: "queued" | "finished" | "payload_only") {
  const values = {
    companyId: w.companyId, agentId: w.verifier, source: "assignment", triggerDetail: "system",
    reason: "workflow_step_runnable", requestKind: "workflow_resume",
    idempotencyKey: legacyQaRemediationRefireWakeKey(w.runId, w.qa.id),
    payload: { issueId: w.qaIssue.id, mutation: "workflow_resume", missionId: w.missionId,
      workflowRunId: w.runId, workflowStepRunId: w.qa.id, forceFreshSession: true },
    ...(mode === "payload_only" ? {} : {
      status: mode, issueId: w.qaIssue.id, missionId: w.missionId, workflowRunId: w.runId,
      workflowStepRunId: w.qa.id, workflowExecutionGeneration: w.qa.executionGeneration,
      requestedByActorType: "system", requestedByActorId: "workflow:qa-check",
    }),
    ...(mode === "finished" ? { finishedAt: new Date() } : {}),
  };
  const [row] = await owned.db.insert(agentWakeupRequests).values(
    mode === "payload_only" ? { ...values, status: "queued" } : values,
  ).returning({ id: agentWakeupRequests.id });
  return row!.id;
}

describe("reconcileQaRemediationReservation", () => {
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120000);
  afterAll(async () => { await Promise.all([...fixtureClosers].map(close => close())); for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }); await owned?.close(); }, 120000);

  it("completes durably once; reentry recognizes the committed completion; no precommit wake execution", async () => {
    const w = await seedWorld();
    const first = asCompleted(await reconcile(w));
    expect(first.created).toBe(true);
    expect(first.publication[0]).toMatchObject({ file: w.file, status: "applied" });
    expect(await readFile(w.file, "utf8")).toBe(AFTER);
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
    const completion = parseQaRemediationCompletion((await rowsOf(w, "qa_remediation_completed"))[0]!.payload);
    const preparation = parseQaRemediationPreparation((await rowsOf(w, "qa_remediation_prepared"))[0]!.payload);
    expect(completion.verdicts[0]).toMatchObject({ eventId: w.verdictId });
    expect(completion.wakes[0]).toMatchObject({ kind: "v2_refire", agentId: w.verifier, statusAtCommit: "queued" });
    expect(completion.wakes[0]!.idempotencyKey).toBe(qaRemediationRefireV2WakeKey(preparation, w.qa.id, w.verdictId));
    const wakes = await v2Wakes(w);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued", runId: null });
    expect(first.notifications).toEqual({ agentIds: [w.verifier], wakeupRequestIds: [wakes[0]!.id] });
    expect(await wakeHeartbeatRuns(w)).toHaveLength(0); // wake 는 커밋됐고 실행은 drain(after-commit) 소관
    const second = asCompleted(await reconcile(w));
    expect(second.created).toBe(false);
    expect(second.completionEventId).toBe(first.completionEventId);
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
    expect(await v2Wakes(w)).toHaveLength(1);
    expect(await readFile(w.file, "utf8")).toBe(AFTER);
  });

  it("real concurrent owner-lock barrier: both reconcile, exactly one completion and one wake", async () => {
    const w = await seedWorld();
    const controller = await owned.db.$client.reserve(), observer = await owned.connect().$client.reserve();
    const clients = [owned.connect(), owned.connect()];
    let held = false, jobs: Promise<PromiseSettledResult<unknown>[]> | null = null;
    try {
      await controller.unsafe("CREATE OR REPLACE FUNCTION public.qa_complete_b2c_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73126,1); RETURN NEW; END $$");
      await controller.unsafe("CREATE TRIGGER qa_complete_b2c_gate BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_remediation_completed') EXECUTE FUNCTION public.qa_complete_b2c_gate()");
      await controller.unsafe("SELECT pg_advisory_lock(73126,1)"); held = true;
      jobs = Promise.allSettled(clients.map(db => reconcile(w, db)));
      const deadline = Date.now() + 9000;
      for (;;) {
        const rows = await observer.unsafe("SELECT pid, query FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND datname = current_database()");
        const inserter = rows.filter((r) => /insert into "workflow_transition_events"/i.test(String(r.query)));
        if (inserter.length >= 1 && w.ownerLockWaits.includes(w.file)) break;
        if (Date.now() >= deadline) throw new Error("real completion insert wait and native file-owner lock_wait were not observed");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await controller.unsafe("SELECT pg_advisory_unlock(73126,1)"); held = false;
      const settled = await jobs;
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      const results = settled.map((r) => { if (r.status === "rejected") throw r.reason; return asCompleted(r.value as never); });
      expect(results.map((r) => r.outcome)).toEqual(["completed", "completed"]);
      expect(new Set(results.map((r) => r.completionEventId)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
      expect(await v2Wakes(w)).toHaveLength(1);
      expect(await readFile(w.file, "utf8")).toBe(AFTER);
      expect(await wakeHeartbeatRuns(w)).toHaveLength(0);
    } finally {
      if (held) await controller.unsafe("SELECT pg_advisory_unlock(73126,1)");
      try { if (jobs) await jobs; } finally {
        await controller.unsafe("DROP TRIGGER IF EXISTS qa_complete_b2c_gate ON workflow_transition_events");
        await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_complete_b2c_gate()");
        controller.release(); observer.release();
      }
    }
  }, 20000);

  it("cancel/authority change prevent publication and preserve the attempted reservation", async () => {
    const cancelled = await seedWorld();
    await prepareQaRemediationReservation(owned.db, req(cancelled));
    await owned.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, cancelled.runId));
    const afterCancel = await reconcile(cancelled);
    expect(afterCancel).toMatchObject({ outcome: "preparation_held", reason: "unresolved_pending" });
    expect(await readFile(cancelled.file, "utf8")).toBe(BEFORE);
    expect((await rowsOf(cancelled, "qa_remediation_completed"))).toHaveLength(0);
    expect(await v2Wakes(cancelled)).toHaveLength(0);
    expect((await rowsOf(cancelled, "qa_remediation_prepared"))).toHaveLength(1);

    const reauthorized = await seedWorld();
    await prepareQaRemediationReservation(owned.db, req(reauthorized));
    await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(workflowRuns.id, reauthorized.runId));
    const afterAuthority = await reconcile(reauthorized);
    expect(afterAuthority).toMatchObject({ outcome: "preparation_held", reason: "unresolved_conflict" });
    expect(await readFile(reauthorized.file, "utf8")).toBe(BEFORE);
    expect((await rowsOf(reauthorized, "qa_remediation_completed"))).toHaveLength(0);
    expect((await rowsOf(reauthorized, "qa_remediation_prepared"))).toHaveLength(1);
  });

  it("retains unavailable runtime cause as non-enumerable hold evidence", async () => {
    const w = await seedWorld();
    const missingLockRoot = path.join(os.tmpdir(), `qa-remediation-missing-lock-${randomUUID()}`, ".locks");
    const unavailableRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: missingLockRoot, qaFileOwnerPython: PYTHON! });
    const capability = await unavailableRuntime.capability;
    if (capability.status !== "unavailable") throw new Error("expected the missing lock root to make the runtime unavailable");
    expect(capability.error).toBeInstanceOf(QaFileOwnerUnavailableError);
    expect(capability.error.cause).toBeInstanceOf(Error);
    expect((capability.error.cause as { code?: string }).code).toBe("ENOENT");

    const notifications = createReplacementRootNotifications();
    const held = await reconcile(w, owned.db, unavailableRuntime, notifications);
    expect(held).toMatchObject({ outcome: "held", reason: "owner_unavailable",
      detail: "native file-owner acquisition failed: QA file-owner configuration is unavailable" });
    expect((held as { cause?: unknown }).cause).toBe(capability.error);
    expect(Object.keys(held)).not.toContain("cause");
    expect(JSON.stringify(held) ?? "").not.toContain(missingLockRoot);
    expect(notifications.agentIds.size).toBe(0);
    expect(notifications.correctionWakeupRequestIds.size).toBe(0);
    expect(await readFile(w.file, "utf8")).toBe(BEFORE);
    expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1);
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(0);
    expect(await v2Wakes(w)).toHaveLength(0);
  });

  it("completion-tx failure after files applied preserves preparation; retry completes exactly once", async () => {
    const w = await seedWorld();
    const controller = await owned.db.$client.reserve();
    try {
      await controller.unsafe("CREATE FUNCTION public.qa_complete_b2c_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'completion gate failure'; END $$");
      await controller.unsafe("CREATE TRIGGER qa_complete_b2c_fail BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_remediation_completed') EXECUTE FUNCTION public.qa_complete_b2c_fail()");
      const cleanupFailure = new Error("private cleanup evidence sentinel");
      const nativeRuntime = w.fileOwnerRuntime;
      const runtimeWithAbortFailure: QaFileOwnerRuntime = {
        capability: nativeRuntime.capability,
        async begin(targets, options) {
          const owner = await nativeRuntime.begin(targets, options);
          const abortNativeOwner = owner.abort.bind(owner);
          // Stop and observe the real helper first, then inject the abort-channel rejection.
          // This isolates cause preservation without leaving a native child behind.
          Object.defineProperty(owner, "abort", { configurable: true, value: async () => {
            await abortNativeOwner();
            throw cleanupFailure;
          } });
          return owner;
        },
      };
      const failedNotifications = createReplacementRootNotifications();
      const failure = await reconcile(w, owned.db, runtimeWithAbortFailure, failedNotifications);
      expectUnknownHold(failure);
      const retainedCause = (failure as { cause?: unknown }).cause;
      const causes = errorGraph(retainedCause);
      expect(retainedCause).toBeInstanceOf(AggregateError);
      expect(causes).toContain(cleanupFailure);
      expect(causes.some((cause) => cause instanceof Error && cause.message.includes("completion gate failure"))).toBe(true);
      expect(Object.keys(failure)).not.toContain("cause");
      expect(JSON.stringify(failure) ?? "").not.toContain(cleanupFailure.message);
      expect(failedNotifications.agentIds.size).toBe(0);
      expect(failedNotifications.correctionWakeupRequestIds.size).toBe(0);
      // 파일은 이미 after 상태(게시가 completion 이전)지만 completion/wake 는 tx 롤백으로 없다.
      expect(await readFile(w.file, "utf8")).toBe(AFTER);
      expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1);
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(0);
      expect(await v2Wakes(w)).toHaveLength(0); // wake 삽입도 completion tx 안 — 사전 커밋 실행/누출 없음
      await controller.unsafe("DROP TRIGGER qa_complete_b2c_fail ON workflow_transition_events");
      await controller.unsafe("DROP FUNCTION public.qa_complete_b2c_fail()");
      const retried = asCompleted(await reconcile(w));
      expect(retried.created).toBe(true);
      expect(retried.publication[0]).toMatchObject({ status: "already_applied" }); // after bytes 인식 — completion 만 재시도
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
      expect(await v2Wakes(w)).toHaveLength(1);
      expect(await wakeHeartbeatRuns(w)).toHaveLength(0);
      const again = asCompleted(await reconcile(w));
      expect(again.created).toBe(false);
      expect(again.completionEventId).toBe(retried.completionEventId);
      expect(await v2Wakes(w)).toHaveLength(1);
    } finally {
      await controller.unsafe("DROP TRIGGER IF EXISTS qa_complete_b2c_fail ON workflow_transition_events");
      await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_complete_b2c_fail()");
      controller.release();
    }
  }, 20000);

  it("retains close and cleanup errors after committed effects while withholding notifications", async () => {
    const w = await seedWorld();
    const closeFailure = new Error("private close evidence sentinel");
    const cleanupFailure = new Error("private close cleanup evidence sentinel");
    const nativeRuntime = w.fileOwnerRuntime;
    const runtimeWithCloseFailure: QaFileOwnerRuntime = {
      capability: nativeRuntime.capability,
      async begin(targets, options) {
        const owner = await nativeRuntime.begin(targets, options);
        const closeNativeOwner = owner.close.bind(owner);
        const abortNativeOwner = owner.abort.bind(owner);
        // Observe the real clean close first, then inject distinct close/cleanup reporting failures.
        Object.defineProperties(owner, {
          close: { configurable: true, value: async () => { await closeNativeOwner(); throw closeFailure; } },
          abort: { configurable: true, value: async () => { await abortNativeOwner(); throw cleanupFailure; } },
        });
        return owner;
      },
    };
    const notifications = createReplacementRootNotifications();
    const held = await reconcile(w, owned.db, runtimeWithCloseFailure, notifications);
    expect(held).toMatchObject({ outcome: "held", reason: "owner_lost" });
    const causes = errorGraph((held as { cause?: unknown }).cause);
    expect(causes).toContain(closeFailure);
    expect(causes).toContain(cleanupFailure);
    expect(Object.keys(held)).not.toContain("cause");
    expect(JSON.stringify(held) ?? "").not.toContain(closeFailure.message);
    expect(JSON.stringify(held) ?? "").not.toContain(cleanupFailure.message);
    expect(notifications.agentIds.size).toBe(0);
    expect(notifications.correctionWakeupRequestIds.size).toBe(0);
    expect(await readFile(w.file, "utf8")).toBe(AFTER);
    expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1);
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
    expect(await v2Wakes(w)).toHaveLength(1);
    expect(await wakeHeartbeatRuns(w)).toHaveLength(0);
  }, 20000);

  // [neg-1] legacy ambiguity: 어떤 상태의 legacy refire 흔적(in-flight/terminal/payload-only)도
  //   verdict/시도 binding 을 증명하지 못한다 — 인식·차용·v2 중복 발행이 아니라 IO 이전 홀드.
  it.each([
    { mode: "queued" as const, label: "in-flight legacy refire wake" },
    { mode: "finished" as const, label: "terminal legacy refire wake" },
    { mode: "payload_only" as const, label: "payload-only (pre-migration) legacy refire wake" },
  ])("holds pre-IO on $label — no copied-verdict recognition, no v2 duplicate", async ({ mode }) => {
    const w = await seedWorld();
    await seedLegacyRefireWake(w, mode);
    const result = await reconcile(w);
    expect(result).toMatchObject({ outcome: "held", reason: "legacy_wake_scope_unknown" });
    expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1); // 예약은 prepare 단계에서 보존
    expect(await readFile(w.file, "utf8")).toBe(BEFORE); // 홀드는 게시 이전 — bytes 불변
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(0);
    expect(await v2Wakes(w)).toHaveLength(0);
  });

  // [neg-2] 같은 키의 prior v2 행은 전 신원 binding 없이는 절대 재사용하지 않는다.
  it("holds a foreign same-key v2 wake row instead of borrowing it", async () => {
    const w = await seedWorld();
    const prepared = await prepareQaRemediationReservation(owned.db, req(w));
    if (prepared.outcome !== "prepared" && prepared.outcome !== "existing") throw new Error(prepared.detail);
    const key = qaRemediationRefireV2WakeKey(prepared.preparation, w.qa.id, w.verdictId);
    await owned.db.insert(agentWakeupRequests).values({ companyId: w.companyId, agentId: w.verifier,
      source: "assignment", status: "queued", idempotencyKey: key, requestKind: "workflow_resume",
      issueId: randomUUID(), // foreign binding: 이 scope 의 issue 가 아니다
      payload: { issueId: randomUUID(), mutation: "workflow_resume" } });
    expectUnknownHold(await reconcile(w));
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(0); // completion tx 롤백
    expect((await v2Wakes(w))).toHaveLength(1); // seed 한 이물 행만 — 신규 발행/차용 없음
    expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1);
    expect(await readFile(w.file, "utf8")).toBe(AFTER); // 게시 후 표출된 이물 행 — fail-visible 오류, bytes 실적 보존
  });

  // [neg-3] 커밋된 completion 승계는 완전 검증기를 통과해야 한다 — 행/ payload/wake 변조는 hold.
  it.each([
    { label: "outer row column (issueId)", sabotage: async (w: World, eventId: string) => {
      await owned.db.update(workflowTransitionEvents).set({ issueId: randomUUID() }).where(eq(workflowTransitionEvents.id, eventId)); } },
    { label: "payload producer tuple", sabotage: async (w: World, eventId: string) => {
      const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, eventId));
      const payload = { ...row!.payload, producer: { ...(row!.payload.producer as object), iterationIndex: 99 } };
      await owned.db.update(workflowTransitionEvents).set({ payload }).where(eq(workflowTransitionEvents.id, eventId)); } },
    { label: "non-success file status", sabotage: async (w: World, eventId: string) => {
      const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, eventId));
      const files = (row!.payload.files as { file: string; status: string; detail: string }[]).map((f, i) => i === 0 ? { ...f, status: "held" } : f);
      await owned.db.update(workflowTransitionEvents).set({ payload: { ...row!.payload, files } }).where(eq(workflowTransitionEvents.id, eventId)); } },
    { label: "recorded v2 wake row deleted", sabotage: async (w: World, eventId: string) => {
      const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, eventId));
      const wakeId = (row!.payload.wakes as { wakeupRequestId: string }[])[0]!.wakeupRequestId;
      await owned.db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)); } },
  ])("holds on tampered completion evidence: $label", async ({ sabotage }) => {
    const w = await seedWorld();
    const done = asCompleted(await reconcile(w));
    await sabotage(w, done.completionEventId);
    expectUnknownHold(await reconcile(w));
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1); // 기존 완료 행 보존
  });

  // [neg-4] pending 재진입은 실제 root notification mapping 에 drain 을 등록한다(반환만이 아님).
  it("pending reentry registers the drain in the actual root notifications mapping", async () => {
    const w = await seedWorld();
    const first = asCompleted(await reconcile(w));
    const wakeId = first.notifications.wakeupRequestIds[0]!;
    expect(first.notifications.agentIds).toEqual([w.verifier]);
    // 새 wrapper(새 mapping)로 재진입 — 첫 wrapper 가 drain 전에 죽은 상황과 동일.
    const secondMapping = createReplacementRootNotifications();
    const second = await withReplacementRootNotificationDb(owned.db, secondMapping, () =>
      reconcileQaRemediationReservation(owned.db, req(w), w.fileOwnerRuntime));
    const done = asCompleted(second);
    expect(done.created).toBe(false);
    expect(done.notifications).toEqual({ agentIds: [w.verifier], wakeupRequestIds: [wakeId] });
    expect(secondMapping.agentIds.has(w.verifier)).toBe(true); // 실제 등록 — drainReplacementRootNotifications 주체가 본다
    expect(await v2Wakes(w)).toHaveLength(1); // 중복 발행 없음
  });

  // [race-5] IO 창구(잠금 취득→커밋, 게시 포함) 동안의 issue 변경은 잠금으로 직렬화된다:
  //   completion 게이트로 창구를 열어두고, 두 번째 클라이언트의 QA issue 취소가 창구 안에 못 들어가는
  //   것(잠금 대기)을 관찰한다. 취소는 커밋 후에만 반영되고, 이미 완료된 사이클 실적은 보존된다.
  it("issue mutation during the lock/IO window serializes behind the row lock", async () => {
    const w = await seedWorld();
    const controller = await owned.db.$client.reserve(), observer = await owned.connect().$client.reserve();
    const client = owned.connect();
    let held = false, jobs: Promise<PromiseSettledResult<unknown>[]> | null = null;
    try {
      await controller.unsafe("CREATE OR REPLACE FUNCTION public.qa_complete_b2c_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73127,1); RETURN NEW; END $$");
      await controller.unsafe("CREATE TRIGGER qa_complete_b2c_race_gate BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_remediation_completed') EXECUTE FUNCTION public.qa_complete_b2c_gate()");
      await controller.unsafe("SELECT pg_advisory_lock(73127,1)"); held = true;
      const reconcileJob = reconcile(w, client);
      const deadline = Date.now() + 9000;
      let inserterPid: number | null = null;
      for (;;) {
        const rows = await observer.unsafe("SELECT pid, query FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND datname = current_database()");
        const inserter = rows.find((r) => /insert into "workflow_transition_events"/i.test(String(r.query)));
        if (inserter) { inserterPid = Number(inserter.pid); break; }
        if (Date.now() >= deadline) throw new Error("completion-insert barrier wait not observed");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const cancelJob = owned.db.update(issues).set({ status: "cancelled" })
        .where(and(eq(issues.id, w.qaIssue.id), eq(issues.companyId, w.companyId))).returning({ id: issues.id });
      jobs = Promise.allSettled([reconcileJob.then((r) => { if (r.outcome !== "completed") throw new Error(r.detail); return r; }), cancelJob]);
      let sawCancelWait = false;
      const cancelDeadline = Date.now() + 9000;
      for (;;) {
        const rows = await observer.unsafe("SELECT pid, query FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND datname = current_database()");
        const updater = rows.find((r) => /update "issues"/i.test(String(r.query)) && Number(r.pid) !== inserterPid);
        if (updater) { sawCancelWait = true; break; } // 창구 안 진입 차단 — 잠금 대기 관찰
        if (Date.now() >= cancelDeadline) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(sawCancelWait).toBe(true);
      await controller.unsafe("SELECT pg_advisory_unlock(73127,1)"); held = false;
      const settled = await jobs;
      expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
      expect(await readFile(w.file, "utf8")).toBe(AFTER); // 창구 안의 완료 사이클 실적 보존
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
      const [issue] = await owned.db.select().from(issues).where(eq(issues.id, w.qaIssue.id));
      expect(issue!.status).toBe("cancelled"); // 취소는 커밋 후 반영 — 창구 내부 개입 불가 증명
      const reentry = await reconcile(w);
      expect(reentry).toMatchObject({ outcome: "preparation_held", reason: "unresolved_pending" }); // 다음 사이클은 울타리 가시화
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1); // 중복 완료 없음
    } finally {
      if (held) await controller.unsafe("SELECT pg_advisory_unlock(73127,1)");
      try { if (jobs) await jobs; } finally {
        await controller.unsafe("DROP TRIGGER IF EXISTS qa_complete_b2c_race_gate ON workflow_transition_events");
        await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_complete_b2c_gate()");
        await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_complete_b2c_race_gate()");
        controller.release(); observer.release();
      }
    }
  }, 25000);

  // [neg-5 — correction 4] 승계 검증기 나머지 구멍: payload scope 위조, 중복 파일 커버(빠진 예약 파일 대체).
  it("holds on tampered committed completion payload scope during reentry", async () => {
    const w = await seedWorld();
    const first = asCompleted(await reconcile(w));
    const row = (await rowsOf(w, "qa_remediation_completed"))[0]!;
    await owned.db.update(workflowTransitionEvents)
      .set({ payload: { ...first.completion, missionId: randomUUID() } })
      .where(eq(workflowTransitionEvents.id, row.id));
    expectUnknownHold(await reconcile(w));
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1); // 승계 거부 — 새 completion 없음
    expect(await v2Wakes(w)).toHaveLength(1);
  });

  it("holds on duplicated-file cover of a two-file reservation", async () => {
    const w = await seedWorld(owned.db, 2);
    const first = asCompleted(await reconcile(w));
    expect(first.publication).toHaveLength(2);
    expect(await readFile(w.file2!, "utf8")).toBe(AFTER2);
    const row = (await rowsOf(w, "qa_remediation_completed"))[0]!;
    const duplicated = first.completion.files[0]!;
    await owned.db.update(workflowTransitionEvents)
      .set({ payload: { ...first.completion, files: [duplicated, duplicated] } })
      .where(eq(workflowTransitionEvents.id, row.id));
    expectUnknownHold(await reconcile(w));
    expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
    expect(await v2Wakes(w)).toHaveLength(1);
  });

  it("prior same-key pending v2 wake with wrong target agent or without stored proof is never borrowed", async () => {
    const agentCase = await seedWorld();
    await prepareQaRemediationReservation(owned.db, req(agentCase));
    const agentPreparation = parseQaRemediationPreparation((await rowsOf(agentCase, "qa_remediation_prepared"))[0]!.payload);
    const agentKey = qaRemediationRefireV2WakeKey(agentPreparation, agentCase.qa.id, agentCase.verdictId);
    // 전 binding(열/키/포인터/이 행에 정합한 저장 proof)은 갖추고 대상 agent 만 다르다 — agent 규칙의 독립 증명.
    const foreignAgent = randomUUID(), wakeId = randomUUID();
    await owned.db.insert(agents).values({ id: foreignAgent, companyId: agentCase.companyId, name: "Foreign" });
    await owned.db.insert(agentWakeupRequests).values({ id: wakeId, companyId: agentCase.companyId, agentId: foreignAgent,
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable", requestKind: "workflow_resume",
      status: "queued", idempotencyKey: agentKey, issueId: agentCase.qaIssue.id, missionId: agentCase.missionId,
      workflowRunId: agentCase.runId, workflowStepRunId: agentCase.qa.id, workflowExecutionGeneration: agentCase.qa.executionGeneration,
      payload: { qaRemediationCompletion: { preparationEventId: agentPreparation.preparationId, sourceVerdictEventId: agentCase.verdictId },
        __paperclipWorkflowProducerAttempt: { schemaVersion: 1, companyId: agentCase.companyId, agentId: foreignAgent,
          issueId: agentCase.qaIssue.id, missionId: agentCase.missionId, workflowRunId: agentCase.runId,
          stepRunId: agentCase.qa.id, executionGeneration: agentCase.qa.executionGeneration,
          retryCount: agentCase.qa.retryCount, iterationIndex: agentCase.qa.iterationIndex,
          wakeupRequestId: wakeId, parentHeartbeatRunId: null } } });
    expectUnknownHold(await reconcile(agentCase));
    expect((await rowsOf(agentCase, "qa_remediation_completed"))).toHaveLength(0);
    expect(await readFile(agentCase.file, "utf8")).toBe(AFTER); // 게시 IO 는 completion tx 롤백과 무관하게 이미 after

    const proofCase = await seedWorld();
    await prepareQaRemediationReservation(owned.db, req(proofCase));
    const proofPreparation = parseQaRemediationPreparation((await rowsOf(proofCase, "qa_remediation_prepared"))[0]!.payload);
    const proofKey = qaRemediationRefireV2WakeKey(proofPreparation, proofCase.qa.id, proofCase.verdictId);
    // 올바른 대상 agent·전 열·포인터 — 그러나 서버 저장 시도 proof 없음: 포인터만으로는 권위가 아니다(날조 금지).
    await owned.db.insert(agentWakeupRequests).values({ companyId: proofCase.companyId, agentId: proofCase.verifier,
      source: "assignment", triggerDetail: "system", reason: "workflow_step_runnable", requestKind: "workflow_resume",
      status: "queued", idempotencyKey: proofKey, issueId: proofCase.qaIssue.id, missionId: proofCase.missionId,
      workflowRunId: proofCase.runId, workflowStepRunId: proofCase.qa.id, workflowExecutionGeneration: proofCase.qa.executionGeneration,
      payload: { qaRemediationCompletion: { preparationEventId: proofPreparation.preparationId, sourceVerdictEventId: proofCase.verdictId } } });
    expectUnknownHold(await reconcile(proofCase));
    expect((await rowsOf(proofCase, "qa_remediation_completed"))).toHaveLength(0);
  });

  // [neg-6 — correction 4] 커밋된 completion 의 기록 wake 가 이후 변조(scope/pointer/proof)되면 승계 거부.
  //   현재 assignee 와의 비교는 하지 않는다 — 이후의 정상 assignee 변경은 거부되지 않는다(변조만 잡는다).
  it("reentry revalidates recorded wakes and holds on changed scope/pointer/proof", async () => {
    for (const tamper of ["scope", "pointer", "proof"] as const) {
      const w = await seedWorld();
      asCompleted(await reconcile(w));
      const wake = (await v2Wakes(w))[0]!;
      const payload = (wake.payload ?? {}) as Record<string, unknown>;
      if (tamper === "scope") {
        await owned.db.update(agentWakeupRequests).set({ missionId: randomUUID() }).where(eq(agentWakeupRequests.id, wake.id));
      } else if (tamper === "pointer") {
        await owned.db.update(agentWakeupRequests).set({ payload: { ...payload,
          qaRemediationCompletion: { ...(payload.qaRemediationCompletion as Record<string, unknown>), sourceVerdictEventId: randomUUID() } } })
          .where(eq(agentWakeupRequests.id, wake.id));
      } else {
        await owned.db.update(agentWakeupRequests).set({ payload: { ...payload,
          __paperclipWorkflowProducerAttempt: { ...(payload.__paperclipWorkflowProducerAttempt as Record<string, unknown>),
            retryCount: w.qa.retryCount + 1 } } })
          .where(eq(agentWakeupRequests.id, wake.id));
      }
      expectUnknownHold(await reconcile(w));
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1); // 승계 거부 — 중복 완료 없음
      expect(await v2Wakes(w)).toHaveLength(1);
    }
  });

  // [test-6 — correction 5] completion 게이트 백엔드 단절은 같은 Vitest 프로세스 안에서 실제 PostgreSQL 로
  //   관측한다. 테스트는 격리 DB 에서 completion INSERT 전용 trigger/advisory barrier 를 먼저 준비하고,
  //   정확한 run 의 INSERT 가 그 controller PID 에 막힌 것을 확인한 뒤 해당 backend 만 종료한다. 임시
  //   자식은 catch 후 강제 종료로 실제 연결 실패를 감추기 쉬우며 Vitest alias 도 상속하지 않으므로 사용하지 않는다.
  //   이 검증은 AFTER-IO 회복만 증명한다(C5 during-IO loss 미해결 — 트랜잭션 객체가 단절 후 소유권을 보장하지 않는다).
  it("backend termination at the completion gate rolls back completion, preserves preparation, and reentry completes once", async () => {
    const pg = await startEmbeddedPostgresTestDatabase("qa-remediation-term-");
    const term = createDb(pg.connectionString), termObserver = createDb(pg.connectionString);
    const controller = await term.$client.reserve(), observer = await termObserver.$client.reserve();
    const w = await seedWorld(term);
    const notifications = createReplacementRootNotifications();
    let held = false;
    let reconciliation: ReturnType<typeof reconcile> | undefined;
    try {
      const identitySql = "SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port";
      const [controllerIdentity] = await controller.unsafe(identitySql);
      const [observerIdentity] = await observer.unsafe(identitySql);
      const [reconcileIdentity] = await term.$client.unsafe(identitySql);
      expect([observerIdentity?.database, observerIdentity?.address, observerIdentity?.port])
        .toEqual([controllerIdentity?.database, controllerIdentity?.address, controllerIdentity?.port]);
      expect([reconcileIdentity?.database, reconcileIdentity?.address, reconcileIdentity?.port])
        .toEqual([controllerIdentity?.database, controllerIdentity?.address, controllerIdentity?.port]);

      await controller.unsafe("CREATE OR REPLACE FUNCTION public.qa_complete_b2c_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73128,2); RETURN NEW; END $$");
      await controller.unsafe(`CREATE TRIGGER qa_complete_b2c_term_gate BEFORE INSERT ON workflow_transition_events
        FOR EACH ROW WHEN (NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${w.runId}')
        EXECUTE FUNCTION public.qa_complete_b2c_gate()`);
      const [{ pid: controllerPidValue }] = await controller.unsafe("SELECT pg_backend_pid() AS pid");
      const controllerPid = Number(controllerPidValue);
      expect(controllerPid).toBeGreaterThan(0);
      await controller.unsafe("SELECT pg_advisory_lock(73128,2)"); held = true;

      // Trigger and held barrier exist before any reconcile work can start.
      reconciliation = reconcile(w, term, w.fileOwnerRuntime, notifications);
      const deadline = Date.now() + 25000;
      let pid: number | null = null;
      for (;;) {
        const rows = await observer.unsafe(`SELECT activity.pid, activity.query, activity.wait_event_type,
            pg_blocking_pids(activity.pid) AS blocking_pids
          FROM pg_stat_activity AS activity
          WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
            AND activity.wait_event_type = 'Lock' AND $1::integer = ANY(pg_blocking_pids(activity.pid))
            AND activity.query ILIKE '%insert into "workflow_transition_events"%'`, [controllerPid]);
        const blocked = rows.filter((row) => Number(row.pid) > 0);
        if (blocked.length === 1) { pid = Number(blocked[0]!.pid); break; }
        if (Date.now() >= deadline) throw new Error(`exact completion INSERT lock wait not observed (controller=${controllerPid}, matches=${blocked.length})`);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      const [termination] = await observer.unsafe("SELECT pg_terminate_backend($1::integer) AS terminated", [pid]);
      expect(termination?.terminated).toBe(true);
      // Signal acceptance is not the exit proof: wait until the exact owned backend disappears.
      let backendExited = false;
      const exitDeadline = Date.now() + 15000;
      for (;;) {
        const [stillPresent] = await observer.unsafe("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1::integer) AS present", [pid]);
        if (!stillPresent?.present) { backendExited = true; break; }
        if (Date.now() >= exitDeadline) throw new Error(`terminated reconcile backend ${pid} remained in pg_stat_activity`);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(backendExited).toBe(true);

      const outcome = await reconciliation;
      expect(outcome).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
      if (outcome.outcome !== "held") throw new Error("terminated transaction was not held");
      expect(outcome.cause).toBeInstanceOf(Error);
      const connectionFailure = outcome.cause as Error & { code?: unknown; errno?: unknown };
      expect(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "57P01"].includes(String(connectionFailure.code))).toBe(true);
      expect(connectionFailure.message).toMatch(/connection|terminat|closed|destroy/i);
      expect(connectionFailure.errno === undefined || String(connectionFailure.errno) === String(connectionFailure.code)).toBe(true);
      expect(notifications.agentIds.size).toBe(0);
      expect(notifications.correctionWakeupRequestIds.size).toBe(0);

      await controller.unsafe("SELECT pg_advisory_unlock(73128,2)"); held = false;
      expect((await rowsOf(w, "qa_remediation_prepared", term))).toHaveLength(1); // 내구 예약은 보존
      expect((await rowsOf(w, "qa_remediation_completed", term))).toHaveLength(0); // completion 은 롤백
      expect(await v2Wakes(w, term)).toHaveLength(0); // wake 삽입도 함께 롤백
      expect(await readFile(w.file, "utf8")).toBe(AFTER); // IO 이후 단절 — after bytes 유지
      const reentry = asCompleted(await reconcile(w, term)); // 재진입은 completion 만 재시도
      expect(reentry.created).toBe(true);
      expect(reentry.publication[0]).toMatchObject({ status: "already_applied" });
      expect((await rowsOf(w, "qa_remediation_prepared", term))).toHaveLength(1);
      expect((await rowsOf(w, "qa_remediation_completed", term))).toHaveLength(1);
      expect(await v2Wakes(w, term)).toHaveLength(1);
      const secondReentry = asCompleted(await reconcile(w, term));
      expect(secondReentry.created).toBe(false);
      expect(secondReentry.completionEventId).toBe(reentry.completionEventId);
      expect(secondReentry.publication[0]).toMatchObject({ status: "already_applied" });
      expect((await rowsOf(w, "qa_remediation_completed", term))).toHaveLength(1);
      expect(await v2Wakes(w, term)).toHaveLength(1);
      expect(await readFile(w.file, "utf8")).toBe(AFTER);
      expect(await wakeHeartbeatRuns(w, term)).toHaveLength(0);
    } finally {
      if (held) await controller.unsafe("SELECT pg_advisory_unlock(73128,2)");
      if (reconciliation) await Promise.allSettled([reconciliation]);
      await controller.unsafe("DROP TRIGGER IF EXISTS qa_complete_b2c_term_gate ON workflow_transition_events");
      await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_complete_b2c_gate()");
      controller.release(); observer.release();
      await Promise.allSettled([term.$client.end({ timeout: 5 }), termObserver.$client.end({ timeout: 5 })]);
      await pg.cleanup();
    }
  }, 60000);
});
