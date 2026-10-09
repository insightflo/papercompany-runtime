import { eq } from "drizzle-orm";
import express from "express";
import {
  agentWakeupRequests, missionPlanArtifacts, missionSessions, workflowRuns,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { missionRoutes } from "../../routes/missions.js";
import { terminalState, type TerminalFixture } from "./mission-terminal-transaction.js";

export function missionReaderApp(db: Db, f: TerminalFixture) {
  const app = express();
  // Auth middleware boundary only: a persisted, same-company agent, not unrestricted board access.
  app.use((req, _res, next) => {
    req.actor = { type: "agent", agentId: f.mission.ownerAgentId, companyId: f.companyId };
    next();
  });
  app.use("/api", missionRoutes(db));
  app.use(errorHandler);
  return app;
}

export async function missionReadState(db: Db, f: TerminalFixture) {
  return {
    ...await terminalState(db, f),
    workflows: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId)).orderBy(workflowRuns.id),
    wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)).orderBy(agentWakeupRequests.id),
    plans: await db.select().from(missionPlanArtifacts).where(eq(missionPlanArtifacts.companyId, f.companyId)).orderBy(missionPlanArtifacts.id),
    sessions: await db.select().from(missionSessions).where(eq(missionSessions.companyId, f.companyId)).orderBy(missionSessions.id),
  };
}
