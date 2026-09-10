import { describe, expect, it } from "vitest";
import {
  observedIssueRow,
  observedOperationRow,
  observedRuntimeRow,
  observedServiceRow,
  settlementHeartbeatRow,
  type ObservedOperationRow,
  type ObservedRuntimeRow,
  type ObservedServiceRow,
} from "./helpers/workflow-resume-observed-resource-fixture.js";
import {
  checkObservedResourceConflicts,
  type ObservedResourceBlocker,
  type ObservedResourceConflictsInput,
} from "../services/workflow/resume/observed-resource-conflicts.js";

/**
 * [purpose] Task5c3b observed resource conflict filter — pure contract tests. NEGATIVE filter over
 *   supplied records only: empty blockers prove ONLY that no conflict was found in the supplied
 *   rows — never total quiescence, never historical absence, never resume eligibility, and a
 *   stopped process is never certified. Full DB-row typed factories only (no `as any`);
 *   duplicate-aware identity rules live in the links test file; real embedded-PG reader
 *   integration lives in workflow-resume-observed-resource-db.test.ts.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "33333333-3333-4333-8333-333333333333";
const HB = "44444444-4444-4444-8444-444444444444";
const HB2 = "55555555-5555-5555-8555-555555555555";
const ISSUE = "66666666-6666-4666-8666-666666666666";
const T0 = new Date("2024-06-01T00:00:00.000Z");
const T1 = new Date("2024-06-01T01:00:00.000Z");
const SCOPE = { companyId: COMPANY, missionId: MISSION, workflowRunId: RUN, startStepId: "resume-step-a" };

function baseInput(): ObservedResourceConflictsInput {
  return {
    scope: SCOPE,
    issues: [observedIssueRow({ id: ISSUE, companyId: COMPANY, missionId: MISSION })],
    heartbeats: [settlementHeartbeatRow({ id: HB, companyId: COMPANY })],
    workspaceOperations: [],
    workspaceRuntimeServices: [],
    missionAgentRuntimes: [],
  };
}

/** valid rows: terminal state + typed in-scope lineage + recorded dates (rules 1-6 clean). */
const validOperation = (overrides?: Partial<ObservedOperationRow>): ObservedOperationRow =>
  observedOperationRow({ companyId: COMPANY, heartbeatRunId: HB, ...overrides });
const validService = (overrides?: Partial<ObservedServiceRow>): ObservedServiceRow =>
  observedServiceRow({ companyId: COMPANY, startedByRunId: HB, scopeId: HB, ...overrides });
const validRuntime = (overrides?: Partial<ObservedRuntimeRow>): ObservedRuntimeRow =>
  observedRuntimeRow({ companyId: COMPANY, missionId: MISSION, lastRunId: HB, ...overrides });

const check = (input: ObservedResourceConflictsInput): ObservedResourceBlocker[] =>
  checkObservedResourceConflicts(input);
const checkOperation = (row: ObservedOperationRow) => check({ ...baseInput(), workspaceOperations: [row] });
const checkService = (row: ObservedServiceRow) => check({ ...baseInput(), workspaceRuntimeServices: [row] });
const checkRuntime = (row: ObservedRuntimeRow) => check({ ...baseInput(), missionAgentRuntimes: [row] });

function expectSole(
  blockers: ObservedResourceBlocker[], code: ObservedResourceBlocker["code"],
  resourceKind: ObservedResourceBlocker["resourceKind"], resourceId: string,
  reason: ObservedResourceBlocker["reason"],
): void {
  expect(blockers).toEqual([{ code, resourceKind, resourceId, reason }]);
}

