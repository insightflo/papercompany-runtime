import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { recordLatestAuthorizedMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";
import {
  normalizeMissionPlanDependencyGraph,
  remapCanonicalDependenciesToStepIds,
  type CanonicalMissionPlanDependencyGraph,
} from "../services/missions/mission-plan-dependency-graph.js";
import { buildDependencyIndex } from "../services/missions/mission-plan-unit-dependencies.js";

const unit = (
  id: string,
  dependencies: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ id, title: `[ACTION] ${id}`, dependencies, ...extra });

function validGraph(
  units: Record<string, unknown>[],
  draftSteps: Array<string | Record<string, unknown>> = [],
): CanonicalMissionPlanDependencyGraph {
  const result = normalizeMissionPlanDependencyGraph(units, draftSteps);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) throw new Error("expected valid graph");
  return result.graph;
}

function errorCodes(
  units: Record<string, unknown>[],
  draftSteps: Array<string | Record<string, unknown>> = [],
): string[] {
  const result = normalizeMissionPlanDependencyGraph(units, draftSteps);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.diagnostics.map((entry) => entry.code);
}

describe("canonical mission-plan dependency identity", () => {
  it("requires unique canonical unit ids", () => {
    expect(errorCodes([{ title: "missing" }])).toContain("missing_unit_id");
    expect(errorCodes([unit("same"), unit("same")])).toContain("duplicate_unit_id");
  });

  it("allows an unreferenced shared provenance alias without contaminating edges", () => {
    const graph = validGraph([
      unit("a", [], { sourceRef: { id: "shared" } }),
      unit("b", ["a"], { sourceRef: { id: "shared" } }),
    ]);

    expect(graph.units.map((entry) => entry.dependencies)).toEqual([[], ["a"]]);
    expect(graph.dependencyIndex).toEqual([[], [0]]);
  });

  it("resolves a unique legacy alias but rejects referenced ambiguous aliases", () => {
    const graph = validGraph([
      unit("producer", [], { unitId: "legacy-producer" }),
      unit("consumer", ["legacy-producer"]),
    ]);
    expect(graph.units[1]!.dependencies).toEqual(["producer"]);

    expect(errorCodes([
      unit("a", [], { sourceRef: { id: "shared" } }),
      unit("b", [], { sourceRef: { id: "shared" } }),
      unit("c", ["shared"]),
    ])).toContain("ambiguous_dependency_ref");
  });

  it("rejects unresolved refs, malformed shapes, self edges, and cycles", () => {
    expect(errorCodes([unit("a", ["missing"])])).toContain("unresolved_dependency_ref");
    expect(errorCodes([{ ...unit("a"), dependencies: "b" }, unit("b")]))
      .toContain("invalid_dependency_shape");
    expect(errorCodes([unit("a"), unit("b")], [{ units: ["b", 3], dependsOn: ["a"] }]))
      .toContain("invalid_dependency_shape");
    expect(errorCodes([unit("a", ["a"])])).toContain("self_dependency");
    expect(errorCodes([unit("a", ["b"]), unit("b", ["a"])]))
      .toContain("dependency_cycle");
    expect(errorCodes([unit("a", ["c"]), unit("b", ["a"]), unit("c", ["b"])]))
      .toContain("dependency_cycle");
  });

  it("merges every dependency form and canonicalizes dependency-bearing draft steps", () => {
    const graph = validGraph(
      [
        unit("a", [], { unitId: "legacy-a" }),
        unit("b", [], { dependsOn: ["legacy-a"] }),
        unit("c", [], { after: ["b"] }),
        unit("d"),
      ],
      [
        { unitId: "d", dependencies: ["c"] },
        { id: "description-only", title: "Not a dependency declaration" },
      ],
    );

    expect(graph.units.map((entry) => entry.dependencies)).toEqual([
      [], ["a"], ["b"], ["c"],
    ]);
    expect(graph.units[1]).not.toHaveProperty("dependsOn");
    expect(graph.units[2]).not.toHaveProperty("after");
    expect(graph.draftSteps[0]).toMatchObject({ unitId: "d", dependencies: ["c"] });
    expect(graph.draftSteps[1]).toEqual({ id: "description-only", title: "Not a dependency declaration" });

    const normalizedAgain = validGraph(graph.units, graph.draftSteps);
    expect(normalizedAgain.units).toEqual(graph.units);
    expect(normalizedAgain.draftSteps).toEqual(graph.draftSteps);
  });

  it("gives non-empty draft units precedence over scalar target forms", () => {
    const graph = validGraph(
      [unit("a"), unit("b"), unit("c")],
      [{ units: ["b"], unitId: "c", dependsOn: ["a"] }],
    );
    expect(graph.units.map((entry) => entry.dependencies)).toEqual([[], ["a"], []]);
  });

  it("rejects materialized-to-filtered edges but allows filtered metadata edges", () => {
    const filtered = unit("oversight", [], { kind: "oversight", title: "[OVERSIGHT] coordinate" });
    expect(errorCodes([unit("action", ["oversight"]), filtered]))
      .toContain("materialized_dependency_on_filtered_unit");

    const graph = validGraph([
      unit("action"),
      { ...filtered, dependencies: ["action"] },
    ]);
    expect(graph.units[1]!.dependencies).toEqual(["action"]);
    expect(graph.materializedUnits.map((entry) => entry.id)).toEqual(["action"]);

    const delegated = unit("delegated", ["action"], {
      kind: "cross_company_mission",
      sourceRef: { type: "cross_company_mission", id: "remote-1" },
    });
    expect(validGraph([unit("action"), delegated]).materializedUnits.map((entry) => entry.id))
      .toEqual(["action"]);
    expect(errorCodes([unit("action", ["delegated"]), { ...delegated, dependencies: [] }]))
      .toContain("materialized_dependency_on_filtered_unit");
  });

  it("uses identical canonical adjacency for the shared index and materialized graph", () => {
    const units = [
      unit("a", [], { sourceRef: { stepId: "source-a" } }),
      unit("b", ["source-a"]),
      unit("c", ["b"]),
    ];
    const graph = validGraph(units);

    expect(buildDependencyIndex(graph.units)).toEqual(graph.dependencyIndex);
    expect(graph.materializedDependencyIndex).toEqual(graph.dependencyIndex);
    expect(remapCanonicalDependenciesToStepIds(graph.materializedUnits, ["step-a", "step-b", "step-c"]))
      .toEqual([[], ["step-a"], ["step-b"]]);
  });

  it("fails before any database or wakeup side effect", async () => {
    const dbTouched = vi.fn();
    const db = new Proxy({}, {
      get() {
        dbTouched();
        throw new Error("database must not be touched");
      },
    }) as Db;
    const wakeup = vi.fn();

    for (const selectedExecutionUnits of [
      [unit("action", ["missing"])],
      [{ ...unit("action"), dependsOn: "missing" }],
    ]) {
      const result = await recordLatestAuthorizedMissionOwnerPlanDecision({
        db,
        companyId: "company-1",
        missionId: "mission-1",
        enqueuePlanQaWakeup: wakeup,
        preParsedDecision: {
          planningIssueId: "plan-1",
          decision: { missionId: "mission-1", selectedExecutionUnits, steps: [] },
        },
      });
      expect(result).toMatchObject({ status: "invalid", reason: "invalid_dependency_graph" });
    }

    expect(dbTouched).not.toHaveBeenCalled();
    expect(wakeup).not.toHaveBeenCalled();
  });
});
