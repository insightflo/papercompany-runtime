// ui/src/pages/workflows/workflow-webhook-api.ts
//
// [purpose] 워크플로 웹훅 관리 패널 전용 API 경계(bounded extraction — 승인 경로). HTTP 상태
//   코드를 기계 신호로 보존하는 typed 오류(404=미구성, 그 외=알 수 없음)와, 신원/마운트 수명을
//   넘는 지연 완료를 무시하는 수명 토큰(실질 stale-fencing 헬퍼 — 지연 Promise 로 검증됨)을
//   제공한다. 응답 본문 산문(prose)은 절대 권위로 파싱하지 않는다(규칙 9).
// [authority] 표시/계약 전용 — 실행 권위 없음. 응답은 공유 zod 스키마로만 해석한다.
import {
  workflowWebhookDisableResponseSchema,
  workflowWebhookEnableResponseSchema,
  workflowWebhookStatusResponseSchema,
  type WorkflowWebhookDisableResponse,
  type WorkflowWebhookEnableResponse,
  type WorkflowWebhookStatusResponse,
} from "@paperclipai/shared";
import { apiBaseUrl } from "./workflow-page-api.js";

/** 상태 코드를 보존하는 구조화 fetch 오류 — 404(미구성)와 그 외 오류의 유일한 구분 신호다. */
export class WebhookApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WebhookApiError";
    this.status = status;
  }
}

async function webhookApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${apiBaseUrl()}/api${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new WebhookApiError(
      payload?.error ?? payload?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return await res.json() as T;
}

/** [B2] 외부 서명 호출의 실제 공개 진입점(표시 전용 — 실행 경로 아님). */
export function webhookDeliveryUrl(workflowId: string): string {
  return `${apiBaseUrl()}/api/webhooks/workflows/${encodeURIComponent(workflowId)}`;
}

export function fetchWorkflowWebhookStatus(workflowId: string): Promise<WorkflowWebhookStatusResponse> {
  return webhookApiJson<WorkflowWebhookStatusResponse>(
    `/workflows/${encodeURIComponent(workflowId)}/webhook`,
  );
}

/** POST = 신규 등록 또는 기존 키 회전/재활성(서버 upsert) — 시크릿은 응답 1회뿐이다. */
export function enableWorkflowWebhook(workflowId: string): Promise<WorkflowWebhookEnableResponse> {
  return webhookApiJson<WorkflowWebhookEnableResponse>(
    `/workflows/${encodeURIComponent(workflowId)}/webhook`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function disableWorkflowWebhook(workflowId: string): Promise<WorkflowWebhookDisableResponse> {
  return webhookApiJson<WorkflowWebhookDisableResponse>(
    `/workflows/${encodeURIComponent(workflowId)}/webhook`,
    { method: "DELETE" },
  );
}

/**
 * [B1] 수명 토큰 — 마운트/신원이 끝난 뒤 도착하는 지연 비동기 완료를 무시하는 유한 가드.
 * end() 이후 run() 결과는 항상 null 로 강등되어 상태 적용이 일어나지 않는다(지연 Promise 로
 * 검증 — 구조적 단언이 아니라 실제 완료 차단 증명이다).
 */
export function createLifecycleGuard() {
  let alive = true;
  return {
    get alive(): boolean {
      return alive;
    },
    end(): void {
      alive = false;
    },
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      const result = await task();
      return alive ? result : null;
    },
  };
}

export type WebhookPanelStatus = WorkflowWebhookStatusResponse;

export type WebhookPanelPhase =
  | { phase: "loading" }
  | { phase: "load-error"; message: string }
  | { phase: "unconfigured" }
  | { phase: "disabled"; status: WebhookPanelStatus }
  | { phase: "enabled"; status: WebhookPanelStatus };

/**
 * 패널 상태 머신(순수 함수) — 알 수 없는 상태(로딩/404 아님 오류)에서는 변이 금지를 도출하고,
 * 실제 404 만 미구성(등록 허용)으로 승격한다.
 */
export function deriveWebhookPanelState(input: {
  loading: boolean;
  error: string | null;
  errorStatus: number | null;
  status: WebhookPanelStatus | null;
}): WebhookPanelPhase {
  if (input.loading) return { phase: "loading" };
  if (input.error !== null) {
    return input.errorStatus === 404
      ? { phase: "unconfigured" }
      : { phase: "load-error", message: input.error };
  }
  if (input.status === null) return { phase: "loading" };
  return input.status.enabled
    ? { phase: "enabled", status: input.status }
    : { phase: "disabled", status: input.status };
}
