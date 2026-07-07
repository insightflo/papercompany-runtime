import { asTrimmedString, isRecord } from "./utils.js";

const EMPTY_RECORD: Readonly<Record<string, unknown>> = {};
export const RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES = new Set(["active", "idle", "running"]);

export type MissionExecutionAssigneeAgent = {
  readonly name: string;
  readonly adapterType: string;
  readonly runtimeConfig: unknown;
  readonly metadata?: unknown;
};

// [P3] Hermes Ops liaison 권한 모드. 기본 advisor(read-only) — 최소 권한 원칙.
//   supervision/relay/admin은 runtimeConfig.hermesOpsMode로 명시 설정했을 때만(hermes-ops-mutation-guard가 소비).
export type HermesOpsMode = "advisor" | "supervision" | "relay" | "admin";

export function isMissionExecutionLiaisonAgent(agent: MissionExecutionAssigneeAgent): boolean {
  if (agent.adapterType !== "hermes_local") return false;
  const runtimeConfig = isRecord(agent.runtimeConfig) ? agent.runtimeConfig : EMPTY_RECORD;
  const metadata = isRecord(agent.metadata) ? agent.metadata : EMPTY_RECORD;
  const domain = asTrimmedString(runtimeConfig.domain);
  const operatingMode = asTrimmedString(runtimeConfig.operatingMode);
  const purpose = asTrimmedString(metadata.purpose);

  // [P3] 신뢰 가능한 신호(explicit flag / mode)를 먼저 보고, 이름은 legacy fallback으로만 둔다.
  //   이름 기반 단독 판정은 fragile(잘못 named agent, rename 시 누락/과잉 매칭).
  const hasExplicitLiaisonFlag =
    runtimeConfig.operationsLiaison === true || typeof runtimeConfig.hermesOpsMode === "string";

  return (
    hasExplicitLiaisonFlag ||
    domain === "operations" ||
    operatingMode === "chief_of_staff_liaison" ||
    operatingMode === "independent_management_operator" ||
    purpose === "research-company-hermes-management" ||
    purpose === "gazua-hermes-management" ||
    agent.name === "Hermes Operations Manager" ||
    agent.name === "Hermes Ops Manager"
  );
}

// [P3] liaison 모드 결정. runtimeConfig.hermesOpsMode가 명시값이면 그것, 아니면 advisor(최소 권한).
export function resolveHermesOpsMode(agent: MissionExecutionAssigneeAgent): HermesOpsMode {
  const runtimeConfig = isRecord(agent.runtimeConfig) ? agent.runtimeConfig : EMPTY_RECORD;
  const raw = typeof runtimeConfig.hermesOpsMode === "string" ? runtimeConfig.hermesOpsMode : "";
  if (raw === "supervision" || raw === "relay" || raw === "admin") return raw;
  return "advisor";
}

// [P3] auth.ts가 authn 시 한 번 호출 — isHermesOpsLiaison + hermesOpsMode를 req.actor에 부착.
//   predicate를 두 번 부르지 않도록 identity를 한 번에 산출한다.
export function resolveHermesOpsLiaisonIdentity(
  agent: MissionExecutionAssigneeAgent,
): { isHermesOpsLiaison: boolean; hermesOpsMode?: HermesOpsMode } {
  if (!isMissionExecutionLiaisonAgent(agent)) {
    return { isHermesOpsLiaison: false };
  }
  return { isHermesOpsLiaison: true, hermesOpsMode: resolveHermesOpsMode(agent) };
}

export function describeMissionExecutionLiaisonBoundary(agent: MissionExecutionAssigneeAgent): string {
  return `${agent.name} is a Hermes operations liaison. It may monitor/report and signal the mission main executor, but it must not directly execute mission ACTION or QA issues.`;
}

export function isRunnableMissionExecutionAssigneeStatus(status: string | null | undefined): boolean {
  return RUNNABLE_MISSION_EXECUTION_ASSIGNEE_STATUSES.has(status ?? "");
}
