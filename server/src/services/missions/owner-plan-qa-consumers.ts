import { and, eq } from "drizzle-orm";
import { issues, missionPlanArtifacts, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { mergeMissionPlanRefs, missionPlanArtifactService } from "../mission-plan-artifacts.js";
import type { ValidationVerdict } from "../validation-verdict.js";
import { readPlanQaVerdict } from "./mission-plan-qa-completion-gate.js";

export type PlanQaStatus = "pending" | "pass" | "request_changes";
export interface PlanQaRef {
  issueId: string;
  status: PlanQaStatus;
  verdict?: ValidationVerdict;
  decisionHash: string;
  reviewedAt?: string;
  reviewGeneration?: number;
  manifestRef?: { attachmentId: string; sha256: string };
  inputHash?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Display/index fields only. Consumers must independently read the verified verdict. */
export function readPlanQaRef(refs: unknown): PlanQaRef | null {
  if (!record(refs) || !record(refs.planQa)) return null;
  const planQa = refs.planQa;
  const issueId = typeof planQa.issueId === "string" ? planQa.issueId : null;
  const decisionHash = typeof planQa.decisionHash === "string" ? planQa.decisionHash : null;
  if (!issueId || !decisionHash) return null;
  const status: PlanQaStatus = planQa.status === "pass" || planQa.status === "request_changes" ? planQa.status : "pending";
  const verdict: ValidationVerdict | undefined = planQa.verdict === "pass" || planQa.verdict === "request_changes" ? planQa.verdict : undefined;
  const reviewedAt = typeof planQa.reviewedAt === "string" ? planQa.reviewedAt : undefined;
  const reviewGeneration = typeof planQa.reviewGeneration === "number" && Number.isSafeInteger(planQa.reviewGeneration) && planQa.reviewGeneration >= 0 ? planQa.reviewGeneration : undefined;
  const manifestRef = record(planQa.manifestRef) && typeof planQa.manifestRef.attachmentId === "string" && typeof planQa.manifestRef.sha256 === "string"
    ? planQa.manifestRef as { attachmentId: string; sha256: string } : undefined;
  const inputHash = typeof planQa.inputHash === "string" ? planQa.inputHash : undefined;
  return { issueId, status, verdict, decisionHash, reviewedAt, reviewGeneration, manifestRef, inputHash };
}

type ConsumerScope = { db: Db; companyId: string; missionId: string; missionPlanArtifactId: string; decisionHash: string };

/** Recheck at each materialization boundary, including recovery of a partially created workflow. */
export async function requireOwnerPlanQaPass(input: ConsumerScope): Promise<void> {
  const activePlan = await missionPlanArtifactService(input.db).getActiveMissionPlan(input);
  const ref = readPlanQaRef(activePlan?.refs);
  if (activePlan?.id !== input.missionPlanArtifactId || !ref || ref.decisionHash !== input.decisionHash
    || (await readPlanQaVerdict({ ...input, planQaIssueId: ref.issueId }))?.verdict !== "pass") {
    throw conflict("quality_plan_qa_approval_missing");
  }
}

export async function updatePlanQaRef(input: {
  db: Db; companyId: string; missionId: string; missionPlanArtifactId: string; patch: Partial<PlanQaRef>;
}): Promise<void> {
  const activePlan = await missionPlanArtifactService(input.db).getActiveMissionPlan(input);
  if (!activePlan || activePlan.id !== input.missionPlanArtifactId) return;
  const existing = readPlanQaRef(activePlan.refs);
  const merged: PlanQaRef = {
    issueId: input.patch.issueId ?? existing?.issueId ?? "",
    status: input.patch.status ?? existing?.status ?? "pending",
    verdict: input.patch.verdict ?? existing?.verdict,
    decisionHash: input.patch.decisionHash ?? existing?.decisionHash ?? "",
    reviewedAt: input.patch.reviewedAt ?? existing?.reviewedAt,
    reviewGeneration: existing?.reviewGeneration,
    manifestRef: existing?.manifestRef,
    inputHash: existing?.inputHash,
  };
  if (merged.verdict || merged.status !== "pending") {
    const gate = await readPlanQaVerdict({ ...input, planQaIssueId: merged.issueId, decisionHash: merged.decisionHash });
    if (!gate || (merged.verdict && gate.verdict !== merged.verdict)
      || (merged.status !== "pending" && gate.verdict !== merged.status)) {
      throw conflict("quality_plan_qa_verdict_missing");
    }
  }
  await input.db.update(missionPlanArtifacts)
    .set({ refs: mergeMissionPlanRefs(activePlan.refs, { planQa: merged }), updatedAt: new Date() })
    .where(and(eq(missionPlanArtifacts.companyId, input.companyId), eq(missionPlanArtifacts.id, activePlan.id)));
}

/** A valid request_changes completes the review, but never authorizes execution. */
export async function closePlanQaIssue(input: { db: Db; companyId: string; missionId: string; planQaIssueId: string; decisionHash: string }): Promise<void> {
  if (!(await readPlanQaVerdict(input))) throw conflict("quality_plan_qa_verdict_missing");
  await input.db.update(issues).set({ status: "done", updatedAt: new Date() })
    .where(and(eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId),
      eq(issues.id, input.planQaIssueId), eq(issues.originKind, "mission_plan_qa")));
}
