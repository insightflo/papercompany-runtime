// server/src/__tests__/mission-owner-authority-flow.integration.test.ts
//
// [Stage 9 — 통합 flow] 최종 caller(executeCoreWorkflowTool mission_owner_execute)에서 여섯 operation 을
//   호출해 exact native executor 실행 → 현재 get-result 통과를 증명한다. fixture(runOwnerAuthorityScenario)는
//   실제 embedded DB 세계(qa-loop/계획 체인)를 시드하고 PLAN-QA·생산자·QA 는 별도 actor/제출로 구동한다.
//   관측값(dispatch/산출물/QA)은 기대값이 아니라 현재 스코프의 실제 행·파일·공식 판정의 독립 readback 이다.
//   board 선택이 필요한 적격 시나리오(revision 미션 fresh/seed)는 별도 board actor 의 전용 구조적 경로가
//   소유한다(stage-5/6/8 revision 테스트 + refusal 의 board 대기 단언) — owner 코드가 board actor 를 합성하지 않는다.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, workflowTransitionEvents } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { setRunRecoveryFlags } from "./helpers/run-reopen-guard-fixture.js";
import { drainHeartbeatRuns } from "./helpers/cap-override-fixtures.js";
import { installAuthorityToolExecutor, runOwnerAuthorityScenario } from "./helpers/mission-owner-authority-integration-fixture.js";
import { setWorkflowToolStepExecutor } from "../services/workflow/dag-engine.js";

// 어댑터만 recording stub(나머지 전부 운영 경로) — issue-backed native resume/claim 이 에이전트 실행을 마칠 수 있게.
const { executeSpy } = vi.hoisted(() => ({ executeSpy: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: executeSpy })),
  runningProcesses: new Map(),
}));

let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("owner-authority-flow-");
  db = createDb(temp.connectionString);
  await setRunRecoveryFlags(db, true, true); // official recovery service 가 failed-run 재개를 소유
  executeSpy.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, usage: null,
    provider: "test", model: "test-model", resultJson: null, runtimeServices: [] });
  installAuthorityToolExecutor(db); // app.ts 운영 executor 결합(큐 claim → 코어 도구 → 실제 완료 기록)
}, 60000);
afterAll(async () => {
  setWorkflowToolStepExecutor(null);
  await drainHeartbeatRuns(db);
  await db.$client.end({ timeout: 5 });
  await temp?.cleanup();
});

it.each(["retry_step", "resume_run", "revise_plan", "recollect", "delegate_fix", "reassign"] as const)(
  "%s executes and proves the current result", async (operation) => {
    const observed = await runOwnerAuthorityScenario(db, operation, "eligible");
    expect(observed.nativeDispatchCount).toBeGreaterThan(0); // 실제 DB dispatch 행(전달≠실행≠해결 분리)
    expect(observed.currentArtifactVerified).toBe(true); // 현재 시도의 등록 산출물 + 실제 파일 bytes
    expect(observed.currentQaVerified).toBe(true); // 생산자와 다른 actor 의 공식 pass 판정(독립 readback)
    expect(observed.result.state).toBe("resolved"); // 옛 파일·댓글·accepted 만으로가 아닌 현재 결과 기반
    expect(observed.result.operation).toBe(operation);
    expect(observed.result.reasonCode).toBeNull();
  }, 120000);

it("resolved flow evidence is structural, not prose: each eligible scenario recorded machine events", async () => {
  // 여섯 eligible 이 종료된 뒤에도 intent/applied machine contract 만 존재한다(자연어는 표시용).
  const observed = await runOwnerAuthorityScenario(db, "retry_step", "eligible");
  expect(observed.result.state).toBe("resolved");
  const events = await db.select({ eventType: workflowTransitionEvents.eventType }).from(workflowTransitionEvents)
    .where(eq(workflowTransitionEvents.eventType, "owner_execute_intent_v1"));
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(await db.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.eventType, "owner_execute_applied_v1")))).not.toEqual([]);
}, 120000);
