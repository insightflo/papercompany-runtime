// ui/src/components/MissionResumeDialog.tsx
// [purpose] 운영자가 기존 실행(run)과 그 run의 실제 단계(step)를 골라 POST /workflow-resume-requests로
//   재개 요청을 보내는 실물 다이얼로그. 범위 변경·재오픈 시 이전 preview·요청·오류를 지워 stale POST를 막고,
//   idempotencyKey는 본문 확정 시점에 한 번만 생성하며, 불확실한 네트워크 오류 시 같은 본문·키로만 재시도한다.
//   구 엔드포인트(/workflow-runs/:id/resume) fallback 없음.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { workflowResumeApi } from "../api/workflow-resume";
import type { MissionWorkflowRun } from "../api/missions";
import type { ResumePreview, ResumeRequestView } from "@paperclipai/shared/types/workflow-resume";
import { resumeRequestSchema } from "@paperclipai/shared/validators/workflow-resume";
import type { ResumeRequestBody } from "@paperclipai/shared/validators/workflow-resume";
import { queryKeys } from "../lib/queryKeys";
import { MissionResumePreviewReport } from "./MissionResumePreviewReport";
import { MissionResumeRequestStatus } from "./MissionResumeRequestStatus";
import {
  describeApplyError,
  isSnapshotExpired,
  newIdempotencyKey,
} from "./mission-resume-dialog-utils";

const REASON_MAX_LENGTH = 2000;
const REQUEST_POLL_INTERVAL_MS = 2000;
const PRESERVATION_NOTE = "완료된 작업은 보존하며, 필요한 게시 승인은 별도로 진행합니다.";

interface MissionResumeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  missionId: string;
  missionTitle: string;
  workflowRuns: MissionWorkflowRun[];
}

