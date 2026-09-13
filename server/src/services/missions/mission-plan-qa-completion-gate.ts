// server/src/services/missions/mission-plan-qa-completion-gate.ts
//
// [파일 목적] T8 승인·완료 소비자가 같은 verified gate 영수증을 확인하는 통로.
//   readVerifiedPlanQaGate 는 저장된 검증 판정의 scope identity·불변 원문/영수증 bytes·이슈 표식을
//   다시 확인해 {verdict, evidenceRefId} 만 돌려준다(mutable refs·워크플로 존재는 승인이 아니다).
//   readPlanQaVerdict 는 owner-plan 소비자용: 엄격 대상(활성 추가 검사)은 gate 만, 구형 비대상은
//   기존 structured-first 원장을 읽는다. hasMissionPlanQaCompletionLedger 는 issueService/heartbeat
//   완료 게이트가 같은 영수증을 확인하게 한다. 표식이 있는데 명세가 사라지면 fail-closed(구형 fallback 금지).
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog, heartbeatRuns, issueComments, issues, missionPlanArtifacts, missionPlanQaVerdicts,
} from "@paperclipai/db";
import { planQaGateVerdictSchema as storedGateVerdictSchema } from "@paperclipai/shared";
import type { ValidationVerdict } from "../validation-verdict.js";
import type { QualityDb } from "../quality/contract.js";
import { readVerifiedPlanQaGate } from "./plan-qa-verified-gate.js";
export { readVerifiedPlanQaGate } from "./plan-qa-verified-gate.js";
import { planQaInputHashForPlan, type PlanQaManifest } from "./plan-qa-addendum-manifest.js";
import { loadPlanQaMarker, planQaGateMode, type VerifiedPlanQaGate } from "./plan-qa-addendum-gate.js";

type CompletionGateDb = QualityDb;
type CompletionBlockDb = Pick<Db, "insert" | "update">;
type CompletionBlockedIssue = Pick<typeof issues.$inferSelect, "companyId" | "id" | "status">;

export type MissionPlanQaCompletionLedgerResult = {
  readonly satisfied: boolean;
  readonly decisionHash: string | null;
  readonly lookupMode: "active_decision_hash" | "any_issue_verdict" | "missing_mission" | "verified_gate" | "fail_closed";
};

/** 소비자 편의: 이슈 표식+원장에서 저장된 gate scope 을 찾아 readVerifiedPlanQaGate 로 검증한다. */
export async function readVerifiedPlanQaGateForIssue(db: QualityDb, input: {
  companyId: string; planQaIssueId: string; decisionHash?: string | null;
}): Promise<VerifiedPlanQaGate | null> {
  const marker = await loadPlanQaMarker(db, input.companyId, input.planQaIssueId);
  if (!marker) return null;
  const decisionHash = input.decisionHash ?? marker.decisionHash;
  const [row] = await db.select({ qualityContract: missionPlanQaVerdicts.qualityContract }).from(missionPlanQaVerdicts)
    .where(and(
      eq(missionPlanQaVerdicts.companyId, input.companyId),
      eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
      eq(missionPlanQaVerdicts.decisionHash, decisionHash),
    )).limit(1);
  const stored = storedGateVerdictSchema.safeParse((row?.qualityContract as Record<string, unknown> | null)?.verdict);
  if (!stored.success || stored.data.scope.companyId !== input.companyId
    || stored.data.scope.issueId !== input.planQaIssueId || stored.data.scope.decisionHash !== decisionHash) return null;
  return readVerifiedPlanQaGate(db, stored.data.scope);
}

export type PlanQaStructuredVerdict = { verdict: ValidationVerdict; diagnostics: Array<Record<string, unknown>> };

function coercePlanQaDiagnostics(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? raw.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry)) : [];
}

function normalizePlanQaVerdict(verdict: unknown): ValidationVerdict | null {
  return verdict === "pass" || verdict === "request_changes" ? verdict : null;
}

