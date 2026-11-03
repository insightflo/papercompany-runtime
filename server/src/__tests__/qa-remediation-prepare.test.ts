// server/src/__tests__/qa-remediation-prepare.test.ts
//
// Stage B2b — 실제 ephemeral Postgres + 실제 임시 파일로 root-only 예약 API 계약 검증.
//   mock DB/lock 없음(기존 qa-correction fixture 패턴), 동시성은 실제 잠금 대기 관측(sleep 없음).
//   실행은 main 소관 — 이 파일 작성 시점 기준 NOT_RUN.

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests, agents, companies, heartbeatRuns, issueWorkProducts, issues, missions,
  workflowDefinitions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db,
} from "@paperclipai/db";
import { recordWorkflowValidationVerdict } from "../services/workflow/validation-verdict-ledger.js";
import { admittedProducer } from "./helpers/admitted-producer.js";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { remediationIdempotencyKey } from "../services/workflow/control-flow/qa-remediation-contract.js";
import { parseQaRemediationPreparation, qaRemediationPreparationKey } from "../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { prepareQaRemediationReservation, type QaRemediationPreparationPassResult } from "../services/workflow/control-flow/qa-remediation-prepare.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const BEFORE = "old flawed draft\n", AFTER = "old polished draft\n";
let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
/** 이 파일이 만든 mkdtemp 디렉터리만 추적해 afterAll 에서 실제 rm 으로 정리(외부 경로 미건드림). */
const tempDirs: string[] = [];

interface World {
  companyId: string; missionId: string; runId: string; verifier: string; file: string;
  producer: typeof workflowStepRuns.$inferSelect; qa: typeof workflowStepRuns.$inferSelect;
  qaIssue: typeof issues.$inferSelect; verdictId: string; verdictHeartbeatId: string;
}
const req = (w: World) => ({ companyId: w.companyId, missionId: w.missionId, workflowRunId: w.runId,
  producerStepRunId: w.producer.id, qaStepRunIds: [w.qa.id] });
const prepare = (w: World, db: Db = owned.db) => prepareQaRemediationReservation(db, req(w));
const asIssued = (r: QaRemediationPreparationPassResult) => {
  if (r.outcome !== "prepared" && r.outcome !== "existing") throw new Error(`expected prepared/existing, got ${r.outcome}: ${r.detail}`);
  return r;
};
const prepRows = async (w: World) => (await owned.db.select({ id: workflowTransitionEvents.id, eventType: workflowTransitionEvents.eventType })
  .from(workflowTransitionEvents).where(eq(workflowTransitionEvents.workflowRunId, w.runId)))
  .filter(r => r.eventType === "qa_remediation_prepared");

async function seedWorld(findings?: { id: string; summary: string; layer: "source_data" | "artifact" }[]) {
  const db = owned.db;
  const companyId = randomUUID(), author = randomUUID(), verifier = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Prepare owner", issuePrefix: `PB${companyId.slice(0, 8)}` });
  await db.insert(agents).values([{ id: author, companyId, name: "Producer" }, { id: verifier, companyId, name: "Verifier" }]);
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-remediation-prepare-")));
  tempDirs.push(dir);
  const file = path.join(dir, "report.md");
  await writeFile(file, BEFORE, "utf8");
  const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
  await db.insert(missions).values({ id: missionId, companyId, title: "Prepare fixture", ownerAgentId: author, status: "active" });
  await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Prepare fixture", stepsJson: [
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
    heartbeatRunId: heartbeatId, ...(findings ? { findings } : {}),
    remediations: { items: [{ op: "string_replace", file, find: "flawed", replace: "polished" }] } });
  const [verdict] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId));
  await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue!.id, type: "file",
    provider: "local_file", title: "report", status: "active", metadata: { path: file } });
  return { companyId, missionId, runId, verifier, file, producer: producer!, qa: qa!, qaIssue: qaIssue!,
    verdictId: verdict!.id, verdictHeartbeatId: heartbeatId } as World;
}

/** 이후 실행(더 최신 heartbeat; verdict 는 선택) — fixture appendQaVerdict 패턴. */
async function newWakeHeartbeat(w: World) {
  const wakeId = randomUUID(), heartbeatId = randomUUID(), later = new Date(Date.now() + 5000);
  await owned.db.insert(agentWakeupRequests).values({ id: wakeId, companyId: w.companyId,
    agentId: w.verifier, source: "workflow.dispatch", workflowStepRunId: w.qa.id });
  await owned.db.insert(heartbeatRuns).values({ id: heartbeatId, companyId: w.companyId, agentId: w.verifier,
    issueId: w.qaIssue.id, wakeupRequestId: wakeId, status: "succeeded", createdAt: later });
  return { heartbeatId, later };
}

