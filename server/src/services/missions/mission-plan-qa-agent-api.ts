// server/src/services/missions/mission-plan-qa-agent-api.ts
//
// [파일 목적] PLAN-QA 검토 전용 agent API. verdict(T4 v1 + T8 strict v2), input(T8 저장 명세 반환),
//   read(T8 readRef 생산) 경로를 등록한다. v2 는 서버가 이슈 표식+현재 실행 시도로 PlanQaScope 를
//   만들고 검사별 제출·원본 bytes 를 검증한다. 표식 없는 v2 와 base_changed 차단 이슈의 제출은 거부한다.
import { and, desc, eq } from "drizzle-orm";
import type { Request, RequestHandler, Router } from "express";
import type { ZodSchema } from "zod";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, missionPlanArtifacts, type issues } from "@paperclipai/db";
import type { QualityAgentActor } from "@paperclipai/shared";
import {
  missionPlanQaVerdictSubmitV2Schema, planQaCheckReadSchema, type MissionPlanQaVerdictSubmitV2,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../../errors.js";
import { assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { issueService } from "../issues.js";
import { logActivity } from "../activity-log.js";
import {
  recordLatestAuthorizedMissionOwnerPlanDecision,
  type PlanQaWakeupHandler,
  type PlanningIssueWakeupHandler,
} from "../mission-owner-plan-decisions.js";
import { recordMissionPlanQaVerdict, verifyPlanQaSubmission } from "./mission-plan-qa-verdicts.js";
import {
  dispatchPendingPlanQaResubmission,
  type PlanQaResubmissionWakeDispatcher,
} from "./plan-qa-resubmission.js";
import { assertLivePlanQaAttempt, buildPlanQaScope, loadPlanQaMarker, planQaGateMode, readPlanQaCheck, readPlanQaInputForIssue } from "./plan-qa-addendum-gate.js";
import { parseEvidence } from "../quality/contract.js";
import { blockedPlanQaTemplates, readPlanQaManifestForIssue } from "./plan-qa-addendum-manifest.js";

type IssueRow = typeof issues.$inferSelect;

export type MissionPlanQaApiIssue = Pick<IssueRow, "id" | "companyId" | "missionId" | "originKind">;

export type MissionPlanQaApiActor = {
  readonly actorType: "agent" | "user";
  readonly actorId: string;
  readonly agentId: string | null;
  readonly runId: string | null;
};

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const property = Reflect.get(value, key);
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : null;
}

async function loadActivePlanQaDecision(input: {
  readonly db: Db;
  readonly issue: MissionPlanQaApiIssue;
}): Promise<string> {
  if (!input.issue.missionId) throw unprocessable("Mission PLAN-QA verdict API requires a mission-scoped issue");
  const [activePlan] = await input.db
    .select({ refs: missionPlanArtifacts.refs })
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, input.issue.companyId),
      eq(missionPlanArtifacts.missionId, input.issue.missionId),
      eq(missionPlanArtifacts.status, "active"),
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.createdAt))
    .limit(1);
  const planQa = activePlan ? Reflect.get(activePlan.refs ?? {}, "planQa") : null;
  if (stringProperty(planQa, "issueId") !== input.issue.id) {
    throw unprocessable("Mission PLAN-QA verdict API requires the active planQa issue");
  }
  const decisionHash = stringProperty(planQa, "decisionHash");
  if (!decisionHash) throw unprocessable("Mission PLAN-QA verdict API requires an active planQa decisionHash");
  const marker = await loadPlanQaMarker(input.db, input.issue.companyId, input.issue.id);
  if (marker && (marker.decisionHash !== decisionHash
    || stringProperty(Reflect.get(activePlan?.refs ?? {}, "ownerPlanDecision"), "decisionHash") !== decisionHash)) {
    throw conflict("quality_plan_qa_binding_mismatch");
  }
  return decisionHash;
}

/** [T8 carry fix] base_changed 로 신규 실행이 차단된 binding 에서는 판정 제출을 받지 않는다. */
async function assertBindingNotBlocked(db: Db, issue: MissionPlanQaApiIssue) {
  const marker = await loadPlanQaMarker(db, issue.companyId, issue.id);
  if (!marker) return null;
  const manifest = await readPlanQaManifestForIssue(db, issue.companyId, issue.id, marker.manifestRef);
  if (blockedPlanQaTemplates(manifest).length) {
    throw conflict("quality_plan_qa_base_changed_required", { code: "quality_plan_qa_base_changed_required" });
  }
  return marker;
}

