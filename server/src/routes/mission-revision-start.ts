import type { Router } from "express";
import { eq } from "drizzle-orm";
import { missions, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { revisionStartOptions } from "../services/missions/revision-start-options.js";

export function mountMissionRevisionStart(router: Router, db: Db) {
  router.get("/missions/:id/revision-start", async (req, res) => {
    const [mission] = await db.select().from(missions).where(eq(missions.id, req.params.id as string));
    if (!mission) throw notFound("Mission not found");
    assertCompanyAccess(req, mission.companyId);
    res.json(await revisionStartOptions(db, mission.companyId, mission.id));
  });
}
