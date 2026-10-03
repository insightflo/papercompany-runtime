import { describe, expect, it } from "vitest";
import { parseToolRecoveryMetadata, toolRecoveryMetadataV1 } from "./tool-recovery-metadata.js";

const valid = {
  version: 1, sameRunRetry: "forbidden",
  idempotencyKey: "entry slug + date",
  statusLookup: { instruction: "Check the published entry status before any retry.", toolName: "status-tool" },
  reconcile: "operator", installPath: "/srv/tools/x", stateLocation: "/srv/state/x.json",
  notes: ["Dispatch may apply after timeout."],
} as const;

// Catches unbounded/loose declarations and runtime throws on bad stored config.
describe("toolRecoveryMetadataV1", () => {
  it("accepts a full and a minimal declaration", () => {
    expect(toolRecoveryMetadataV1.safeParse(valid).success).toBe(true);
    expect(toolRecoveryMetadataV1.safeParse({ version: 1, sameRunRetry: "unknown" }).success).toBe(true);
  });
  it.each([
    ["wrong version", { ...valid, version: 2 }],
    ["bad sameRunRetry", { ...valid, sameRunRetry: "yes" }],
    ["bad reconcile", { ...valid, reconcile: "anyone" }],
    ["unknown key", { ...valid, retryCommand: "rm -rf" }],
    ["too many notes", { ...valid, notes: ["a", "b", "c", "d", "e", "f"] }],
    ["long note", { ...valid, notes: ["x".repeat(201)] }],
    ["long instruction", { ...valid, statusLookup: { instruction: "x".repeat(501) } }],
    ["long path", { ...valid, installPath: "x".repeat(301) }],
    ["empty instruction", { ...valid, statusLookup: { instruction: "" } }],
  ])("rejects %s", (_label, value) => {
    expect(toolRecoveryMetadataV1.safeParse(value).success).toBe(false);
  });
  it("parses adapterConfig.recovery without throwing", () => {
    expect(parseToolRecoveryMetadata({ recovery: valid })).toEqual({ status: "valid", metadata: valid });
    expect(parseToolRecoveryMetadata({ command: "x" })).toEqual({ status: "absent" });
    expect(parseToolRecoveryMetadata(null)).toEqual({ status: "absent" });
    expect(parseToolRecoveryMetadata("not-an-object")).toEqual({ status: "absent" });
    const invalid = parseToolRecoveryMetadata({ recovery: { version: 9 } });
    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid") {
      expect(invalid.diagnostic.length).toBeGreaterThan(0);
      expect(invalid.diagnostic.length).toBeLessThanOrEqual(300);
    }
    expect(parseToolRecoveryMetadata({ recovery: "string" }).status).toBe("invalid");
  });
});
