import { missionPlanUnitText } from "./mission-plan-unit-text.js";
import { classifyWorkflowStepRole } from "../workflow-step-role.js";

const DELIVERY_TOOL_ACTION_TOKENS = new Set([
  "deliver",
  "delivery",
  "deploy",
  "post",
  "publish",
  "publisher",
  "register",
  "release",
  "send",
  "submit",
  "upload",
]);
const DELIVERY_TOOL_TARGET_TOKENS = new Set([
  "github",
  "gitlab",
  "linear",
  "notion",
  "jira",
  "cms",
  "crm",
  "catalog",
]);
const DELIVERY_TOOL_TARGET_ACTION_TOKENS = new Set(["comment", "issue", "pr", "pullrequest", "record", "entry"]);
const ARTIFACT_PRODUCER_DIRECT_RE =
  /\breport[-_\s]?for[-_\s]?beginners\b|\bhtml[-_\s]?for[-_\s]?beginners\b|\bsynth(?:esis|esize)?\b|합성|종합/iu;
const ARTIFACT_NOUN_RE =
  /\bwork[-_\s]?product\b|\bartifact\b|\bdeliverable\b|\boutput\b|\basset\b|\btemplate\b|\breport\b|\bhtml\b|\bpdf\b|\bdeck\b|\bpptx\b|\bmarkdown\b|\bjson\b|\bcsv\b|\bdashboard\b|\bpage\b|\bfile\b|\bdocument\b|\bevidence[-_\s]?(?:packet|bundle|file|json|md)?\b|\bsource[-_\s]?(?:packet|bundle|file)\b|산출물|결과물|템플릿|자료|초안|원고|보고서|리포트|문서|페이지|대시보드|이미지|파일|근거\s*(?:패킷|파일)|출처\s*(?:패킷|파일)/iu;
const ARTIFACT_PRODUCTION_VERB_RE =
  /\bwrite\b|\bbuild\b|\bcreate\b|\bgenerate\b|\brender\b|\bcompile\b|\bpackage\b|\bdraft\b|\bproduce\b|\bcollect\b|\bcurate\b|작성|생성|제작|빌드|렌더|초안|만들|꾸리|수집|정리/iu;
const QA_UNIT_RE =
  /^\s*\[qa\]/iu;
const QA_TEXT_RE =
  /\bqa\b|\bverif(?:y|ied|ication)\b|\bvalid(?:ate|ated|ation)\b|\breview\b|검증|리뷰|확인/u;
const ARTIFACT_QA_TEXT_RE =
  /\bqa\b|\bverif(?:y|ied|ication)\b|\bvalid(?:ate|ated|ation)\b|\breview\b|\baudit\b|\bquality\b|검증|리뷰|검수|품질/u;
const ARTIFACT_QA_RE =
  /\bwork[-_\s]?product\b|\bartifact\b|\bdeliverable\b|\boutput\b|\basset\b|\btemplate\b|\bclaim\b|\bevidence\b|\bsource\b|\bcitation\b|\brubric\b|\bsuccess\s*criteria\b|\bacceptance\b|\bquality\b|\bcoverage\b|\bcontent\b|\bformat\b|\bfile\b|\bpreview\b|\brender\b|산출물|결과물|템플릿|자료|본문|내용|주장|근거|출처|품질|성공기준|수용기준|커버리지|형식|파일|미리보기|렌더|동작|검수/iu;
const TOOL_GRANT_PREFLIGHT_MARKER_RE =
  /\bworkflow\s*tools?\b|\btool\s*(?:access|availability|grant|permission|contract)s?\b|도구\s*(?:접근|권한|가용|계약)/iu;
const PREFLIGHT_CONTEXT_RE =
  /\bpre[-_\s]?flight\b|\bprerequisite\b|\bcondition\b|\binput[-_\s]?check\b|\bdelivery\b|\bdownstream\b|사전|조건|필수|하위|후속/iu;