/** Marked reviews without addenda still require their current pinned decision, never any-row fallback. */
async function hasCurrentMarkedIdentity(db: QualityDb, input: {
  companyId: string; missionId: string | null; planQaIssueId: string;
  missionPlanArtifactId?: string | null; decisionHash?: string | null;
}, manifest: PlanQaManifest): Promise<boolean> {
  if (manifest.missionId !== input.missionId
    || (input.missionPlanArtifactId && manifest.planArtifactId !== input.missionPlanArtifactId)
    || (input.decisionHash && manifest.decisionHash !== input.decisionHash)) return false;
  const [plan] = await db.select().from(missionPlanArtifacts).where(and(
    eq(missionPlanArtifacts.companyId, input.companyId), eq(missionPlanArtifacts.missionId, manifest.missionId),
    eq(missionPlanArtifacts.status, "active"),
  )).orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.createdAt)).limit(1);
  const marker = await loadPlanQaMarker(db, input.companyId, input.planQaIssueId);
  if (!plan || !marker || plan.id !== manifest.planArtifactId) return false;
  return readActivePlanQaDecisionHash(plan.refs, input.planQaIssueId) === manifest.decisionHash
    && recordProperty(recordProperty(plan.refs, "ownerPlanDecision"), "decisionHash") === manifest.decisionHash
    && marker.missionId === manifest.missionId && marker.planArtifactId === manifest.planArtifactId
    && marker.decisionHash === manifest.decisionHash && marker.reviewGeneration === manifest.reviewGeneration
    && planQaInputHashForPlan(plan, manifest.decisionHash) === marker.inputHash;
}

/** owner-plan 소비자용 판정 읽기. 엄격 대상은 verified gate 만 권위다(구형 비대상 경로는 기존 원장 유지). */
export async function readPlanQaVerdict(input: {
  db: Db;
  companyId: string;
  missionId: string | null;
  missionPlanArtifactId?: string | null;
  planQaIssueId: string;
  decisionHash?: string | null;
  afterCreatedAt?: Date | null;
}): Promise<PlanQaStructuredVerdict | null> {
  const mode = await planQaGateMode(input.db, { companyId: input.companyId, planQaIssueId: input.planQaIssueId });
  if (mode.kind === "fail_closed") return null;
  if (mode.manifest && !(await hasCurrentMarkedIdentity(input.db, input, mode.manifest))) return null;
  if (mode.kind === "strict") {
    const decisionHash = input.decisionHash ?? mode.manifest.decisionHash;
    const gate = await readVerifiedPlanQaGateForIssue(input.db, {
      companyId: input.companyId, planQaIssueId: input.planQaIssueId, decisionHash,
    });
    if (!gate) return null;
    const [row] = await input.db.select({ diagnostics: missionPlanQaVerdicts.diagnostics }).from(missionPlanQaVerdicts)
      .where(and(
        eq(missionPlanQaVerdicts.companyId, input.companyId),
        eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
        eq(missionPlanQaVerdicts.decisionHash, decisionHash),
      )).limit(1);
    return { verdict: gate.verdict, diagnostics: coercePlanQaDiagnostics(row?.diagnostics) };
  }
  // 구형(비대상): structured 전용 제출만 권위. 자연어 comment 유래 행은 표시/감사용이다.
  const conditions = [
    eq(missionPlanQaVerdicts.companyId, input.companyId),
    eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
    isNull(missionPlanQaVerdicts.sourceCommentId),
  ];
  if (input.missionId) conditions.push(eq(missionPlanQaVerdicts.missionId, input.missionId));
  const decisionHash = mode.manifest?.decisionHash ?? input.decisionHash;
  if (decisionHash) conditions.push(eq(missionPlanQaVerdicts.decisionHash, decisionHash));
  const [structuredVerdict] = await input.db
    .select({ verdict: missionPlanQaVerdicts.verdict, diagnostics: missionPlanQaVerdicts.diagnostics })
    .from(missionPlanQaVerdicts)
    .where(and(...conditions))
    .orderBy(desc(missionPlanQaVerdicts.updatedAt), desc(missionPlanQaVerdicts.createdAt), desc(missionPlanQaVerdicts.id))
    .limit(1);
  const verdictValue = normalizePlanQaVerdict(structuredVerdict?.verdict);
  if (!verdictValue) return null;
  return { verdict: verdictValue, diagnostics: coercePlanQaDiagnostics(structuredVerdict?.diagnostics) };
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Reflect.get(value, key);
}

function readActivePlanQaDecisionHash(refs: unknown, planQaIssueId: string): string | null {
  const planQa = recordProperty(refs, "planQa");
  if (trimmedString(recordProperty(planQa, "issueId")) !== planQaIssueId) return null;
  return trimmedString(recordProperty(planQa, "decisionHash"));
}

