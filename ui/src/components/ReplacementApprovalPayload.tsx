import { replacementApprovalPayloadSchema } from "@paperclipai/shared/validators/workflow-replacement";

export function ReplacementApprovalPayload({ payload }: { payload: Record<string, unknown> }) {
  const parsed = replacementApprovalPayloadSchema.safeParse(payload);
  if (!parsed.success) return <p className="text-destructive">교체 승인 정보가 유효하지 않습니다. 승인하지 말고 수정 요청하세요.</p>;
  const p = parsed.data;
  const fields = [
    ["원 실행", p.sourceRunId], ["예약된 새 실행", p.targetRunId], ["미션", p.missionId], ["워크플로우 정의", p.workflowId],
    ["실패 단계", p.stepRunId], ["현재 실패 세대 / 권한 버전", `${p.requestGeneration} / ${p.sourceAuthorityVersion}`],
    ["책임자 결정", p.decisionEventId], ["종결 결정", p.terminalDecisionId], ["요청 식별자", p.idempotencyKey],
    ["입력 식별 해시 (SHA256)", p.inputHash], ["정의 식별 해시 (SHA256)", p.definitionHash],
    ["외부 효과", "운영자가 대사 완료로 제출함 — 외부 상태 자동 검증 아님"],
  ];
  return <section className="mt-3 space-y-2 text-sm" aria-label="교체 실행 승인 범위">
    <p>실패한 원 실행은 변경하지 않습니다. 새 입력·정의·대상을 한 번만 승인합니다.</p>
    <dl className="space-y-1">{fields.map(([label, value]) => <div key={label}>
      <dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all font-mono text-xs">{value}</dd>
    </div>)}</dl>
    <details><summary>승인할 입력 보기</summary><pre className="overflow-auto text-xs">{JSON.stringify(p.metadata, null, 2)}</pre></details>
  </section>;
}
