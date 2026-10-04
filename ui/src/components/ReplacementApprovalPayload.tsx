import { replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { L, useCompanyLanguage } from "../lib/companyLanguage";

export function ReplacementApprovalPayload({ payload }: { payload: Record<string, unknown> }) {
  const lang = useCompanyLanguage();
  const parsed = replacementApprovalPayloadSchema.safeParse(payload);
  if (!parsed.success) return <p className="text-destructive">{L(lang, { en: "Invalid replacement approval information. Request a revision instead of approving.", ko: "교체 승인 정보가 유효하지 않습니다. 승인하지 말고 수정 요청하세요." })}</p>;
  const p = parsed.data;
  const fields = [
    [L(lang, { en: "Original run", ko: "원 실행" }), p.sourceRunId], [L(lang, { en: "Reserved replacement run", ko: "예약된 새 실행" }), p.targetRunId], [L(lang, { en: "Mission", ko: "미션" }), p.missionId], [L(lang, { en: "Workflow definition", ko: "워크플로우 정의" }), p.workflowId],
    [L(lang, { en: "Failed step", ko: "실패 단계" }), p.stepRunId], [L(lang, { en: "Current failed generation / authority version", ko: "현재 실패 세대 / 권한 버전" }), `${p.requestGeneration} / ${p.sourceAuthorityVersion}`],
    [L(lang, { en: "Owner decision", ko: "책임자 결정" }), p.decisionEventId], [L(lang, { en: "Terminal decision", ko: "종결 결정" }), p.terminalDecisionId], [L(lang, { en: "Request identifier", ko: "요청 식별자" }), p.idempotencyKey],
    [L(lang, { en: "Input hash (SHA256)", ko: "입력 식별 해시 (SHA256)" }), p.inputHash], [L(lang, { en: "Definition hash (SHA256)", ko: "정의 식별 해시 (SHA256)" }), p.definitionHash],
    [L(lang, { en: "External effects", ko: "외부 효과" }), L(lang, { en: "Operator submitted reconciliation complete — not automatic external-state verification", ko: "운영자가 대사 완료로 제출함 — 외부 상태 자동 검증 아님" })],
  ];
  return <section className="mt-3 space-y-2 text-sm" aria-label="교체 실행 승인 범위">
    <p>{L(lang, { en: "The failed original run is unchanged. Approve the new inputs, definition and target once only.", ko: "실패한 원 실행은 변경하지 않습니다. 새 입력·정의·대상을 한 번만 승인합니다." })}</p>
    <dl className="space-y-1">{fields.map(([label, value]) => <div key={label}>
      <dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all font-mono text-xs">{value}</dd>
    </div>)}</dl>
    <details><summary>{L(lang, { en: "View inputs to approve", ko: "승인할 입력 보기" })}</summary><pre className="overflow-auto text-xs">{JSON.stringify(p.metadata, null, 2)}</pre></details>
  </section>;
}
