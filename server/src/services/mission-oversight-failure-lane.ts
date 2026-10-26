import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import { issues, missions, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { CadenceVerdict } from "./mission-oversight-cadence.js";
import { evaluateMissionOversightForMission } from "./mission-oversight-shadow.js";

export type MissionOversightFailureWakeRequestedHandler = (input: {
  mission: { id: string; companyId: string; ownerAgentId: string };
  issueId: string;
  verdict: Pick<CadenceVerdict, "state" | "reasonCode">;
  failureEntities: NonNullable<CadenceVerdict["failureEntities"]>;
  idempotencyKey: string;
}) => Promise<void>;

interface FailureLaneOptions {
  failureLaneIntervalMs?: number;
  onMissionOversightFailureWakeRequested: MissionOversightFailureWakeRequestedHandler;
}
const DEFAULT_INTERVAL_MS = 30_000;
const LOOKBACK_MS = 10 * 60_000;
const PAGE_SIZE = 500;
const WAKE_EVENT = "mission_oversight_failure_wake";

/** Events only request a fresh read: recovery/retry authority stays in the existing
 * evaluator. This lane writes a once-only audit claim, never execution state.
 * Claims intentionally precede delivery; a failed delivery leaves the claim intact
 * and the independent five-minute supervision path remains the fallback.
 */
export function createMissionOversightFailureLane(db: Db, options: FailureLaneOptions) {
  const intervalMs = Math.max(1, options.failureLaneIntervalMs ?? DEFAULT_INTERVAL_MS);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lifecycle = 0;
  // Retain DB microseconds, not JS Date's truncated milliseconds. The sealed
  // watermark is strictly excluded; full pages need a tie-breaking continuation
  // until the entire final timestamp bucket has been consumed.
  let watermark = new Date(Date.now() - LOOKBACK_MS).toISOString();
  let cursor: { at: string; id: string } | null = null;

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    const epoch = lifecycle;
    try {
      const events = await db.select({ id: workflowTransitionEvents.id, companyId: workflowTransitionEvents.companyId,
        missionId: workflowTransitionEvents.missionId, at: sql<string>`${workflowTransitionEvents.createdAt}::text` })
        .from(workflowTransitionEvents).where(and(
          gt(workflowTransitionEvents.createdAt, sql`${watermark}::timestamptz`),
          cursor ? sql`(${workflowTransitionEvents.createdAt}, ${workflowTransitionEvents.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
          eq(workflowTransitionEvents.eventType, "workflow_step_status_transition"),
          inArray(workflowTransitionEvents.toStatus, ["failed", "timed_out", "recovery_pending"]),
          isNotNull(workflowTransitionEvents.missionId),
        )).orderBy(asc(workflowTransitionEvents.createdAt), asc(workflowTransitionEvents.id)).limit(PAGE_SIZE);
      if (epoch !== lifecycle) return;
      const affected = new Map(events.map((event) => [`${event.companyId}:${event.missionId}`, event]));
      let complete = true;
      for (const event of affected.values()) {
        try {
          const [mission] = await db.select({ id: missions.id, companyId: missions.companyId, ownerAgentId: missions.ownerAgentId })
            .from(missions).where(and(eq(missions.id, event.missionId!), eq(missions.companyId, event.companyId),
              inArray(missions.status, ["active", "planning"])));
          if (epoch !== lifecycle) return;
          if (!mission?.ownerAgentId) continue;
          const [oversightIssue] = await db.select({ id: issues.id }).from(issues).where(and(
            eq(issues.companyId, mission.companyId),
            eq(issues.missionId, mission.id),
            eq(issues.originKind, "mission_main_executor_oversight"),
            isNull(issues.hiddenAt),
            not(inArray(issues.status, ["done", "cancelled"])),
          )).orderBy(asc(issues.createdAt)).limit(1);
          if (epoch !== lifecycle) return;
          // Owner-recovery authority is issue-scoped. Do not emit an issue-less wake
          // that can start an agent run but can never read or submit its decision.
          if (!oversightIssue) continue;
          const verdict = await evaluateMissionOversightForMission(db, mission.companyId, mission.id, new Date());
          if (epoch !== lifecycle) return;
          if (verdict?.state !== "FAILURE_OR_RECOVERY_NEEDED" || !verdict.failureEntities?.length) continue;
          const failureEntities = verdict.failureEntities.map(({ kind, id, status, version }) => ({ kind, id, status, version }))
            .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
          const hash = createHash("sha256").update(JSON.stringify(failureEntities)).digest("hex").slice(0, 16);
          const idempotencyKey = `mission-oversight-failure:${mission.id}:${hash}`;
          // Same append-only claim contract as missions/supervision.ts. The partial
          // unique index on (company_id, idempotency_key) arbitrates other processes.
          const claimed = await db.insert(workflowTransitionEvents).values({ companyId: mission.companyId, missionId: mission.id,
            issueId: oversightIssue.id, eventType: WAKE_EVENT, layer: "mission_owner_recovery", idempotencyKey,
            payload: { schemaVersion: 1, kind: WAKE_EVENT, issueId: oversightIssue.id,
              state: verdict.state, reasonCode: verdict.reasonCode, failureEntities },
          }).onConflictDoNothing().returning({ id: workflowTransitionEvents.id });
          if (epoch !== lifecycle) return;
          if (claimed.length) await options.onMissionOversightFailureWakeRequested({ mission, issueId: oversightIssue.id,
            verdict: { state: verdict.state, reasonCode: verdict.reasonCode }, failureEntities, idempotencyKey });
        } catch (err) {
          complete = false;
          logger.warn({ err, companyId: event.companyId, missionId: event.missionId }, "Mission oversight failure lane mission failed");
        }
      }
      if (epoch !== lifecycle || !complete) return;
      const last = events.at(-1);
      if (events.length === PAGE_SIZE && last) cursor = { at: last.at, id: last.id };
      else {
        watermark = last?.at ?? cursor?.at ?? watermark;
        cursor = null;
      }
    } catch (err) {
      logger.warn({ err }, "Mission oversight failure lane tick failed");
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void run(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      lifecycle++; // An already-awaiting tick must not wake an owner after stop.
    },
    run,
  };
}
