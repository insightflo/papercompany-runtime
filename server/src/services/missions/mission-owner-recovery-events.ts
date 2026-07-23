export type MissionOwnerDecisionOption =
  | "request_input"
  | "retry_source_issue"
  | "reassign_source_issue"
  | "replan_mission"
  | "escalate"
  | "report_impossible"
  | "recover_artifact"
  | "no_action_waiting";

export const MISSION_OWNER_DECISION_OPTIONS: MissionOwnerDecisionOption[] = [
  "request_input",
  "retry_source_issue",
  "reassign_source_issue",
  "replan_mission",
  "escalate",
  "report_impossible",
  "recover_artifact",
  "no_action_waiting",
];

export type MissionOwnerActionMarker = {
  missionId: string;
  sourceIssueId?: string;
  actionType: "unblock";
  status?: string;
};

export function buildMissionOwnerActionMarker(input: {
  missionId: string;
  sourceIssueId: string;
  actionType: "unblock";
  status: "decision_required";
}): string {
  return `<!-- mission-owner-action:${JSON.stringify({
    missionId: input.missionId,
    sourceIssueId: input.sourceIssueId,
    actionType: input.actionType,
    status: input.status,
  })} -->`;
}

const MISSION_OWNER_ACTION_MARKER_PATTERN = /<!--\s*mission-owner-action\s*:\s*(\{[\s\S]*?\})\s*-->/i;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseMissionOwnerActionMarker(description: string | null | undefined): MissionOwnerActionMarker | null {
  const match = description?.match(MISSION_OWNER_ACTION_MARKER_PATTERN);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    const missionId = readNonEmptyString(parsed.missionId);
    const sourceIssueId = readNonEmptyString(parsed.sourceIssueId) ?? undefined;
    const actionType = readNonEmptyString(parsed.actionType);
    const status = readNonEmptyString(parsed.status) ?? undefined;
    if (!missionId || actionType !== "unblock") return null;
    return { missionId, sourceIssueId, actionType, status };
  } catch {
    return null;
  }
}

export function buildMissionOwnerDecisionFormat(): string {
  return [
    "Optional display-only comment template (the API submission is authoritative):",
    "### Mission owner decision",
    "Decision: <one of the allowed decision options>",
    "Source issue: <source issue identifier or id>",
    "Rework target: <upstream producer issue identifier to revise when a QA gate blocked the source; omit when retrying the source itself>",
    "Reason: <why this decision is appropriate>",
    "Next action: <specific next action or waiting condition>",
    "Evidence: <compact evidence used for the decision>",
  ].join("\n");
}

export type ExtractedMissionOwnerDecision = {
  decision: MissionOwnerDecisionOption;
  sourceIssueRef?: string;
  reworkTargetRef?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
} | {
  decision: null;
  invalidDecision: string;
  sourceIssueRef?: string;
  reworkTargetRef?: string;
  reason?: string;
  nextAction?: string;
  evidence?: string;
};

export type AppliedMissionOwnerDecisionOption = "retry_source_issue" | "reassign_source_issue";

const MISSION_OWNER_DECISION_BLOCK_HEADINGS = [
  "### Mission owner decision",
  "## Mission-owner adjudication recorded",
] as const;