describe("checkObservedResourceConflicts — accepted records (rule 4 states, no eligible flag)", () => {
  it.each(["succeeded", "failed", "skipped"])("accepts terminal operation status %s", (status) => {
    expect(checkOperation(validOperation({ status }))).toEqual([]);
  });

  it.each(["stopped", "failed"])("accepts recorded-terminal service status %s", (status) => {
    expect(checkService(validService({ status }))).toEqual([]);
  });

  it.each(["idle", "stopped", "crashed"])("accepts inactive bookkeeping runtime status %s", (status) => {
    expect(checkRuntime(validRuntime({ status, ...(status === "stopped" ? { stoppedAt: T0 } : {}) }))).toEqual([]);
  });

  it("returns [] for zero resource arrays — explicitly NOT an eligible/quiescent flag", () => {
    // 빈 결과는 "공급된 행에서 충돌을 못 찾았다"일 뿐이다. unmapped/shared-workspace 행 부재를 완전성으로 쓰지 않는다.
    expect(check(baseInput())).toEqual([]);
  });

  it("allows the same ID reused across different resource kinds (per-category identity only)", () => {
    const sharedId = "77777777-7777-4777-8777-777777777777";
    expect(check({
      ...baseInput(),
      workspaceOperations: [validOperation({ id: sharedId })],
      workspaceRuntimeServices: [validService({ id: sharedId })],
      missionAgentRuntimes: [validRuntime({ id: sharedId })],
    })).toEqual([]);
  });
});

describe("checkObservedResourceConflicts — rule 4 nonterminal/unknown state blocks", () => {
  it.each(["running", "queued", "mystery_unknown_status"])("blocks operation status %s as not_terminal", (status) => {
    const operation = validOperation({ status });
    expectSole(checkOperation(operation), "active_work", "workspace_operation", operation.id, "resource_not_terminal");
  });

  it.each(["running", "starting"])("blocks service status %s even with populated stoppedAt", (status) => {
    const service = validService({ status, stoppedAt: T1 });
    expectSole(checkService(service), "active_work", "workspace_service", service.id, "resource_not_terminal");
  });

  it.each(["starting", "ready", "busy", "stopping"])("blocks runtime status %s even with stoppedAt", (status) => {
    const runtime = validRuntime({ status, stoppedAt: T1 });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_not_terminal");
  });
});

describe("checkObservedResourceConflicts — rule 3 typed lineage", () => {
  it("blocks operation with null or dangling heartbeatRunId as lineage_unproven", () => {
    for (const heartbeatRunId of [null, RUN]) {
      const operation = validOperation({ heartbeatRunId });
      expectSole(checkOperation(operation), "active_work", "workspace_operation", operation.id, "resource_lineage_unproven");
    }
  });

  it("blocks runtime with null/dangling lastRunId before state and ownership rules", () => {
    for (const lastRunId of [null, ISSUE]) {
      const runtime = validRuntime({ lastRunId, status: "busy", queueDepth: 4 });
      expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_lineage_unproven");
    }
  });

  it("blocks dangling currentIssueId as lineage_unproven — resolution precedes ownership rule", () => {
    const runtime = validRuntime({ currentIssueId: RUN });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_lineage_unproven");
  });

  it.each([
    ["run scope null scopeId", { startedByRunId: null, scopeId: null }],
    ["run scope empty scopeId", { startedByRunId: null, scopeId: "" }],
    ["no heartbeat refs and no issue", { scopeType: "agent", scopeId: null, startedByRunId: null }],
    ["dangling startedByRunId", { startedByRunId: ISSUE }],
    ["dangling issueId", { issueId: RUN }],
  ])("blocks service with %s as lineage_unproven", (_label, overrides) => {
    const service = validService(overrides);
    expectSole(checkService(service), "active_work", "workspace_service", service.id, "resource_lineage_unproven");
  });

  it("allows issue-only service association and multiple distinct known heartbeat refs", () => {
    const issueOnly = validService({
      scopeType: "agent", scopeId: "ws-not-a-heartbeat", startedByRunId: null, issueId: ISSUE,
    });
    expect(checkService(issueOnly)).toEqual([]);
    const twoRefs = validService({ startedByRunId: HB, scopeId: HB2 });
    const bothHeartbeats = [
      settlementHeartbeatRow({ id: HB, companyId: COMPANY }), settlementHeartbeatRow({ id: HB2, companyId: COMPANY }),
    ];
    expect(check({ ...baseInput(), heartbeats: bothHeartbeats, workspaceRuntimeServices: [twoRefs] })).toEqual([]);
  });

  it("does not mistake a non-run scopeId for a heartbeat reference", () => {
    const service = validService({ scopeType: "agent", scopeId: HB, startedByRunId: null });
    expectSole(checkService(service), "active_work", "workspace_service", service.id, "resource_lineage_unproven");
  });
});