export function MissionResumeDialog({
  open,
  onOpenChange,
  companyId,
  missionId,
  missionTitle,
  workflowRuns,
}: MissionResumeDialogProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [frozenBody, setFrozenBody] = useState<ResumeRequestBody | null>(null);
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const queryClient = useQueryClient();

  const previewMutation = useMutation({
    mutationFn: (scope: { workflowRunId: string; startStepId: string }) =>
      workflowResumeApi.preview(companyId, missionId, scope.workflowRunId, scope.startStepId),
  });

  const requestQuery = useQuery({
    queryKey: ["mission-workflow-resume-request", companyId, missionId, createdRequestId],
    queryFn: () => workflowResumeApi.getRequest(companyId, missionId, createdRequestId as string),
    enabled: createdRequestId !== null,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === "pending_delivery" ? REQUEST_POLL_INTERVAL_MS : false,
  });

  // readback이 도메인 뷰일 때만 사용(혼합 빌드/기타 데이터 방어). 요청 응답은 반환된 id가 있을 때만 조회한다.
  const requestView: ResumeRequestView | null =
    requestQuery.data && typeof requestQuery.data.state === "string" && typeof requestQuery.data.id === "string"
      ? requestQuery.data
      : null;

  useEffect(() => {
    if (requestView?.state === "accepted") {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(missionId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.workflowRuns(missionId) });
    }
  }, [requestView, missionId, queryClient]);

  const runs = Array.isArray(workflowRuns) ? workflowRuns : [];
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const applyMutation = useMutation({
    mutationFn: (body: ResumeRequestBody) => workflowResumeApi.createRequest(companyId, missionId, body),
    onSuccess: (view) => {
      setApplyError(null);
      setCreatedRequestId(view.id);
    },
    onError: (error) => setApplyError(describeApplyError(error)),
  });

  const preview = previewMutation.data ?? null;
  // 스냅샷은 정확히 선택된 범위에만 유효 — 선택이 바뀌면 이전 preview는 표시/확정할 수 없다.
  const visiblePreview = preview && preview.workflowRunId === selectedRunId && preview.startStepId === selectedStepId ? preview : null;
  const busy = previewMutation.isPending || applyMutation.isPending;
  const requestInFlight = requestView?.state === "pending_delivery";
  const snapshotExpired = visiblePreview ? isSnapshotExpired(visiblePreview) : false;
  const canConfirm =
    visiblePreview !== null &&
    visiblePreview.eligible &&
    !!visiblePreview.snapshotToken &&
    !snapshotExpired &&
    reason.trim().length > 0 &&
    !busy &&
    !requestInFlight;

  function clearStaleAttemptState() {
    setFrozenBody(null);
    setCreatedRequestId(null);
    setApplyError(null);
    previewMutation.reset();
  }

  // 닫힘(사용자 닫기/부모에 의한 제어 닫기 모두) 시 이전 preview·요청·오류·사유를 지워 stale POST를 막는다.
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (!open && wasOpenRef.current) {
      setSelectedRunId(null);
      setSelectedStepId(null);
      setReason("");
      clearStaleAttemptState();
    }
    wasOpenRef.current = open;
  }, [open]);

  function handleRunChange(nextRunId: string) {
    setSelectedRunId(nextRunId);
    setSelectedStepId(null);
    clearStaleAttemptState();
  }

  function handleStepChange(nextStepId: string) {
    setSelectedStepId(nextStepId);
    clearStaleAttemptState();
  }

  function handlePreview() {
    if (!selectedRunId || !selectedStepId) return;
    clearStaleAttemptState();
    previewMutation.mutate({ workflowRunId: selectedRunId, startStepId: selectedStepId });
  }

  function handleConfirm() {
    if (!canConfirm || !visiblePreview?.snapshotToken || !selectedRunId || !selectedStepId) return;
    // 본문(idempotencyKey 포함)은 확정 시점에 정확히 한 번 만들어 고정한다.
    const body: ResumeRequestBody = frozenBody ?? {
      schemaVersion: 1,
      mode: "resume_from_step",
      companyId,
      missionId,
      workflowRunId: selectedRunId,
      startStepId: selectedStepId,
      snapshotToken: visiblePreview.snapshotToken,
      idempotencyKey: newIdempotencyKey(),
      reason: reason.trim(),
    };
    const parsed = resumeRequestSchema.safeParse(body);
    if (!parsed.success) {
      setApplyError({
        message: "재개 요청 본문이 공유 계약(resumeRequestSchema)을 만족하지 않습니다.",
        uncertain: false,
      });
      return;
    }
    if (!frozenBody) setFrozenBody(parsed.data);
    applyMutation.mutate(parsed.data);
  }

  /** 불확실한 네트워크 오류 이후에만 노출 — 자동 재시도 없음, 동일 본문/키 재사용. */
  function handleRetry() {
    if (!frozenBody) return;
    applyMutation.mutate(frozenBody);
  }

  function handleReasonChange(next: string) {
    setReason(next);
    if (frozenBody) {
      // 사유가 바뀌면 본문이 달라지므로 이전 시도(키 포함)는 재사용할 수 없다.
      setFrozenBody(null);
      setApplyError(null);
    }
  }

  // 닫힘 시 미렌더(node SSR·혼합 빌드 안전).
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>이 실행 이어서 진행</DialogTitle>
          <DialogDescription>
            {missionTitle ? `${missionTitle} — ` : ""}
            기존 워크플로 실행의 단계부터 재개 요청을 만듭니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="mission-resume-run" className="text-xs font-medium text-muted-foreground">
                재개할 실행
              </label>
              <select
                id="mission-resume-run"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
                value={selectedRunId ?? ""}
                disabled={busy}
                onChange={(event) => handleRunChange(event.target.value)}
              >
                <option value="">실행 선택…</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.workflowName ?? run.id} ({run.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mission-resume-step" className="text-xs font-medium text-muted-foreground">
                시작 단계
              </label>
              <select
                id="mission-resume-step"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
                value={selectedStepId ?? ""}
                disabled={busy || !selectedRun}
                onChange={(event) => handleStepChange(event.target.value)}
              >
                <option value="">단계 선택…</option>
                {(selectedRun?.steps ?? []).map((step) => (
                  <option key={step.stepId} value={step.stepId}>
                    {step.name} ({step.status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePreview}
              disabled={busy || !selectedRunId || !selectedStepId}
            >
              재개 범위 확인
            </Button>
            {!visiblePreview && (
              <p className="text-xs text-muted-foreground">실행과 단계를 선택하고 재개 범위를 확인하세요.</p>
            )}
          </div>

          {visiblePreview && <MissionResumePreviewReport preview={visiblePreview} expired={snapshotExpired} />}

          <div className="space-y-1.5">
            <label htmlFor="mission-resume-reason" className="text-xs font-medium text-muted-foreground">
              재개 사유 (필수, 최대 2000자)
            </label>
            <Textarea
              id="mission-resume-reason"
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              disabled={busy}
              onChange={(event) => handleReasonChange(event.target.value)}
              placeholder="이 지점부터 다시 진행하는 이유를 적어주세요."
            />
          </div>

          <p className="text-xs text-muted-foreground">{PRESERVATION_NOTE}</p>

          <MissionResumeRequestStatus
            applyError={applyError}
            canRetry={!!applyError?.uncertain && frozenBody !== null}
            onRetry={handleRetry}
            requestLoading={createdRequestId !== null && requestQuery.isPending}
            requestError={
              createdRequestId !== null && requestQuery.error instanceof Error ? requestQuery.error.message : null
            }
            requestView={createdRequestId !== null ? requestView : null}
          />

          <div className="flex justify-end">
            <Button type="button" onClick={handleConfirm} disabled={!canConfirm}>
              이 지점부터 재개
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
