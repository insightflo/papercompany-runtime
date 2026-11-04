/** Read the existing HTTP counter without touching request or mission state. */
type CounterSample = { values: Array<{ value: number; labels: { method?: string | number; route?: string | number; status_code?: string | number } }> };
type MonitorLogger = { warn: (fields: Record<string, unknown>, message: string) => void; info: (fields: Record<string, unknown>, message: string) => void };

export function createRuntimeMetricsMonitor(read: () => Promise<CounterSample>, logger: MonitorLogger, threshold = 5) {
  let previous: Map<string, number> | null = null;
  let alerting = false;
  let reading = false;
  let readFailed = false;
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
          } else if (errors < threshold && alerting) {
            alerting = false;
            log("info", { errors, threshold }, "HTTP 5xx threshold recovered");
          }
        }
        previous = next;
        readFailed = false;
      } catch {
        if (!readFailed) log("warn", {}, "HTTP metrics sample failed");
        readFailed = true;
      } finally {
        reading = false;
      }
    },
  };
}
