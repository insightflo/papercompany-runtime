import { describe, expect, it } from "vitest";
import {
  buildPaperclipMissionRuntimeContext,
  isPersistentMissionRuntimeEnabled,
  MISSION_RUNTIME_CONTEXT_INVARIANT,
} from "../services/missions/mission-context-compiler.js";


describe("mission context compiler", () => {
  it("keeps persistent runtime support behind explicit adapter config flags", () => {
    expect(isPersistentMissionRuntimeEnabled({})).toBe(false);
    expect(isPersistentMissionRuntimeEnabled({ missionRuntimePersistent: true })).toBe(true);
    expect(isPersistentMissionRuntimeEnabled({ persistentMissionRuntime: true })).toBe(true);
    expect(isPersistentMissionRuntimeEnabled({ missionRuntimePersistent: false, persistentMissionRuntime: false })).toBe(false);
  });

  it("builds a compact runtime context contract instead of embedding bespoke instructions", () => {
    expect(buildPaperclipMissionRuntimeContext({
      runtimeId: "runtime-1",
      runtimeKey: "company:c|mission:m|agent:a|adapter:claude_local|workspace:w",
      policy: {
        bootstrapRequired: false,
        fullContextInjection: false,
        issueEnvelopeOnly: true,
      },
    })).toEqual({
      runtimeId: "runtime-1",
      runtimeKey: "company:c|mission:m|agent:a|adapter:claude_local|workspace:w",
      bootstrapRequired: false,
      fullContextInjection: false,
      issueEnvelopeOnly: true,
      invariant: MISSION_RUNTIME_CONTEXT_INVARIANT,
    });
  });
});
