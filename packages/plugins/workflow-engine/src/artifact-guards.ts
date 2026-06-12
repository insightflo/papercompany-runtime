import { access, readFile } from "node:fs/promises";
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

function requiredArtifactPathsForStep(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  stepDef: WorkflowStep,
): string[] {
  const workflowName = workflowRun.data.workflowName || workflowDefinition.data.name;
  if (workflowName !== "gazua-morning" && workflowName !== "gazua-evening") {
    return [];
  }
  if (stepDef.id !== "materialize-html-report") {
    return [];
  }

  const runDate = resolveRunDate(workflowRun);
  const monthKey = runDate.slice(0, 7).replace("-", "");
  const marketPrefix = workflowName === "gazua-evening" ? "US" : "KR";
  const dailyReportPrefix = workflowName === "gazua-evening" ? "US_Market_Report" : "KR_Market_Report";
  return [
    join(
      getGazuaWorkspaceDir(),
      "reports",
      "beginner_html",
      "dashboard",
      "daily",
      monthKey,
      `${dailyReportPrefix}_${runDate}.html`,
    ),
    join(
      getGazuaWorkspaceDir(),
      "reports",
      "beginner_html",
      "dashboard",
      "deep_dive",
      monthKey,
      `Sector_Rotation_Analysis_${runDate}${marketPrefix === "US" ? "_US" : ""}.html`,
    ),
    join(
      getGazuaWorkspaceDir(),
      "reports",
      "beginner_html",
      "dashboard",
      "deep_dive",
      monthKey,
      `Narrative_Deep_Dive_${runDate}${marketPrefix === "US" ? "_US" : ""}.html`,
    ),
  ];
}

function validateReportForBeginnersHtml(path: string, html: string): string | null {
  if (!html.trim().startsWith("<!DOCTYPE html>")) return `Report is not a standalone HTML document: ${path}`;
  if (!html.includes('data-gazua-report="beginner-html"')) return `Missing data-gazua-report marker: ${path}`;
  if (!html.includes('data-report-style="report-for-beginners"')) return `Missing report-for-beginners style marker: ${path}`;
  if (!html.includes("GAZUA_BEGINNER_REPORT_META")) return `Missing GAZUA_BEGINNER_REPORT_META comment: ${path}`;
  if (html.includes("<!-- SLIDES:")) return `Raw SLIDES markdown comment leaked into HTML: ${path}`;
  if (html.includes('class="report-body"')) return `Legacy markdown-wrapper HTML is not acceptable for report-for-beginners output: ${path}`;

  const requiredSignals = [
    "판단 항목",
    "신뢰도",
    'class="kpi-grid"',
    "계산식",
    "chart-card",
    "risk-grid",
    "scenario-grid",
    "References",
  ];
  const missingSignals = requiredSignals.filter((signal) => !html.includes(signal));
  if (missingSignals.length > 0) {
    return `Report-for-beginners structure incomplete for ${path}: missing ${missingSignals.join(", ")}`;
  }

  return null;
}

async function validateRequiredArtifact(path: string): Promise<ArtifactValidationResult> {
  try {
    await access(path);
  } catch {
    return {
      ok: false,
      requiredPath: path,
      reason: `Required workflow artifact missing: ${path}`,
    };
  }

  const html = await readFile(path, "utf8");
  const reason = validateReportForBeginnersHtml(path, html);
  if (reason) {
    return {
      ok: false,
      requiredPath: path,
      reason,
    };
  }

  return { ok: true };
}

export async function validateRequiredStepArtifacts(
  workflowRun: WorkflowRunRecord,
  workflowDefinition: WorkflowDefinitionRecord,
  stepDef: WorkflowStep,
): Promise<ArtifactValidationResult> {
  const requiredPaths = requiredArtifactPathsForStep(workflowRun, workflowDefinition, stepDef);
  if (requiredPaths.length === 0) {
    return { ok: true };
  }

  for (const requiredPath of requiredPaths) {
    const result = await validateRequiredArtifact(requiredPath);
    if (!result.ok) return result;
  }

  return { ok: true };
}
