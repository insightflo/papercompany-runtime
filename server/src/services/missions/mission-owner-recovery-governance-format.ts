import type { MissionGovernanceThreadSummary } from "./governance-thread.js";

type GovernanceSummaryEvent = MissionGovernanceThreadSummary["latestEvents"][number];

const GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT = 5;

export function formatGovernanceEventSummary(event: GovernanceSummaryEvent): string {
  const source = `${event.sourceRef.type}:${event.sourceRef.id}`;
  return `${event.eventType}: ${event.title} — ${event.summary} [${source}]`;
}

export function governanceThreadReasonSuffix(summary: MissionGovernanceThreadSummary | null | undefined): string | null {
  if (!summary || summary.totalEventCount === 0) return null;
  const decisionEvent = summary.openDecisions[0];
  const failedOrBlockedEvent = [...summary.latestEvents]
    .reverse()
    .find((event) => event.severity === "failed" || event.severity === "blocked" || event.severity === "attention");
  const event = decisionEvent ?? failedOrBlockedEvent ?? summary.latestEvents.at(-1);
  if (!event) return `governance thread observed ${summary.totalEventCount} event(s)`;
  return `${event.eventType}: ${event.summary}`;
}

export function formatGovernanceThreadEvidenceLines(summary: MissionGovernanceThreadSummary | null | undefined): string[] {
  if (!summary || summary.totalEventCount === 0) return [];
  const latestEventLines = summary.latestEvents
    .slice(-GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT)
    .map((event) => `- ${formatGovernanceEventSummary(event)}`);
  const openDecisionLines = summary.openDecisions.length > 0
    ? [
      "- Open decisions:",
      ...summary.openDecisions
        .slice(0, GOVERNANCE_THREAD_COMMENT_EVENT_LIMIT)
        .map((event) => `  - ${formatGovernanceEventSummary(event)}`),
    ]
    : [];
  return [
    "Governance thread evidence:",
    `- Total governance events observed: ${summary.totalEventCount}`,
    ...latestEventLines,
    ...openDecisionLines,
  ];
}
