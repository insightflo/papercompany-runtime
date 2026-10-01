import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { missionRevisionSourceSchema } from "./mission-revision.js";

describe("mission revision source contract", () => {
  it("accepts ordinary and nullable source links", () => {
    expect(missionRevisionSourceSchema.parse({})).toEqual({});
    expect(missionRevisionSourceSchema.safeParse({ sourceMissionId: null, sourceWorkflowRunId: null }).success).toBe(true);
    expect(missionRevisionSourceSchema.safeParse({ sourceMissionId: randomUUID() }).success).toBe(true);
  });
  it("refuses malformed IDs and a run without its mission", () => {
    expect(missionRevisionSourceSchema.safeParse({ sourceMissionId: "not-a-uuid" }).success).toBe(false);
    expect(missionRevisionSourceSchema.safeParse({ sourceWorkflowRunId: randomUUID() }).success).toBe(false);
  });
});
