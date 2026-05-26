import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { missionPlanArtifacts, missions } from "@paperclipai/db";
import { notFound } from "../errors.js";

export type MissionPlanArtifact = typeof missionPlanArtifacts.$inferSelect;
export type MissionPlanArtifactStatus = "draft" | "active" | "replanned" | "completed" | "superseded" | "archived";

export type MissionPlanSelectedExecutionUnitStateCounts = {
  selected: number;
  excluded: number;
  satisfied: number;
  candidate: number;
};

export type MissionPlanSelectedExecutionUnitExecutionStateCounts = {
  blocked: number;
  failed: number;
  cancelled: number;
};

export type MissionPlanRuntimeSummary = {
  available: boolean;
  missionPlanId?: string;
  revision?: number;
  status?: string;
  missionGoal?: string;
  requiredInputsCount?: number;
  openRequiredInputs?: string[];
  successCriteriaCount?: number;
  riskCount?: number;
  stepCount?: number;
  stepSummary?: string[];
  executionUnitCount?: number;
  blockedOrFailedUnitCount?: number;
  selectedExecutionUnitCount?: number;
  selectedExecutionUnitSelectionStateCounts?: MissionPlanSelectedExecutionUnitStateCounts;
  selectedExecutionUnitExecutionStateCounts?: MissionPlanSelectedExecutionUnitExecutionStateCounts;
  selectedExecutionUnitLabels?: string[];
  ruleRefCount?: number;
  ruleNames?: string[];
  ruleModes?: string[];
  refs?: Record<string, unknown>;
};

type MissionPlanExecutionUnitRef = JsonRecord & {
  kind?: string;
  status?: string;
  sourceRef?: JsonRecord & {
    type?: string;
    id?: string;
  };
};

export type MissionPlanExecutionUnitSelection = JsonRecord & {
  id?: string;
  kind?: "workflow_definition_step" | "workflow_run" | "workflow_step_run" | "mission_issue" | "tool_execution_candidate";
  title?: string | null;
  selectionState: "selected" | "excluded" | "satisfied" | "candidate";
  executionState?: "not_materialized" | "materialized" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  reason: string;
  sourceRef: JsonRecord & {
    type: string;
    id: string;
    workflowDefinitionId?: string;
    workflowDefinitionName?: string;
    workflowDefinitionSnapshotAt?: string | null;
    definitionVersionLabel?: string | number | null;
    workflowRunId?: string | null;
    workflowStepRunId?: string | null;
    stepId?: string | null;
    issueId?: string | null;
  };
  dependencyTreatment?: "none" | "selected" | "satisfied_by_prior_artifact" | "explicitly_skipped" | "blocked";
  evidenceRefs?: Array<JsonRecord & {
    type?: string;
    id?: string | null;
    label?: string | null;
  }>;
  materializedRef?: {
    type: "mission_issue" | "workflow_run" | "workflow_step_run" | "tool_execution";
    id: string;
  } | null;
};

export type MissionPlanRefsV2 = JsonRecord & {
  schemaVersion?: 2;
  executionUnits?: MissionPlanExecutionUnitRef[];
  ruleRefs?: JsonRecord[];
};

export type MissionPlanRefsV3 = Omit<MissionPlanRefsV2, "schemaVersion"> & {
  schemaVersion: 3;
  selectedExecutionUnits?: MissionPlanExecutionUnitSelection[];
};

type MissionPlanRefs = MissionPlanRefsV2 | MissionPlanRefsV3;

type JsonRecord = Record<string, unknown>;
type MissionPlanArtifactJsonArray = Array<JsonRecord | string>;

type CreateInitialMissionPlanInput = {
  companyId: string;
  missionId: string;
  ownerAgentId?: string;
  missionGoal?: string;
  refs?: JsonRecord;
  assumptions?: Array<JsonRecord | string>;
  requiredInputs?: MissionPlanArtifactJsonArray;
  successCriteria?: MissionPlanArtifactJsonArray;
  risks?: MissionPlanArtifactJsonArray;
  steps?: MissionPlanArtifactJsonArray;
};

