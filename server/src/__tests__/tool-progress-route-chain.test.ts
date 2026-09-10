import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";
import { progressTokenHash } from "../services/tools/progress-policy.js";
import { event, progressDatabase } from "./helpers/tool-progress.js";
import { progressRecord } from "./helpers/tool-progress-records.js";

let fixture: Awaited<ReturnType<typeof progressDatabase>>;
const servers: Server[] = [];
const bases: Record<string, string> = {};
const actors: string[] = [];
const token = "route-fixture-capability";
beforeAll(async () => {
  fixture = await progressDatabase();
  for (const deploymentMode of ["local_trusted", "authenticated"] as const) {
    const app = express();
    // Same relevant order/options as app.ts; no auth or board-guard bypass.
    app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    } }));
    app.use(actorMiddleware(fixture.db, { deploymentMode }));
    const api = express.Router();
    api.use(boardMutationGuard());
    api.use((req, _res, next) => { actors.push(`${req.actor.type}:${req.actor.source}`); next(); });
    api.use(toolDefinitionRoutes(fixture.db));
    app.use("/api", api);
    app.use(errorHandler);
    const server = createServer(app); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    bases[deploymentMode] = `http://127.0.0.1:${address.port}`;
  }
}, 60_000);
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  });
  await fixture?.cleanup();
});
function post(mode: string, companyId: string, id: string, body: string, capability?: string) {
  return fetch(`${bases[mode]}/api/companies/${companyId}/tool-executions/${id}/progress`, {
    method: "POST", headers: { "Content-Type": "application/json",
      ...(capability ? { "X-Papercompany-Progress-Token": capability } : {}) }, body,
  });
}
const record = () => progressRecord(fixture.db, fixture.reader, "http", progressTokenHash(token));

describe("progress capability through actual actor/board guard/tool routes", () => {
  it("denies implicit local board without capability, allows authenticated-mode actor none with it", async () => {
    const r = await record(); const body = JSON.stringify(event(r.row.id));
    const denied = await post("local_trusted", r.scope.companyId, r.row.id, body);
    expect(denied.status).toBe(401); expect(actors.at(-1)).toBe("board:local_implicit");
    expect((await r.read()).sequence).toBe(0);
    const accepted = await post("authenticated", r.scope.companyId, r.row.id, body, token);
    expect(accepted.status).toBe(200); expect(actors.at(-1)).toBe("none:none");
    expect(await accepted.json()).toEqual({ accepted: true });
    expect((await r.read()).current).toBe(1);
  });

  it.each(["company", "execution", "token"])("rejects wrong %s without writes or capability echoes", async (wrong) => {
    const r = await record(); const before = await r.read(); const audit = await r.audit();
    const response = await post("authenticated", wrong === "company" ? randomUUID() : r.scope.companyId,
      wrong === "execution" ? randomUUID() : r.row.id, JSON.stringify(event(r.row.id)), wrong === "token" ? "wrong" : token);
    expect(response.status).toBe(wrong === "token" ? 401 : 404);
    const body = await response.text();
    expect(body).not.toContain(token); expect(body).not.toContain(progressTokenHash(token));
    expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
  });

  it.each(["oversized", "malformed", "global-oversized"])("returns 400 for %s wire JSON without writes", async (kind) => {
    const r = await record(); const before = await r.read(); const audit = await r.audit();
    const body = kind === "malformed" ? '{"version":' : JSON.stringify(event(r.row.id)) +
      " ".repeat(kind === "global-oversized" ? 10 * 1024 * 1024 : 4096);
    const response = await post("authenticated", r.scope.companyId, r.row.id, body, token);
    const responseBody = await response.text();
    console.info("callback invalid body", { kind, status: response.status, body: responseBody });
    expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
    expect(response.status).toBe(400);
    expect(responseBody).not.toContain(token); expect(responseBody).not.toContain("tokenHash");
    expect(responseBody).not.toContain(r.row.id);
    expect(JSON.parse(responseBody)).toEqual({ error: "tool_progress_invalid_event" });
  });

  it("returns 409 after terminal and never exposes the row/hash/token", async () => {
    const r = await record(); await r.store.finish(r.scope.companyId, r.row.id, "succeeded");
    const before = await r.read(); const audit = await r.audit();
    const response = await post("authenticated", r.scope.companyId, r.row.id, JSON.stringify(event(r.row.id)), token);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(JSON.stringify(body)).not.toContain(token); expect(JSON.stringify(body)).not.toContain(progressTokenHash(token));
    expect(await r.read()).toEqual(before); expect(await r.audit()).toEqual(audit);
  });
});
