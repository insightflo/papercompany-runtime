// server/src/services/missions/owner-actions.ts
//
// [파일 목적] mission owner action 클로저들을 factory로 캡슐화 (P2).
//   db/deps 명시 주입 → 클로저 공유 대체. missions.ts(missionService)가 호출.
// [수정시 주의] 부작용 있음(이슈 생성/갱신/wakeup). 순수 아님.
import { activityLog, issueComments, issues, missionPlanArtifacts, missions, pluginEntities, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { issueService } from "../issues.js";
import { mergeMissionPlanRefs, missionPlanArtifactService } from "../mission-plan-artifacts.js";
import type { MissionRow } from "../missions.js";
import type { WorkflowStep } from "../workflow/dag-engine.js";
import { buildValidatorRetryEvidenceComment, isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import type { MissionTerminalCleanupDb } from "./terminal-cleanup-fence.js";
import { createMissionWorkflowReconciliation } from "./mission-workflow-reconciliation.js";
import { buildRevisionMissionPlanningDescription } from "./mission-revision-planning.js";
import { missionPlanTemplateService } from "./mission-plan-templates.js";
import { listCompanyExecutionCandidates, formatCandidateRosterLines } from "./mission-execution-candidates.js";
import { buildMissionRuleContext } from "./mission-rule-context.js";
import { createMissionWorkSettlement } from "./mission-work-settlement.js";
import { listMissionExecutionSourceSnapshots } from "./mission-execution-sources.js";
import { pruneStaleWorkflowExecutionUnits, type PluginWorkflowRunData, type PluginWorkflowStepRunData } from "./plugin-workflow.js";
import type { ToolStepFailureClassification } from "./tool-step-failure.js";
import { ensureToolRecoveryCard } from "./tool-recovery-card.js";
import { asTrimmedString } from "./utils.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { isTerminalMissionStatus } from "./shared-types.js";
import type { MissionServiceDeps } from "../missions.js";
import type { MissionOwnerDecisionWakeupDispatchStatus } from "./supervision-types.js";
import { createOwnerUnblockAnchor } from "./owner-unblock-anchor.js";
import { loadCompanySystemLanguage } from "./system-language.js";
import { appendOrRefreshMissionOwnerHumanInputInstructions, buildMainExecutorOversightDescription } from "./oversight-human-input-instructions.js";
export function createOwnerActions({ db, deps }: { db: Db; deps: MissionServiceDeps }) {

  const findOpenMissionWork = createMissionWorkSettlement(db);

  async function reopenCompletedWorkflowMissionForOpenWork(
    mission: MissionRow,
    openWork: { id: string; status: string },
  ): Promise<MissionRow> {
    const now = new Date();
    const updates: Partial<MissionRow> = {
      status: "active",
      completedAt: null,
      startedAt: mission.startedAt ?? now,
      updatedAt: now,
    };
    await db.update(missions).set(updates).where(eq(missions.id, mission.id));
    const reopenedMission = { ...mission, ...updates };
    await ensureMainExecutorOversightIssue(reopenedMission, mission.title);
    await logActivity(db, {
      companyId: mission.companyId,
      actorType: "system",
      actorId: "mission-owner-supervision",
      agentId: mission.ownerAgentId,
      action: "mission.reopened_for_unsettled_work",
      entityType: "mission",
      entityId: mission.id,
      details: {
        previousStatus: mission.status,
        nextStatus: "active",
        openIssueId: openWork.id,
        openIssueStatus: openWork.status,
        reason: "completed_workflow_mission_has_open_non_oversight_work",
      },
    });
    return reopenedMission;
  }

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

  const reconcileMissionStatusFromWorkflowRuns = createMissionWorkflowReconciliation({
    db,
    findOpenMissionWork,
    reopenCompletedWorkflowMissionForOpenWork,
    completeOpenMissionOversightIfSettled,
  });

  async function completeOpenMissionOversightIfSettled(mission: MissionRow, completedAt: Date, executor: MissionTerminalCleanupDb = db): Promise<void> {
    if (mission.status !== "completed") return;

    const openWork = await createMissionWorkSettlement(executor as Db)(mission.companyId, mission.id);
    if (openWork) return;

    const now = new Date();
    await executor
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
    const candidates = await listCompanyExecutionCandidates(db, mission.companyId);
    const runnableRosterLines = formatCandidateRosterLines(candidates, mission.ownerAgentId);
    const planTemplateCatalog = await missionPlanTemplateService(db).list(mission.companyId, { includeDisabled: false });

    const description = await buildRevisionMissionPlanningDescription(db, {
      companyId: mission.companyId,
      missionId: mission.id,
      title: mission.title,
      description: mission.description,
      runnableCandidates: candidates,
      runnableRosterLines,
      planTemplateCatalog,
    });

    return issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description,
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
    // [2026-09-19 500-버그 수정] 가드는 '활성' 계획이 아니라 '임의 상태의 최신' 계획으로
    // 판정한다. 미션 종료 처리가 계획을 completed/archived로 바꾼 뒤 같은 흐름에서
    // 오버사이트 확보가 다시 불리면 활성 계획만 보는 가드는 재생성 경로로 빠져
    // (mission_id, revision=1) 유니크 위반 500을 냈다. 이미 어떤 계획이든 있으면
    // 새 초기 계획을 만들지 않는다(활성인 경우에만 refs 병합을 갱신).
    const [latestPlan] = await db
      .select()
      .from(missionPlanArtifacts)
      .where(and(
        eq(missionPlanArtifacts.companyId, mission.companyId),
        eq(missionPlanArtifacts.missionId, mission.id),
      ))
      .orderBy(desc(missionPlanArtifacts.revision))
      .limit(1);
    if (latestPlan) {
      if (latestPlan.status === "active") {
        const currentRefs = typeof latestPlan.refs === "object" && latestPlan.refs !== null && !Array.isArray(latestPlan.refs)
          ? latestPlan.refs as Record<string, unknown>
          : {};
        const baseRefs = pruneStaleWorkflowExecutionUnits(currentRefs, workflowName, metadata.sourceRunId);
        const mergedRefs = mergeMissionPlanRefs(baseRefs, refs);
        const changed = JSON.stringify(currentRefs) !== JSON.stringify(mergedRefs);
        if (changed) {
          await db
            .update(missionPlanArtifacts)
            .set({ refs: mergedRefs, updatedAt: new Date() })
            .where(eq(missionPlanArtifacts.id, latestPlan.id));
        }
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

  const ensureMainExecutorUnblockIssue = createOwnerUnblockAnchor({
    db,
    deps,
    createMissionOwnerActionIssue: (tx, companyId, data) =>
      createOwnerActions({ db: tx, deps: {} }).createMissionOwnerActionIssue(companyId, data),
  });
  async function ensureToolStepFailureRecoveryIssue(input: {
    mission: MissionRow;
    oversightIssue: IssueRow;
    run: typeof workflowRuns.$inferSelect;
    stepRun: typeof workflowStepRuns.$inferSelect;
    step: WorkflowStep | null;
    workflowName: string;
  }): Promise<{ issue: IssueRow; created: boolean; classification: ToolStepFailureClassification; toolNames: string[] }> {
    return ensureToolRecoveryCard(db, deps, input, (tx, companyId, data) =>
      createOwnerActions({ db: tx, deps: {} }).createMissionOwnerActionIssue(companyId, data));
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
      if (!isTerminalMissionStatus(mission.status) && !isTerminalIssueStatus(existing.status)) {
        const description = appendOrRefreshMissionOwnerHumanInputInstructions(existing.description ?? "");
        if (description !== existing.description) {
          await db.update(issues).set({ description, updatedAt: new Date() }).where(eq(issues.id, existing.id));
          existing.description = description;
        }
      }
      await ensureWorkflowMissionPlanArtifact(mission, existing, workflowName, metadata);
      return existing;
    }

    const oversightIssue = await issueService(db).create(mission.companyId, {
      assigneeAgentId: mission.ownerAgentId,
      description: buildMainExecutorOversightDescription({ missionTitle: mission.title, workflowName }),
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

  function readToolStepAttemptCount(stepRun: typeof workflowStepRuns.$inferSelect): number {
    const retryCount = typeof stepRun.retryCount === "number" ? stepRun.retryCount : 0;
    return 1 + Math.max(0, retryCount);
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
    // [진단 강제] 같은 실패가 반복됐다는 건 이전 복구 액션이 원인을 못 다룬 것.
    // 2026-08-27 gazua-evening 2: 오너가 “생산자 재작업→재시도”를 반복했으나 원인은
    // 정의의 toolArgs 누락이었다. 반복 실패 시 원인 좁히기 절차를 코멘트로 강제한다.
    const attempts = readToolStepAttemptCount(input.stepRun);
    const identicalRepeat = attempts >= 2;
    await issueService(db).addComment(
      input.issue.id,
      [
        "### Native tool step retry failed\nThe tool retry failed; recovery is still unresolved. Next action: inspect the recorded failure and decide the next structured recovery action.",
        `Workflow run: ${input.runId}`,
        `Step: ${input.stepId}`,
        `Step run: ${input.stepRun.id}`,
        `Failed at: ${input.stepRun.completedAt?.toISOString() ?? new Date().toISOString()}`,
        `Recorded failed attempts: ${attempts}`,
        "",
        "The completed recovery action was applied through the unified workflow engine, but the tool step failed again. Reopening this recovery issue so the mission owner can diagnose the latest failure before another retry.",
        ...(identicalRepeat ? [
          "",
          "**Repeated failure — diagnose before another retry.** The same step has now failed more than once. Before any further action:",
          "1. Check `toolInvocationArgs` in the evidence below: empty `{}` means the workflow definition itself lacks toolArgs (a definition defect you cannot fix — escalate with the exact missing field).",
          "2. Verify the expected artifact actually exists (registered work products) before blaming the producer.",
          "3. Compare the failing tool's invocation with a previously successful run of the same workflow.",
          "A retry without a stated root cause and a reason it will now change the outcome will just repeat this failure.",
        ] : []),
      ].join("\n"),
      { agentId: input.mission.ownerAgentId },
    );
    return true;
  }

  async function reopenUnresolvedRetryOwnerAction(input: {
    mission: MissionRow;
    ownerActionIssue: IssueRow;
    retryTargetIssue: IssueRow;
    retryTargetLabel: string;
    blockedIssue: IssueRow;
    marker: string;
    dispatchWakeup: boolean;
  }): Promise<MissionOwnerDecisionWakeupDispatchStatus> {
    if (input.ownerActionIssue.status !== "todo") {
      await issueService(db).update(input.ownerActionIssue.id, { status: "todo" });
    }
    await issueService(db).addComment(
      input.ownerActionIssue.id,
      [
        "### Mission owner retry unresolved\nThe requested recovery has not resolved the source issue. Next action: check the source run and structured recovery record before requesting another retry.",
        `<!-- ${input.marker} -->`,
        "Previous decision: retry_source_issue",
        `Retry target: ${input.retryTargetLabel}`,
        `Blocked issue: ${input.blockedIssue.identifier ?? input.blockedIssue.id}`,
        `Result: retry target is ${input.retryTargetIssue.status}, but the blocked issue is still blocked.`,
        "Required next decision: choose replan_mission, request_input, escalate, report_impossible, or provide a different retry target with new evidence. Do not repeat the same retry without new evidence.",
      ].join("\n"),
      { agentId: input.mission.ownerAgentId },
    );
    if (!input.dispatchWakeup) return "not_requested";
    if (!deps.onOwnerActionCreated) return "failed";
    await deps.onOwnerActionCreated({
      mission: input.mission,
      issue: input.ownerActionIssue,
      sourceIssue: input.blockedIssue,
      reason: "mission_unblock_action_stalled",
    });
    return "dispatched";
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
        "### Duplicate native tool step recovery closed\nThis duplicate recovery issue was closed, not the original work. Next action: follow the canonical recovery issue below; no new retry is implied.",
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
    // Structured authority only: durable heartbeat gate activity, not comment keyword search.
    if (!input.assigneeAgentId) return [];
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .innerJoin(activityLog, and(
        eq(activityLog.entityType, "issue"),
        // activity_log.entity_id is text; issues.id is uuid.
        sql`${activityLog.entityId} = ${issues.id}::text`,
        eq(activityLog.companyId, input.companyId),
      ))
      .where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.assigneeAgentId),
        isNull(issues.hiddenAt),
        eq(activityLog.action, "issue.artifact_work_product_missing_auto_blocked"),
        gte(activityLog.createdAt, input.since),
      ))
      .orderBy(desc(activityLog.createdAt));
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
    reopenUnresolvedRetryOwnerAction,
    closeDuplicateToolStepRecoveryIssue,
    listRecurringArtifactMissingIssueRefs,
    buildCorrectedArtifactValidatorRetryEvidence,
    isMissionOwnerActionParentPlacementRejected,
  };
}
