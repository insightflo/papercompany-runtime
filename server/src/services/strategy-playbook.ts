/**
 * Strategy Playbook Store (쇼츠 컴퍼니 Phase F)
 *
 * 전략 플레이북 항목(strategy_playbook_entries)의 저장/조회/상태 전이.
 * - create 는 항상 status='proposed' 로만 만든다 (활성화는 별도 보드 전용 전이).
 * - 전이 규칙: proposed→active (activatedAt 기록), active→retired (retiredAt 기록).
 *   그 외 전이(같은 상태 재설정, proposed→retired, retired 재활성 등)는 모두 거부한다.
 * - 보드 전용 여부(agent 키 금지)는 라우트가 담당하고, 스토어는 상태 기계만 지킨다.
 */

import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { strategyPlaybookEntries } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";

export type StrategyPlaybookRow = typeof strategyPlaybookEntries.$inferSelect;

export interface CreateStrategyPlaybookEntryInput {
  companyId: string;
  channel: string;
  triggerType: string;
  conditionJson: Record<string, unknown>;
  actionType: string;
  actionJson: Record<string, unknown>;
  evidenceRefs: string[];
  proposedByAgentId: string | null;
}

export interface ListStrategyPlaybookFilter {
  status?: string;
  channel?: string;
}

/** 허용되는 상태 전이 맵. 키 "from→to". */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set(["proposed->active", "active->retired"]);

export function strategyPlaybookStore(db: Db) {
  /**
   * list — 회사 스코프 전체 목록 (기본 최신 생성 순).
   */
  async function list(companyId: string, filter: ListStrategyPlaybookFilter = {}): Promise<StrategyPlaybookRow[]> {
    const conditions = [eq(strategyPlaybookEntries.companyId, companyId)];
    if (filter.status !== undefined) {
      conditions.push(eq(strategyPlaybookEntries.status, filter.status));
    }
    if (filter.channel !== undefined) {
      conditions.push(eq(strategyPlaybookEntries.channel, filter.channel));
    }
    return await db
      .select()
      .from(strategyPlaybookEntries)
      .where(and(...conditions))
      .orderBy(desc(strategyPlaybookEntries.createdAt));
  }

  /**
   * getById — 단일 행 조회. 없으면 404.
   */
  async function getById(id: string): Promise<StrategyPlaybookRow> {
    const rows = await db
      .select()
      .from(strategyPlaybookEntries)
      .where(eq(strategyPlaybookEntries.id, id))
      .limit(1);
    if (rows.length === 0) {
      throw notFound(`Strategy playbook entry not found: ${id}`);
    }
    return rows[0];
  }

  /**
   * create — 제안 생성. status 는 입력과 무관하게 항상 'proposed' 로 강제한다.
   */
  async function create(input: CreateStrategyPlaybookEntryInput): Promise<StrategyPlaybookRow> {
    const [row] = await db
      .insert(strategyPlaybookEntries)
      .values({
        companyId: input.companyId,
        channel: input.channel,
        triggerType: input.triggerType,
        conditionJson: input.conditionJson,
        actionType: input.actionType,
        actionJson: input.actionJson,
        evidenceRefs: input.evidenceRefs,
        status: "proposed",
        proposedByAgentId: input.proposedByAgentId,
      })
      .returning();
    return row;
  }

  /**
   * transition — 상태 전이. 허용 전이만 성공하고 activatedAt/retiredAt 를 기록한다.
   */
  async function transition(
    id: string,
    targetStatus: "proposed" | "active" | "retired",
  ): Promise<StrategyPlaybookRow> {
    const existing = await getById(id);
    const key = `${existing.status}->${targetStatus}`;
    if (!ALLOWED_TRANSITIONS.has(key)) {
      throw conflict(
        `Invalid strategy playbook status transition: ${existing.status} -> ${targetStatus}`,
      );
    }

    const now = new Date();
    const [updated] = await db
      .update(strategyPlaybookEntries)
      .set({
        status: targetStatus,
        activatedAt: targetStatus === "active" ? now : existing.activatedAt,
        retiredAt: targetStatus === "retired" ? now : existing.retiredAt,
        updatedAt: now,
      })
      .where(eq(strategyPlaybookEntries.id, id))
      .returning();
    return updated;
  }

  return { list, getById, create, transition };
}

export type StrategyPlaybookStore = ReturnType<typeof strategyPlaybookStore>;
