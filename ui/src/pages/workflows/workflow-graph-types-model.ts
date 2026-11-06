import type { WorkflowGraphEdgeKind, WorkflowGraphStep, WorkflowGraphStepAdvanced, WorkflowGraphStepDataFlow, WorkflowGraphStepExecution, WorkflowGraphStepRunStatus, WorkflowGraphStepTesting } from "./workflow-graph-types-core.js";

export type WorkflowGraphStepResources = {
  resourceRefs: string[];
  secretRefs: string[];
  badges: string[];
};

export type WorkflowGraphDataFlowResultRef = {
  stepId: string;
  path: string;
  available: boolean;
};

export type WorkflowGraphDataFlowMap = {
  stepId: string;
  title: string;
  inputExpression: string;
  flowInputRefs: string[];
  resultRefs: WorkflowGraphDataFlowResultRef[];
  upstreamStepIds: string[];
  missingStepIds: string[];
  resourceRefs: string[];
  secretRefs: string[];
  outputContractBadges: string[];
  blocked: boolean;
  badges: string[];
  summary: string;
};

export type WorkflowGraphNode<TStep extends WorkflowGraphStep = WorkflowGraphStep> = {
  id: string;
  label: string;
  kind: string;
  layer: number;
  order: number;
  x: number;
  y: number;
  step: TStep;
  runStatus: WorkflowGraphStepRunStatus;
  advanced: WorkflowGraphStepAdvanced;
  testing: WorkflowGraphStepTesting;
  execution: WorkflowGraphStepExecution;
  dataFlow: WorkflowGraphStepDataFlow;
  resources: WorkflowGraphStepResources;
};

export type WorkflowGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: WorkflowGraphEdgeKind;
  label: string;
  condition: string;
  when?: string;
};

export type WorkflowGraphChangedStep = {
  id: string;
  fields: string[];
};

export type WorkflowGraphDraftDiff = {
  hasChanges: boolean;
  addedSteps: string[];
  removedSteps: string[];
  changedSteps: WorkflowGraphChangedStep[];
  addedEdges: string[];
  removedEdges: string[];
  changedEdges: string[];
  summary: string[];
};

export type WorkflowGraphGroup = {
  id: string;
  title: string;
  color: string;
  collapsed: boolean;
  collapsedByDefault: boolean;
  stepIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowGraphContainerType = "branch" | "loop";

export type WorkflowGraphContainer = {
  id: string;
  type: WorkflowGraphContainerType;
  title: string;
  description: string;
  mode: string;
  condition: string;
  iterator: string;
  skipFailure: boolean;
  runInParallel: boolean;
  parallelism: number | null;
  badges: string[];
  stepIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowGraphContainerSummary = {
  id: string;
  type: WorkflowGraphContainerType;
  title: string;
  description: string;
  mode: string;
  stepIds: string[];
  entryStepIds: string[];
  terminalStepIds: string[];
  inboundStepIds: string[];
  outboundStepIds: string[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphSelectionMode = "self" | "upstream" | "downstream" | "connected";

export type WorkflowGraphSelectionSummary = {
  stepIds: string[];
  entryStepIds: string[];
  terminalStepIds: string[];
  inboundStepIds: string[];
  outboundStepIds: string[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphFailureRouteOptions = {
  label?: string;
  condition?: string;
  handlerScope?: string;
  handlerInput?: string;
};

export type WorkflowGraphFailureRouteSummary = {
  sourceStepIds: string[];
  handlerStepId: string;
  label: string;
  condition: string;
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphIssueSeverity = "error" | "warning" | "info";

export type WorkflowGraphIssue = {
  id: string;
  severity: WorkflowGraphIssueSeverity;
  code: string;
  message: string;
  stepId?: string;
  sourceId?: string;
  targetId?: string;
};

export type WorkflowGraphDiagnostics = {
  entryStepIds: string[];
  terminalStepIds: string[];
  issueCountBySeverity: Record<WorkflowGraphIssueSeverity, number>;
  issues: WorkflowGraphIssue[];
};

export type WorkflowGraphRepairAction =
  | "connect-or-remove-dependency"
  | "assign-step-id"
  | "disconnect-cycle-edge"
  | "inspect-diagnostic";

export type WorkflowGraphRepairItem = {
  id: string;
  severity: WorkflowGraphIssueSeverity;
  issueCode: string;
  action: WorkflowGraphRepairAction;
  title: string;
  description: string;
  focusStepId: string;
  sourceStepId?: string;
  targetStepId?: string;
  badges: string[];
};

export type WorkflowGraphRepairPlan = {
  items: WorkflowGraphRepairItem[];
  badges: string[];
  blocked: boolean;
  summary: string;
};

export type WorkflowGraphInspectorMode = "overview" | "edit" | "policy" | "raw";

export type WorkflowGraphInspectorSection = {
  mode: WorkflowGraphInspectorMode;
  title: string;
  badges: string[];
  summary: string;
};

export type WorkflowGraphInspectorSummary = {
  defaultMode: WorkflowGraphInspectorMode;
  selectedStepId: string;
  sections: WorkflowGraphInspectorSection[];
};

export type WorkflowGraphFocusLensTone = "success" | "warning" | "danger" | "info" | "neutral";

export type WorkflowGraphFocusLensMetric = {
  id: "step" | "path" | "controls" | "runtime";
  label: string;
  value: string;
  tone: WorkflowGraphFocusLensTone;
  detail: string;
};

export type WorkflowGraphFocusLensAction = {
  id: "edit" | "test" | "evidence" | "policy" | "raw" | "add-after" | "diagnostics";
  label: string;
  disabled?: boolean;
};

export type WorkflowGraphFocusLensSummary = {
  selectedStepId: string;
  title: string;
  description: string;
  tone: WorkflowGraphFocusLensTone;
  badges: string[];
  metrics: WorkflowGraphFocusLensMetric[];
  actions: WorkflowGraphFocusLensAction[];
  detailsHiddenByDefault: boolean;
};

export type WorkflowGraphTestDrawerMode = {
  id: "test-flow" | "test-step" | "restart" | "iteration" | "inputs";
  title: string;
  tone: WorkflowGraphFocusLensTone;
  badges: string[];
  summary: string;
};

export type WorkflowGraphTestDrawerSummary = {
  selectedStepId: string;
  title: string;
  tone: WorkflowGraphFocusLensTone;
  summary: string;
  badges: string[];
  modes: WorkflowGraphTestDrawerMode[];
};
