import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const directory = path.dirname(fileURLToPath(import.meta.url));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("local copier reports only copied bytes through fd3, leaving stdout as final JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tool-progress-example-"));
  const executionId = randomUUID();
  try {
    const input = path.join(dir, "source.bin"); const output = path.join(dir, "copy.bin");
    const bytes = Buffer.alloc(128 * 1024, 42); await writeFile(input, bytes);
    const child = spawn(process.execPath, [path.join(directory, "local-copy.mjs"), "--input", input, "--output", output], {
      env: { ...process.env, PAPERCOMPANY_TOOL_EXECUTION_ID: executionId, PAPERCOMPANY_TOOL_PROGRESS_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"], signal: AbortSignal.timeout(5000),
    });
    let stdout = ""; let stderr = ""; let frames = "";
    child.stdout.on("data", (b) => { stdout += b; }); child.stderr.on("data", (b) => { stderr += b; });
    child.stdio[3].on("data", (b) => { frames += b; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, stderr); assert.equal(stderr, "");
    assert.deepEqual(await readFile(output), bytes);
    assert.deepEqual(JSON.parse(stdout), { bytes: bytes.length, output });
    const events = frames.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.length > 0);
    for (const [i, event] of events.entries()) {
      assert.deepEqual(Object.keys(event).sort(), ["version", "executionId", "sequence", "stage", "unit", "current", "total"].sort());
      assert.equal(event.executionId, executionId); assert.equal(event.sequence, i + 1);
      assert.equal(event.stage, "copy"); assert.equal(event.unit, "bytes"); assert.equal(event.total, bytes.length);
      assert.ok(event.current > (events[i - 1]?.current ?? 0)); assert.ok(event.current <= bytes.length);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("HTTP item service uses pinned callback identity, fails on non-2xx, never echoes capability", async () => {
  const { createExampleServer } = await import("./http-items.mjs");
  const token = "fixture-only-progress-capability"; const executionId = randomUUID(); const companyId = randomUUID();
  const events = []; let callbackStatus = 200;
  const callback = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    events.push({ url: req.url, token: req.headers["x-papercompany-progress-token"], body: JSON.parse(body) });
    res.writeHead(callbackStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(callbackStatus === 200 ? { accepted: true } : { error: token }));
  });
  const base = await listen(callback);
  const service = createExampleServer({ callbackBaseUrl: base, authToken: "fixture-auth" });
  const url = await listen(service);
  const callbackPath = `/api/companies/${companyId}/tool-executions/${executionId}/progress`;
  const headers = { "Content-Type": "application/json", Authorization: "fixture-auth", "X-Papercompany-Progress-Version": "1",
    "X-Papercompany-Execution-Id": executionId, "X-Papercompany-Progress-Token": token, "X-Papercompany-Progress-Url": base + callbackPath };
  try {
    const items = ["alpha", "beta", "gamma"];
    const response = await fetch(`${url}/tool`, { method: "POST", headers, body: JSON.stringify({ items }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { processed: items.length,
      hashes: items.map((value) => createHash("sha256").update(value).digest("hex")) } });
    assert.ok(events.length > 0); assert.equal(events[0].token, token); assert.equal(events[0].url, callbackPath);
    assert.deepEqual(events[0].body, { version: 1, executionId, sequence: 1, stage: "process", unit: "items", current: 1, total: 3 });
    callbackStatus = 409;
    const denied = await fetch(`${url}/tool`, { method: "POST", headers, body: JSON.stringify({ items }) });
    assert.equal(denied.status, 502); assert.equal(await denied.text(), '{"error":"example_processing_failed"}');
    const before = events.length;
    const mismatch = await fetch(`${url}/tool`, { method: "POST", headers: { ...headers, "X-Papercompany-Execution-Id": randomUUID() }, body: JSON.stringify({ items }) });
    assert.equal(mismatch.status, 400); assert.equal(events.length, before);
    const paths = await fetch(`${url}/tool`, { method: "POST", headers, body: JSON.stringify({ path: "/etc/passwd" }) });
    assert.equal(paths.status, 400); assert.equal(events.length, before);
  } finally { await close(service); await close(callback); }
});
