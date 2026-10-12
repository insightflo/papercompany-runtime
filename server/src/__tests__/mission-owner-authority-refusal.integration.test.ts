// server/src/__tests__/mission-owner-authority-refusal.integration.test.ts
//
// [Stage 9 — 통합 refusal] 성공(flow 테스트)과 분리된 거부·경합·증거누락 경계를 통합 관점에서 검증한다.
//   기존 8개 단계 테스트가 이미 커버하는 항목(apply 후 전달 crash·순차 재송·old receipt/new intent·
//   old worker 지연 결과·plan hash 변경 = stage 1/2/5/8)은 중복 최소화를 위해 제외하고, 통합 관점에서
//   아직 직접 검증되지 않은 것에 집중한다: ① 경합(동시 재송·전달 후 결과 제출 전 crash·owner 교체)
//   ② 사람 중지/시작 펜스(자동 해제 금지) ③ 증거 누락 상태에서 resolved 아님 + 정확한 제출 요청.
//   성공/거부 분리: 전부 거부하는 구현은 여섯 기능 지원이 아니다 — flow 테스트의 여섯 eligible 실제
//   진행 증명과 이 파일의 구조적 대기가 함께 분리를 이룬다.
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, agents, missions, workflowRecoveryAuthorities, workflowStepRuns, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { drainHeartbeatRuns } from "./helpers/cap-override-fixtures.js";
import { authorityWorld, installAuthorityToolExecutor, pendingOf, runOwnerAuthorityScenario, type AuthorityWorld } from "./helpers/mission-owner-authority-integration-fixture.js";
import { processQueuedWorkflowToolStepRuns, setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

const FAILED_LOOP = { runStatus: "failed" as const, collectorStatus: "failed" as const, terminal: { policyCause: "recovery_deadline_hard" } };
const retryAction = (w: AuthorityWorld) => ({ operation: "retry_step", target: w.collectorTarget });
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
const roots: string[] = [];
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-authority-refusal-");
  db = createDb(temp.connectionString);
  await setRunRecoveryFlags(db, true, true);
  installAuthorityToolExecutor(db);
}, 60000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await drainHeartbeatRuns(db);
  await db.$client.end({ timeout: 5 });
  await temp?.cleanup();
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});
async function loopWorld(): Promise<AuthorityWorld> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "owner-refusal-")));
  roots.push(root);
  const w = await authorityWorld(db, root, FAILED_LOOP);
  w.evidenceAfter = new Date();
  return w;
}
const authoritiesOf = async (w: AuthorityWorld) => (await db.select({ id: workflowRecoveryAuthorities.id })
  .from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, w.workflowRunId)));
