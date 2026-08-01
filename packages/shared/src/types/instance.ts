export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableHeartbeatFinalizationV1: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
