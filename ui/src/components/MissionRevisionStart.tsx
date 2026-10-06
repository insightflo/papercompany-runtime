import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { Button } from "./ui/button";

type Options = { workflowDefinitionId: string; sourceMissionId: string; sourceWorkflowRunId: string | null;
  candidates: { stepId: string; sourceStepId: string; name: string; dependencies: string[] }[];
  blockedUnits?: { unitId: string; label: string; toolName: string | null; code: string; message: string }[] };

export function MissionRevisionStart({ missionId, onStarted }: { missionId: string; onStarted: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const query = useQuery({ queryKey: ["mission-revision-start", missionId],
    queryFn: () => api.get<Options | null>(`/missions/${missionId}/revision-start`) });
  const start = useMutation({ mutationFn: (reuse: boolean) => api.post(`/workflows/${query.data!.workflowDefinitionId}/runs`, {
    missionId, ...(reuse ? { seedFromRun: { sourceWorkflowRunId: query.data!.sourceWorkflowRunId, stepIds: selected } } : {}),
  }), onSuccess: () => { onStarted(); void query.refetch(); } });
  if (query.error) return <p role="alert">수정 미션의 시작 정보를 불러오지 못했습니다: {query.error.message}</p>;
  if (!query.data) return null;
  const options = query.data;
  const closureComplete = selected.every(id => options.candidates.find(c => c.stepId === id)?.dependencies.every(d => selected.includes(d)));
  return <section className="rounded-lg border p-4 space-y-3" aria-label="수정 미션 시작">
    <h3 className="font-medium">계획 검토 완료 · 실행 승인 대기</h3>
    <p className="text-sm text-muted-foreground">원본 실행 ({options.sourceWorkflowRunId ?? "없음"})의 완료된 결과를 선택하거나 새로 실행하세요.
      서버가 원본 파일과 실행 조건을 다시 검사하며, 이전에 실패한 설정을 그대로 실행할 수는 없습니다.</p>
    {options.blockedUnits?.map(unit => <p key={unit.unitId} role="status" className="text-sm text-muted-foreground">
      {unit.label} · 실행 차단({unit.code}) — {unit.message}{unit.toolName ? ` (도구: ${unit.toolName})` : ""}
      요청한 필수 결과는 이 계획에서 미해결로 남습니다.</p>)}
    {options.candidates.map(c => <label key={c.stepId} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={selected.includes(c.stepId)} disabled={start.isPending}
        onChange={e => setSelected(ids => e.target.checked ? [...ids, c.stepId] : ids.filter(id => id !== c.stepId))} />
      {c.name} · 원본 단계 ({c.sourceStepId}) · 재사용 후보
    </label>)}
    <p className="text-sm text-muted-foreground">선택하지 않은 단계는 새로 실행(재실행)되며, 차단 단위는 실행되지 않습니다.</p>
    {!closureComplete && <p role="alert">선택한 단계의 선행 단계도 함께 선택해 주세요.</p>}
    {start.error && <p role="alert">실행이 거절되었습니다: {start.error.message}</p>}
    <div className="flex gap-2">
      <Button disabled={start.isPending || !selected.length || !closureComplete} onClick={() => start.mutate(true)}>선택한 결과 재사용하여 시작</Button>
      <Button variant="outline" disabled={start.isPending} onClick={() => start.mutate(false)}>재사용 없이 새로 시작</Button>
    </div>
  </section>;
}
