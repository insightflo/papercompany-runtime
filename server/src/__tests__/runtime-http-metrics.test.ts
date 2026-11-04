/**
 * WBS 3A runtime HTTP metrics 미들웨어 테스트.
 *
 * 기존 prom-client 지표(httpRequestDuration/httpRequestTotal)는 vi.mock으로
 * 가로채고, 실제 Express 5 앱에 supertest로 요청해 다음을 검증한다.
 * - 라우트 템플릿 라벨(원문 ID·쿼리·비밀 미포함)
 * - 상태 코드 그룹화와 duration 기록
 * - 매칭 실패 경로의 고정 라벨
 * - 수집 실패가 요청 처리를 막지 않음(WBS 3A 완료 조건)
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

const { observeMock, incMock } = vi.hoisted(() => ({
  observeMock: vi.fn(),
  incMock: vi.fn(),
}));

vi.mock("../routes/metrics.js", () => ({
  httpRequestDuration: { observe: observeMock },
  httpRequestTotal: { inc: incMock },
}));

import { resolveRouteTemplate, runtimeHttpMetrics } from "../middleware/runtime-http-metrics.js";

function buildApp() {
  const app = express();
  app.use(runtimeHttpMetrics());
  const api = express.Router();
  api.get("/things/:thingId", (req, res) => {
    res.status(req.query.fail ? 503 : 200).json({ ok: true });
  });
  app.use("/api", api);
  // 라우트 매칭 실패(404)도 지표에 포함되는지 보는 fallback 핸들러
  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found" }));
  return app;
}

function syntheticReq(overrides: { baseUrl?: string; path?: string; route?: unknown } = {}): Request {
  return {
    method: "GET",
    baseUrl: overrides.baseUrl ?? "",
    path: overrides.path ?? "/",
    route: overrides.route,
  } as unknown as Request;
}

describe("runtimeHttpMetrics (WBS 3A)", () => {
  beforeEach(() => {
    observeMock.mockReset();
    incMock.mockReset();
    observeMock.mockImplementation(() => {});
    incMock.mockImplementation(() => {});
  });

  it("라우트 템플릿 단위로 count/duration/status를 기록하고 원문 ID·쿼리를 라벨에 넣지 않는다", async () => {
    const res = await request(buildApp()).get(
      "/api/things/9f8e7d6c-1111-2222-3333-444455556666?token=secret-value",
    );
    expect(res.status).toBe(200);

    expect(incMock).toHaveBeenCalledTimes(1);
    const [labels] = incMock.mock.calls[0]!;
    expect(labels).toEqual({ method: "GET", route: "/api/things/:thingId", status_code: "200" });
    expect(String(labels.route)).not.toContain("9f8e7d6c");
    expect(String(labels.route)).not.toContain("secret-value");

    expect(observeMock).toHaveBeenCalledTimes(1);
    const [durationLabels, duration] = observeMock.mock.calls[0]!;
    expect(durationLabels).toEqual(labels);
    expect(typeof duration).toBe("number");
    expect(duration as number).toBeGreaterThanOrEqual(0);
    expect(duration as number).toBeLessThan(5);
  });

  it("같은 템플릿에 다른 상태 코드를 함께 묶는다", async () => {
    const app = buildApp();
    await request(app).get("/api/things/1").expect(200);
    await request(app).get("/api/things/2?fail=1").expect(503);

    expect(incMock).toHaveBeenCalledTimes(2);
    const statuses = incMock.mock.calls.map((call) => (call[0] as { status_code: string }).status_code);
    expect(statuses).toEqual(["200", "503"]);
    const routes = incMock.mock.calls.map((call) => (call[0] as { route: string }).route);
    expect(routes).toEqual(["/api/things/:thingId", "/api/things/:thingId"]);
  });

  it("매칭되지 않은 /api 경로는 URL 유출 없이 고정 라벨로 묶는다", async () => {
    const res = await request(buildApp()).get("/api/never-matched/run-12345?secret=k");
    expect(res.status).toBe(404);

    const [labels] = incMock.mock.calls[0]!;
    // router@2는 .use 레이어에서 req.baseUrl을 마운트 경로("/api")로 세우므로
    // 이 fallback의 고정 라벨은 "/api/"가 된다.
    expect(labels.route).toBe("/api/");
    expect(String(labels.route)).not.toContain("never-matched");
    expect(String(labels.route)).not.toContain("12345");
  });

  it("수집 실패가 요청 처리를 막지 않는다 (WBS 3A)", async () => {
    observeMock.mockImplementation(() => {
      throw new Error("prom-client down");
    });
    incMock.mockImplementation(() => {
      throw new Error("prom-client down");
    });

    const res = await request(buildApp()).get("/api/things/7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("collapses variable nested router mounts without exposing IDs", async () => {
    const app = express();
    app.use(runtimeHttpMetrics());
    const nested = express.Router();
    nested.get("/tasks/:taskId", (_req, res) => res.sendStatus(200));
    app.use("/api/companies/:companyId", nested);
    for (let i = 0; i < 20; i++) {
      await request(app).get(`/api/companies/company-secret-${i}/tasks/task-secret-${i}?token=secret`).expect(200);
    }
    const routes = incMock.mock.calls.map(([labels]) => labels.route);
    expect(new Set(routes)).toEqual(new Set(["/nested/tasks/:taskId"]));
    expect(JSON.stringify(routes)).not.toMatch(/company-secret|task-secret|token/);
  });

  it("resolveRouteTemplate: 템플릿과 고정 라벨 조합을 결정한다", () => {
    expect(resolveRouteTemplate(syntheticReq({ baseUrl: "/api", route: { path: "/things/:id" } }))).toBe(
      "/api/things/:id",
    );
    expect(resolveRouteTemplate(syntheticReq({ route: { path: "/api/health" } }))).toBe("/api/health");
    expect(resolveRouteTemplate(syntheticReq({ baseUrl: "/api" }))).toBe("/api/");
    expect(resolveRouteTemplate(syntheticReq({ path: "/api/unknown" }))).toBe("unmatched_api");
    expect(resolveRouteTemplate(syntheticReq({ path: "/index.html" }))).toBe("unmatched");
    // 방어 코드: 배열·정규식·빈 문자열 경로도 고정 템플릿으로 정규화한다
    expect(resolveRouteTemplate(syntheticReq({ route: { path: ["/a", "/b"] } }))).toBe("/a|/b");
    expect(resolveRouteTemplate(syntheticReq({ route: { path: /^.*$/ } }))).toBe("/");
    expect(resolveRouteTemplate(syntheticReq({ route: { path: "" } }))).toBe("/");
  });
});
