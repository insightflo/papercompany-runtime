import type { IssueExecutionCardJson } from "@paperclipai/db";
import { ARTIFACT_MARKER, extractProseIssueContract } from "./prose-markers.js";
import { sha256Text } from "./hash.js";

type WorkflowCardStep = {
  id: string;
  dependencies: string[];
  graphWorkProductRequired?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readToolNames(step: unknown): string[] {
  const record = asRecord(step);
  return Array.from(new Set([
    ...stringArray(record.toolNames),
    ...stringArray(record.requiredToolNames),
    typeof record.toolName === "string" ? record.toolName : null,
  ].filter((value): value is string => value !== null)));
}

function readKnowledgeNames(step: unknown): string[] {
  const record = asRecord(step);
  return Array.from(new Set([
    ...stringArray(record.knowledgeNames),
    ...stringArray(record.requiredKnowledgeNames),
  ]));
}

function deliveryReadbackRequired(description: string, step: unknown): boolean {
  const record = asRecord(step);
  return extractProseIssueContract(description).deliveryReadbackRequired ||
    record.deliveryReadbackRequired === true ||
    record.requiresDeliveryReadback === true ||
    record.publicReadbackRequired === true;
}

export function buildWorkflowIssueExecutionCard(input: {
  title: string;
  description: string;
  companyId: string;
  issueId?: string;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  missionId?: string | null;
  workflowDefinitionId: string;
  workflowRunId: string;
  workflowStepRunId?: string | null;
  step: WorkflowCardStep;
  stepOutputDir?: string | null;
  qaRubricPath?: string | null;
  evidenceRefs?: IssueExecutionCardJson["evidenceRefs"];
  isQaStep: boolean;
}): IssueExecutionCardJson {
  const prose = extractProseIssueContract(input.description);
  const requiresWorkProduct = input.step.graphWorkProductRequired === true || prose.workProductRequired;
  const requiresVerdict = input.isQaStep || prose.workflowVerdictRequired;
  const evidenceRefs = dedupeEvidenceRefs([
    input.stepOutputDir ? {
      type: "output_dir",
      path: input.stepOutputDir,
      description: "Assigned workflow step output directory",
    } : null,
    input.qaRubricPath ? {
      type: "qa_rubric",
      path: input.qaRubricPath,
      description: "Generated QA rubric for validator step",
    } : null,
    ...(input.evidenceRefs ?? []),
  ].filter((entry): entry is NonNullable<typeof entry> => entry !== null));

  return {
    version: 1,
    issue: {
      id: input.issueId,
      title: input.title,
      assigneeAgentId: input.assigneeAgentId ?? null,
      projectId: input.projectId ?? null,
      originKind: "workflow_execution",
    },
    workflow: {
      definitionId: input.workflowDefinitionId,
      runId: input.workflowRunId,
      stepRunId: input.workflowStepRunId ?? null,
      stepId: input.step.id,
      dependencyStepIds: [...input.step.dependencies],
    },
    requiredOutputs: {
      workProduct: {
        required: requiresWorkProduct,
        outputDir: input.stepOutputDir ?? null,
        artifactMarker: ARTIFACT_MARKER,
      },
      verdict: {
        required: requiresVerdict,
        ledger: requiresVerdict ? "workflow_validation_verdict" : null,
        allowed: requiresVerdict ? ["PASS", "REQUEST_CHANGES"] : [],
      },
      deliveryReadback: {
        required: input.isQaStep ? deliveryReadbackRequired(input.description, input.step) : false,
        marker: null,
      },
    },
    toolPermissionContract: {
      requiredToolNames: readToolNames(input.step),
      requiredKnowledgeNames: readKnowledgeNames(input.step),
    },
    evidenceRefs,
    preservedProseMarkers: prose.preservedMarkers,
    source: {
      descriptionHash: sha256Text(input.description),
      generatedBy: "workflow.dag-engine.createWorkflowStepIssue",
    },
  };
}

function dedupeEvidenceRefs(refs: IssueExecutionCardJson["evidenceRefs"]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = [ref.type, ref.id ?? "", ref.path ?? ""].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
