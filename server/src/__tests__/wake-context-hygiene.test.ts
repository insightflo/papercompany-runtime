import { describe, expect, it } from "vitest";
import {
  WAKE_RECENT_COMMENT_BODY_MAX_CHARS,
  capWakeRecentCommentBody,
  refreshStepInputManifest,
} from "../services/wake-context-hygiene.js";

describe("wake-context-hygiene", () => {
  describe("capWakeRecentCommentBody", () => {
    it("keeps short comment bodies verbatim", () => {
      expect(capWakeRecentCommentBody("Looks good.")).toBe("Looks good.");
    });

    it("truncates oversized comment bodies to the wake cap with a marker", () => {
      const longBody = "x".repeat(WAKE_RECENT_COMMENT_BODY_MAX_CHARS + 5_000);
      const capped = capWakeRecentCommentBody(longBody);
      expect(capped).not.toBeNull();
      expect(capped!.length).toBeLessThanOrEqual(WAKE_RECENT_COMMENT_BODY_MAX_CHARS + 40);
      expect(capped!.startsWith("x".repeat(WAKE_RECENT_COMMENT_BODY_MAX_CHARS))).toBe(true);
      expect(capped!).toContain("[truncated]");
    });

    it("handles null bodies", () => {
      expect(capWakeRecentCommentBody(null)).toBeNull();
      expect(capWakeRecentCommentBody(undefined)).toBeNull();
    });
  });

  describe("refreshStepInputManifest", () => {
    const missionPlan = {
      available: true,
      missionPlanId: "plan-1",
      revision: 2,
      status: "active",
      missionGoal: "Customer homepage rollout",
      selectedExecutionUnitLabels: ["Run preflight smoke"],
    };

    it("drops the raw paperclipMissionPlan key once the manifest carries the plan", () => {
      const context: Record<string, unknown> = {
        taskKey: "issue:123",
        issueId: "issue-1",
        paperclipMissionPlan: missionPlan,
      };
      refreshStepInputManifest(context, "issue:123");

      expect(context.paperclipMissionPlan).toBeUndefined();
      const manifest = context.paperclipStepInputManifest as {
        inputs: { missionPlan: { available: boolean; missionPlanId: string | null } };
      };
      expect(manifest.inputs.missionPlan.available).toBe(true);
      expect(manifest.inputs.missionPlan.missionPlanId).toBe("plan-1");
    });

    it("keeps missionPlan in the manifest across repeated refreshes (carry-forward)", () => {
      const context: Record<string, unknown> = {
        taskKey: "issue:123",
        issueId: "issue-1",
        paperclipMissionPlan: missionPlan,
      };
      refreshStepInputManifest(context, "issue:123");
      refreshStepInputManifest(context, "issue:123");
      refreshStepInputManifest(context, "issue:123");

      const manifest = context.paperclipStepInputManifest as {
        inputs: { missionPlan: { available: boolean; missionPlanId: string | null } };
      };
      expect(manifest.inputs.missionPlan.available).toBe(true);
      expect(manifest.inputs.missionPlan.missionPlanId).toBe("plan-1");
      expect(context.paperclipMissionPlan).toBeUndefined();
    });

    it("leaves contexts without a mission plan untouched", () => {
      const context: Record<string, unknown> = { taskKey: "issue:123" };
      refreshStepInputManifest(context, "issue:123");
      const manifest = context.paperclipStepInputManifest as {
        inputs: { missionPlan: { available: boolean } };
      };
      expect(manifest.inputs.missionPlan.available).toBe(false);
    });
  });
});