describe("checkObservedResourceConflicts — rule 5 runtime ownership (PID never consulted)", () => {
  it("blocks a resolving currentIssueId as owner_present", () => {
    const runtime = validRuntime({ currentIssueId: ISSUE });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_owner_present");
  });

  it.each([1, -1, Number.NaN, 1.5])("blocks queueDepth %s as owner_present (only exactly 0 passes)", (queueDepth) => {
    const runtime = validRuntime({ queueDepth });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_owner_present");
  });

  it("expired/stopped bookkeeping does not bypass ownership", () => {
    const runtime = validRuntime({ status: "stopped", stoppedAt: T0, queueDepth: 3 });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_owner_present");
  });

  it("gives identical results for null and retained processPid and never parses lastRunStatus/stateJson", () => {
    // [] 는 quiescence 주장이 아니다 — processPid 유지/부재 어느 쪽도 결과를 바꾸지 않고,
    // lastRunStatus/stateJson/lastError prose 는 일절 해석하지 않는다(멈춘 프로세스 증명 없음).
    const withoutPid = validRuntime({ lastRunStatus: "running", stateJson: { runtimeKey: "prose" }, lastError: "boom" });
    const withPid = validRuntime({ ...withoutPid, processPid: 4242 });
    expect(checkRuntime(withoutPid)).toEqual(checkRuntime(withPid));
    expect(checkRuntime(withPid)).toEqual([]);
  });
});

describe("checkObservedResourceConflicts — rule 6 recorded terminal timestamps", () => {
  it.each([
    ["finishedAt null", { finishedAt: null }],
    ["finishedAt invalid", { finishedAt: new Date("not-a-date") }],
    ["reversed dates", { startedAt: T1, finishedAt: T0 }],
  ])("blocks operation %s as terminal_record_unproven", (_label, overrides) => {
    const operation = validOperation(overrides);
    expectSole(checkOperation(operation), "active_work", "workspace_operation", operation.id, "resource_terminal_record_unproven");
  });

  it.each([
    ["stoppedAt null", { stoppedAt: null }],
    ["stoppedAt invalid", { stoppedAt: new Date("nope") }],
    ["reversed dates", { startedAt: T1, stoppedAt: T0 }],
  ])("blocks service %s as terminal_record_unproven", (_label, overrides) => {
    const service = validService(overrides);
    expectSole(checkService(service), "active_work", "workspace_service", service.id, "resource_terminal_record_unproven");
  });

  it.each([
    ["stopped missing stoppedAt", { status: "stopped", stoppedAt: null }],
    ["stopped invalid startedAt", { status: "stopped", stoppedAt: T1, startedAt: new Date("bad") }],
    ["stopped reversed dates", { status: "stopped", startedAt: T1, stoppedAt: T0 }],
    ["idle invalid startedAt", { startedAt: new Date("bad") }],
    ["crashed invalid nonnull stoppedAt", { status: "crashed", stoppedAt: new Date("bad") }],
  ])("blocks runtime %s as terminal_record_unproven", (_label, overrides) => {
    const runtime = validRuntime(overrides);
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_terminal_record_unproven");
  });

  it("equal start/stop timestamps are valid; idle/crashed null stoppedAt is normal", () => {
    expect(checkOperation(validOperation({ startedAt: T0, finishedAt: T0 }))).toEqual([]);
    expect(checkService(validService({ startedAt: T0, stoppedAt: T0 }))).toEqual([]);
    expect(checkRuntime(validRuntime({ startedAt: T0, stoppedAt: T0 }))).toEqual([]);
    expect(checkRuntime(validRuntime({ status: "crashed", stoppedAt: null }))).toEqual([]);
  });
});

