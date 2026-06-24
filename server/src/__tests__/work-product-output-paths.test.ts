import { describe, expect, it } from "vitest";
import {
  buildMissionWorkProductPaths,
  isPathInsideOrEqual,
  safeWorkProductPathSegment,
} from "../services/work-products/output-paths.ts";

describe("workProduct output paths", () => {
  it("builds company-rooted mission/run/step output directories", () => {
    expect(buildMissionWorkProductPaths({
      workProductRoot: "/srv/papercompany/projects/research-company/produced_work",
      missionId: "mission-1",
      workflowRunId: "run-1",
      stepId: "Collect TrendShift Top25 evidence",
    })).toEqual({
      workProductRoot: "/srv/papercompany/projects/research-company/produced_work",
      missionOutputDir: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1",
      runOutputDir: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1/runs/run-1",
      stepOutputDir: "/srv/papercompany/projects/research-company/produced_work/missions/mission-1/runs/run-1/steps/Collect-TrendShift-Top25-evidence",
    });
  });

  it("detects paths inside the mission output root", () => {
    const root = "/srv/papercompany/projects/research-company/produced_work/missions/mission-1";
    expect(isPathInsideOrEqual(`${root}/runs/run-1/steps/collect/evidence.json`, root)).toBe(true);
    expect(isPathInsideOrEqual("/srv/papercompany/projects/research-company/produced_work/tech-scout/old/evidence.json", root)).toBe(false);
  });

  it("sanitizes workflow step ids for filesystem segments", () => {
    expect(safeWorkProductPathSegment("build/html report")).toBe("build-html-report");
    expect(safeWorkProductPathSegment("")).toBe("unknown");
  });
});
