import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { missionService } from "../missions.js";
import { resolveWorkflowMissionOwnerAgentId } from "../missions/mission-create-records.js";
import { admitReplacement, assertAgentReplacementRequired } from "./replacement-admission.js";
import { createAdmittedWorkflowRun } from "./agent-run-create.js";
import { assertRevisionBoardStart } from "./revision-run-admission.js";
import { assertSeedActor } from "./workflow-seed-admission.js";
import { assertWorkflowToolReadinessForSteps } from "./admission-tool-readiness.js";
import { normalizeWorkflowRunInputs, type WorkflowRunInputPolicy } from "./run-input-normalization.js";
import { formatDateKeyInTimezone } from "./workflow-run-date.js";
import { getWorkflowDefinitionById, listWorkflowRuns } from "./workflow-store.js";
import { ensureCreatedRunOversight } from "./workflow-created-run-oversight.js";
import type { CreateWorkflowRunInput, WorkflowDefinition, WorkflowRun } from "./types.js";

function formatWorkflowMissionTitle(
  workflowName: string,
  input: { runDate?: string | null; timezone?: string | null; runLabel?: string | null },
  now = new Date(),
): string {
  const yyyyMmDd = typeof input.runDate === "string" && input.runDate.trim().length > 0
    ? input.runDate.trim()
    : (input.timezone ? formatDateKeyInTimezone(now, input.timezone) : null) ?? now.toISOString().slice(0, 10);
  // [manual run label] 수동 실행 대화상자의 실행명(runLabel)은 미션명에 접미되어 같은 날
  //   같은 워크플로우의 반복 실행을 구분한다. 없음/공백이면 기존 포맷 그대로(스케줄 무변화).
  const runLabel = typeof input.runLabel === "string" ? input.runLabel.trim() : "";
  const base = `${yyyyMmDd} ${workflowName}`;
  if (!runLabel) return base;
  return `${base} — ${runLabel.slice(0, 120)}`;
}

async function ensureMissionForWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
  options?: { deferWorkingNote?: boolean },
): Promise<CreateWorkflowRunInput> {
  if (input.missionId) return input;

  const workflow = await getWorkflowDefinitionById(db, input.workflowId);
  if (!workflow) {
    throw new Error(`Workflow definition not found: ${input.workflowId}`);
  }

  const ownerAgentId = await resolveWorkflowMissionOwnerAgentId(db, input.companyId, workflow);
  const [company] = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const timezone = workflow.timezone ?? company?.timezone ?? null;
  const mission = await missionService(db).create({
    companyId: input.companyId,
    ownerAgentId,
    title: formatWorkflowMissionTitle(workflow.name, { runDate: input.runDate, timezone, runLabel: input.runLabel }),
    description: `Created automatically for workflow run: ${workflow.name}`,
    status: "active",
    source: "workflow",
    // [연결] workflow 정의의 projectId → mission 으로 전파. mission.projectId 가 있어야
    //   heartbeat resolveWorkspaceForRun 이 project_primary workspace 를 주입하고,
    //   step-input-manifest 의 broadScanAllowed 가 켜진다(find . / rg 허용). 없으면 broad scan guard 가
    //   workflow 단계의 정상적인 파일 탐색까지 차단해 첫 단계부터 실패함.
    projectId: workflow.projectId ?? undefined,
  }, options);
  await missionService(db).ensureMainExecutorOversightIssue(mission, workflow.name, {
    workflowStepIds: workflow.steps.map((step) => step.id),
  });

  return { ...input, missionId: mission.id };
}

async function assertNoImplicitDuplicateScheduledWorkflowRun(
  db: Db,
  input: CreateWorkflowRunInput,
  workflow: WorkflowDefinition,
  runDate: string,
): Promise<void> {
  if (input.missionId) return;
  if (typeof workflow.schedule !== "string" || workflow.schedule.trim().length === 0) return;

  const existingScheduledRun = await findActiveScheduledWorkflowMissionRun(db, input, workflow, runDate);
  if (!existingScheduledRun) return;

  throw new Error(
    `Workflow already has an active scheduled workflow mission for ${runDate}: ${existingScheduledRun.id}. `
      + "Finish/cancel the active mission before starting another scheduled run for the same workflow date.",
  );
}

export async function findActiveScheduledWorkflowMissionRun(
  db: Db,
  input: Pick<CreateWorkflowRunInput, "companyId" | "workflowId">,
  workflow: WorkflowDefinition,
  runDate: string,
): Promise<WorkflowRun | null> {
  if (typeof workflow.schedule !== "string" || workflow.schedule.trim().length === 0) return null;

  const existingRuns = await listWorkflowRuns(db, {
    companyId: input.companyId,
    workflowId: input.workflowId,
  });

  for (const run of existingRuns) {
    if (run.runDate !== runDate) continue;
    if (typeof run.missionId !== "string" || run.missionId.trim().length === 0) continue;
    if (run.triggerSource !== "schedule" && typeof run.scheduledSlotId !== "string") continue;

    const mission = await missionService(db).reconcileById(run.missionId);
    if (mission?.status === "active") return run;
  }

  return null;
}

export async function prepareWorkflowTrigger(
  db: Db,
  input: CreateWorkflowRunInput,
  policy: WorkflowRunInputPolicy = {},
  options?: { deferWorkingNote?: boolean },
): Promise<{ run: WorkflowRun; replay: boolean }> {
  assertSeedActor(input, policy.actor);
  const workflow = await getWorkflowDefinitionById(db, input.workflowId);
  if (!workflow) {
    throw new Error(`Workflow definition not found: ${input.workflowId}`);
  }
  if (workflow.companyId !== input.companyId) {
    throw new Error(`Workflow does not belong to company: ${input.workflowId}`);
  }
  await assertRevisionBoardStart(db, input, policy.actor);
  await assertAgentReplacementRequired(db, input, policy.actor);
  if (input.replacementIntent) {
    return admitReplacement(db, input, policy.actor);
  }
  input = { ...input, metadata: normalizeWorkflowRunInputs(workflow.runInputs, input.metadata, policy) };
  await assertWorkflowToolReadinessForSteps(db, { companyId: input.companyId, steps: workflow.steps });
  const [company] = await db
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  const timezone = workflow.timezone ?? company?.timezone ?? null;
  const runDate = input.runDate
    ?? (timezone ? formatDateKeyInTimezone(new Date(), timezone) : null)
    ?? new Date().toISOString().slice(0, 10);
  await assertNoImplicitDuplicateScheduledWorkflowRun(db, input, workflow, runDate);
  const runInput = await ensureMissionForWorkflowRun(db, { ...input, runDate }, options);
  const run = await createAdmittedWorkflowRun(db, runInput, policy.actor);
  await ensureCreatedRunOversight(db, run);
  return { run, replay: false };
}
