import type { Db } from "@paperclipai/db";
import { getIssueExecutionCard } from "./store.js";

export type WorkProductRouteGuardReason = "workflow_card_requires_artifact_marker" | "ok";

export type WorkProductRouteGuardDecision = {
  readonly block: boolean;
  readonly reason: WorkProductRouteGuardReason;
  readonly issueExecutionCardHash: string | null;
  readonly message: string | null;
};

export async function resolveAgentWorkProductRouteGuard(input: {
  readonly db: Pick<Db, "select" | "insert" | "update">;
  readonly companyId: string;
  readonly issueId: string;
  readonly actorType: string;
}): Promise<WorkProductRouteGuardDecision> {
  const ok: WorkProductRouteGuardDecision = {
    block: false,
    reason: "ok",
    issueExecutionCardHash: null,
    message: null,
  };
  if (input.actorType !== "agent") return ok;

  const card = await getIssueExecutionCard({
    db: input.db,
    companyId: input.companyId,
    issueId: input.issueId,
  });
  if (!card) return ok;

  const required = card.cardJson?.requiredOutputs?.workProduct?.required === true;
  if (!required) return ok;

  const outputDir = card.cardJson?.requiredOutputs?.workProduct?.outputDir ?? null;
  const lines = [
    "This workflow execution issue requires an official workProduct. Use POST /api/issues/:id/workflow/artifacts first: send an existing absolute local path for file artifacts, or type=preview_url plus an HTTP(S) url for public delivery URLs.",
    "Do not emit an `[ARTIFACT]` marker, comment text, or stdout to register — only POST /api/issues/:id/workflow/artifacts registers a work product. Comments, stdout, and artifact markers are not registration authority.",
    "Do not POST /api/issues/:id/work-products manually for this issue, and do not rely on transcript claims.",
  ];
  if (typeof outputDir === "string" && outputDir.length > 0) {
    lines.push(`Assigned output directory: ${outputDir}`);
  }
  lines.push(`issueExecutionCardHash=${card.contentHash}`);

  return {
    block: true,
    reason: "workflow_card_requires_artifact_marker",
    issueExecutionCardHash: card.contentHash,
    message: lines.join(" "),
  };
}
