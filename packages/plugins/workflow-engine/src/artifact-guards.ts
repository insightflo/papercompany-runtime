import { access } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowStep } from "./dag-engine.js";
import type { WorkflowDefinitionRecord, WorkflowRunRecord } from "./workflow-utils.js";

export type ArtifactValidationResult = {
  ok: boolean;
  requiredPath?: string;
  reason?: string;
};

function parseRunLabelDate(runLabel: string | undefined): string | null {
  const match = /^#?(\d{4}-\d{2}-\d{2})(?:-\d+)?$/.exec(runLabel?.trim() ?? "");
  return match?.[1] ?? null;
}

function resolveRunDate(workflowRun: WorkflowRunRecord): string {
  const explicit = typeof workflowRun.data.runDate === "string" ? workflowRun.data.runDate.trim() : "";
  if (explicit) return explicit;

  const fromLabel = parseRunLabelDate(workflowRun.data.runLabel);
  if (fromLabel) return fromLabel;

  const startedMs = Date.parse(workflowRun.data.startedAt ?? "");
  if (Number.isFinite(startedMs)) return new Date(startedMs).toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

function getGazuaWorkspaceDir(): string {
  return process.env.GAZUA_DASHBOARD_ROOT
    || "/Users/kwak/Projects/ai/gazua-dashboard";
}

function requiredArtifactPathForStep(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  stepDef: WorkflowStep,
): string | null {
  const workflowName = workflowRun.data.workflowName || workflowDefinition.data.name;
  if (workflowName !== "gazua-morning" && workflowName !== "gazua-evening") {
    return null;
  }
  if (stepDef.id !== "materialize-html-report") {
    return null;
  }

  const runDate = resolveRunDate(workflowRun);
  const monthKey = runDate.slice(0, 7).replace("-", "");
  const reportPrefix = workflowName === "gazua-evening" ? "US_Market_Report" : "KR_Market_Report";
  return join(
    getGazuaWorkspaceDir(),
    "reports",
    "beginner_html",
    "dashboard",
    "daily",
    monthKey,
    `${reportPrefix}_${runDate}.html`,
  );
}

export async function validateRequiredStepArtifacts(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  stepDef: WorkflowStep,
): Promise<ArtifactValidationResult> {
  const requiredPath = requiredArtifactPathForStep(workflowRun, workflowDefinition, stepDef);
  if (!requiredPath) {
    return { ok: true };
  }

  try {
    await access(requiredPath);
    return { ok: true };
  } catch {
    return {
      ok: false,
      requiredPath,
      reason: `Required workflow artifact missing: ${requiredPath}`,
    };
  }
}
