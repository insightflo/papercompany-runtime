import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanQaVerdicts,
} from "@paperclipai/db";

type CompletionGateDb = Pick<Db, "select">;
type CompletionBlockDb = Pick<Db, "insert" | "update">;
type CompletionBlockedIssue = Pick<typeof issues.$inferSelect, "companyId" | "id" | "status">;

export type MissionPlanQaCompletionLedgerResult = {
  readonly satisfied: boolean;
  readonly decisionHash: string | null;
  readonly lookupMode: "active_decision_hash" | "any_issue_verdict" | "missing_mission";
};

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
  const lookupMode = decisionHash ? "active_decision_hash" : "any_issue_verdict";
  const verdictConditions = [
    eq(missionPlanQaVerdicts.companyId, input.companyId),
    eq(missionPlanQaVerdicts.missionId, input.missionId),
    eq(missionPlanQaVerdicts.planQaIssueId, input.planQaIssueId),
  ];
  if (decisionHash) {
    verdictConditions.push(eq(missionPlanQaVerdicts.decisionHash, decisionHash));
  }

  const [verdict] = await input.db
    .select({ id: missionPlanQaVerdicts.id })
    .from(missionPlanQaVerdicts)
    .where(and(...verdictConditions))
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
