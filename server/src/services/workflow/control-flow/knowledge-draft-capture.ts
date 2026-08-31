// server/src/services/workflow/control-flow/knowledge-draft-capture.ts
//
// [purpose] P1 — 반복 QA 기계 교정 → 지식 패턴 카드 자동 초안. 기계적 remediation 루프가
//   동일 결함 서명(string_replace find→replace 쌍의 sha256)을 lookback 기간 내 2회째 적용하는
//   순간, company_knowledge_patterns에 failure_mode 초안 카드(source='auto_rework_draft',
//   status='draft')를 생성한다. 사람 승인(approve) 전까지 검색/주입 어디에도 노출되지 않는다.
//
// [authority] 서명과 발생 횟수는 오직 기계 레코드 — qa_remediation_applied 전이 이벤트의
//   payload.signatures(머신 생성 해시 배열)에서만 계산한다. 프로즈/코멘트/stdout 파싱 없음(규칙 8).
//
// [safety — 규칙 7 실행통제 영향 0]
//   - 호출부(qa-remediation.tryQaRemediationPass)는 모든 제어 판정(applied/waiting/not_applicable)이
//     끝난 뒤 이벤트 기록 이후에 이 모듈을 fire-and-forget으로 호출한다.
//   - 이 모듈의 모든 실패는 호출부의 try/catch에서 로그로 소화된다. 재작업 경로/반환값/이벤트
//     기록에 영향을 줄 수 없다(초안 생성은 부수 기록일 뿐).
//   - 초안 생성은 (company_id, defect_signature) 부분 유일 인덱스로 idempotent — 같은 서명
//     재감지에도 카드는 하나뿐이다.

import { createHash } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowTransitionEvents } from "@paperclipai/db";
import { knowledgePatternsService } from "../../knowledge-patterns.js";

/** 서명 발생 집계 lookback — 이 기간 내 반복만 "같은 결함의 재발"로 인정한다. */
export const REMEDIATION_SIGNATURE_LOOKBACK_DAYS = 30;
/** 초안 생성 임계값 — lookback 내 2회째 적용부터 초안(선례: "같은 교정 50번 반복" 캡처 갭). */
export const AUTO_DRAFT_MIN_OCCURRENCES = 2;
/** 발생 집계 스캔 상한 — 기계 교정은 저빈도 이벤트라 실제로 크게 여유 있는 상한. */
const PRIOR_EVENT_SCAN_LIMIT = 500;

/** 결함 서명 — 동일 문자열 교정(find→replace)의 결정론적 해시. 머신 생성 규약 v1. */
export function computeDefectSignature(find: string, replace: string): string {
  return createHash("sha256").update(`${find}\n-->\n${replace}`, "utf8").digest("hex");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 과거 적용 이벤트들의 payload.signatures에서 해당 서명의 발생 횟수.
 *  이번 패스가 방금 기록한 이벤트(sourceVerdictEventId 일치)는 선행 발생에서 제외한다 —
 *  그렇지 않으면 첫 적용이 곧 2회째로 집계되는 자기포함 버그가 생긴다. */
async function countPriorOccurrences(
  db: Db,
  companyId: string,
  eventType: string,
  signature: string,
  excludeSourceVerdictEventId: string,
): Promise<number> {
  const since = new Date(Date.now() - REMEDIATION_SIGNATURE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const events = await db
    .select({ payload: workflowTransitionEvents.payload })
    .from(workflowTransitionEvents)
    .where(and(
      eq(workflowTransitionEvents.companyId, companyId),
      eq(workflowTransitionEvents.eventType, eventType),
      eq(workflowTransitionEvents.decision, "mechanical_remediation_applied"),
      gte(workflowTransitionEvents.createdAt, since),
    ))
    .orderBy(desc(workflowTransitionEvents.createdAt))
    .limit(PRIOR_EVENT_SCAN_LIMIT);
  let occurrences = 0;
  for (const event of events) {
    const payload = event.payload as { signatures?: unknown; sourceVerdictEventId?: unknown } | null;
    if (payload?.sourceVerdictEventId === excludeSourceVerdictEventId) continue;
    const signatures = payload?.signatures;
    if (Array.isArray(signatures) && signatures.includes(signature)) occurrences += 1;
  }
  return occurrences;
}

export interface MechanicalReworkCaptureInput {
  readonly db: Db;
  readonly companyId: string;
  /** qa_remediation_applied 이벤트 타입 상수(호출부 소유 — 순환 import 방지). */
  readonly remediationEventType: string;
  readonly producerStepId: string;
  readonly qaStepId: string;
  readonly sourceVerdictEventId: string;
  readonly items: ReadonlyArray<{ readonly find: string; readonly replace: string }>;
}

/**
 * [purpose] 적용된 기계 교정 항목의 결함 서명을 집계하고, lookback 내 2회째면 초안 카드를 만든다.
 *   던지지 않는다를 보장하지 않으므로 호출부가 try/catch로 감싸 비차단 유지한다.
 */
export async function captureMechanicalReworkPatterns(input: MechanicalReworkCaptureInput): Promise<void> {
  if (input.items.length === 0) return;
  const svc = knowledgePatternsService(input.db);
  const seenSignatures = new Set<string>();
  for (const item of input.items) {
    const signature = computeDefectSignature(item.find, item.replace);
    if (seenSignatures.has(signature)) continue;
    seenSignatures.add(signature);

    const prior = await countPriorOccurrences(
      input.db,
      input.companyId,
      input.remediationEventType,
      signature,
      input.sourceVerdictEventId,
    );
    const occurrences = prior + 1;
    if (occurrences < AUTO_DRAFT_MIN_OCCURRENCES) continue;

    const title = truncate(`반복 기계 교정: ${oneLine(item.find)}`, 200);
    const summary = [
      `QA 기계적 교정(remediation)이 동일 결함 서명으로 최근 ${REMEDIATION_SIGNATURE_LOOKBACK_DAYS}일 내 ${occurrences}회 적용됐다.`,
      `생산자가 같은 결함을 재생성하고 있다는 기계 신호다. 자동 초안 — 사람 검수 후 활성화 필요.`,
      `producer=${input.producerStepId} qa=${input.qaStepId}`,
    ].join(" ");
    await svc.createAutoReworkDraft({
      companyId: input.companyId,
      signature,
      title,
      summary,
      symptoms: truncate(item.find, 500),
      whatWorked: truncate(item.replace, 500),
      evidence: [{
        type: "transition_event",
        id: input.sourceVerdictEventId,
        note: `qa mechanical remediation ${occurrences}회차`,
      }],
    });
  }
}
