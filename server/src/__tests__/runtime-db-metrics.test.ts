import express from "express";
import request from "supertest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, companySecrets, createDb, heartbeatRuns, missionSessions, missions,
  srbDeliveryLog, srbLinks, workflowDefinitions, workflowRuns, worktreeRules,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { metricsRoutes } from "../routes/metrics.js";
import { createDbMetricsMonitor, createRuntimeMetricsMonitor, createTelegramMetricsSender } from "../services/runtime-metrics-monitor.js";

describe("DB metrics and operational alerts", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let timer: NodeJS.Timeout | undefined;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("runtime-db-metrics-");
    db = createDb(temp.connectionString);
  }, 90_000);

  afterAll(async () => {
    if (timer) clearInterval(timer);
    await db?.$client.end({ timeout: 5 });
    await temp?.cleanup();
  });

  it("exports real DB counts, clears stale labels and excludes private source fields", async () => {
    const [company] = await db.insert(companies).values({ name: "Metrics fixture", issuePrefix: "MT" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "A", role: "operator", adapterType: "process" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId: company.id, name: "fixture" }).returning();
    const [mission] = await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "private-mission-title", status: "active" }).returning();
    await db.insert(missionSessions).values({ companyId: company.id, missionId: mission.id, agentId: agent.id, sessionSecretId: secret.id, adapterType: "process", status: "active" });
    const [definition] = await db.insert(workflowDefinitions).values({ companyId: company.id, name: "Workflow", stepsJson: [] }).returning();
    await db.insert(workflowRuns).values({ companyId: company.id, missionId: mission.id, workflowId: definition.id, triggeredBy: "manual", status: "running" });
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running" });
    await db.insert(worktreeRules).values({ companyId: company.id, name: "Rule", severity: "MUST", action: "block", createdBy: "test" });
    const [link] = await db.insert(srbLinks).values({ localCompanyId: company.id, remoteCompanyId: "remote", direction: "outbound", createdBy: "test" }).returning();
    await db.insert(srbDeliveryLog).values({ linkId: link.id, event: "test", payloadHash: "fixture", status: "delivered" });

    const intervals = vi.spyOn(globalThis, "setInterval");
    const app = express();
    app.use("/api/metrics", metricsRoutes(db, { sendAlert: vi.fn().mockResolvedValue(undefined) }));
    const tick = intervals.mock.calls[0]![0] as () => void;
    timer = intervals.mock.results[0]!.value as NodeJS.Timeout;
    intervals.mockRestore();

    await vi.waitFor(async () => {
      const response = await request(app).get("/api/metrics").expect(200);
      expect(response.text).toContain('paperclip_missions_by_status{status="active"} 1');
      expect(response.text).toContain('paperclip_workflow_runs_by_status{status="running"} 1');
      expect(response.text).toContain('paperclip_worktree_rules_by_severity{severity="MUST"} 1');
      expect(response.text).toContain('paperclip_srb_deliveries_by_status{status="delivered"} 1');
      expect(response.text).toContain("paperclip_active_mission_sessions 1");
      expect(response.text).toContain("paperclip_active_heartbeat_runs 1");
      expect(response.text).not.toContain("private-mission-title");
      expect(response.text).not.toContain("Metrics fixture");
    }, { timeout: 5_000 });

    await db.update(missions).set({ status: "completed" }).where(eq(missions.id, mission.id));
    tick();
    await vi.waitFor(async () => {
      const response = await request(app).get("/api/metrics").expect(200);
      expect(response.text).toContain('paperclip_missions_by_status{status="active"} 0');
      expect(response.text).toContain('paperclip_missions_by_status{status="completed"} 1');
    }, { timeout: 5_000 });
  }, 90_000);

  it("delivers threshold and recovery alerts, retrying a failed delivery without labels", async () => {
    let value = 10;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const send = vi.fn().mockRejectedValueOnce(new Error("transport secret")).mockResolvedValue(undefined);
    const read = async () => ({ values: [{ value, labels: { method: "GET", route: "/private-label", status_code: "500" } }] });
    const monitor = createRuntimeMetricsMonitor(read, logger, 5, send);
    await monitor.sample();
    value = 15;
    await monitor.sample();
    expect(send).toHaveBeenCalledTimes(1);
    value = 20;
    await monitor.sample();
    expect(send).toHaveBeenCalledTimes(2);
    value = 21;
    await monitor.sample();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toMatch(/HTTP 5xx/i);
    expect(send.mock.calls[2]![0]).toMatch(/recover/i);
    expect(JSON.stringify([send.mock.calls, logger.warn.mock.calls])).not.toMatch(/private-label|transport secret/);
  });

  it("reports and recovers from HTTP sample failures once per episode", async () => {
    let fail = true;
    const send = vi.fn().mockResolvedValue(undefined);
    const monitor = createRuntimeMetricsMonitor(async () => {
      if (fail) throw new Error("private-error");
      return { values: [] };
    }, { warn: vi.fn(), info: vi.fn() }, 5, send);
    await monitor.sample();
    await monitor.sample();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(/HTTP metrics sampling failed/i);
    fail = false;
    await monitor.sample();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatch(/recovered/i);
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-error");
  });

  it("alerts on a stuck DB sample without starting overlapping queries", async () => {
    vi.useFakeTimers();
    try {
      const transaction = vi.fn(() => new Promise(() => {}));
      const scalar = { set: vi.fn() };
      const labeled = { reset: vi.fn(), set: vi.fn() };
      const up = { set: vi.fn() };
      const send = vi.fn().mockResolvedValue(undefined);
      const monitor = createDbMetricsMonitor({ transaction } as unknown as typeof db, {
        activeSessions: scalar, activeHeartbeats: scalar, missions: labeled, workflows: labeled,
        rules: labeled, deliveries: labeled, up, lastSuccess: scalar,
      }, { warn: vi.fn(), info: vi.fn() }, send);
      const first = monitor.sample();
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      expect(up.set).toHaveBeenCalledWith(0);
      expect(send).toHaveBeenCalledOnce();
      const second = monitor.sample();
      await vi.advanceTimersByTimeAsync(10_000);
      await second;
      expect(transaction).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      monitor.stop();
    } finally { vi.useRealTimers(); }
  });

  it("does not publish a timed-out DB snapshot when it resolves in a later sample", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      const delayed = new Promise((resolve) => { release = resolve; });
      const snapshot = {
        activeSessions: 7, activeHeartbeats: 0,
        missions: { planning: 0, active: 0, paused: 0, completed: 0, cancelled: 0, other: 0 },
        workflows: { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0, other: 0 },
        rules: { MUST: 0, SHOULD: 0, MAY: 0, other: 0 },
        deliveries: { pending: 0, retrying: 0, delivered: 0, failed: 0, abandoned: 0, other: 0 },
      };
      const transaction = vi.fn().mockReturnValueOnce(delayed).mockResolvedValue(snapshot);
      const scalar = { set: vi.fn() };
      const labeled = { reset: vi.fn(), set: vi.fn() };
      const up = { set: vi.fn() };
      const send = vi.fn().mockResolvedValue(undefined);
      const monitor = createDbMetricsMonitor({ transaction } as unknown as typeof db, {
        activeSessions: scalar, activeHeartbeats: scalar, missions: labeled, workflows: labeled,
        rules: labeled, deliveries: labeled, up, lastSuccess: scalar,
      }, { warn: vi.fn(), info: vi.fn() }, send);

      const first = monitor.sample();
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      await vi.advanceTimersByTimeAsync(50_000);
      const second = monitor.sample();
      release(snapshot);
      await second;
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(up.set).not.toHaveBeenCalledWith(1);
      expect(scalar.set).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      await monitor.sample();
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(up.set).toHaveBeenCalledWith(1);
      expect(send.mock.calls[1]![0]).toMatch(/recovered/i);
      monitor.stop();
    } finally { vi.useRealTimers(); }
  });

  it("reports a DB sampling failure and recovery without presenting stale values as current", async () => {
    vi.resetModules();
    const fresh = await import("../routes/metrics.js");
    const send = vi.fn().mockResolvedValue(undefined);
    const intervals = vi.spyOn(globalThis, "setInterval");
    const app = express();
    app.use("/api/metrics", fresh.metricsRoutes(db, { sendAlert: send }));
    const tick = intervals.mock.calls[0]![0] as () => void;
    const localTimer = intervals.mock.results[0]!.value as NodeJS.Timeout;
    intervals.mockRestore();
    try {
      await vi.waitFor(async () => {
        const response = await request(app).get("/api/metrics");
        expect(response.text).toContain("paperclip_db_metrics_collection_up 1");
      }, { timeout: 5_000 });
      const beforeFailure = await request(app).get("/api/metrics");
      const lastSuccess = beforeFailure.text.match(/^paperclip_db_metrics_last_success_timestamp_seconds .+$/m)?.[0];
      const previousCount = beforeFailure.text.match(/^paperclip_missions_by_status\{status="completed"\} .+$/m)?.[0];
      expect(lastSuccess).toBeDefined();
      expect(previousCount).toBeDefined();
      const failure = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("private-database-error"));
      tick();
      await vi.waitFor(async () => {
        const response = await request(app).get("/api/metrics");
        expect(response.text).toContain("paperclip_db_metrics_collection_up 0");
        expect(response.text).toContain(lastSuccess!);
        expect(response.text).toContain(previousCount!);
        expect(send).toHaveBeenCalledWith(expect.stringMatching(/DB metrics.*fail/i));
      }, { timeout: 5_000 });
      failure.mockRestore();
      tick();
      await vi.waitFor(async () => {
        const response = await request(app).get("/api/metrics");
        expect(response.text).toContain("paperclip_db_metrics_collection_up 1");
        expect(send).toHaveBeenCalledWith(expect.stringMatching(/DB metrics.*recover/i));
      }, { timeout: 5_000 });
      expect(JSON.stringify(send.mock.calls)).not.toContain("private-database-error");
    } finally {
      vi.restoreAllMocks();
      clearInterval(localTimer);
    }
  }, 30_000);

  it("does not expose a previous database's counts after rebinding", async () => {
    const [company] = await db.insert(companies).values({ name: "Rebind", issuePrefix: "RB" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "A", role: "operator", adapterType: "process" }).returning();
    await db.insert(missions).values({ companyId: company.id, ownerAgentId: agent.id, title: "Old database", status: "completed" });
    vi.resetModules();
    const fresh = await import("../routes/metrics.js");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const app = express();
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    app.use("/api/metrics", fresh.metricsRoutes(db, { sendAlert }));
    const localTimer = intervals.mock.results[0]!.value as NodeJS.Timeout;
    intervals.mockRestore();
    let release: (() => void) | undefined;
    try {
      await vi.waitFor(async () => {
        const response = await request(app).get("/api/metrics");
        expect(response.text).toMatch(/^paperclip_missions_by_status\{status="completed"\} [1-9]/m);
      }, { timeout: 5_000 });
      const pendingDb = {
        transaction: () => new Promise((resolve) => { release = () => resolve({
          activeSessions: 99, activeHeartbeats: 99,
          missions: { planning: 0, active: 0, paused: 0, completed: 99, cancelled: 0, other: 0 },
          workflows: { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0, other: 0 },
          rules: { MUST: 0, SHOULD: 0, MAY: 0, other: 0 },
          deliveries: { pending: 0, retrying: 0, delivered: 0, failed: 0, abandoned: 0, other: 0 },
        }); }),
      } as unknown as typeof db;
      fresh.metricsRoutes(pendingDb, { sendAlert });
      const response = await request(app).get("/api/metrics");
      expect(response.text).toContain("paperclip_db_metrics_collection_up 0");
      expect(response.text).not.toMatch(/^paperclip_missions_by_status\{status="completed"\} [1-9]/m);
      fresh.metricsRoutes(db, { sendAlert });
      await vi.waitFor(async () => {
        const current = await request(app).get("/api/metrics");
        expect(current.text).toContain("paperclip_db_metrics_collection_up 1");
      }, { timeout: 5_000 });
      release?.();
      release = undefined;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const current = await request(app).get("/api/metrics");
      expect(current.text).not.toContain("paperclip_active_heartbeat_runs 99");
      expect(current.text).toContain("paperclip_db_metrics_collection_up 1");
    } finally {
      clearInterval(localTimer);
      release?.();
    }
  }, 30_000);

  it("uses the private existing-format environment file for Telegram delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-alert-test-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, 'export TELEGRAM_BOT_TOKEN="123456:TEST_TOKEN_123"\nTELEGRAM_CHAT_ID=-123456\n', { mode: 0o600 });
    const transport = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubEnv("PAPERCOMPANY_METRICS_ALERT_ENV_FILE", envFile);
    vi.stubGlobal("fetch", transport);
    vi.resetModules();
    const fresh = await import("../routes/metrics.js");
    const intervals = vi.spyOn(globalThis, "setInterval");
    fresh.metricsRoutes(db);
    const tick = intervals.mock.calls[0]![0] as () => void;
    const localTimer = intervals.mock.results[0]!.value as NodeJS.Timeout;
    intervals.mockRestore();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      fresh.httpRequestTotal.inc({ method: "GET", route: "/secret-route", status_code: "500" }, 5);
      tick();
      await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce(), { timeout: 5_000 });
      const [url, options] = transport.mock.calls[0]!;
      expect(String(url)).toBe("https://api.telegram.org/bot123456:TEST_TOKEN_123/sendMessage");
      const payload = JSON.parse((options as RequestInit).body as string);
      expect(payload.chat_id).toBe("-123456");
      expect(payload.text).toMatch(/HTTP 5xx/i);
      expect(payload.text).not.toContain("secret-route");
    } finally {
      clearInterval(localTimer);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects public or symlinked credentials and unsuccessful Telegram responses without leaking secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-alert-safety-"));
    const envFile = join(dir, ".env");
    const symlink = join(dir, "linked.env");
    writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=123456:FAKE_SECRET\nTELEGRAM_CHAT_ID=-123456\n", { mode: 0o600 });
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    try {
      vi.stubEnv("PAPERCOMPANY_METRICS_ALERT_ENV_FILE", envFile);
      chmodSync(envFile, 0o644);
      await expect(createTelegramMetricsSender()("test")).rejects.toThrow("metrics alert delivery failed");
      expect(transport).not.toHaveBeenCalled();
      chmodSync(envFile, 0o600);
      symlinkSync(envFile, symlink);
      vi.stubEnv("PAPERCOMPANY_METRICS_ALERT_ENV_FILE", symlink);
      await expect(createTelegramMetricsSender()("test")).rejects.toThrow("metrics alert delivery failed");
      expect(transport).not.toHaveBeenCalled();
      vi.stubEnv("PAPERCOMPANY_METRICS_ALERT_ENV_FILE", envFile);
      transport.mockResolvedValueOnce(new Response('{"ok":false}', { status: 200 }));
      await expect(createTelegramMetricsSender()("test")).rejects.toThrow("metrics alert delivery failed");
      transport.mockRejectedValueOnce(new Error("123456:FAKE_SECRET"));
      await expect(createTelegramMetricsSender()("test")).rejects.toThrow(/^metrics alert delivery failed$/);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
