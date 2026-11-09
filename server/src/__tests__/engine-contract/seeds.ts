// engine-contract 시드 헬퍼 — helpers.ts 에서 재수출된다.
// 원칙: 시드는 순수 DB insert 만. 서비스 내부 헬퍼/클로저를 import 하지 않는다.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  missions,
  operatorDecisions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
  type Db,
} from "@paperclipai/db";

export const MIN = 60_000;

export async function seedHeartbeatRun(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    workflowStepRunId?: string | null;
    wakeupRequestId?: string | null;
    status: string;
    terminalOutcome?: string | null;
    finalizationVersion?: number | null;
    resultJson?: Record<string, unknown> | null;
    error?: string | null;
    errorCode?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
    stdoutExcerpt?: string | null;
    stderrExcerpt?: string | null;
    finishedAt?: Date | null;
    settledAt?: Date | null;
    createdAt?: Date | null;
    updatedAt?: Date | null;
    executionScopeKind?: string | null;
    executionEpoch?: number | null;
    executionToken?: string | null;
    executorOwnerId?: string | null;
    executorOwnerLeaseToken?: string | null;
    executorOwnerLeaseEpoch?: number | null;
    executorOwnerLeaseExpiresAt?: Date | null;
    executorOwnerReleasedAt?: Date | null;
  },
) {
  const [row] = await db
    .insert(heartbeatRuns)
    .values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId ?? null,
      workflowStepRunId: input.workflowStepRunId ?? null,
      wakeupRequestId: input.wakeupRequestId ?? null,
      status: input.status,
      terminalOutcome: input.terminalOutcome ?? null,
      finalizationVersion: input.finalizationVersion ?? 0,
      resultJson: input.resultJson ?? null,
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      contextSnapshot: input.contextSnapshot ?? null,
      stdoutExcerpt: input.stdoutExcerpt ?? null,
      stderrExcerpt: input.stderrExcerpt ?? null,
      finishedAt: input.finishedAt ?? null,
      settledAt: input.settledAt ?? null,
      createdAt: input.createdAt ?? undefined,
      updatedAt: input.updatedAt ?? undefined,
      executionScopeKind: input.executionScopeKind ?? null,
      executionEpoch: input.executionEpoch ?? null,
      executionToken: input.executionToken ?? null,
      executorOwnerId: input.executorOwnerId ?? null,
      executorOwnerLeaseToken: input.executorOwnerLeaseToken ?? null,
      executorOwnerLeaseEpoch: input.executorOwnerLeaseEpoch ?? null,
      executorOwnerLeaseExpiresAt: input.executorOwnerLeaseExpiresAt ?? null,
      executorOwnerReleasedAt: input.executorOwnerReleasedAt ?? null,
    })
    .returning();
  return row;
}

export interface SeededMissionRun {
  mission: typeof missions.$inferSelect;
  issue: typeof issues.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
  wakeupRequestId: string;
}

/** 미션 + 실행 이슈 + checkout/execution 잠금 + wakeup + v1 heartbeat run 묶음 시드. */
export async function seedMissionV1Run(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    mission?: Partial<typeof missions.$inferInsert>;
    issue?: Partial<typeof issues.$inferInsert>;
    stepCompleted?: boolean;
    run?: Partial<Omit<Parameters<typeof seedHeartbeatRun>[1], "companyId" | "agentId">>;
  },
): Promise<SeededMissionRun> {
  const [mission] = await db
    .insert(missions)
    .values({
      companyId: input.companyId,
      title: "Contract mission",
      status: "active",
      ownerAgentId: input.agentId,
      ...input.mission,
    })
    .returning();
  const issueId = randomUUID();
  const [issue] = await db
    .insert(issues)
    .values({
      id: issueId,
      companyId: input.companyId,
      missionId: mission.id,
      title: "Contract issue",
      status: "in_progress",
      assigneeAgentId: input.agentId,
      originKind: input.stepCompleted ? "workflow_execution" : "manual",
      ...input.issue,
    })
    .returning();
  const run = await seedHeartbeatRun(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: issue.id,
    status: "running",
    finalizationVersion: 1,
    // v1 종결 결정(terminal_outcome first-wins)은 실행 권위 식별자가 모두 있어야만 기록된다.
    executionScopeKind: "issue_nonworkflow",
    executionEpoch: 1,
    executionToken: randomUUID(),
    executorOwnerId: "executor-1",
    executorOwnerLeaseToken: randomUUID(),
    executorOwnerLeaseEpoch: 1,
    executorOwnerLeaseExpiresAt: new Date(Date.now() + 5 * MIN),
    ...input.run,
  });
  const wakeupRequestId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: wakeupRequestId,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: issue.id,
    runId: run.id,
    source: "issue_assigned",
    reason: "issue_assigned",
    idempotencyKey: `contract-wake-${run.id}`,
    status: "claimed",
    claimedAt: new Date(),
  });
  await db
    .update(heartbeatRuns)
    .set({ wakeupRequestId })
    .where(eq(heartbeatRuns.id, run.id));
  await db
    .update(issues)
    .set({ executionRunId: run.id, checkoutRunId: run.id, executionLockedAt: new Date() })
    .where(eq(issues.id, issue.id));
  return { mission, issue, run: { ...run, wakeupRequestId }, wakeupRequestId };
}

export async function seedWorkflow(
  db: Db,
  input: {
    companyId: string;
    missionId?: string | null;
    steps: { id: string; name: string; agentId: string; dependencies: string[] }[];
    run?: Partial<typeof workflowRuns.$inferInsert>;
    stepRows?: (Partial<typeof workflowStepRuns.$inferInsert> & { stepId: string })[];
  },
) {
  const [definition] = await db
    .insert(workflowDefinitions)
    .values({ companyId: input.companyId, name: `Contract wf ${randomUUID()}`, stepsJson: input.steps })
    .returning();
  const [run] = await db
    .insert(workflowRuns)
    .values({
      companyId: input.companyId,
      workflowId: definition.id,
      missionId: input.missionId ?? null,
      status: "running",
      triggeredBy: "contract-seed",
      startedAt: new Date(Date.now() - 90 * MIN),
      ...input.run,
    })
    .returning();
  const steps = [];
  for (const s of input.stepRows ?? []) {
    const [step] = await db
      .insert(workflowStepRuns)
      .values({ workflowRunId: run.id, status: "pending", metadata: {}, ...s })
      .returning();
    steps.push(step);
  }
  return { definition, run, steps };
}

export async function seedPendingHumanCard(
  db: Db,
  input: { companyId: string; missionId: string; requestKey?: string; title?: string },
) {
  const requestKey = input.requestKey ?? `mission-owner-human-input:contract:${input.missionId}:${randomUUID()}`;
  const [card] = await db
    .insert(operatorDecisions)
    .values({
      companyId: input.companyId,
      requestKey,
      requestHash: `hash-${requestKey}`,
      status: "pending",
      priority: "high",
      interactionType: "single_select",
      title: input.title ?? "사람 결정 필요",
      sourceType: "mission_owner_human_input",
      sourceId: `card-${requestKey}`,
      sourceContext: {
        missionId: input.missionId,
        workflowId: null,
        workflowRunId: null,
        artifactRefs: [],
      },
      definition: {
        options: [{ id: "approve", label: "승인", description: null, facts: [], evidenceRefs: [] }],
        actions: [{
          id: "submit",
          label: "제출",
          outcome: "submit",
          tone: "primary",
          requiresSelection: true,
        }],
        selection: { min: 1, max: 1 },
        comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
        approvedScope: [],
        forbiddenScope: [],
      },
    })
    .returning();
  return card;
}
