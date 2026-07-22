import type { WorkflowStep } from "../workflow/dag-engine.js";
import type {
  MissionSupervisionIssue,
  MissionSupervisionWorkflowStepRow,
} from "./mission-supervision-context.js";
import { isQaLikeStep } from "./supervision-helpers.js";

export function selectTerminalWorkflowAuthoritySource(input: {
  missionIssues: MissionSupervisionIssue[];
  missionIssueById: ReadonlyMap<string, MissionSupervisionIssue>;
  workflowStepRows: MissionSupervisionWorkflowStepRow[];
}): MissionSupervisionIssue | null {
  const steps = Array.isArray(input.workflowStepRows[0]?.definition.stepsJson)
    ? input.workflowStepRows[0]!.definition.stepsJson as WorkflowStep[]
    : [];
  const sourceCandidates = input.workflowStepRows
    .filter((row) => row.stepRun.status === "failed" && row.stepRun.issueId)
    .map((row) => ({
      issue: input.missionIssueById.get(row.stepRun.issueId!) ?? null,
      qaLike: isQaLikeStep(
        steps.find((step) => step.id === row.stepRun.stepId)
          ?? { id: row.stepRun.stepId, name: row.stepRun.stepId },
      ),
    }))
    .filter((candidate): candidate is { issue: MissionSupervisionIssue; qaLike: boolean } =>
      Boolean(candidate.issue))
    .sort((left, right) =>
      Number(right.qaLike) - Number(left.qaLike)
        || left.issue.id.localeCompare(right.issue.id));
  const missionAuthoritySource = input.missionIssues
    .filter((issue) =>
      !issue.hiddenAt
      && (
        issue.originKind === "mission_main_executor_oversight"
        || issue.originKind === "mission_main_executor_plan"
      ))
    .sort((left, right) => {
      const authorityRank = (issue: MissionSupervisionIssue) =>
        issue.originKind === "mission_main_executor_oversight" ? 0 : 1;
      return authorityRank(left) - authorityRank(right) || left.id.localeCompare(right.id);
    })[0] ?? null;
  return sourceCandidates[0]?.issue ?? input.workflowStepRows
    .map((row) => row.stepRun.issueId
      ? input.missionIssueById.get(row.stepRun.issueId) ?? null
      : null)
    .find((issue): issue is MissionSupervisionIssue => Boolean(issue))
    ?? missionAuthoritySource;
}
