/**
 * Scheduler Routes
 *
 * API endpoints for managing agent wakeup schedules.
 *
 * Endpoints:
 * - GET    /scheduler/schedules          — List schedules
 * - POST   /scheduler/schedules          — Create schedule
 * - GET    /scheduler/schedules/:id      — Get schedule
 * - PATCH  /scheduler/schedules/:id      — Update schedule
 * - DELETE /scheduler/schedules/:id      — Delete schedule
 * - GET    /scheduler/state              — Get scheduler state
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { scheduleStore } from "../services/scheduler/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound, unprocessable } from "../errors.js";
import { validateCron } from "../services/cron.js";
import { logActivity } from "../services/activity-log.js";

export function schedulerRoutes(db: Db) {
  const router = Router();

  /**
   * GET /scheduler/schedules
   *
   * List schedules for a company.
   * Query params: ?enabled=true&agentId=xxx
   */
  router.get("/companies/:companyId/schedules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const enabled = req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const agentId = req.query.agentId as string | undefined;

    const result = await scheduleStore.listSchedules(db, companyId, { enabled, agentId });
    res.json(result);
  });

  /**
   * POST /scheduler/schedules
   *
   * Create a new schedule.
   */
  router.post("/companies/:companyId/schedules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { cronExpression, timezone, agentId, missionId, enabled } = req.body;

    // Validate cron expression
    const cronError = validateCron(cronExpression);
    if (cronError) {
      throw unprocessable(`Invalid cron expression: ${cronError}`);
    }

    // Validate timezone
    if (timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
      } catch {
        throw unprocessable(`Invalid timezone: ${timezone}`);
      }
    }

    const created = await scheduleStore.createSchedule(db, {
      companyId,
      agentId,
      cronExpression,
      timezone: timezone ?? "UTC",
      missionId: missionId ?? null,
      enabled: enabled ?? true,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "schedule.created",
      entityType: "schedule",
      entityId: created.id,
      details: {
        agentId: created.agentId,
        cronExpression: created.cronExpression,
        missionId: created.missionId,
      },
    });

    res.status(201).json(created);
  });

  /**
   * GET /scheduler/schedules/:id
   *
   * Get a schedule by ID.
   */
  router.get("/schedules/:id", async (req, res) => {
    const schedule = await scheduleStore.getScheduleById(db, req.params.id as string);
    if (!schedule) {
      throw notFound("Schedule not found");
    }
    assertCompanyAccess(req, schedule.companyId);
    res.json(schedule);
  });

  /**
   * PATCH /scheduler/schedules/:id
   *
   * Update a schedule.
   */
  router.patch("/schedules/:id", async (req, res) => {
    const existing = await scheduleStore.getScheduleById(db, req.params.id as string);
    if (!existing) {
      throw notFound("Schedule not found");
    }
    assertCompanyAccess(req, existing.companyId);

    const updates: Record<string, unknown> = {};

    if (req.body.cronExpression !== undefined) {
      const cronError = validateCron(req.body.cronExpression);
      if (cronError) {
        throw unprocessable(`Invalid cron expression: ${cronError}`);
      }
      updates.cronExpression = req.body.cronExpression;
    }

    if (req.body.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: req.body.timezone }).format(new Date());
      } catch {
        throw unprocessable(`Invalid timezone: ${req.body.timezone}`);
      }
      updates.timezone = req.body.timezone;
    }

    if (req.body.missionId !== undefined) {
      updates.missionId = req.body.missionId;
    }

    if (req.body.enabled !== undefined) {
      updates.enabled = req.body.enabled;
    }

    const updated = await scheduleStore.updateSchedule(db, req.params.id as string, updates);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "schedule.updated",
      entityType: "schedule",
      entityId: req.params.id,
      details: updates,
    });

    res.json(updated);
  });

  /**
   * DELETE /scheduler/schedules/:id
   *
   * Delete a schedule.
   */
  router.delete("/schedules/:id", async (req, res) => {
    const existing = await scheduleStore.getScheduleById(db, req.params.id as string);
    if (!existing) {
      throw notFound("Schedule not found");
    }
    assertCompanyAccess(req, existing.companyId);

    await scheduleStore.deleteSchedule(db, req.params.id as string);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "schedule.deleted",
      entityType: "schedule",
      entityId: req.params.id,
      details: {
        agentId: existing.agentId,
        cronExpression: existing.cronExpression,
      },
    });

    res.status(204).send();
  });

  /**
   * GET /scheduler/state
   *
   * Get scheduler state (for debugging/monitoring).
   */
  router.get("/state", async (req, res) => {
    // This is a system endpoint - requires instance admin
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const state = await scheduleStore.getSchedulerState(db);
    res.json(state);
  });

  return router;
}
