// server/src/services/workflow/workflow-run-start.ts
//
// [purpose] workflow run 실행 진입 오케스트레이션(fix4 §2.2/§2.4, cycle A §2/§5/§7). 링크된 자식은
//   실행 진입에서 임대(acquire)를 먼저 획득하고, preparation 실패는 소유 fence 를 유지한 채 정산한
//   뒤 원본 오류를 재던진다. acquisition 이 이미 running/startedAt 을 설정하므로 별도의 소유 시작
//   UPDATE 는 없다 — materializer 가 결정적 fence 다. native-continuation 의도는 모든 run 에 대해
//   readiness/시작/mission 활성화 이전의 조기 반환 경로다.
// [authority] 내구 레코드(workflow_runs.child_start_* / invocation / step rows)만이 권위(규칙 7/8).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowRuns } from "@paperclipai/db";
import {
  findChildStartIdentityForRun,
  type ChildStartFence,
  type ChildStartIdentity,
} from "./workflow-child-start-state.js";
import {
  acquireWorkflowChildStartLease,
  expireWorkflowChildStart,
} from "./workflow-child-start-lease.js";
import { failOwnedWorkflowChildStart } from "./workflow-child-start-failure.js";
import { isChildStartContention, isChildStartDatabaseTimeout } from "./workflow-child-start-contention.js";
import { repairWorkflowChildStartDiscovery } from "./workflow-child-discovery.js";
import { executeNativeContinuation } from "./workflow-native-continuation.js";