type CreateMissionPlanRevisionInput = CreateInitialMissionPlanInput & {
  status?: MissionPlanArtifactStatus;
};

function truncate(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): MissionPlanArtifactJsonArray {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord | string => typeof item === "string" || (typeof item === "object" && item !== null && !Array.isArray(item))) : [];
}

function asRecordArray(value: unknown): JsonRecord[] {
  return asArray(value).filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item));
}

function itemKey(value: unknown) {
  return typeof value === "object" && value !== null && "key" in value && typeof (value as JsonRecord).key === "string"
    ? ((value as JsonRecord).key as string).trim()
    : null;
}

function itemStatus(value: unknown) {
  return typeof value === "object" && value !== null && "status" in value && typeof (value as JsonRecord).status === "string"
    ? ((value as JsonRecord).status as string).trim()
    : null;
}

function itemTitle(value: unknown) {
  return typeof value === "object" && value !== null && "title" in value && typeof (value as JsonRecord).title === "string"
    ? ((value as JsonRecord).title as string).trim()
    : null;
}

function refsExecutionUnitKey(unit: MissionPlanExecutionUnitRef): string | null {
  const sourceRef = asRecord(unit.sourceRef);
  const type = typeof sourceRef.type === "string" ? sourceRef.type.trim() : "";
  const id = typeof sourceRef.id === "string" ? sourceRef.id.trim() : "";
  if (!type || !id) return null;
  return `${type}:${id}`;
}

const selectedExecutionUnitStates = new Set(["selected", "excluded", "satisfied", "candidate"]);

function hasValidEvidenceRef(value: unknown): boolean {
  const ref = asRecord(value);
  return typeof ref.type === "string" && ref.type.trim().length > 0;
}

export function selectedExecutionUnitKey(unit: MissionPlanExecutionUnitSelection): string | null {
  const id = typeof unit.id === "string" ? unit.id.trim() : "";
  if (id) return id;

  const sourceRef = asRecord(unit.sourceRef);
  const type = typeof sourceRef.type === "string" ? sourceRef.type.trim() : "";
  const sourceId = typeof sourceRef.id === "string" ? sourceRef.id.trim() : "";
  if (!type || !sourceId) return null;

  const stepId = typeof sourceRef.stepId === "string" ? sourceRef.stepId.trim() : "";
  return [type, sourceId, stepId].filter(Boolean).join(":");
}

export function asSelectedExecutionUnits(value: unknown): MissionPlanExecutionUnitSelection[] {
  return asRecordArray(value).filter((unit): unit is MissionPlanExecutionUnitSelection => {
    const sourceRef = asRecord(unit.sourceRef);
    const sourceType = typeof sourceRef.type === "string" ? sourceRef.type.trim() : "";
    const sourceId = typeof sourceRef.id === "string" ? sourceRef.id.trim() : "";
    const selectionState = typeof unit.selectionState === "string" ? unit.selectionState.trim() : "";
    const reason = typeof unit.reason === "string" ? unit.reason.trim() : "";
    if (!sourceType || !sourceId || !selectedExecutionUnitStates.has(selectionState) || !reason) return false;
    if (selectedExecutionUnitKey(unit as MissionPlanExecutionUnitSelection) === null) return false;
    if (unit.dependencyTreatment === "satisfied_by_prior_artifact") {
      return Array.isArray(unit.evidenceRefs) && unit.evidenceRefs.some(hasValidEvidenceRef);
    }
    return true;
  });
}

function ruleRefKey(ruleRef: JsonRecord): string | null {
  const key = typeof ruleRef.key === "string" ? ruleRef.key.trim() : "";
  if (key) return key;
  const source = typeof ruleRef.source === "string" ? ruleRef.source.trim() : "";
  const id = typeof ruleRef.id === "string" ? ruleRef.id.trim() : "";
  if (source && id) return `${source}:${id}`;
  if (id) return id;
  const name = typeof ruleRef.name === "string" ? ruleRef.name.trim() : "";
  return name || null;
}

