import { heartbeatRuns, issues, workflowRuns, workflowStepRuns, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { resolveMissionWorkProductPaths } from "../work-products/output-paths.js";

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function parametersToCliArgs(parameters: unknown): string[] {
  if (Array.isArray(parameters)) return parameters.map((item) => String(item));
  const cliArgs: string[] = [];
  for (const [key, value] of Object.entries(readObject(parameters))) {
    if (!key.trim() || value === undefined || value === null || value === false) continue;
    if (key === "_" || key === "positional") {
      if (Array.isArray(value)) cliArgs.push(...value.map((entry) => String(entry)));
      continue;
    }
    const flag = `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`).replace(/_/g, "-")}`;
    if (value === true) { cliArgs.push(flag); continue; }
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry === undefined || entry === null || entry === false) continue;
      cliArgs.push(flag, typeof entry === "object" ? JSON.stringify(entry) : String(entry));
    }
  }
  return cliArgs;
}
export function normalizeCommandParts(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const part = match[1] ?? match[2] ?? match[3] ?? "";
    if (part.length > 0) parts.push(part);
  }
  return parts;
}
export async function resolveRunStepEnv(db: Db, runId: string): Promise<Record<string, string>> {
  const [run] = await db.select({ issueId: heartbeatRuns.issueId, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
  if (!run?.issueId) return {};
  const [issue] = await db.select({ missionId: issues.missionId, projectId: issues.projectId })
    .from(issues).where(eq(issues.id, run.issueId)).limit(1);
  if (!issue?.missionId) return {};
  const [stepRun] = await db.select({ workflowRunId: workflowStepRuns.workflowRunId, stepId: workflowStepRuns.stepId })
    .from(workflowStepRuns).where(eq(workflowStepRuns.issueId, run.issueId)).limit(1);
  if (!stepRun) return {};
  const paths = await resolveMissionWorkProductPaths(db, { companyId: run.companyId, missionId: issue.missionId,
    projectId: issue.projectId, workflowRunId: stepRun.workflowRunId, stepId: stepRun.stepId });
  const env: Record<string, string> = { PAPERCLIP_WORKFLOW_RUN_ID: stepRun.workflowRunId,
    PAPERCLIP_WORKFLOW_STEP_ID: stepRun.stepId, PAPERCLIP_MISSION_ID: issue.missionId };
  if (paths?.stepOutputDir) env.PAPERCLIP_STEP_OUTPUT_DIR = paths.stepOutputDir;
  return env;
}
/** Native tool steps resolve the same mission output contract as heartbeat tools. */
export async function resolveWorkflowRunStepEnv(db: Db, input: {
  companyId: string; workflowRunId: string; stepId: string;
}): Promise<Record<string, string>> {
  const env: Record<string, string> = { PAPERCLIP_WORKFLOW_RUN_ID: input.workflowRunId, PAPERCLIP_STEP_ID: input.stepId };
  const [run] = await db.select({ missionId: workflowRuns.missionId }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, input.workflowRunId), eq(workflowRuns.companyId, input.companyId))).limit(1);
  if (!run?.missionId) return env;
  env.PAPERCLIP_MISSION_ID = run.missionId;
  const paths = await resolveMissionWorkProductPaths(db, { companyId: input.companyId, missionId: run.missionId,
    workflowRunId: input.workflowRunId, stepId: input.stepId });
  if (paths?.stepOutputDir) env.PAPERCLIP_STEP_OUTPUT_DIR = paths.stepOutputDir;
  return env;
}
