import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies, issueComments, missions, operatorDecisionContinuations, operatorDecisions, workflowRuns } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { normalizeSystemLanguage, type SystemLanguage } from "./missions/system-language.js";
import { guardQualityWrite } from "./quality/write-guard.js";
import { sameOperatorDecisionResult, validateOperatorDecisionResult } from "./operator-decision-result.js";
import {
  assertOwnerHumanDecisionCurrent,
  assertTargetSnapshotCurrent,
  MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE,
  readTargetSnapshot,
} from "./operator-decision-currentness.js";
import type { operatorDecisionReadService } from "./operator-decisions-read.js";
import { startApprovedRevisionRun } from "./workflow/approved-revision-start.js";
import { resumeRunFromOperatorDecisionInsideSerialization, TERMINAL_RESUME_OPTION_ID } from "./missions/terminal-resume-from-decision.js";
import {
  withResumeSerialization,
  type ResumeMutationTransaction,
  type ResumeSerializationContext,
} from "./workflow/resume/serialization.js";
import { assertExactBoardWorkflowRestartPolicy, holdUnprovenRestart,
  startWorkflowRestartFromOperatorDecision } from "./missions/approved-workflow-restart.js";
import { evaluateRecoveryAdviceIdentity, loadRecoveryAdviceIdentityFacts } from "./operator-decision-recovery-advice.js";
import {
  WORKFLOW_RESTART_FROM_START_OPTION_ID,
  WORKFLOW_RESTART_FROM_START_SCOPE,
} from "./missions/workflow-restart-option.js";

 type OperatorDecisionResolutionDependencies = {
  read: Pick<ReturnType<typeof operatorDecisionReadService>, "getRequired">;
  conflictFor: (id: string, status: string, message?: string) => ReturnType<typeof conflict>;
};

// [delivery bridge] definition.options × result.selectedOptionIds 를 한국어 라벨+영어 식별자로 해석한다.
//   규칙 8: 이 표시용 해석은 권위가 아니며, 권위는 operator_decisions.result + activity log 에 있다.
function resolveSelectedOptions(
  definition: CreateOperatorDecisionInput["definition"],
  selectedOptionIds: readonly string[],
): { id: string; label: string; description: string | null }[] {
  const byId = new Map(definition.options.map((option) => [option.id, option]));
  return selectedOptionIds
    .map((optionId) => {
      const option = byId.get(optionId);
      return option
        ? { id: option.id, label: option.label, description: option.description }
        : { id: optionId, label: optionId, description: null };
    });
}

