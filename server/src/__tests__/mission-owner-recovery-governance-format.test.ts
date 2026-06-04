import { describe, expect, it } from "vitest";
import type { MissionGovernanceThreadSummary } from "../services/missions/governance-thread.js";
import {
  formatGovernanceEventSummary,
  formatGovernanceThreadEvidenceLines,
  governanceThreadReasonSuffix,
} from "../services/missions/mission-owner-recovery-governance-format.js";

function event(overrides: Partial<MissionGovernanceThreadSummary["latestEvents"][number]> = {}): MissionGovernanceThreadSummary["latestEvents"][number] {
  return {
    id: overrides.id ?? "event-1",
    companyId: overrides.companyId ?? "company-1",
    scope: overrides.scope ?? { missionId: "mission-1" },
    sourceRef: overrides.sourceRef ?? { type: "issue", id: "issue-1" },
    eventType: overrides.eventType ?? "heartbeat_failed",
    title: overrides.title ?? "Heartbeat failed",
    summary: overrides.summary ?? "worker run failed",
    timestamp: overrides.timestamp ?? "2026-06-04T00:00:00.000Z",
    severity: overrides.severity ?? "failed",
    actor: overrides.actor,
    evidenceRefs: overrides.evidenceRefs,
    suggestedResumeTarget: overrides.suggestedResumeTarget,
    rawAvailable: overrides.rawAvailable,
  };
}

describe("mission owner recovery governance formatting", () => {
  it("formats event summaries with source references", () => {
    expect(formatGovernanceEventSummary(event({
      eventType: "owner_diagnosis",
      title: "Owner review",
      summary: "needs operator decision",
      sourceRef: { type: "issue_comment", id: "comment-1" },
    }))).toBe("owner_diagnosis: Owner review — needs operator decision [issue_comment:comment-1]");
  });

  it("prefers open decisions, then latest failed/blocked/attention event for reason suffix", () => {
    const attention = event({ id: "event-attn", eventType: "activity_observed", summary: "attention item", severity: "attention" });
    const failed = event({ id: "event-failed", eventType: "heartbeat_failed", summary: "failed item", severity: "failed" });
    const decision = event({ id: "event-decision", eventType: "owner_diagnosis", summary: "decision item", severity: "blocked" });

    expect(governanceThreadReasonSuffix({
      totalEventCount: 3,
      latestEvents: [attention, failed],
      openDecisions: [decision],
    })).toBe("owner_diagnosis: decision item");

    expect(governanceThreadReasonSuffix({
      totalEventCount: 2,
      latestEvents: [attention, failed],
      openDecisions: [],
    })).toBe("heartbeat_failed: failed item");

    expect(governanceThreadReasonSuffix(null)).toBeNull();
    expect(governanceThreadReasonSuffix({ totalEventCount: 0, latestEvents: [], openDecisions: [] })).toBeNull();
  });

  it("formats bounded governance evidence lines including open decisions", () => {
    const latestEvents = Array.from({ length: 7 }, (_, index) => event({
      id: `event-${index}`,
      eventType: "activity_observed",
      title: `Event ${index}`,
      summary: `summary ${index}`,
      sourceRef: { type: "activity_log", id: `activity-${index}` },
      severity: "info",
    }));
    const openDecisions = [event({
      id: "decision-1",
      eventType: "owner_diagnosis",
      title: "Decision",
      summary: "choose recovery",
      sourceRef: { type: "issue", id: "issue-2" },
      severity: "blocked",
    })];

    const lines = formatGovernanceThreadEvidenceLines({
      totalEventCount: 8,
      latestEvents,
      openDecisions,
    });

    expect(lines[0]).toBe("Governance thread evidence:");
    expect(lines[1]).toBe("- Total governance events observed: 8");
    expect(lines).not.toContain("- activity_observed: Event 0 — summary 0 [activity_log:activity-0]");
    expect(lines).toContain("- activity_observed: Event 6 — summary 6 [activity_log:activity-6]");
    expect(lines).toContain("- Open decisions:");
    expect(lines).toContain("  - owner_diagnosis: Decision — choose recovery [issue:issue-2]");
    expect(formatGovernanceThreadEvidenceLines(undefined)).toEqual([]);
  });
});
