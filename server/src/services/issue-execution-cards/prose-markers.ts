export const ARTIFACT_MARKER = "[ARTIFACT]: <absolute path>" as const;
export const DELIVERY_VERIFICATION_MARKER = "Delivery Verification:";

const ARTIFACT_DECLARATION_RE = /`?\[?ARTIFACT\]?`?\s*:/iu;
const OUTPUT_DIRECTORY_RE = /Deliverable output \(use exactly this directory\)|assigned output directory/iu;
const WORK_PRODUCT_REGISTRATION_RE = /registered workProduct|issue_work_products|Register the artifact/iu;
const REQUEST_CHANGES_RE = /\bREQUEST[_\s-]?CHANGES\b/iu;
const PASS_RE = /\bPASS\b/u;
const QA_RUBRIC_RE = /QA grading rubric|validator|validation issue/iu;

export type ProseIssueContract = {
  workProductRequired: boolean;
  workflowVerdictRequired: boolean;
  deliveryReadbackRequired: boolean;
  preservedMarkers: string[];
};

export function extractProseIssueContract(description: string | null | undefined): ProseIssueContract {
  const text = description ?? "";
  const preservedMarkers: string[] = [];

  if (ARTIFACT_DECLARATION_RE.test(text)) preservedMarkers.push(ARTIFACT_MARKER);
  if (OUTPUT_DIRECTORY_RE.test(text)) preservedMarkers.push("Deliverable output directory");
  if (WORK_PRODUCT_REGISTRATION_RE.test(text)) preservedMarkers.push("registered workProduct");
  if (PASS_RE.test(text) && REQUEST_CHANGES_RE.test(text)) preservedMarkers.push("PASS/REQUEST_CHANGES");
  if (text.includes(DELIVERY_VERIFICATION_MARKER)) preservedMarkers.push(DELIVERY_VERIFICATION_MARKER);

  return {
    workProductRequired: ARTIFACT_DECLARATION_RE.test(text) &&
      (OUTPUT_DIRECTORY_RE.test(text) || WORK_PRODUCT_REGISTRATION_RE.test(text)),
    workflowVerdictRequired: PASS_RE.test(text) && REQUEST_CHANGES_RE.test(text) && QA_RUBRIC_RE.test(text),
    deliveryReadbackRequired: text.includes(DELIVERY_VERIFICATION_MARKER),
    preservedMarkers: Array.from(new Set(preservedMarkers)),
  };
}
