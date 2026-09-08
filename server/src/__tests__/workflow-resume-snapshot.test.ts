import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashSnapshotState, signSnapshot, verifySnapshot } from "../services/workflow/resume/snapshot.js";
import type { SnapshotState } from "../services/workflow/resume/snapshot-state.js";
import {
  HASH_B,
  KEY_A,
  KEY_B,
  NOW,
  OTHER_DATE,
  reverseKeyOrder,
  snapshotState,
  stateWith,
} from "./helpers/workflow-resume-snapshot-fixture.js";

/**
 * [purpose] Task5c1 signed snapshot positive contract — roundtrip, determinism under
 *   reordered object keys, frozen-input immutability, array-order significance, exact
 *   5-minute expiry window, and stateHash/token sensitivity for every declared state group.
 */

const STALE = "stale_snapshot";

/** 런타임 한정 deep-freeze — unsafe cast 없이 SnapshotState 타입을 유지한다. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, object>)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

describe("signSnapshot / verifySnapshot — roundtrip and determinism", () => {
  it("roundtrips a valid snapshot state through sign and verify", () => {
    const state = snapshotState();
    const token = signSnapshot(state, KEY_A, NOW);
    expect(verifySnapshot(token, KEY_A, NOW)).toEqual(state);
  });

  it("is deterministic and independent of object key insertion order", () => {
    const state = snapshotState();
    const tokenA = signSnapshot(state, KEY_A, NOW);
    expect(signSnapshot(state, KEY_A, NOW)).toBe(tokenA);
    expect(signSnapshot(reverseKeyOrder(state), KEY_A, NOW)).toBe(tokenA);
  });

  it("does not mutate frozen input", () => {
    const state = deepFreeze(snapshotState());
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.steps[0])).toBe(true);
    expect(Object.isFrozen(state.scope)).toBe(true);
    const token = signSnapshot(state, KEY_A, NOW);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.steps[0])).toBe(true);
    expect(verifySnapshot(token, KEY_A, NOW)).toEqual(state);
  });

  // [의도] 재배열이 실질이 되려면 각 배열이 >=2 항목이어야 한다 — 이 테스트 안에서만
  // 두 번째 valid evidence/approval 을 base 에 추가한다 (전역 fixture 확장 금지:
  // step-2 approval 이 상주하면 MUTATIONS 의 steps[1].stepId 변이가 무효화됨).
  it.each([
    ["steps", (s: SnapshotState) => { s.steps = [...s.steps].reverse(); }],
    ["evidence", (s: SnapshotState) => { s.evidence = [...s.evidence].reverse(); }],
    ["approvals", (s: SnapshotState) => { s.approvals = [...s.approvals].reverse(); }],
  ])("treats %s array order as significant for hash and token", (_group, reverse) => {
    const base = snapshotState();
    base.evidence.push({ id: randomUUID(), sha256: HASH_B });
    base.approvals.push({ stepId: "step-2", executionGeneration: 1, bindingHash: null });
    const reordered = structuredClone(base);
    reverse(reordered);
    const tokenBase = signSnapshot(base, KEY_A, NOW);
    const tokenReordered = signSnapshot(reordered, KEY_A, NOW);
    expect(tokenBase).not.toBe(tokenReordered);
    expect(hashSnapshotState(base)).not.toBe(hashSnapshotState(reordered));
    expect(verifySnapshot(tokenReordered, KEY_A, NOW)).toEqual(reordered);
  });
});

describe("expiry window (issuedAt <= now < expiresAt, TTL exactly 300000ms)", () => {
  it("accepts issuance instant and 1ms before expiry, rejects exact expiry and earlier", () => {
    const token = signSnapshot(snapshotState(), KEY_A, NOW);
    expect(verifySnapshot(token, KEY_A, NOW)).toBeDefined();
    expect(verifySnapshot(token, KEY_A, new Date(NOW.getTime() + 299_999))).toBeDefined();
    expect(() => verifySnapshot(token, KEY_A, new Date(NOW.getTime() + 300_000))).toThrowError(STALE);
    expect(() => verifySnapshot(token, KEY_A, new Date(NOW.getTime() - 1))).toThrowError(STALE);
  });

  it("rejects tokens issued in the future", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    const futureToken = signSnapshot(snapshotState(), KEY_A, later);
    expect(verifySnapshot(futureToken, KEY_A, later)).toBeDefined();
    expect(() => verifySnapshot(futureToken, KEY_A, NOW)).toThrowError(STALE);
  });

  it("rejects verification with the wrong key", () => {
    const token = signSnapshot(snapshotState(), KEY_A, NOW);
    expect(() => verifySnapshot(token, KEY_B, NOW)).toThrowError(STALE);
  });
});

describe("hashSnapshotState", () => {
  it("returns a stable 64-hex digest sensitive to state content", () => {
    const base = snapshotState();
    const digest = hashSnapshotState(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSnapshotState(structuredClone(base))).toBe(digest);
    const mutated = structuredClone(base);
    mutated.factsHash = HASH_B; // 동일 fixture 복제본에서 factsHash 만 변경
    expect(hashSnapshotState(mutated)).not.toBe(digest);
  });
});

describe("stateHash/token sensitivity — every declared SnapshotState group", () => {
  // [의미] 각 진행은 서로 다른 선언 그룹(field)을 건드린다. schemaVersion literal 은 변이 불가.
  const MUTATIONS: [string, (state: SnapshotState) => void][] = [
    ["scope.companyId", (s) => { s.scope.companyId = randomUUID(); }],
    ["scope.missionId", (s) => { s.scope.missionId = randomUUID(); }],
    ["scope.workflowRunId", (s) => { s.scope.workflowRunId = randomUUID(); }],
    ["scope.startStepId", (s) => { s.scope.startStepId = "step-2"; }],
    ["definitionHash", (s) => { s.definitionHash = HASH_B; }],
    ["mission.status", (s) => { s.mission.status = "paused"; }],
    ["mission.updatedAt", (s) => { s.mission.updatedAt = OTHER_DATE; }],
    ["run.status", (s) => { s.run.status = "paused"; }],
    ["run.dispatchAuthorityVersion", (s) => { s.run.dispatchAuthorityVersion = 2; }],
    ["run.startedAt", (s) => { s.run.startedAt = OTHER_DATE; }],
    ["run.completedAt", (s) => { s.run.completedAt = OTHER_DATE; }],
    ["steps[].id", (s) => { s.steps[0].id = randomUUID(); }],
    ["steps[].stepId", (s) => { s.steps[1].stepId = "step-3"; }],
    ["steps[].status", (s) => { s.steps[0].status = "failed"; }],
    ["steps[].executionGeneration", (s) => { s.steps[0].executionGeneration = 5; }],
    ["steps[].statusTransitionVersion", (s) => { s.steps[0].statusTransitionVersion = 3; }],
    ["steps[].dispatchOwnerWakeupRequestId", (s) => { s.steps[0].dispatchOwnerWakeupRequestId = randomUUID(); }],
    ["steps[].dispatchOwnerHeartbeatRunId", (s) => { s.steps[0].dispatchOwnerHeartbeatRunId = randomUUID(); }],
    ["steps[].lastDispatchRequestId", (s) => { s.steps[0].lastDispatchRequestId = "req-2"; }],
    ["evidence[].id", (s) => { s.evidence[0].id = randomUUID(); }],
    ["evidence[].sha256", (s) => { s.evidence[0].sha256 = HASH_B; }],
    ["evidence append", (s) => { s.evidence.push({ id: randomUUID(), sha256: HASH_B }); }],
    ["approvals[].executionGeneration", (s) => { s.approvals[0].executionGeneration = 1; }],
    ["approvals[].bindingHash", (s) => { s.approvals[0].bindingHash = HASH_B; }],
    ["approvals append", (s) => { s.approvals.push({ stepId: "step-2", executionGeneration: 1, bindingHash: null }); }],
    ["resumeEpoch", (s) => { s.resumeEpoch = 1; }],
    ["factsHash", (s) => { s.factsHash = HASH_B; }],
  ];

  it.each(MUTATIONS)("%s changes stateHash and token", (_name, mutate) => {
    const base = snapshotState();
    // [의도] 독립 fixture 대신 동일 base 복제본을 변이한다 — 랜덤 UUID 차이가 아닌
    // 해당 그룹 변경만이 hash/token 차이의 유일한 원인임을 증명한다.
    const mutated = structuredClone(base);
    mutate(mutated);
    expect(hashSnapshotState(base)).not.toBe(hashSnapshotState(mutated));
    expect(signSnapshot(base, KEY_A, NOW)).not.toBe(signSnapshot(mutated, KEY_A, NOW));
    expect(verifySnapshot(signSnapshot(mutated, KEY_A, NOW), KEY_A, NOW)).toEqual(mutated);
  });

  it("explicitly permits null approval bindingHash — signer is not an eligibility evaluator", () => {
    const state = stateWith((s) => {
      s.approvals[0].bindingHash = null;
      s.approvals.push({ stepId: "step-2", executionGeneration: 1, bindingHash: null });
    });
    expect(state.approvals.every((a) => a.bindingHash === null)).toBe(true);
    const token = signSnapshot(state, KEY_A, NOW);
    expect(verifySnapshot(token, KEY_A, NOW).approvals).toEqual(state.approvals);
  });
});
