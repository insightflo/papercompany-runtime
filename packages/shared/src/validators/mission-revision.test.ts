import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { missionRevisionDeltaSchema, missionRevisionSourceSchema } from "./mission-revision.js";

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

describe("mission revision delta collection scope (Q5)", () => {
  const deltaWith = (collectionScope: unknown) => missionRevisionDeltaSchema.safeParse({
    schemaVersion: "mission-revision-delta.v1", sourceWorkflowRunId: randomUUID(),
    base: { workflowDefinitionId: randomUUID(), snapshotHash: "a".repeat(64) },
    units: [{ unitId: "collectNew", operation: "add", ...(collectionScope === undefined ? {} : { collectionScope }) }],
  });
  it("accepts oneShot, permanentChange and absent collectionScope (backward compatible)", () => {
    expect(deltaWith("oneShot").success).toBe(true);
    expect(deltaWith("permanentChange").success).toBe(true);
    expect(deltaWith(undefined).success).toBe(true);
  });
  it("refuses unknown scope spellings at the contract level", () => {
    expect(deltaWith("oneshot").success).toBe(false);
    expect(deltaWith("permanent").success).toBe(false);
    expect(deltaWith("one-shot").success).toBe(false);
  });
});
