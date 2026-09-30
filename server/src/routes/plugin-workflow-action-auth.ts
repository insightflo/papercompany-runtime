import type { Request } from "express";
import { replacementIntentSchema } from "@paperclipai/shared/validators/workflow-replacement";
import { badRequest, forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const nativeWorkflowActionKeys = new Set([
  "create-workflow", "update-workflow", "delete-workflow", "start-workflow",
  "resume-run", "cancel-run", "abort-run", "manual-complete", "handle-tool-execution-result",
]);
export { nativeWorkflowActionKeys };

export function normalizedWorkflowActionParams(
  key: string,
  body: { params?: Record<string, unknown> } | undefined,
): Record<string, unknown> {
  if (body?.params && typeof body.params === "object") return body.params;
  if (!body || !nativeWorkflowActionKeys.has(key)) return {};
  const { renderEnvironment: _renderEnvironment, params: _params, key: _key, ...topLevelParams } =
    body as Record<string, unknown>;
  return topLevelParams;
}

// This exception only admits a request to the native shared replacement boundary.
// Company/owner/approval/intent authority is still checked by trigger/admitReplacement.
export function assertPluginWorkflowActionAccess(
  req: Request,
  plugin: { pluginKey: string },
  key: string,
  params: Record<string, unknown>,
  body: { companyId?: string } | undefined,
) {
  if (req.actor.type !== "agent") return assertBoard(req);
  if (plugin.pluginKey !== "insightflo.workflow-engine" || key !== "start-workflow" || !params.replacementIntent) {
    throw forbidden("Board access required");
  }
  const intent = replacementIntentSchema.safeParse(params.replacementIntent);
  if (!intent.success) throw badRequest("Invalid replacementIntent", intent.error.issues);
  const companyId = typeof params.companyId === "string" ? params.companyId.trim() : body?.companyId?.trim();
  if (!companyId) throw forbidden("replacement_requester_required");
  assertCompanyAccess(req, companyId);
}
