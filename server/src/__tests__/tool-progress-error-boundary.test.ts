import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

const path = "/api/companies/company/tool-executions/execution/progress";
const parserError = (type = "entity.parse.failed", status = 400) =>
  Object.assign(new Error("private-parser-body"), { type, status, body: "private-body" });

describe("progress parser error mapping only at the authorized boundary", () => {
  it.each([
    ["POST", path, parserError(), 400],
    ["POST", `${path.toUpperCase()}/`, parserError("entity.too.large", 413), 400],
    ["POST", `${path}?ignored=yes`, parserError(), 400],
    ["GET", path, parserError(), 500],
    ["POST", "/api/unrelated", parserError(), 500],
    ["POST", `/api/unrelated?spoof=${path}`, parserError(), 500],
    ["POST", path, new Error("private-arbitrary-error"), 500],
    ["POST", path, parserError("encoding.unsupported", 415), 500],
    ["POST", path, parserError("entity.parse.failed", 413), 500],
    ["POST", path, parserError("entity.too.large", 400), 500],
    ["POST", `${path}/extra`, parserError(), 500],
    ["POST", path.replace("company/tool", "nested/company/tool"), parserError(), 500],
  ] as const)("%s %s preserves scoped status %s", async (method, url, error, status) => {
    const app = express();
    let context: unknown; let raw: unknown;
    app.use((_req, _res, next) => next(error));
    app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      errorHandler(err, req, res, next);
      const observed = res as express.Response & { __errorContext?: unknown; err?: unknown };
      context = observed.__errorContext; raw = observed.err;
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`, { method });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: status === 400 ? "tool_progress_invalid_event" : "Internal server error" });
      if (status === 400) { expect(context).toBeUndefined(); expect(raw).toBeUndefined(); }
      else { expect(context).toBeDefined(); expect(raw).toBe(error); }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
