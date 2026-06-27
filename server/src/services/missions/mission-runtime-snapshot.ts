// server/src/services/missions/mission-runtime-snapshot.ts
//
// Unified mission runtime snapshot for Ops/Hermes/oversight readback.
// Comments are display-only; structured runtime records remain the control source.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issues,
  missionPlanArtifacts,
  missionPlanDecisionSubmissions,
  missionPlanQaVerdicts,
  workflowRuns,
  workflowStepRuns,
  workflowTransitionEvents,
} from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface MissionRuntimeSnapshot {
  missionId: string;
  dag: {
    workflowRuns: Array<Record<string, unknown>>;
    stepRuns: Array<Record<string, unknown>>;
  };
  loop: {
    transitionEvents: Array<Record<string, unknown>>;
  };
  queue: {
    wakeupRequests: Array<Record<string, unknown>>;
  };
  runs: {
    heartbeatRuns: Array<Record<string, unknown>>;
  };
  domain: {
    planSubmissions: Array<Record<string, unknown>>;
    planQaVerdicts: Array<Record<string, unknown>>;
    planArtifacts: Array<Record<string, unknown>>;
  };
  comments: {
    recentComments: Array<Record<string, unknown>>;
    controlSource: "display_only";
  };
  legacyFallbackDiagnostics: Array<{
    parser: string;
    missionId: string;
    issueId?: string | null;
    runId?: string | null;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Snapshot loader
// ---------------------------------------------------------------------------

export async function loadMissionRuntimeSnapshot(
  db: Db,
  input: { companyId: string; missionId: string },
): Promise<MissionRuntimeSnapshot> {
  const { companyId, missionId } = input;

  // DAG: workflow_runs + workflow_step_runs for this mission
  const workflowRunRows = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.missionId, missionId)))
    .orderBy(desc(workflowRuns.createdAt));

  const stepRunRows = workflowRunRows.length > 0
    ? await db
      .select()
      .from(workflowStepRuns)
      .where(
        inArray(
          workflowStepRuns.workflowRunId,
          workflowRunRows.map((row) => row.id),
        ),
      )
    : [];

  // Loop: transition_events for this mission (DAG/step/loop layer)
  const transitionEventRows = await db
    .select()
    .from(workflowTransitionEvents)
    .where(
      and(
        eq(workflowTransitionEvents.companyId, companyId),
        eq(workflowTransitionEvents.missionId, missionId),
      ),
    )
    .orderBy(desc(workflowTransitionEvents.createdAt));

  // Queue: agent_wakeup_requests for this mission (typed mission_id column from p1 Task 1C)
  const wakeupRequestRows = await db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.missionId, missionId),
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt));

  // Runs: heartbeat_runs linked to this mission's issues
  const missionIssueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.missionId, missionId)));

  const heartbeatRunRows = missionIssueRows.length > 0
    ? await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(
            heartbeatRuns.issueId,
            missionIssueRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
    : [];

  // Domain: plan submissions + QA verdicts + plan artifacts
  const planSubmissionRows = await db
    .select()
    .from(missionPlanDecisionSubmissions)
    .where(
      and(
        eq(missionPlanDecisionSubmissions.companyId, companyId),
        eq(missionPlanDecisionSubmissions.missionId, missionId),
      ),
    )
    .orderBy(desc(missionPlanDecisionSubmissions.createdAt));

  const planQaVerdictRows = await db
    .select()
    .from(missionPlanQaVerdicts)
    .where(
      and(
        eq(missionPlanQaVerdicts.companyId, companyId),
        eq(missionPlanQaVerdicts.missionId, missionId),
      ),
    )
    .orderBy(desc(missionPlanQaVerdicts.createdAt));

  const planArtifactRows = await db
    .select()
    .from(missionPlanArtifacts)
    .where(
      and(
        eq(missionPlanArtifacts.companyId, companyId),
        eq(missionPlanArtifacts.missionId, missionId),
        eq(missionPlanArtifacts.status, "active"),
      ),
    )
    .orderBy(desc(missionPlanArtifacts.revision));

  // Comments: recent issue comments for this mission (display-only)
  const commentRows = missionIssueRows.length > 0
    ? await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(
            issueComments.issueId,
            missionIssueRows.map((row) => row.id),
          ),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(50)
    : [];

  return {
    missionId,
    dag: {
      workflowRuns: workflowRunRows as Array<Record<string, unknown>>,
      stepRuns: stepRunRows as Array<Record<string, unknown>>,
    },
    loop: {
      transitionEvents: transitionEventRows as Array<Record<string, unknown>>,
    },
    queue: {
      wakeupRequests: wakeupRequestRows as Array<Record<string, unknown>>,
    },
    runs: {
      heartbeatRuns: heartbeatRunRows as Array<Record<string, unknown>>,
    },
    domain: {
      planSubmissions: planSubmissionRows as Array<Record<string, unknown>>,
      planQaVerdicts: planQaVerdictRows as Array<Record<string, unknown>>,
      planArtifacts: planArtifactRows as Array<Record<string, unknown>>,
    },
    comments: {
      recentComments: commentRows as Array<Record<string, unknown>>,
      controlSource: "display_only",
    },
    legacyFallbackDiagnostics: [],
  };
}
