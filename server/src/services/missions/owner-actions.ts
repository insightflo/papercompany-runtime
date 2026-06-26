// server/src/services/missions/owner-actions.ts
//
// [파일 목적] mission owner action 클로저들을 factory로 캡슐화 (P2).
//   db/deps 명시 주입 → 클로저 공유 대체. missions.ts(missionService)가 호출.
// [수정시 주의] 부작용 있음(이슈 생성/갱신/wakeup). 순수 아님.
import { agents, issueComments, issues, missionPlanArtifacts, missions, pluginEntities, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { mergeMissionPlanRefs, missionPlanArtifactService } from "../mission-plan-artifacts.js";
import type { MissionRow, MissionStatus } from "../missions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { buildMainExecutorBrief, buildMissionOwnerUnblockDescription, buildValidatorRetryEvidenceComment, extractLatestMissionOwnerDecision, isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import { buildMissionExecutionDigest } from "./mission-execution-digest.js";
import { buildMissionRuleContext } from "./mission-rule-context.js";
import { listMissionExecutionSourceSnapshots } from "./mission-execution-sources.js";
import { pruneStaleWorkflowExecutionUnits, type PluginWorkflowRunData, type PluginWorkflowStepRunData } from "./plugin-workflow.js";
import { classifyToolStepFailure, getWorkflowStepToolNames, type ToolStepFailureClassification } from "./tool-step-failure.js";
import { asTrimmedString } from "./utils.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { isTerminalMissionStatus } from "./shared-types.js";
import type { MissionServiceDeps } from "../missions.js";

export function createOwnerActions({ db, deps }: { db: Db; deps: MissionServiceDeps }) {

  const activeWorkflowRunStatuses = new Set(["pending", "queued", "running", "in_progress"]);
  const recoverableFailedWorkflowRunStatuses = new Set(["failed", "error"]);
  const cancelledWorkflowRunStatuses = new Set(["aborted", "cancelled", "canceled"]);
  const completedWorkflowRunStatuses = new Set(["completed", "succeeded", "done"]);
  const legacyWorkflowMissionGraceMs = 5 * 60 * 1000;

  function isMissionOwnerActionParentPlacementRejected(error: unknown) {
    return error instanceof HttpError &&
      error.status === 422 &&
      (
        error.message.includes("Mission downstream issue creation is not allowed") ||
        error.message.includes("Mission nested child issue creation is not allowed") ||
        error.message.includes("Mission child issue burst limit exceeded")
      );
  }

  async function createMissionOwnerActionIssue(companyId: string, data: IssueCreateInput) {
    if (!data.parentId) return issueService(db).create(companyId, data);
    try {
      return await issueService(db).create(companyId, data);
    } catch (error) {
      if (!isMissionOwnerActionParentPlacementRejected(error)) throw error;
      const { parentId: _parentId, ...flatData } = data;
      logger.warn({
        err: error,
        companyId,
        missionId: data.missionId,
        originKind: data.originKind,
        originId: data.originId,
        rejectedParentId: data.parentId,
      }, "mission owner action parent placement rejected; creating flat owner action with origin link");
      return issueService(db).create(companyId, flatData);
    }
  }

  async function reconcileMissionStatusFromWorkflowRuns(mission: MissionRow): Promise<MissionRow> {
    if (mission.status === "cancelled") return mission;

    const isWorkflowCreatedMission = mission.description?.startsWith("Created automatically for workflow run:") ?? false;
    const canReconcileTerminalWorkflowMission =
      isWorkflowCreatedMission && mission.status === "completed";
    const canCloseCompletedMissionOversight = mission.status === "completed";
    const canPromoteStartedPlanningMission = mission.status === "planning";
    if (
      mission.status !== "active" &&
      !canReconcileTerminalWorkflowMission &&
      !canPromoteStartedPlanningMission &&
      !canCloseCompletedMissionOversight
    ) return mission;

    const linkedRuns: Array<{ status: string; createdAt: Date | null; startedAt: Date | null; completedAt: Date | null }> = [];
    const nativeRuns = await db
      .select({
        status: workflowRuns.status,
        createdAt: workflowRuns.createdAt,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.missionId, mission.id));
    for (const run of nativeRuns) {
      linkedRuns.push({
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      });
    }

    if (linkedRuns.length === 0) {
      if (mission.status === "completed") {
        await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
      }
      if (
        isWorkflowCreatedMission &&
        mission.status === "active" &&
        mission.startedAt &&
        Date.now() - mission.startedAt.getTime() > legacyWorkflowMissionGraceMs
      ) {
        const legacyPluginRun = await db
          .select({ id: pluginEntities.id, updatedAt: pluginEntities.updatedAt })
          .from(pluginEntities)
          .where(and(
            eq(pluginEntities.entityType, "workflow-run"),
            eq(pluginEntities.scopeKind, "company"),
            eq(pluginEntities.scopeId, mission.companyId),
            sql`${pluginEntities.data} ->> 'missionId' = ${mission.id}`,
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (legacyPluginRun) {
          const openWork = await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(
              eq(issues.missionId, mission.id),
              isNull(issues.hiddenAt),
              sql`${issues.status} not in ('done', 'cancelled')`,
              sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!openWork) {
            const completedAt = legacyPluginRun.updatedAt ?? new Date();
            const updates: Partial<MissionRow> = {
              status: "cancelled",
              completedAt,
              updatedAt: new Date(),
            };
            await db.update(missions).set(updates).where(eq(missions.id, mission.id));
            await db
              .update(issues)
              .set({ status: "cancelled", cancelledAt: completedAt, updatedAt: new Date() })
              .where(and(
                eq(issues.missionId, mission.id),
                isNull(issues.hiddenAt),
                sql`${issues.status} not in ('done', 'cancelled')`,
              ));
            return { ...mission, ...updates };
          }
        }
      }
      return mission;
    }

    const normalizedStatuses = linkedRuns.map((run) => run.status.trim().toLowerCase()).filter(Boolean);
    const startedAt = mission.startedAt ?? linkedRuns
      .map((run) => run.startedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? new Date();
    if (normalizedStatuses.some((status) => activeWorkflowRunStatuses.has(status))) {
      if (mission.status === "completed") return mission;
      if (mission.status === "active" && mission.completedAt === null && mission.startedAt !== null) return mission;
      const updates: Partial<MissionRow> = {
        status: "active",
        startedAt,
        completedAt: null,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));
      return {
        ...mission,
        ...updates,
      };
    }

    const latestRun = [...linkedRuns].sort((left, right) => {
      const leftTime = (left.createdAt ?? left.startedAt ?? left.completedAt)?.getTime() ?? 0;
      const rightTime = (right.createdAt ?? right.startedAt ?? right.completedAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    })[0] ?? null;
    const latestStatus = latestRun?.status.trim().toLowerCase() ?? null;
    if (latestStatus && (completedWorkflowRunStatuses.has(latestStatus) || cancelledWorkflowRunStatuses.has(latestStatus))) {
      if (mission.status === "planning") return mission;
      if (mission.status === "completed" && !canReconcileTerminalWorkflowMission) {
        if (completedWorkflowRunStatuses.has(latestStatus)) {
          await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
        }
        return mission;
      }

      const nextStatus: MissionStatus = cancelledWorkflowRunStatuses.has(latestStatus) ? "cancelled" : "completed";
      const completedAt = latestRun.completedAt ?? latestRun.startedAt ?? latestRun.createdAt ?? new Date();
      const updates: Partial<MissionRow> = {
        status: nextStatus,
        completedAt,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));

      const updatedMission = {
        ...mission,
        ...updates,
      };
      if (nextStatus === "completed") {
        await completeOpenMissionOversightIfSettled(updatedMission, completedAt);
      }
      return updatedMission;
    }

    if (normalizedStatuses.some((status) => recoverableFailedWorkflowRunStatuses.has(status))) {
      if (mission.status === "completed" && !canReconcileTerminalWorkflowMission) return mission;
      if (mission.status === "active" && mission.completedAt === null && mission.startedAt !== null) return mission;
      const updates: Partial<MissionRow> = {
        status: "active",
        startedAt,
        completedAt: null,
        updatedAt: new Date(),
      };
      await db.update(missions).set(updates).where(eq(missions.id, mission.id));
      return {
        ...mission,
        ...updates,
      };
    }
    if (normalizedStatuses.some((status) => !cancelledWorkflowRunStatuses.has(status) && !completedWorkflowRunStatuses.has(status))) {
      return mission;
    }
    if (mission.status === "planning") return mission;
    if (mission.status === "completed" && !canReconcileTerminalWorkflowMission) {
      if (normalizedStatuses.every((status) => completedWorkflowRunStatuses.has(status))) {
        await completeOpenMissionOversightIfSettled(mission, mission.completedAt ?? new Date());
      }
      return mission;
    }

    const nextStatus: MissionStatus = normalizedStatuses.some((status) => cancelledWorkflowRunStatuses.has(status))
      ? "cancelled"
      : "completed";
    const completedAt = linkedRuns
      .map((run) => run.completedAt)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? new Date();

    const updates: Partial<MissionRow> = {
      status: nextStatus,
      completedAt,
      updatedAt: new Date(),
    };
    await db.update(missions).set(updates).where(eq(missions.id, mission.id));

    const updatedMission = {
      ...mission,
      ...updates,
    };
    if (nextStatus === "completed") {
      await completeOpenMissionOversightIfSettled(updatedMission, completedAt);
    }
    return updatedMission;
  }

  async function completeOpenMissionOversightIfSettled(mission: MissionRow, completedAt: Date): Promise<void> {
    if (mission.status !== "completed") return;

    const openWork = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.missionId, mission.id),
        isNull(issues.hiddenAt),
        sql`${issues.status} not in ('done', 'cancelled')`,
        sql`${issues.originKind} <> 'mission_main_executor_oversight'`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (openWork) return;

    const now = new Date();
    await db
      .update(issues)
      .set({
        status: "done",
        completedAt,
        updatedAt: now,
      })
      .where(and(
        eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_oversight"),
        isNull(issues.hiddenAt),
        sql`${issues.status} not in ('done', 'cancelled')`,
      ));
  }

  async function collectWorkflowIssueIdsForMission(mission: MissionRow): Promise<string[]> {
    const issueIds = new Set<string>();

    const nativeRuns = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, mission.companyId), eq(workflowRuns.missionId, mission.id)));
    if (nativeRuns.length > 0) {
      const nativeStepRuns = await db
        .select({ issueId: workflowStepRuns.issueId })
        .from(workflowStepRuns)
        .where(inArray(workflowStepRuns.workflowRunId, nativeRuns.map((run) => run.id)));
      for (const stepRun of nativeStepRuns) {
        if (stepRun.issueId) issueIds.add(stepRun.issueId);
      }
    }

    const pluginRunEntities = await db
      .select()
      .from(pluginEntities)
      .where(and(
        eq(pluginEntities.entityType, "workflow-run"),
        eq(pluginEntities.scopeKind, "company"),
        eq(pluginEntities.scopeId, mission.companyId),
      ));
    const pluginRunIds = pluginRunEntities
      .filter((entity) => {
        const data = entity.data as PluginWorkflowRunData;
        return data.companyId === mission.companyId && data.missionId === mission.id;
      })
      .map((entity) => entity.id);

    if (pluginRunIds.length > 0) {
      const pluginStepRunEntities = await db
        .select()
        .from(pluginEntities)
        .where(and(
          eq(pluginEntities.entityType, "workflow-step-run"),
          eq(pluginEntities.scopeKind, "company"),
          eq(pluginEntities.scopeId, mission.companyId),
        ));
      for (const entity of pluginStepRunEntities) {
        const data = entity.data as PluginWorkflowStepRunData;
        const runId = asTrimmedString(data.runId);
        const issueId = asTrimmedString(data.issueId);
        if (runId && issueId && pluginRunIds.includes(runId)) issueIds.add(issueId);
      }
    }

    return [...issueIds];
  }

  async function collectIssueIdsWithAncestors(companyId: string, seedIssueIds: string[]): Promise<string[]> {
    const result = new Set<string>();
    const visited = new Set<string>();
    let frontier = [...new Set(seedIssueIds)];

    while (frontier.length > 0) {
      const current = frontier.filter((id) => !visited.has(id));
      if (current.length === 0) break;
      for (const id of current) visited.add(id);

      const rows = await db
        .select({ id: issues.id, parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, current)));

      const next: string[] = [];
      for (const row of rows) {
        result.add(row.id);
        if (row.parentId && !visited.has(row.parentId)) next.push(row.parentId);
      }
      frontier = next;
    }

    return [...result];
  }

  async function ensureWorkflowIssuesLinkedToMission(mission: MissionRow): Promise<void> {
    const workflowIssueIds = await collectWorkflowIssueIdsForMission(mission);
    if (workflowIssueIds.length === 0) return;

    const issueIdsWithAncestors = await collectIssueIdsWithAncestors(mission.companyId, workflowIssueIds);
    if (issueIdsWithAncestors.length === 0) return;

    await db
      .update(issues)
      .set({ missionId: mission.id, updatedAt: new Date() })
      .where(and(eq(issues.companyId, mission.companyId), inArray(issues.id, issueIdsWithAncestors)));
  }

  async function findMainExecutorIssue(missionId: string, originKind: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.missionId, missionId), eq(issues.originKind, originKind)))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMainExecutorPlanningIssue(mission: MissionRow) {
    const existing = await findMainExecutorIssue(mission.id, "mission_main_executor_plan");
    if (existing) return existing;
    const companyAgents = await db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, mission.companyId))
      .orderBy(asc(agents.name), asc(agents.id));
    const runnableRosterLines = companyAgents
      .filter((agent) => agent.status === "active" || agent.status === "idle")
      .map((agent) => (
        `- ${agent.name} (${agent.role}, ${agent.status}) id=${agent.id}${agent.id === mission.ownerAgentId ? " [mission owner]" : ""}`
      ));

    return issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: [
        "Plan the mission before execution begins, then close this issue when the mission-level work structure is materialized.",
        "",
        `Mission: ${mission.title}`,
        mission.description ? `Brief: ${mission.description}` : null,
        "",
        "Expected output:",
        "- Do not create mission-level `[ACTION]`, `[QA]`, or `[OVERSIGHT]` issues directly from this PLAN issue.",
        "- Post exactly one structured `### Mission owner plan decision` JSON comment; the server materializes the selected work through the server-native DAG.",
        "- In `selectedExecutionUnits`, define execution work units with explicit `assigneeAgentId` values from the Available runnable company roster below.",
        "- Do not invent or reuse assignee ids that are not listed in the Available runnable company roster.",
        "- Agents with status `paused`, `running`, `error`, `pending_approval`, or `terminated` are intentionally omitted and are not runnable execution assignees.",
        "- Use source/research units for researcher/scout agents, synthesis/report units for synthesis/editor agents, QA units for validator/QA agents, and oversight/recovery for the mission owner.",
        "- Set `graphWorkProductRequired: true` on ACTION units that must create official deliverables; QA units should normally set `graphWorkProductRequired: false` and validate dependency workProducts.",
        "- Express execution order with `dependsOn` arrays on each non-root `selectedExecutionUnits` entry; root units must use `dependsOn: []`.",
        "- Use `dependsOn` values that exactly match upstream selected unit `id` or `sourceRef.id` values. The `steps` array is only human-readable phase notes and must not be the only place dependencies appear.",
        "- Do not rely on loose issue creation order, phase text, or assignee wakeups for ordering.",
        "- Identify blockers and approval needs early.",
        "- Do not perform ACTION/QA work from this PLAN issue; define the DAG structure, then mark this PLAN issue done after the structured decision is posted.",
        "",
        "Required decision comment shape:",
        "### Mission owner plan decision",
        "```json",
        JSON.stringify({
          missionId: mission.id,
          missionGoal: "Restate the mission goal",
          selectedExecutionUnits: [{
            id: "unit-source-1",
            kind: "mission_plan_unit",
            title: "Concrete ACTION title",
            assigneeAgentId: "agent-id-from-roster",
            selectionState: "selected",
            reason: "Why this work unit is required",
            sourceRef: { type: "mission_plan_unit", id: "unit-source-1" },
            dependsOn: [],
            graphWorkProductRequired: true,
          }, {
            id: "unit-synthesis-1",
            kind: "mission_plan_unit",
            title: "Concrete synthesis ACTION title",
            assigneeAgentId: "agent-id-from-roster",
            selectionState: "selected",
            reason: "Why this synthesis unit is required",
            sourceRef: { type: "mission_plan_unit", id: "unit-synthesis-1" },
            dependsOn: ["unit-source-1"],
            graphWorkProductRequired: true,
          }, {
            id: "unit-qa-1",
            kind: "mission_plan_unit",
            title: "[QA] Concrete validation title",
            assigneeAgentId: "agent-id-from-roster",
            selectionState: "selected",
            reason: "Why this validation unit is required",
            sourceRef: { type: "mission_plan_unit", id: "unit-qa-1" },
            dependsOn: ["unit-synthesis-1"],
            graphWorkProductRequired: false,
          }],
          requiredInputs: [],
          successCriteria: [],
          steps: [],
        }, null, 2),
        "```",
        "",
        "Available runnable company roster:",
        ...runnableRosterLines,
      ].filter(Boolean).join("\n"),
      missionId: mission.id,
      originKind: "mission_main_executor_plan",
      priority: "medium",
      status: "todo",
      title: `[PLAN] ${mission.title}`,
    });
  }

  async function ensureWorkflowMissionPlanArtifact(
    mission: MissionRow,
    oversightIssue: typeof issues.$inferSelect,
    workflowName: string,
    metadata: { workflowStepIds?: string[]; sourceRunId?: string; executionUnits?: Array<Record<string, unknown>> } = {},
  ): Promise<void> {
    const executionUnits = metadata.executionUnits ?? [
      ...(metadata.sourceRunId ? [{
        kind: "native_workflow_run",
        title: workflowName,
        status: "running",
        sourceRef: { type: "native_workflow_run", id: metadata.sourceRunId },
      }] : []),
      ...(metadata.workflowStepIds ?? []).map((stepId) => ({
        kind: "native_workflow_step_run",
        title: stepId,
        status: "pending",
        sourceRef: {
          type: "native_workflow_step_run",
          id: stepId,
          ...(metadata.sourceRunId ? { workflowRunId: metadata.sourceRunId } : {}),
        },
      })),
    ];
    const missionRuleContext = await buildMissionRuleContext(db, { companyId: mission.companyId });
    const refs = mergeMissionPlanRefs({}, {
      oversightIssueId: oversightIssue.id,
      workflowName,
      ...(metadata.workflowStepIds ? { workflowStepIds: metadata.workflowStepIds } : {}),
      ...(metadata.sourceRunId ? { sourceRunId: metadata.sourceRunId } : {}),
      ...(executionUnits.length > 0 ? { executionUnits } : {}),
      ...(missionRuleContext.ruleRefs.length > 0 ? { ruleRefs: missionRuleContext.ruleRefs } : {}),
    });
    const planSvc = missionPlanArtifactService(db);
    const activePlan = await planSvc.getActiveMissionPlan({ companyId: mission.companyId, missionId: mission.id });
    if (activePlan) {
      const currentRefs = typeof activePlan.refs === "object" && activePlan.refs !== null && !Array.isArray(activePlan.refs)
        ? activePlan.refs as Record<string, unknown>
        : {};
      const baseRefs = pruneStaleWorkflowExecutionUnits(currentRefs, workflowName, metadata.sourceRunId);
      const mergedRefs = mergeMissionPlanRefs(baseRefs, refs);
      const changed = JSON.stringify(currentRefs) !== JSON.stringify(mergedRefs);
      if (changed) {
        await db
          .update(missionPlanArtifacts)
          .set({ refs: mergedRefs, updatedAt: new Date() })
          .where(eq(missionPlanArtifacts.id, activePlan.id));
      }
      return;
    }

    await planSvc.createInitialMissionPlan({
      companyId: mission.companyId,
      missionId: mission.id,
      refs,
      assumptions: [
        "Workflow-created mission: the main executor owns supervision, diagnosis, recovery/replan, and escalation rather than only executing a single step.",
      ],
      requiredInputs: [
        { key: "workflow-step-state", status: "tracked", source: "workflow_runs/workflow_step_runs/issues" },
        { key: "owner-judgement", status: "ongoing", source: "mission_main_executor_oversight" },
      ],
      successCriteria: [
        { description: "All workflow steps are completed or explicitly diagnosed as blocked/impossible with evidence." },
        { description: "The main executor oversight issue records the current judgement, recovery/replan, or escalation path." },
      ],
      risks: [
        { description: "Step dispatch omission or stale unstarted work can leave the mission active without owner-visible diagnosis.", category: "dispatch_gap", severity: "observe" },
      ],
      steps: [
        { id: "supervise", title: "Supervise workflow step progress and detect stale/blocked/failing work", status: "ongoing", intendedRole: "mission_owner" },
        { id: "diagnose", title: "Diagnose failures or dispatch omissions with evidence", status: "planned", intendedRole: "mission_owner" },
        { id: "recover-or-escalate", title: "Recover, replan, or report impossible completion", status: "planned", intendedRole: "mission_owner" },
      ],
    });
  }

  async function ensureMainExecutorUnblockIssue(
    mission: MissionRow,
    blockedIssue: typeof issues.$inferSelect,
    options: { renewAfterNoActionWaiting?: boolean; governanceEvidence?: string[] } = {},
  ): Promise<typeof issues.$inferSelect> {
    const existingRows = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, mission.companyId),
        eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, blockedIssue.id),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id));
    for (const existing of existingRows) {
      if (options.renewAfterNoActionWaiting && isTerminalIssueStatus(existing.status)) {
        const existingComments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, existing.id))
          .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
        const latestDecision = extractLatestMissionOwnerDecision(existingComments.map((comment) => comment.body));
        if (latestDecision?.decision === "no_action_waiting") continue;
      }
      return existing;
    }

    const blockedLabel = blockedIssue.identifier ?? blockedIssue.id;
    let missionExecutionDigest: string[] = [];
    try {
      missionExecutionDigest = await buildMissionExecutionDigest(db, { mission, blockedIssue });
    } catch (error) {
      logger.warn({ err: error, missionId: mission.id, blockedIssueId: blockedIssue.id }, "Failed to build mission execution digest for owner unblock issue");
      missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
    }
    const unblockParentId = blockedIssue.parentId ? undefined : blockedIssue.id;
    const unblockIssue = await createMissionOwnerActionIssue(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: buildMissionOwnerUnblockDescription(mission, blockedIssue, {
        governanceEvidence: options.governanceEvidence,
        missionExecutionDigest,
      }),
      missionId: mission.id,
      originKind: "mission_main_executor_unblock",
      originId: blockedIssue.id,
      parentId: unblockParentId,
      priority: "high",
      status: "todo",
      title: `[Unblock] ${blockedLabel}: ${blockedIssue.title}`,
    });

    if (deps.onOwnerActionCreated) {
      void Promise.resolve(deps.onOwnerActionCreated({
        mission,
        issue: unblockIssue,
        sourceIssue: blockedIssue,
        reason: "mission_unblock_action_created",
      })).catch((err) => {
        logger.warn({ err, missionId: mission.id, issueId: unblockIssue.id }, "failed to notify owner about mission unblock action");
      });
    }

    return unblockIssue;
  }

  async function ensureToolStepFailureRecoveryIssue(input: {
    mission: MissionRow;
    oversightIssue: IssueRow;
    run: typeof workflowRuns.$inferSelect;
    stepRun: typeof workflowStepRuns.$inferSelect;
    step: WorkflowStep | null;
    workflowName: string;
  }): Promise<{ issue: IssueRow; created: boolean; classification: ToolStepFailureClassification; toolNames: string[] }> {
    const marker = `tool-step-recovery:${input.run.id}:${input.stepRun.stepId}`;
    const existingRows = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, input.mission.companyId),
        eq(issues.missionId, input.mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"),
        eq(issues.originId, input.oversightIssue.id),
        isNull(issues.hiddenAt),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id));
    const existing = existingRows.find((issue) => (issue.description ?? "").includes(marker));
    const classification = classifyToolStepFailure(input.step, input.stepRun);
    const toolNames = getWorkflowStepToolNames(input.step);
    if (existing) {
      return { issue: existing, created: false, classification, toolNames };
    }

    const displayStepName = input.step?.name?.trim() || input.stepRun.stepId;
    const toolNamesLabel = toolNames.length > 0 ? toolNames.join(", ") : "(not recorded)";
    const recoveryParentId = input.oversightIssue.parentId ? undefined : input.oversightIssue.id;
    const recoveryIssue = await createMissionOwnerActionIssue(input.mission.companyId, {
      assigneeAgentId: input.mission.ownerAgentId,
      description: [
        `<!-- ${marker} -->`,
        "Mission-owner signal. A tool workflow step failed without a linked execution issue. Automation has not selected a recovery action.",
        "",
        `Mission: ${input.mission.title}`,
        `Workflow: ${input.workflowName}`,
        `Workflow run: ${input.run.id}`,
        `Step: ${input.stepRun.stepId} (${displayStepName})`,
        `Tool names: ${toolNamesLabel}`,
        `Local signal hint: ${classification.className}`,
        `Local retry hint: ${classification.retryPolicy}`,
        `Hint rationale: ${classification.rationale}`,
        "",
        "Raw evidence:",
        ...(classification.evidence.length > 0 ? classification.evidence.map((line) => `- ${line}`) : ["- No runtime stderr/stdout/error evidence was captured on the workflow step run."]),
        "",
        buildMainExecutorBrief({
          missionGoal: input.mission.title,
          currentSituation: `Workflow ${input.workflowName} run ${input.run.id} has failed tool step ${input.stepRun.stepId}; no linked execution issue owns the failure.`,
        }),
        "",
        "No recovery action has been selected by automation.",
      ].join("\n"),
      missionId: input.mission.id,
      originKind: "mission_main_executor_unblock",
      originId: input.oversightIssue.id,
      parentId: recoveryParentId,
      priority: "high",
      status: "todo",
      title: `[Owner Action] Tool step failed: ${input.stepRun.stepId}`,
    });

    if (deps.onOwnerActionCreated) {
      void Promise.resolve(deps.onOwnerActionCreated({
        mission: input.mission,
        issue: recoveryIssue,
        sourceIssue: input.oversightIssue,
        reason: "tool_step_failure_recovery_created",
      })).catch((err) => {
        logger.warn({ err, missionId: input.mission.id, issueId: recoveryIssue.id }, "failed to notify owner about tool step recovery action");
      });
    }

    return { issue: recoveryIssue, created: true, classification, toolNames };
  }

  async function ensureMainExecutorOversightIssue(
    mission: MissionRow,
    workflowName: string,
    metadata: { workflowStepIds?: string[]; sourceRunId?: string; executionUnits?: Array<Record<string, unknown>> } = {},
  ): Promise<typeof issues.$inferSelect> {
    const existing = await findMainExecutorIssue(mission.id, "mission_main_executor_oversight");
    if (existing) {
      const nextTitle = `[OVERSIGHT] ${workflowName}`;
      if (!isTerminalMissionStatus(mission.status) && isTerminalIssueStatus(existing.status)) {
        const now = new Date();
        await db
          .update(issues)
          .set({
            status: "todo",
            assigneeAgentId: mission.ownerAgentId,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: now,
          })
          .where(eq(issues.id, existing.id));
        await db.insert(issueComments).values({
          companyId: mission.companyId,
          issueId: existing.id,
          authorAgentId: mission.ownerAgentId,
          body: [
            "## Mission oversight restored",
            `- mission status: \`${mission.status}\``,
            "- policy: mission oversight remains open until the mission is completed or cancelled.",
            `- previous issue status: \`${existing.status}\``,
          ].join("\n"),
        });
        await logActivity(db, {
          companyId: mission.companyId,
          actorType: "system",
          actorId: "mission-owner-supervision",
          agentId: mission.ownerAgentId,
          action: "mission.oversight_restored",
          entityType: "issue",
          entityId: existing.id,
          details: {
            missionId: mission.id,
            previousStatus: existing.status,
            nextStatus: "todo",
            missionStatus: mission.status,
            reason: "mission_oversight_must_remain_open_until_mission_terminal",
          },
        });
        existing.status = "todo";
        existing.assigneeAgentId = mission.ownerAgentId;
        existing.checkoutRunId = null;
        existing.executionRunId = null;
        existing.executionAgentNameKey = null;
        existing.executionLockedAt = null;
        existing.completedAt = null;
        existing.cancelledAt = null;
        existing.updatedAt = now;
      }
      if (existing.title !== nextTitle) {
        await db
          .update(issues)
          .set({ title: nextTitle, updatedAt: new Date() })
          .where(eq(issues.id, existing.id));
        existing.title = nextTitle;
      }
      await ensureWorkflowMissionPlanArtifact(mission, existing, workflowName, metadata);
      return existing;
    }

    const oversightIssue = await issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: [
        "Monitor this mission and keep execution moving.",
        "",
        `Mission: ${mission.title}`,
        `Scope: ${workflowName}`,
        "",
        "Main executor duties:",
        "- Watch step progress and comments.",
        "- Comment on failed, stale, undispatched, or blocked steps with the current judgement.",
        "- Retry failed workflow steps when retry is safe and within the retry limit.",
        "- Recover/replan toward completion, or escalate/report impossible states with evidence.",
      ].join("\n"),
      missionId: mission.id,
      originKind: "mission_main_executor_oversight",
      priority: "medium",
      status: "todo",
      title: `[OVERSIGHT] ${workflowName}`,
    });
    await ensureWorkflowMissionPlanArtifact(mission, oversightIssue, workflowName, metadata);
    return oversightIssue;
  }

  async function ensureMissionExecutionPlan(input: {
    companyId: string;
    missionId: string;
    sourceHints?: {
      workflowName?: string;
      sourceRunId?: string;
      workflowStepIds?: string[];
      executionUnits?: Array<Record<string, unknown>>;
    };
  }): Promise<{ missionId: string; oversightIssueId: string; planId: string | null }> {
    const [mission] = await db
      .select()
      .from(missions)
      .where(and(eq(missions.companyId, input.companyId), eq(missions.id, input.missionId)))
      .limit(1);
    if (!mission) throw notFound(`Mission not found: ${input.missionId}`);

    const snapshot = await listMissionExecutionSourceSnapshots(db, {
      companyId: input.companyId,
      missionIds: [input.missionId],
    }).then((snapshots) => snapshots[input.missionId] ?? null);
    const snapshotUnits = snapshot?.units.map((unit) => ({
      kind: unit.kind,
      title: unit.title ?? unit.workflowName ?? null,
      status: unit.status,
      sourceRef: unit.sourceRef,
    })) ?? [];
    const executionUnits = input.sourceHints?.executionUnits
      ?? (input.sourceHints?.sourceRunId || input.sourceHints?.workflowStepIds ? undefined : snapshotUnits);
    const workflowName = input.sourceHints?.workflowName
      ?? snapshot?.units.find((unit) => unit.workflowName)?.workflowName
      ?? snapshot?.units.find((unit) => unit.title)?.title
      ?? "Mission execution";

    const oversightIssue = await ensureMainExecutorOversightIssue(mission, workflowName, {
      workflowStepIds: input.sourceHints?.workflowStepIds,
      sourceRunId: input.sourceHints?.sourceRunId,
      executionUnits,
    });
    const activePlan = await missionPlanArtifactService(db).getActiveMissionPlan({
      companyId: input.companyId,
      missionId: input.missionId,
    });
    return { missionId: mission.id, oversightIssueId: oversightIssue.id, planId: activePlan?.id ?? null };
  }

  async function reopenAppliedToolStepRecoveryIfRetryFailed(input: {
    issue: IssueRow;
    mission: MissionRow;
    runId: string;
    stepId: string;
    stepRun: typeof workflowStepRuns.$inferSelect;
  }): Promise<boolean> {
    if (input.issue.status !== "done" || input.stepRun.status !== "failed") return false;
    await issueService(db).update(input.issue.id, { status: "todo" });
    await issueService(db).addComment(
      input.issue.id,
      [
        "### Native tool step retry failed",
        `Workflow run: ${input.runId}`,
        `Step: ${input.stepId}`,
        `Step run: ${input.stepRun.id}`,
        `Failed at: ${input.stepRun.completedAt?.toISOString() ?? new Date().toISOString()}`,
        "",
        "The completed recovery action was applied through the unified workflow engine, but the tool step failed again. Reopening this recovery issue so the mission owner can diagnose the latest failure before another retry.",
      ].join("\n"),
      { agentId: input.mission.ownerAgentId },
    );
    return true;
  }

  async function closeDuplicateToolStepRecoveryIssue(input: {
    issue: IssueRow;
    mission: MissionRow;
    canonicalIssue: IssueRow;
    runId: string;
    stepId: string;
  }): Promise<boolean> {
    if (input.issue.status === "done") return false;
    await issueService(db).update(input.issue.id, { status: "done" });
    await issueService(db).addComment(
      input.issue.id,
      [
        "### Duplicate native tool step recovery closed",
        `Canonical recovery issue: ${input.canonicalIssue.identifier ?? input.canonicalIssue.id}`,
        `Workflow run: ${input.runId}`,
        `Step: ${input.stepId}`,
        "",
        "This issue has the same tool-step recovery marker as the canonical issue. Automatic recovery will be handled only once through the unified workflow engine.",
      ].join("\n"),
      { agentId: input.mission.ownerAgentId },
    );
    return true;
  }

  function buildCorrectedArtifactValidatorRetryEvidence(input: {
    sourceIssue: IssueRow;
    sourceLabel: string;
    missionIssues: IssueRow[];
    commentsByIssueId: Map<string, string[]>;
  }): { comment: string; childIssueId: string } | null {
    const childCandidates = input.missionIssues
      .filter((issue) => issue.parentId === input.sourceIssue.id && isTerminalIssueStatus(issue.status))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    for (const child of childCandidates) {
      const comments = input.commentsByIssueId.get(child.id) ?? [];
      const combined = comments.join("\n");
      const lower = combined.toLowerCase();
      const hasCorrectedArtifact = lower.includes("corrected")
        && (lower.includes(".png") || lower.includes("png path") || lower.includes("corrected png"));
      const mentionsValidatorCriteria = lower.includes("res-148")
        || lower.includes("repair spec")
        || lower.includes("panel 3")
        || lower.includes("panel 5")
        || lower.includes("request_changes");
      if (!hasCorrectedArtifact || !mentionsValidatorCriteria) continue;

      const evidenceLines = combined
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => {
          const normalized = line.toLowerCase();
          return normalized.includes("corrected")
            || normalized.includes(".png")
            || normalized.includes("res-148")
            || normalized.includes("repair spec")
            || normalized.includes("panel 3")
            || normalized.includes("panel 5")
            || normalized.includes("request_changes")
            || normalized.includes("pass")
            || normalized.includes("telegram")
            || normalized.includes("send");
        })
        .slice(0, 12);

      return {
        childIssueId: child.id,
        comment: buildValidatorRetryEvidenceComment({
          sourceLabel: input.sourceLabel,
          childLabel: `${child.identifier ?? child.id} (${child.id})`,
          evidenceLines: evidenceLines.length > 0 ? evidenceLines : [`Correction issue ${child.identifier ?? child.id} recorded corrected artifact evidence.`],
        }),
      };
    }

    return null;
  }

  async function listRecurringArtifactMissingIssueRefs(input: {
    companyId: string;
    assigneeAgentId: string | null;
    since: Date;
  }): Promise<Array<{ id: string; identifier: string | null; title: string }>> {
    if (!input.assigneeAgentId) return [];
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .innerJoin(issueComments, eq(issueComments.issueId, issues.id))
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.assigneeAgentId),
        isNull(issues.hiddenAt),
        gte(issueComments.createdAt, input.since),
        sql`(
          ${issueComments.body} ilike '%required workflow artifact missing%'
          or ${issueComments.body} ilike '%artifact missing%'
          or ${issueComments.body} ilike '%블로그 파일 누락%'
          or ${issueComments.body} ilike '%markdown 파일로 저장%'
          or ${issueComments.body} ilike '%파일로만 저장%'
        )`,
      ));
    const byIssueId = new Map<string, { id: string; identifier: string | null; title: string }>();
    for (const row of rows) byIssueId.set(row.id, row);
    return [...byIssueId.values()];
  }


  return {
    createMissionOwnerActionIssue,
    ensureMainExecutorUnblockIssue,
    ensureMainExecutorPlanningIssue,
    ensureMainExecutorOversightIssue,
    ensureToolStepFailureRecoveryIssue,
    ensureMissionExecutionPlan,
    ensureWorkflowMissionPlanArtifact,
    ensureWorkflowIssuesLinkedToMission,
    reconcileMissionStatusFromWorkflowRuns,
    completeOpenMissionOversightIfSettled,
    collectWorkflowIssueIdsForMission,
    collectIssueIdsWithAncestors,
    findMainExecutorIssue,
    reopenAppliedToolStepRecoveryIfRetryFailed,
    closeDuplicateToolStepRecoveryIssue,
    listRecurringArtifactMissingIssueRefs,
    buildCorrectedArtifactValidatorRetryEvidence,
    isMissionOwnerActionParentPlacementRejected,
  };
}
