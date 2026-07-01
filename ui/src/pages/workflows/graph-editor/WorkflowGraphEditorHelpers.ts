import { normalizeGraphEdgeKind, type WorkflowGraphEdgeKind } from "../workflow-graph.js";
import type { StepDraft } from "../step-draft.js";

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

export const LABEL_COLOR_PRESETS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#6366f1", "#ec4899"];

export function clampGraphCanvasScale(value: number): number {
  return Math.min(1.8, Math.max(0.45, value));
}

export function clampGraphInspectorWidth(value: number): number {
  return Math.min(620, Math.max(320, Math.round(value)));
}

export function graphEdgeMetadataFor(step: StepDraft | null, sourceId: string): { kind: WorkflowGraphEdgeKind; label: string; condition: string } {
  const metadata = step?.graphEdgeMetadata?.[sourceId];
  return {
    kind: normalizeGraphEdgeKind(metadata?.kind),
    label: typeof metadata?.label === "string" ? metadata.label : "",
    condition: typeof metadata?.condition === "string" ? metadata.condition : "",
  };
}
