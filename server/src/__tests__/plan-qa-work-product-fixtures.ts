import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { createDb } from "@paperclipai/db";
import { missionPlanArtifacts } from "@paperclipai/db";

/**
 * Shared fixtures for PLAN-QA work product tests. Kept in a non-test module so
 * the two focused test files can import these without one test suite pulling in
 * (and re-running) the other.
 */

export const tempDirs: string[] = [];

export function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plan-qa-work-product-"));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}

export const DECISION_HASH_A = "a".repeat(64);

export function refsWithPlanQa(
  planQaIssueId: string,
  decisionHash: string,
  extra: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 3,
    selectedExecutionUnits: [{ id: "unit-1", title: "Draft report", selectionState: "selected" }],
    planTemplates: { selectionSource: "explicit", items: [] },
    ownerPlanDecision: { decisionHash },
    dynamicMissionPlanning: { missionInvariant: [] },
    planQa: { issueId: planQaIssueId, status: "pending", decisionHash },
    ...extra,
  };
}

export async function seedActivePlan(
  db: ReturnType<typeof createDb>,
  companyId: string,
  missionId: string,
  ownerAgentId: string,
  planQaIssueId: string,
  decisionHash: string,
  overrides: Partial<typeof missionPlanArtifacts.$inferInsert> = {},
) {
  const [plan] = await db
    .insert(missionPlanArtifacts)
    .values({
      companyId,
      missionId,
      ownerAgentId,
      missionGoal: "Ship the research report",
      refs: refsWithPlanQa(planQaIssueId, decisionHash),
      requiredInputs: [{ label: "Source data" }],
      successCriteria: [{ label: "Report passes review" }],
      risks: [{ label: "Data gap" }],
      steps: [{ id: "step-1", title: "Draft" }],
      ...overrides,
    })
    .returning();
  return plan!;
}
