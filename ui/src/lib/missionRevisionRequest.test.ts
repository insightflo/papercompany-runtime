import { describe, expect, it } from "vitest";

import { buildMissionRevisionPrefill } from "./missionRevisionRequest";

// [수정 요청 미션] 원본 맥락 사전 채움 — 링크·산출물·수정 지시 칸·오너 승계.
describe("buildMissionRevisionPrefill", () => {
  const mission = { id: "0b57da0a-c6dc-45f1-a728-dd28ebae72a5", title: "2026-08-30 evo harness rl", ownerAgentId: "owner-1" };

  it("carries the board mission link, latest completed artifacts, instruction placeholder, and the same owner", () => {
    const prefill = buildMissionRevisionPrefill({
      mission,
      workflowRuns: [
        {
          id: "run-1",
          status: "completed",
          steps: [
            {
              stepId: "s1",
              workProducts: [
                { url: "https://manual-onboarding.pages.dev/onboarding/concepts/20260830-evo-harness-rl/index.html", title: "발행본", createdAt: "2026-08-29T20:00:00Z" },
                { url: null, title: "URL 없는 산출물", createdAt: "2026-08-29T20:01:00Z" },
              ],
            } as never,
          ],
        } as never,
        { id: "run-2", status: "failed", steps: [] } as never,
      ],
      origin: "https://papercompany.showk.ing",
      issuePrefix: "RES",
    });

    expect(prefill.title).toBe("수정 요청 — 2026-08-30 evo harness rl");
    expect(prefill.ownerAgentId).toBe("owner-1");
    expect(prefill.description).toContain("원본 미션 링크: https://papercompany.showk.ing/RES/missions/0b57da0a-c6dc-45f1-a728-dd28ebae72a5");
    expect(prefill.description).toContain("- https://manual-onboarding.pages.dev/onboarding/concepts/20260830-evo-harness-rl/index.html (발행본)");
    expect(prefill.description).not.toContain("URL 없는 산출물");
    expect(prefill.description).toContain("수정 지시:");
    expect(prefill.description).toContain("기존 승인 양식/템플릿");
  });

  it("falls back to the raw mission id when the company prefix is unavailable and omits the artifact section when none", () => {
    const prefill = buildMissionRevisionPrefill({ mission, workflowRuns: [], origin: "https://x", issuePrefix: null });
    expect(prefill.description).toContain(`원본 미션 링크: ${mission.id}`);
    expect(prefill.description).not.toContain("원본 최종 산출물:");
  });
});
