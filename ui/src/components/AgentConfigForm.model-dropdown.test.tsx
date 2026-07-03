// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isAdapterTypeEnabled } from "./agent-config-adapter-types";
import { getCustomModelCandidate } from "../lib/model-dropdown";
import {
  filterModelsByProvider,
  listModelProviders,
  resolveProviderModelSelection,
} from "../lib/model-utils";

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

describe("Hermes provider model helpers", () => {
  const models = [
    { id: "openai-codex/gpt-5.4-mini", label: "gpt-5.4-mini" },
    { id: "openai-codex/gpt-5.4", label: "gpt-5.4" },
    { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "gpt-5.4", label: "gpt-5.4" },
  ];

  it("lists only explicit providers with model counts", () => {
    expect(listModelProviders(models)).toEqual([
      { id: "anthropic", label: "anthropic", modelCount: 1 },
      { id: "openai-codex", label: "openai-codex", modelCount: 2 },
    ]);
  });

  it("filters models to the selected provider", () => {
    expect(filterModelsByProvider(models, "openai-codex")).toEqual([
      { id: "openai-codex/gpt-5.4-mini", label: "gpt-5.4-mini" },
      { id: "openai-codex/gpt-5.4", label: "gpt-5.4" },
    ]);
  });

  it("preserves the model name when switching providers when possible", () => {
    expect(
      resolveProviderModelSelection(
        [
          { id: "openai-codex/gpt-5.4-mini", label: "gpt-5.4-mini" },
          { id: "other/gpt-5.4-mini", label: "gpt-5.4-mini" },
        ],
        "other",
        "openai-codex/gpt-5.4-mini",
      ),
    ).toBe("other/gpt-5.4-mini");
  });

  it("falls back to the first provider model when the current model is unavailable", () => {
    expect(resolveProviderModelSelection(models, "anthropic", "openai-codex/gpt-5.4")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("falls back to the first provider model when the current model is missing at runtime", () => {
    const selected = Reflect.apply(resolveProviderModelSelection, undefined, [
      models,
      "openai-codex",
      undefined,
    ]);

    expect(selected).toBe("openai-codex/gpt-5.4-mini");
  });
});
