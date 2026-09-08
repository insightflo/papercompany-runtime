import { describe, expect, it } from "vitest";
import {
  observedIssueRow,
  observedOperationRow,
  observedRuntimeRow,
  observedServiceRow,
  settlementHeartbeatRow,
  type ObservedIssueRow,
  type ObservedServiceRow,
} from "./helpers/workflow-resume-observed-resource-fixture.js";
import {
  buildHistoryLinkIndex,
  collectServiceHeartbeatRefs,
  runScopeIdMissing,
} from "../services/workflow/resume/observed-resource-links.js";
import {
  checkObservedResourceConflicts,
  type ObservedResourceBlocker,
  type ObservedResourceConflictsInput,
} from "../services/workflow/resume/observed-resource-conflicts.js";

/**
 * [purpose] Task5c3b duplicate-aware typed link index — the LESSONS.md duplicate-index pitfall
 *   guards. Map overwrite is not identity validation: duplicated heartbeat/issue IDs must make
 *   referencing resources ambiguous (no last-wins authority), and a single contaminated
 *   duplicate candidate must surface scope_mismatch in any input order.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSION = "22222222-2222-4222-8222-222222222222";
const OTHER_MISSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "33333333-3333-4333-8333-333333333333";
const HB = "44444444-4444-4444-8444-444444444444";
const HB2 = "55555555-5555-5555-8555-555555555555";
const ISSUE = "66666666-6666-4666-8666-666666666666";
const SCOPE = { companyId: COMPANY, missionId: MISSION, workflowRunId: RUN, startStepId: "resume-step-a" };

function heartbeat(id: string, companyId = COMPANY) {
  return settlementHeartbeatRow({ id, companyId });
}
function issue(overrides?: Partial<ObservedIssueRow>): ObservedIssueRow {
  return observedIssueRow({ id: ISSUE, companyId: COMPANY, missionId: MISSION, ...overrides });
}
function validRuntime(overrides?: Parameters<typeof observedRuntimeRow>[0]): ReturnType<typeof observedRuntimeRow> {
  return observedRuntimeRow({ companyId: COMPANY, missionId: MISSION, lastRunId: HB, ...overrides });
}
function validService(overrides?: Partial<ObservedServiceRow>): ObservedServiceRow {
  return observedServiceRow({ companyId: COMPANY, startedByRunId: HB, scopeId: HB, ...overrides });
}

function check(input: ObservedResourceConflictsInput): ObservedResourceBlocker[] {
  return checkObservedResourceConflicts(input);
}

describe("buildHistoryLinkIndex — resolution, duplication, scope contamination", () => {
  it("resolves present ids only and flags duplicated heartbeat/issue ids in both orders", () => {
    const duplicated = [heartbeat(HB), heartbeat(HB, COMPANY)];
    for (const heartbeats of [duplicated, [...duplicated].reverse()]) {
      const links = buildHistoryLinkIndex(SCOPE, [issue()], heartbeats);
      expect(links.heartbeatResolves(HB)).toBe(true);
      expect(links.heartbeatResolves(HB2)).toBe(false);
      expect(links.issueResolves(ISSUE)).toBe(true);
      expect(links.isDuplicateHeartbeat(HB)).toBe(true);
      expect(links.isDuplicateHeartbeat(HB2)).toBe(false);
      expect(links.isDuplicateIssue(ISSUE)).toBe(false);
    }
  });

  it("marks duplicate issue ids ambiguous without collapsing to last-wins", () => {
    const links = buildHistoryLinkIndex(SCOPE, [issue(), issue()], [heartbeat(HB)]);
    expect(links.isDuplicateIssue(ISSUE)).toBe(true);
    expect(links.issueResolves(ISSUE)).toBe(true);
  });

  it("heartbeat contamination is any-candidate: one bad company among duplicates taints the id", () => {
    const mixed = [heartbeat(HB), heartbeat(HB, OTHER_COMPANY)];
    for (const heartbeats of [mixed, [...mixed].reverse()]) {
      const links = buildHistoryLinkIndex(SCOPE, [], heartbeats);
      expect(links.heartbeatOutOfScope(HB)).toBe(true);
    }
  });

  it("issue scope: other company or nonnull other mission is out of scope; null mission is legacy-allowed", () => {
    const links = buildHistoryLinkIndex(SCOPE, [
      issue({ id: ISSUE, missionId: null }),
      issue({ id: HB, companyId: OTHER_COMPANY }),
      issue({ id: HB2, missionId: OTHER_MISSION }),
    ], []);
    expect(links.issueOutOfScope(ISSUE)).toBe(false); // null missionId = legacy association allowed
    expect(links.issueOutOfScope(HB)).toBe(true);
    expect(links.issueOutOfScope(HB2)).toBe(true);
    expect(links.issueResolves(RUN)).toBe(false);
    expect(links.issueOutOfScope(RUN)).toBe(false); // unresolved refs are lineage, not scope
  });

  it("clean duplicate candidates keep out-of-scope false while remaining ambiguous", () => {
    const links = buildHistoryLinkIndex(SCOPE, [], [heartbeat(HB), heartbeat(HB)]);
    expect(links.heartbeatOutOfScope(HB)).toBe(false);
    expect(links.isDuplicateHeartbeat(HB)).toBe(true);
  });
});

describe("collectServiceHeartbeatRefs / runScopeIdMissing — typed reference collection", () => {
  it("collects nonnull startedByRunId and run-scope nonempty scopeId, in that order", () => {
    expect(collectServiceHeartbeatRefs(validService({ startedByRunId: HB, scopeId: HB2 }))).toEqual([HB, HB2]);
  });

  it("never interprets a non-run scopeId as a heartbeat reference", () => {
    const agent = validService({ scopeType: "agent", scopeId: HB, startedByRunId: null });
    expect(collectServiceHeartbeatRefs(agent)).toEqual([]);
    const project = validService({ scopeType: "project", scopeId: HB2, startedByRunId: null, issueId: ISSUE });
    expect(collectServiceHeartbeatRefs(project)).toEqual([]);
  });

  it("run scope with null/empty scopeId is flagged missing; non-run scopeId absence is not", () => {
    expect(runScopeIdMissing(validService({ scopeId: null }))).toBe(true);
    expect(runScopeIdMissing(validService({ scopeId: "" }))).toBe(true);
    expect(runScopeIdMissing(validService({ scopeType: "agent", scopeId: null }))).toBe(false);
    expect(runScopeIdMissing(validService({ scopeId: HB2 }))).toBe(false);
  });
});

describe("end-to-end via checkObservedResourceConflicts — duplicate and contamination behavior", () => {
  it("duplicated heartbeat id makes the referencing operation ambiguous, not last-wins accepted", () => {
    const operation = observedOperationRow({ companyId: COMPANY, heartbeatRunId: HB });
    const input = (heartbeats: ReturnType<typeof heartbeat>[]) => ({
      scope: SCOPE,
      issues: [],
      heartbeats,
      workspaceOperations: [operation],
      workspaceRuntimeServices: [],
      missionAgentRuntimes: [],
    });
    const duplicated = [heartbeat(HB), heartbeat(HB)];
    expect(check(input(duplicated))).toEqual([{
      code: "scope_mismatch", resourceKind: "workspace_operation", resourceId: operation.id,
      reason: "resource_identity_ambiguous",
    }]);
    expect(check(input([...duplicated].reverse()))).toEqual(check(input(duplicated)));
  });

  it("one contaminated duplicate candidate yields scope_mismatch for the referencing runtime in any order", () => {
    const runtime = validRuntime();
    const input = (heartbeats: ReturnType<typeof heartbeat>[]) => ({
      scope: SCOPE,
      issues: [],
      heartbeats,
      workspaceOperations: [],
      workspaceRuntimeServices: [],
      missionAgentRuntimes: [runtime],
    });
    const mixed = [heartbeat(HB), heartbeat(HB, OTHER_COMPANY)];
    const expected = [{
      code: "scope_mismatch", resourceKind: "mission_runtime", resourceId: runtime.id,
      reason: "resource_scope_mismatch",
    }];
    expect(check(input(mixed))).toEqual(expected);
    expect(check(input([...mixed].reverse()))).toEqual(expected);
  });

  it("duplicated issue id makes the referencing runtime ambiguous (identity beats ownership)", () => {
    const runtime = validRuntime({ currentIssueId: ISSUE });
    const base = (issues: ObservedIssueRow[]) => ({
      scope: SCOPE,
      issues,
      heartbeats: [heartbeat(HB)],
      workspaceOperations: [],
      workspaceRuntimeServices: [],
      missionAgentRuntimes: [runtime],
    });
    expect(check(base([issue(), issue()]))).toEqual([{
      code: "scope_mismatch", resourceKind: "mission_runtime", resourceId: runtime.id,
      reason: "resource_identity_ambiguous",
    }]);
    // clean single issue resolves — identity passes, ownership rule then reports the owner.
    expect(check(base([issue()]))).toEqual([{
      code: "active_work", resourceKind: "mission_runtime", resourceId: runtime.id,
      reason: "resource_owner_present",
    }]);
  });

  it("referenced heartbeat/issue from another company or mission is a scope mismatch, not lineage", () => {
    const foreignHbService = validService({ startedByRunId: HB, scopeId: HB });
    const input = (heartbeats: ReturnType<typeof heartbeat>[]) => ({
      scope: SCOPE,
      issues: [issue()],
      heartbeats,
      workspaceOperations: [],
      workspaceRuntimeServices: [foreignHbService],
      missionAgentRuntimes: [],
    });
    expect(check(input([heartbeat(HB, OTHER_COMPANY)]))).toEqual([{
      code: "scope_mismatch", resourceKind: "workspace_service", resourceId: foreignHbService.id,
      reason: "resource_scope_mismatch",
    }]);
    const runtimeWithForeignIssue = observedRuntimeRow({
      companyId: COMPANY, missionId: MISSION, lastRunId: HB, currentIssueId: ISSUE,
    });
    expect(check({
      scope: SCOPE,
      issues: [issue({ missionId: OTHER_MISSION })],
      heartbeats: [heartbeat(HB)],
      workspaceOperations: [],
      workspaceRuntimeServices: [],
      missionAgentRuntimes: [runtimeWithForeignIssue],
    })).toEqual([{
      code: "scope_mismatch", resourceKind: "mission_runtime", resourceId: runtimeWithForeignIssue.id,
      reason: "resource_scope_mismatch",
    }]);
  });
});

// [fix1] ANY contaminated duplicate candidate => whole identity gets ONE scope_mismatch (order-free); date ORDER only for stopped.
const SCOPE_REASONS = new Set<string>(["resource_scope_mismatch", "resource_identity_ambiguous"]);
const sole = (resourceKind: ObservedResourceBlocker["resourceKind"], resourceId: string, reason: ObservedResourceBlocker["reason"]): ObservedResourceBlocker[] => [{ code: SCOPE_REASONS.has(reason) ? "scope_mismatch" : "active_work", resourceKind, resourceId, reason }];

describe("fix1 regressions — identity scope precedence, runtime date order, contract gaps", () => {
  const T0 = new Date("2024-06-01T00:00:00.000Z");
  const T1 = new Date("2024-06-01T01:00:00.000Z");
  const inputWith = (rows: Partial<ObservedResourceConflictsInput>): ObservedResourceConflictsInput => ({
    scope: SCOPE, issues: [], heartbeats: [heartbeat(HB)],
    workspaceOperations: [], workspaceRuntimeServices: [], missionAgentRuntimes: [], ...rows,
  });
  it("any company/mission-contaminated duplicate candidate => ONE scope_mismatch per identity, order-free; clean duplicates => ONE ambiguity", () => {
    const operation = observedOperationRow({ companyId: COMPANY, heartbeatRunId: HB });
    const operationForeign = observedOperationRow({ id: operation.id, companyId: OTHER_COMPANY, heartbeatRunId: HB });
    const service = validService();
    const serviceForeign = validService({ id: service.id, companyId: OTHER_COMPANY });
    const runtime = validRuntime();
    const expectSole = (input: ObservedResourceConflictsInput, kind: ObservedResourceBlocker["resourceKind"], id: string, reason: ObservedResourceBlocker["reason"]) => expect(check(input)).toEqual(sole(kind, id, reason));
    expectSole(inputWith({ workspaceOperations: [operation, operationForeign] }), "workspace_operation", operation.id, "resource_scope_mismatch");
    expectSole(inputWith({ workspaceOperations: [operationForeign, operation] }), "workspace_operation", operation.id, "resource_scope_mismatch");
    expectSole(inputWith({ workspaceRuntimeServices: [service, serviceForeign] }), "workspace_service", service.id, "resource_scope_mismatch");
    expectSole(inputWith({ workspaceRuntimeServices: [serviceForeign, service] }), "workspace_service", service.id, "resource_scope_mismatch");
    for (const foreign of [validRuntime({ id: runtime.id, companyId: OTHER_COMPANY }), validRuntime({ id: runtime.id, missionId: OTHER_MISSION })])
      for (const rows of [[runtime, foreign], [foreign, runtime]])
        expectSole(inputWith({ missionAgentRuntimes: rows }), "mission_runtime", runtime.id, "resource_scope_mismatch");
    expectSole(inputWith({ workspaceOperations: [operation, observedOperationRow({ id: operation.id, companyId: COMPANY, heartbeatRunId: HB })] }), "workspace_operation", operation.id, "resource_identity_ambiguous");
    expectSole(inputWith({ workspaceRuntimeServices: [service, validService({ id: service.id })] }), "workspace_service", service.id, "resource_identity_ambiguous");
    expectSole(inputWith({ missionAgentRuntimes: [runtime, validRuntime({ id: runtime.id })] }), "mission_runtime", runtime.id, "resource_identity_ambiguous");
  });
  it("a duplicate candidate referencing a foreign heartbeat/issue makes the WHOLE identity scope_mismatch", () => {
    const foreignHb = [heartbeat(HB), heartbeat(HB2, OTHER_COMPANY)], foreignIssue = [issue(), issue({ id: ISSUE, companyId: OTHER_COMPANY })];
    const operation = observedOperationRow({ companyId: COMPANY, heartbeatRunId: HB }), service = validService(), runtime = validRuntime();
    for (const rows of [[operation, observedOperationRow({ id: operation.id, companyId: COMPANY, heartbeatRunId: HB2 })], [observedOperationRow({ id: operation.id, companyId: COMPANY, heartbeatRunId: HB2 }), operation]])
      expect(check(inputWith({ heartbeats: foreignHb, workspaceOperations: rows }))).toEqual(sole("workspace_operation", operation.id, "resource_scope_mismatch"));
    for (const rows of [[service, validService({ id: service.id, scopeId: HB2 })], [validService({ id: service.id, scopeId: HB2 }), service]]) // foreign heartbeat ref: scopeId=HB2, startedByRunId=HB
      expect(check(inputWith({ heartbeats: foreignHb, workspaceRuntimeServices: rows }))).toEqual(sole("workspace_service", service.id, "resource_scope_mismatch"));
    for (const rows of [[service, validService({ id: service.id, issueId: ISSUE })], [validService({ id: service.id, issueId: ISSUE }), service]]) // foreign issue ref, issue company foreign
      expect(check(inputWith({ heartbeats: [heartbeat(HB)], issues: foreignIssue, workspaceRuntimeServices: rows }))).toEqual(sole("workspace_service", service.id, "resource_scope_mismatch"));
    for (const rows of [[runtime, validRuntime({ id: runtime.id, lastRunId: HB2 })], [validRuntime({ id: runtime.id, lastRunId: HB2 }), runtime]])
      expect(check(inputWith({ heartbeats: foreignHb, missionAgentRuntimes: rows }))).toEqual(sole("mission_runtime", runtime.id, "resource_scope_mismatch"));
    for (const rows of [[runtime, validRuntime({ id: runtime.id, currentIssueId: ISSUE })], [validRuntime({ id: runtime.id, currentIssueId: ISSUE }), runtime]])
      expect(check(inputWith({ heartbeats: [heartbeat(HB)], issues: foreignIssue, missionAgentRuntimes: rows }))).toEqual(sole("mission_runtime", runtime.id, "resource_scope_mismatch"));
  });
  it("runtime date ORDER applies only to stopped; idle/crashed need finite dates without ordering", () => {
    const checkRuntime = (overrides: Parameters<typeof validRuntime>[0]) => check(inputWith({ missionAgentRuntimes: [validRuntime(overrides)] }));
    expect(checkRuntime({ startedAt: T1, stoppedAt: T0 })).toEqual([]); // idle: finite dates only, no order
    expect(checkRuntime({ status: "crashed", startedAt: T1, stoppedAt: T0 })).toEqual([]);
    const stoppedReversed = validRuntime({ status: "stopped", startedAt: T1, stoppedAt: T0 });
    expect(check(inputWith({ missionAgentRuntimes: [stoppedReversed] }))).toEqual(sole("mission_runtime", stoppedReversed.id, "resource_terminal_record_unproven"));
    expect(checkRuntime({ status: "stopped", startedAt: T0, stoppedAt: T0 })).toEqual([]); // equal dates valid
  });
  it("gaps: unknown service/runtime states, invalid startedAt, dangling run scopeId beside valid startedByRunId", () => {
    const unknownService = validService({ status: "mystery_unknown_status" });
    expect(check(inputWith({ workspaceRuntimeServices: [unknownService] }))).toEqual(sole("workspace_service", unknownService.id, "resource_not_terminal"));
    const unknownRuntime = validRuntime({ status: "mystery_unknown_status" });
    expect(check(inputWith({ missionAgentRuntimes: [unknownRuntime] }))).toEqual(sole("mission_runtime", unknownRuntime.id, "resource_not_terminal"));
    const badStartOperation = observedOperationRow({ companyId: COMPANY, heartbeatRunId: HB, startedAt: new Date("not-a-date") });
    expect(check(inputWith({ workspaceOperations: [badStartOperation] }))).toEqual(sole("workspace_operation", badStartOperation.id, "resource_terminal_record_unproven"));
    const badStartService = validService({ startedAt: new Date("not-a-date") });
    expect(check(inputWith({ workspaceRuntimeServices: [badStartService] }))).toEqual(sole("workspace_service", badStartService.id, "resource_terminal_record_unproven"));
    const danglingScope = validService({ scopeId: RUN }); // startedByRunId=HB resolves; run scopeId dangles
    expect(check(inputWith({ workspaceRuntimeServices: [danglingScope] }))).toEqual(sole("workspace_service", danglingScope.id, "resource_lineage_unproven"));
  });
  it("duplicate service heartbeat/issue references: contamination judged BEFORE ambiguity", () => {
    const scopeService = validService({ startedByRunId: HB, scopeId: HB2 }), issueService = validService({ issueId: ISSUE }), cleanHbs = [heartbeat(HB), heartbeat(HB2), heartbeat(HB2)];
    for (const rows of [cleanHbs, [...cleanHbs].reverse()])
      expect(check(inputWith({ heartbeats: rows, workspaceRuntimeServices: [scopeService] }))).toEqual(sole("workspace_service", scopeService.id, "resource_identity_ambiguous"));
    for (const rows of [[heartbeat(HB), heartbeat(HB2), heartbeat(HB2, OTHER_COMPANY)], [heartbeat(HB2, OTHER_COMPANY), heartbeat(HB), heartbeat(HB2)]])
      expect(check(inputWith({ heartbeats: rows, workspaceRuntimeServices: [scopeService] }))).toEqual(sole("workspace_service", scopeService.id, "resource_scope_mismatch"));
    expect(check(inputWith({ heartbeats: [heartbeat(HB)], issues: [issue(), issue()], workspaceRuntimeServices: [issueService] }))).toEqual(sole("workspace_service", issueService.id, "resource_identity_ambiguous"));
    for (const rows of [[issue(), issue({ companyId: OTHER_COMPANY })], [issue({ companyId: OTHER_COMPANY }), issue()]])
      expect(check(inputWith({ heartbeats: [heartbeat(HB)], issues: rows, workspaceRuntimeServices: [issueService] }))).toEqual(sole("workspace_service", issueService.id, "resource_scope_mismatch"));
  });
  it("recursively frozen input (objects and arrays) is judged without mutation", () => {
    const runtime = validRuntime({ queueDepth: 2 });
    const input = inputWith({ missionAgentRuntimes: [runtime] });
    const deepFreeze = (value: object): void => {
      if (Object.isFrozen(value)) return;
      Object.freeze(value);
      for (const child of Object.values(value)) if (child !== null && typeof child === "object") deepFreeze(child);
    };
    deepFreeze(input);
    expect(Object.isFrozen(input.missionAgentRuntimes)).toBe(true);
    expect(() => check(input)).not.toThrow();
    expect(check(input)).toEqual(sole("mission_runtime", runtime.id, "resource_owner_present"));
  });
});