export async function submitMissionPlanQaVerdict(input: {
  readonly db: Db;
  readonly issue: MissionPlanQaApiIssue;
  readonly actor: MissionPlanQaApiActor;
  readonly data: MissionPlanQaVerdictSubmitV2;
  readonly agentActor?: QualityAgentActor | null;
  readonly enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  readonly enqueuePlanningIssueWakeup?: PlanningIssueWakeupHandler;
  readonly enqueuePlanQaResubmissionWakeup?: PlanQaResubmissionWakeDispatcher | null;
}) {
  if (input.issue.originKind !== "mission_plan_qa") {
    throw conflict("Mission PLAN-QA verdict API can only be used for mission_plan_qa issues");
  }
  const data = parseEvidence(missionPlanQaVerdictSubmitV2Schema, input.data);
  const missionId = input.issue.missionId;
  if (!missionId) throw unprocessable("Mission PLAN-QA verdict API requires a mission-scoped issue");
  const mode = await planQaGateMode(input.db, { companyId: input.issue.companyId, planQaIssueId: input.issue.id });
  if (mode.kind === "fail_closed") throw conflict("quality_plan_qa_binding_invalid");
  if (mode.kind === "strict" && data.schemaVersion !== 2) throw conflict("quality_plan_qa_v2_required");
  const decisionHash = await loadActivePlanQaDecision({ db: input.db, issue: input.issue });
  const marker = await assertBindingNotBlocked(input.db, input.issue);

  if (data.schemaVersion === 2) {
    // strict v2: agent 실행 binding 이 필수다(board/user 는 고정 명세 검증 제출을 할 수 없다).
    if (!input.agentActor || input.actor.actorType !== "agent"
      || input.actor.actorId !== input.agentActor.agentId || input.actor.agentId !== input.agentActor.agentId
      || input.actor.runId !== input.agentActor.heartbeatRunId || input.issue.companyId !== input.agentActor.companyId) {
      throw forbidden("quality_agent_required");
    }
    if (!marker) throw unprocessable("quality_plan_qa_binding_missing");
    const scope = await buildPlanQaScope(input.db, {
      companyId: input.issue.companyId, issueId: input.issue.id,
      heartbeatRunId: input.agentActor.heartbeatRunId, executionEpoch: input.agentActor.executionEpoch,
    });
    if (scope.decisionHash !== decisionHash) throw unprocessable("quality_plan_qa_binding_mismatch");
    await assertLivePlanQaAttempt(input.db, input.agentActor, scope);
    // Authorize before any base/result write; strict base remains pending until verified.
    await recordMissionPlanQaVerdict({
      db: input.db, companyId: input.issue.companyId, missionId, planQaIssueId: input.issue.id,
      decisionHash, verdict: data.verdict, diagnostics: data.diagnostics,
      reviewedBy: { actorType: "agent", actorId: input.agentActor.agentId },
      sourceRunId: input.agentActor.heartbeatRunId,
    });
    const gate = await verifyPlanQaSubmission(input.db, input.agentActor, {
      scope, schemaVersion: 2, checks: data.checks ?? [],
    });
    if (gate.status === "missing_evidence") {
      // [T8 bounded resubmission] 원장 저장은 verify 트랜잭션이 끝냈다. 커밋 뒤 기존 실행 권위로만
      //   재제출을 요청하고, 반환값은 요청 여부일 뿐 수락 증거가 아니다.
      const resubmission = await dispatchPendingPlanQaResubmission(input.db, {
        companyId: input.issue.companyId, planQaIssueId: input.issue.id,
        decisionHash, missionId,
        enqueue: input.enqueuePlanQaResubmissionWakeup ?? null,
      });
      return { ...gate, decisionHash, planDecisionStatus: "plan_qa_pending" as const, resubmission };
    }
    const planDecision = await recordLatestAuthorizedMissionOwnerPlanDecision({
      db: input.db, companyId: input.issue.companyId, missionId,
      requestedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
      enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
      enqueuePlanningIssueWakeup: input.enqueuePlanningIssueWakeup,
    });
    return {
      status: "recorded" as const, planQaIssueId: input.issue.id, decisionHash,
      verdict: gate.status, evidenceRefId: gate.evidenceRefId, planDecisionStatus: planDecision.status,
    };
  }

  const recorded = await recordMissionPlanQaVerdict({
    db: input.db,
    companyId: input.issue.companyId,
    missionId,
    planQaIssueId: input.issue.id,
    decisionHash,
    verdict: data.verdict,
    diagnostics: data.diagnostics,
    reviewedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
    sourceRunId: input.actor.runId,
  });
  const planDecision = await recordLatestAuthorizedMissionOwnerPlanDecision({
    db: input.db,
    companyId: input.issue.companyId,
    missionId,
    requestedBy: { actorType: input.actor.actorType, actorId: input.actor.actorId },
    enqueuePlanQaWakeup: input.enqueuePlanQaWakeup,
    enqueuePlanningIssueWakeup: input.enqueuePlanningIssueWakeup,
  });
  return { ...recorded, decisionHash, planDecisionStatus: planDecision.status };
}