async function laterHeartbeat(w: World, verdict: "pass" | "request_changes") {
  const { heartbeatId, later } = await newWakeHeartbeat(w);
  await recordWorkflowValidationVerdict({ db: owned.db, issue: w.qaIssue, source: "workflow_api",
    verdict, ...(verdict === "request_changes"
      ? { remediations: { items: [{ op: "string_replace", file: w.file, find: "flawed", replace: "polished" }] } }
      : {}), heartbeatRunId: heartbeatId });
  const [event] = await owned.db.update(workflowTransitionEvents).set({ createdAt: later })
    .where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId)).returning();
  return event!.id;
}

describe("prepareQaRemediationReservation", () => {
  beforeAll(async () => { owned = await createQaCorrectionTestDb(); }, 120000);
  afterAll(async () => { for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }); await owned?.close(); }, 120000);

  it("reserves durably before any effect: schema-valid record, no file bytes change, no wakes", async () => {
    const w = await seedWorld();
    const wakesBefore = (await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId))).length;
    const result = asIssued(await prepare(w));
    expect(result.outcome).toBe("prepared");
    const [row] = await owned.db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, result.preparationEventId));
    expect(row.eventType).toBe("qa_remediation_prepared");
    expect(row.layer).toBe("workflow_validation");
    expect(row.idempotencyKey).toBe(qaRemediationPreparationKey(result.preparation));
    const parsed = parseQaRemediationPreparation(row.payload);
    expect(parsed.preparationId).toBe(row.id);
    expect(parsed.files[0]).toMatchObject({ path: w.file, beforeSha256: sha(BEFORE), afterSha256: sha(AFTER),
      beforeByteSize: Buffer.byteLength(BEFORE), afterByteSize: Buffer.byteLength(AFTER) });
    expect(await readFile(w.file, "utf8")).toBe(BEFORE);
    expect((await owned.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, w.companyId))).length).toBe(wakesBefore);
  });

  it("returns existing without a second reservation when bytes already sit at the after identity", async () => {
    const w = await seedWorld();
    const first = asIssued(await prepare(w));
    await writeFile(w.file, AFTER, "utf8");
    const second = asIssued(await prepare(w));
    expect(second.outcome).toBe("existing");
    expect(second.preparationEventId).toBe(first.preparationEventId);
    expect(second.preparation).toEqual(first.preparation);
    expect(await readFile(w.file, "utf8")).toBe(AFTER);
    expect(await prepRows(w)).toHaveLength(1);
  });

  it("preserves the pending reservation when a newer heartbeat supersedes execution freshness", async () => {
    const w = await seedWorld();
    const first = asIssued(await prepare(w));
    await newWakeHeartbeat(w); // 더 최신 heartbeat, 아직 새 verdict 없음 → 기존 verdict 로 existing
    const second = asIssued(await prepare(w));
    expect(second.outcome).toBe("existing");
    expect(second.preparationEventId).toBe(first.preparationEventId);
    expect(await prepRows(w)).toHaveLength(1);
  });

  it("holds (never not_applicable) when the latest verdict is unresolvable but a pending reservation exists", async () => {
    const w = await seedWorld();
    await prepare(w);
    await laterHeartbeat(w, "pass"); // 최신 공식 verdict = pass → remediations 원천 없음
    const result = await prepare(w);
    expect(result).toMatchObject({ outcome: "held", reason: "unresolved_pending" });
    expect(await prepRows(w)).toHaveLength(1);
  });

  it("a newer request_changes verdict reserves its own record and never borrows the previous one", async () => {
    const w = await seedWorld();
    const first = asIssued(await prepare(w));
    const newerVerdictId = await laterHeartbeat(w, "request_changes");
    const second = asIssued(await prepare(w));
    expect(second.outcome).toBe("prepared");
    expect(second.preparation.verdicts[0]!.eventId).toBe(newerVerdictId);
    expect(second.preparationEventId).not.toBe(first.preparationEventId);
    expect(await prepRows(w)).toHaveLength(2);
  });

  it("a changed dispatch authority version on the same verdict holds the existing reservation without borrowing", async () => {
    const w = await seedWorld();
    const first = asIssued(await prepare(w));
    await owned.db.update(workflowRuns).set({ dispatchAuthorityVersion: 2 }).where(eq(workflowRuns.id, w.runId));
    const second = await prepare(w);
    // 내구 예약 키(company/run/producer/verdict)에는 권한 버전이 없다 — 같은 verdict 는 같은 키로 충돌하고 재독기도
    // 권한 불일치로 exact 예약을 확정하지 못한다. 새 예약도 기존 예약 승계도 아닌 홀드가 정확하다(차용 아님).
    expect(second).toMatchObject({ outcome: "held", reason: "unresolved_conflict" });
    expect(second.detail).toContain("idempotency-key conflict");
    expect((await prepRows(w)).map(r => r.id)).toEqual([first.preparationEventId]);
  });

  it("scoped legacy applied/write_failed evidence holds instead of producer fallback", async () => {
    const w = await seedWorld();
    await owned.db.insert(workflowTransitionEvents).values({
      companyId: w.companyId, missionId: w.missionId, workflowRunId: w.runId, workflowStepRunId: w.qa.id,
      issueId: w.qaIssue.id, heartbeatRunId: w.verdictHeartbeatId, executionGeneration: w.qa.executionGeneration,
      eventType: "qa_remediation_applied", layer: "workflow_validation", decision: "mechanical_remediation_write_failed",
      verdict: "request_changes", reason: "workflow_api", reasonCode: "qa_remediation",
      idempotencyKey: remediationIdempotencyKey(w.companyId, w.qa.id, w.verdictId),
      payload: { kind: "qa_remediation_applied", outcome: "write_failed", producerStepId: "produce",
        producerStepRunId: w.producer.id, producerIteration: w.producer.iterationIndex ?? 0, qaStepId: "qa-check",
        sourceVerdictEventId: w.verdictId, appliedAt: new Date().toISOString(),
        items: [{ op: "string_replace", file: w.file, find: "flawed", replace: "polished" }] },
    });
    const result = await prepare(w);
    expect(result).toMatchObject({ outcome: "held", reason: "legacy_effect" });
    expect(await prepRows(w)).toHaveLength(0);
  });

  it("a cancelled run holds attempted effects instead of wiping them as not_applicable", async () => {
    const w = await seedWorld();
    await prepare(w);
    await owned.db.update(workflowRuns).set({ status: "cancelled" }).where(eq(workflowRuns.id, w.runId));
    const result = await prepare(w);
    expect(result).toMatchObject({ outcome: "held", reason: "unresolved_pending" });
    expect(result.detail).toContain("cancelled");
    expect(await prepRows(w)).toHaveLength(1); // 시도된 예약은 보존 — existing 권한 부여·새 예약 없음
  });

  it.each([
    { label: "mission cancelled", sabotage: async (w: World) => { await owned.db.update(missions).set({ status: "cancelled" }).where(eq(missions.id, w.missionId)); } },
    { label: "qa issue hidden", sabotage: async (w: World) => { await owned.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, w.qaIssue.id)); } },
    { label: "producer attempt missing issue binding", sabotage: async (w: World) => { await owned.db.update(workflowStepRuns).set({ issueId: null }).where(eq(workflowStepRuns.id, w.producer.id)); } },
    { label: "producer issue hidden", sabotage: async (w: World) => { await owned.db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, w.producer.issueId!)); } },
    { label: "qa issue cancelled", sabotage: async (w: World) => { await owned.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, w.qaIssue.id)); } },
  ])("cancellation/hidden fences refuse clean scopes but hold attempted effects ($label)", async ({ sabotage }) => {
    const fresh = await seedWorld();
    await sabotage(fresh);
    expect((await prepare(fresh)).outcome).toBe("not_applicable");
    expect(await prepRows(fresh)).toHaveLength(0);
    const attempted = await seedWorld();
    await prepare(attempted);
    await sabotage(attempted);
    expect(await prepare(attempted)).toMatchObject({ outcome: "held", reason: "unresolved_pending" });
    expect(await prepRows(attempted)).toHaveLength(1);
  });

  it("counts unfinished durable reservations toward the cap and holds", async () => {
    const w = await seedWorld();
    // 상한은 실제 미완료 예약 3건으로 채운다 — 권한 버전 올림(같은 verdict → 같은 내구 키 충돌)이 아니라 매번
    // 새 공식 request_changes verdict 로 고유 예약 키를 만든다(순차 await 라 createdAt 순서 결정적, sleep 없음).
    for (let n = 1; n <= 3; n++) {
      expect((await prepare(w)).outcome).toBe("prepared");
      await laterHeartbeat(w, "request_changes");
    }
    const capped = await prepare(w);
    expect(capped).toMatchObject({ outcome: "held", reason: "reservation_cap" });
    expect(await prepRows(w)).toHaveLength(3);
  });

  it("keeps the shared source_data eligibility refusal (history-first does not bypass it)", async () => {
    const w = await seedWorld([{ id: "F1", summary: "wrong upstream data", layer: "source_data" }]);
    const result = await prepare(w);
    expect(result.outcome).toBe("not_applicable");
    expect(result.detail).toContain("source_data");
    expect(await prepRows(w)).toHaveLength(0);
  });

  it("rejects a caller-supplied transaction (root-only)", async () => {
    const w = await seedWorld();
    await expect(owned.db.transaction(tx =>
      prepare(w, tx as unknown as Db))).rejects.toMatchObject({ reason: "nested_caller" });
  });

  it("concurrent same-scope reservations leave exactly one record (real DB lock barriers)", async () => {
    const w = await seedWorld();
    const controller = await owned.db.$client.reserve(), observer = await owned.connect().$client.reserve();
    const clients = [owned.connect(), owned.connect()];
    let held = false, jobs: Promise<PromiseSettledResult<QaRemediationPreparationPassResult>[]> | null = null;
    try {
      await controller.unsafe("CREATE FUNCTION public.qa_prepare_b2b_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(73123,1); RETURN NEW; END $$");
      await controller.unsafe("CREATE TRIGGER qa_prepare_b2b_gate BEFORE INSERT ON workflow_transition_events FOR EACH ROW WHEN (NEW.event_type = 'qa_remediation_prepared') EXECUTE FUNCTION public.qa_prepare_b2b_gate()");
      await controller.unsafe("SELECT pg_advisory_lock(73123,1)"); held = true;
      const [holder] = await controller.unsafe("SELECT pg_backend_pid() AS pid");
      jobs = Promise.allSettled(clients.map(db => prepare(w, db)));
      const deadline = Date.now() + 8000;
      for (;;) {
        const rows = await observer.unsafe("SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND datname = current_database()");
        const reachesHolder = (pid: number, seen = new Set<number>()): boolean => {
          if (pid === Number(holder!.pid)) return true;
          if (seen.has(pid)) return false;
          const row = rows.find(r => Number(r.pid) === pid);
          return !!row && (row.blockers as number[]).some(next => reachesHolder(Number(next), new Set(seen).add(pid)));
        };
        const waiting = rows.filter(r => reachesHolder(Number(r.pid)));
        if (waiting.length === 2 && new Set(waiting.map(r => r.pid)).size === 2
          && waiting.some(r => /workflow_transition_events/.test(String(r.query)))
          && waiting.some(r => /missions|workflow_runs/.test(String(r.query)))) break;
        if (Date.now() >= deadline) throw new Error("two real DB lock waits not observed");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await controller.unsafe("SELECT pg_advisory_unlock(73123,1)"); held = false;
      const settled = await jobs;
      expect(settled.every(r => r.status === "fulfilled")).toBe(true);
      const results = settled.map(r => { if (r.status === "rejected") throw r.reason; return r.value; });
      expect(results.map(r => r.outcome).sort()).toEqual(["existing", "prepared"]);
      const issued = results.filter((r): r is Extract<QaRemediationPreparationPassResult, { preparation: unknown }> => "preparation" in r);
      expect(issued).toHaveLength(2);
      expect(issued[0]!.preparation).toEqual(issued[1]!.preparation);
      expect(await prepRows(w)).toHaveLength(1);
    } finally {
      if (held) await controller.unsafe("SELECT pg_advisory_unlock(73123,1)");
      try { if (jobs) await jobs; } finally {
        await controller.unsafe("DROP TRIGGER IF EXISTS qa_prepare_b2b_gate ON workflow_transition_events");
        await controller.unsafe("DROP FUNCTION IF EXISTS public.qa_prepare_b2b_gate()");
        controller.release(); observer.release();
      }
    }
  }, 20000);
});
