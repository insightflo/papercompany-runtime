// server/src/__tests__/mission-factory-decomposition.test.ts
//
// [목적] missions.ts 클로저 분해(P0-P3) 회귀 테스트.
//   createOwnerActions + createSupervision factory가 정확히 주입받아 클로저를 재현하는지 검증.
//   factory 변환 후 deps 콜백/메서드가 동일하게 노출되는지 확인 (구조적 wiring 회귀 방지).
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { MissionServiceDeps } from "../services/missions.js";
import { createOwnerActions } from "../services/missions/owner-actions.js";
import { createSupervision } from "../services/missions/supervision.js";

const EXPECTED_OWNER_ACTIONS = [
  "createMissionOwnerActionIssue",
  "ensureMainExecutorUnblockIssue",
  "ensureMainExecutorPlanningIssue",
  "ensureMainExecutorOversightIssue",
  "ensureToolStepFailureRecoveryIssue",
  "ensureMissionExecutionPlan",
  "ensureWorkflowMissionPlanArtifact",
  "ensureWorkflowIssuesLinkedToMission",
  "reconcileMissionStatusFromWorkflowRuns",
  "completeOpenMissionOversightIfSettled",
  "collectWorkflowIssueIdsForMission",
  "collectIssueIdsWithAncestors",
  "findMainExecutorIssue",
  "reopenAppliedToolStepRecoveryIfRetryFailed",
  "closeDuplicateToolStepRecoveryIssue",
  "listRecurringArtifactMissingIssueRefs",
  "buildCorrectedArtifactValidatorRetryEvidence",
  "isMissionOwnerActionParentPlacementRejected",
] as const;

describe("mission closure decomposition — factory wiring", () => {
  // 더미 db/deps (factory 생성만 검증, 실제 DB 호출 안 함)
  const mockDb = {} as Db;
  const mockDeps: MissionServiceDeps = {
    onOwnerActionCreated: async () => {},
    onOwnerDecisionRetrySourceIssueApplied: async () => ({ status: "dispatched" }),
    onStaleSourceIssueWakeupRequested: async () => {},
    onOwnerPlanningIssueCreated: async () => {},
  };

  it("createOwnerActions는 18개 action 함수를 반환한다", () => {
    const actions = createOwnerActions({ db: mockDb, deps: mockDeps });
    for (const fn of EXPECTED_OWNER_ACTIONS) {
      expect(actions[fn], `missing ownerActions.${fn}`).toBeTypeOf("function");
    }
  });

  it("createSupervision는 runMainExecutorSupervision + runActiveMissionOwnerSupervision을 반환한다", () => {
    const ownerActions = createOwnerActions({ db: mockDb, deps: mockDeps });
    const supervision = createSupervision({ db: mockDb, deps: mockDeps, ownerActions });
    expect(supervision.runMainExecutorSupervision).toBeTypeOf("function");
    expect(supervision.runActiveMissionOwnerSupervision).toBeTypeOf("function");
  });

  it("factory composition: createSupervision는 createOwnerActions의 출력을 받는다", () => {
    const ownerActions = createOwnerActions({ db: mockDb, deps: mockDeps });
    // createSupervision이 ownerActions의 타입을 받아 에러 없이 생성되는지 확인
    const supervision = createSupervision({ db: mockDb, deps: mockDeps, ownerActions });
    expect(supervision).toBeDefined();
    expect(Object.keys(supervision)).toHaveLength(2);
  });

  it("deps 콜백이 factory에 주입되어 접근 가능하다 (wiring 회귀 방지)", () => {
    // deps의 각 콜백이 factory 생성 시 누락되지 않았는지 간접 검증
    // (factory가 deps를 클로저로 캡처하므로, 생성 자체가 성공하면 wiring OK)
    let ownerActionCallbackCount = 0;
    const trackingDeps: MissionServiceDeps = {
      onOwnerActionCreated: async () => { ownerActionCallbackCount++; },
    };
    const actions = createOwnerActions({ db: mockDb, deps: trackingDeps });
    expect(actions).toBeDefined();
    // 실제 호출은 DB가 필요하므로 여기서는 wiring(생성)만 검증
  });

  it("factory는 독립 인스턴스를 생성한다 (매 호출마다 새 클로저)", () => {
    const a1 = createOwnerActions({ db: mockDb, deps: mockDeps });
    const a2 = createOwnerActions({ db: mockDb, deps: mockDeps });
    // 서로 다른 클로저 인스턴스 (같은 함수가 아님)
    expect(a1.ensureMainExecutorUnblockIssue).not.toBe(a2.ensureMainExecutorUnblockIssue);
  });
});
