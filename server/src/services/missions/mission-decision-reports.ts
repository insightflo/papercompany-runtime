import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, MissionRollingDecisionRecord } from "@paperclipai/db";
import { missionRollingState } from "@paperclipai/db";
import { unprocessable } from "../../errors.js";
import { buildMissionStateMarkdown, mergeDecisionRecords } from "./mission-runtime-manager.js";

/**
 * [결정 보고 API — A안 후속 생산자 2026-09-05]
 * A안(#193)이 만든 롤링 상태 결정 로그(decisions)는 핸드오프 파이프라인만 있고
 * 생산자가 없어 늘 비어 있었다. 이 모듈이 그 직접 생산자다: 에이전트/보드가
 * 구조화된 결정 보고(zod 계약)를 POST 하면 런타임이 결정론적으로
 * mergeDecisionRecords 로 롤링 상태에 반영한다(SKILL.state 분업 유지).
 *
 * 규칙 8 준수: 결정 로그는 다음 에이전트에게 맥락을 전달하는 상태일 뿐,
 * 실행 통제(retry/complete/branch/QA 판정)의 권위가 아니다. 실행 통제 코드는
 * 이 테이블을 읽어 판단하지 않는다. 실행 통계(totalRuns/lastRunId 등)는
 * 런이 아니므로 건드리지 않는다.
 */
export const MISSION_DECISION_REPORT_MAX_UPDATES = 20;

const decisionUpdateSchema = z.object({
  id: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(2000).optional(),
  status: z.enum(["confirmed", "under_review", "retired"]).optional(),
  supersedes: z.string().trim().min(1).max(100).nullable().optional(),
});

export const missionDecisionReportSchema = z.object({
  updates: z.array(decisionUpdateSchema).min(1).max(MISSION_DECISION_REPORT_MAX_UPDATES),
});

export type MissionDecisionReportInput = z.infer<typeof missionDecisionReportSchema>;

export type MissionDecisionReportResult = {
  missionId: string;
  revision: number;
  updatedAt: string;
  appliedUpdates: number;
  decisions: MissionRollingDecisionRecord[];
  stateMarkdown: string;
};

export type MissionDecisionLogView = {
  missionId: string;
  revision: number;
  updatedAt: string;
  decisions: MissionRollingDecisionRecord[];
  stateMarkdown: string;
};

/**
 * 결정 보고를 롤링 상태에 반영한다.
 * - 입력은 zod 계약으로 검증(실패=422, DB 미접촉).
 * - 병합은 기존 mergeDecisionRecords 재사용(신규 under_review 기본, supersedes→retired 잔류, cap 50).
 * - 직접 보고 기록의 출처 handoffId 는 null(핸드오프가 아니라 API 보고).
 * - 실행 계정(totalRuns/lastRunId/토큰/비용)은 변경하지 않는다.
 */
export async function applyMissionDecisionReports(
  db: Db,
  input: { companyId: string; missionId: string; updates: unknown; now?: Date },
): Promise<MissionDecisionReportResult> {
  const parsed = missionDecisionReportSchema.safeParse({ updates: input.updates });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw unprocessable(`Invalid mission decision report: ${issues}`);
  }
  const now = input.now ?? new Date();
  const existing = await db
    .select()
    .from(missionRollingState)
    .where(eq(missionRollingState.missionId, input.missionId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const previousState = existing?.stateJson ?? {};
  const decisions = mergeDecisionRecords(previousState.decisions, parsed.data.updates, {
    handoffId: null,
    now,
  });
  const nextState = { ...previousState, decisions };
  const stateMarkdown = buildMissionStateMarkdown({ missionId: input.missionId, state: nextState });

  const [row] = await db
    .insert(missionRollingState)
    .values({
      companyId: input.companyId,
      missionId: input.missionId,
      revision: 1,
      status: "active",
      stateJson: nextState,
      stateMarkdown,
      lastCompactedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: missionRollingState.missionId,
      set: {
        revision: sql`${missionRollingState.revision} + 1`,
        status: "active",
        stateJson: nextState,
        stateMarkdown,
        updatedAt: now,
      },
    })
    .returning();

  return {
    missionId: row.missionId,
    revision: row.revision,
    updatedAt: (row.updatedAt ?? now).toISOString(),
    appliedUpdates: parsed.data.updates.length,
    decisions,
    stateMarkdown,
  };
}

/** 결정 로그 읽기(보드/에이전트 소비면). 행이 없으면 null. */
export async function getMissionDecisionLog(db: Db, input: { missionId: string }): Promise<MissionDecisionLogView | null> {
  const row = await db
    .select()
    .from(missionRollingState)
    .where(eq(missionRollingState.missionId, input.missionId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  return {
    missionId: row.missionId,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    decisions: row.stateJson.decisions ?? [],
    stateMarkdown: row.stateMarkdown,
  };
}
