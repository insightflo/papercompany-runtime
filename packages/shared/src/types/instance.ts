export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableHeartbeatFinalizationV1: boolean;
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
