import { z } from "zod";

/**
 * 전략 플레이북 항목 검증 (쇼츠 컴퍼니 Phase F).
 *
 * - channel 은 'knowledge' | 'shopping' 만 허용 (enum 컬럼 대신 text + 검증).
 * - status 는 'proposed' | 'active' | 'retired' (text + 검증).
 * - conditionJson/actionJson 은 구조가 자유롭더라도 반드시 JSON 객체여야 한다.
 * - 생성 스키마에는 status 가 없다: 서버가 항상 status='proposed' 로 강제 생성하고,
 *   요청에 status 를 실어 오면 strict 모드로 거부된다(무시하지 않고 명시적으로 422).
 * - 갱신 스키마는 status 전이만 허용한다. 전이 방향(proposed→active, active→retired,
 *   보드 전용 여부) 검증은 라우트/서비스가 담당한다.
 */

export const strategyPlaybookChannelSchema = z.enum(["knowledge", "shopping"]);

export const strategyPlaybookStatusSchema = z.enum(["proposed", "active", "retired"]);

export const strategyPlaybookCreateProposalSchema = z
  .object({
    channel: strategyPlaybookChannelSchema,
    triggerType: z.string().min(1),
    conditionJson: z.record(z.unknown()),
    actionType: z.string().min(1),
    actionJson: z.record(z.unknown()),
    evidenceRefs: z.array(z.string()).default([]),
  })
  .strict();

export const strategyPlaybookUpdateSchema = z
  .object({
    status: strategyPlaybookStatusSchema,
  })
  .strict();

export type StrategyPlaybookCreateProposalInput = z.infer<typeof strategyPlaybookCreateProposalSchema>;

export type StrategyPlaybookUpdateInput = z.infer<typeof strategyPlaybookUpdateSchema>;