describe("checkObservedResourceConflicts — first-failed-rule precedence", () => {
  it("rule 1 scope beats later rules in every category", () => {
    const operation = validOperation({ companyId: OTHER_COMPANY, status: "running" });
    expectSole(checkOperation(operation), "scope_mismatch", "workspace_operation", operation.id, "resource_scope_mismatch");
    const service = validService({ companyId: OTHER_COMPANY, status: "starting" });
    expectSole(checkService(service), "scope_mismatch", "workspace_service", service.id, "resource_scope_mismatch");
    const runtime = validRuntime({ missionId: OTHER_MISSION, queueDepth: 2 });
    expectSole(checkRuntime(runtime), "scope_mismatch", "mission_runtime", runtime.id, "resource_scope_mismatch");
  });

  it("rule 2 identity beats rules 3-4; identity-level contamination yields ONE scope_mismatch, not both reasons", () => {
    const clean = validOperation();
    const nonterminalDuplicate = validOperation({ id: clean.id, status: "running" });
    expectSole(check({ ...baseInput(), workspaceOperations: [clean, nonterminalDuplicate] }),
      "scope_mismatch", "workspace_operation", clean.id, "resource_identity_ambiguous");
    const contaminated = validOperation({ companyId: OTHER_COMPANY });
    const cleanDuplicate = validOperation({ id: contaminated.id });
    expectSole(check({ ...baseInput(), workspaceOperations: [contaminated, cleanDuplicate] }),
      "scope_mismatch", "workspace_operation", contaminated.id, "resource_scope_mismatch");
    expectSole(check({ ...baseInput(), workspaceOperations: [cleanDuplicate, contaminated] }),
      "scope_mismatch", "workspace_operation", contaminated.id, "resource_scope_mismatch");
  });

  it("rule 4 state beats rule 6 timestamps for services; rule 5 beats rule 6 for runtimes", () => {
    const service = validService({ status: "running", stoppedAt: null });
    expectSole(checkService(service), "active_work", "workspace_service", service.id, "resource_not_terminal");
    const runtime = validRuntime({ status: "stopped", stoppedAt: null, queueDepth: 5 });
    expectSole(checkRuntime(runtime), "active_work", "mission_runtime", runtime.id, "resource_owner_present");
  });
});

describe("checkObservedResourceConflicts — determinism, immutability, no-throw", () => {
  it("never mutates caller input and is deterministic under reversed array order", () => {
    const input = {
      ...baseInput(),
      workspaceOperations: [validOperation(), validOperation({ heartbeatRunId: null })],
      missionAgentRuntimes: [validRuntime({ queueDepth: 2 }), validRuntime()],
    };
    const frozen = structuredClone(input);
    const forward = check(input);
    const reversed = check({
      ...input,
      workspaceOperations: [...input.workspaceOperations].reverse(),
      missionAgentRuntimes: [...input.missionAgentRuntimes].reverse(),
    });
    expect(input).toEqual(frozen);
    expect(reversed).toEqual(forward);
  });

  it("sorts blockers by resourceKind/resourceId/code/reason codepoint and dedups identical tuples", () => {
    // codepoint 순 검증이라 id 자체를 고정한다(랜덤 uuid 는 순서가 뒤바뀐다).
    const OP_A = "88888888-8888-4888-8888-888888888888";
    const OP_B = "99999999-9999-4999-8999-999999999999";
    const runtime = validRuntime({ queueDepth: 1 });
    const blockers = check({
      ...baseInput(),
      workspaceOperations: [validOperation({ id: OP_A }), validOperation({ id: OP_B, heartbeatRunId: null }), validOperation({ id: OP_A })],
      missionAgentRuntimes: [runtime],
    });
    expect(blockers).toEqual([
      { code: "active_work", resourceKind: "mission_runtime", resourceId: runtime.id, reason: "resource_owner_present" },
      { code: "scope_mismatch", resourceKind: "workspace_operation", resourceId: OP_A, reason: "resource_identity_ambiguous" },
      { code: "active_work", resourceKind: "workspace_operation", resourceId: OP_B, reason: "resource_lineage_unproven" },
    ]);
  });

  it("treats ordinary unsupported rows as blockers, never exceptions", () => {
    expect(() => checkOperation(validOperation({ status: "€€" }))).not.toThrow();
  });
});
