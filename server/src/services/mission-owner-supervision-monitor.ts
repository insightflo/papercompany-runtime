import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { missionService, type MissionOwnerActionCreatedHandler, type MissionOwnerDecisionRetrySourceIssueAppliedHandler, type MissionOwnerDecisionDispatchStalledWakeRequestedHandler, type MissionOwnerPeriodicReviewWakeRequestedHandler, type MissionPlanRevisionRequestedHandler, type MissionPlanSubmissionMissingHandler, type MissionStaleSourceIssueWakeupRequestedHandler, type MissionTerminalRunCloseoutWakeRequestedHandler, type MissionWorkProductReuseWakeRequestedHandler } from "./missions.js";
import type { PlanQaWakeupHandler } from "./mission-owner-plan-decisions.js";
import { recordActiveMissionCadenceShadow } from "./mission-oversight-shadow.js";
import { sweepApprovedRevisionStarts } from "./workflow/approved-revision-start.js";
import { promoteStrandedDeferredWakes } from "./deferred-wake-promotion.js";
import { createMissionOversightFailureLane, type MissionOversightFailureWakeRequestedHandler } from "./mission-oversight-failure-lane.js";
import { createMissionOversightLivenessLane, type MissionOversightLivenessGhostWakeRequestedHandler } from "./mission-oversight-liveness-lane.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_MINUTES = 30;

export interface MissionOwnerSupervisionMonitorOptions {
  intervalMs?: number;
  failureLaneIntervalMs?: number;
  onMissionOversightFailureWakeRequested?: MissionOversightFailureWakeRequestedHandler;
  livenessLaneIntervalMs?: number;
  onMissionOversightLivenessGhostWakeRequested?: MissionOversightLivenessGhostWakeRequestedHandler;
  staleAfterMinutes?: number;
  runImmediately?: boolean;
  applySafeActions?: boolean;
  onOwnerActionCreated?: MissionOwnerActionCreatedHandler;
  onOwnerDecisionRetrySourceIssueApplied?: MissionOwnerDecisionRetrySourceIssueAppliedHandler;
  onStaleSourceIssueWakeupRequested?: MissionStaleSourceIssueWakeupRequestedHandler;
  onWorkProductReuseWakeRequested?: MissionWorkProductReuseWakeRequestedHandler;
  onPlanQaIssueCreated?: PlanQaWakeupHandler;
  onPlanSubmissionMissing?: MissionPlanSubmissionMissingHandler;
  onPlanRevisionRequested?: MissionPlanRevisionRequestedHandler;
  onMissionTerminalRunCloseoutWakeRequested?: MissionTerminalRunCloseoutWakeRequestedHandler;
  onOwnerDecisionDispatchStalledWakeRequested?: MissionOwnerDecisionDispatchStalledWakeRequestedHandler;
  onMissionOwnerPeriodicReviewWakeRequested?: MissionOwnerPeriodicReviewWakeRequestedHandler;
}

export function createMissionOwnerSupervisionMonitor(
  db: Db,
  options: MissionOwnerSupervisionMonitorOptions = {},
) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const staleAfterMinutes = Math.max(1, options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES);
  const runImmediately = options.runImmediately ?? true;
  const applySafeActions = options.applySafeActions ?? true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const failureLane = options.onMissionOversightFailureWakeRequested ? createMissionOversightFailureLane(db, {
    failureLaneIntervalMs: options.failureLaneIntervalMs,
    onMissionOversightFailureWakeRequested: options.onMissionOversightFailureWakeRequested,
  }) : null;

  const livenessLane = options.onMissionOversightLivenessGhostWakeRequested ? createMissionOversightLivenessLane(db, {
    livenessLaneIntervalMs: options.livenessLaneIntervalMs,
    onMissionOversightLivenessGhostWakeRequested: options.onMissionOversightLivenessGhostWakeRequested,
  }) : null;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const result = await missionService(db, {
        onOwnerActionCreated: options.onOwnerActionCreated,
        onOwnerDecisionRetrySourceIssueApplied: options.onOwnerDecisionRetrySourceIssueApplied,
        onStaleSourceIssueWakeupRequested: options.onStaleSourceIssueWakeupRequested,
        onWorkProductReuseWakeRequested: options.onWorkProductReuseWakeRequested,
        onPlanQaIssueCreated: options.onPlanQaIssueCreated,
        onPlanSubmissionMissing: options.onPlanSubmissionMissing,
        onPlanRevisionRequested: options.onPlanRevisionRequested,
        onMissionTerminalRunCloseoutWakeRequested: options.onMissionTerminalRunCloseoutWakeRequested,
        onOwnerDecisionDispatchStalledWakeRequested: options.onOwnerDecisionDispatchStalledWakeRequested,
        onMissionOwnerPeriodicReviewWakeRequested: options.onMissionOwnerPeriodicReviewWakeRequested,
      }).runActiveMissionOwnerSupervision({
        staleAfterMinutes,
        applySafeActions,
        applyOwnerDecisionActions: true,
        dispatchOwnerDecisionWakeups: true,
        dispatchStaleSourceIssueWakeups: false,
      });
      const findingsCount = result.missions.reduce((total, mission) => total + mission.findings.length, 0);
      const commentedCount = result.missions.filter((mission) => mission.commented).length;
      const appliedActionsCount = result.missions.reduce((total, mission) => total + mission.appliedActions.length, 0);
      if (findingsCount > 0 || commentedCount > 0 || appliedActionsCount > 0) {
        logger.warn(
          {
            missionIds: result.missionIds,
            findingsCount,
            commentedCount,
            appliedActionsCount,
          },
          "Mission owner supervision monitor observed active mission issues",
        );
      }
    } catch (err) {
      logger.warn({ err }, "Mission owner supervision monitor sweep failed");
    } finally {
      running = false;
    }
    // Observe only AFTER the unchanged sweep, outside its in-flight guard.
    // Failure/latency in shadow must never gate an existing supervision tick.
    try {
      await recordActiveMissionCadenceShadow(db, new Date());
    } catch (err) {
      logger.warn({ err }, "Mission oversight cadence shadow observation failed");
    }
    // [승인=시작 2026-10-22] 이미 승인됐지만 실행이 시작되지 않은 수정 미션을 소급 시작한다.
    //   기존 sweep 이후·가드 밖에서 실행하며, 실패가 감독 주기를 막지 않는다.
    try {
      await sweepApprovedRevisionStarts(db);
    } catch (err) {
      logger.warn({ err }, "approved revision start sweep failed");
    }
    // [성긴 deferred 깨움 승격 2026-10-23] 이슈를 아무도 붙잡지 않는 오래된 deferred 깨움을 queued 로
    //   돌려보낸다 — 해제-승격 경로가 작동하지 않아 사람 결정 전달이 성그는 것을 막는다.
    try {
      await promoteStrandedDeferredWakes(db);
    } catch (err) {
      logger.warn({ err }, "stranded deferred wake promotion sweep failed");
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), intervalMs);
      failureLane?.start();
      livenessLane?.start();
      if (runImmediately) void run();
    },
    stop() {
      failureLane?.stop();
      livenessLane?.stop();
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    run,
  };
}

export type MissionOwnerSupervisionMonitor = ReturnType<typeof createMissionOwnerSupervisionMonitor>;
