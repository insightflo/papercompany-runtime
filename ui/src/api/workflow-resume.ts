// ui/src/api/workflow-resume.ts
//
// [purpose] 미션 워크플로 재개(workflow resume) 실물 HTTP 클라이언트.
//   기존 api client(/api 프리픽스, JSON, credentials 포함)를 그대로 사용하며,
//   회사/미션/요청 ID는 모두 encodeURIComponent로 인코딩한다. 주입식 가짜 포트는 없다.
import { api } from "./client";
import type { ResumePreview, ResumeRequestView } from "@paperclipai/shared/types/workflow-resume";
import type { ResumeRequestBody } from "@paperclipai/shared/validators/workflow-resume";

function missionResumeScope(companyId: string, missionId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/missions/${encodeURIComponent(missionId)}`;
}

export const workflowResumeApi = {
  /** GET /workflow-resume-preview?workflowRunId=...&startStepId=... → ResumePreview */
  preview(companyId: string, missionId: string, workflowRunId: string, startStepId: string): Promise<ResumePreview> {
    const params = new URLSearchParams();
    params.set("workflowRunId", workflowRunId);
    params.set("startStepId", startStepId);
    return api.get<ResumePreview>(
      `${missionResumeScope(companyId, missionId)}/workflow-resume-preview?${params.toString()}`,
    );
  },

  /** POST /workflow-resume-requests with ResumeRequestBody → ResumeRequestView (202 신규 / 200 동일 재전달) */
  createRequest(companyId: string, missionId: string, body: ResumeRequestBody): Promise<ResumeRequestView> {
    return api.post<ResumeRequestView>(
      `${missionResumeScope(companyId, missionId)}/workflow-resume-requests`,
      body,
    );
  },

  /** GET /workflow-resume-requests/:requestId → ResumeRequestView (요청 상태 readback) */
  getRequest(companyId: string, missionId: string, requestId: string): Promise<ResumeRequestView> {
    return api.get<ResumeRequestView>(
      `${missionResumeScope(companyId, missionId)}/workflow-resume-requests/${encodeURIComponent(requestId)}`,
    );
  },
};
