import { asTrimmedString, isRecord } from "./utils.js";

const EMPTY_RECORD: Readonly<Record<string, unknown>> = {};
export const RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES = new Set(["active", "idle", "running"]);

export type MissionExecutionAssigneeAgent = {
  readonly name: string;
  readonly adapterType: string;
  readonly runtimeConfig: unknown;
  readonly metadata?: unknown;
};

export function isMissionExecutionLiaisonAgent(agent: MissionExecutionAssigneeAgent): boolean {
  if (agent.adapterType !== "hermes_local") return false;
  const runtimeConfig = isRecord(agent.runtimeConfig) ? agent.runtimeConfig : EMPTY_RECORD;
  const metadata = isRecord(agent.metadata) ? agent.metadata : EMPTY_RECORD;
  const domain = asTrimmedString(runtimeConfig.domain);
  const operatingMode = asTrimmedString(runtimeConfig.operatingMode);
  const purpose = asTrimmedString(metadata.purpose);

  return (
    agent.name === "Hermes Operations Manager" ||
    agent.name === "Hermes Ops Manager" ||
    domain === "operations" ||
    purpose === "research-company-hermes-management" ||
    purpose === "gazua-hermes-management" ||
    operatingMode === "chief_of_staff_liaison" ||
    operatingMode === "independent_management_operator"
  );
}

export function describeMissionExecutionLiaisonBoundary(agent: MissionExecutionAssigneeAgent): string {
  return `${agent.name} is a Hermes operations liaison. It may monitor/report and signal the mission main executor, but it must not directly execute mission ACTION or QA issues.`;
}

export function isRunnableMissionExecutionAssigneeStatus(status: string | null | undefined): boolean {
  return RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES.has(status ?? "");
}
