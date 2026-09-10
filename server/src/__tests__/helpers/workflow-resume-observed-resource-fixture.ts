import { randomUUID } from "node:crypto";
import type { ResumeExecutionHistory } from "../../services/workflow/resume/read-model.js";
import { settlementHeartbeatRow, type SettlementHeartbeatRow } from "./workflow-resume-settlement-fixture.js";

/**
 * [목적] Task5c3b observed-resource 순수 테스트 픽스처. 승인된 기존 fixture(settlement →
 *   resource → read-model → frozen/5a1)를 import 로만 재사용(수정 금지)하고, 세 resource
 *   테이블(workspace_operations / workspace_runtime_services / mission_agent_runtimes)과
 *   issues 의 전체 열($inferSelect) 타입 팩토리만 추가한다. `as any`/부분 행 캐스트 없이
 *   전체 열을 명시한다. 순수 테스트 전용 — 실제 DB 시딩은 기존 resource fixture 의 seed* 를
 *   그대로 사용한다(이 파일은 insert 를 하지 않는다).
 * [순수 테스트 계약] 팩토리는 호출마다 새 객체+새 uuid 를 만들어 caller 의 변이가 다음 호출에
 *   영향이 없게 한다(승인된 settlement fixture 와 동일 규약). 기본값은 각 범주의 "정상 producer
 *   기록"이며, 상태/링크/소유 위반 테스트는 overrides 로만 비틀어 쓴다.
 */

export { settlementHeartbeatRow };
export type { SettlementHeartbeatRow };

type IssueRow = ResumeExecutionHistory["issues"][number];
type OperationRow = ResumeExecutionHistory["workspaceOperations"][number];
type ServiceRow = ResumeExecutionHistory["workspaceRuntimeServices"][number];
type RuntimeRow = ResumeExecutionHistory["missionAgentRuntimes"][number];

export type ObservedIssueRow = IssueRow;
export type ObservedOperationRow = OperationRow;
export type ObservedServiceRow = ServiceRow;
export type ObservedRuntimeRow = RuntimeRow;

const T0 = new Date("2024-06-01T00:00:00.000Z");

/** 전체 열 issue 행 — 기본은 scope-linked(null missionId 도 허용되므로 caller 가 지정). */
export function observedIssueRow(overrides: Partial<IssueRow> = {}): IssueRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    missionId: null,
    parentId: null,
    title: "observed-resource-issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    originKind: "workflow_execution",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** 전체 열 workspace operation 행 — 기본은 정상 단말(succeeded, 동일 시각 기록). */
export function observedOperationRow(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    executionWorkspaceId: null,
    heartbeatRunId: null,
    phase: "test-phase",
    command: null,
    cwd: null,
    status: "succeeded",
    exitCode: 0,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    metadata: null,
    startedAt: T0,
    finishedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** 전체 열 workspace runtime service 행 — 기본은 기록된 단말(stopped + stoppedAt). */
export function observedServiceRow(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    scopeType: "run",
    scopeId: null,
    serviceName: "observed-resource-test",
    status: "stopped",
    lifecycle: "ephemeral",
    reuseKey: null,
    command: null,
    cwd: null,
    port: null,
    url: null,
    provider: "docker",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: T0,
    startedAt: T0,
    stoppedAt: T0,
    stopPolicy: null,
    healthStatus: "unknown",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** 전체 열 mission agent runtime 행 — 기본은 무소유 비활성(idle, queue 0, PID null). */
export function observedRuntimeRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    missionId: randomUUID(),
    agentId: randomUUID(),
    adapterType: "test-adapter",
    runtimeKey: randomUUID(),
    status: "idle",
    processPid: null,
    sessionId: null,
    sessionParamsJson: null,
    workspaceId: null,
    workspaceKey: "default",
    currentIssueId: null,
    lastRunId: null,
    lastRunStatus: null,
    queueDepth: 0,
    runCount: 0,
    contextBootstrapVersion: 1,
    contextInjectedAt: null,
    lastIssueEnvelopeAt: null,
    stateJson: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostCents: 0,
    lastError: null,
    stopReason: null,
    startedAt: T0,
    stoppedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}
