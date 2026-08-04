import { describe, expect, it } from "vitest";

import { buildHermesChatArgs } from "../adapters/hermes-local-execute.js";

describe("Hermes local custom provider forwarding", () => {
  it("passes a Hermes user-defined provider through unchanged", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "-m",
        "deepseek-v4-flash",
        "--provider",
        "deepseek",
      ]),
    );
  });
});
