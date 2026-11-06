import type { WorkflowGraphStep, WorkflowGraphWorkProduct } from "./workflow-graph-types-core.js";
import type { WorkflowGraphContainer, WorkflowGraphDiagnostics, WorkflowGraphEdge, WorkflowGraphFocusLensTone, WorkflowGraphGroup, WorkflowGraphNode } from "./workflow-graph-types-model.js";
import type { WorkflowGraphInterfaceInput } from "./workflow-graph-types-interface.js";

export type WorkflowGraphStructurePaletteActionId =
  | "agent"
  | "tool"
  | "if"
  | "complete"
  | "branch"
  | "loop"
  | "approval"
  | "failure-handler"
  | "group"
  | "branch-wrap"
  | "loop-wrap"
  | "route-failure";

export type WorkflowGraphStructurePaletteAction = {
  id: WorkflowGraphStructurePaletteActionId;
  label: string;
  description: string;
  tone: WorkflowGraphFocusLensTone;
  disabled?: boolean;
};

export type WorkflowGraphStructurePaletteSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  summary: string;
  badges: string[];
  addActions: WorkflowGraphStructurePaletteAction[];
  transformActions: WorkflowGraphStructurePaletteAction[];
};

export type WorkflowGraphExecutionEvidenceMetric = {
  id: "status" | "issue" | "dispatch" | "outputs";
  label: string;
  value: string;
  tone: WorkflowGraphFocusLensTone;
  detail: string;
};

export type WorkflowGraphExecutionEvidenceSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  available: boolean;
  summary: string;
  badges: string[];
  metrics: WorkflowGraphExecutionEvidenceMetric[];
  resultPreview: string;
  logPreview: string;
  workProducts: WorkflowGraphWorkProduct[];
};

export type WorkflowGraphWorkbenchAction = {
  id: string;
  label: string;
  disabled?: boolean;
};

export type WorkflowGraphWorkbenchCommandGroup = {
  id: string;
  label: string;
  actions: WorkflowGraphWorkbenchAction[];
};

export type WorkflowGraphWorkbenchSummary = {
  selectedStepId: string;
  commandGroups: WorkflowGraphWorkbenchCommandGroup[];
  statusBadges: string[];
  pathSummary: string;
  detailsHiddenByDefault: boolean;
};

export type WorkflowGraphModel<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  nodes: Array<WorkflowGraphNode<TStep>>;
  edges: WorkflowGraphEdge[];
  groups: WorkflowGraphGroup[];
  containers: WorkflowGraphContainer[];
  warnings: string[];
  diagnostics: WorkflowGraphDiagnostics;
};

export type WorkflowGraphTestPlan = {
  targetStepId: string;
  stepIds: string[];
  excludedStepIds: string[];
  missingDependencyIds: string[];
  blocked: boolean;
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestExecutionMode = "will-run" | "mocked" | "pinned" | "skipped" | "blocked";

export type WorkflowGraphTestExecutionStep = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphTestExecutionMode;
  reason: string;
  badges: string[];
};

export type WorkflowGraphTestExecutionPreview = {
  targetStepId: string;
  steps: WorkflowGraphTestExecutionStep[];
  badges: string[];
  summary: string;
};

export type WorkflowGraphIterationTestPreview = {
  containerId: string;
  title: string;
  iterationIndex: number;
  iterationValue: unknown;
  iteratorExpression: string;
  stepIds: string[];
  skippedStepIds: string[];
  parallelism: number | null;
  skipFailure: boolean;
  runInParallel: boolean;
  blocked: boolean;
  badges: string[];
  summary: string;
  requestJson: string;
};

export type WorkflowGraphSingleStepTestContextMode = "mocked" | "pinned" | "unavailable";

export type WorkflowGraphSingleStepTestContextResult = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphSingleStepTestContextMode;
  badges: string[];
  value?: unknown;
  pinnedResultRunId?: string;
};

export type WorkflowGraphSingleStepTestPreview = {
  stepId: string;
  title: string;
  kind: string;
  flowArguments: Record<string, unknown>;
  stepArguments: Record<string, unknown>;
  inputExpression: string;
  upstreamContextStepIds: string[];
  downstreamStepIds: string[];
  missingDependencyIds: string[];
  contextResults: WorkflowGraphSingleStepTestContextResult[];
  blocked: boolean;
  badges: string[];
  summary: string;
  requestJson: string;
};

export type WorkflowGraphRestartMode = "reused" | "rerun" | "blocked";

export type WorkflowGraphRestartStep = {
  stepId: string;
  title: string;
  kind: string;
  mode: WorkflowGraphRestartMode;
  reason: string;
  badges: string[];
};

export type WorkflowGraphRestartPreview = {
  restartStepId: string;
  reusedStepIds: string[];
  rerunStepIds: string[];
  blockedStepIds: string[];
  blocked: boolean;
  steps: WorkflowGraphRestartStep[];
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestRequestPreview = {
  arguments: Record<string, unknown>;
  envPreview: Record<string, unknown>;
  requiredInputNames: string[];
  badges: string[];
  requestJson: string;
};

export type WorkflowGraphRequestFillPreview = {
  arguments: Record<string, unknown>;
  matchedInputNames: string[];
  extraArgumentNames: string[];
  missingRequiredInputNames: string[];
  badges: string[];
  requestJson: string;
  error?: string;
};

export type WorkflowGraphTestInputPreset = {
  name: string;
  args: Record<string, unknown>;
  requestJson: string;
};

export type WorkflowGraphTestInputLibrarySummary = {
  presets: WorkflowGraphTestInputPreset[];
  badges: string[];
};

export type WorkflowGraphManagementRunInput = {
  workflowId?: string;
  status?: string;
  triggerSource?: string;
  startedAt?: string;
  completedAt?: string;
  runLabel?: string;
};

export type WorkflowGraphManagementTileTone = "neutral" | "success" | "warning" | "danger" | "info";

export type WorkflowGraphManagementTile = {
  id: "draft" | "test" | "runs" | "history";
  title: string;
  status: string;
  tone: WorkflowGraphManagementTileTone;
  summary: string;
  badges: string[];
  actionLabel: string;
};

export type WorkflowGraphManagementSummary = {
  tiles: WorkflowGraphManagementTile[];
  badges: string[];
  hasBlockingIssue: boolean;
};

export type WorkflowGraphManagementSummaryInput<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  workflowId?: string;
  savedSteps?: TStep[];
  draftSteps: TStep[];
  selectedStepId?: string;
  activeRuns?: WorkflowGraphManagementRunInput[];
  recentRuns?: WorkflowGraphManagementRunInput[];
  interfaceInput?: WorkflowGraphInterfaceInput;
};
