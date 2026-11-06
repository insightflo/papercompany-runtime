/**
 * Prometheus Metrics Endpoint
 *
 * Exposes /metrics endpoint for Prometheus scraping.
 * Uses prom-client library for Node.js metrics collection.
 */

import { Router } from "express";
import client from "prom-client";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { createRuntimeMetricsMonitor, createDbMetricsMonitor, createTelegramMetricsSender, type MonitorAlertSender } from "../services/runtime-metrics-monitor.js";

function normalizeMetricRoute(url: string): string {
  const path = url.split("?")[0] ?? url;
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\b\d+\b/g, ":id")
    .replace(/\b[a-z0-9_-]{20,}\b/gi, ":token");
}

// Initialize the default registry
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

/**
 * HTTP request duration histogram.
 */
export const httpRequestDuration = new client.Histogram({
  name: "paperclip_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * HTTP request total counter.
 */
export const httpRequestTotal = new client.Counter({
  name: "paperclip_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

/**
 * Active mission sessions gauge.
 */
export const activeMissionSessions = new client.Gauge({
  name: "paperclip_active_mission_sessions",
  help: "Number of mission sessions with active database status, including expired sessions",
  registers: [register],
});

/**
 * Mission count by status.
 */
export const missionsByStatus = new client.Gauge({
  name: "paperclip_missions_by_status",
  help: "Number of missions grouped by status",
  labelNames: ["status"],
  registers: [register],
});

/**
 * Workflow runs by status.
 */
export const workflowRunsByStatus = new client.Gauge({
  name: "paperclip_workflow_runs_by_status",
  help: "Number of workflow runs grouped by status",
  labelNames: ["status"],
  registers: [register],
});

/**
 * Agent heartbeat runs gauge.
 */
export const activeHeartbeatRuns = new client.Gauge({
  name: "paperclip_active_heartbeat_runs",
  help: "Number of currently active heartbeat runs",
  registers: [register],
});

/**
 * Worktree rules count by severity.
 */
export const worktreeRulesBySeverity = new client.Gauge({
  name: "paperclip_worktree_rules_by_severity",
  help: "Number of worktree rules grouped by severity",
  labelNames: ["severity"],
  registers: [register],
});

/**
 * SRB delivery count by status.
 */
export const srbDeliveriesByStatus = new client.Gauge({
  name: "paperclip_srb_deliveries_by_status",
  help: "Number of SRB deliveries grouped by status",
  labelNames: ["status"],
  registers: [register],
});

// The last values remain available during an outage; check up and timestamp for freshness.
export const dbMetricsCollectionUp = new client.Gauge({
  name: "paperclip_db_metrics_collection_up", help: "Whether the latest DB metrics collection succeeded", registers: [register],
});
export const dbMetricsLastSuccess = new client.Gauge({
  name: "paperclip_db_metrics_last_success_timestamp_seconds", help: "Unix time of the last successful DB metrics collection", registers: [register],
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware to track HTTP request metrics.
 * Use before your route handlers.
 */
export function metricsMiddleware() {
  return (req: { method: string; url: string }, res: { on: Function; statusCode: number }, next: () => void) => {
    const start = Date.now();

    res.on("finish", () => {
      const duration = (Date.now() - start) / 1000;
      const route = normalizeMetricRoute(req.url);
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      };

      httpRequestDuration.observe(labels, duration);
      httpRequestTotal.inc(labels);
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

let metricsMonitorStarted = false;
let monitoredDb: Db | undefined;
let dbMonitor: ReturnType<typeof createDbMetricsMonitor> | undefined;
let metricsAlertSender: MonitorAlertSender | undefined;

export function metricsRoutes(db?: Db, options?: { sendAlert?: MonitorAlertSender }) {
  if (db && db !== monitoredDb) {
    dbMonitor?.stop();
    activeMissionSessions.set(0); activeHeartbeatRuns.set(0);
    missionsByStatus.reset(); workflowRunsByStatus.reset();
    worktreeRulesBySeverity.reset(); srbDeliveriesByStatus.reset();
    dbMetricsCollectionUp.set(0); dbMetricsLastSuccess.set(0);
    monitoredDb = db;
    metricsAlertSender = options?.sendAlert ?? createTelegramMetricsSender();
    dbMonitor = createDbMetricsMonitor(db, {
      activeSessions: activeMissionSessions, activeHeartbeats: activeHeartbeatRuns,
      missions: missionsByStatus, workflows: workflowRunsByStatus,
      rules: worktreeRulesBySeverity, deliveries: srbDeliveriesByStatus,
      up: dbMetricsCollectionUp, lastSuccess: dbMetricsLastSuccess,
    }, logger, (message) => metricsAlertSender!(message));
    if (metricsMonitorStarted) void dbMonitor.sample();
  }
  if (!metricsMonitorStarted) {
    metricsMonitorStarted = true;
    const monitor = createRuntimeMetricsMonitor(() => httpRequestTotal.get(), logger, 5, async (message) => {
      if (metricsAlertSender) await metricsAlertSender(message);
    });
    const sample = () => { void monitor.sample(); if (dbMonitor) void dbMonitor.sample(); };
    sample();
    const timer = setInterval(sample, 60_000);
    timer.unref();
  }
  const router = Router();

  /**
   * GET /metrics
   * Returns Prometheus-formatted metrics.
   */
  router.get("/", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (error) {
      res.status(500).end(String(error));
    }
  });

  /**
   * GET /metrics/json
   * Returns metrics as JSON (for debugging).
   */
  router.get("/json", async (_req, res) => {
    try {
      res.json(await register.getMetricsAsJSON());
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// SLI Metrics (P9-T2, P9-T3, P9-T4, P9-T5)
// ---------------------------------------------------------------------------

/**
 * P9-T2: Scheduler due-to-wakeup latency histogram.
 * Measures time from schedule.nextRunAt to actual agent wakeup enqueue.
 * SLO: p95 < 90s
 */
export const schedulerDueToWakeupLatency = new client.Histogram({
  name: "paperclip_scheduler_due_to_wakeup_latency_seconds",
  help: "Time from schedule due timestamp to wakeup enqueue (seconds). SLO: p95 < 90s",
  buckets: [1, 5, 10, 30, 60, 90, 120, 180, 300],
  registers: [register],
});

/**
 * P9-T3: Worktree checkAction latency histogram.
 * Measures time to evaluate a single checkAction call.
 * SLO: p99 < 50ms
 */
export const worktreeCheckActionLatency = new client.Histogram({
  name: "paperclip_worktree_check_action_latency_seconds",
  help: "Time to evaluate worktree.checkAction (seconds). SLO: p99 < 50ms",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  labelNames: ["tier", "result"],
  registers: [register],
});

/**
 * P9-T4: SRB webhook delivery attempts counter.
 * Track success/failure for delivery rate SLI.
 * SLO: >99% within 60s
 */
export const srbWebhookDeliveries = new client.Counter({
  name: "paperclip_srb_webhook_deliveries_total",
  help: "Total SRB webhook delivery attempts",
  labelNames: ["status"],
  registers: [register],
});

export const srbRetryTransitions = new client.Counter({
  name: "paperclip_srb_retry_transitions_total",
  help: "SRB retry worker state transitions and claim events",
  labelNames: ["event"],
  registers: [register],
});

/**
 * P9-T5: Mission session reuse counter.
 * Track new vs reused sessions to compute session reuse rate.
 * SLO: >80% reuse rate
 */
export const missionSessionEvents = new client.Counter({
  name: "paperclip_mission_session_events_total",
  help: "Mission session lifecycle events (new|reused)",
  labelNames: ["event"],
  registers: [register],
});

// Re-export for use in other parts of the app
export { register };
