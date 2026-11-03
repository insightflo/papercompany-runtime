// server/src/__tests__/qa-remediation-owner-loss.test.ts
//
// [purpose] C5 owner-loss fixture for the current root contract. A real Python file-owner child pauses
// immediately before os.replace; terminating the owning PostgreSQL backend must make the root kill and
// observe that exact child before a later root continues the same durable preparation once.
// [evidence] Real ephemeral PostgreSQL, real transaction/backend termination, real native helper and
// os.replace barrier, exact child PID/signal, preserved preparation/completion/wake bindings, no heartbeat
// execution, and a post-cancel byte fence. No filesystem or native-helper mock stands in for the effect.
// [cleanup] The owned child is aborted in failure cleanup, the barrier socket and private temp tree close,
// and the controller DB reservation is released before the fixture closes.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, heartbeatRuns, issueWorkProducts, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { parseQaRemediationCompletion } from "../services/workflow/control-flow/qa-remediation-completion.js";
import { parseQaRemediationPreparation } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { QaRemediationFileOwner } from "../services/workflow/control-flow/qa-remediation-file-owner.js";
import { createQaFileOwnerRuntime, type QaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import { reconcileQaRemediationReservation } from "../services/workflow/control-flow/qa-remediation-reconcile.js";
import { createReplacementRootNotifications, withReplacementRootNotificationDb } from "../services/issue-assignment-wakeup.js";
import { createRenameBarrier, NATIVE_HELPER, PYTHON, waitForProcessExit, within } from "./helpers/qa-remediation-parent-death-harness.js";

const BEFORE = "old flawed draft\n", AFTER = "old polished draft\n";
/** 취소 전환 후 적법한 소유자(운영자/생산자 다음 주기)가 기록한 것으로 설정하는 fixture 내용. */
const NEWER = "post-cancel owner replacement\n";
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
const tempDirs: string[] = [];

interface World {
  companyId: string; missionId: string; runId: string; verifier: string; file: string; lockRoot: string;
  fileOwnerRuntime: ReturnType<typeof createQaFileOwnerRuntime>;
  producer: typeof workflowStepRuns.$inferSelect; qa: typeof workflowStepRuns.$inferSelect;
  producerIssue: typeof issues.$inferSelect; qaIssue: typeof issues.$inferSelect;
  verdictId: string; verdictHeartbeatId: string;
}
const req = (w: World) => ({ companyId: w.companyId, missionId: w.missionId, workflowRunId: w.runId,
  producerStepRunId: w.producer.id, qaStepRunIds: [w.qa.id] });
function runtimeWithHelper(lockRoot: string, helperPath: string, owners: QaRemediationFileOwner[]): QaFileOwnerRuntime {
  return {
    capability: Promise.resolve({ status: "configured", scope: "configuration-only", lockRoot, pythonCommand: PYTHON!, helperPath }),
    async begin(targets, options = {}) {
      const owner = await QaRemediationFileOwner.begin({ lockRoot, targets, pythonCommand: PYTHON!, helperPath,
        onEvent: options.onEvent, signal: options.signal });
      owners.push(owner);
      return owner;
    },
  };
}
/** 실제 root reconcile 진입 — 실제 notification mapping 등록(after-commit drain 은 테스트 소유). */
const reconcile = (w: World, db: Db, runtime: QaFileOwnerRuntime = w.fileOwnerRuntime) =>
  withReplacementRootNotificationDb(db, createReplacementRootNotifications(), () => reconcileQaRemediationReservation(db, req(w), runtime));
const rowsOf = async (w: World, eventType: string) => (await owned.db.select().from(workflowTransitionEvents)
  .where(eq(workflowTransitionEvents.workflowRunId, w.runId))).filter((r) => r.eventType === eventType);
const v2Wakes = async (w: World) => (await owned.db.select().from(agentWakeupRequests)
  .where(eq(agentWakeupRequests.companyId, w.companyId))).filter((r) => String(r.idempotencyKey).startsWith("qa-remediation-refire-v2:"));
const wakeHeartbeatRuns = async (w: World) => {
  const wakes = await v2Wakes(w);
  if (wakes.length === 0) return [];
  return owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, eq(heartbeatRuns.wakeupRequestId, agentWakeupRequests.id))
    .where(and(eq(agentWakeupRequests.companyId, w.companyId), inArray(agentWakeupRequests.id, wakes.map((r) => r.id))));
};
const asCompleted = (r: { outcome: string; detail?: string }) => {
  if (r.outcome !== "completed") throw new Error(`expected completed, got ${r.outcome}: ${"detail" in r ? r.detail : ""}`);
  return r as { outcome: "completed"; completionEventId: string; created: boolean;
    completion: ReturnType<typeof parseQaRemediationCompletion>;
    publication: { status: string }[]; notifications: { agentIds: readonly string[]; wakeupRequestIds: readonly string[] } };
};
/** 결정론적 관찰 폴 — 임의 sleep 없음. probe 가 undefined 아닌 값을 돌려주면 그 값으로 즉시 반환. */
const observe = async <T>(label: string, deadlineMs: number, probe: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`observation deadline exceeded: ${label} — missing signal is not proof`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** qa-remediation-reconcile.test.ts seedWorld 와 동일한 실제 세계(실제 PG 행 + 실제 파일). */
async function seedWorld() {
  const db = owned.db;
  const companyId = randomUUID(), author = randomUUID(), verifier = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Owner-loss repro", issuePrefix: `OL${companyId.slice(0, 8)}` });
  await db.insert(agents).values([{ id: author, companyId, name: "Producer" }, { id: verifier, companyId, name: "Verifier" }]);
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-remediation-owner-loss-")));
  tempDirs.push(dir);
  const lockRoot = path.join(dir, ".locks");
  await mkdir(lockRoot, { mode: 0o700 });
  const fileOwnerRuntime = createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! });
  const file = path.join(dir, "report.md");
  await writeFile(file, BEFORE, "utf8");
  const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, title: "Owner-loss fixture", ownerAgentId: author, status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Owner-loss fixture", stepsJson: [
    { id: "produce", name: "Produce", agentId: author, dependencies: [],
      conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
    { id: "qa-check", name: "QA", agentId: verifier, dependencies: ["produce"] },
  ] });
  await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
  const [producerIssue] = await db.insert(issues).values({ companyId, missionId, title: "Produce", status: "done", originKind: "workflow_execution" }).returning();
  const [qaIssue] = await db.insert(issues).values({ companyId, missionId, title: "[QA] Check", status: "todo", originKind: "workflow_execution" }).returning();
  const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "produce",
    issueId: producerIssue!.id, status: "completed", completedAt: new Date(Date.now() - 2000) }).returning();
  const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "qa-check", issueId: qaIssue!.id, status: "failed" }).returning();
  await admittedProducer(db, { companyId, agentId: author, issueId: producerIssue!.id, stepRunId: producer!.id, heartbeatId: randomUUID() });
  const wakeId = randomUUID(), heartbeatId = randomUUID();
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId: verifier, source: "workflow.dispatch", workflowStepRunId: qa!.id });
  await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId: verifier, issueId: qaIssue!.id,
    wakeupRequestId: wakeId, status: "succeeded", createdAt: new Date(Date.now() - 1000) });
  await recordWorkflowValidationVerdict({ db, issue: qaIssue!, source: "workflow_api", verdict: "request_changes",
    heartbeatRunId: heartbeatId, remediations: { items: [{ op: "string_replace", file, find: "flawed", replace: "polished" }] } });
  const [verdict] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId));
  await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue!.id, type: "file",
    provider: "local_file", title: "report", status: "active", metadata: { path: file } });
  return { companyId, missionId, runId, verifier, file, lockRoot, fileOwnerRuntime, producer: producer!, qa: qa!,
    producerIssue: producerIssue!, qaIssue: qaIssue!, verdictId: verdict!.id, verdictHeartbeatId: heartbeatId } as World;
}

