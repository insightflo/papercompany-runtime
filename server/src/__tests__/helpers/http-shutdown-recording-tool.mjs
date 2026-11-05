import { appendFileSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";

const port = Number(process.env.H4_HTTP_PORT);
const tlsPort = Number(process.env.H4_TLS_PORT);
const eventsFile = process.env.H4_HTTP_EVENTS_FILE;
const requests = new Map();
let targetBase = "";
const record = (event, data = {}) => appendFileSync(eventsFile, JSON.stringify({
  schemaVersion: "http-shutdown-recording-tool.v1", event, pid: process.pid, ...data,
}) + "\n");

function reply(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(value));
}

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function sendCallback(state) {
  record("callback-started", { nonce: state.nonce, executionId: state.executionId });
  try {
    const response = await fetch(state.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Papercompany-Progress-Token": state.token },
      body: JSON.stringify({ version: 1, executionId: state.executionId, sequence: 1,
        stage: "running", unit: "items", current: 1, total: 2 }),
    });
    const result = { status: response.status, body: await response.json() };
    record("callback-result", { nonce: state.nonce, executionId: state.executionId, ...result });
    return result;
  } catch (error) {
    record("callback-error", { nonce: state.nonce, executionId: state.executionId,
      error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ready: true });
    if (req.method === "GET" && req.url === "/events") {
      const { readFileSync } = await import("node:fs");
      const rows = readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      return reply(res, 200, rows);
    }
    const control = /^\/control\/(callback|result)\/([^/]+)$/.exec(req.url ?? "");
    if (req.method === "POST" && req.url === "/control/target") {
      const input = await bodyOf(req);
      const target = new URL(String(input.target));
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
        return reply(res, 400, { error: "invalid_callback_target" });
      }
      targetBase = target.toString();
      return reply(res, 200, { configured: true });
    }
    if (req.method === "POST" && control) {
      const state = requests.get(decodeURIComponent(control[2]));
      if (!state) return reply(res, 404, { error: "request_not_found" });
      if (control[1] === "callback") {
        state.callbackPromise ??= sendCallback(state);
        return reply(res, 202, { started: true });
      }
      state.resultGate.release();
      return reply(res, 202, { released: true });
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      reply(res, 200, { stopping: true });
      setImmediate(() => {
        server.close(() => callbackProxy.close(() => record("peer-stopped")));
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/tool") return reply(res, 404, { error: "not_found" });

    const input = await bodyOf(req);
    const nonce = String(input.nonce ?? "");
    const state = {
      nonce,
      executionId: req.headers["x-papercompany-execution-id"],
      callbackUrl: req.headers["x-papercompany-progress-url"],
      token: req.headers["x-papercompany-progress-token"],
      resultGate: gate(),
      callbackPromise: null,
    };
    requests.set(nonce, state);
    record("tool-started", { nonce, requestId: req.headers["x-papercompany-request-id"],
      executionId: state.executionId, callbackUrl: state.callbackUrl, hold: input.hold === true });
    if (req.headers["x-h4-auth"] !== process.env.H4_EXPECTED_AUTH) return reply(res, 401, { error: "tool_auth_rejected" });
    if (input.hold === true) {
      await state.resultGate.promise;
      if (state.callbackPromise) await state.callbackPromise;
    }
    const result = { result: { value: `actual:${nonce}` } };
    record("tool-result", { nonce, requestId: req.headers["x-papercompany-request-id"], result });
    return reply(res, 200, result);
  } catch (error) {
    record("peer-error", { error: error instanceof Error ? error.name : "unknown" });
    if (!res.headersSent) reply(res, 500, { error: "peer_failure" });
    else res.destroy();
  }
});

const callbackProxy = createHttpsServer({
  key: readFileSync(process.env.H4_TLS_KEY_FILE),
  cert: readFileSync(process.env.H4_TLS_CERT_FILE),
}, (req, res) => {
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ready: true });
  if (!targetBase || req.method !== "POST" || !/^\/api\/companies\/[^/]+\/tool-executions\/[^/]+\/progress$/.test(req.url ?? "")) {
    return reply(res, 404, { error: "callback_target_unavailable" });
  }
  const target = new URL(req.url, targetBase);
  record("callback-proxy-started", { path: req.url, target: target.toString() });
  const upstream = httpRequest(target, { method: req.method,
    headers: { ...req.headers, host: target.host, connection: "close" } }, (response) => {
    record("callback-proxy-response", { path: req.url, status: response.statusCode ?? 0 });
    const headers = { ...response.headers, connection: "close" };
    delete headers["transfer-encoding"];
    res.writeHead(response.statusCode ?? 502, headers);
    response.pipe(res);
  });
  upstream.on("error", (error) => {
    record("callback-proxy-error", { path: req.url, error: error.name });
    if (!res.headersSent) reply(res, 502, { error: "callback_target_failed" });
    else res.destroy();
  });
  req.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => record("peer-ready", { port }));
callbackProxy.listen(tlsPort, "127.0.0.1", () => record("callback-proxy-ready", { port: tlsPort }));
