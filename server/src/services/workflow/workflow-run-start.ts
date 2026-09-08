// server/src/services/workflow/workflow-run-start.ts
//
// [purpose] descope v1 — workflow run 실행 진입 오케스트레이션. 링크된 자식은 발견(discovery,
//   읽기 전용) 후 전체 신원 임대(start-lease) 소유자만 preparation 이후 초기화 트랜잭션과
//   fence sync 에 도달하고, preparation 실패는 소유 fence 를 유지한 채 정산한 뒤 원본 오류를
//   재던진다. manual-resume/native-continuation 진입점과 옵션은 삭제됐다(D3). 비자식 run 은
//   기존 plain 실행 경로를 유지하되, plain 시작 UPDATE 는 명시적 no-child 가드를 갖는다 —
//   자식 표지 run 은 이 문장에 도달할 수 없고 자식 시작은 임대 소유 변이로만 일어난다(D5).
// [authority] 내구 레코드(workflow_runs.child_start_* / invocation / step rows)만이 권위(규칙 7/8).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import type { ChildStartFence } from "./workflow-child-start-state.js";
import {
  acquireWorkflowChildStartLease,
  expireWorkflowChildStart,
} from "./workflow-child-start-lease.js";
import { failOwnedWorkflowChildStart } from "./workflow-child-start-failure.js";
import { isChildStartContention, isChildStartDatabaseTimeout } from "./workflow-child-start-contention.js";
import { discoverWorkflowChildStart } from "./workflow-child-discovery.js";

export type WorkflowRunStartOutcome = {
  // 'settled' — 이 호출의 만료 변이자가 절대 마감 정산에 이긴 경우(종말 스냅숏 포함).
  kind: "started" | "busy" | "ineligible" | "materialized" | "expired" | "settled";
  result: WorkflowExecutionResultLite;
};
// 결과는 런타임 dag-engine 의 구체 타입을 그대로 통과시킨다(구조적 표시만 필요).
export type WorkflowExecutionResultLite = {
  runId: string;
  workflowId: string;
  missionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  completedAt: Date | null;
  error?: string;
  stepRuns: unknown[];
};

/** sync의 소유 결과를 실행 스냅숏과 분리해 전달한다(공개 래퍼가 풀어 쓴다). */
export type WorkflowRunStartSyncOutcome = { kind: "synced" | "not-owner" | "busy"; result: WorkflowExecutionResultLite };
export type WorkflowRunStartSyncOptions = {
  childStartFence?: ChildStartFence;
  requireRunning?: boolean;
};

const TERMINAL = ["completed", "cancelled", "aborted", "failed", "timed-out"];

export type WorkflowRunStartHooks = {
  loadContext: (db: Db, runId: string) => Promise<{ run: { id: string; companyId: string; status: string; missionId: string | null }; steps: unknown[] }>;
  assertToolsReady: (input: { companyId: string; steps: unknown[] }) => Promise<void>;
  validateStructural: (input: { db: Db; companyId: string; steps: unknown[] }) => Promise<string[]>;
  structuralTopologyErrors: (steps: unknown[]) => string[];
  activateMission: (tx: Db, input: { companyId: string; missionId: string | null; workflowRunId: string; startedAt: Date }) => Promise<unknown>;
  sync: (db: Db, runId: string, source: string, options?: WorkflowRunStartSyncOptions) => Promise<WorkflowRunStartSyncOutcome>;
  snapshot: (db: Db, runId: string) => Promise<WorkflowExecutionResultLite>;
  childCompletionHook: (db: Db, input: { id: string; companyId: string; status: string }) => Promise<boolean>;
};

/**
 * 실행 진입 — 링크된 자식이면 임대 소유자만 preparation 이후 초기화/fence sync 에 도달한다.
 * 비자식 run 은 기존 실행 경로를 그대로 유지한다(취소된 run 거부 포함).
 * invalid-child 발견은 plain fallback 이 없다 — ineligible 스냅숏으로 양보한다(fail-closed).
 */
