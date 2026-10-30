// ui/src/lib/human-operator-surface-malformed.test.ts
//
// [목적] selectHumanOperatorSurface 의 malformed 게이트 회귀 방어(배열 enum 우회).
//   String(value.outcome)/String(value.identity) 강제 변환은 ["submit"]/["exact"] 배열을
//   통과시켜 표시 상태를 실행 권한처럼 보이게 할 수 있었다. typeof string 가드 후에도
//   배열은 반드시 malformed 로 분류되고, 표시(visibility)·unknown 스코프 처리는 유지되며,
//   어떤 경우에도 실행 권한(카드 바인딩)을 부여하지 않음을 검증한다.
// [외부 연결] 대상: ./human-operator-surface.ts (표시 전용 셀렉터 — 실행 권한 없음).
// [수정시 주의] 여기는 malformed 초점 파일이다. 정상 바인딩·카드 충돌 등 넓은 계약은
//   human-operator-surface.test.ts (444줄) 가 소유한다; 여기에 중복 확장하지 않는다.
import { describe, expect, it } from "vitest";
import type { HumanOperatorRequestStateV1 } from "@paperclipai/shared/types/human-operator-request-state";
import type { MissionHumanOperatorRequest, MissionListItem, MissionStatus } from "../api/missions";
import type { OperatorDecisionView } from "@paperclipai/shared/types/operator-decision";
import { selectHumanOperatorSurface } from "./human-operator-surface";

const companyId = "company-1";
const missionId = "mission-1";
const timestamp = "2026-07-29T10:00:00.000Z";
const EVENT_ONE = "00000000-0000-4000-8000-000000000001";
const DECISION_ONE = "00000000-0000-4000-8000-000000000011";
const OWNER_ISSUE = "00000000-0000-4000-8000-000000000021";
const SOURCE_ISSUE = "00000000-0000-4000-8000-000000000022";
const MOI2_REQUEST_UUID = "00000000-0000-4000-8000-000000000031";

function exactRequestState(): HumanOperatorRequestStateV1 {
  return {
    schemaVersion: 1, identity: "exact", reasonCode: null,
    decisionEventId: EVENT_ONE, ownerActionIssueId: OWNER_ISSUE, sourceIssueId: SOURCE_ISSUE,
    decision: {
      id: DECISION_ONE, requestKey: `moi2:${MOI2_REQUEST_UUID}`, sourceId: EVENT_ONE,
      status: "pending", result: null, resolvedAt: null, cancelledAt: null, continuationMode: "none",
    },
    continuation: null, attention: false,
  };
}

function makeMission(): MissionListItem {
  const now = new Date(timestamp);
  return { id: missionId, companyId, ownerAgentId: "owner-1", title: missionId, description: null,
    status: "active" as MissionStatus, goalId: null, startedAt: null, completedAt: null, createdAt: now, updatedAt: now };
}

function makeRequest(overrides: {
  ownerCompanyId?: string;
  requestState?: HumanOperatorRequestStateV1;
} = {}): MissionHumanOperatorRequest {
  const id = "request-1";
  return {
    id, companyId: overrides.ownerCompanyId ?? companyId, missionId, missionTitle: "Mission",
    missionStatus: "active", issueId: OWNER_ISSUE, title: id, summary: "Operator request", timestamp,
    event: {
      id: `diagnostic-${id}`, companyId: overrides.ownerCompanyId ?? companyId,
      scope: { missionId, issueId: OWNER_ISSUE },
      sourceRef: { type: "activity_log", id, table: "activity_log" }, eventType: "owner_diagnosis",
      title: "Human/operator input requested", summary: "Choose a direction", timestamp,
    },
    ...(overrides.requestState ? { requestState: overrides.requestState } : {}),
  };
}

