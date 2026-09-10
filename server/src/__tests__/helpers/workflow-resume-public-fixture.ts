import { createRequire } from "node:module";
import express from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { ResumePreview } from "@paperclipai/shared/types/workflow-resume";
import { MissionResumePreviewReport } from "../../../../ui/src/components/MissionResumePreviewReport.tsx";
import { errorHandler } from "../../middleware/index.js";
import { workflowRoutes } from "../../routes/workflows.js";

// Test-only bridge: use the UI's installed React/ReactDOM pair, not new server dependencies.
const uiRequire = createRequire(new URL("../../../../ui/package.json", import.meta.url));
const { createElement } = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
export function renderPublicPreview(preview: ResumePreview): string {
  return renderToStaticMarkup(createElement(MissionResumePreviewReport, { preview, expired: false }));
}

export function publicResumeApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "projection-board" };
    next();
  });
  app.use("/api", workflowRoutes(db));
  app.use(errorHandler);
  return app;
}
export function publicResumePath(scope: { companyId: string; missionId: string }, suffix: string) {
  return `/api/companies/${scope.companyId}/missions/${scope.missionId}/workflow-resume-${suffix}`;
}

// Independent exact-key runtime checks for the approved shared TypeScript contract.
export const publicPreviewSchema = z.object({
  schemaVersion: z.literal(1), companyId: z.string().uuid(), missionId: z.string().uuid(),
  workflowRunId: z.string().uuid(), startStepId: z.string(), eligible: z.boolean(),
  blockers: z.array(z.object({ code: z.string(), message: z.string(), stepId: z.string().optional() }).strict()),
  affected: z.array(z.object({ stepId: z.string(), name: z.string(), action: z.enum(["execute", "reevaluate"]) }).strict()),
  preserved: z.array(z.object({ stepId: z.string(), name: z.string() }).strict()),
  evidence: z.array(z.object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  generation: z.enum(["none", "possible"]), budget: z.enum(["verified", "unknown"]),
  approvals: z.array(z.object({ stepId: z.string(), required: z.literal(true) }).strict()),
  snapshotToken: z.string().min(1).nullable(), expiresAt: z.string().datetime().nullable(),
}).strict();
export const publicRequestSchema = z.object({
  id: z.string().uuid(), workflowRunId: z.string().uuid(), startStepId: z.string(),
  state: z.enum(["pending_delivery", "accepted", "blocked", "cancelled"]),
  acceptanceId: z.string().uuid().nullable(), code: z.string().nullable(), createdAt: z.string().datetime(),
}).strict();
