// C08 producer: mission/run/heartbeat/sorted issues precede the current pointer and card.
// Creation uses the caller's transaction; notifications run only after it commits.
import { heartbeatRuns, issues, missions, workflowRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import type { MissionRow, MissionServiceDeps } from "../missions.js";
import { buildMissionExecutionDigest } from "./mission-execution-digest.js";
import { buildMissionOwnerUnblockDescription, isTerminalIssueStatus } from "./mission-owner-recovery-comments.js";
import { loadLatestMissionOwnerDecision } from "./mission-owner-recovery-ledger.js";
import { findRelatedKnowledgePatterns } from "./mission-owner-related-patterns.js";
import { ownerHumanCurrentKey, ownerHumanCurrentSchema, ownerHumanLifetimeSchema,
  sameOwnerHumanValue, type OwnerHumanScope } from "./owner-human-request-contract.js";
import { readOwnerHumanCurrent } from "./owner-human-request-state.js";
import { renewOwnerHumanRequestWithCard } from "./owner-human-request-renew.js";
import type { IssueCreateInput, IssueRow } from "./shared-types.js";
import { loadCompanySystemLanguage } from "./system-language.js";

type OwnerUnblockAnchorDependencies = {
  db: Db;
  deps: Pick<MissionServiceDeps, "onOwnerActionCreated">;
  createMissionOwnerActionIssue: (tx: Db, companyId: string, data: IssueCreateInput) => Promise<IssueRow>;
};
const fail = (): never => { throw conflict("Owner unblock anchor conflict", {
  reason: "owner_unblock_anchor_changed",
}); };

export function createOwnerUnblockAnchor({ db, deps, createMissionOwnerActionIssue }: OwnerUnblockAnchorDependencies) {
  return async function ensureMainExecutorUnblockIssue(
    observedMission: MissionRow,
    blockedIssue: IssueRow,
    options: { renewAfterNoActionWaiting?: boolean; governanceEvidence?: string[]; notifyOwner?: boolean } = {},
  ): Promise<IssueRow> {
    const result = await db.transaction(async (tx) => {
      const [mission] = await tx.select().from(missions).where(and(
        eq(missions.id, observedMission.id), eq(missions.companyId, observedMission.companyId))).for("update");
      if (!mission || mission.ownerAgentId !== observedMission.ownerAgentId
        || ["completed", "cancelled"].includes(mission.status)) return fail();
      const [observedSource] = await tx.select().from(issues).where(and(
        eq(issues.id, blockedIssue.id), eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id)));
      if (!observedSource || observedSource.hiddenAt) return fail();
      const scope: OwnerHumanScope = { companyId: mission.companyId, missionId: mission.id,
        target: { kind: "source_issue", issueId: observedSource.id } };
      const [pointerRow] = await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, mission.companyId),
        eq(workflowTransitionEvents.idempotencyKey, ownerHumanCurrentKey(scope))));
      // Discovery supplies lock IDs only. The authoritative state reader checks the exact
      // pointer, immutable origin and every predecessor again after the native locks.
      const parsedPointer = pointerRow ? ownerHumanCurrentSchema.safeParse(pointerRow.payload) : null;
      if (parsedPointer && !parsedPointer.success) return fail();
      const pointer = parsedPointer?.success ? parsedPointer.data : null;
      if (pointer && !sameOwnerHumanValue(pointer.scope, scope)) return fail();
      const [saved] = pointer ? await tx.select().from(workflowTransitionEvents).where(and(
        eq(workflowTransitionEvents.companyId, mission.companyId),
        eq(workflowTransitionEvents.id, pointer.lifetimeId))) : [];
      const parsedLifetime = pointer ? ownerHumanLifetimeSchema.safeParse(saved?.payload) : null;
      if (parsedLifetime && !parsedLifetime.success) return fail();
      const lifetime = parsedLifetime?.success ? parsedLifetime.data : null;
      const runId = observedSource.originRunId;
      const [run] = runId ? await tx.select().from(workflowRuns).where(and(
        sql`${workflowRuns.id}::text = ${runId}`, eq(workflowRuns.companyId, mission.companyId),
        eq(workflowRuns.missionId, mission.id))).for("update") : [];
      // Legacy nonhuman sources may name a plugin run rather than a native UUID.
      // A human lifetime still requires the exact native run proven at submission.
      if (lifetime && runId && !run) return fail();
      if (lifetime) {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lifetime.heartbeatRunId)).for("share");
      }
      const discovered = await tx.select().from(issues).where(and(
        eq(issues.companyId, mission.companyId), eq(issues.missionId, mission.id),
        eq(issues.originKind, "mission_main_executor_unblock"), eq(issues.originId, observedSource.id)))
        .orderBy(asc(issues.createdAt), asc(issues.id));
      const locked = new Map<string, IssueRow>();
      for (const id of [...new Set([observedSource.id, ...discovered.map((row) => row.id)])].sort()) {
        const [row] = await tx.select().from(issues).where(eq(issues.id, id)).for("update");
        if (!row || row.companyId !== mission.companyId || row.missionId !== mission.id) return fail();
        locked.set(id, row);
      }
      const source = locked.get(observedSource.id)!;
      if (source.hiddenAt || source.originRunId !== runId) return fail();
      const anchors = discovered.map((row) => locked.get(row.id)!);
      if (anchors.some((row) => row.originKind !== "mission_main_executor_unblock" || row.originId !== source.id)) return fail();
      const visible = anchors.filter((row) => !row.hiddenAt);
      const open = visible.filter((row) => !isTerminalIssueStatus(row.status));
      if (open.length > 1) return fail();
      let current = null as Awaited<ReturnType<typeof readOwnerHumanCurrent>>;
      if (lifetime) {
        const anchor = locked.get(lifetime.anchorIssueId);
        if (!anchor || anchor.hiddenAt || lifetime.authorAgentId !== mission.ownerAgentId
          || anchor.assigneeAgentId !== mission.ownerAgentId || lifetime.sourceIssueId !== source.id
          || lifetime.cardInput.workflowRunId !== (run?.id ?? null)) return fail();
        // The server producer has acquired and checked the full source-issue prefix.
        // No agent checkout or new authorship is synthesized for this state-only read.
        current = await readOwnerHumanCurrent({ tx, scope, anchor, source, run, step: undefined,
          purpose: "settle", renewal: undefined, renewalAnchor: undefined,
          agentId: mission.ownerAgentId, heartbeatRunId: lifetime.heartbeatRunId,
          recoveryTarget: lifetime.submission.recoveryTarget });
        if (!current || current.lifetime.lifetimeId !== lifetime.lifetimeId) return fail();
        if (open.length && open[0]!.id !== current.pointer.anchorIssueId
          && (current.pointer.recoveryNeeded || source.status !== "blocked"
            || !isTerminalIssueStatus(anchor.status))) return fail();
      } else {
        const [orphan] = await tx.select({ id: workflowTransitionEvents.id }).from(workflowTransitionEvents).where(and(
          eq(workflowTransitionEvents.companyId, mission.companyId), eq(workflowTransitionEvents.missionId, mission.id),
          eq(workflowTransitionEvents.eventType, "owner_human_lifetime_v1"),
          sql`${workflowTransitionEvents.payload}->'scope' = ${JSON.stringify(scope)}::jsonb`)).limit(1);
        if (orphan) return fail();
      }
      if (open.length) {
        if (open[0]!.assigneeAgentId && open[0]!.assigneeAgentId !== mission.ownerAgentId) return fail();
        return { mission, source, issue: open[0]!, created: false };
      }
      const historical = current ? locked.get(current.pointer.anchorIssueId)! : visible[0];
      if (isTerminalIssueStatus(source.status) || current && source.status !== "blocked") {
        if (!historical) return fail();
        return { mission, source, issue: historical, created: false };
      }
      // A real blocked source needs a live anchor even without any human lifetime.
      // Preserve the existing explicit no-action renewal for nonblocked legacy callers.
      if (historical && !current && source.status !== "blocked") {
        for (const previous of visible) {
          const decision = options.renewAfterNoActionWaiting ? await loadLatestMissionOwnerDecision({
            db: tx, companyId: mission.companyId, ownerActionIssueId: previous.id,
          }) : null;
          if (decision?.decision.decision !== "no_action_waiting") {
            return { mission, source, issue: previous, created: false };
          }
        }
      }
      if (historical?.assigneeAgentId && historical.assigneeAgentId !== mission.ownerAgentId) return fail();
      let missionExecutionDigest: string[] = [];
      try {
        missionExecutionDigest = await tx.transaction((nested) =>
          buildMissionExecutionDigest(nested as unknown as Db, { mission, blockedIssue: source }));
      } catch (error) {
        logger.warn({ err: error, missionId: mission.id, blockedIssueId: source.id }, "Failed to build mission execution digest for owner unblock issue");
        missionExecutionDigest = ["Mission execution digest could not be built; inspect workflow runs, step runs, work products, and source issue comments manually."];
      }
      let relatedKnowledgePatterns: Array<{ id: string; title: string }> = [];
      try {
        relatedKnowledgePatterns = await tx.transaction((nested) => findRelatedKnowledgePatterns(
          nested as unknown as Db, mission.companyId, [mission.title, source.title, ...missionExecutionDigest]));
      } catch (error) {
        logger.warn({ err: error, missionId: mission.id, blockedIssueId: source.id }, "Failed to find related knowledge patterns for owner unblock issue");
      }
      const language = await loadCompanySystemLanguage(tx as unknown as Db, mission.companyId);
      const issue = await createMissionOwnerActionIssue(tx as unknown as Db, mission.companyId, {
        assigneeAgentId: mission.ownerAgentId,
        description: buildMissionOwnerUnblockDescription(mission, source, {
          governanceEvidence: options.governanceEvidence, missionExecutionDigest, relatedKnowledgePatterns, language,
        }),
        missionId: mission.id, originKind: "mission_main_executor_unblock", originId: source.id,
        parentId: source.parentId ? undefined : source.id, priority: "high", status: "todo",
        title: `[Unblock] ${source.identifier ?? source.id}: ${source.title}`,
      });
      // A closed lifetime cannot be renewed. The owner submits fresh content/key on
      // this anchor through the existing CAS writer; historical approval grants nothing.
      if (current?.pointer.recoveryNeeded) {
        await renewOwnerHumanRequestWithCard(tx, { companyId: mission.companyId,
          previousLifetimeId: current.lifetime.lifetimeId, anchorIssueId: issue.id,
          requestKey: `owner-anchor-renewal:v1:${current.lifetime.lifetimeId}:${issue.id}` });
      }
      return { mission, source, issue, created: true };
    });
    if (result.created && options.notifyOwner !== false && deps.onOwnerActionCreated) {
      void Promise.resolve(deps.onOwnerActionCreated({
        mission: result.mission, issue: result.issue, sourceIssue: result.source,
        reason: "mission_unblock_action_created",
      })).catch((err) => {
        logger.warn({ err, missionId: result.mission.id, issueId: result.issue.id }, "failed to notify owner about mission unblock action");
      });
    }
    return result.issue;
  };
}
