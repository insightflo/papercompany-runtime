export interface SessionHandoffArtifact {
  version: 1;
  previousSessionId: string;
  previousRunId: string | null;
  issueId: string | null;
  rotationReason: string;
  lastRunSummaryText: string | null;
}

export function buildSessionHandoffArtifact(input: {
  previousSessionId: string;
  previousRunId: string | null;
  issueId: string | null;
  rotationReason: string;
  lastRunSummaryText: string | null;
}): SessionHandoffArtifact {
  return {
    version: 1,
    previousSessionId: input.previousSessionId,
    previousRunId: input.previousRunId,
    issueId: input.issueId,
    rotationReason: input.rotationReason,
    lastRunSummaryText: input.lastRunSummaryText,
  };
}