const TOOL_GRANT_PREFLIGHT_NEGATION_RE =
  /\b(?:must|should|do|does|did|will|would|can|cannot|can't)\s+not\b|\bnot\s+(?:verify|check|confirm|validate|pre[-_\s]?flight)\b|하지\s*(?:않|말)|검증하지|확인하지|점검하지/iu;

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readUnitToolNames(unit: Record<string, unknown>): string[] {
  return Array.from(new Set([
    ...readStringArray(unit.toolNames),
    ...readStringArray(unit.tools),
    typeof unit.toolName === "string" && unit.toolName.trim().length > 0 ? unit.toolName.trim() : null,
  ].filter((toolName): toolName is string => Boolean(toolName))));
}

function readUnitLabel(unit: Record<string, unknown>): string {
  for (const key of ["title", "name"]) {
    const value = unit[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function toolNameTokens(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function isDeliveryToolName(toolName: string): boolean {
  const tokens = toolNameTokens(toolName);
  if (tokens.some((token) => DELIVERY_TOOL_ACTION_TOKENS.has(token))) return true;
  const hasTarget = tokens.some((token) => DELIVERY_TOOL_TARGET_TOKENS.has(token));
  return hasTarget && tokens.some((token) => DELIVERY_TOOL_TARGET_ACTION_TOKENS.has(token));
}

export function hasDeliveryActionRole(unit: Record<string, unknown>): boolean {
  return readUnitToolNames(unit).some(isDeliveryToolName);
}

export function hasArtifactProducerRole(unit: Record<string, unknown>): boolean {
  const text = missionPlanUnitText(unit);
  const producesArtifact =
    ARTIFACT_PRODUCER_DIRECT_RE.test(text) ||
    (ARTIFACT_NOUN_RE.test(text) && ARTIFACT_PRODUCTION_VERB_RE.test(text));
  return producesArtifact && !QA_UNIT_RE.test(text) && !QA_TEXT_RE.test(text) && !hasDeliveryActionRole(unit);
}

export function hasArtifactQaRole(unit: Record<string, unknown>): boolean {
  const role = classifyWorkflowStepRole(unit);
  if (role === "action" || role === "oversight") return false;
  const label = readUnitLabel(unit);
  const text = missionPlanUnitText(unit);
  return (QA_UNIT_RE.test(label) || ARTIFACT_QA_TEXT_RE.test(text)) && ARTIFACT_QA_RE.test(text);
}

function isNonProducingGateOrQaRole(unit: Record<string, unknown>): boolean {
  const text = missionPlanUnitText(unit);
  return QA_UNIT_RE.test(text)
    || QA_TEXT_RE.test(text)
    || /\bread[-\s]?back\b|\baudit\b|\bapproval\b|\bapprove\b|\bcondition\b|\binput[-_\s]?check\b|\bprerequisite\b|\bblocker\b|\bscope\b|승인|감사|검수|조건|필수\s*조건|점검/iu.test(text);
}

function readOptionalBooleanMarker(value: unknown): boolean | null {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function readUnitWorkProductRequired(unit: Record<string, unknown>): boolean | null {
  return readOptionalBooleanMarker(unit.graphWorkProductRequired)
    ?? readOptionalBooleanMarker(unit.workProductRequired)
    ?? readOptionalBooleanMarker(unit.requiresWorkProduct);
}

function unitDiagnosticLabel(unit: Record<string, unknown>, index: number): string {
  for (const key of ["title", "name", "id"]) {
    const value = unit[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return `unit #${index + 1}`;
}

export function reviewArtifactWorkProductMarkers(
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>,
): Array<{ code: "invalid_artifact_workproduct_marker"; severity: "invalid"; message: string }> {
  const diagnostics: Array<{ code: "invalid_artifact_workproduct_marker"; severity: "invalid"; message: string }> = [];
  selectedExecutionUnits.forEach((unit, index) => {
    if (readUnitWorkProductRequired(unit) !== false) return;
    if (isNonProducingGateOrQaRole(unit)) return;
    if (!hasDeliveryActionRole(unit) && !hasArtifactProducerRole(unit)) return;
    diagnostics.push({
      code: "invalid_artifact_workproduct_marker",
      severity: "invalid",
      message: `산출물 작성/delivery unit "${unitDiagnosticLabel(unit, index)}" 이 graphWorkProductRequired:false 로 표시되어 있습니다. 공식 산출물을 만들거나 전달하는 ACTION 은 graphWorkProductRequired:true 로 두고, 순수 조건 확인/QA unit 만 false 로 두세요.`,
    });
  });
  return diagnostics;
}

function affirmativeToolPreflightText(text: string): string {
  return text
    .split(/[\n.;!?。！？]+/u)
    .filter((sentence) => !TOOL_GRANT_PREFLIGHT_NEGATION_RE.test(sentence))
    .join("\n");
}

function mentionsToolGrantPreflight(unit: Record<string, unknown>): boolean {
  const text = affirmativeToolPreflightText(missionPlanUnitText(unit));
  return TOOL_GRANT_PREFLIGHT_MARKER_RE.test(text) && PREFLIGHT_CONTEXT_RE.test(text);
}

export function reviewDeliveryToolPreflightMarkers(
  selectedExecutionUnits: ReadonlyArray<Record<string, unknown>>,
): Array<{ code: "invalid_delivery_tool_preflight_unit"; severity: "invalid"; message: string }> {
  const diagnostics: Array<{ code: "invalid_delivery_tool_preflight_unit"; severity: "invalid"; message: string }> = [];
  selectedExecutionUnits.forEach((unit, index) => {
    if (readUnitToolNames(unit).length > 0 || !mentionsToolGrantPreflight(unit)) return;
    diagnostics.push({
      code: "invalid_delivery_tool_preflight_unit",
      severity: "invalid",
      message: `조건 확인 unit "${unitDiagnosticLabel(unit, index)}" 이 downstream workflow tool 권한/가용성을 실행 중 확인하도록 되어 있습니다. 도구 배치는 PLAN/PLAN-QA에서 실제 tool unit assignee 기준으로 검증하고, ACTION preflight 는 URL/입력 접근 같은 자기 step의 실제 조건만 확인하게 수정하세요.`,
    });
  });
  return diagnostics;
}
