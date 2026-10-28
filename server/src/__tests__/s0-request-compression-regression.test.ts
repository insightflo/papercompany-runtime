import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const DEFAULT_SERVER_ROOT = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const CHILD_TIMEOUT_MS = 6_500;

function selectedServerRoot() {
  const input = process.env.S0_REGRESSION_SERVER_ROOT;
  return realpathSync(input ? resolve(process.cwd(), input) : DEFAULT_SERVER_ROOT);
}

function packageInfo(serverRoot: string) {
  const workspaceRoot = dirname(serverRoot);
  const requireFromServer = createRequire(join(serverRoot, "package.json"));
  const expressEntry = realpathSync(requireFromServer.resolve("express"));
  const bodyParserEntry = realpathSync(createRequire(expressEntry).resolve("body-parser"));
  const paths = { express: expressEntry, bodyParser: bodyParserEntry };
  for (const entry of Object.values(paths)) {
    const fromWorkspace = relative(workspaceRoot, entry);
    if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
      throw new Error(`Resolved dependency escaped selected workspace: ${entry}`);
    }
  }
  const version = (entry: string) => JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version;
  return { paths, versions: { express: version(expressEntry), bodyParser: version(bodyParserEntry) } };
}

function runChild(serverRoot: string, source: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>((resolveChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: serverRoot,
      env: { S0_REGRESSION_SERVER_ROOT: serverRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = "";
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-12_000); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });
    child.once("error", (error) => { spawnError = String(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveChild({ code: spawnError ? -1 : code, signal, timedOut, stdout, stderr: spawnError ? `${stderr}\n${spawnError}` : stderr });
    });
  });
}

function records(output: string) {
  return output.split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

const CHILD = String.raw`
import { createServer, request } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

const serverRoot = realpathSync(process.env.S0_REGRESSION_SERVER_ROOT);
const workspaceRoot = dirname(serverRoot);
const requireFromServer = createRequire(join(serverRoot, "package.json"));
const expressEntry = realpathSync(requireFromServer.resolve("express"));
const bodyParserEntry = realpathSync(createRequire(expressEntry).resolve("body-parser"));
const entries = { express: expressEntry, bodyParser: bodyParserEntry };
for (const entry of Object.values(entries)) {
  const rel = relative(workspaceRoot, entry);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("dependency resolved outside selected workspace");
}
const packageVersion = (entry) => JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")).version;
const versions = { express: packageVersion(expressEntry), bodyParser: packageVersion(bodyParserEntry) };
console.log(JSON.stringify({ kind: "resolved-packages", serverRoot, paths: entries, versions }));

const express = requireFromServer("express");
const app = express();
app.use(express.json({
  limit: "10mb",
  verify(req, _res, bytes) { req.rawBody = bytes; },
}));
app.post("/", (req, res) => res.status(200).json(req.body));
app.use((error, _req, res, _next) => {
  if (!res.headersSent) res.status(error.statusCode || error.status || 400).json({ error: error.type || "body_parse_error" });
});

const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
function post(bytes, encoding, allowDisconnect = false, splitAt = bytes.length) {
  return new Promise((resolve, reject) => {
    let requestFinished = false;
    let responseFinished = false;
    let responseResult;
    let delayedWrite;
    const finish = () => { if (requestFinished && responseFinished) resolve(responseResult); };
    const onError = (error) => {
      if (delayedWrite) clearTimeout(delayedWrite);
      if (allowDisconnect && requestFinished) resolve({ status: null, body: "", transportError: String(error.code || error.name || error) });
      else reject(error);
    };
    const headers = { "content-type": "application/json", "content-length": String(bytes.length) };
    if (encoding) headers["content-encoding"] = encoding;
    const req = request({ hostname: "127.0.0.1", port, method: "POST", path: "/", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.once("aborted", () => onError(new Error("response aborted")));
      res.once("error", onError);
      res.once("end", () => {
        responseResult = { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") };
        responseFinished = true;
        finish();
      });
    });
    req.once("finish", () => { requestFinished = true; finish(); });
    req.once("error", onError);
    if (splitAt < bytes.length) {
      req.write(bytes.subarray(0, splitAt));
      delayedWrite = setTimeout(() => req.end(bytes.subarray(splitAt)), 25);
    } else {
      req.end(bytes);
    }
  });
}
try {
  const healthy = {};
  const value = (encoding) => Buffer.from(JSON.stringify({ ok: true, encoding }));
  for (const [encoding, compress] of Object.entries({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync })) {
    const response = await post(compress(value(encoding)), encoding);
    if (response.status !== 200 || JSON.stringify(JSON.parse(response.body)) !== JSON.stringify({ ok: true, encoding })) {
      throw new Error("healthy " + encoding + " JSON did not survive decompression");
    }
    healthy[encoding] = response.status;
  }

  const overLimitJson = Buffer.from(JSON.stringify({ padding: "x".repeat(10 * 1024 * 1024) }));
  const overLimit = await post(gzipSync(overLimitJson), "gzip");
  if (overLimit.status !== 413) throw new Error("10mb inflated body limit changed: " + overLimit.status);

  const trailingJson = Buffer.from(JSON.stringify({ ok: true, source: "valid-frame" }));
  const validFrame = gzipSync(trailingJson);
  const trailingBytes = Buffer.concat([validFrame, Buffer.from([0xff, 0x00, 0x01, 0x02])]);
  const malformed = await post(trailingBytes, "gzip", true, validFrame.length);
  const next = await post(Buffer.from(JSON.stringify({ ok: true, source: "after-malformed" })), undefined);
  if (next.status !== 200 || JSON.stringify(JSON.parse(next.body)) !== JSON.stringify({ ok: true, source: "after-malformed" })) {
    throw new Error("normal JSON request failed after compressed trailing bytes");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(JSON.stringify({
    kind: "result",
    healthy,
    overLimitStatus: overLimit.status,
    malformedOutcome: malformed.transportError ? "transport-error" : "http-response",
    nextStatus: next.status,
  }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
`;

test("Express compressed JSON survives valid encodings, size limit, and trailing-byte input", async () => {
  const serverRoot = selectedServerRoot();
  const expectedPackages = packageInfo(serverRoot);
  const child = await runChild(serverRoot, CHILD);
  const outputRecords = records(child.stdout);
  const resolved = outputRecords.find((record) => record.kind === "resolved-packages");
  console.info("[S0 resolved packages] " + JSON.stringify(resolved));
  expect(resolved).toEqual({ kind: "resolved-packages", serverRoot, ...expectedPackages });
  if (child.timedOut || child.code !== 0) {
    throw new Error(`isolated parser process failed (exit=${child.code}, signal=${child.signal}, timeout=${child.timedOut})\n${child.stdout}\n${child.stderr}`);
  }
  const result = outputRecords.find((record) => record.kind === "result");
  expect(result).toEqual({
    kind: "result",
    healthy: { gzip: 200, deflate: 200, br: 200 },
    overLimitStatus: 413,
    malformedOutcome: expect.stringMatching(/^(http-response|transport-error)$/),
    nextStatus: 200,
  });
  expect(["http-response", "transport-error"]).toContain(result?.malformedOutcome);
}, 9_000);
