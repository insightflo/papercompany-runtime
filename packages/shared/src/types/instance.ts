export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableHeartbeatFinalizationV1: boolean;
  /** [run-terminal-boundary v1] 종결 경계(원인 스탬프 결정·회복 게이트·권한 CAS·스코프 정지) 스위치. 기본 off. */
  enableRunTerminalBoundaryV1: boolean;
  /** [run-reopen-guard v1] 종결 run 재오픈 가드 — 재개는 상태 CAS + 권한버전 범프로만. 기본 off. */
  enableRunReopenGuardV1: boolean;
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
