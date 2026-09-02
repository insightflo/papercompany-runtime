// server/src/services/workflow/tool-result-truth.ts
//
// [ purpose ] Tool-step completion truth guard (2026-09-02).
//   Some tool wrappers report success=true while the tool's own machine
//   contract declares failure (data.ok === false with an error payload —
//   e.g. naver-publish-enqueue emits {ok:false,error} on exit≠0). Recording
//   the step as completed lets downstream trust an unfounded success
//   (2026-08-31 enqueue-naver-publish: 25.6-min hang + manual_recovery).
//
//   Structural gates (qaType:"structural") are exempt: their verdict
//   ledger/parsing contract relies on success=true callbacks carrying
//   data.ok:false (planStructuralCompletion owns that interpretation).

export interface ToolResultTruthInput {
  success: boolean;
  data?: unknown;
  error?: string;
  exitCode?: number | null;
  isStructuralGate: boolean;
}

/** Fields to override on the completion input. Empty object = keep as-is. */
export type ToolResultTruthOverride = {
  success: boolean;
  error: string;
  exitCode: number;
} | Record<string, never>;

export function applyMachineContractTruth(input: ToolResultTruthInput): ToolResultTruthOverride {
  if (input.isStructuralGate || !input.success) return {};
  const data = input.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  if (record.ok !== false) return {};

  const toolError = record.error;
  return {
    success: false,
    error: input.error
      ?? (typeof toolError === "string" && toolError.trim() ? `tool reported ok:false: ${toolError}` : "tool reported ok:false"),
    exitCode: input.exitCode ?? 1,
  };
}
