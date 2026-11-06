import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parse } from "dotenv";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/** Read the existing HTTP counter without touching request or mission state. */
type CounterSample = { values: Array<{ value: number; labels: { method?: string | number; route?: string | number; status_code?: string | number } }> };
export type MonitorLogger = { warn: (fields: Record<string, unknown>, message: string) => void; info: (fields: Record<string, unknown>, message: string) => void };
export type MonitorAlertSender = (message: string) => Promise<void>;

/** A bounded, in-memory queue retries failed delivery on the next sample. */
export function createMonitorAlertQueue(send: MonitorAlertSender | undefined, logger: MonitorLogger) {
  const pending: string[] = [];
  let sending = false;
  const warn = (message: string) => { try { logger.warn({}, message); } catch { /* Monitoring is non-critical. */ } };
  return {
    push(message: string) {
      if (!send) return;
      if (pending.length >= 32) { warn("Metrics alert queue full"); return; }
      pending.push(message);
    },
    async flush() {
      if (!send || sending) return;
      sending = true;
      try {
        while (pending.length) {
          try { await send(pending[0]!); pending.shift(); }
          catch { warn("Metrics alert delivery failed; will retry"); break; }
        }
      } finally { sending = false; }
    },
  };
}

export function createRuntimeMetricsMonitor(read: () => Promise<CounterSample>, logger: MonitorLogger, threshold = 5, sendAlert?: MonitorAlertSender) {
  let previous: Map<string, number> | null = null;
  let alerting = false;
  let reading = false;
  let readFailed = false;
  const alerts = createMonitorAlertQueue(sendAlert, logger);
  const log = (level: "warn" | "info", fields: Record<string, unknown>, message: string) => {
    try { logger[level](fields, message); } catch { /* Monitoring must not affect the application. */ }
  };

  return {
    async sample(): Promise<void> {
      if (reading) return;
      reading = true;
      try {
        const snapshot = await read();
        const next = new Map<string, number>();
        for (const row of snapshot.values) {
          const code = String(row.labels.status_code ?? "");
          if (!/^5\d\d$/.test(code)) continue;
          if (!Number.isFinite(row.value) || row.value < 0) throw new Error("invalid_counter");
          const key = JSON.stringify([row.labels.method, row.labels.route, code]);
          if (next.has(key)) throw new Error("duplicate_counter_series");
          next.set(key, row.value);
        }
        if (previous) {
          let errors = 0;
          for (const [key, value] of next) {
            const before = previous.get(key) ?? 0;
            errors += value >= before ? value - before : value;
          }
          if (errors >= threshold && !alerting) {
            alerting = true;
            log("warn", { errors, threshold }, "HTTP 5xx threshold reached since last successful metrics sample");
            alerts.push(`Papercompany HTTP 5xx alert: ${errors} errors since the previous sample (threshold ${threshold}).`);
          } else if (errors < threshold && alerting) {
            alerting = false;
            log("info", { errors, threshold }, "HTTP 5xx threshold recovered");
            alerts.push("Papercompany HTTP 5xx alert recovered.");
          }
        }
        previous = next;
        if (readFailed) {
          log("info", {}, "HTTP metrics sample recovered");
          alerts.push("Papercompany HTTP metrics sampling recovered.");
        }
        readFailed = false;
      } catch {
        if (!readFailed) {
          log("warn", {}, "HTTP metrics sample failed");
          alerts.push("Papercompany HTTP metrics sampling failed.");
        }
        readFailed = true;
      } finally {
        reading = false;
        await alerts.flush();
      }
    },
  };
}

const DEFAULT_ALERT_ENV = "/srv/papercompany/projects/research-company/tools/notifications/.env";
const MISSION_STATES = ["planning", "active", "paused", "completed", "cancelled", "other"] as const;
const WORKFLOW_STATES = ["pending", "running", "completed", "failed", "cancelled", "other"] as const;
const RULE_SEVERITIES = ["MUST", "SHOULD", "MAY", "other"] as const;
const DELIVERY_STATES = ["pending", "retrying", "delivered", "failed", "abandoned", "other"] as const;

type ScalarGauge = { set(value: number): void };
type StatusGauge = { reset(): void; set(labels: { status: string }, value: number): void };
type SeverityGauge = { reset(): void; set(labels: { severity: string }, value: number): void };
export type DbMetricGauges = {
  activeSessions: ScalarGauge;
  activeHeartbeats: ScalarGauge;
  missions: StatusGauge;
  workflows: StatusGauge;
  rules: SeverityGauge;
  deliveries: StatusGauge;
  up: ScalarGauge;
  lastSuccess: ScalarGauge;
};
type Snapshot = {
  activeSessions: number;
  activeHeartbeats: number;
  missions: Record<string, number>;
  workflows: Record<string, number>;
  rules: Record<string, number>;
  deliveries: Record<string, number>;
};

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid DB metric count");
  return value;
}

function grouped(value: unknown, labels: readonly string[]): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid DB metric group");
  const source = value as Record<string, unknown>;
  return Object.fromEntries(labels.map((label) => [label, count(source[label] ?? 0)]));
}

