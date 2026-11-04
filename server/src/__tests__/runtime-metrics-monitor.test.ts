import { describe, expect, it, vi } from "vitest";
import { createRuntimeMetricsMonitor } from "../services/runtime-metrics-monitor.js";
import { httpRequestTotal, metricsRoutes } from "../routes/metrics.js";

const row = (value: number, status = "500", route = "/test") => ({
  value, labels: { method: "GET", route, status_code: status },
});

describe("runtime HTTP metrics monitor", () => {
  it("uses a baseline, warns once, and reports recovery without exposing labels", async () => {
    let values = [row(20), row(100, "200")];
    const logger = { warn: vi.fn(), info: vi.fn() };
    const monitor = createRuntimeMetricsMonitor(async () => ({ values }), logger);
    await monitor.sample();
    values = [row(26), row(200, "200")];
    await monitor.sample();
    values = [row(32), row(300, "200")];
    await monitor.sample();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toEqual({ errors: 6, threshold: 5 });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("/test");
    values = [row(33)];
    await monitor.sample();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("counts new series and resets, and preserves the last successful baseline across read failures", async () => {
    let values = [row(10)];
    let fails = false;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const monitor = createRuntimeMetricsMonitor(async () => {
      if (fails) throw new Error("unavailable");
      return { values };
    }, logger);
    await monitor.sample();
    fails = true;
    await monitor.sample();
    await monitor.sample();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    fails = false;
    values = [row(2), row(4, "503", "/new")];
    await monitor.sample();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1]![0]).toEqual({ errors: 6, threshold: 5 });
  });

  it("does not overlap reads, and logging failures do not escape", async () => {
    let finish!: (sample: { values: ReturnType<typeof row>[] }) => void;
    const read = vi.fn(() => new Promise<{ values: ReturnType<typeof row>[] }>((resolve) => { finish = resolve; }));
    const monitor = createRuntimeMetricsMonitor(read, { warn: () => { throw new Error("log"); }, info: () => {} });
    const first = monitor.sample();
    await monitor.sample();
    expect(read).toHaveBeenCalledTimes(1);
    finish({ values: [row(-1)] });
    await expect(first).resolves.toBeUndefined();
  });

  it("starts one unrefed periodic monitor for repeated route creation", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    metricsRoutes();
    metricsRoutes();
    expect(interval).toHaveBeenCalledOnce();
    expect(interval.mock.calls[0]![1]).toBe(60_000);
    const timer = interval.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    interval.mockRestore();
  });

  it("reads the actual registry counter used by the metrics route", async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const monitor = createRuntimeMetricsMonitor(() => httpRequestTotal.get(), logger);
    await monitor.sample();
    httpRequestTotal.inc({ method: "GET", route: "/monitor-test", status_code: "503" }, 5);
    await monitor.sample();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toEqual({ errors: 5, threshold: 5 });
  });
});