const intentsOf = async (w: AuthorityWorld) => (await db.select({ id: workflowTransitionEvents.id })
  .from(workflowTransitionEvents).where(and(eq(workflowTransitionEvents.companyId, w.companyId),
    eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"))));
const collectorRow = async (w: AuthorityWorld) => (await db.select().from(workflowStepRuns)
  .where(eq(workflowStepRuns.id, w.collectorStepRunId)))[0]!;

it("[stopped] a human operator cancel stays a structural board wait — no auto resume", async () => {
  const observed = await runOwnerAuthorityScenario(db, "resume_run", "stopped");
  expect(observed.result).toMatchObject({ state: "blocked", reasonCode: "operator_cancel", operation: "resume_run" });
  expect(observed.result.state).not.toBe("resolved"); // 사람 중지 자동 해제 금지 — 실행 응답은 board_resume requiredAction(stage-4),
  // get-result 재투영은 설계대로 정확한 reasonCode 만 전달한다(기록된 stage-4 계약).
  expect(observed.nativeDispatchCount).toBe(0); // 실행 부작용 0
  expect(observed.currentArtifactVerified).toBe(false);
  expect(observed.currentQaVerified).toBe(false);
}, 60000);

it("[stopped] a mission paused right before PLAN-QA never starts a run even with a QA pass", async () => {
  const observed = await runOwnerAuthorityScenario(db, "revise_plan", "stopped");
  expect(observed.result.state).not.toBe("resolved"); // 시작 펜스 — 정지된 미션의 run 시작 없음
  expect(observed.nativeDispatchCount).toBe(0); // 새 run 자체가 없다(물화·실행 0)
}, 120000);

it("[missing_evidence] a completed producer without a registered artifact is not resolved and demands the exact submission", async () => {
  const observed = await runOwnerAuthorityScenario(db, "delegate_fix", "missing_evidence");
  expect(observed.result).toMatchObject({ state: "needs_evidence", reasonCode: "producer_artifact_missing", operation: "delegate_fix" });
  expect(observed.result.requiredAction).toMatchObject({ kind: "submit_artifact" }); // 정확한 등록 제출 요청
  expect(observed.currentArtifactVerified).toBe(false); // 파일/등록 누락은 resolved 근거가 아니다
  expect(observed.result.state).not.toBe("resolved");
}, 60000);

it("[stale_intent] a newer owner intent on the same issue voids the old attempt's completion", async () => {
  const observed = await runOwnerAuthorityScenario(db, "retry_step", "stale_intent");
  expect(observed.result.state).not.toBe("resolved"); // 옛 시도는 새 의도로 완성될 수 없다
  expect(observed.currentArtifactVerified).toBe(false); // invocation fence 가 실제 명령 시작을 막았다
}, 60000);

it("[race] concurrent resends of the same action request converge on one intent and one authority", async () => {
  const w = await loopWorld();
  const action = retryAction(w), requestId = randomUUID();
  const [a, b] = await Promise.all([w.call(action, requestId), w.call(action, requestId)]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(pendingOf(b).actionId).toBe(pendingOf(a).actionId); // 같은 key → 같은 action
  expect(await intentsOf(w)).toHaveLength(1); // intent 1행 — 경합 중복 기록 없음
  expect(await authoritiesOf(w)).toHaveLength(1); // 권한 1회 소비
  expect((await collectorRow(w)).executionGeneration).toBe(1); // reset 1회 — 이중 reset 없음
  await processQueuedWorkflowToolStepRuns(db);
  expect((await collectorRow(w)).status).toBe("completed");
  expect((await w.getResult(pendingOf(a).actionId)).state).toBe("resolved");
}, 60000);

it("[crash] a crash after delivery but before result submission does not double-reset on resend", async () => {
  const w = await loopWorld();
  const action = retryAction(w), requestId = randomUUID();
  const actionId = pendingOf(await w.call(action, requestId)).actionId;
  setWorkflowToolStepExecutor(async () => { throw new Error("crash after delivery, before result submission"); });
  try { await processQueuedWorkflowToolStepRuns(db); } finally { installAuthorityToolExecutor(db); }
  const crashed = await collectorRow(w);
  expect(crashed.status).toBe("failed"); // 결과 제출 전 중단 — 전달≠실행≠해결
  expect((await w.getResult(actionId)).state).not.toBe("resolved");
  const before = (await authoritiesOf(w)).length;
  const replay = await w.call(action, requestId); // 같은 요청 재송 — 현재 attempt 에만 연결
  expect(replay.status).toBe(200);
  expect((await authoritiesOf(w)).length).toBe(before); // 재reset·재한도 소비 없음
  expect((await collectorRow(w)).executionGeneration).toBe(crashed.executionGeneration);
}, 60000);

it("[owner-replaced] the prior owner cannot replay the action and causes no new side effects", async () => {
  const w = await loopWorld();
  const action = retryAction(w), requestId = randomUUID();
  const actionId = pendingOf(await w.call(action, requestId)).actionId;
  expect(actionId).toBeTruthy();
  const replacementAgentId = randomUUID(); // 실제 교체 오너 행(FK) — 권한 자체는 바뀌지 않는다
  await db.insert(agents).values({ id: replacementAgentId, companyId: w.companyId, name: "Replacement Owner", role: "operator", status: "active", adapterType: "process" });
  await db.update(missions).set({ ownerAgentId: replacementAgentId }).where(eq(missions.id, w.missionId)); // 오너 교체
  const replay = await w.call(action, requestId);
  expect(replay.status).toBe(403);
  expect((replay.body as { error?: string }).error).toBe("not_mission_owner");
  expect(await intentsOf(w)).toHaveLength(1); // 새 intent 없음 — 부작용 0
  expect(await authoritiesOf(w)).toHaveLength(1); // 권한 추가 소비 없음
}, 60000);
