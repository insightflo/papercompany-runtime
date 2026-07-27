import { describe, expect, it } from "vitest";
import { nextSelectedEdgeIdAfterDisconnect } from "./WorkflowGraphEditorHelpers";

describe("nextSelectedEdgeIdAfterDisconnect", () => {
  it("clears a plain edge selection matching the removed source/target", () => {
    expect(nextSelectedEdgeIdAfterDisconnect("if-1->agent-1", "if-1", "agent-1")).toBeNull();
  });

  it("clears a colon-suffixed conditional edge selection", () => {
    expect(nextSelectedEdgeIdAfterDisconnect("if-1->complete-1:condition_false", "if-1", "complete-1")).toBeNull();
    expect(nextSelectedEdgeIdAfterDisconnect("if-1->agent-1:condition_true", "if-1", "agent-1")).toBeNull();
  });

  it("preserves an unrelated edge selection", () => {
    expect(nextSelectedEdgeIdAfterDisconnect("if-1->complete-1:condition_false", "if-1", "agent-1")).toBe(
      "if-1->complete-1:condition_false",
    );
  });

  it("does not over-match a similarly-prefixed target id", () => {
    expect(nextSelectedEdgeIdAfterDisconnect("if-1->complete-1:condition_false", "if-1", "complete")).toBe(
      "if-1->complete-1:condition_false",
    );
  });

  it("passes through a null selection", () => {
    expect(nextSelectedEdgeIdAfterDisconnect(null, "if-1", "complete-1")).toBeNull();
  });
});
