import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolvePiHome,
  resolvePiSessionsDir,
  resolvePiSkillsDir,
} from "./runtime-paths.js";

describe("pi_local runtime paths", () => {
  it("uses the configured HOME for sessions and skills", () => {
    const config = { env: { HOME: "/tmp/paperclip-pi-home" } };

    expect(resolvePiHome(config)).toBe("/tmp/paperclip-pi-home");
    expect(resolvePiSessionsDir(config)).toBe("/tmp/paperclip-pi-home/.pi/paperclips");
    expect(resolvePiSkillsDir(config)).toBe("/tmp/paperclip-pi-home/.pi/agent/skills");
  });

  it("falls back to the process home when HOME is absent", () => {
    expect(resolvePiHome({})).toBe(os.homedir());
  });
});
