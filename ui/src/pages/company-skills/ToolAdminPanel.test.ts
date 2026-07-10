import { describe, expect, it } from "vitest";
import {
  buildToolPayload,
  emptyToolForm,
  isSourceManagedTool,
  resolveToolSelection,
} from "./toolAdminModel";

describe("tool administration state", () => {
  it("keeps the editor in create mode when tools already exist", () => {
    const selectedToolId = resolveToolSelection({
      isCreating: true,
      selectedToolId: null,
      toolIds: ["tool-1", "tool-2"],
    });

    expect(selectedToolId).toBeNull();
  });

  it("selects the first available tool when the current company changes", () => {
    const selectedToolId = resolveToolSelection({
      isCreating: false,
      selectedToolId: "old-company-tool",
      toolIds: ["new-company-tool", "other-new-company-tool"],
    });

    expect(selectedToolId).toBe("new-company-tool");
  });

  it("rejects a tool name that is empty after trimming", () => {
    expect(() => buildToolPayload({ ...emptyToolForm, name: "   " })).toThrow("Tool name is required.");
  });

  it("recognizes definitions synchronized from the Tool Registry", () => {
    expect(isSourceManagedTool({ source: "tool-registry" })).toBe(true);
    expect(isSourceManagedTool({ command: "pnpm collect" })).toBe(false);
  });
});
