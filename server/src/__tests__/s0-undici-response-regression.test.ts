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
  const undiciEntry = realpathSync(requireFromServer.resolve("undici"));
  const fromWorkspace = relative(workspaceRoot, undiciEntry);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new Error(`Resolved dependency escaped selected workspace: ${undiciEntry}`);
  }
  const version = JSON.parse(readFileSync(join(dirname(undiciEntry), "package.json"), "utf8")).version;
  return { paths: { undici: undiciEntry }, versions: { undici: version } };
}

function runChild(serverRoot: string, source: string) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>((resolveChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
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
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const serverRoot = realpathSync(process.env.S0_REGRESSION_SERVER_ROOT);
const workspaceRoot = dirname(serverRoot);
const requireFromServer = createRequire(join(serverRoot, "package.json"));
const undiciEntry = realpathSync(requireFromServer.resolve("undici"));
const rel = relative(workspaceRoot, undiciEntry);
if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("undici resolved outside selected workspace");
const undiciVersion = JSON.parse(readFileSync(join(dirname(undiciEntry), "package.json"), "utf8")).version;
console.log(JSON.stringify({ kind: "resolved-packages", serverRoot, paths: { undici: undiciEntry }, versions: { undici: undiciVersion } }));

const dispatcherModule = pathToFileURL(join(serverRoot, "src/services/workflow/http-tool-dispatcher.ts")).href;
const { httpDispatcher, undiciFetch } = await import(dispatcherModule);
const dispatcher = httpDispatcher();
const server = createServer((req, res) => {
  if (req.url === "/excessive-encoding") {
    const socket = res.socket;
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": Array(6).fill("gzip").join(", "),
      "content-length": "128",
    });
    res.flushHeaders();
    setImmediate(() => socket?.destroy());
    return;
  }
  const body = JSON.stringify({ ok: true });
  res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = "http://127.0.0.1:" + server.address().port;
try {
  let malformedFailed = false;
  try {
    const response = await undiciFetch(baseUrl + "/excessive-encoding", { dispatcher });
    await response.arrayBuffer();
  } catch {
    malformedFailed = true;
  }
  if (!malformedFailed) throw new Error("response with excessive Content-Encoding unexpectedly succeeded");

  const healthy = await undiciFetch(baseUrl + "/healthy", { dispatcher });
  const body = await healthy.json();
  if (healthy.status !== 200 || JSON.stringify(body) !== JSON.stringify({ ok: true })) {
    throw new Error("normal response failed after malformed response");
  }
  await dispatcher.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  console.log(JSON.stringify({ kind: "result", malformedFailed, healthyStatus: healthy.status, dispatcherClosed: true, serverClosed: true }));
} catch (error) {
  await dispatcher.destroy().catch(() => undefined);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  throw error;
}
`;

test("production Undici dispatcher survives excessive encodings and an early close", async () => {
  const serverRoot = selectedServerRoot();
  const expectedPackages = packageInfo(serverRoot);
  const child = await runChild(serverRoot, CHILD);
  const outputRecords = records(child.stdout);
  const resolved = outputRecords.find((record) => record.kind === "resolved-packages");
  console.info("[S0 resolved packages] " + JSON.stringify(resolved));
  expect(resolved).toEqual({ kind: "resolved-packages", serverRoot, ...expectedPackages });
  if (child.timedOut || child.code !== 0) {
    throw new Error(`isolated Undici process failed (exit=${child.code}, signal=${child.signal}, timeout=${child.timedOut})\n${child.stdout}\n${child.stderr}`);
  }
  const result = outputRecords.find((record) => record.kind === "result");
  expect(result).toEqual({ kind: "result", malformedFailed: true, healthyStatus: 200, dispatcherClosed: true, serverClosed: true });
}, 9_000);
