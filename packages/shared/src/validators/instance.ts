import { z } from "zod";

/** 판단(Jev) 엔드포인트 오버라이드 — http(s) 만, userinfo/query/fragment 금지, 2048자 이하. null 은 해제. */
export const judgmentBaseUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "judgment base URL must be http(s) without userinfo, query, or fragment")
  .nullable();

/** 판단(Jev) 모델 오버라이드 — 1~200자, [A-Za-z0-9._:/-]. null 은 해제(정의별 모델로 복귀). */
export const judgmentModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/, "judgment model id contains invalid characters")
  .nullable();

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  judgmentBaseUrl: judgmentBaseUrlSchema.optional(),
  judgmentModelId: judgmentModelIdSchema.optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableHeartbeatFinalizationV1: z.boolean().default(false),
  // [run-terminal-boundary v1] 종결 경계(원인 스탬프 결정·회복 게이트·권한 CAS·스코프 정지) 스위치.
  //   기본 off = legacy 종결 경로와 바이트 동등.
  enableRunTerminalBoundaryV1: z.boolean().default(false),
  // [run-reopen-guard v1] 종결 run 재오픈 가드 — 관측 사실(재계산·즉시 재평가)만으로 종결 run 을
  //   running 으로 부활시키지 않고, 재개는 상태 CAS + 권한버전 범프로만 허용한다.
  //   기본 off = legacy 재개/재계산 경로와 바이트 동등.
  enableRunReopenGuardV1: z.boolean().default(false),
  // [run-recovery-service v1] 종결 실행 공식 복구 스위치 — 기본 off(fail-closed). 서버는
  //   reopenGuard 와 함께 켜졌을 때만 활성 판정(가드 off 시 legacy 경로와 소비 기록이 어긋남).
  enableRunRecoveryServiceV1: z.boolean().default(false),
  // [work-product binding v1 — 스테이지 A] 실행 단위 산출물 핀 — 기본 off(fail-closed,
  //   off 면 기존 대표 우선 재해석 경로를 그대로 둔다).
  enableWorkProductBindingV1: z.boolean().default(false),
  // [P2 측정 롤아웃] 사람 큐레이션 패턴 카드의 스텝 디스패치 주입 스위치. 기본 off = 주입 없음(fail-closed).
  //   on이어도 결정론적 그룹 배정(50/50)의 injection 군에만 주입되고 스텝런 메타데이터에 기록된다.
  enableKnowledgePatternInjection: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
