// helpers/run-terminal-boundary-integration-fixtures.ts
//
// [목적] run-terminal-boundary v1 호출부 연결(dag-engine/reconciler/deadlock-reconciler) 통합
//   테스트 픽스처. 기존 dag-engine·frozen-reconciler 테스트의 인라인 시딩 패턴을 함수화한다.
//   스텝은 전부 agent 형이며 재시도 정책(onFailure:"retry")을 심지 않는다 — 채널 b(재시도 예약)는
//   metadata 로 명시적으로만 연다.
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  instanceSettings,
  issues,
  missionAgentRuntimes,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";

export interface BoundaryStepSeed {
  stepId: string;
  dependencies?: string[];
  status: string;
  /** 지정 시 이 스텝 전용 실행 이슈를 만든다. */
  issueStatus?: string;
  /** 실행 이슈가 있을 때 그 이슈를 source 로 하는 열린 unblock 채널을 붙인다. */
  unblock?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BoundaryRunSeed {
  runStatus?: string;
  startedAt?: Date;
  steps: BoundaryStepSeed[];
  /** 이 스텝의 실행 이슈에 물린 활성 미션 런타임을 만든다(스코프 kill 효과 검증용). */
  runtimeOnStepIssue?: string;
}

export interface BoundaryRunWorld {
  companyId: string;
  agentId: string;
  missionId: string;
  workflowId: string;
  runId: string;
  issueIdsByStep: Record<string, string>;
  unblockIdsByStep: Record<string, string>;
  stepRunIdsByStep: Record<string, string>;
  runtimeId: string | null;
}

export async function setRunTerminalBoundaryFlag(db: Db, enabled: boolean): Promise<void> {
  await db.delete(instanceSettings);
  await db.insert(instanceSettings).values({
    singletonKey: "default",
    general: {},
    experimental: { enableRunTerminalBoundaryV1: enabled },
  } as never);
}

/** company/mission/run/stepRun(+실행 이슈·unblock 채널·런타임)을 한 번에 시딩한다. */
export async function seedBoundaryIntegrationRun(db: Db, seed: BoundaryRunSeed): Promise<BoundaryRunWorld> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const missionId = randomUUID();
  const workflowId = randomUUID();
  const runId = randomUUID();
  const startedAt = seed.startedAt ?? new Date();
  await db.insert(companies).values({
    id: companyId,
    name: "Boundary Integration Co",
    issuePrefix: `BI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId, companyId, name: "Boundary Integration Agent", role: "engineer",
    status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(missions).values({
    id: missionId, companyId, ownerAgentId: agentId, title: "Boundary integration mission",
    status: "active", startedAt,
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "boundary-integration-wf",
    stepsJson: seed.steps.map((step) => ({
      id: step.stepId,
      name: step.stepId,
      type: "agent",
      agentId,
      dependencies: step.dependencies ?? [],
    })),
  });
  await db.insert(workflowRuns).values({
    id: runId, workflowId, companyId, missionId,
    status: seed.runStatus ?? "running", triggeredBy: "test", startedAt,
  });

  const issueIdsByStep: Record<string, string> = {};
  const unblockIdsByStep: Record<string, string> = {};
  const stepRunIdsByStep: Record<string, string> = {};
  for (const step of seed.steps) {
    let issueId: string | null = null;
    if (step.issueStatus) {
      issueId = randomUUID();
      issueIdsByStep[step.stepId] = issueId;
      await db.insert(issues).values({
        id: issueId, companyId, missionId,
        identifier: `BI-${randomUUID().slice(0, 6)}`,
        title: `${step.stepId} issue`,
        status: step.issueStatus,
        originKind: "workflow_execution",
        originRunId: runId,
      });
      if (step.unblock) {
        const unblockId = randomUUID();
        unblockIdsByStep[step.stepId] = unblockId;
        await db.insert(issues).values({
          id: unblockId, companyId, missionId,
          identifier: `BI-${randomUUID().slice(0, 6)}`,
          title: `${step.stepId} unblock`,
          status: "todo",
          originKind: "mission_main_executor_unblock",
          originId: issueId,
        });
      }
    }
    const isPending = step.status === "pending";
    const [stepRun] = await db.insert(workflowStepRuns).values({
      workflowRunId: runId,
      stepId: step.stepId,
      status: step.status,
      ...(issueId ? { issueId } : {}),
      startedAt: isPending ? null : startedAt,
      completedAt: isPending ? null : startedAt,
      ...(step.metadata ? { metadata: step.metadata } : {}),
    }).returning({ id: workflowStepRuns.id });
    stepRunIdsByStep[step.stepId] = stepRun!.id;
  }

  let runtimeId: string | null = null;
  if (seed.runtimeOnStepIssue) {
    const runtimeIssueId = issueIdsByStep[seed.runtimeOnStepIssue];
    if (!runtimeIssueId) throw new Error(`runtimeOnStepIssue: no issue for step ${seed.runtimeOnStepIssue}`);
    runtimeId = randomUUID();
    await db.insert(missionAgentRuntimes).values({
      id: runtimeId, companyId, missionId, agentId,
      adapterType: "codex_local", runtimeKey: `rt-${randomUUID().slice(0, 8)}`,
      status: "busy", queueDepth: 1, currentIssueId: runtimeIssueId,
    });
  }

  return { companyId, agentId, missionId, workflowId, runId, issueIdsByStep, unblockIdsByStep, stepRunIdsByStep, runtimeId };
}
