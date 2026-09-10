#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBodyBytes = 1024 * 1024;
function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
}
function callbackIdentity(req, trustedBase) {
  const executionId = req.headers["x-papercompany-execution-id"];
  const token = req.headers["x-papercompany-progress-token"];
  if (req.headers["x-papercompany-progress-version"] !== "1" || typeof executionId !== "string" || !uuid.test(executionId) ||
    typeof token !== "string" || !token || token.length > 256) throw new Error("invalid_identity");
  const url = new URL(req.headers["x-papercompany-progress-url"]);
  const prefix = trustedBase.pathname.replace(/\/$/, "") + "/api/companies/";
  if (url.origin !== trustedBase.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) {
    throw new Error("invalid_callback");
  }
  const parts = url.pathname.slice(prefix.length).split("/");
  if (parts.length !== 4 || !uuid.test(parts[0]) || parts[1] !== "tool-executions" || parts[2] !== executionId || parts[3] !== "progress") {
    throw new Error("invalid_callback_identity");
  }
  return { url, executionId, token };
}
async function readItems(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("oversized_input");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join() !== "items" ||
    !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 1000 ||
    body.items.some((item) => typeof item !== "string" || Buffer.byteLength(item) > 64 * 1024)) throw new Error("invalid_items");
  return body.items;
}

// Local teaching fixture, not a public file server: explicit bounded strings only.
export function createExampleServer({ callbackBaseUrl, authToken }) {
  const trustedBase = new URL(callbackBaseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(trustedBase.hostname);
  if (!authToken || trustedBase.username || trustedBase.password || trustedBase.search || trustedBase.hash ||
    (trustedBase.protocol !== "https:" && !(loopback && trustedBase.protocol === "http:"))) throw new Error("invalid_example_config");
  return createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/tool") { reply(res, 404, { error: "not_found" }); return; }
    if (req.headers.authorization !== authToken) { reply(res, 401, { error: "unauthorized" }); return; }
    let identity; let items;
    try { identity = callbackIdentity(req, trustedBase); items = await readItems(req); }
    catch { reply(res, 400, { error: "example_invalid_input" }); return; }
    try {
      let lastSent = -Infinity; let sequence = 0; const hashes = [];
      for (const item of items) {
        if (res.destroyed) throw new Error("caller_disconnected");
        hashes.push(createHash("sha256").update(item).digest("hex"));
        const current = hashes.length; // This item has actually been processed.
        const now = performance.now();
        if (now - lastSent >= 1000) {
          const callback = await fetch(identity.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json", "X-Papercompany-Progress-Token": identity.token },
            body: JSON.stringify({ version: 1, executionId: identity.executionId, sequence: ++sequence,
              stage: "process", unit: "items", current, total: items.length }),
          });
          if (!callback.ok) { await callback.body?.cancel(); throw new Error("callback_rejected"); }
          const receipt = await callback.json();
          if (receipt?.accepted !== true && !(receipt?.accepted === false && receipt?.reason === "throttled")) {
            throw new Error("callback_not_progress");
          }
          lastSent = now;
        }
      }
      // A final result is independent of the last coalesced progress counter.
      reply(res, 200, { result: { processed: hashes.length, hashes } });
    } catch { if (!res.destroyed) reply(res, 502, { error: "example_processing_failed" }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createExampleServer({ callbackBaseUrl: process.env.EXAMPLE_CALLBACK_BASE_URL,
      authToken: process.env.EXAMPLE_TOOL_AUTH_TOKEN });
    const port = Number(process.env.PORT ?? 8088);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
    server.on("error", () => { console.error("example_server_failed"); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => console.log(`Example listening on 127.0.0.1:${server.address().port}`));
  } catch { console.error("example_config_invalid"); process.exitCode = 1; }
}