export async function executeWorkflowRunStart(
  db: Db,
  runId: string,
  hooks: WorkflowRunStartHooks,
): Promise<WorkflowRunStartOutcome> {
  // 자식 판별 — 컨텍스트/readiness/plain 시작 쓰기 "이전"에 읽기 전용 발견을 수행한다.
  const discovery = await discoverWorkflowChildStart(db, runId);
  let fence: ChildStartFence | null = null;
  if (discovery.kind === "invalid-child") {
    // 비정합 자식 표지 — plain 실행 권한 절대 없음(구조화 사유는 discovery 가 실는다).
    return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
  }
  if (discovery.kind === "linked") {
    const identity = discovery.identity;
    // 취소/종말 자식은 typed ineligible 경계다(설계 §3 — 지연 시작은 취소 경주에서 typed
    // ineligible 로 양보한다; 평문 Error 던지기는 reconciliation 경계에서 failed 로 오보된다).
    if (discovery.childStatus === "cancelled") {
      return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
    }
    if (TERMINAL.includes(discovery.childStatus)) {
      return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
    }
    const lease = await acquireWorkflowChildStartLease(db, identity);
    if (lease.kind === "owned") {
      fence = { identity: lease.identity, token: lease.token };
    } else if (lease.kind === "expired") {
      // 직접 실행도 배경 만료와 동일하게 정산+승자 훅을 호출한다. 이 호출의 만료 정산 변이자가
      // 이기면 settled(종말 스냅숏), 지면 expired(실제 스냅숏)다.
      const expiry = await expireWorkflowChildStart(db, identity);
      if (expiry?.settled) {
        await hooks.childCompletionHook(db, {
          id: identity.childRunId,
          companyId: identity.companyId,
          status: expiry.childStatus,
        });
        return { kind: "settled", result: await hooks.snapshot(db, runId) };
      }
      return { kind: "expired", result: await hooks.snapshot(db, runId) };
    } else {
      return { kind: lease.kind, result: await hooks.snapshot(db, runId) };
    }
  }

  // preparation scope — 임대 이후 컨텍스트 적재/readiness/구조 검증/토폴로지를 하나의 try 로
  // 감싼다. post-materialization(sync) 예외는 이 scope 에 포함되지 않는다.
  let context: Awaited<ReturnType<typeof hooks.loadContext>>;
  try {
    context = await hooks.loadContext(db, runId);
    await hooks.assertToolsReady({ companyId: context.run.companyId, steps: context.steps });
    const structuralErrors = await hooks.validateStructural({ db, companyId: context.run.companyId, steps: context.steps });
    const allStructuralErrors = [...structuralErrors, ...hooks.structuralTopologyErrors(context.steps)];
    if (allStructuralErrors.length > 0) {
      throw new Error(`Structural gate validation failed: ${allStructuralErrors.join("; ")}`);
    }
  } catch (error) {
    // 경합은 정산 없이 실제 스냅숏과 함께 busy 다.
    if (isChildStartContention(error)) {
      return { kind: "busy", result: await hooks.snapshot(db, runId) };
    }
    // 로컬에서 발급한 fence 를 그대로 유지한다 — DB에서 토큰을 재발견하지 않는다.
    // 57014(statement 취소/타임아웃)는 소유 사업 실패 정산 없이 전파한다(타임아웃 진단).
    if (fence && !isChildStartDatabaseTimeout(error)) {
      const settle = await failOwnedWorkflowChildStart(db, {
        identity: fence.identity,
        token: fence.token,
        errorCode: "child_start_validation_failed",
      });
      if (settle.kind === "won") {
        try {
          // 커밋 후 자식 completion hook — 부모 정산 fence 는 훅 내부에 있다.
          await hooks.childCompletionHook(db, {
            id: fence.identity.childRunId,
            companyId: fence.identity.companyId,
            status: "failed",
          });
        } catch {
          // 훅/정산 실패는 원본 preparation 오류를 가리지 않는다(회복은 회복 경로).
        }
      }
    }
    // 원본 preparation 오류를 그대로 재던진다.
    throw error;
  }

  let syncOptions: WorkflowRunStartSyncOptions | undefined;
  if (fence) {
    // acquisition 이 이미 running/startedAt 을 설정했다 — 별도의 소유 시작 UPDATE 는 없으며,
    // materializer 의 영수증 소비가 결정적 fence 다.
    syncOptions = { childStartFence: fence };
  } else {
    const startedAt = new Date();
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      // [D5] plain 시작 UPDATE — 자식 표지 run 은 도달할 수 없다(triggered-by/부모 포인터/
      //   invocation 역참조 가드). 자식 시작은 임대 소유 변이로만 일어난다.
      const [startedRun] = await txDb
        .update(workflowRuns)
        .set({ status: "running", startedAt, completedAt: null })
        .where(and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.companyId, context.run.companyId),
          // 취소된 run 을 무조건 running 으로 되돌리지 않는다(workflow child fix2 P1-2).
          sql`${workflowRuns.status} <> 'cancelled'`,
          // 명시적 no-child 가드 — 자식 표지/참조가 하나라도 있으면 이 문장은 0행이다.
          sql`${workflowRuns.triggeredBy} <> 'workflow-step'`,
          sql`${workflowRuns.parentRunId} is null`,
          sql`${workflowRuns.parentStepRunId} is null`,
          sql`not exists (
            select 1 from workflow_step_invocations wrc_i where wrc_i.child_run_id = ${workflowRuns.id})`,
        ))
        .returning({
          id: workflowRuns.id,
          companyId: workflowRuns.companyId,
          missionId: workflowRuns.missionId,
          startedAt: workflowRuns.startedAt,
        });
      if (!startedRun?.startedAt) {
        if (context.run.status === "cancelled") {
          throw new Error(`Workflow run ${runId} is cancelled; refusing to start execution.`);
        }
        throw new Error(`Workflow run disappeared before execution start: ${runId}`);
      }
      await hooks.activateMission(txDb, {
        companyId: startedRun.companyId,
        missionId: startedRun.missionId,
        workflowRunId: startedRun.id,
        startedAt: startedRun.startedAt,
      });
    });
  }

  // sync 소유 결과를 타입으로 전달한다 — 'started'는 이 호출이 materialization 을 소유했을 때만
  // 보고된다(not-owner/busy는 실제 영속 스냅숏을 실은 busy 다).
  const syncOutcome = await hooks.sync(db, runId, "workflow_execution", syncOptions);
  return { kind: syncOutcome.kind === "synced" ? "started" : "busy", result: syncOutcome.result };
}
