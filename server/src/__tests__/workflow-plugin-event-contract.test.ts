import { describe, expect, it } from "vitest";
import { PLUGIN_EVENT_TYPES, WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT } from "@paperclipai/shared";
import { WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT as WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT_FROM_CONSTANTS } from "@paperclipai/shared/constants";

describe("workflow plugin event contract", () => {
  it("exports the core workflow tool execution request event as a subscribable plugin event", () => {
    expect(WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT).toBe("workflow-tool-execution-request");
    expect(WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT_FROM_CONSTANTS).toBe("workflow-tool-execution-request");
    expect(PLUGIN_EVENT_TYPES).toContain(WORKFLOW_TOOL_EXECUTION_REQUEST_EVENT);
  });
});
