// engine-contract S20 — C5 claim 차단 범위가 실행 단위로 축소된 계약 (#684 회귀).
// claim 대기 판정은 '실행 단위(workflowStepRunId + issueId)'를 공유하는 pending preparation 만
// 차단하고, 다른 step/issue 의 pending 은 실행을 진행시킨다. 순수 계약 — DB 불필요.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  claimExecutingUnit,
  pendingInvolvesExecutingUnit,
  type QaCorrectionExecutionIdentity,
} from "../../services/workflow/control-flow/qa-remediation-admission-root.js";

function identity(over: Partial<QaCorrectionExecutionIdentity> = {}): QaCorrectionExecutionIdentity {
  return {
    heartbeatRunId: randomUUID(),
    companyId: randomUUID(),
    agentId: randomUUID(),
    issueId: null,
    wakeupRequestId: null,
    workflowStepRunId: null,
    workflowExecutionGeneration: null,
    retryOfRunId: null,
    executionScopeKind: null,
    executionEpoch: null,
    executionToken: null,
    executorOwnerId: null,
    executorOwnerLeaseEpoch: null,
    executorOwnerLeaseToken: null,
    executorOwnerLeaseExpiresAt: null,
    executorOwnerAcknowledgedAt: null,
    executorOwnerReleasedAt: null,
    processLossRetryCount: null,
    ...over,
  };
}

function pendingItem(opts: { producerStep?: string | null; producerIssue?: string | null; qaStep?: string | null; qaIssue?: string | null }) {
  return {
    eventId: randomUUID(),
    preparation: {
      producer: { stepRunId: opts.producerStep ?? null, issueId: opts.producerIssue ?? null },
      verdicts: [{ qa: { stepRunId: opts.qaStep ?? null, issueId: opts.qaIssue ?? null } }],
      files: [],
    },
  } as never;
}

describe("engine-contract S20 — C5 claim executing unit (#684)", () => {
  it("S20: 실행 단위를 공유하는 pending 만 차단하고 무관한 pending 은 통과 — 단위가 없으면 fail-closed", () => {
    const stepA = randomUUID();
    const issueA = randomUUID();
    const unit = claimExecutingUnit(identity({ workflowStepRunId: stepA, issueId: issueA }));
    expect(unit).not.toBeNull();
    expect(unit!.workflowStepRunId).toBe(stepA);
    expect(unit!.issueId).toBe(issueA);

    // 같은 step 을 생산한 pending — 차단(claim 대기).
    expect(pendingInvolvesExecutingUnit(
      pendingItem({ producerStep: stepA }), unit!,
    )).toBe(true);
    // 같은 issue 를 다룬 QA verdict 축이 있는 pending — 차단.
    expect(pendingInvolvesExecutingUnit(
      pendingItem({ qaIssue: issueA }), unit!,
    )).toBe(true);
    // 실행 단위와 무관한 다른 step/issue 의 pending — 통과(차단 범위 축소 계약).
    expect(pendingInvolvesExecutingUnit(
      pendingItem({ producerStep: randomUUID(), producerIssue: randomUUID() }), unit!,
    )).toBe(false);

    // fail-closed: 실행 단위를 식별할 수 없는 identity 는 claim 단위가 없다(전부 차단으로 수렴).
    expect(claimExecutingUnit(identity())).toBeNull();
    expect(claimExecutingUnit(identity({ workflowStepRunId: stepA }))).not.toBeNull();
    expect(claimExecutingUnit(identity({ issueId: issueA }))).not.toBeNull();

    // 필터 의미론: 혼합 pending 목록에서 실행 단위 관련만 골라낸다.
    const mixed = [
      pendingItem({ producerStep: stepA }),
      pendingItem({ producerStep: randomUUID() }),
      pendingItem({ qaIssue: issueA }),
    ];
    expect(mixed.filter((p) => pendingInvolvesExecutingUnit(p, unit!)).length).toBe(2);
  });
});
