export type MaintenanceRecommendedNextAction =
  | "request_missing_input"
  | "identify_affected_system"
  | "investigate"
  | "escalate_incident"
  | "vendor_handoff"
  | "repair"
  | "verify_and_close"
  | "record_recurrence";

export type MaintenanceSuggestedStatus = "todo" | "in_progress" | "blocked" | "done" | "in_review" | null;

type MaintenanceIssue = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  affectedSystem?: string | null;
  symptom?: string | null;
  timeWindow?: string | null;
  evidence?: string | null;
  verification?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type MaintenanceDecisionRuleMatch = {
  id: string;
  name: string;
  action: MaintenanceRecommendedNextAction;
  severity: "MUST" | "SHOULD" | "MAY";
  reason: string;
};

export type MaintenanceDecisionResult = {
  matchedRules: MaintenanceDecisionRuleMatch[];
  recommendedNextAction: MaintenanceRecommendedNextAction;
  requiredInputs: string[];
  suggestedStatus: MaintenanceSuggestedStatus;
  handoffTarget: string | null;
  promptBlock: string;
  kbReferences: Array<{ id: string; name: string; source: string; excerpt: string }>;
  warnings: string[];
};

export type EvaluateMaintenanceIssueInput = {
  issue: MaintenanceIssue;
  requestedStatus?: string | null;
  kbReferences?: Array<{ id: string; name: string; source?: string | null; excerpt?: string | null }>;
};

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function readMetadataString(issue: MaintenanceIssue, key: string) {
  const value = issue.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function issueText(issue: MaintenanceIssue) {
  return [issue.title, issue.description, issue.priority, issue.status]
    .map(normalizeText)
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function containsAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasAffectedSystem(issue: MaintenanceIssue, text: string) {
  return Boolean(
    normalizeText(issue.affectedSystem) ||
      readMetadataString(issue, "affectedSystem") ||
      readMetadataString(issue, "affected_system") ||
      containsAny(text, [
        /affected\s+system\s*[:=]/i,
        /system\s*[:=]/i,
        /서비스|시스템|kiosk|키오스크|printer|프린터|결제|payment|pg사|api/i,
      ]),
  );
}

function hasSymptom(issue: MaintenanceIssue, text: string) {
  return Boolean(
    normalizeText(issue.symptom) ||
      readMetadataString(issue, "symptom") ||
      containsAny(text, [
        /symptom\s*[:=]/i,
        /오류|불가|timeout|타임아웃|응답|걸림|실패|error|failed|failure|outage|down/i,
      ]),
  );
}

function hasTimeWindow(issue: MaintenanceIssue, text: string) {
  return Boolean(
    normalizeText(issue.timeWindow) ||
      readMetadataString(issue, "timeWindow") ||
      readMetadataString(issue, "time_window") ||
      containsAny(text, [
        /time\s*window\s*[:=]/i,
        /\b\d{1,2}:\d{2}\b/,
        /\b\d{4}-\d{2}-\d{2}\b/,
        /부터|까지|동안|오전|오후|오늘|어제|방금|반복|최근|since|between|during/i,
      ]),
  );
}

function hasCompletionEvidence(issue: MaintenanceIssue, text: string) {
  return Boolean(
    normalizeText(issue.evidence) ||
      normalizeText(issue.verification) ||
      readMetadataString(issue, "evidence") ||
      readMetadataString(issue, "verification") ||
      containsAny(text, [/evidence\s*[:=]/i, /verification\s*[:=]/i, /검증|증빙|스크린샷|로그|확인 완료|재현 확인|테스트 통과/i]),
  );
}

function buildPromptBlock(result: Omit<MaintenanceDecisionResult, "promptBlock">) {
  const required = result.requiredInputs.length > 0 ? result.requiredInputs.join(", ") : "none";
  const matches = result.matchedRules.map((rule) => `${rule.name}: ${rule.reason}`).join("; ") || "none";
  return [
    "Maintenance decision preflight:",
    `- Recommended next action: ${result.recommendedNextAction}`,
    `- Suggested status: ${result.suggestedStatus ?? "none"}`,
    `- Required inputs: ${required}`,
    `- Matched rules: ${matches}`,
  ].join("\n");
}

export const maintenanceDecisionService = {
  evaluateIssue(input: EvaluateMaintenanceIssueInput): MaintenanceDecisionResult {
    const issue = input.issue;
    const text = issueText(issue);
    const matchedRules: MaintenanceDecisionRuleMatch[] = [];
    const requiredInputs: string[] = [];
    const warnings: string[] = [];

    const attemptedDone = (input.requestedStatus ?? issue.status ?? "").toLowerCase() === "done";
    const incidentExplicit = containsAny(text, [
      /outage|down|customer\s+impact|customer-facing|production\s+incident/i,
      /고객.*(불가|장애|영향|중단)|전체.*(불가|장애)|서비스.*(불가|중단)|장애 상황/i,
    ]);
    const vendorExplicit = containsAny(text, [
      /vendor|external\s+(dependency|api|service)|third[-\s]?party|provider/i,
      /벤더|외부\s*(연동|의존|api|서비스)|pg사|공급사/i,
    ]);

    if (incidentExplicit) {
      matchedRules.push({
        id: "maintenance-incident-escalation",
        name: "Escalate explicit customer-impact outage",
        action: "escalate_incident",
        severity: "MUST",
        reason: "Issue text explicitly mentions customer impact or outage.",
      });
    }

    if (vendorExplicit) {
      matchedRules.push({
        id: "maintenance-vendor-handoff",
        name: "Prepare vendor handoff for explicit external dependency",
        action: "vendor_handoff",
        severity: "SHOULD",
        reason: "Issue text explicitly mentions an external or vendor dependency.",
      });
    }

    if (attemptedDone && !hasCompletionEvidence(issue, text)) {
      warnings.push("completion_evidence_missing");
      matchedRules.push({
        id: "maintenance-verify-before-close",
        name: "Verify before close",
        action: "verify_and_close",
        severity: "SHOULD",
        reason: "Completion was attempted without explicit evidence or verification.",
      });
    }

    if (!hasAffectedSystem(issue, text)) requiredInputs.push("affectedSystem");
    if (!hasSymptom(issue, text)) requiredInputs.push("symptom");
    if (!hasTimeWindow(issue, text)) requiredInputs.push("timeWindow");

    if (requiredInputs.length > 0 && matchedRules.length === 0) {
      matchedRules.push({
        id: "maintenance-request-missing-input",
        name: "Request missing maintenance intake input",
        action: "request_missing_input",
        severity: "MUST",
        reason: `Missing required intake fields: ${requiredInputs.join(", ")}.`,
      });
    }

    const recommendedNextAction: MaintenanceRecommendedNextAction = incidentExplicit
      ? "escalate_incident"
      : vendorExplicit
        ? "vendor_handoff"
        : attemptedDone && !hasCompletionEvidence(issue, text)
          ? "verify_and_close"
          : requiredInputs.length > 0
            ? "request_missing_input"
            : "investigate";

    const suggestedStatus: MaintenanceSuggestedStatus =
      recommendedNextAction === "request_missing_input"
        ? "blocked"
        : recommendedNextAction === "verify_and_close"
          ? "in_review"
          : recommendedNextAction === "escalate_incident" || recommendedNextAction === "vendor_handoff"
            ? "in_progress"
            : null;

    const resultWithoutPrompt = {
      matchedRules,
      recommendedNextAction,
      requiredInputs,
      suggestedStatus,
      handoffTarget: recommendedNextAction === "vendor_handoff" ? "vendor" : null,
      kbReferences: (input.kbReferences ?? []).map((reference) => ({
        id: reference.id,
        name: reference.name,
        source: reference.source ?? reference.name,
        excerpt: reference.excerpt ?? "",
      })),
      warnings,
    };

    return {
      ...resultWithoutPrompt,
      promptBlock: buildPromptBlock(resultWithoutPrompt),
    };
  },
};
