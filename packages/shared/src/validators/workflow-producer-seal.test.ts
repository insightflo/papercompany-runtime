import { expect, it } from "vitest";
import { workProductProducerSchema } from "./workflow-artifact.js";
import { legacyReceipt } from "./__tests__/fixtures/artifact-legacy.js";

const legacy = legacyReceipt.input.producer;
const seal = { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", byteSize: 3 };

// Break: strict producer parsing rejects server-produced seals or rewrites legacy records.
it("accepts the production seal pair without changing legacy unsealed producer records", () => {
  expect(workProductProducerSchema.parse(legacy)).toEqual(legacy);
  expect(workProductProducerSchema.parse({ ...legacy, ...seal })).toEqual({ ...legacy, ...seal });
  expect(workProductProducerSchema.safeParse({ ...legacy, ...seal, byteSize: 0 }).success).toBe(true);
});

// Break: partial or malformed production evidence can masquerade as legacy absence.
it.each([
  { sha256: seal.sha256 }, { byteSize: 3 },
  { ...seal, sha256: "A".repeat(64) }, { ...seal, sha256: "bad" },
  { ...seal, byteSize: -1 }, { ...seal, byteSize: 0.5 },
  { ...seal, sha256: null }, { ...seal, byteSize: null },
])("rejects malformed or unpaired seals: %j", patch => {
  expect(workProductProducerSchema.safeParse({ ...legacy, ...patch }).success).toBe(false);
});