function buildMissingPlanQaVerdictGateComment(input: {
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly ledger: MissionPlanQaCompletionLedgerResult;
}) {
  return [
    "## Completion blocked: plan_qa_verdict_missing",
    `- Run: \`${input.run.id}\``,
    "- Reason: this mission_plan_qa issue cannot be marked done until the official mission_plan_qa_verdicts ledger contains the PLAN-QA verdict.",
    input.ledger.decisionHash
      ? `- Required decisionHash: \`${input.ledger.decisionHash}\``
      : "- Required evidence: any verdict row for this planQaIssueId in the same company and mission.",
    `- Lookup mode: \`${input.ledger.lookupMode}\``,
  ].join("\n");
}

export async function hasMissionPlanQaCompletionLedger(input: {
  readonly db: CompletionGateDb;
  readonly companyId: string;
  readonly missionId: string | null;
  readonly planQaIssueId: string;
}): Promise<MissionPlanQaCompletionLedgerResult> {
  if (!input.missionId) {
    return { satisfied: false, decisionHash: null, lookupMode: "missing_mission" };
  }
  const mode = await planQaGateMode(input.db as Db, { companyId: input.companyId, planQaIssueId: input.planQaIssueId });
  const [activePlan] = await input.db
    .select({ refs: missionPlanArtifacts.refs })
    .from(missionPlanArtifacts)
    .where(and(
      eq(missionPlanArtifacts.companyId, input.companyId),
      eq(missionPlanArtifacts.missionId, input.missionId),
      eq(missionPlanArtifacts.status, "active"),
    ))
    .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.createdAt))
    .limit(1);
  const decisionHash = activePlan
    ? readActivePlanQaDecisionHash(activePlan.refs, input.planQaIssueId)
    : null;

  if (mode.kind === "fail_closed"
    || (mode.manifest && !(await hasCurrentMarkedIdentity(input.db, input, mode.manifest)))) {
    return { satisfied: false, decisionHash, lookupMode: "fail_closed" };
  }
  if (mode.kind === "strict") {
    const gate = await readVerifiedPlanQaGateForIssue(input.db, {
      companyId: input.companyId, planQaIssueId: input.planQaIssueId, decisionHash,
    });
    return { satisfied: gate !== null, decisionHash, lookupMode: "verified_gate" };
  }
  // 구형 비대상: 표식이 있으면 any_issue_verdict fallback 없이 활성 decisionHash 만 인정한다.
  const lookupMode: MissionPlanQaCompletionLedgerResult["lookupMode"] = decisionHash ? "active_decision_hash" : "any_issue_verdict";
  const conditions = [
    eq(missionPlanQaVerdicts.companyId, input.companyId),
    eq(missionPlanQaVerdicts.missionId, input.missionId),
    eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
    inArray(missionPlanQaVerdicts.verdict, ["pass", "request_changes"]),
  ];
  if (decisionHash) conditions.push(eq(missionPlanQaVerdicts.decisionHash, decisionHash));
  const [verdict] = await input.db
    .select({ id: missionPlanQaVerdicts.id })
    .from(missionPlanQaVerdicts)
    .where(and(...conditions))
    .orderBy(desc(missionPlanQaVerdicts.updatedAt), desc(missionPlanQaVerdicts.createdAt))
    .limit(1);
  return { satisfied: Boolean(verdict), decisionHash, lookupMode };
}

export async function blockMissionPlanQaCompletionWithoutLedger(input: {
  readonly db: CompletionBlockDb;
  readonly issue: CompletionBlockedIssue;
  readonly run: typeof heartbeatRuns.$inferSelect;
  readonly ledger: MissionPlanQaCompletionLedgerResult;
}) {
  const now = new Date();
  await input.db
    .update(issues)
    .set({
      status: "blocked",
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(eq(issues.id, input.issue.id));
  await input.db.insert(issueComments).values({
    companyId: input.issue.companyId,
    issueId: input.issue.id,
    authorAgentId: input.run.agentId,
    body: buildMissingPlanQaVerdictGateComment(input),
  });
  await input.db.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.plan_qa_verdict_missing_auto_blocked",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      previousStatus: input.issue.status,
      nextStatus: "blocked",
      reason: "plan_qa_verdict_missing",
      decisionHash: input.ledger.decisionHash,
      lookupMode: input.ledger.lookupMode,
    },
  });
}
