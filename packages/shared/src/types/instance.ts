export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  /** 판단(Jev) 엔드포인트 오버라이드. 미설정(undefined)이면 기본값 사용. */
  judgmentBaseUrl?: string;
  /** 판단(Jev) 모델 오버라이드. 미설정(undefined)이면 정의별 모델 사용. */
  judgmentModelId?: string;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableHeartbeatFinalizationV1: boolean;
  /** [run-terminal-boundary v1] 종결 경계(원인 스탬프 결정·회복 게이트·권한 CAS·스코프 정지) 스위치. 기본 off. */
  enableRunTerminalBoundaryV1: boolean;
  /** [run-reopen-guard v1] 종결 run 재오픈 가드 — 재개는 상태 CAS + 권한버전 범프로만. 기본 off. */
  enableRunReopenGuardV1: boolean;
  /** [run-recovery-service v1] 종결 실행의 공식 복구(결정 1회 소비·권한버전 검증)를
   *  resume/감독 재시도/언블록 해결에 적용. 기본 off — off 면 PR-2a 가드 동작을 유지하고,
   *  서버는 reopenGuard 플래그와 함께 켜져 있을 때만 활성으로 판정한다. */
  enableRunRecoveryServiceV1: boolean;
  /** [work-product binding v1 — 스테이지 A] 도구 스텝의 workProducts 참조를 실행 단위로
   *  핀한다(재시도가 "현재 대표"를 재해석하지 않는다). 기본 off — off 면 기존 대표 우선
   *  재해석 경로 유지. 핀은 tool-step dispatch 경로(스텝런 신원 있는 곳)에만 적용되며
   *  condition-source/child-precheck 호출부는 스텝런 신원이 없어 이 단계에서 제외. */
  enableWorkProductBindingV1: boolean;
  /** [P2 측정 롤아웃] 사람 큐레이션 패턴 카드의 스텝 디스패치 주입 스위치. 기본 off = 주입 없음. */
  enableKnowledgePatternInjection: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
