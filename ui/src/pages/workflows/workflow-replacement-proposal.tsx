import { useState } from "react";
import { Link } from "@/lib/router";
import type { Approval } from "@paperclipai/shared";
import { proposeReplacementSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { workflowReplacementApi } from "./workflow-replacement-api.js";

export function WorkflowReplacementProposal({ companyId, runId }: { companyId: string; runId: string }) {
  const [decisionEventId, setDecision] = useState("");
  const [key, setKey] = useState("");
  const [metadata, setMetadata] = useState("{}");
  const [reconciled, setReconciled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  async function propose() {
    setPending(true); setError("");
    try {
      if (!reconciled) throw new Error("외부 발행·저장 효과를 확인한 뒤 요청하세요.");
      const input = proposeReplacementSchema.parse({ sourceRunId: runId, decisionEventId, idempotencyKey: key,
        metadata: JSON.parse(metadata), externalEffects: "operator_reconciled" });
      setApproval(await workflowReplacementApi.propose(companyId, input));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  }
  return <details className="rounded border p-3 text-sm"><summary>처음부터 교체 실행 승인 요청</summary>
    <p>보드 운영자 전용입니다. 현재 책임자의 명시적 재시작 결정이 필요합니다. 이 요청은 새 실행을 시작하지 않습니다.</p>
    <p className="break-all">원 실행: {runId}</p>
    <label className="block">책임자 결정 번호<input className="block w-full border" value={decisionEventId} onChange={e => setDecision(e.target.value)} /></label>
    <label className="block">이번 요청의 고유 식별자<input className="block w-full border" value={key} onChange={e => setKey(e.target.value)} /></label>
    <label className="block">승인할 입력 (JSON)<textarea className="block w-full border font-mono" value={metadata} onChange={e => setMetadata(e.target.value)} /></label>
    <label className="block"><input type="checkbox" checked={reconciled} onChange={e => setReconciled(e.target.checked)} />외부 발행·저장·비용 효과를 대사했습니다.</label>
    <button type="button" disabled={pending || !reconciled || !!approval} onClick={() => void propose()}>승인 요청 만들기</button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {approval && <Link to={`/approvals/${approval.id}`}>요청 내용을 검토하고 승인·거절하기</Link>}
  </details>;
}
