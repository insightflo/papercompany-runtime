import { and, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm"; import { normalizeSystemLanguage, type SystemLanguage } from "./missions/system-language.js";
import type { Db } from "@paperclipai/db";
import {
  activityLog, companies,
  agents,
  issueComments,
  issues,
  missionPlanArtifacts,
  missions,
  operatorDecisionContinuations,
  operatorDecisions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { CreateOperatorDecisionInput, OperatorDecisionTargetSnapshot } from "@paperclipai/shared/types/operator-decision";
import { operatorDecisionOutcomeInputSchema } from "@paperclipai/shared/validators/operator-decision";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { guardQualityWrite } from "./quality/write-guard.js";
import {
  sameOperatorDecisionResult,
  validateAndHashOperatorDecisionCreate,
  validateOperatorDecisionResult,
} from "./operator-decision-result.js";
import { operatorDecisionContinuationRetryService } from "./operator-decision-continuation-retry.js";
import { operatorDecisionReadService } from "./operator-decisions-read.js";
import { startApprovedRevisionRun } from "./workflow/approved-revision-start.js";

export type OperatorDecisionActor = { type: "agent" | "user"; id: string };

// [stale-card sweep 4a] 시스템 스윕 주체 식별자 — activity 감사(activityLog.actorId)와 카드 취소
//   세부(details.cancelledByActorId) 양쪽에 같은 값을 쓴다. 사람 취소·요청자 취소와 감사 구조를 공유한다.
const STALE_SWEEP_ACTOR_ID = "system:operator-decision-stale-sweep";
// [stale-card sweep 4a] 한 번의 pollOnce 스윕이 검사하는 후보 상한 — 대량 테이블 스캔·장기 점유 방지.
const STALE_SWEEP_BATCH_LIMIT = 50;

// [moi currentness 완화 2026-10-17] 사람 응답 대기 중 이슈 상태 churn(todo↔in_progress↔blocked)은
//   정상 — moi 카드의 currentness는 이슈 종결 여부 기준이다(라이브 사고 2026-10-17 14:30Z: 사람이 볼
//   새 없이 생성 2분 만에 stale sweep 이 issueStatus 불일치로 정당한 요청을 취소). 값 원본은
//   missions/mission-owner-human-input-card.ts 가 스냅샷 생산자다(순환 import 회피로 여기 값 복제).
const MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE = "mission_owner_human_input";
// [moi currentness] 종결 이슈 상태 — routes/execution-workspaces.ts TERMINAL_ISSUE_STATUSES 와 같은 기준.
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

// [moi currentness] issueStatus 비교 정책 — "exact" 는 기존 정확-스냅샷(qa rebind·source defect 등
//   전 유형 불변), "terminal_only" 는 moi 전용 완화(열린 상태 간 전환은 통과, 종결만 mismatch).
export type IssueStatusCurrentnessPolicy = "exact" | "terminal_only";

function conflictFor(id: string, status: string, message = "Operator decision conflict") {
  return conflict(message, { operatorDecisionId: id, status });
}

// [currentness gate] 저장된 sourceContext 에서 대상 스냅샷을 안전하게 꺼낸다. 스냅샷은 create 시점에
//   zod 검증을 통과해 저장되며, 이전 규약 행(스냅샷 키 없음)은 null 을 반환해 기존 동작을 그대로 둔다.
function readTargetSnapshot(sourceContext: unknown): OperatorDecisionTargetSnapshot | null {
  if (sourceContext === null || typeof sourceContext !== "object") return null;
  const candidate = (sourceContext as Record<string, unknown>).targetSnapshot;
  if (candidate === null || typeof candidate !== "object") return null;
  return candidate as OperatorDecisionTargetSnapshot;
}

// [승인=시작 묶음 2026-10-22] 미션의 현재 활성 계획 결정 해시. moi 카드 create 에서 서버가 sourceContext
//   .planDecisionHash 로 기록한다(요청자 제공 값은 무시·위조 불가). 이 해시가 수정 런 시작 권한의
//   묶음 기준이다 — 계획이 바뀌면 해시가 바뀌어 과거 승인은 더 이정 시작을 권한 부여하지 않는다.
const MISSION_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function activePlanDecisionHash(db: Db, companyId: string, missionId: string): Promise<string | null> {
  // uuid 컬럼 조회 전 형식 가드 — uuid 가 아닌 missionId(테스트 픽스처 등)는 계획이 없는 것으로 취급한다.
  if (!MISSION_ID_UUID_RE.test(missionId)) return null;
  const [plan] = await db.select({ refs: missionPlanArtifacts.refs }).from(missionPlanArtifacts)
    .where(and(eq(missionPlanArtifacts.companyId, companyId), eq(missionPlanArtifacts.missionId, missionId),
      eq(missionPlanArtifacts.status, "active")))
    .orderBy(desc(missionPlanArtifacts.revision)).limit(1);
  const refs = plan?.refs !== null && typeof plan?.refs === "object" && !Array.isArray(plan?.refs)
    ? plan.refs as Record<string, unknown> : {};
  const owner = refs.ownerPlanDecision !== null && typeof refs.ownerPlanDecision === "object"
    && !Array.isArray(refs.ownerPlanDecision) ? refs.ownerPlanDecision as Record<string, unknown> : {};
  return typeof owner.decisionHash === "string" && owner.decisionHash !== "" ? owner.decisionHash : null;
}

// [currentness gate] 스냅샷과 현재 DB 상태를 비교해 mismatch 필드 목록만 반환한다(판정 순수 함수).
//   issueStatusPolicy="terminal_only" 는 moi 카드용 완화 — 사람 응답 대기 중 이슈 상태 churn 은
//   정상이므로 종결(done/cancelled) 도달만 mismatch 로 본다(2026-10-17 사고). 그 외 식별자
//   존재·회사 스코프·workflowRun/stepRun 비교는 죽은 대상 거부(CAS 개념)로 그대로 유지된다.
async function collectTargetSnapshotMismatch(
  tx: Pick<Db, "select">,
  companyId: string,
  snapshot: OperatorDecisionTargetSnapshot,
  issueStatusPolicy: IssueStatusCurrentnessPolicy = "exact",
): Promise<string[]> {
  const mismatch: string[] = [];
  if (snapshot.issueId != null) {
    const issue = await tx.select({ companyId: issues.companyId, status: issues.status }).from(issues)
      .where(eq(issues.id, snapshot.issueId)).then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== companyId) mismatch.push("issueId");
    else if (issueStatusPolicy === "terminal_only") {
      if (TERMINAL_ISSUE_STATUSES.has(issue.status)) mismatch.push("issueStatus");
    } else if (snapshot.issueStatus != null && issue.status !== snapshot.issueStatus) mismatch.push("issueStatus");
  }
  if (snapshot.workflowRunId != null) {
    const run = await tx.select({ companyId: workflowRuns.companyId, status: workflowRuns.status }).from(workflowRuns)
      .where(eq(workflowRuns.id, snapshot.workflowRunId)).then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId) mismatch.push("workflowRunId");
    else if (snapshot.workflowRunStatus != null && run.status !== snapshot.workflowRunStatus) mismatch.push("workflowRunStatus");
  }
  if (snapshot.stepRunId != null) {
    const stepRun = await tx.select({
      status: workflowStepRuns.status,
      executionGeneration: workflowStepRuns.executionGeneration,
      runCompanyId: workflowRuns.companyId,
    }).from(workflowStepRuns)
      .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
      .where(eq(workflowStepRuns.id, snapshot.stepRunId)).then((rows) => rows[0] ?? null);
    if (!stepRun || stepRun.runCompanyId !== companyId) mismatch.push("stepRunId");
    else {
      if (snapshot.stepRunStatus != null && stepRun.status !== snapshot.stepRunStatus) mismatch.push("stepRunStatus");
      if (snapshot.executionGeneration != null && stepRun.executionGeneration !== snapshot.executionGeneration) {
        mismatch.push("executionGeneration");
      }
    }
  }
  return mismatch;
}