/** One read-only transaction produces a consistent snapshot without identifiers in labels. */
async function readDatabaseMetrics(db: Db): Promise<Snapshot> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const rows = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM mission_sessions WHERE status = 'active') AS "activeSessions",
        (SELECT count(*)::int FROM heartbeat_runs WHERE status = 'running') AS "activeHeartbeats",
        (SELECT COALESCE(json_object_agg(k, n), '{}'::json) FROM
          (SELECT CASE WHEN status IN ('planning','active','paused','completed','cancelled')
            THEN status ELSE 'other' END AS k, count(*)::int AS n FROM missions GROUP BY 1) s) AS "missions",
        (SELECT COALESCE(json_object_agg(k, n), '{}'::json) FROM
          (SELECT CASE WHEN status IN ('pending','running','completed','failed','cancelled')
            THEN status ELSE 'other' END AS k, count(*)::int AS n FROM workflow_runs GROUP BY 1) s) AS "workflows",
        (SELECT COALESCE(json_object_agg(k, n), '{}'::json) FROM
          (SELECT CASE WHEN severity IN ('MUST','SHOULD','MAY')
            THEN severity ELSE 'other' END AS k, count(*)::int AS n FROM worktree_rules GROUP BY 1) s) AS "rules",
        (SELECT COALESCE(json_object_agg(k, n), '{}'::json) FROM
          (SELECT CASE WHEN status IN ('pending','retrying','delivered','failed','abandoned')
            THEN status ELSE 'other' END AS k, count(*)::int AS n FROM srb_delivery_log GROUP BY 1) s) AS "deliveries"
    `);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("DB metrics snapshot missing");
    return {
      activeSessions: count(row.activeSessions), activeHeartbeats: count(row.activeHeartbeats),
      missions: grouped(row.missions, MISSION_STATES), workflows: grouped(row.workflows, WORKFLOW_STATES),
      rules: grouped(row.rules, RULE_SEVERITIES), deliveries: grouped(row.deliveries, DELIVERY_STATES),
    };
  });
}

function publishSnapshot(gauges: DbMetricGauges, snapshot: Snapshot): void {
  gauges.activeSessions.set(snapshot.activeSessions);
  gauges.activeHeartbeats.set(snapshot.activeHeartbeats);
  gauges.missions.reset();
  for (const status of MISSION_STATES) gauges.missions.set({ status }, snapshot.missions[status]!);
  gauges.workflows.reset();
  for (const status of WORKFLOW_STATES) gauges.workflows.set({ status }, snapshot.workflows[status]!);
  gauges.rules.reset();
  for (const severity of RULE_SEVERITIES) gauges.rules.set({ severity }, snapshot.rules[severity]!);
  gauges.deliveries.reset();
  for (const status of DELIVERY_STATES) gauges.deliveries.set({ status }, snapshot.deliveries[status]!);
  gauges.lastSuccess.set(Date.now() / 1000);
  gauges.up.set(1);
}

export function createDbMetricsMonitor(db: Db, gauges: DbMetricGauges, logger: MonitorLogger, sendAlert?: MonitorAlertSender) {
  const alerts = createMonitorAlertQueue(sendAlert, logger);
  let failed = false;
  let reading = false;
  let stopped = false;
  let inFlight: Promise<Snapshot> | undefined;
  const log = (level: "warn" | "info", message: string) => { try { logger[level]({}, message); } catch { /* Monitoring is non-critical. */ } };
  function read() {
    if (!inFlight) {
      const pending = readDatabaseMetrics(db);
      inFlight = pending;
      void pending.then(
        () => { if (inFlight === pending) inFlight = undefined; },
        () => { if (inFlight === pending) inFlight = undefined; },
      );
    }
    return inFlight;
  }
  return {
    stop() { stopped = true; },
    async sample(): Promise<void> {
      if (stopped || reading) return;
      reading = true;
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DB metrics timeout")), 10_000);
          timer.unref();
        });
        const snapshot = await Promise.race([read(), timeout]);
        if (stopped) return;
        publishSnapshot(gauges, snapshot);
        if (failed) {
          log("info", "DB metrics sampling recovered");
          alerts.push("Papercompany DB metrics sampling recovered.");
        }
        failed = false;
      } catch {
        if (stopped) return;
        gauges.up.set(0);
        if (!failed) {
          log("warn", "DB metrics sampling failed");
          alerts.push("Papercompany DB metrics sampling failed.");
        }
        failed = true;
      } finally {
        if (timer) clearTimeout(timer);
        reading = false;
        if (!stopped) await alerts.flush();
      }
    },
  };
}

/** Reuse the backup alert's private file; the override is for alternate installations and tests. */
export function createTelegramMetricsSender(): MonitorAlertSender {
  const envFile = process.env.PAPERCOMPANY_METRICS_ALERT_ENV_FILE || DEFAULT_ALERT_ENV;
  return async (message) => {
    try {
      const handle = await open(envFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      let token: string;
      let chat: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("unsafe alert file");
        const values = parse(await handle.readFile({ encoding: "utf8" }));
        token = values.TELEGRAM_BOT_TOKEN ?? "";
        chat = values.TELEGRAM_CHAT_ID ?? "";
      } finally {
        await handle.close();
      }
      if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || !chat) throw new Error("invalid alert configuration");
      const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: message }), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || (await response.json() as { ok?: unknown }).ok !== true) throw new Error("delivery rejected");
    } catch {
      // Never propagate errors that may contain a bot token or response body.
      throw new Error("metrics alert delivery failed");
    }
  };
}