describe("qa-remediation owner loss during native IO (C5)", () => {
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120000);
  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
    await owned?.close();
  }, 120000);

  it("kills the exact native owner before os.replace, then continues the durable attempt exactly once", async () => {
    const w = await seedWorld();
    const controller = await owned.db.$client.reserve();
    const barrierDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-remediation-owner-gate-")));
    tempDirs.push(barrierDir);
    const barrier = await createRenameBarrier(barrierDir, NATIVE_HELPER);
    const firstOwners: QaRemediationFileOwner[] = [];
    let firstSettled: PromiseSettledResult<unknown> | null = null;
    let tracked1: Promise<unknown> = Promise.resolve();
    try {
      const baseline = new Set((await controller.unsafe(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database()",
      )).map((row) => Number((row as unknown as { pid: number }).pid)));

      const client1 = owned.connect();
      const job1 = reconcile(w, client1, runtimeWithHelper(w.lockRoot, barrier.helperPath, firstOwners));
      tracked1 = job1.then(
        (value) => { firstSettled = { status: "fulfilled", value }; return value; },
        (reason) => { firstSettled = { status: "rejected", reason }; return undefined; },
      );
      const hit = await within(barrier.before, "native os.replace before-effect barrier", 15000);
      expect(hit.dst).toBe(w.file);
      expect(path.dirname(hit.src)).toBe(path.dirname(w.file));
      expect(path.basename(hit.src)).toMatch(/^\.c5pub-/);
      expect(Number.isInteger(hit.helperPid)).toBe(true);
      expect(hit.parentPid).toBe(process.pid);

      const writerPid = await observe("first root backend holding the reservation while native owner is paused", 9000, async () => {
        const rows = await controller.unsafe(
          "SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid " +
          "WHERE a.datname = current_database() AND a.state = 'idle in transaction' " +
          "AND l.locktype = 'relation' AND l.mode = 'RowShareLock' " +
          "AND l.relation = 'workflow_transition_events'::regclass AND a.pid <> pg_backend_pid()",
        );
        const candidates = rows.map((row) => Number((row as unknown as { pid: number }).pid)).filter((pid) => !baseline.has(pid));
        if (candidates.length === 1) return candidates[0]!;
        if (candidates.length > 1) throw new Error(`ambiguous first-root backends: ${candidates.join(",")} — refusing to terminate`);
        return undefined;
      });
      expect(Number.isInteger(writerPid)).toBe(true);

      const terminated = await controller.unsafe(`SELECT pg_terminate_backend(${writerPid}) AS ok`);
      expect(Boolean((terminated as unknown as { ok: boolean }[])[0]!.ok)).toBe(true);
      await observe("terminated first-root backend disappears", 9000, async () => {
        const rows = await controller.unsafe(`SELECT pid FROM pg_stat_activity WHERE pid = ${writerPid}`);
        return rows.length === 0 ? true : undefined;
      });
      await tracked1;
      const settled = firstSettled as PromiseSettledResult<unknown> | null;
      if (!settled || settled.status !== "fulfilled") {
        throw new Error(`first root did not return its held result: ${settled?.status ?? "missing"}`);
      }
      expect(settled.value).toMatchObject({ outcome: "held", reason: "transaction_outcome_unknown" });
      expect((settled.value as { detail?: string }).detail).toContain("notifications were withheld");
      expect(firstOwners).toHaveLength(1);
      expect(await firstOwners[0]!.awaitExit()).toEqual({ code: null, signal: "SIGKILL" });
      const helperState = await waitForProcessExit(hit.helperPid);
      expect(helperState === null || helperState.startsWith("Z")).toBe(true);
      expect(barrier.hits.map((event) => event.phase)).toEqual(["before"]);
      expect(await readFile(w.file, "utf8")).toBe(BEFORE);

      const result2 = asCompleted(await reconcile(w, owned.connect()));
      expect(result2.created).toBe(true);
      const preparedRows = await rowsOf(w, "qa_remediation_prepared");
      const completionRows = await rowsOf(w, "qa_remediation_completed");
      expect(preparedRows).toHaveLength(1);
      expect(completionRows).toHaveLength(1);
      const preparation = parseQaRemediationPreparation(preparedRows[0]!.payload);
      expect(result2.completion.preparationId).toBe(preparedRows[0]!.id);
      expect(result2.completion.completionId).toBe(completionRows[0]!.id);
      expect(result2.completion.producer).toEqual(preparation.producer);
      expect(result2.completion.verdicts).toEqual(preparation.verdicts.map(({ eventId, heartbeatRunId, qa, remediationsHash }) =>
        ({ eventId, heartbeatRunId, qa, remediationsHash })));
      expect(await v2Wakes(w)).toHaveLength(1);
      expect(await wakeHeartbeatRuns(w)).toHaveLength(0);
      expect(await readFile(w.file, "utf8")).toBe(AFTER);

      await owned.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, w.runId));
      await writeFile(w.file, NEWER, "utf8");
      expect(await readFile(w.file, "utf8")).toBe(NEWER);
      expect(barrier.hits.map((event) => event.phase)).toEqual(["before"]);
      expect((await rowsOf(w, "qa_remediation_prepared"))).toHaveLength(1);
      expect((await rowsOf(w, "qa_remediation_completed"))).toHaveLength(1);
      expect(await v2Wakes(w)).toHaveLength(1);
      expect(await wakeHeartbeatRuns(w)).toHaveLength(0);
      const producerIssue = (await owned.db.select().from(issues).where(eq(issues.id, w.producerIssue.id)))[0]!;
      expect(producerIssue.status).toBe("done");
    } finally {
      if (firstOwners[0]) await firstOwners[0].abort();
      await tracked1;
      await barrier.close();
      controller.release();
    }
  }, 60000);
});
