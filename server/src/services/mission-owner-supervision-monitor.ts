import { missions, type Db } from "@paperclipai/db";
import { asc, inArray } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { missionService, type MissionOwnerActionCreatedHandler, type MissionOwnerDecisionRetrySourceIssueAppliedHandler, type MissionOwnerDecisionDispatchStalledWakeRequestedHandler, type MissionOwnerPeriodicReviewWakeRequestedHandler, type MissionPlanRevisionRequestedHandler, type MissionPlanSubmissionMissingHandler, type MissionStaleSourceIssueWakeupRequestedHandler, type MissionTerminalRunCloseoutWakeRequestedHandler, type MissionWorkProductReuseWakeRequestedHandler } from "./missions.js";
import type { PlanQaWakeupHandler, SweepStalledPlanQaPassRecordsResult } from "./mission-owner-plan-decisions.js";
import { sweepStalledPlanQaPassRecords } from "./mission-owner-plan-decisions.js";
import {
  closeSatisfiedReplanUnblockIssues,
  type CloseSatisfiedReplanUnblockIssuesResult,
} from "./missions/owner-replan-application.js";
import { recordActiveMissionCadenceShadow } from "./mission-oversight-shadow.js";
import { isStaleSourceWakeupEnabled } from "./missions/stale-source-wakeup-gate.js";
import { sweepApprovedRevisionStarts } from "./workflow/approved-revision-start.js";
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
  let automaticAdmissionOpen = false;
  let automaticGeneration = 0;
  const activeRuns = new Set<Promise<void>>();
  const failureLane = options.onMissionOversightFailureWakeRequested ? createMissionOversightFailureLane(db, {
    failureLaneIntervalMs: options.failureLaneIntervalMs,
    onMissionOversightFailureWakeRequested: options.onMissionOversightFailureWakeRequested,
  }) : null;

  const livenessLane = options.onMissionOversightLivenessGhostWakeRequested ? createMissionOversightLivenessLane(db, {
    livenessLaneIntervalMs: options.livenessLaneIntervalMs,
    onMissionOversightLivenessGhostWakeRequested: options.onMissionOversightLivenessGhostWakeRequested,
  }) : null;

  function trackRun(task: Promise<void>): Promise<void> {
    activeRuns.add(task);
    void task.then(
      () => activeRuns.delete(task),
      () => activeRuns.delete(task),
    );
    return task;
  }

  async function runCycle(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const service = missionService(db, {
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
      });

      // [stale-source wakeup gate 2026-11-13] 하드코딩 off 대신 인스턴스 설정 게이트 —
      //   enableStaleSourceIssueWakeupV1 이 켜지면 자동 깨움 경로를 연다. 설정 없이도
      //   같은 진단 임계 반복 + 구조화 판정이면 감독 내부의 자동 게이트가 열린다.
      //   설정 읽기 실패는 fail-closed(진단만) — sweep 자체를 죽이지 않는다.
      const dispatchStaleSourceIssueWakeups = await isStaleSourceWakeupEnabled(db).catch((err) => {
        logger.warn({ err }, "stale-source wakeup gate read failed; defaulting to diagnose-only");
        return false;
      });
      const sweepOptions = {
        staleAfterMinutes,
        applySafeActions,
        applyOwnerDecisionActions: true,
        dispatchOwnerDecisionWakeups: true,
        dispatchStaleSourceIssueWakeups,
      };
      let result: Awaited<ReturnType<typeof service.runActiveMissionOwnerSupervision>>;
      try {
        // Preserve the established single aggregate sweep on the normal path.
        result = await service.runActiveMissionOwnerSupervision(sweepOptions);
      } catch (err) {
        // A safety conflict in one mission remains visible, then the fallback
        // isolates candidates so unrelated missions can still close out.
        logger.warn({ err }, "Mission owner supervision monitor aggregate sweep failed; retrying by mission");
        const candidates = await db
          .select({ id: missions.id })
          .from(missions)
          .where(inArray(missions.status, applySafeActions
            ? ["active", "planning", "completed"]
            : ["active", "planning"]))
          .orderBy(asc(missions.createdAt), asc(missions.id));
        const missionIds: string[] = [];
        const supervisedMissions: typeof result.missions = [];
        for (const candidate of candidates) {
          try {
            const missionResult = await service.runActiveMissionOwnerSupervision({
              ...sweepOptions,
              missionIds: [candidate.id],
            });
            missionIds.push(...missionResult.missionIds);
            supervisedMissions.push(...missionResult.missions);
          } catch (missionErr) {
            logger.warn({ err: missionErr, missionId: candidate.id }, "Mission owner supervision monitor mission sweep failed");
          }
        }
        result = { missionIds, missions: supervisedMissions };
      }

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
    // [승인=시작 2026-11-11] PLAN-QA PASS 원장은 기록됐지만 소비 noop 으로 멈춘 미션을 회복한다.
    //   기존 sweep 이후·가드 밖에서 실행하며, 실패가 감독 주기를 막지 않는다.
    try {
      const swept: SweepStalledPlanQaPassRecordsResult = await sweepStalledPlanQaPassRecords(db);
      if (swept.recovered > 0 || swept.failures.length > 0) {
        logger.warn({ ...swept }, "stalled PLAN-QA pass sweep completed");
      }
    } catch (err) {
      logger.warn({ err }, "stalled PLAN-QA pass sweep failed");
    }

    // [5207d3bf 수리] 충족된 replan_mission 결정의 미종결 언블록 이슈를 done 종결해
    //   run-terminal-recovery-gate 채널 (a)의 런 종결 유예 고착(회복 채널이 닫히지 않아
    //   running 잔존)을 해소한다. 실패가 감독 주기를 막지 않는다.
    try {
      const closeout: CloseSatisfiedReplanUnblockIssuesResult = await closeSatisfiedReplanUnblockIssues(db);
      if (closeout.closed > 0 || closeout.failures.length > 0) {
        logger.warn({ ...closeout }, "satisfied replan unblock closeout sweep completed");
      }
    } catch (err) {
      logger.warn({ err }, "satisfied replan unblock closeout sweep failed");
    }
  }

  function run(): Promise<void> {
    return trackRun(runCycle());
  }

  function isCurrentAutomaticGeneration(generation: number): boolean {
    return automaticAdmissionOpen && automaticGeneration === generation;
  }

  function runAutomatically(generation: number): void {
    if (!isCurrentAutomaticGeneration(generation)) return;
    void run();
  }

  async function drainOwnRuns(): Promise<void> {
    while (activeRuns.size > 0) {
      await Promise.allSettled([...activeRuns]);
    }
  }

  async function drain(): Promise<void> {
    await Promise.all([
      drainOwnRuns(),
      failureLane?.drain() ?? Promise.resolve(),
      livenessLane?.drain() ?? Promise.resolve(),
    ]);
  }

  return {
    start() {
      if (timer) return;
      automaticAdmissionOpen = true;
      const generation = ++automaticGeneration;
      timer = setInterval(() => runAutomatically(generation), intervalMs);
      failureLane?.start();
      livenessLane?.start();
      if (runImmediately) runAutomatically(generation);
    },
    stop() {
      automaticAdmissionOpen = false;
      automaticGeneration += 1;
      failureLane?.stop();
      livenessLane?.stop();
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    drain,
    run,
  };
}

export type MissionOwnerSupervisionMonitor = ReturnType<typeof createMissionOwnerSupervisionMonitor>;
