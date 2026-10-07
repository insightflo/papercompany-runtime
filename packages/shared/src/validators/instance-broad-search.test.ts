import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

const fields = [
  "broadSearchAllowedCompanyIdsV1",
  "broadSearchAllowedMissionIdsV1",
  "broadSearchAllowedAgentIdsV1",
] as const;
const id = "11111111-1111-4111-8111-111111111111";

describe("instance experimental broad search allowlists", () => {
  it("defaults all scopes to empty deny lists", () => {
    expect(instanceExperimentalSettingsSchema.parse({})).toMatchObject({
      broadSearchAllowedCompanyIdsV1: [],
      broadSearchAllowedMissionIdsV1: [],
      broadSearchAllowedAgentIdsV1: [],
    });
  });

  it("leaves omitted patch fields absent", () => {
    expect(patchInstanceExperimentalSettingsSchema.parse({})).toEqual({});
  });

  it.each(fields)("accepts UUID arrays and explicit clearing for %s", (field) => {
    expect(patchInstanceExperimentalSettingsSchema.parse({ [field]: [id] })).toEqual({ [field]: [id] });
    expect(instanceExperimentalSettingsSchema.parse({ [field]: [id] })).toHaveProperty(field, [id]);
    expect(patchInstanceExperimentalSettingsSchema.parse({ [field]: [] })).toEqual({ [field]: [] });
  });

  it.each(fields)("rejects malformed %s lists", (field) => {
    for (const invalid of [null, id, ["not-a-uuid"], [123]]) {
      expect(instanceExperimentalSettingsSchema.safeParse({ [field]: invalid }).success).toBe(false);
      expect(patchInstanceExperimentalSettingsSchema.safeParse({ [field]: invalid }).success).toBe(false);
    }
  });
});
