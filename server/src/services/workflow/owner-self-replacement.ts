// server/src/services/workflow/owner-self-replacement.ts
//
// [목적] 미션 오너 에이전트가 자기 미션의 실패한 런에 대해 교정 메타데이터로
//   workflow replacement 를 사람 승인 없이 제안+승인(approved)까지 한 트랜잭션으로 기록한다.
// [권한] 기존 owner-recovery 결정 API(authorizeOwnerRecoveryApi)와 동일 체인 — 미션 오너 일치 +
//   owner-action(unblock) 이슈 + 동일 heartbeat identity + 체크아웃. 보드 경로는 그대로 사람 전용.
// [검증] 스코프·정의·스태일니스 검증은 보드 경로의 lockReplacementScope /
//   lockReplacementDefinition / replacementDefinitionHash / normalizeWorkflowRunInputs /
//   reserved-metadata 거부를 그대로 재사용한다(우회 금지).
// [입장] 신규 런 생성·admission 은 기존 admitReplacement 경로만 사용한다. 이 서비스는
//   approval( approved )과 targetRunId 를 반환하고 오너가 replacementIntent 로 런을 트리거한다.
import { and, eq, sql } from "drizzle-orm";
import { approvals, activityLog, type Db } from "@paperclipai/db";
import { replacementApprovalPayloadSchema, ownerSelfReplacementSchema, type OwnerSelfReplacement } from "@paperclipai/shared/validators/workflow-replacement";
import { conflict, forbidden } from "../../errors.js";
import { hashStructuredValue } from "../issue-execution-cards/hash.js";
import { lockReplacementScope, lockReplacementDefinition } from "./replacement-scope.js";
import { replacementDefinitionHash } from "./replacement-definition.js";
import { normalizeWorkflowRunInputs } from "./run-input-normalization.js";
import type { OwnerRecoveryApiActor } from "../missions/mission-owner-recovery-agent-api.js";
import { authorizeOwnerRecoveryWindow } from "../missions/owner-recovery-window-auth.js";

export type OwnerSelfReplacementResult = {
  readonly approval: typeof approvals.$inferSelect;
  readonly targetRunId: string;
  readonly replay: boolean;
};

// owner-recovery 결정 API 의 비-결정 인가 체인(미션 오너·이슈 종류·소스 이슈·heartbeat
// identity·체크아웃)은 owner-recovery-window-auth.ts 로 추출됐다 — 결정·자가교체·mission_owner_execute
// 실행 창구가 같은 체인을 공유한다(메시지 계약 보존을 위해 label 만 파라미터화).

export async function ownerSelfReplacement(db: Db, input: {
  readonly issueId: string;
  readonly actor: OwnerRecoveryApiActor;
  readonly request: OwnerSelfReplacement;
}): Promise<OwnerSelfReplacementResult> {
  const body = ownerSelfReplacementSchema.parse(input.request);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const { issue } = await authorizeOwnerRecoveryWindow(t, input.issueId, input.actor, "replacement");
    // 멱등 replay 는 스코프 잠금 앞에서 판정한다 — 이미 기록된 자가 승인 행 자체가 증거다.
    // ( admission 이 이미 소비된 뒤의 재요청도 scope 잠금 없이 동일 승인을 반환한다. )
    const [existing] = await tx.select().from(approvals).where(and(eq(approvals.companyId, issue.companyId),
      eq(approvals.type, "workflow_replacement"),
      sql`${approvals.payload}->>'idempotencyKey' = ${body.idempotencyKey}`)).limit(1).for("update");
    if (existing) {
      const parsed = replacementApprovalPayloadSchema.safeParse(existing.payload);
      if (existing.status === "approved" && parsed.success && parsed.data.ownerAgentSelfApproval === true
        && parsed.data.sourceRunId === body.sourceRunId && parsed.data.decisionEventId === body.decisionEventId) {
        return { approval: existing, targetRunId: parsed.data.targetRunId, replay: true };
      }
      throw conflict("replacement_idempotency_key_reuse");
    }
    // D3: 자기 미션 실패 런·terminal 결정·generation·예산·중복 실행·권한 소비 검증 전부 재사용.
    const scope = await lockReplacementScope(t, issue.companyId, body.sourceRunId, body.decisionEventId);
    if (scope.mission.id !== issue.missionId) throw conflict("owner_replacement_mission_mismatch");
    if (scope.mission.ownerAgentId !== input.actor.agentId) throw forbidden("owner_replacement_owner_required");
    const definition = await lockReplacementDefinition(t, issue.companyId, scope.run.workflowId);
    const targetRunId = crypto.randomUUID();
    const metadata = normalizeWorkflowRunInputs(definition.runInputs as never, body.metadata);
    if ("replacementAuthorityId" in metadata || "executionDefinitionVersion" in metadata || "replacementStart" in metadata) throw conflict("replacement_reserved_metadata");
    const payload = replacementApprovalPayloadSchema.parse({ schemaVersion: 1, companyId: issue.companyId,
      missionId: scope.mission.id, workflowId: scope.run.workflowId, sourceRunId: scope.run.id,
      sourceAuthorityVersion: scope.run.dispatchAuthorityVersion, terminalDecisionId: scope.terminal.id,
      decisionEventId: scope.owner.eventId, requesterAgentId: scope.mission.ownerAgentId, targetRunId,
      requestGeneration: scope.step.executionGeneration, stepRunId: scope.step.id,
      definitionHash: await replacementDefinitionHash(t, definition, scope.mission.id, targetRunId),
      inputHash: hashStructuredValue(metadata), inputContract: definition.runInputs ?? [], metadata,
      idempotencyKey: body.idempotencyKey, externalEffects: "owner_agent_reconciled",
      ownerAgentSelfApproval: true });
    const [approval] = await tx.insert(approvals).values({ companyId: issue.companyId, type: "workflow_replacement",
      status: "approved", requestedByAgentId: scope.mission.ownerAgentId, requestedByUserId: null,
      decidedByUserId: null, decidedAt: new Date(),
      // 스키마에 agent 결정자 컬럼이 없으므로 decisionNote·payload·activity 로 출처를 명시한다.
      decisionNote: `owner-agent:${input.actor.agentId}${body.reason ? ` — ${body.reason}` : ""}`,
      payload }).returning();
    await tx.insert(activityLog).values({ companyId: issue.companyId, actorType: "agent", actorId: input.actor.agentId!,
      action: "workflow.replacement_owner_approved", entityType: "approval", entityId: approval.id,
      details: { sourceRunId: scope.run.id, targetRunId, decisionEventId: scope.owner.eventId,
        requesterAgentId: scope.mission.ownerAgentId, payloadHash: hashStructuredValue(payload),
        reason: body.reason ?? null } });
    return { approval, targetRunId, replay: false };
  });
}
