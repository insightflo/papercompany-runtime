import { describe, expect, it } from "vitest";
import { applyMachineContractTruth } from "../services/workflow/tool-result-truth.ts";

describe("applyMachineContractTruth", () => {
  it("flips success=true to failure when the tool reports ok:false", () => {
    const result = applyMachineContractTruth({
      success: true,
      data: { ok: false, error: "cannot read verify result file" },
      isStructuralGate: false,
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("tool reported ok:false"),
      exitCode: 1,
    });
    expect(result.error).toContain("cannot read verify result file");
  });

  it("keeps an executor-provided error and exit code when flipping", () => {
    expect(applyMachineContractTruth({
      success: true,
      data: { ok: false },
      error: "Command failed (exit: 3)",
      exitCode: 3,
      isStructuralGate: false,
    })).toEqual({
      success: false,
      error: "Command failed (exit: 3)",
      exitCode: 3,
    });
  });

  it("does NOT flip structural gates — their verdict ledger relies on success=true callbacks", () => {
    expect(applyMachineContractTruth({
      success: true,
      data: { ok: false, verdict: "request_changes" },
      isStructuralGate: true,
    })).toEqual({});
  });

  it("leaves tools without an explicit ok:false untouched (empty override)", () => {
    expect(applyMachineContractTruth({ success: true, data: { ok: true }, isStructuralGate: false })).toEqual({});
    expect(applyMachineContractTruth({ success: true, data: { stdout: "plain" }, isStructuralGate: false })).toEqual({});
    expect(applyMachineContractTruth({ success: true, data: undefined, isStructuralGate: false })).toEqual({});
    expect(applyMachineContractTruth({ success: false, data: { ok: false }, isStructuralGate: false })).toEqual({});
  });
});
