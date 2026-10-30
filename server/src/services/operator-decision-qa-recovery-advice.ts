import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { issues, operatorDecisions, workflowRuns, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { workflowVerdictFindingsSchema, type WorkflowVerdictFinding } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { stripOperatorDecisionServerContext } from "./operator-decision-server-context.js";
import { validateAndHashOperatorDecisionCreate } from "./operator-decision-result.js";
import { buildHistoricalV3Candidates, buildHistoricalV3RequestKey, type HistoricalQaSourceDefectCardIdentityInput } from "./workflow/qa-source-defect-card-historical-v3.js";
import { applyRecurrencePromotion } from "./workflow/control-flow/rework-contract.js";
import { heartbeatRunScopedToIssue, loadPriorRejectedFindings, loadWorkflowApiFindings } from "./workflow/validation-verdict-ledger.js";
import { loadExecutionDefinition, type LoadedExecutionDefinition } from "./workflow/execution-definition.js";
import { overlayQaRecoveryAdvice } from "./operator-decision-qa-recovery-display.js";
export { overlayQaRecoveryAdvice } from "./operator-decision-qa-recovery-display.js";

type DecisionRow = typeof operatorDecisions.$inferSelect;
type StepRun = Pick<typeof workflowStepRuns.$inferSelect, "id" | "workflowRunId" | "stepId" | "issueId" | "status" | "iterationIndex" | "completedAt" | "metadata" | "startedAt" | "lastDispatchAttemptAt" | "lastDispatchAcceptedAt" | "dispatchOwnerHeartbeatRunId" | "dispatchOwnerWakeupRequestId">;
type IssueScope = Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId">;
type Location = { runId: string; producerStepId: string; iteration: number };

export type QaRecoveryAdvice =
  | { disposition: "outside_default_scope" }
  | { disposition: "unproven"; reason: string }
  | { disposition: "verified"; cause: "artifact_only" | "source_only" | "mixed"; findings: WorkflowVerdictFinding[];
    producerStepId: string; iteration: number; maxIterations: number; producerCompletedAt: Date;
    sourceIssueId: string | null; collectionChoiceAllowed: boolean };

const qaSource = "workflow_qa_rejection";
const collectionOption = "rerun_source_collection";
const v3Key = /^qa-source-defect(?:-sha256)?:v3:/u;
const v4Key = /^qa-source-defect(?:-sha256)?:v4:/u;
const verdictPayload = z.object({ kind: z.literal("workflow_validation_verdict"), workflowRunId: z.string().uuid(),
  stepRunId: z.string().uuid(), issueId: z.string().uuid(),
  verdict: z.enum(["pass", "request_changes", "insufficient_evidence"]) }).passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonparticipatingSkippedQa(run: StepRun): boolean {
  // Native skip propagation writes this marker only after activation classification; require it plus
  // the skipped row and empty dispatch identity. A missing event or issue is never enough by itself.
  return run.status === "skipped" && run.issueId === null && isRecord(run.metadata)
    && run.metadata.controlFlowSkipped === true && run.startedAt === null
    && run.lastDispatchAttemptAt === null && run.lastDispatchAcceptedAt === null
    && run.dispatchOwnerHeartbeatRunId === null && run.dispatchOwnerWakeupRequestId === null;
}

function hasCollectionOption(card: DecisionRow): boolean {
  return Array.isArray(card.definition.options) && card.definition.options.some((option) => option.id === collectionOption);
}

function locateV3Card(card: DecisionRow): Location | null {
  if (!v3Key.test(card.requestKey) || !isRecord(card.sourceContext)) return null;
  const runId = card.sourceContext.workflowRunId;
  if (typeof runId !== "string" || !z.string().uuid().safeParse(runId).success
    || typeof card.sourceContext.missionId !== "string" || !card.sourceId.startsWith(`${runId}:`)) return null;
  const tail = card.sourceId.slice(runId.length + 1), separator = tail.lastIndexOf(":");
  if (separator <= 0) return null;
  const producerStepId = tail.slice(0, separator), iteration = Number(tail.slice(separator + 1));
  if (!producerStepId || !Number.isSafeInteger(iteration) || iteration < 0
    || card.sourceId !== `${runId}:${producerStepId}:${iteration}`
    || card.requestKey !== buildHistoricalV3RequestKey({ workflowRunId: runId, producerStepId, iteration })) return null;
  return { runId, producerStepId, iteration };
}

export function storedHashMatches(card: DecisionRow, requireCurrentV4 = false): boolean {
  try {
    const hashMatches = validateAndHashOperatorDecisionCreate({ schemaVersion: card.schemaVersion, requestKey: card.requestKey,
      priority: card.priority, interactionType: card.interactionType, title: card.title, description: card.description,
      sourceType: card.sourceType, sourceId: card.sourceId,
      sourceContext: stripOperatorDecisionServerContext(card.sourceContext), definition: card.definition,
      issueId: card.issueId, continuationMode: card.continuationMode }).requestHash === card.requestHash;
    return hashMatches && (!requireCurrentV4 || (v4Key.test(card.requestKey)
      && locateV3Card({ ...card, requestKey: card.requestKey.replace(":v4:", ":v3:") }) !== null));
  } catch { return false; }
}

function causeOf(findings: readonly WorkflowVerdictFinding[]): "artifact_only" | "source_only" | "mixed" | null {
  if (!findings.length) return null;
  if (findings.every((finding) => finding.layer === "artifact")) return "artifact_only";
  if (findings.every((finding) => finding.layer === "source_data")) return "source_only";
  return "mixed";
}

function sameFindings(left: readonly WorkflowVerdictFinding[], right: readonly WorkflowVerdictFinding[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoizedRead<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (!value) { value = read(); cache.set(key, value); }
  return value;
}

function issueMatches(issue: IssueScope | undefined, companyId: string, missionId: string): issue is IssueScope { return Boolean(issue && issue.companyId === companyId && issue.missionId === missionId); }

async function readFrozenDefinition(db: Pick<Db, "select">, runId: string): Promise<LoadedExecutionDefinition | null> {
  try { return await loadExecutionDefinition(db, runId, { requireHistorical: true }); }
  catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 422)) return null;
    throw error;
  }
}