function asExecutionUnits(value: unknown): MissionPlanExecutionUnitRef[] {
  return asRecordArray(value).filter((unit): unit is MissionPlanExecutionUnitRef => refsExecutionUnitKey(unit as MissionPlanExecutionUnitRef) !== null);
}

export function mergeMissionPlanRefs(existing: unknown, incoming: unknown): MissionPlanRefs {
  const existingRefs = asRecord(existing);
  const incomingRefs = asRecord(incoming);
  const merged: MissionPlanRefs = { ...existingRefs, ...incomingRefs } as MissionPlanRefs;

  const unitsByKey = new Map<string, MissionPlanExecutionUnitRef>();
  for (const unit of [...asExecutionUnits(existingRefs.executionUnits), ...asExecutionUnits(incomingRefs.executionUnits)]) {
    const key = refsExecutionUnitKey(unit);
    if (!key) continue;
    unitsByKey.set(key, unit);
  }

  const executionUnits = Array.from(unitsByKey.values());
  if (executionUnits.length > 0) {
    merged.schemaVersion = 2;
    merged.executionUnits = executionUnits;
  }

  const ruleRefsByKey = new Map<string, JsonRecord>();
  for (const ruleRef of [...asRecordArray(existingRefs.ruleRefs), ...asRecordArray(incomingRefs.ruleRefs)]) {
    const key = ruleRefKey(ruleRef);
    if (!key) continue;
    ruleRefsByKey.set(key, ruleRef);
  }
  const ruleRefs = Array.from(ruleRefsByKey.values());
  if (ruleRefs.length > 0) {
    merged.schemaVersion = 2;
    merged.ruleRefs = ruleRefs;
  }

  const selectedUnitsByKey = new Map<string, MissionPlanExecutionUnitSelection>();
  for (const unit of [
    ...asSelectedExecutionUnits(existingRefs.selectedExecutionUnits),
    ...asSelectedExecutionUnits(incomingRefs.selectedExecutionUnits),
  ]) {
    const key = selectedExecutionUnitKey(unit);
    if (!key) continue;
    selectedUnitsByKey.set(key, unit);
  }
  const selectedExecutionUnits = Array.from(selectedUnitsByKey.values());
  if (selectedExecutionUnits.length > 0) {
    merged.schemaVersion = 3;
    merged.selectedExecutionUnits = selectedExecutionUnits;
  } else {
    delete (merged as JsonRecord).selectedExecutionUnits;
  }

  return merged;
}

function refsRuleRefs(refs: JsonRecord): JsonRecord[] {
  return asRecordArray(refs.ruleRefs);
}

function ruleRefName(ruleRef: JsonRecord): string | null {
  const name = typeof ruleRef.name === "string" ? ruleRef.name.trim() : "";
  if (name) return truncate(name, 80);
  const key = typeof ruleRef.key === "string" ? ruleRef.key.trim() : "";
  if (key) return truncate(key, 80);
  const id = typeof ruleRef.id === "string" ? ruleRef.id.trim() : "";
  return id ? truncate(id, 80) : null;
}

