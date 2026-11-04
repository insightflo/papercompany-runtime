import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { runtimeHttpMetrics } from "../middleware/runtime-http-metrics.js";
import { metricsRoutes } from "../routes/metrics.js";

describe("runtime HTTP metrics scrape", () => {
  it("exports bounded labels and durations for successful, rejected, failed and missing requests", async () => {
    const app = express();
    app.use(runtimeHttpMetrics());
    app.get("/api/metrics-probe/:id", (_req, res) => res.sendStatus(200));
    app.get("/api/metrics-denied", (_req, res) => res.sendStatus(403));
    app.get("/api/metrics-failed", (_req, res) => res.sendStatus(500));
    const nested = express.Router();
    nested.get("/tasks/:id", (_req, res) => res.sendStatus(200));
    app.use("/api/companies/:companyId", nested);
    app.use("/api/metrics", metricsRoutes());
    await request(app).get("/api/metrics-probe/first?token=secret-value").expect(200);
    await request(app).get("/api/metrics-probe/second").expect(200);
    await request(app).get("/api/metrics-denied").expect(403);
    await request(app).get("/api/metrics-failed").expect(500);
    await request(app).get("/api/missing/run-secret").expect(404);
    await request(app).get("/api/companies/company-secret/tasks/task-secret").expect(200);
    const result = await request(app).get("/api/metrics").expect(200);
    expect(result.text).toContain('paperclip_http_requests_total{method="GET",route="/api/metrics-probe/:id",status_code="200"} 2');
    expect(result.text).toContain('paperclip_http_request_duration_seconds_count{method="GET",route="/api/metrics-probe/:id",status_code="200"} 2');
    for (const [route, status] of [["/api/metrics-denied", "403"], ["/api/metrics-failed", "500"], ["unmatched_api", "404"], ["/nested/tasks/:id", "200"]]) {
      expect(result.text).toContain(`paperclip_http_requests_total{method="GET",route="${route}",status_code="${status}"} 1`);
    }
    expect(result.text).not.toMatch(/secret-value|run-secret|company-secret|task-secret/);
  });
});
