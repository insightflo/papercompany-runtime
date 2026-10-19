import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents } from "@paperclipai/db";
import { workflowQaRemediationsSchema, workflowVerdictFindingsSchema } from "@paperclipai/shared";
import type {
  WorkflowNonblockingAcceptance,
  WorkflowQaRemediations,
  WorkflowValidationVerdictPayload,
  WorkflowValidationVerdictValue,
  WorkflowVerdictFinding,
} from "@paperclipai/shared";
import type { WorkflowValidationLedgerResult } from "./validation-verdict-ledger.js";

type ResolveContext = typeof import("./validation-verdict-ledger.js").resolveWorkflowValidationContext;
type WorkflowValidationDb = Pick<Db, "select" | "insert">;
type WorkflowValidationIssue = Parameters<ResolveContext>[1];

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export async function recordWorkflowValidationVerdict(input: {
  readonly db: WorkflowValidationDb;
  readonly issue: WorkflowValidationIssue;
  readonly verdict: WorkflowValidationVerdictValue;
  readonly source: "workflow_api";
  readonly actorAgentId?: string | null;
  readonly heartbeatRunId?: string | null;
  readonly sourceText?: string | null;
  readonly nonblockingAcceptance?: WorkflowNonblockingAcceptance | null;
  readonly findings?: readonly WorkflowVerdictFinding[] | null;
  readonly remediations?: WorkflowQaRemediations | null;
}, resolveWorkflowValidationContext: ResolveContext): Promise<WorkflowValidationLedgerResult> {
  const context = await resolveWorkflowValidationContext(input.db, input.issue, { mode: "record" });
  if (!context.isCandidate || !context.workflowRunId || !context.workflowStepRunId) {
    return { ...context, satisfied: false, verdict: null, insufficientEvidence: false, insufficientEvidenceReason: null };
  }
  // [qa-cap acceptance] nonblocking 분류는 request_changes verdict 와만 공존. heartbeat/comment 경로는
  //   이 필드를 넘기지 않으므로 구조적 수용은 오직 공식 workflow API(request_changes) 만 가능하다.
  const acceptance = input.nonblockingAcceptance && input.verdict === "request_changes"
    ? input.nonblockingAcceptance
    : null;
  // [qa defect layer] findings 도 nonblockingAcceptance 와 동일하게 request_changes 와만 공존한다.
  //   heartbeat/comment 경로는 이 필드를 넘기지 않으므로 구조화 계층 태그는 오직 공식 workflow API 만 제출 가능.
  const findings = input.findings && input.findings.length > 0 && input.verdict === "request_changes"
    ? workflowVerdictFindingsSchema.parse(input.findings)
    : null;
  // [qa mechanical remediation] remediations 도 request_changes 와만 공존한다(스키마 refine 보장).
  //   heartbeat/comment 경로는 이 필드를 넘기지 않으므로 기계적 수정 지시는 오직 공식 workflow API 만 제출 가능.
  const remediations = input.remediations && input.verdict === "request_changes"
    ? workflowQaRemediationsSchema.parse(input.remediations)
    : null;
  const boundedReason = typeof input.sourceText === "string" && input.sourceText.trim().length > 0
    ? input.sourceText.trim().slice(0, 4000)
    : null;
  const payload = {
    kind: "workflow_validation_verdict",
    workflowRunId: context.workflowRunId,
    stepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    verdict: input.verdict,
    diagnostics: [],
    ...(boundedReason ? { reason: boundedReason } : {}),
    ...(acceptance ? { nonblockingAcceptance: acceptance } : {}),
    ...(findings ? { findings } : {}),
    ...(remediations ? { remediations } : {}),
  } satisfies WorkflowValidationVerdictPayload;
  const sourceKey = input.heartbeatRunId
    ? `run:${input.heartbeatRunId}`
    : `text:${hashText(input.sourceText ?? input.verdict)}`;

  await input.db.insert(workflowTransitionEvents).values({
    companyId: input.issue.companyId,
    missionId: input.issue.missionId,
    workflowRunId: context.workflowRunId,
    workflowStepRunId: context.workflowStepRunId,
    issueId: input.issue.id,
    heartbeatRunId: input.heartbeatRunId ?? null,
    eventType: "workflow_validation_verdict",
    layer: "workflow_validation",
    verdict: input.verdict,
    decision: input.verdict,
    reason: input.source,
    reasonCode: input.source,
    idempotencyKey: `workflow-validation-verdict:${input.issue.companyId}:${input.issue.id}:${context.workflowStepRunId}:${sourceKey}`,
    payload,
  }).onConflictDoNothing();

  return {
    ...context,
    satisfied: true,
    verdict: input.verdict,
    insufficientEvidence: false,
    insufficientEvidenceReason: null,
  };
}
