import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { readPayload, shortSha } from "./external-automation-payload";

function approvalWith(payload: Record<string, unknown>): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "external_automation",
    requestedByAgentId: null,
    requestedByUserId: null,
    requestedByPluginId: "insightflo.github-repository-bridge",
    status: "pending",
    payload,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-07-21T00:00:00.000Z"),
    updatedAt: new Date("2026-07-21T00:00:00.000Z"),
  };
}

describe("ExternalAutomationApprovals payload helpers", () => {
  it("reads repository, branch, commit, title and summary from the approval payload", () => {
    const payload = readPayload(
      approvalWith({
        repository: "acme/runtime",
        branch: "main",
        commit: "deadbeefcafebabe",
        title: "Deploy acme/runtime main",
        summary: "All required checks passed.",
      }),
    );
    expect(payload.repository).toBe("acme/runtime");
    expect(payload.branch).toBe("main");
    expect(payload.commit).toBe("deadbeefcafebabe");
    expect(payload.title).toBe("Deploy acme/runtime main");
    expect(payload.summary).toBe("All required checks passed.");
  });

  it("returns an empty object when the payload is missing or non-object", () => {
    expect(readPayload({ ...approvalWith({}), payload: {} as Record<string, unknown> }).repository).toBeUndefined();
  });

  it("truncates long SHAs to a human-readable prefix", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456789ab…");
    expect(shortSha("abcd1234")).toBe("abcd1234");
  });
});
