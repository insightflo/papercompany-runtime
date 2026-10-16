import { activityLog, type Db } from "@paperclipai/db";
import { workProductSelectorsSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { loadExecutionDefinition } from "../workflow/execution-definition.js";

/**
 * [파일 목적] 산출물 소비 하드닝 2a — 등록 대표(isPrimary) 미지정 해석의 ①계약 부합 판정과
 *   승격 감사 기록. createForIssue 본문 변경을 최소화하기 위해 판정 로직만 이 모듈에 둔다.
 * [계약] 등록은 늘 성공해야 한다 — 정의 로드 실패·형태 불일치는 등록 실패가 아니라 미부합이다.
 *   위임(delegation) 등록은 원본 미러 의미 보존을 위해 호출부(createForIssue)에서 ① 대상에서 제외한다.
 * [수정시 주의] selector 값 스키마는 @paperclipai/shared workProductSelectorsSchema 와 동일 기준으로
 *   검증하며, 부합은 type·title 문자열 정확 일치만 인정한다(접두·정규화 매칭 금지).
 */

export const CONTRACT_PROMOTION_SCHEMA_VERSION = "workflow.workproduct-contract-promotion.v1";

export interface ContractPromotionMatch {
  producerStepId: string;
  workflowRunId: string;
  selector: { type: string; title: string };
}

/**
 * 이 등록을 봉인한 producer의 런 실행 정의에서 소비자 선택 규칙이 이 산출물을 정확 지목하는지.
 * 임의 step의 workProductSelectors[producerStepId] 값이 { type, title } 과 정확 일치하면 부합.
 */
export async function matchWorkProductContractPromotion(
  db: Pick<Db, "select">,
  input: { workflowRunId: string; producerStepId: string; type: string; title: string },
): Promise<ContractPromotionMatch | null> {
  try {
    const definition = await loadExecutionDefinition(db, input.workflowRunId, { requireHistorical: false });
    for (const step of definition.steps) {
      const selectors = workProductSelectorsSchema.safeParse(
        (step as { workProductSelectors?: unknown }).workProductSelectors ?? {},
      );
      if (!selectors.success) continue;
      const selector = selectors.data[input.producerStepId];
      if (selector && selector.type === input.type && selector.title === input.title) {
        return { producerStepId: input.producerStepId, workflowRunId: input.workflowRunId, selector };
      }
    }
    return null;
  } catch {
    // 정의 로드 실패·형태 불일치는 미부합 — 등록 계약(자동 등록은 늘 성공)을 지킨다.
    return null;
  }
}

/** ① 승격이 실제 확정(대표 INSERT 성공)된 뒤 같은 트랜잭션에서 감사 1건을 남긴다. */
export async function recordContractPromotionAudit(db: Pick<Db, "insert">, input: {
  companyId: string;
  workProductId: string;
  match: ContractPromotionMatch;
}): Promise<void> {
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "workproduct-contract-promotion",
    action: "workflow.workproduct_contract_promotion",
    entityType: "issue_work_product",
    entityId: input.workProductId,
    details: {
      schemaVersion: CONTRACT_PROMOTION_SCHEMA_VERSION,
      producerStepId: input.match.producerStepId,
      workflowRunId: input.match.workflowRunId,
      selector: { type: input.match.selector.type, title: input.match.selector.title },
    },
  });
}
