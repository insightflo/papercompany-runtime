// Workflow graph export snapshot, YAML serialization and draft parsing.
// Split out of workflow-graph.ts (pure move, function bodies unchanged).

import type { WorkflowGraphStep } from "./workflow-graph-types-core.js";
import type { WorkflowGraphExportFormat, WorkflowGraphExportInput, WorkflowGraphExportSnapshot, WorkflowGraphTriggerInput, WorkflowGraphTriggerSummary, WorkflowGraphYamlDraftParseResult } from "./workflow-graph-types-interface.js";
import { parse as parseYaml } from "yaml";
import { parseDependencies } from "./workflow-graph-dependencies.js";
import { readPlainObject, readTrimmedString } from "./workflow-graph-value-readers.js";
import { normalizeFlowEnvVariables, normalizeFlowInputs, summarizeWorkflowGraphInterface } from "./workflow-graph-flow-interface.js";

function parseTriggerLabels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => parseTriggerLabels(entry))));
  }
  if (typeof value !== "string") return [];
  return Array.from(new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean)));
}

export function summarizeWorkflowGraphTriggers(input: WorkflowGraphTriggerInput): WorkflowGraphTriggerSummary {
  const cron = readTrimmedString(input.schedule);
  const timezone = readTrimmedString(input.timezone);
  const labels = parseTriggerLabels(input.triggerLabels);
  const lastRunAt = readTrimmedString(input.lastScheduledRunAt);
  const error = readTrimmedString(input.lastScheduleError);
  const errorAt = readTrimmedString(input.lastScheduleErrorAt);
  const hasSchedule = Boolean(cron);
  const hasLabels = labels.length > 0;
  const enabled = hasSchedule || hasLabels;
  const badges: string[] = [];
  if (hasSchedule) badges.push("Cron");
  if (timezone) badges.push(timezone);
  if (hasLabels) badges.push(`${labels.length} label${labels.length === 1 ? "" : "s"}`);
  if (error) badges.push("Schedule error");
  if (badges.length === 0) badges.push("Manual");
  const descriptionParts: string[] = [];
  if (hasSchedule) descriptionParts.push(`Cron ${cron}`);
  if (hasLabels) descriptionParts.push(`Labels ${labels.join(", ")}`);
  return {
    enabled,
    status: error ? "error" : enabled ? "active" : "manual",
    schedule: {
      cron,
      timezone,
      lastRunAt,
      error,
      errorAt,
    },
    labels,
    badges,
    description: descriptionParts.join(" · ") || "Manual run only",
  };
}

export function buildWorkflowGraphExportSnapshot(input: WorkflowGraphExportInput): WorkflowGraphExportSnapshot {
  const flowInterface = summarizeWorkflowGraphInterface(input);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(input.id),
      name: readTrimmedString(input.name),
      description: readTrimmedString(input.description),
      status: readTrimmedString(input.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(input.schedule),
      timezone: readTrimmedString(input.timezone),
      triggerLabels: parseTriggerLabels(input.triggerLabels),
    },
    flowInterface: {
      inputs: flowInterface.inputs,
      envVariables: flowInterface.envVariables,
    },
    steps: Array.isArray(input.steps) ? input.steps : [],
  };
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./*@ -]+$/.test(text) && !/^\s|\s$/.test(text)) return text;
  return JSON.stringify(text);
}

function formatYamlValue(value: unknown, indent = 0): string {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((entry) => {
      if (entry && typeof entry === "object") {
        return `${prefix}- ${formatYamlValue(entry, indent + 2).trimStart()}`;
      }
      return `${prefix}- ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries.map(([key, entry]) => {
      if (Array.isArray(entry) || (entry && typeof entry === "object")) {
        return `${prefix}${key}: ${formatYamlValue(entry, indent + 2) === "[]" || formatYamlValue(entry, indent + 2) === "{}" ? formatYamlValue(entry, indent + 2) : `\n${formatYamlValue(entry, indent + 2)}`}`;
      }
      return `${prefix}${key}: ${formatYamlScalar(entry)}`;
    }).join("\n");
  }
  return formatYamlScalar(value);
}

function normalizeSnapshotSteps(value: unknown): WorkflowGraphStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = readPlainObject(entry);
    const id = readTrimmedString(record.id);
    if (!id) return [];
    return [{
      ...record,
      id,
      title: readTrimmedString(record.title),
      type: readTrimmedString(record.type),
      dependsOn: parseDependencies(record.dependsOn),
    } as WorkflowGraphStep];
  });
}

function normalizeExportSnapshot(value: unknown): WorkflowGraphExportSnapshot {
  const record = readPlainObject(value);
  const metadata = readPlainObject(record.metadata);
  const settings = readPlainObject(record.settings);
  const flowInterface = readPlainObject(record.flowInterface);
  return {
    formatVersion: 1,
    metadata: {
      id: readTrimmedString(metadata.id),
      name: readTrimmedString(metadata.name),
      description: readTrimmedString(metadata.description),
      status: readTrimmedString(metadata.status) || "active",
    },
    settings: {
      schedule: readTrimmedString(settings.schedule),
      timezone: readTrimmedString(settings.timezone),
      triggerLabels: parseTriggerLabels(settings.triggerLabels),
    },
    flowInterface: {
      inputs: normalizeFlowInputs(flowInterface.inputs),
      envVariables: normalizeFlowEnvVariables(flowInterface.envVariables),
    },
    steps: normalizeSnapshotSteps(record.steps),
  };
}

export function serializeWorkflowGraphExportSnapshot(
  snapshot: WorkflowGraphExportSnapshot,
  format: WorkflowGraphExportFormat,
): string {
  if (format === "yaml") {
    return `${formatYamlValue(snapshot)}\n`;
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseWorkflowGraphYamlDraft(yamlText: string): WorkflowGraphYamlDraftParseResult {
  try {
    return {
      snapshot: normalizeExportSnapshot(parseYaml(yamlText)),
      error: "",
    };
  } catch (error) {
    return {
      snapshot: normalizeExportSnapshot({}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
