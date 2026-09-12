import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { workflowAgentApiRoutes } from "../../routes/workflow-agent-api.js";
import type { GateWorld } from "./plan-qa-addendum.js";

// Auth middleware itself is outside this fixture; real route authorization/services/DB/storage run.
export function planQaApiApp(db: Db, w: GateWorld, actor?: Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor ?? { type: "agent", source: "agent_jwt", companyId: w.companyId,
      agentId: w.reviewerAgentId, runId: w.runId };
    next();
  });
  app.use("/api", workflowAgentApiRoutes(db));
  app.use(errorHandler);
  return app;
}

export async function runEvidenceCli(url: string, runId: string, args: string[]) {
  const child = spawn(process.execPath, [path.resolve("scripts/quality/evidence.mjs"), ...args], {
    env: { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: "test-only-key", PAPERCLIP_RUN_ID: runId },
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}
