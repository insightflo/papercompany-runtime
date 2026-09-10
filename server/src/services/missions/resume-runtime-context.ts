import { and, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, workflowResumeRequests, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { readOwnResumeRequestId } from "../workflow/resume-scope-fence.js";
import { withResumeSerialization } from "../workflow/resume/serialization.js";
import { assertMissionRuntimeAcceptsWork, ensureMissionAgentRuntime } from "./mission-runtime-manager.js";

type RuntimeInput = Omit<Parameters<typeof ensureMissionAgentRuntime>[1], "resumeContext"> & { runId: string };
const stale = () => conflict("Stale or missing resumed mission runtime producer identity");
const validGeneration = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Only persisted typed identity is authority. A linked wakeup fills absent typed fields,
 * never overrides them. No contextSnapshot, prompt, or caller request stamp is consumed.
 */
async function readProducer(db: Db, input: RuntimeInput, lock = false) {
  const heartbeatQuery = db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  )).limit(1);
  const [heartbeat] = await (lock ? heartbeatQuery.for("update") : heartbeatQuery);
  const wakeupQuery = heartbeat?.wakeupRequestId
    ? db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, heartbeat.wakeupRequestId),
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
    )).limit(1) : null;
  const [wakeup] = wakeupQuery ? await (lock ? wakeupQuery.for("update") : wakeupQuery) : [];
  return {
    heartbeat, wakeup,
    stepRunId: heartbeat?.workflowStepRunId ?? wakeup?.workflowStepRunId ?? null,
    generation: heartbeat?.workflowExecutionGeneration ?? wakeup?.workflowExecutionGeneration ?? null,
  };
}

/** Discover the serialization scope, then re-read producer/step/request and ensure in that
 * transaction. Default-workspace lifecycle preparation is not the actual worker runtime.
 */
export async function ensureMissionRuntimeForHeartbeat(db: Db, input: RuntimeInput) {
  const producer = await readProducer(db, input);
  if (!producer.heartbeat) throw stale();
  if (!producer.stepRunId && !input.currentIssueId) return ensureMissionAgentRuntime(db, input);
  // Issue lookup detects a resumed producer with missing/foreign typed identity; it never
  // supplies that identity. This prevents silently downgrading a stale heartbeat to ordinary.
  const candidates = await db.select({ step: workflowStepRuns, run: workflowRuns })
    .from(workflowStepRuns).innerJoin(workflowRuns, eq(workflowRuns.id, workflowStepRuns.workflowRunId))
    .where(and(
      eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.missionId, input.missionId),
      or(
        producer.stepRunId ? eq(workflowStepRuns.id, producer.stepRunId) : undefined,
        input.currentIssueId ? eq(workflowStepRuns.issueId, input.currentIssueId) : undefined,
      ),
    ));
  const linked = producer.stepRunId ? candidates.find(({ step }) => step.id === producer.stepRunId) : undefined;
  const resumedIssue = candidates.find(({ step }) =>
    step.issueId === input.currentIssueId && readOwnResumeRequestId(step.metadata) !== null);
  const scope = resumedIssue ?? linked ?? candidates[0];
  if (!scope) {
    if (producer.stepRunId) throw stale();
    return ensureMissionAgentRuntime(db, input);
  }

  return withResumeSerialization(db, {
    companyId: input.companyId, missionId: input.missionId, runId: scope.run.id,
  }, async ({ tx, mission, run, steps }) => {
    const scopedDb = tx as unknown as Db;
    const fresh = await readProducer(scopedDb, input, true);
    const step = steps.find((row) => row.id === scope.step.id);
    if (!step) throw stale();
    const requestId = readOwnResumeRequestId(step.metadata);
    // An unstamped OUTSIDE step remains ordinary even if its containing run was resumed.
    if (requestId === null) return ensureMissionAgentRuntime(scopedDb, input);
    if (!fresh.heartbeat || fresh.stepRunId !== step.id || fresh.heartbeat.issueId !== input.currentIssueId
      || !input.currentIssueId || step.issueId !== input.currentIssueId
      || readOwnResumeRequestId(run.metadata) !== requestId
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(requestId)
      || !validGeneration(fresh.generation) || fresh.generation !== step.executionGeneration) throw stale();
    const needsWakeup = fresh.heartbeat.workflowStepRunId == null || fresh.heartbeat.workflowExecutionGeneration == null;
    if (needsWakeup && (!fresh.wakeup || fresh.wakeup.workflowRunId !== run.id
      || fresh.wakeup.workflowStepRunId !== step.id)) throw stale();
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.currentIssueId), eq(issues.companyId, input.companyId), eq(issues.missionId, input.missionId),
    )).limit(1);
    const [request] = await tx.select().from(workflowResumeRequests).where(and(
      eq(workflowResumeRequests.id, requestId), eq(workflowResumeRequests.companyId, input.companyId),
      eq(workflowResumeRequests.missionId, input.missionId), eq(workflowResumeRequests.workflowRunId, run.id),
    )).for("update");
    if (!issue || !request || !["pending_delivery", "accepted"].includes(request.state)) throw stale();
    if (mission.status !== "active") {
      await assertMissionRuntimeAcceptsWork(scopedDb, input);
      throw stale();
    }
    return ensureMissionAgentRuntime(scopedDb, { ...input, resumeContext: { resumeRequestId: request.id } });
  });
}