function ruleRefMode(ruleRef: JsonRecord): string | null {
  return typeof ruleRef.mode === "string" && ruleRef.mode.trim().length > 0 ? ruleRef.mode.trim() : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isBlockedOrFailedExecutionUnit(unit: JsonRecord): boolean {
  const status = typeof unit.status === "string" ? unit.status.trim().toLowerCase() : "";
  return ["blocked", "failed", "error", "cancelled", "canceled", "aborted", "timed_out", "timed-out", "timeout"].includes(status);
}

function selectedExecutionUnitLabel(unit: MissionPlanExecutionUnitSelection): string | null {
  const title = typeof unit.title === "string" ? unit.title.trim() : "";
  if (title) return truncate(title, 80);

  const sourceRef = asRecord(unit.sourceRef);
  const workflowName = typeof sourceRef.workflowDefinitionName === "string" ? sourceRef.workflowDefinitionName.trim() : "";
  const stepId = typeof sourceRef.stepId === "string" ? sourceRef.stepId.trim() : "";
  if (workflowName && stepId) return truncate(`${workflowName}:${stepId}`, 80);
  if (workflowName) return truncate(workflowName, 80);

  const type = typeof sourceRef.type === "string" ? sourceRef.type.trim() : "";
  const id = typeof sourceRef.id === "string" ? sourceRef.id.trim() : "";
  if (type && id && stepId) return truncate(`${type}:${id}:${stepId}`, 80);
  if (type && id) return truncate(`${type}:${id}`, 80);
  return null;
}

function selectedExecutionUnitRuntimeSummary(units: MissionPlanExecutionUnitSelection[]) {
  const selectionStateCounts: MissionPlanSelectedExecutionUnitStateCounts = {
    selected: 0,
    excluded: 0,
    satisfied: 0,
    candidate: 0,
  };
  const executionStateCounts: MissionPlanSelectedExecutionUnitExecutionStateCounts = {
    blocked: 0,
    failed: 0,
    cancelled: 0,
  };
  const labels: string[] = [];

  for (const unit of units) {
    selectionStateCounts[unit.selectionState] += 1;
    if (unit.executionState === "blocked") executionStateCounts.blocked += 1;
    if (unit.executionState === "failed") executionStateCounts.failed += 1;
    if (unit.executionState === "cancelled") executionStateCounts.cancelled += 1;

    if ((unit.selectionState === "selected" || unit.selectionState === "candidate") && labels.length < 5) {
      const label = selectedExecutionUnitLabel(unit);
      if (label) labels.push(label);
    }
  }

  return {
    selectedExecutionUnitCount: units.length,
    selectedExecutionUnitSelectionStateCounts: selectionStateCounts,
    selectedExecutionUnitExecutionStateCounts: executionStateCounts,
    selectedExecutionUnitLabels: labels,
  };
}

export function summarizeMissionPlanForRuntime(plan: MissionPlanArtifact | null | undefined): MissionPlanRuntimeSummary {
  if (!plan) return { available: false };

  const requiredInputs = asArray(plan.requiredInputs);
  const steps = asArray(plan.steps);
  const openRequiredInputs = requiredInputs
    .filter((input) => itemStatus(input) !== "received")
    .map(itemKey)
    .filter((value): value is string => Boolean(value))
    .slice(0, 5);
  const stepSummary = steps
    .map(itemTitle)
    .filter((value): value is string => Boolean(value))
    .slice(0, 3)
    .map((title) => truncate(title, 80));
  const refs = asRecord(plan.refs);
  const executionUnits = asExecutionUnits(refs.executionUnits);
  const selectedExecutionUnits = asSelectedExecutionUnits(refs.selectedExecutionUnits);
  const ruleRefs = refsRuleRefs(refs);

  return {
    available: true,
    missionPlanId: plan.id,
    revision: plan.revision,
    status: plan.status,
    missionGoal: truncate(plan.missionGoal, 220),
    requiredInputsCount: requiredInputs.length,
    openRequiredInputs,
    successCriteriaCount: asArray(plan.successCriteria).length,
    riskCount: asArray(plan.risks).length,
    stepCount: steps.length,
    stepSummary,
    executionUnitCount: executionUnits.length,
    blockedOrFailedUnitCount: executionUnits.filter((unit) => isBlockedOrFailedExecutionUnit(unit)).length,
    ...(selectedExecutionUnits.length > 0 ? selectedExecutionUnitRuntimeSummary(selectedExecutionUnits) : {}),
    ruleRefCount: ruleRefs.length,
    ruleNames: uniqueStrings(ruleRefs.map(ruleRefName)).slice(0, 10),
    ruleModes: uniqueStrings(ruleRefs.map(ruleRefMode)).slice(0, 10),
    refs,
  };
}

export function missionPlanArtifactService(db: Db) {
  async function loadMission(companyId: string, missionId: string) {
    const [mission] = await db
      .select()
      .from(missions)
      .where(and(eq(missions.companyId, companyId), eq(missions.id, missionId)))
      .limit(1);
    if (!mission) throw notFound(`Mission not found: ${missionId}`);
    return mission;
  }

  function goalForMission(mission: typeof missions.$inferSelect, explicitGoal?: string) {
    if (explicitGoal?.trim()) return explicitGoal.trim();
    return [mission.title, mission.description].filter(Boolean).join(" — ");
  }

  async function createInitialMissionPlan(input: CreateInitialMissionPlanInput): Promise<MissionPlanArtifact> {
    const mission = await loadMission(input.companyId, input.missionId);
    const [created] = await db
      .insert(missionPlanArtifacts)
      .values({
        companyId: input.companyId,
        missionId: input.missionId,
        revision: 1,
        status: "active",
        ownerAgentId: input.ownerAgentId ?? mission.ownerAgentId,
        missionGoal: goalForMission(mission, input.missionGoal),
        refs: input.refs ?? {},
        assumptions: input.assumptions ?? [],
        requiredInputs: input.requiredInputs ?? [],
        successCriteria: input.successCriteria ?? [],
        risks: input.risks ?? [],
        steps: input.steps ?? [],
      })
      .returning();
    return created;
  }

  async function getActiveMissionPlan(input: { companyId: string; missionId: string }): Promise<MissionPlanArtifact | null> {
    const [plan] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(and(
        eq(missionPlanArtifacts.companyId, input.companyId),
        eq(missionPlanArtifacts.missionId, input.missionId),
        eq(missionPlanArtifacts.status, "active"),
      ))
      .orderBy(desc(missionPlanArtifacts.revision), desc(missionPlanArtifacts.updatedAt))
      .limit(1);
    return plan ?? null;
  }

  async function createMissionPlanRevision(input: CreateMissionPlanRevisionInput): Promise<MissionPlanArtifact> {
    return db.transaction(async (tx) => {
      const [mission] = await tx
        .select()
        .from(missions)
        .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
        .limit(1);
      if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

      const [latest] = await tx
        .select()
        .from(missionPlanArtifacts)
        .where(and(eq(missionPlanArtifacts.companyId, input.companyId), eq(missionPlanArtifacts.missionId, input.missionId)))
        .orderBy(desc(missionPlanArtifacts.revision))
        .limit(1);

      await tx
        .update(missionPlanArtifacts)
        .set({ status: "superseded", updatedAt: new Date() })
        .where(and(
          eq(missionPlanArtifacts.companyId, input.companyId),
          eq(missionPlanArtifacts.missionId, input.missionId),
          eq(missionPlanArtifacts.status, "active"),
        ));

      const [created] = await tx
        .insert(missionPlanArtifacts)
        .values({
          companyId: input.companyId,
          missionId: input.missionId,
          revision: (latest?.revision ?? 0) + 1,
          status: input.status ?? "active",
          ownerAgentId: input.ownerAgentId ?? mission.ownerAgentId,
          missionGoal: goalForMission(mission, input.missionGoal ?? latest?.missionGoal),
          refs: input.refs ?? asRecord(latest?.refs),
          assumptions: input.assumptions ?? asArray(latest?.assumptions),
          requiredInputs: input.requiredInputs ?? asArray(latest?.requiredInputs),
          successCriteria: input.successCriteria ?? asArray(latest?.successCriteria),
          risks: input.risks ?? asArray(latest?.risks),
          steps: input.steps ?? asArray(latest?.steps),
        })
        .returning();
      return created;
    });
  }

  return {
    createInitialMissionPlan,
    getActiveMissionPlan,
    createMissionPlanRevision,
    summarizeMissionPlanForRuntime,
    // Internal hook used by the transactional revision path without exporting a second service type.
    loadMissionForRevision: loadMission,
  };
}
