import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityFileEntry,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreviewResult,
} from "@paperclipai/shared";

export type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
};

export type CompanyPackageIncludeEntry = {
  path: string;
};

type PaperclipExtensionDoc = {
  schema?: string;
  company?: Record<string, unknown> | null;
  agents?: Record<string, Record<string, unknown>> | null;
  projects?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
};

type ProjectLike = {
  id: string;
  name: string;
  description: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  status: string;
  executionWorkspacePolicy: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAdapterOverrides: Record<string, unknown> | null;
};

export type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

export type ImportMode = "board_full" | "agent_safe";

export type ImportBehaviorOptions = {
  mode?: ImportMode;
  sourceCompanyId?: string | null;
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};