function makeCard(): OperatorDecisionView {
  return {
    id: DECISION_ONE, companyId, schemaVersion: 1, requestKey: `moi2:${MOI2_REQUEST_UUID}`, status: "pending",
    priority: "critical", interactionType: "single_select", title: DECISION_ONE, description: "Choose",
    sourceType: "mission_owner_human_input", sourceId: EVENT_ONE,
    sourceContext: {
      missionId, workflowId: null, workflowRunId: "run-1", artifactRefs: [],
      targetSnapshot: { issueId: OWNER_ISSUE, workflowRunId: "run-1" },
    },
    definition: {
      options: [], actions: [], selection: null,
      comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
      approvedScope: [], forbiddenScope: [],
    },
    result: null, issueId: OWNER_ISSUE, issueIdentifier: null, issueTitle: null, missionTitle: null,
    continuationMode: "none", requestedBy: null, resolvedByUserId: null, resolvedAt: null, cancelledAt: null,
    createdAt: timestamp, updatedAt: timestamp, continuation: null,
  };
}

function select(requests: readonly MissionHumanOperatorRequest[], cards: readonly OperatorDecisionView[] = []) {
  return selectHumanOperatorSurface({ companyId, missions: [makeMission()], requests, pendingDecisions: cards });
}

describe("selectHumanOperatorSurface malformed enum guards", () => {
  it("classifies an array decision outcome as malformed, keeps the request visible, and never binds a card", () => {
    const poisoned = exactRequestState();
    poisoned.decision!.status = "resolved";
    poisoned.decision!.result = { actionId: "act-1", outcome: "submit", selectedOptionIds: [], comment: null };
    // String(["submit"]) === "submit" 우회: 배열 outcome 은 문자열 가드에서 거부되어야 한다.
    (poisoned.decision!.result as unknown as Record<string, unknown>).outcome = ["submit"];
    const surface = select([makeRequest({ requestState: poisoned })], [makeCard()]);
    const item = surface.active.requests[0];
    // 표시는 유지되되 상태 해석은 malformed — 실행 권한(카드 바인딩)은 없다.
    expect(item?.requestStateProblem).toBe("malformed");
    expect(item?.requestState).toBeNull();
    expect(item?.card).toBeNull();
    expect(surface.displayedCount).toBe(2);
    // 카드 자체는 미바인딩 상태로 여전히 표시된다(visibility 보존).
    expect(surface.active.cards.map(({ decision }) => decision.id)).toEqual([DECISION_ONE]);
  });

  it("classifies an array identity with null decision as malformed instead of the legacy bypass", () => {
    const poisoned = exactRequestState();
    poisoned.decision = null;
    poisoned.continuation = null;
    poisoned.attention = null;
    // String(["exact"]) === "exact" 우회: 배열 identity 는 non-exact 분기로 넘어갈 수 없다.
    (poisoned as unknown as Record<string, unknown>).identity = ["exact"];
    const surface = select([makeRequest({ requestState: poisoned })]);
    const item = surface.active.requests[0];
    expect(item?.requestStateProblem).toBe("malformed");
    expect(item?.requestState).toBeNull();
    expect(item?.card).toBeNull();
    // 회사/미션 불일치 요청의 unknown 스코프 처리는 malformed 가드와 무관하게 유지된다.
    const offScope = select([makeRequest({ ownerCompanyId: "other-co", requestState: poisoned })]);
    expect(offScope.unknown.requests[0]?.requestStateProblem).toBe("scope-conflict");
    expect(offScope.unknown.requests[0]?.requestState).toBeNull();
  });

  it("keeps accepting valid string controls after the guards", () => {
    const pending = select([makeRequest({ requestState: exactRequestState() })], [makeCard()]);
    const bound = pending.active.requests[0];
    expect(bound?.requestStateProblem).toBeNull();
    expect(bound?.requestState?.identity).toBe("exact");
    expect(bound?.card?.id).toBe(DECISION_ONE);

    const resolved = exactRequestState();
    resolved.decision!.status = "resolved";
    resolved.decision!.resolvedAt = timestamp;
    resolved.decision!.result = { actionId: "act-1", outcome: "submit", selectedOptionIds: ["opt-1"], comment: null };
    // resolved 정상 컨트롤에는 카드를 넣지 않는다(대기 카드 동반 시 card-conflict 는 별도 계약).
    const resolvedSurface = select([makeRequest({ requestState: resolved })]);
    const resolvedItem = resolvedSurface.active.requests[0];
    expect(resolvedItem?.requestStateProblem).toBeNull();
    expect(resolvedItem?.requestState?.decision?.result?.outcome).toBe("submit");
    expect(resolvedItem?.card).toBeNull();
    expect(resolvedSurface.displayedCount).toBe(1);
  });
});
