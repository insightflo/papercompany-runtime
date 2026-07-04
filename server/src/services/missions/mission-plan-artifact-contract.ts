import { missionPlanUnitText } from "./mission-plan-unit-text.js";

const STRICT_PUBLISH_UNIT_RE =
  /\bmanual[-_\s]?onboarding\b|\bpublisher\b|\bcloudflare\b|\bpages\b|\bR2\b|\bpublish(?:ed|ing)?\b|\bdeploy(?:ed|ing|ment)?\b|\bupload(?:ed|ing)?\b|\bhost(?:ed|ing)?\b|게시|배포|업로드|출간|출판|올리(?!픽)|사이트\s*(?:게시|배포|업로드)|웹사이트\s*(?:게시|배포|업로드)/iu;
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

export function hasStrictPublishRole(unit: Record<string, unknown>): boolean {
  return STRICT_PUBLISH_UNIT_RE.test(missionPlanUnitText(unit));
}

export function hasArtifactProducerRole(unit: Record<string, unknown>): boolean {
  const text = missionPlanUnitText(unit);
  const producesArtifact =
    ARTIFACT_PRODUCER_DIRECT_RE.test(text) ||
    (ARTIFACT_NOUN_RE.test(text) && ARTIFACT_PRODUCTION_VERB_RE.test(text));
  return producesArtifact && !QA_UNIT_RE.test(text) && !QA_TEXT_RE.test(text) && !hasStrictPublishRole(unit);
}

export function hasArtifactQaRole(unit: Record<string, unknown>): boolean {
  const text = missionPlanUnitText(unit);
  return (QA_UNIT_RE.test(text) || ARTIFACT_QA_TEXT_RE.test(text)) && ARTIFACT_QA_RE.test(text);
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
    if (!hasStrictPublishRole(unit) && !hasArtifactProducerRole(unit)) return;
    diagnostics.push({
      code: "invalid_artifact_workproduct_marker",
      severity: "invalid",
      message: `산출물 작성/게시 unit "${unitDiagnosticLabel(unit, index)}" 이 graphWorkProductRequired:false 로 표시되어 있습니다. 공식 산출물을 만드는 ACTION 은 graphWorkProductRequired:true 로 두고, 순수 조건 확인/QA unit 만 false 로 두세요.`,
    });
  });
  return diagnostics;
}
