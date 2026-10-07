import { describe, expect, it } from "vitest";
import { graphEdgeRemoveButtonStyle } from "./graphStyles.js";

/**
 * [purpose] The graph canvas content wrappers set `pointerEvents: "none"` so the
 * pan/drag surface can manage events. The edge remove button is rendered inside
 * that tree, and pointer-events is an inherited property: without an explicit
 * `pointerEvents: "auto"` on the button style, computed pointer-events becomes
 * `none`, the button stops receiving clicks, and edge deletion breaks (clicks
 * land on the edge hit-path underneath). Regression guard for that bug.
 */
describe("graphEdgeRemoveButtonStyle", () => {
  it("overrides the canvas pointer-events:none inheritance so the button is clickable", () => {
    expect(graphEdgeRemoveButtonStyle.pointerEvents).toBe("auto");
  });
});
