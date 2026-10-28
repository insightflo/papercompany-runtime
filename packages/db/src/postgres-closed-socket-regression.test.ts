import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net, { type Socket } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const childScript = `
import { pathToFileURL } from "node:url";
const postgres = (await import(pathToFileURL(process.argv[1]).href)).default;
const sql = postgres(process.argv[2], { max: 1, connect_timeout: 5 });
const reserved = await sql.reserve();
await reserved\`select 1\`;
console.log("READY");
await new Promise((resolve) => process.stdin.once("data", resolve));
const code = await reserved\`select 1\`.then(() => "UNEXPECTED_SUCCESS", (error) => error.code);
console.log("RESULT:" + code);
reserved.release();
await sql.end({ timeout: 0 });
`;

let database: EmbeddedPostgresTestDatabase | undefined;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("postgres-closed-socket-");
}, 120_000);

afterAll(async () => {
  await database?.cleanup();
});

async function listen(server: net.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Proxy port was not allocated"));
      else resolve(address.port);
    });
  });
}

async function runClosedSocketProbe(modulePath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const target = new URL(database!.connectionString);
  const downstream = new Set<Socket>();
  const proxy = net.createServer((client) => {
    downstream.add(client);
    client.once("close", () => downstream.delete(client));
    const upstream = net.connect(Number(target.port), target.hostname);
    client.pipe(upstream).pipe(client);
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  const proxyUrl = new URL(database!.connectionString);
  proxyUrl.port = String(proxyPort);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript, modulePath, proxyUrl.toString()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

  try {
    const readyDeadline = Date.now() + 15_000;
    while (!stdout.includes("READY") && Date.now() < readyDeadline) await delay(20);
    if (!stdout.includes("READY")) throw new Error(`Probe did not become ready: ${stderr}`);
    for (const socket of downstream) socket.destroy();
    await delay(100);
    child.stdin.write("\n");
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Probe did not exit")), 15_000);
      child.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    return { code, stdout, stderr };
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

describe("patched postgres closed-socket writes", () => {
  it("rejects ESM and CJS reserved queries without an uncaught process crash", async () => {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(dirname(dirname(require.resolve("postgres"))));
    for (const modulePath of [join(packageRoot, "src/index.js"), join(packageRoot, "cjs/src/index.js")]) {
      const result = await runClosedSocketProbe(modulePath);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("RESULT:CONNECTION_CLOSED");
      expect(result.stderr).not.toContain("Cannot read properties of null");
    }
  }, 30_000);
});
