// ui/src/components/MissionRevisionActions.tsx
//
// [purpose] 미션 상세의 수정 액션 묶음 — 기존 "새 미션으로 수정"(신규 미션 사전 채움)과
//   새 "이 실행 이어서 진행"(실물 MissionResumeDialog)을 한 컴포넌트로 제공한다.
// [계약] 이어서 진행 버튼은 회사 미선택 또는 실행 기록 없음일 때만 비활성화한다.
//   미션 status로 재개 가능 여부를 추측하지 않는다. 재개 가능 여부는 서버 preview가 유일하게 판정한다.
import { useState } from "react";
import { GitBranch, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MissionStatus, MissionWorkflowRun } from "../api/missions";
import { buildMissionRevisionPrefill } from "../lib/missionRevisionRequest";
import { MissionResumeDialog } from "./MissionResumeDialog";

export interface MissionRevisionMission {
  id: string;
  title: string;
  ownerAgentId: string;
  status: MissionStatus;
}

interface MissionRevisionActionsProps {
  companyId: string | null;
  mission: MissionRevisionMission;
  workflowRuns: MissionWorkflowRun[];
  /**
   * 신규 미션 링크의 origin. 미지정 시 클릭 시점에 window.location.origin을 사용한다.
   * 렌더 시점 평가를 피해 node SSR(renderToStaticMarkup) 환경에서도 안전하게 한다.
   */
  origin?: string;
  issuePrefix?: string | null;
  onNewMission: (defaults: ReturnType<typeof buildMissionRevisionPrefill>) => void;
}

export function MissionRevisionActions({
  companyId,
  mission,
  workflowRuns,
  origin,
  issuePrefix,
  onNewMission,
}: MissionRevisionActionsProps) {
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  // 혼합 빌드 방어: 예상치 못한 non-array 입력은 실행 기록 없음과 동일하게 처리한다.
  const runs = Array.isArray(workflowRuns) ? workflowRuns : [];
  const resumeDisabled = !companyId || runs.length === 0;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => {
          // [수정 요청 미션] 원본 맥락(링크·산출물·오너)을 사전 채운 신규 미션 생성 다이얼로그.
          onNewMission(
            buildMissionRevisionPrefill({
              mission: { id: mission.id, title: mission.title, ownerAgentId: mission.ownerAgentId },
              workflowRuns: runs,
              origin: origin ?? window.location.origin,
              issuePrefix,
            }),
          );
        }}
      >
        <RotateCcw className="mr-1 h-3.5 w-3.5" /> 새 미션으로 수정
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={resumeDisabled}
        title={resumeDisabled ? "회사 선택과 실행 기록이 필요합니다." : undefined}
        onClick={() => setResumeDialogOpen(true)}
      >
        <GitBranch className="mr-1 h-3.5 w-3.5" /> 이 실행 이어서 진행
      </Button>
      {companyId && (
        <MissionResumeDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          companyId={companyId}
          missionId={mission.id}
          missionTitle={mission.title}
          workflowRuns={runs}
        />
      )}
    </>
  );
}
