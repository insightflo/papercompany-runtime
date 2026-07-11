// [파일 목적] issue execution card 를 runtime brief 용 짧은 bullet 들로 전개.
//   긴 JSON dump 금지, 경로/배열 길이 상한으로 brief 크기 통제.
// [주요 흐름] card.requiredOutputs/workflow/toolPermissionContract/evidenceRefs 읽어 bullet 화.
// [외부 연결] runtime-brief.ts buildPaperclipRuntimeBrief.
// [수정시 주의] bullet 은 사람/agent 가 한눈에 읽는 용. card schema 변경 시 field 만 추가.
//   ponytail: 단순 field reader, 복잡한 정규화/추론 없음. card 가 없으면 빈 배열.

type CardLike = Record<string, unknown>;

function asRecord(value: unknown): CardLike | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as CardLike)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (text) {
      out.push(text);
      if (out.length >= cap) break;
    }
  }
  return out;
}

function joinList(items: readonly string[]): string {
  return items.join(", ");
}

const ARRAY_CAP = 8;
const QA_SCOPE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  mission_plan: "Review mission intent, plan structure, resources, and acceptance criteria; do not require a workProduct or public URL.",
  dependency_work_products: "Use only declared dependency workProduct paths; do not scan the workspace.",
  delivery_readback: "Use the declared final destination and fresh readback evidence; do not scan the workspace.",
};

export function buildIssueExecutionCardBriefLines(input: {
  readonly card: unknown;
  readonly cardHash?: string | null;
}): string[] {
  const card = asRecord(input.card);
  if (!card) return [];

  const requiredOutputs = asRecord(card.requiredOutputs);
  const workProduct = asRecord(requiredOutputs?.workProduct);
  const verdict = asRecord(requiredOutputs?.verdict);
  const delivery = asRecord(requiredOutputs?.deliveryReadback);
  const workflow = asRecord(card.workflow);
  const toolContract = asRecord(card.toolPermissionContract);
  const evidenceRefs = Array.isArray(card.evidenceRefs) ? card.evidenceRefs : [];

  const lines: string[] = [];
  const hash = asString(input.cardHash);
  lines.push(hash ? `Issue execution card ${hash}:` : "Issue execution card:");

  if (workProduct) {
    const outputDir = asString(workProduct.outputDir);
    const artifactMarker = asString(workProduct.artifactMarker);
    lines.push(
      `- Work product: required=${workProduct.required === true}`
      + `${outputDir ? `; outputDir=${outputDir}` : ""}`
      + `${artifactMarker ? `; marker=${artifactMarker}` : ""}`,
    );
  }

  if (verdict) {
    const ledger = asString(verdict.ledger);
    const allowed = asStringArray(verdict.allowed, ARRAY_CAP);
    lines.push(
      `- Verdict: required=${verdict.required === true}`
      + `${ledger ? `; ledger=${ledger}` : ""}`
      + `${allowed.length > 0 ? `; allowed=${joinList(allowed)}` : ""}`,
    );
  }

  if (delivery) {
    const marker = asString(delivery.marker);
    lines.push(
      `- Delivery readback: required=${delivery.required === true}${marker ? `; marker=${marker}` : ""}`,
    );
  }

  const closeoutParts = [
    workProduct?.required === true ? "register artifacts with /workflow/artifacts" : null,
    delivery?.required === true ? "register public URLs with /workflow/artifacts type=preview_url" : null,
    verdict?.required === true ? "submit verdict with /workflow/verdict" : null,
    "complete with /workflow/complete",
  ].filter((part): part is string => part !== null);
  if (workflow && closeoutParts.length > 0) {
    lines.push(`- Workflow API closeout: ${joinList(closeoutParts)}; use the paperclip skill for request examples.`);
  }

  const stepId = asString(workflow?.stepId);
  const runId = asString(workflow?.runId);
  const deps = asStringArray(workflow?.dependencyStepIds, ARRAY_CAP);
  if (stepId || runId) {
    const head = [stepId ? `step=${stepId}` : null, runId ? `run=${runId}` : null]
      .filter((value): value is string => value !== null)
      .join(", ");
    lines.push(`${deps.length > 0 ? `- Workflow: ${head}; dependsOn=${joinList(deps)}` : `- Workflow: ${head}`}`);
  }

  const qaType = asString(workflow?.qaType);
  const qaInputScope = asString(workflow?.qaInputScope);
  if (qaType && qaInputScope) {
    lines.push(`- QA type: ${qaType}; inputScope=${qaInputScope}`);
    const scopeInstruction = QA_SCOPE_INSTRUCTIONS[qaInputScope];
    if (scopeInstruction) lines.push(`- QA input boundary: ${scopeInstruction}`);
  }

  const toolNames = asStringArray(toolContract?.requiredToolNames, ARRAY_CAP);
  const knowledgeNames = asStringArray(toolContract?.requiredKnowledgeNames, ARRAY_CAP);
  if (toolNames.length > 0) lines.push(`- Required tools: ${joinList(toolNames)}`);
  if (knowledgeNames.length > 0) lines.push(`- Required knowledge: ${joinList(knowledgeNames)}`);

  const evidenceLines: string[] = [];
  for (const rawRef of evidenceRefs) {
    if (evidenceLines.length >= ARRAY_CAP) break;
    const ref = asRecord(rawRef);
    const path = asString(ref?.path) ?? asString(ref?.id);
    const label = asString(ref?.description) ?? asString(ref?.type);
    if (path) evidenceLines.push(label ? `${label}: ${path}` : path);
  }
  if (evidenceLines.length > 0) lines.push(`- Evidence: ${joinList(evidenceLines)}`);

  return lines;
}
