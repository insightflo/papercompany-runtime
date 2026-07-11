import { resolveWorkflowQaContract } from "./workflow/workflow-qa-type.js";

export type WorkflowStepRole = "action" | "qa" | "oversight" | "unknown";

export type WorkflowStepRoleInput = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly type?: unknown;
  readonly qaType?: unknown;
};

const EXPLICIT_ROLE_RE = /^\s*\[(ACTION|QA|OVERSIGHT)\]/iu;
const QA_ID_RE = /^(?:qa|validate|verify|audit|inspect)(?:[-_]|$)/iu;
const ACTION_ID_RE = /^action(?:[-_]|$)/iu;
const OVERSIGHT_ID_RE = /^(?:oversight|approval)(?:[-_]|$)/iu;
const QA_NAME_RE = /\b(?:qa|audit\w*|validat\w*|verif\w*|inspect\w*)\b/iu;
const CONTEXTUAL_QA_RE = /\b(?:(?:final|quality|artifact|work\s*product|deliverable|report|output|evidence|citation|source\s*coverage|readback|delivery|compliance|acceptance)\s+(?:review\w*|check\w*)|(?:review\w*|check\w*)\s+(?:quality|artifact|work\s*product|deliverable|report|output|evidence|citation|source\s*coverage|readback|delivery|compliance|acceptance))\b/iu;
const READBACK_QA_RE = /\bread[-\s]?back\b/iu;
const KOREAN_QA_RE = /검수|검증|감사|(?:최종|품질|산출물|결과물|보고서|배포|게시물)\s*(?:확인|점검|검사|검토)/u;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function explicitRole(input: WorkflowStepRoleInput): WorkflowStepRole | null {
  for (const value of [input.name, input.title]) {
    const match = text(value).match(EXPLICIT_ROLE_RE)?.[1]?.toUpperCase();
    if (match === "ACTION") return "action";
    if (match === "QA") return "qa";
    if (match === "OVERSIGHT") return "oversight";
  }
  return null;
}

export function classifyWorkflowStepRole(input: WorkflowStepRoleInput): WorkflowStepRole {
  if (resolveWorkflowQaContract(input.qaType)) return "qa";

  const explicit = explicitRole(input);
  if (explicit) return explicit;

  const type = text(input.type).toLowerCase();
  if (["qa", "validation", "validator"].includes(type)) return "qa";
  if (["approval", "oversight"].includes(type)) return "oversight";
  if (["action", "producer", "research"].includes(type)) return "action";

  const id = text(input.id);
  if (ACTION_ID_RE.test(id)) return "action";
  if (OVERSIGHT_ID_RE.test(id)) return "oversight";
  if (QA_ID_RE.test(id)) return "qa";

  const label = [input.name, input.title].map(text).filter(Boolean).join("\n");
  if (QA_NAME_RE.test(label) || CONTEXTUAL_QA_RE.test(label) || READBACK_QA_RE.test(label) || KOREAN_QA_RE.test(label)) {
    return "qa";
  }

  return "unknown";
}

export function isQaLikeStep(input: WorkflowStepRoleInput): boolean {
  return classifyWorkflowStepRole(input) === "qa";
}
