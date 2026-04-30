import {
  maintenanceDecisionService,
  type MaintenanceDecisionResult,
} from "./decision-service.js";

type MaintenanceDecisionIssue = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  metadata?: Record<string, unknown> | null;
};

type MaintenanceGuidanceForDecision = {
  knowledge?: Array<{
    id?: string | null;
    name?: string | null;
    source?: string | null;
    content?: string | null;
  }>;
} | null;

export type MaintenanceDecisionContext = MaintenanceDecisionResult & {
  version: 1;
};

export function buildMaintenanceDecisionContext(input: {
  issue: MaintenanceDecisionIssue | null;
  requestedStatus?: string | null;
  guidance: MaintenanceGuidanceForDecision;
}): MaintenanceDecisionContext | null {
  if (!input.issue?.id && !input.issue?.title && !input.issue?.description) return null;

  const kbReferences = (input.guidance?.knowledge ?? [])
    .map((entry) => ({
      id: readString(entry.id) ?? "unknown-kb",
      name: readString(entry.name) ?? "Knowledge base",
      source: readString(entry.source) ?? readString(entry.name) ?? "knowledge",
      excerpt: truncateExcerpt(readString(entry.content) ?? ""),
    }))
    .filter((entry) => entry.id.length > 0 && entry.name.length > 0);

  return {
    version: 1,
    ...maintenanceDecisionService.evaluateIssue({
      issue: {
        id: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
        description: input.issue.description,
        status: input.issue.status,
        priority: input.issue.priority,
        metadata: input.issue.metadata,
      },
      requestedStatus: input.requestedStatus,
      kbReferences,
    }),
  };
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateExcerpt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}