async function loadIssue(db: Db, issueId: string) {
  const issue = await issueService(db).getById(issueId);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function authorizeMissionPlanQaApi(req: Request, db: Db, issue: Awaited<ReturnType<typeof loadIssue>>) {
  assertCompanyAccess(req, issue.companyId);
  if (issue.originKind !== "mission_plan_qa") {
    throw conflict("Mission PLAN-QA verdict API can only be used for mission_plan_qa issues");
  }
  const actor = getActorInfo(req);
  if (req.actor.type !== "agent") return actor;
  if (!actor.agentId) throw forbidden("Agent authentication required");
  if (!actor.runId) throw unauthorized("Agent run id required");
  await issueService(db).assertCheckoutOwner(issue.id, actor.agentId, actor.runId);
  return actor;
}

/** agent 실행 binding(회사·run·epoch)을 매 요청마다 서버가 다시 확인한다. */
async function agentQualityActor(db: Db, req: Request, issueCompanyId: string, rejectionCode: string): Promise<QualityAgentActor> {
  if (req.actor.type !== "agent") throw forbidden(rejectionCode);
  const { agentId, companyId, runId } = req.actor;
  if (!agentId || !companyId || !runId) throw forbidden(rejectionCode);
  if (companyId !== issueCompanyId) throw forbidden("Agent key cannot access another company");
  const [run] = await db.select({ executionEpoch: heartbeatRuns.executionEpoch }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.agentId, agentId)))
    .limit(1);
  if (!run || run.executionEpoch === null) throw forbidden(rejectionCode);
  return { agentId, companyId, heartbeatRunId: runId, executionEpoch: run.executionEpoch };
}

export function registerMissionPlanQaAgentRoutes(router: Router, deps: {
  readonly db: Db;
  readonly guard: (action: string) => RequestHandler;
  readonly validate: (schema: ZodSchema) => RequestHandler;
  readonly enqueuePlanQaWakeup?: PlanQaWakeupHandler;
  readonly enqueuePlanningIssueWakeup?: PlanningIssueWakeupHandler;
  readonly enqueuePlanQaResubmissionWakeup?: PlanQaResubmissionWakeDispatcher | null;
}) {
  router.post("/issues/:id/mission-plan-qa/verdict", deps.guard("mission.plan_qa.verdict.submit"), deps.validate(missionPlanQaVerdictSubmitV2Schema), async (req, res, next) => {
    try {
      const issue = await loadIssue(deps.db, String(req.params.id));
      const actor = await authorizeMissionPlanQaApi(req, deps.db, issue);
      const data: MissionPlanQaVerdictSubmitV2 = req.body;
      const agentActor = data.schemaVersion === 2
        ? await agentQualityActor(deps.db, req, issue.companyId, "quality_agent_required")
        : null;
      const verdict = await submitMissionPlanQaVerdict({
        db: deps.db, issue, actor, data, agentActor,
        enqueuePlanQaWakeup: deps.enqueuePlanQaWakeup,
        enqueuePlanningIssueWakeup: deps.enqueuePlanningIssueWakeup,
        enqueuePlanQaResubmissionWakeup: deps.enqueuePlanQaResubmissionWakeup,
      });
      await logActivity(deps.db, {
        companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId,
        agentId: actor.agentId, runId: actor.runId,
        action: "issue.mission_plan_qa_verdict_submitted", entityType: "issue", entityId: issue.id,
        details: {
          identifier: issue.identifier,
          verdict: verdict.status === "recorded" ? verdict.verdict : verdict.status,
          decisionHash: verdict.decisionHash,
          planDecisionStatus: verdict.planDecisionStatus,
        },
      });
      res.json(verdict);
    } catch (error) { next(error); }
  });

  router.get("/issues/:id/mission-plan-qa/input", async (req, res, next) => {
    try {
      const issue = await loadIssue(deps.db, String(req.params.id));
      await authorizeMissionPlanQaApi(req, deps.db, issue);
      const actor = await agentQualityActor(deps.db, req, issue.companyId, "quality_agent_required");
      const data = await readPlanQaInputForIssue(deps.db, actor, { issueId: issue.id });
      res.json({ data });
    } catch (error) { next(error); }
  });

  router.post("/issues/:id/mission-plan-qa/read", deps.guard("mission.plan_qa.read.submit"), deps.validate(planQaCheckReadSchema), async (req, res, next) => {
    try {
      const issue = await loadIssue(deps.db, String(req.params.id));
      await authorizeMissionPlanQaApi(req, deps.db, issue);
      const actor = await agentQualityActor(deps.db, req, issue.companyId, "quality_agent_required");
      const data: { checkId: string; pointers: string[] } = req.body;
      const read = await readPlanQaCheck(deps.db, actor, { issueId: issue.id, checkId: data.checkId, pointers: data.pointers });
      res.status(201).json({ data: read });
    } catch (error) { next(error); }
  });

  return router;
}