/** Batches run/step/card facts; repeated generations share the same frozen definition and QA lookups. */
export async function loadQaRecoveryAdviceFacts(db: Pick<Db, "select">, cards: readonly DecisionRow[]) {
  const result = new Map<string, QaRecoveryAdvice>(cards.map((card) => [card.id, { disposition: "outside_default_scope" }]));
  const candidates = cards.filter((card) => card.status === "pending" && card.sourceType === qaSource && hasCollectionOption(card));
  for (const card of candidates) if (!v4Key.test(card.requestKey) || !storedHashMatches(card, true))
    result.set(card.id, { disposition: "unproven", reason: "historical_qa_identity_unproven" });
  const located = candidates.flatMap((card) => v4Key.test(card.requestKey) ? [] :
    (location => location ? [{ card, location }] : [])(locateV3Card(card)));
  if (!located.length) return result;

  const runIds = [...new Set(located.map(({ location }) => location.runId))];
  const runs = await db.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, missionId: workflowRuns.missionId })
    .from(workflowRuns).where(inArray(workflowRuns.id, runIds));
  const stepRuns = await db.select({ id: workflowStepRuns.id, workflowRunId: workflowStepRuns.workflowRunId,
    stepId: workflowStepRuns.stepId, issueId: workflowStepRuns.issueId, status: workflowStepRuns.status,
    iterationIndex: workflowStepRuns.iterationIndex, completedAt: workflowStepRuns.completedAt,
    metadata: workflowStepRuns.metadata, startedAt: workflowStepRuns.startedAt,
    lastDispatchAttemptAt: workflowStepRuns.lastDispatchAttemptAt,
    lastDispatchAcceptedAt: workflowStepRuns.lastDispatchAcceptedAt,
    dispatchOwnerHeartbeatRunId: workflowStepRuns.dispatchOwnerHeartbeatRunId,
    dispatchOwnerWakeupRequestId: workflowStepRuns.dispatchOwnerWakeupRequestId })
    .from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId, runIds));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const rowsByRun = new Map<string, StepRun[]>();
  for (const row of stepRuns) rowsByRun.set(row.workflowRunId, [...(rowsByRun.get(row.workflowRunId) ?? []), row]);
  const definitions = new Map<string, LoadedExecutionDefinition | null>();
  for (const runId of runIds) definitions.set(runId, await readFrozenDefinition(db, runId));

  const qaStepRunIds = new Set<string>();
  for (const { location } of located) {
    const producer = definitions.get(location.runId)?.steps.find((step) => step.id === location.producerStepId);
    for (const edge of producer?.conditionalDependencies ?? []) {
      if (!edge.isBackEdge || edge.when !== "qa_request_changes") continue;
      const qa = rowsByRun.get(location.runId)?.find((row) => row.stepId === edge.stepId);
      if (qa?.issueId) qaStepRunIds.add(qa.id);
    }
  }
  const issueIds = [...new Set([...located.map(({ card }) => card.issueId), ...stepRuns.map((row) => row.issueId)]
    .filter((id): id is string => typeof id === "string"))];
  const issueRows = issueIds.length ? await db.select({ id: issues.id, companyId: issues.companyId, missionId: issues.missionId })
    .from(issues).where(inArray(issues.id, issueIds)) : [];
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  const currentEvents = qaStepRunIds.size ? await db.select({
    id: workflowTransitionEvents.id, companyId: workflowTransitionEvents.companyId, missionId: workflowTransitionEvents.missionId,
    workflowRunId: workflowTransitionEvents.workflowRunId, workflowStepRunId: workflowTransitionEvents.workflowStepRunId,
    issueId: workflowTransitionEvents.issueId, heartbeatRunId: workflowTransitionEvents.heartbeatRunId,
    eventType: workflowTransitionEvents.eventType, layer: workflowTransitionEvents.layer, verdict: workflowTransitionEvents.verdict,
    reason: workflowTransitionEvents.reason, reasonCode: workflowTransitionEvents.reasonCode,
    payload: workflowTransitionEvents.payload, createdAt: workflowTransitionEvents.createdAt,
  }).from(workflowTransitionEvents).where(and(
    inArray(workflowTransitionEvents.workflowStepRunId, [...qaStepRunIds]),
    eq(workflowTransitionEvents.eventType, "workflow_validation_verdict"), eq(workflowTransitionEvents.reason, "workflow_api"),
  )).orderBy(desc(workflowTransitionEvents.createdAt), desc(workflowTransitionEvents.id)) : [];
  const latest = new Map<string, (typeof currentEvents)[number]>();
  for (const event of currentEvents) {
    if (event.workflowStepRunId && !latest.has(event.workflowStepRunId)) latest.set(event.workflowStepRunId, event);
  }
  const heartbeatCache = new Map<string, Promise<boolean>>();
  const findingsCache = new Map<string, Promise<WorkflowVerdictFinding[] | null>>();
  const priorFindingsCache = new Map<string, Promise<WorkflowVerdictFinding[] | null>>();

  for (const { card, location } of located) {
    const run = runById.get(location.runId), definition = definitions.get(location.runId);
    const runRows = rowsByRun.get(location.runId) ?? [];
    const producerRows = runRows.filter((row) => row.stepId === location.producerStepId);
    const latestIteration = Math.max(-1, ...producerRows.map((row) => row.iterationIndex ?? -1));
    const latestProducerRows = producerRows.filter((row) => row.iterationIndex === latestIteration);
    const producer = latestProducerRows.length === 1 ? latestProducerRows[0] : undefined;
    const producerDef = definition?.steps.find((step) => step.id === location.producerStepId);
    const edges = producerDef?.conditionalDependencies?.filter((edge) => edge.isBackEdge && edge.when === "qa_request_changes") ?? [];
    const caps = [...new Set(edges.map((edge) => edge.maxIterations))], maxIterations = caps[0];
    if (!run || !definition || run.companyId !== card.companyId || !run.missionId
      || !isRecord(card.sourceContext) || card.sourceContext.missionId !== run.missionId
      || !card.issueId || !issueMatches(issueById.get(card.issueId), card.companyId, run.missionId)
      || !producer || producer.status !== "completed" || !producer.completedAt || producer.iterationIndex !== location.iteration
      || !producer.issueId || !issueMatches(issueById.get(producer.issueId), card.companyId, run.missionId)
      || !producerDef || !edges.length || caps.length !== 1 || typeof maxIterations !== "number"
      || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || !storedHashMatches(card)
      || card.qualityActionId !== null || card.qualityBinding !== null) continue;

    const producerCompletedAt = producer.completedAt;
    const refs: HistoricalQaSourceDefectCardIdentityInput["qaRefs"][number][] = [];
    const findings: WorkflowVerdictFinding[] = [];
    let scopeInvalid = false;
    for (const edge of edges) {
      const qaRun = runRows.find((row) => row.stepId === edge.stepId);
      if (!qaRun) { scopeInvalid = true; break; }
      if (isNonparticipatingSkippedQa(qaRun)) continue;
      if (!qaRun.issueId || !issueMatches(issueById.get(qaRun.issueId), card.companyId, run.missionId)
        || (qaRun.status !== "failed" && qaRun.status !== "completed")) { scopeInvalid = true; break; }
      const qaIssueId = qaRun.issueId;
      const event = latest.get(qaRun.id);
      if (!event) { scopeInvalid = true; break; }
      const payload = verdictPayload.safeParse(event.payload);
      if (event.companyId !== card.companyId || event.missionId !== run.missionId || event.workflowRunId !== run.id
        || event.workflowStepRunId !== qaRun.id || event.issueId !== qaIssueId || event.layer !== "workflow_validation"
        || event.reasonCode !== "workflow_api" || !payload.success || payload.data.workflowRunId !== run.id
        || payload.data.stepRunId !== qaRun.id || payload.data.issueId !== qaIssueId || payload.data.verdict !== event.verdict
        || !(await memoizedRead(heartbeatCache, `${event.heartbeatRunId}|${card.companyId}|${qaIssueId}`,
          () => heartbeatRunScopedToIssue(db, event.heartbeatRunId, { companyId: card.companyId, issueId: qaIssueId })))) {
        scopeInvalid = true; break;
      }
      if (payload.data.verdict !== "request_changes") continue;
      if ((qaRun.status !== "failed" && qaRun.status !== "completed") || !qaRun.completedAt
        || qaRun.completedAt.getTime() < producerCompletedAt.getTime()
        || event.createdAt.getTime() < producerCompletedAt.getTime()) { scopeInvalid = true; break; }
      const official = await memoizedRead(findingsCache, `${card.companyId}|${qaIssueId}|${run.id}|${qaRun.id}`,
        () => loadWorkflowApiFindings({ db, companyId: card.companyId, issueId: qaIssueId,
          workflowRunId: run.id, workflowStepRunId: qaRun.id }));
      const parsed = workflowVerdictFindingsSchema.safeParse(isRecord(event.payload) ? event.payload.findings : null);
      if (!official?.length || !parsed.success || !sameFindings(official, parsed.data)) { scopeInvalid = true; break; }
      refs.push({ qaStepId: edge.stepId, qaIssueId });
      findings.push(...official);
    }
    if (scopeInvalid || !refs.length) continue;

    const priorFindings: WorkflowVerdictFinding[] = [];
    for (const ref of refs) {
      const qaRun = runRows.find((row) => row.stepId === ref.qaStepId && row.issueId === ref.qaIssueId)!;
      const prior = await memoizedRead(priorFindingsCache, `${card.companyId}|${ref.qaIssueId}|${run.id}|${qaRun.id}|${producerCompletedAt.toISOString()}`,
        () => loadPriorRejectedFindings({ db, companyId: card.companyId, issueId: ref.qaIssueId!,
          workflowRunId: run.id, workflowStepRunId: qaRun.id, notAfter: producerCompletedAt }));
      if (prior) priorFindings.push(...prior);
    }
    const recurrence = applyRecurrencePromotion(findings, priorFindings);
    const hashInput: HistoricalQaSourceDefectCardIdentityInput = { workflowRunId: run.id,
      producerStepId: location.producerStepId, iteration: location.iteration, maxIterations, findings, qaRefs: refs,
      missionId: run.missionId, linkIssueId: card.issueId };
    const exactHash = buildHistoricalV3Candidates(hashInput, recurrence.recurringFindingIds).some((candidate) => {
      try { return candidate.requestKey === card.requestKey
        && validateAndHashOperatorDecisionCreate(candidate).requestHash === card.requestHash; }
      catch { return false; }
    });
    const cause = causeOf(findings);
    if (!exactHash || !cause) continue;

    const sourceStepId = producerDef.dependencies.length === 1 ? producerDef.dependencies[0] : null;
    const sourceRun = sourceStepId ? runRows.find((row) => row.stepId === sourceStepId) : null;
    const sourceIssueId = sourceRun?.issueId && sourceRun.status === "completed" && sourceRun.completedAt
      && sourceRun.completedAt.getTime() <= producerCompletedAt.getTime()
      && issueMatches(issueById.get(sourceRun.issueId), card.companyId, run.missionId) ? sourceRun.issueId : null;
    result.set(card.id, { disposition: "verified", cause, findings, producerStepId: location.producerStepId,
      iteration: location.iteration, maxIterations, producerCompletedAt, sourceIssueId,
      collectionChoiceAllowed: cause === "source_only" && sourceIssueId !== null });
  }
  return result;
}


export function qaRecoveryCollectionChoiceAllowed(advice: QaRecoveryAdvice): boolean {
  return advice.disposition === "verified" && advice.collectionChoiceAllowed;
}
