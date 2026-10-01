import path from "node:path";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { resolveWorkProductLocalFilePath } from "../work-products.js";

export function assertPinnedProductConsumable(input: {
  referencedStepId: string; workProductId: string; provider: string | null; metadata: unknown; url: string | null;
}): string {
  const fileRef = { url: input.url, metadata: input.metadata } as Pick<IssueWorkProduct, "url" | "metadata">;
  if (!input.provider) throw new Error(`workproduct_binding_target_missing: ${input.referencedStepId} → ${input.workProductId}`);
  if (input.provider !== "local" && input.provider !== "local_file") {
    throw new Error(`workproduct_binding_target_invalid: ${input.referencedStepId} → ${input.workProductId} (provider ${input.provider})`);
  }
  const pinnedPath = resolveWorkProductLocalFilePath(fileRef);
  if (!pinnedPath) throw new Error(`workproduct_binding_target_invalid: ${input.referencedStepId} → ${input.workProductId} (unresolvable path)`);
  return path.resolve(pinnedPath);
}
