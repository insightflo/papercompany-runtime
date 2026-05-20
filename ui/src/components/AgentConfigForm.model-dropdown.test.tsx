// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isAdapterTypeEnabled } from "./agent-config-adapter-types";
import { getCustomModelCandidate } from "../lib/model-dropdown";

describe("AgentConfigForm model dropdown custom option", () => {
  it("offers a searched custom model when it is not already listed", () => {
    const candidate = getCustomModelCandidate(
      [
        { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
        { id: "gpt-5.4", label: "gpt-5.4" },
      ],
      "gpt-5.5-codex",
    );

    expect(candidate).toBe("gpt-5.5-codex");
  });

  it("does not offer a duplicate custom model", () => {
    const candidate = getCustomModelCandidate(
      [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
      " Claude Sonnet 4.6 ",
    );

    expect(candidate).toBeNull();
  });

  it("treats Antigravity local as selectable rather than coming soon", () => {
    expect(isAdapterTypeEnabled("antigravity_local")).toBe(true);
  });
});
