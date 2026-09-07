import { z } from "zod";

/**
 * [purpose] 워크플로우 웹훅 관리 API 응답 계약(보드 전용).
 * 시크릿 전체 값은 enable/rotate 응답에서 정확히 1회만 반환되며,
 * status 응답에는 last4(끝 4자)와 24h 수신 카운트만 노출된다.
 * [care] 규칙 8 — 이 스키마는 표시/계약용이며 실행 권위가 아니다.
 */
export const workflowWebhookEnableResponseSchema = z.object({
  secret: z.string().min(1),
  last4: z.string().min(1),
  enabled: z.literal(true),
});

export const workflowWebhookStatusResponseSchema = z.object({
  enabled: z.boolean(),
  last4: z.string().min(1),
  deliveriesLast24h: z.number().int().nonnegative(),
});

export const workflowWebhookDisableResponseSchema = z.object({
  enabled: z.literal(false),
});

export type WorkflowWebhookEnableResponse = z.infer<typeof workflowWebhookEnableResponseSchema>;
export type WorkflowWebhookStatusResponse = z.infer<typeof workflowWebhookStatusResponseSchema>;
export type WorkflowWebhookDisableResponse = z.infer<typeof workflowWebhookDisableResponseSchema>;
