import type { Router } from "express";
import type { Db, issues } from "@paperclipai/db";
import type {
  missionOwnerDecisionSubmitSchema,
  MissionOwnerDecisionSubmit,
} from "@paperclipai/shared/validators/workflow-agent-api";
import type { ownerSelfReplacementSchema, OwnerSelfReplacement } from "@paperclipai/shared/validators/workflow-replacement";
import type { ownerExecuteApiSchema, OwnerExecuteApi } from "@paperclipai/shared/validators/mission-owner-authority";
import type { validate } from "../middleware/validate.js";
import type { hermesOpsMutationGuard } from "../middleware/hermes-ops-mutation-guard.js";
import type { assertCompanyAccess, getActorInfo } from "./authz.js";
import type { logActivity } from "../services/activity-log.js";
import type { submitMissionOwnerDecision } from "../services/missions/mission-owner-recovery-agent-api.js";
import type { ownerSelfReplacement } from "../services/workflow/owner-self-replacement.js";
import type { ownerExecuteDecisionWindow } from "../services/missions/owner-execute-decision-window.js";

type OwnerRecoveryAgentRouteDependencies = {
  readonly db: Db;
  readonly hermesOpsMutationGuard: typeof hermesOpsMutationGuard;
  readonly validate: typeof validate;
  readonly routeParam: (value: string | string[] | undefined, name: string) => string;
  readonly loadIssue: (db: Db, issueId: string) => Promise<Pick<typeof issues.$inferSelect, "id" | "companyId" | "identifier">>;
  readonly assertCompanyAccess: typeof assertCompanyAccess;
  readonly getActorInfo: typeof getActorInfo;
  readonly missionOwnerDecisionSubmitSchema: typeof missionOwnerDecisionSubmitSchema;
  readonly submitMissionOwnerDecision: typeof submitMissionOwnerDecision;
  readonly logActivity: typeof logActivity;
  readonly ownerSelfReplacementSchema: typeof ownerSelfReplacementSchema;
  readonly ownerSelfReplacement: typeof ownerSelfReplacement;
  readonly ownerExecuteApiSchema: typeof ownerExecuteApiSchema;
  readonly ownerExecuteDecisionWindow: typeof ownerExecuteDecisionWindow;
};

export function registerOwnerRecoveryAgentRoutes(router: Router, deps: OwnerRecoveryAgentRouteDependencies) {
  const {
    db, hermesOpsMutationGuard, validate, routeParam, loadIssue, assertCompanyAccess, getActorInfo,
    missionOwnerDecisionSubmitSchema, submitMissionOwnerDecision, logActivity,
    ownerSelfReplacementSchema, ownerSelfReplacement, ownerExecuteApiSchema, ownerExecuteDecisionWindow,
  } = deps;

  router.post("/issues/:id/owner-recovery/decision", hermesOpsMutationGuard("owner_recovery.decision.submit"), validate(missionOwnerDecisionSubmitSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const data: MissionOwnerDecisionSubmit = req.body;
    const recorded = await submitMissionOwnerDecision({ db, issueId: issue.id, actor, data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.owner_recovery_decision_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        decision: recorded.submission.decision,
        decisionEventId: recorded.eventId,
      },
    });
    res.status(201).json({ eventId: recorded.eventId, createdAt: recorded.createdAt, decision: recorded.submission.decision });
  });

  // 오너 에이전트 자기 미션 실패 런의 교정 메타데이터 replacement — 제안+승인을 한 번에 기록한다.
  // 인가는 owner-recovery 결정 라우트와 동일 체인(미션 오너 + heartbeat identity + 체크아웃).
  router.post("/issues/:id/owner-recovery/replacement", hermesOpsMutationGuard("owner_recovery.replacement.self_approve"), validate(ownerSelfReplacementSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const data: OwnerSelfReplacement = req.body;
    const result = await ownerSelfReplacement(db, { issueId: issue.id, actor, request: data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.owner_recovery_replacement_recorded",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        approvalId: result.approval.id,
        sourceRunId: data.sourceRunId,
        targetRunId: result.targetRunId,
        replay: result.replay,
      },
    });
    res.status(201).json({ approvalId: result.approval.id, status: result.approval.status,
      targetRunId: result.targetRunId, replay: result.replay });
  });

  // 오너 결정 API 창구로 mission_owner_execute 오퍼레이션을 제출한다. 오너액션 이슈 웨이크 런에는
  // 스텝이 없어 런 도구 계약(플러그인 도구 라우트)이 만들어지지 않으므로(2026-10-17 사고, 403),
  // 같은 owner-recovery 인가 체인의 API 창구가 기존 executeMissionOwnerAction 검증·펜스·원장을
  // 그대로 재사용해 실행한다. 응답은 실행 결과 투영이라 신규·replay 모두 200 이다.
  router.post("/issues/:id/owner-recovery/execute", hermesOpsMutationGuard("owner_recovery.execute.submit"), validate(ownerExecuteApiSchema), async (req, res) => {
    const issue = await loadIssue(db, routeParam(req.params.id, "id"));
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const data: OwnerExecuteApi = req.body;
    const submitted = await ownerExecuteDecisionWindow(db, { issueId: issue.id, actor, request: data });
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.owner_recovery_execute_submitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        operation: submitted.result.operation,
        actionId: submitted.result.actionId,
        state: submitted.result.state,
        reasonCode: submitted.result.reasonCode,
      },
    });
    res.status(200).json(submitted.result);
  });
}
