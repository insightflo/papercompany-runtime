import { Router, json } from "express";
import type { Db } from "@paperclipai/db";
import { toolProgressEventSchema } from "@paperclipai/shared";
import { z } from "zod";
import { ToolProgressError } from "../services/tools/progress-policy.js";
import { createToolProgressStore } from "../services/tools/progress-store.js";

export function toolProgressRoutes(db: Db) {
  const router = Router();
  const store = createToolProgressStore(db);
  router.post("/companies/:companyId/tool-executions/:executionId/progress", json({ limit: "4kb" }), async (req, res) => {
    const companyId = z.string().uuid().safeParse(req.params.companyId);
    const executionId = z.string().uuid().safeParse(req.params.executionId);
    const token = req.header("X-Papercompany-Progress-Token");
    // The parent app already parsed JSON and preserved rawBody. Check original
    // wire size too: re-stringifying alone would miss oversized whitespace.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if ((rawBody?.length ?? Buffer.byteLength(JSON.stringify(req.body) ?? "")) > 4096) {
      res.status(400).json({ error: "tool_progress_invalid_event" }); return;
    }
    if (!companyId.success || !executionId.success) { res.status(404).json({ error: "tool_progress_not_found" }); return; }
    if (!token || token.length > 256) { res.status(401).json({ error: "tool_progress_unauthorized" }); return; }
    const event = toolProgressEventSchema.safeParse(req.body);
    if (!event.success) { res.status(400).json({ error: "tool_progress_invalid_event" }); return; }
    try {
      res.json(await store.accept(companyId.data, executionId.data, event.data, token));
    } catch (error) {
      res.status(error instanceof ToolProgressError ? error.status : 500)
        .json({ error: error instanceof ToolProgressError ? error.reason : "tool_progress_db_failure" });
    }
  });
  return router;
}