// [currentness gate] 늦은 선택 보호 — 생성 시점 스냅샷과 현재 DB 상태를 CAS 트랜잭션 안에서 같은 tx로
//   재검증한다(검사-저장 창 최소화). 회사 스코프에서 행이 사라졌거나 지정한 상태·generation이 다르면
//   409 target_changed. throw 로 트랜잭션이 롤백되므로 결과 저장·continuation 생성이 모두 취소되고
//   카드는 pending 유지 — 상태가 원복되면 같은 카드로 다시 resolve 할 수 있다(거부는 영구적이지 않음).
async function assertTargetSnapshotCurrent(
  tx: Pick<Db, "select">,
  operatorDecisionId: string,
  companyId: string,
  snapshot: OperatorDecisionTargetSnapshot,
  issueStatusPolicy: IssueStatusCurrentnessPolicy = "exact",
): Promise<void> {
  const mismatch = await collectTargetSnapshotMismatch(tx, companyId, snapshot, issueStatusPolicy);
  if (mismatch.length > 0) {
    throw conflict("Operator decision target changed since card creation", {
      code: "target_changed",
      mismatch,
      operatorDecisionId,
    });
  }
}

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

export function operatorDecisionWriteService(db: Db) {
  const read = operatorDecisionReadService(db);
  const retry = operatorDecisionContinuationRetryService(db);

  async function assertCreateOwnership(
    companyId: string,
    input: CreateOperatorDecisionInput,
    actor: OperatorDecisionActor,
  ) {
    if (actor.type === "agent") {
      const requester = await db.select({ companyId: agents.companyId }).from(agents)
        .where(eq(agents.id, actor.id)).then((rows) => rows[0] ?? null);
      if (!requester || requester.companyId !== companyId) throw forbidden("Agent key cannot access another company");
    }
    if (input.issueId) {
      const issue = await db.select({ companyId: issues.companyId }).from(issues)
        .where(eq(issues.id, input.issueId)).then((rows) => rows[0] ?? null);
      if (!issue || issue.companyId !== companyId) throw unprocessable("Linked issue must belong to the company");
    }
  }

  async function loadReplay(companyId: string, requestKey: string, requestHash: string) {
    const existing = await db.select().from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, companyId),
      eq(operatorDecisions.requestKey, requestKey),
    )).then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) throw conflictFor(existing.id, existing.status, "Operator decision request key conflict");
    return { decision: (await read.getRequired(existing.id)), replayed: true };
  }

  async function create(companyId: string, rawInput: unknown, actor: OperatorDecisionActor) {
    const validated = validateAndHashOperatorDecisionCreate(rawInput);
    await assertCreateOwnership(companyId, validated.input, actor);
    const replay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
    if (replay) return replay;

    // [결정 가능성 게이트] 판단 정보 패킷(definition.humanReview)이 없는 카드는 UI 버튼 잠금과
    // resolve 422(human_review_packet_required)로 결정 불가능한 죽은 카드가 된다(실제 사례:
    // 2026-10-06 rebind 승인 요청 2건). 생성 단계에서 거부해 요청자가 패킷을 갖춰 다시 만들게 한다.
    // replay 는 멱등 유지를 위해 게이트 앞에서 반환된다(기존 행은 cancel 경로로 정리).
    if (!validated.input.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계(definition.humanReview)가 없는 결정 카드는 만들 수 없습니다. 패킷을 갖춰 다시 요청해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

    // [currentness gate] 스냅샷이 있으면 서버가 재검증할 식별자(issueId/workflowRunId/stepRunId)가
    //   최소 1개 필요하다 — 없으면 재검증 불가능한 죽은 스냅샷이 되므로 생성 단계에서 거부한다.
    const targetSnapshot = readTargetSnapshot(validated.input.sourceContext);
    if (targetSnapshot && targetSnapshot.issueId == null && targetSnapshot.workflowRunId == null && targetSnapshot.stepRunId == null) {
      throw unprocessable(
        "targetSnapshot 은 issueId, workflowRunId, stepRunId 중 최소 하나를 지정해야 합니다.",
        { code: "target_snapshot_identifier_required" },
      );
    }

    let id: string;
    // [승인=시작 묶음 2026-10-22] moi 카드는 서버가 현재 활성 계획 해시를 찍어 저장한다. 생성 스키마가
    //   strict 하므로 요청자가 이 키를 넣을 수 없고, 넣어도 검증 후 여기서 서버 값으로만 기록된다.
    let storedSourceContext: typeof operatorDecisions.$inferInsert.sourceContext = validated.input.sourceContext;
    if (validated.input.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE && validated.input.sourceContext.missionId) {
      storedSourceContext = { ...storedSourceContext,
        planDecisionHash: await activePlanDecisionHash(db, companyId, validated.input.sourceContext.missionId) };
    }
    try {
      id = await db.transaction(async (tx) => {
        const [created] = await tx.insert(operatorDecisions).values({
          companyId,
          requestKey: validated.input.requestKey,
          requestHash: validated.requestHash,
          schemaVersion: 1,
          priority: validated.input.priority,
          interactionType: validated.input.interactionType,
          title: validated.input.title,
          description: validated.input.description,
          sourceType: validated.input.sourceType,
          sourceId: validated.input.sourceId,
          sourceContext: storedSourceContext,
          issueId: validated.input.issueId,
          requestedByAgentId: actor.type === "agent" ? actor.id : null,
          requestedByUserId: actor.type === "user" ? actor.id : null,
          definition: validated.input.definition,
          continuationMode: validated.input.continuationMode,
        }).returning({ id: operatorDecisions.id });
        await tx.insert(activityLog).values({
          companyId,
          actorType: actor.type,
          actorId: actor.id,
          agentId: actor.type === "agent" ? actor.id : null,
          action: "operator_decision.created",
          entityType: "operator_decision",
          entityId: created!.id,
          details: {
            schemaVersion: 1,
            operatorDecisionId: created!.id,
            requestKey: validated.input.requestKey,
            priority: validated.input.priority,
            interactionType: validated.input.interactionType,
            sourceType: validated.input.sourceType,
            sourceId: validated.input.sourceId,
            issueId: validated.input.issueId,
            continuationMode: validated.input.continuationMode,
          },
        });
        return created!.id;
      });
    } catch (error) {
      const concurrentReplay = await loadReplay(companyId, validated.input.requestKey, validated.requestHash);
      if (concurrentReplay) return concurrentReplay;
      throw error;
    }
    // [card alert] 신규 생성(비-replay)에만 발행한다 — replay 는 이미 알림을 받았으므로 멱등하게 스킵.
    publishLiveEvent({
      companyId,
      type: "operator_decision.created",
      payload: {
        operatorDecisionId: id,
        issueId: validated.input.issueId,
        missionId: validated.input.sourceContext.missionId ?? null,
        title: validated.input.title,
        priority: validated.input.priority,
      },
    });
    return { decision: await read.getRequired(id), replayed: false };
  }

  async function resolve(id: string, rawInput: unknown, resolvedByUserId: string) {
    const before = await db.select({ ...getTableColumns(operatorDecisions), defaultLanguage: sql<string | null>`(select ${companies.defaultLanguage} from ${companies} where ${companies.id} = ${operatorDecisions.companyId})` }).from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    // [T5] Quality 연결 결정은 전용 경로로만: 실제 컬럼 연결(qualityActionId) 기준.
    await guardQualityWrite(db, { companyId: before.companyId, subject: "decision", subjectId: id, operation: "resolve" });
    const result = validateOperatorDecisionResult(before.definition, rawInput);
    if (before.status === "pending" && !before.definition.humanReview) {
      throw unprocessable(
        "판단 주제, 근거 원본 위치, 해석, 영향과 다음 단계가 없어 결정할 수 없습니다. 요청자에게 정보 보완을 요구해 주세요.",
        { code: "human_review_packet_required" },
      );
    }

    const applied = await db.transaction(async (tx) => {
      const now = new Date();
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
      if (updated.continuationMode === "issue_current_assignee") {
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
      return true;
    });
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
    // [승인=시작 2026-10-22] "승인"은 대기 중 수정 실행의 시작 권한이다. resolve 트랜잭션 커밋 후
    //   비동기로 시작하며(응답 지연 없음), 실패·경합은 모니터 sweep 이 소급 재시도한다.
    if (applied && result.outcome === "approve" && decision.sourceContext.missionId) {
      const missionId = decision.sourceContext.missionId;
      void startApprovedRevisionRun(db, { companyId: decision.companyId, missionId })
        .catch((err) => logger.warn({ err, operatorDecisionId: id, missionId },
          "approved revision start after decision resolve failed"));
    }
    return { decision, applied, continuation: decision.continuation };
  }

  async function cancel(id: string, actor: OperatorDecisionActor, reason?: string) {
    const before = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id))
      .then((rows) => rows[0] ?? null);
    if (!before) throw notFound("Operator decision not found");
    if (actor.type === "agent" && before.requestedByAgentId !== actor.id) throw forbidden("Only the requester can cancel this decision");
    // [T5] Quality 연결 결정의 취소도 전용 경로로(sourceType 아닌 실제 연결 기준).
    await guardQualityWrite(db, { companyId: before.companyId, subject: "decision", subjectId: id, operation: "cancel" });
    if (before.status === "cancelled") return { decision: await read.getRequired(id), applied: false };
    if (before.status !== "pending") throw conflictFor(id, before.status);
    await db.transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.update(operatorDecisions).set({ status: "cancelled", cancelledAt: now, updatedAt: now })
        .where(and(eq(operatorDecisions.id, id), eq(operatorDecisions.status, "pending"))).returning({ id: operatorDecisions.id });
      if (updated.length !== 1) throw conflictFor(id, "terminal");
      await tx.insert(activityLog).values({
        companyId: before.companyId,
        actorType: actor.type,
        actorId: actor.id,
        agentId: actor.type === "agent" ? actor.id : null,
        action: "operator_decision.cancelled",
        entityType: "operator_decision",
        entityId: id,
        details: {
          schemaVersion: 1,
          operatorDecisionId: id,
          cancelledByActorType: actor.type,
          cancelledByActorId: actor.id,
          cancelledAt: now.toISOString(),
          ...(reason ? { reason } : {}),
        },
      });
    });
    return { decision: await read.getRequired(id), applied: true };
  }

  // [4c outcome] 요청자 에이전트의 결과 회신 — resolved 카드에 대해 원 요청자만 status 를 구조화돼
  //   되돌린다. 카드 행·continuation 은 불변이고 회신은 activity 투영만 남긴다(append-only:
  //   in_progress 갱신·최종 상태 뒤 재보고까지 차단 없이 모두 기록). 보드 사용자·다른 에이전트의
  //   대리 보고는 금지(403) — 권위 값은 status(enum)뿐이고 reason/detail 은 표시용이다.
  async function reportOutcome(id: string, actor: OperatorDecisionActor, rawInput: unknown, now = new Date()) {
    const input = operatorDecisionOutcomeInputSchema.parse(rawInput);
    if (actor.type !== "agent") throw forbidden("Only the card requester agent may report the outcome");
    // 회사 스코프 로드 — 요청자 에이전트가 속한 회사의 카드만 보인다(다른 회사·알 수 없는 에이전트는 404).
    const agent = await db.select({ companyId: agents.companyId }).from(agents)
      .where(eq(agents.id, actor.id)).then((rows) => rows[0] ?? null);
    const row = agent
      ? await db.select().from(operatorDecisions).where(and(
          eq(operatorDecisions.id, id),
          eq(operatorDecisions.companyId, agent.companyId),
        )).then((rows) => rows[0] ?? null)
      : null;
    if (!row) throw notFound("Operator decision not found");
    if (actor.id !== row.requestedByAgentId) throw forbidden("Only the card requester agent may report the outcome");
    if (row.status !== "resolved") throw conflictFor(id, row.status, "Operator decision outcome requires a resolved card");
    await db.insert(activityLog).values({
      companyId: row.companyId,
      actorType: "agent",
      actorId: actor.id,
      agentId: actor.id,
      action: "operator_decision.outcome_reported",
      entityType: "operator_decision",
      entityId: id,
      details: {
        schemaVersion: 1,
        operatorDecisionId: id,
        requesterAgentId: actor.id,
        status: input.status,
        ...(input.reason != null ? { reason: input.reason } : {}),
        ...(input.detail != null ? { detail: input.detail } : {}),
        reportedAt: now.toISOString(),
      },
    });
    return { applied: true, decision: await read.getRequired(id) };
  }

  // [stale-card sweep 4a] 선택 전 상태 변경 → 카드 자동 취소(2026-10-15 정책). 스냅샷 있는 pending 카드 중
  //   현재 상태와 불일치하는 카드를 시스템 주체로 cancelled 처리한다. 불일치 판정은 2단계
  //   assertTargetSnapshotCurrent(409 target_changed)와 같은 비교(collectTargetSnapshotMismatch)를
  //   재사용하고, 취소는 pending CAS 로만
  //   적용해 동시 resolve 승리 시 조용히 건너뛴다. 취소는 continuation/wakeup 을 만들지 않는다.
  //   Quality 연결 카드(qualityActionId)는 T5 전용 경로 계약대로 후보에서 제외한다.
  // [moi terminal-anchor sweep 2026-10-17] mission_owner_human_input pending 카드는 완화 기준으로만
  //   취소한다 — 앵커 이슈 종결(done/cancelled)·소멸, 스냅샷 식별자 소멸, 또는 미션 cancelled.
  //   열린 상태 간 이슈 status churn 으로는 사람 결정 요청을 취소하지 않는다(사람이 볼 새 없이 승인
  //   버튼이 사라진 2026-10-17 라이브 사고 재발 방지). 미션 completed 는 앵커 이슈 종결로 이미
  //   커버되므로 취소 트리거에 넣지 않는다(미션명·이슈명 같은 예시 특수 로직 없음).
  async function sweepStalePendingCards(now = new Date()) {
    const candidates = await db.select({
      id: operatorDecisions.id,
      companyId: operatorDecisions.companyId,
      sourceType: operatorDecisions.sourceType,
      sourceContext: operatorDecisions.sourceContext,
    }).from(operatorDecisions).where(and(
      eq(operatorDecisions.status, "pending"),
      isNull(operatorDecisions.qualityActionId),
      sql`coalesce(${operatorDecisions.sourceContext}, '{}'::jsonb) ? 'targetSnapshot'`,
    )).limit(STALE_SWEEP_BATCH_LIMIT);

    let checked = 0;
    let cancelled = 0;
    for (const candidate of candidates) {
      const snapshot = readTargetSnapshot(candidate.sourceContext);
      // 재검증 식별자(issueId/workflowRunId/stepRunId) 없는 스냅샷은 판정 불가 — 쓰지 않고 건너뛴다.
      if (!snapshot || (snapshot.issueId == null && snapshot.workflowRunId == null && snapshot.stepRunId == null)) continue;
      checked += 1;
      const moi = candidate.sourceType === MISSION_OWNER_HUMAN_INPUT_SOURCE_TYPE;
      const mismatch = await collectTargetSnapshotMismatch(db, candidate.companyId, snapshot,
        moi ? "terminal_only" : "exact");
      if (moi && mismatch.length === 0) {
        // [moi] 미션 cancelled 판정 — missionId 는 moi 카드 생성 시 항상 채워진다(빠면 판정 불가로 통과).
        const sourceContext = candidate.sourceContext as unknown as Record<string, unknown> | null;
        const missionId = typeof sourceContext?.missionId === "string" ? sourceContext.missionId : null;
        if (missionId) {
          const mission = await db.select({ companyId: missions.companyId, status: missions.status }).from(missions)
            .where(eq(missions.id, missionId)).then((rows) => rows[0] ?? null);
          if (mission?.companyId === candidate.companyId && mission.status === "cancelled") mismatch.push("missionStatus");
        }
      }
      if (mismatch.length === 0) continue; // 여전히 일치 — 아무 것도 쓰지 않는다.
      const cancelledNow = await db.transaction(async (tx) => {
        const updated = await tx.update(operatorDecisions).set({
          status: "cancelled", cancelledAt: now, updatedAt: now,
        }).where(and(eq(operatorDecisions.id, candidate.id), eq(operatorDecisions.status, "pending")))
          .returning({ id: operatorDecisions.id });
        if (updated.length !== 1) return false; // 동시 resolve/cancel 승리 — 조용히 skip
        await tx.insert(activityLog).values({
          companyId: candidate.companyId,
          actorType: "user",
          actorId: STALE_SWEEP_ACTOR_ID,
          agentId: null,
          action: "operator_decision.cancelled",
          entityType: "operator_decision",
          entityId: candidate.id,
          details: {
            schemaVersion: 1,
            operatorDecisionId: candidate.id,
            cancelledByActorType: "user",
            cancelledByActorId: STALE_SWEEP_ACTOR_ID,
            cancelledAt: now.toISOString(),
            reason: "target_changed",
            mismatch,
          },
        });
        return true;
      });
      if (cancelledNow) cancelled += 1;
    }
    return { checked, cancelled };
  }

  return { create, resolve, cancel, reportOutcome, retryContinuation: retry.retryContinuation, sweepStalePendingCards };
}