function firstNonEmptyLine(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function readDecisionField(block: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedField}\\s*:\\s*([\\s\\S]*?)(?=^\\w[\\w ]*\\s*:|^###\\s+|(?![\\s\\S]))`, "im");
  return firstNonEmptyLine(pattern.exec(block)?.[1]);
}

export function extractMissionOwnerDecisionFromText(text: string): ExtractedMissionOwnerDecision | null {
  const lowerText = text.toLowerCase();
  let latest: { index: number; blockStart: number; rawDecision?: string } | null = null;
  for (const heading of MISSION_OWNER_DECISION_BLOCK_HEADINGS) {
    const index = lowerText.lastIndexOf(heading.toLowerCase());
    if (index >= 0 && (!latest || index > latest.index)) {
      latest = { index, blockStart: index + heading.length };
    }
  }
  for (const match of text.matchAll(/Mission-owner decision recorded\s*:\s*([a-z_]+)/gi)) {
    const index = match.index;
    if (!latest || index > latest.index) {
      latest = { index, blockStart: index + match[0].length, rawDecision: match[1]?.toLowerCase() };
    }
  }
  if (!latest) return null;

  const rest = text.slice(latest.blockStart);
  const nextHeading = rest.search(/^#{1,6}\s+/m);
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  const rawDecision = latest.rawDecision ?? readDecisionField(block, "Decision")?.toLowerCase();
  if (!rawDecision) return null;

  const sourceIssueRef = readDecisionField(block, "Source issue");
  const reworkTargetRef = readDecisionField(block, "Rework target");
  const reason = readDecisionField(block, "Reason");
  const nextAction = readDecisionField(block, "Next action");
  const evidence = readDecisionField(block, "Evidence");

  if (!MISSION_OWNER_DECISION_OPTIONS.includes(rawDecision as MissionOwnerDecisionOption)) {
    return { decision: null, invalidDecision: rawDecision, sourceIssueRef, reworkTargetRef, reason, nextAction, evidence };
  }

  return { decision: rawDecision as MissionOwnerDecisionOption, sourceIssueRef, reworkTargetRef, reason, nextAction, evidence };
}

export function buildMissionOwnerDecisionAppliedMarker(input: {
  ownerActionIssueId: string;
  sourceIssueId: string;
  decision: AppliedMissionOwnerDecisionOption;
}): string {
  return `<!-- mission-owner-decision-applied:${JSON.stringify(input)} -->`;
}

export function hasMissionOwnerDecisionAppliedMarker(comments: string[], input: {
  ownerActionIssueId: string;
  sourceIssueId: string;
  decision: AppliedMissionOwnerDecisionOption;
}): boolean {
  const marker = buildMissionOwnerDecisionAppliedMarker(input);
  return comments.some((comment) => comment.includes(marker));
}

export function buildMissionOwnerDecisionWakeupIdempotencyKey(input: {
  missionId: string;
  ownerActionIssueId: string;
  sourceIssueId: string;
  decision?: AppliedMissionOwnerDecisionOption;
}): string {
  return `mission-owner-decision-wakeup:${input.missionId}:${input.ownerActionIssueId}:${input.sourceIssueId}:${input.decision ?? "retry_source_issue"}`;
}

export function buildMissionOwnerDecisionWakeupDispatchedMarker(input: {
  missionId: string;
  ownerActionIssueId: string;
  sourceIssueId: string;
  decision: AppliedMissionOwnerDecisionOption;
  idempotencyKey: string;
}): string {
  return `<!-- mission-owner-decision-wakeup-dispatched:${JSON.stringify(input)} -->`;
}

export function hasMissionOwnerDecisionWakeupDispatchedMarker(comments: string[], input: {
  missionId: string;
  ownerActionIssueId: string;
  sourceIssueId: string;
  decision: AppliedMissionOwnerDecisionOption;
  idempotencyKey: string;
}): boolean {
  const marker = buildMissionOwnerDecisionWakeupDispatchedMarker(input);
  return comments.some((comment) => comment.includes(marker));
}

export function buildStaleSourceIssueWakeupDispatchedMarker(input: {
  missionId: string;
  sourceIssueId: string;
  failedRunId: string;
  idempotencyKey: string;
}): string {
  return `<!-- mission-stale-source-wakeup-dispatched:${JSON.stringify(input)} -->`;
}

export function hasStaleSourceIssueWakeupDispatchedMarker(comments: string[], input: {
  missionId: string;
  sourceIssueId: string;
  failedRunId: string;
  idempotencyKey: string;
}): boolean {
  const marker = buildStaleSourceIssueWakeupDispatchedMarker(input);
  return comments.some((comment) => comment.includes(marker));
}

// workProduct-reuse recovery wake: a blocked graphWorkProductRequired producer with no
// registered workProduct, a stalled recovery issue, and the expected artifact file already on
// disk. Keyed by the artifact path so a later different file can re-arm, while the dispatched
// marker prevents repeat dispatch for the same input.
export function buildWorkProductReuseWakeIdempotencyKey(input: {
  missionId: string;
  sourceIssueId: string;
  artifactPath: string;
}): string {
  return `mission-workproduct-reuse-wakeup:${input.missionId}:${input.sourceIssueId}:${input.artifactPath}`;
}

export function buildWorkProductReuseWakeDispatchedMarker(input: {
  missionId: string;
  sourceIssueId: string;
  artifactPath: string;
  idempotencyKey: string;
}): string {
  return `<!-- mission-workproduct-reuse-wakeup-dispatched:${JSON.stringify(input)} -->`;
}

export function hasWorkProductReuseWakeDispatchedMarker(comments: string[], input: {
  missionId: string;
  sourceIssueId: string;
  artifactPath: string;
  idempotencyKey: string;
}): boolean {
  const marker = buildWorkProductReuseWakeDispatchedMarker(input);
  return comments.some((comment) => comment.includes(marker));
}