// [delivery bridge] resolve 직후 이슈에 남는 시스템 코멘트(저자 null). 이미 running인 런도 다음 실행에서
//   brief 의 recentIssueComments 로 이 결정을 본다. 삽입 실패는 resolve 를 깨지 않는다(display 계층).
async function insertOperatorDecisionResolvedComment(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    operatorDecisionId: string; language: SystemLanguage;
    selectedOptions: { id: string; label: string; description: string | null }[];
  },
): Promise<void> {
  const selectionLines = input.selectedOptions.map((option) =>
    `- 선택: ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  const body = [
    "## 운영자 결정 반영 (operator decision resolved)",
    ...selectionLines,
    `- operatorDecisionId: ${input.operatorDecisionId}`,
    input.language === "ko" ? "- 다음 행동: 다음 실행자는 이 결정을 우선 지시로 따른다. 선택 기록은 실행 완료를 뜻하지 않습니다." : "- Next action: the next executor follows this decision as the priority instruction (다음 실행자는 이 결정을 우선 지시로 따른다.). A recorded selection does not mean execution is complete.",
  ].join("\n");
  try {
    await db.insert(issueComments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      authorAgentId: null,
      authorUserId: null,
      body,
    });
  } catch (error) {
    logger.warn({
      msg: "Failed to insert operator-decision resolved system comment",
      operatorDecisionId: input.operatorDecisionId,
      issueId: input.issueId,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}

export function operatorDecisionResolutionWriteService(
  db: Db,
  { read, conflictFor }: OperatorDecisionResolutionDependencies,
) {
  async function resolve(id: string, rawInput: unknown, resolvedByUserId: string) {
    const before = await db.select({ ...getTableColumns(operatorDecisions), defaultLanguage: sql<string | null>`(select ${companies.defaultLanguage} from ${companies} where ${companies.id} = ${operatorDecisions.companyId})` }).from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    // [T5] Quality 연결 결정은 전용 경로로만: 실제 컬럼 연결(qualityActionId) 기준.
    await guardQualityWrite(db, { companyId: before.companyId, subject: "decision", subjectId: id, operation: "resolve" });
    const result = validateOperatorDecisionResult(before.definition, rawInput);
    const directResumeSelected = result.outcome === "submit"
      && result.selectedOptionIds.includes(TERMINAL_RESUME_OPTION_ID);
    const directRestartSelected = (result.outcome === "approve" || result.outcome === "submit")
      && result.selectedOptionIds.includes(WORKFLOW_RESTART_FROM_START_OPTION_ID);
    const directCommandSelected = directResumeSelected || directRestartSelected;
    if (directResumeSelected && (!before.sourceContext.missionId || !before.sourceContext.workflowRunId)) {
      throw conflict("resume_scope_missing");
    }
    if (directRestartSelected && (!before.sourceContext.missionId || !before.sourceContext.workflowRunId)) {
      throw conflict("workflow_restart_scope_missing");
    }
    if (before.status === "pending" && !before.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계가 없어 결정할 수 없습니다. 요청자에게 정보 보완을 요구해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

    const resolveInsideTransaction = async (
      tx: ResumeMutationTransaction,
      resumeContext?: ResumeSerializationContext,
    ) => {
      const now = new Date();
      if (before.status === "pending" && directRestartSelected) {
        const [observed] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id));
        if (observed?.status === "resolved" && sameOperatorDecisionResult(observed.result, result)) return false;
      }
      if (before.status === "pending") await assertOwnerHumanDecisionCurrent(tx, before);
      if (before.status === "pending" && directRestartSelected) {
        const [current] = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id)).for("update");
        if (current?.status === "resolved" && sameOperatorDecisionResult(current.result, result)) return false;
        if (!current || current.status !== "pending") throw conflictFor(id, current?.status ?? "missing");
        if (current.requestHash !== before.requestHash) throw conflict("Operator decision changed while it was being resolved", {
          code: "operator_decision_binding_changed", operatorDecisionId: id,
        });
        const currentResult = validateOperatorDecisionResult(current.definition, rawInput);
        if (!sameOperatorDecisionResult(currentResult, result)) throw conflict("Operator decision result no longer matches the submitted selection", {
          code: "operator_decision_binding_changed", operatorDecisionId: id,
        });
        if (!current.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)) {
          throw conflict("workflow_restart_scope_missing");
        }
        if (!current.sourceContext.missionId || !current.sourceContext.workflowRunId) {
          throw conflict("workflow_restart_scope_missing");
        }
        const targetSnapshot = readTargetSnapshot(current.sourceContext);
        if (targetSnapshot) await assertTargetSnapshotCurrent(tx, id, current.companyId, targetSnapshot,
          current.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE ? "terminal_only" : "exact");
        const facts = await loadRecoveryAdviceIdentityFacts(tx as unknown as Db, current);
        const advice = facts
          ? evaluateRecoveryAdviceIdentity({ card: current, ...facts })
          : evaluateRecoveryAdviceIdentity({ kind: "outside_default_scope", card: current });
        if (advice.disposition !== "outside_default_scope") holdUnprovenRestart(id);
        assertExactBoardWorkflowRestartPolicy(current, currentResult, {
          companyId: current.companyId, missionId: current.sourceContext.missionId,
          sourceWorkflowRunId: current.sourceContext.workflowRunId,
        });
      }
      const updated = await tx.update(operatorDecisions).set({
        status: "resolved",
        result,
        resolvedByUserId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) {
        const current = await tx.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
          .then((rows) => rows[0] ?? null);
        if (current?.status === "resolved" && sameOperatorDecisionResult(current.result, result)) return false;
        throw conflictFor(id, current?.status ?? "missing");
      }
      // [currentness gate] CAS 성공(첫 적용) 경로에서만 재검증한다 — 이미 확정된 결정의 멱등 replay
      //   (applied=false)는 스냅샷과 무관하게 그대로 둔다. throw 시 트랜잭션이 롤백되어 카드는 pending 유지.
      const targetSnapshot = readTargetSnapshot(updated.sourceContext);
      if (targetSnapshot) {
        // [moi currentness 완화 2026-10-17] 사람 응답 대기 중 이슈 상태 churn 은 정상 — moi 카드의
        //   currentness는 이슈 종결 여부 기준(종결 이슈 resolve 는 기존대로 409 target_changed).
        await assertTargetSnapshotCurrent(tx, id, updated.companyId, targetSnapshot,
          updated.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE ? "terminal_only" : "exact");
      }
      let continuationId: string | null = null;
      if (updated.continuationMode === "issue_current_assignee" && !directCommandSelected) {
        continuationId = await tx.insert(operatorDecisionContinuations).values({
          companyId: updated.companyId,
          operatorDecisionId: id,
          issueId: updated.issueId,
          state: "pending",
          nextAttemptAt: now,
        }).returning({ id: operatorDecisionContinuations.id }).then((rows) => rows[0]!.id);
      }
      await tx.insert(activityLog).values({
        companyId: updated.companyId,
        actorType: "user",
        actorId: resolvedByUserId,
        action: "operator_decision.resolved",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          actionId: result.actionId,
          outcome: result.outcome,
          selectedOptionIds: result.selectedOptionIds,
          commentPresent: result.comment !== null,
          resolvedByUserId,
          resolvedAt: now.toISOString(),
          issueId: updated.issueId,
          continuationId,
        },
      });
      if (directRestartSelected) {
        if (!updated.definition.approvedScope.includes(WORKFLOW_RESTART_FROM_START_SCOPE)) {
          throw conflict("workflow_restart_scope_missing");
        }
        if (!updated.sourceContext.missionId || !updated.sourceContext.workflowRunId) {
          throw conflict("workflow_restart_scope_missing");
        }
        await startWorkflowRestartFromOperatorDecision(tx as unknown as Db, {
          companyId: updated.companyId,
          missionId: updated.sourceContext.missionId,
          sourceWorkflowRunId: updated.sourceContext.workflowRunId,
          operatorDecisionId: updated.id,
          resolvedByUserId,
          issueId: updated.issueId,
          decisionRequestHash: updated.requestHash,
          decisionResult: updated.result ?? undefined,
        });
      }
      if (directResumeSelected) {
        if (!resumeContext || !updated.sourceContext.missionId || !updated.sourceContext.workflowRunId) {
          throw conflict("resume_scope_missing");
        }
        await resumeRunFromOperatorDecisionInsideSerialization(resumeContext, {
          operatorDecisionId: id,
          resolvedByUserId,
          companyId: updated.companyId,
          missionId: updated.sourceContext.missionId,
          workflowRunId: updated.sourceContext.workflowRunId,
        });
      }
      return true;
    };
    const applied = directResumeSelected
      ? await withResumeSerialization(db, {
        companyId: before.companyId,
        missionId: before.sourceContext.missionId!,
        runId: before.sourceContext.workflowRunId!,
      }, (context) => resolveInsideTransaction(context.tx, context))
      : directRestartSelected
        ? await db.transaction(async (tx) => {
          const [lockedMission] = await tx.select({ id: missions.id }).from(missions).where(and(
            eq(missions.id, before.sourceContext.missionId!),
            eq(missions.companyId, before.companyId),
          )).for("update");
          if (!lockedMission) throw conflict("workflow_restart_scope_missing");
          await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
            eq(workflowRuns.id, before.sourceContext.workflowRunId!),
            eq(workflowRuns.companyId, before.companyId),
            eq(workflowRuns.missionId, before.sourceContext.missionId!),
          )).for("update");
          return resolveInsideTransaction(tx);
        })
        : await db.transaction((tx) => resolveInsideTransaction(tx));
    const decision = await read.getRequired(id);
    // [delivery bridge] applied(첫 적용)에만 코멘트를 남긴다 — replay 는 이미 코멘트가 존재한다.
    //   이슈가 삭제된 경우 decision.issueId 는 FK(set null) 로 비어 자연 스킵된다.
    if (applied && decision.issueId) {
      await insertOperatorDecisionResolvedComment(db, {
        companyId: decision.companyId,
        issueId: decision.issueId,
        operatorDecisionId: id, language: normalizeSystemLanguage(before.defaultLanguage),
        selectedOptions: resolveSelectedOptions(decision.definition, result.selectedOptionIds),
      });
    }
    // 직접 복구 명령은 같은 resolve에서 이미 정확한 대상 실행을 만들거나 재개했다.
    // 일반 승인 후처리까지 실행하면 별도 revision run이 중복 시작될 수 있다.
    if (applied && !directCommandSelected && result.outcome === "approve" && decision.sourceContext.missionId) {
      const missionId = decision.sourceContext.missionId;
      void startApprovedRevisionRun(db, { companyId: decision.companyId, missionId })
        .catch((err) => logger.warn({ err, operatorDecisionId: id, missionId },
          "approved revision start after decision resolve failed"));
    }
    return { decision, applied, continuation: decision.continuation };
  }

  return { resolve };
}