export type WorkflowRunStartOptions = {
  intent?: "manual-resume" | "native-continuation";
  /** [cycle B F3] engine.resumeRun 의 prepareManualChildResume 이 발급한 fence — 수동 전용.
   *  이 옵션 없는 수동 자식 실행은 ineligible 스냅숏으로 양보한다(암묵적 재준비 금지).
   */
  preparedChildStartFence?: ChildStartFence;
};
export type WorkflowRunStartOutcome = {
  // [cycle A §7] 'settled' — 이 호출의 만료 변이자가 절대 마감 정산에 이긴 경우(종말 스냅숏 포함).
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

/** [cycle A §7] sync의 소유 결과를 실행 스냅숏과 분리해 전달한다(공개 래퍼가 풀어 쓴다). */
export type WorkflowRunStartSyncOutcome = { kind: "synced" | "not-owner" | "busy"; result: WorkflowExecutionResultLite };
export type WorkflowRunStartSyncOptions = {
  childStartFence?: ChildStartFence;
  requireRunning?: boolean;
  /** [cycle B F6] native-continuation 전용 — 영수증 또는 기존 행이 없으면 not-owner(초기화 금지). */
  requireMaterialized?: boolean;
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
 * 실행 진입 — 링크된 자식이면 임대 소유자만 preparation 이후 초기화 트랜잭션과 fence sync 에
 * 도달한다. 비자식 run 은 기존 실행 경로를 그대로 유지한다(취소된 run 거부 포함).
 */
export async function executeWorkflowRunStart(
  db: Db,
  runId: string,
  options: WorkflowRunStartOptions | undefined,
  hooks: WorkflowRunStartHooks,
): Promise<WorkflowRunStartOutcome> {
  // [cycle A §3/§7 + cycle B F4] native-continuation — 모든 run 의 조기 반환: readiness/시작
  //   트랜잭션/mission 활성화/임대 획득/재설정을 하지 않는다. 판별자 발견/레거시 수리를 먼저 하고
  //   (invalid 는 ineligible — plain 인가 아님), 인가(running AND 영수증/기존 행)는
  //   executeNativeContinuation 의 잠금 하 재판정 하나로 모은다.
  if (options?.intent === "native-continuation") {
    if ((await repairWorkflowChildStartDiscovery(db, runId)).kind === "yield") {
      return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
    }
    return await executeNativeContinuation(db, runId, hooks);
  }

  // [cycle B F4] 자식 판별 — 컨텍스트/readiness/plain 시작 쓰기 "이전"에 발견+레거시 수리한다.
  //   plain/missing 은 기존 plain 경로, linked/legacy(수리 후)는 임대 흐름, invalid-child/수리
  //   실패는 ineligible 스냅숏으로 양보한다(plain fallback 금지).
  let detected: Awaited<ReturnType<typeof findChildStartIdentityForRun>> = null;
  const childEntry = await repairWorkflowChildStartDiscovery(db, runId);
  if (childEntry.kind === "yield") {
    return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
  }
  if (childEntry.kind === "proceed") {
    // 수리 직후의 신선한 linked 신원 — 이후 lease/manual/expiry 흐름은 이 신원으로만 진행한다.
    detected = await findChildStartIdentityForRun(db, runId);
    if (!detected) {
      return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
    }
  }

  let fence: ChildStartFence | null = null;
  if (detected) {
    const child = await loadChildRun(db, runId);
    // 취소된 자식은 기존 거부 에러를 유지한다(fix2 계약).
    if (child && child.status === "cancelled") {
      throw new Error(`Workflow run ${runId} is cancelled; refusing to start execution.`);
    }
    // 완료 자식 부활 금지. failed 자식은 수동 의도에서만 운영자 복구를 위해 임대 검사까지 진행한다
    // (자동은 acquire 의 종말 거부로 ineligible).
    if (child && TERMINAL.includes(child.status) && !(child.status === "failed" && options?.intent === "manual-resume")) {
      return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
    }
    const intent = options?.intent === "manual-resume" ? ("manual-resume" as const) : ("automatic" as const);
    if (intent === "manual-resume") {
      // [cycle B F3] 수동 자식 실행은 "공급된" prepared fence 로만 진행한다 — 준비가 거절되거나
      // fence 가 없으면 암묵적 재준비/재획득 없이 ineligible 스냅숏으로 양보한다. fence 는 그대로
      // 사용되며 materializer 가 소유를 재검증한다. 자동 진입은 공급된 수동 fence 를 무시한다.
      const prepared = options?.preparedChildStartFence;
      if (!prepared || prepared.intent !== "manual-resume" || prepared.identity.childRunId !== runId) {
        return { kind: "ineligible", result: await hooks.snapshot(db, runId) };
      }
      fence = prepared;
    } else {
      const lease = await acquireWorkflowChildStartLease(db, detected.identity, { intent });
      if (lease.kind === "owned") {
        fence = { identity: lease.identity as ChildStartIdentity, token: lease.token, intent };
      } else if (lease.kind === "expired") {
      // [cycle A §7] 직접 실행도 배경 만료와 동일하게 정산+승자 훅을 호출한다. 이 호출의 만료
      // 정산 변이자가 이기면 settled(종말 스냅숏), 지면 expired(실제 스냅숏)다.
      const expiry = await expireWorkflowChildStart(db, detected.identity);
      if (expiry?.settled) {
        await hooks.childCompletionHook(db, {
          id: detected.identity.childRunId,
          companyId: detected.identity.companyId,
          status: expiry.childStatus,
        });
        return { kind: "settled", result: await hooks.snapshot(db, runId) };
      }
      return { kind: "expired", result: await hooks.snapshot(db, runId) };
      } else {
        return { kind: lease.kind, result: await hooks.snapshot(db, runId) };
      }
    }
  }

  // [cycle A §5] preparation scope — 임대 이후 컨텍스트 적재/readiness/구조 검증/토폴로지를 하나의
  // try 로 감싼다. 반환된 검증 배열도 try "안에서" Error 로 변환한다. post-materialization(sync)
  // 예외는 이 scope 에 포함되지 않는다.
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
    // [cycle A §8] 경합은 정산 없이 실제 스냅숏과 함께 busy 다.
    if (isChildStartContention(error)) {
      return { kind: "busy", result: await hooks.snapshot(db, runId) };
    }
    // [cycle A §5] 로컬에서 발급한 fence 를 그대로 유지한다 — DB에서 토큰을 재발견하지 않는다.
    // 57014(statement 취소/타임아웃)는 소유 사업 실패 정산 없이 전파한다(cycle A §8/§9).
    if (fence && !isChildStartDatabaseTimeout(error)) {
      const settle = await failOwnedWorkflowChildStart(db, {
        identity: fence.identity,
        token: fence.token,
        intent: fence.intent,
        errorCode: "child_start_validation_failed",
      });
      if (settle.kind === "won") {
        try {
          // 커밋 후 자식 completion hook — 부모 정산 fence 는 훅 내부에 있다(fix4 §3).
          await hooks.childCompletionHook(db, {
            id: fence.identity.childRunId,
            companyId: fence.identity.companyId,
            status: "failed",
          });
        } catch {
          // [cycle A §5] 훅/정산 실패는 원본 preparation 오류를 가리지 않는다(회복은 회복 경로).
        }
      }
    }
    // [cycle A §5] 원본 preparation 오류를 그대로 재던진다.
    throw error;
  }

  let syncOptions: WorkflowRunStartSyncOptions | undefined;
  if (fence) {
    // [cycle A §2] acquisition 이 이미 running/startedAt 을 설정했다 — 별도의 소유 시작 UPDATE 는
    // 없으며, materializer 의 영수증 소비가 결정적 fence 다.
    syncOptions = { childStartFence: fence };
  } else {
    const startedAt = new Date();
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const [startedRun] = await txDb
        .update(workflowRuns)
        .set({ status: "running", startedAt, completedAt: null })
        .where(and(
          eq(workflowRuns.id, runId),
          eq(workflowRuns.companyId, context.run.companyId),
          // [workflow child fix2 P1-2] 취소된 run 을 무조건 running 으로 되돌리지 않는다.
          sql`${workflowRuns.status} <> 'cancelled'`,
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

  // [cycle A §7] sync 소유 결과를 타입으로 전달한다 — 'started'는 이 호출이 materialization 을
  // 소비했을 때만 보고된다(not-owner/busy는 실제 영속 스냅숏을 실은 busy 다).
  const syncOutcome = await hooks.sync(db, runId, "workflow_execution", syncOptions);
  return { kind: syncOutcome.kind === "synced" ? "started" : "busy", result: syncOutcome.result };
}

async function loadChildRun(db: Db, runId: string) {
  const [child] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  return child ?? null;
}

/**
 * [fix4 §2.4] 수동 resume — 오래된 토큰/임대를 공통 잠금 하 무효화한다. 스텝이 0행인 경우에만
 * 마감/영수증을 초기화해 새 수동 초기화를 허용한다(이미 materialized 면 네이티브 sync 가 정답).
 */
