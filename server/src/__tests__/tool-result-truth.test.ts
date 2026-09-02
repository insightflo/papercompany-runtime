import { describe, expect, it } from "vitest";
import { applyMachineContractTruth } from "../services/workflow/tool-result-truth.ts";

describe("applyMachineContractTruth", () => {
  it("flips success=true to failure when the tool reports ok:false", () => {
    const result = applyMachineContractTruth({
      success: true,
      data: { ok: false, error: "cannot read verify result file" },
      isStructuralGate: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("tool reported ok:false");
    expect(result.error).toContain("cannot read verify result file");
    expect(result.exitCode).toBe(1);
  });

  it("keeps an executor-provided error and exit code when flipping", () => {
    const result = applyMachineContractTruth({
      success: true,
      data: { ok: false },
      error: "Command failed (exit: 3)",
      exitCode: 3,
      isStructuralGate: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Command failed (exit: 3)");
    expect(result.exitCode).toBe(3);
  });

  it("does NOT flip structural gates — their verdict ledger relies on success=true callbacks", () => {
    const result = applyMachineContractTruth({
      success: true,
      data: { ok: false, verdict: "request_changes" },
      isStructuralGate: true,
    });
    expect(result.success).toBe(true);
  });

  it("leaves tools without an explicit ok:false untouched", () => {
    expect(applyMachineContractTruth({ success: true, data: { ok: true }, isStructuralGate: false }).success).toBe(true);
    expect(applyMachineContractTruth({ success: true, data: { stdout: "plain" }, isStructuralGate: false }).success).toBe(true);
    expect(applyMachineContractTruth({ success: true, data: undefined, isStructuralGate: false }).success).toBe(true);
    expect(applyMachineContractTruth({ success: false, data: { ok: false }, isStructuralGate: false }).success).toBe(false);
  });
});
