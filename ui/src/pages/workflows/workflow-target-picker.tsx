// ui/src/pages/workflows/workflow-target-picker.tsx
//
// [purpose] [workflow child step] 스텝 편집기의 우측 보조 필드(scalar field switch) 전용 모듈
//   (bounded extraction — 승인 경로). (1) StepSecondaryField: 타입별 보조 필드 전환 — 기존
//   tool/agent/else 분기는 승인(A)에 따라 원본 그대로 이식했고, workflow 케이스가 여기 추가됐다.
//   (2) WorkflowTargetPicker: 하위 워크플로 대상 정의 선택기 — 회사 워크플로 목록을 기존 overview
//   훅으로 읽어 자기 자신(self-cycle)을 제외하고, 활성 정의를 우선 나열하며 비활성 정의는 선택
//   불가 옵션으로 표시한다. 자식 실행 완료 대기(wait 고정)/재시도 없음 계약 안내 포함(D1/D2).
// [authority] 표시 전용 — 실행 권위 없음. 대상 id 저장은 스텝 편집기의 1급 draft 필드다.
import { type JSX } from "react";
import { useCompany } from "../../context/CompanyContext.js";
import { useWorkflowOverview } from "./workflow-page-api.js";
import { mutedTextStyle, selectStyle } from "./workflow-page-styles.js";
import { FieldLabel } from "./shared-controls.js";
import { splitCommaList, WorkflowToolPicker } from "./workflow-tool-picker.js";
import type { StepDraft } from "./step-draft.js";
import type { WorkflowToolGrant, WorkflowToolOption } from "./workflow-page-types.js";

function WorkflowTargetPicker({
  value,
  onChange,
  editingWorkflowId,
}: {
  value: string;
  onChange: (next: string) => void;
  editingWorkflowId?: string;
}): JSX.Element {
  const { selectedCompanyId } = useCompany();
  const overview = useWorkflowOverview(selectedCompanyId);
  const workflows = overview.data?.workflows ?? [];
  const candidates = workflows.filter((w) => w.id !== editingWorkflowId);
  const active = candidates.filter((w) => w.status.trim().toLowerCase() === "active");
  const inactive = candidates.filter((w) => w.status.trim().toLowerCase() !== "active");
  return (
    <>
      <FieldLabel help="Child workflow definition this step invokes. The currently edited workflow itself is excluded to prevent self-cycles.">대상 워크플로 (Target Workflow)</FieldLabel>
      <select style={selectStyle} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select workflow —</option>
        {active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        {inactive.map((w) => <option key={w.id} value={w.id} disabled>{w.name} ({w.status})</option>)}
      </select>
      <span style={{ ...mutedTextStyle, fontSize: "11px" }}>
        자식 워크플로 실행 완료까지 대기합니다 (wait 고정). 재시도 없음.
        {!value ? " 저장 시 targetWorkflowId 필수." : ""}
      </span>
    </>
  );
}

/**
 * 타입별 우측 보조 필드. tool/agent/else 분기는 기존 step-editor 렌더링을 행동 동일하게 이식한
 * 것(승인 경로 A)이고, workflow 케이스는 대상 정의 선택기다. 상태 변경은 onPatch 로 호환
 * update() 에 그대로 위임된다(병합 의미 동일).
 */
export function StepSecondaryField({
  step,
  agents,
  availableTools,
  availableToolGrants,
  editingWorkflowId,
  onPatch,
}: {
  step: StepDraft;
  agents: Array<{ id: string; name: string }>;
  availableTools: WorkflowToolOption[];
  availableToolGrants: WorkflowToolGrant[];
  editingWorkflowId?: string;
  onPatch: (patch: Partial<StepDraft>) => void;
}): JSX.Element {
  if (step.type === "workflow") {
    return (
      <WorkflowTargetPicker
        value={step.targetWorkflowId}
        onChange={(next) => onPatch({ targetWorkflowId: next })}
        editingWorkflowId={editingWorkflowId}
      />
    );
  }
  if (step.type === "tool") {
    return (
      <>
        <FieldLabel help="Authorized tool that this tool step runs. The picker only lists tools currently available to workflows.">Tool Name</FieldLabel>
        <WorkflowToolPicker
          value={step.toolName}
          multiple={false}
          tools={availableTools}
          onChange={(value) => onPatch({ toolName: value })}
        />
      </>
    );
  }
  if (step.type === "agent") {
    return (
      <>
        <FieldLabel help="Worker assigned to this step. Changing this also trims tool access to grants for that agent.">Agent</FieldLabel>
        <select style={selectStyle} value={step.agentId || agents.find((a) => a.name === step.agentName)?.id || ""} onChange={(e) => {
          const selectedId = e.target.value;
          const agent = agents.find((a) => a.id === selectedId);
          const newName = agent?.name ?? "";
          const granted = new Set(availableToolGrants.filter((g) => g.agentName === newName).map((g) => g.toolName));
          const cleaned = splitCommaList(step.tools).filter((t) => granted.has(t)).join(", ");
          onPatch({ agentId: selectedId, agentName: newName, tools: cleaned });
        }}>
          <option value="">— Select agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </>
    );
  }
  return (
    <span style={{ ...mutedTextStyle, alignSelf: "end", fontSize: "11px" }}>
      엔진이 직접 실행하며 에이전트나 도구를 호출하지 않습니다.
    </span>
  );
}
