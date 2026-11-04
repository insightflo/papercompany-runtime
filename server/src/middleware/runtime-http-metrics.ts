/**
 * Runtime HTTP metrics middleware (WBS 3A: 실제 지표 연결).
 *
 * [목적] Express 요청마다 count / duration / status_code를 라우트 템플릿 단위로
 * 기록해 기존 prom-client 레지스트리(server/src/routes/metrics.ts)에 반영한다.
 * 별도 등록 없이 기존 /api/metrics(Prometheus)와 /api/metrics/json에 함께 노출된다.
 *
 * [흐름] app.use(runtimeHttpMetrics())로 라우팅보다 앞에 마운트한다. finish
 * 이벤트에서 Express 라우팅 결과로 저카디널리티
 * 라벨을 만들어 기존 paperclip_http_request_duration_seconds 히스토그램과
 * paperclip_http_requests_total 카운터에 기록한다.
 *
 * [주의]
 * - 라벨은 라우트 템플릿을 사용한다. 가변 마운트 경로는 /nested로 묶는다.
 *   원문 URL·쿼리·비밀·고유 실행 ID는 지표 이름표에 넣지 않는다.
 * - 매칭 실패(404 fallback·정적·라우팅 전 에러)는 고정 라벨로 묶는다.
 * - 수집 실패는 절대 요청 처리로 전파하지 않는다(WBS 3A: 수집 실패가 업무를 막지 않음).
 * - 기존 routes/metrics.ts의 metricsMiddleware()(URL 정규화 방식, 미마운트)는
 *   그대로 둔다. 이 미들웨어가 템플릿 기반으로 대체한다(정리는 별도 승인 범위).
 */

import type { NextFunction, Request, Response } from "express";
import { httpRequestDuration, httpRequestTotal } from "../routes/metrics.js";

/** @types/express에 매칭 라우트 정보가 선언돼 있지 않아 최소 형태로만 본다. */
type MatchedRoute = { path?: unknown };

/**
 * 완료된 요청의 저카디널리티 라우트 템플릿을 만든다.
 * baseUrl은 중첩 라우터에서 실제 매개변수 값을 포함할 수 있으므로
 * 고정된 루트만 보존하고 나머지 마운트는 하나의 라벨로 묶는다.
 */
export function resolveRouteTemplate(req: Request): string {
  const mountedBase = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const base = mountedBase === "" || mountedBase === "/api" ? mountedBase : "/nested";
  const route = (req as unknown as { route?: MatchedRoute }).route;
  if (route && route.path !== undefined) {
    const path = route.path;
    // 배열·정규식 경로(Express 5에서는 문자열이 표준)도 고정 템플릿으로 정규화한다.
    const routePath = Array.isArray(path)
      ? path.map((part) => String(part)).join("|")
      : path instanceof RegExp
        ? ""
        : String(path);
    const template = `${base}${routePath}`;
    return template.length > 0 ? template : "/";
  }
  // 라우트 매칭 전·실패는 마운트 경로 기준 고정 라벨로 묶는다.
  if (base.length > 0) return `${base}/`;
  return typeof req.path === "string" && req.path.startsWith("/api") ? "unmatched_api" : "unmatched";
}

/**
 * 요청 완료 시점에 기존 히스토그램·카운터에 기록하는 미들웨어.
 * 라우팅·body 파서보다 앞에 마운트해야 파싱 실패 응답까지 포함된다.
 */
export function runtimeHttpMetrics() {
  return function runtimeHttpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      try {
        const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
        const labels = {
          method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method) ? req.method : "OTHER",
          route: resolveRouteTemplate(req),
          status_code: String(res.statusCode),
        };
        httpRequestDuration.observe(labels, durationSeconds);
        httpRequestTotal.inc(labels);
      } catch {
        // 지표 수집 실패는 업무를 막지 않는다(WBS 3A). 로그는 httpLogger가 아니라
        // 이 try의 정적 무시로 처리해 요청 경로에 I/O를 추가하지 않는다.
      }
    });
    next();
  };
}
