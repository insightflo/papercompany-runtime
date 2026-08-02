import { describe, expect, it } from "vitest";
import { buildCommandCodePermissionArgs } from "./env.js";

describe("buildCommandCodePermissionArgs", () => {
  it("returns the safe --permission-mode auto-accept default when not skipping", () => {
    expect(buildCommandCodePermissionArgs(false)).toEqual(["--permission-mode", "auto-accept"]);
  });

  it("returns --yolo and never sets --permission-mode when skipping permissions", () => {
    const args = buildCommandCodePermissionArgs(true);
    expect(args).toEqual(["--yolo"]);
    expect(args).not.toContain("--permission-mode");
  });
});
