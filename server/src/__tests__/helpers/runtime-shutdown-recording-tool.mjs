import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const pluginMode = process.env.RUNTIME_SHUTDOWN_PLUGIN_MODE;
if (pluginMode === "relay") await runPluginRelay();
else await runRecordingTool(pluginMode === "result");

async function runPluginRelay() {
  const worker = spawn(process.execPath, [process.env.RUNTIME_SHUTDOWN_PLUGIN_FIXTURE_PATH], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const eventFile = process.env.RUNTIME_SHUTDOWN_PLUGIN_EVENTS_FILE;
  const record = (event, extra = {}) => appendFileSync(eventFile, JSON.stringify({
    schemaVersion: "runtime-shutdown-plugin-relay.v1", event, wrapperPid: process.pid, ...extra,
  }) + "\n");
  const requests = new Map();
  let initializeId = null, resultStarted = false, producer = null;
  record("relay-started", { workerPid: worker.pid });
  createInterface({ input: process.stdin }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === "initialize") initializeId = message.id;
      if (message.method === "executeTool") requests.set(String(message.params.runContext.runId), message.params);
    } catch {}
    worker.stdin.write(line + "\n");
  });
  createInterface({ input: worker.stdout }).on("line", (line) => {
    process.stdout.write(line + "\n");
    try {
      const message = JSON.parse(line);
      if (message.id === initializeId && message.result?.ok === true) record("initialized", { workerPid: worker.pid });
      if (message.method !== "streams.emit" || message.params?.event !== "tool-started") return;
      const runId = String(message.params.runId), params = requests.get(runId);
      record("tool-started", { workerPid: worker.pid, runId, starts: message.params.starts });
      if (!params || resultStarted) return;
      resultStarted = true;
      producer = spawn(process.execPath, [process.argv[1]], {
        env: { ...process.env, RUNTIME_SHUTDOWN_PLUGIN_MODE: "result", PAPERCLIP_REQUEST_ID: runId },
        stdio: ["pipe", "pipe", "inherit"],
      });
      record("result-producer-started", { workerPid: worker.pid, resultProducerPid: producer.pid, runId });
      let output = "";
      producer.stdout.on("data", (chunk) => { output += chunk.toString(); });
      producer.stdin.end(JSON.stringify({ runId, parameters: params.parameters }) + "\n");
      producer.once("exit", (code) => {
        if (code !== 0) { record("result-producer-failed", { runId, code }); return; }
        const result = JSON.parse(output.trim());
        worker.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture.tool-release", params: { runId, result } }) + "\n");
        record("worker-release-sent", { workerPid: worker.pid, resultProducerPid: producer.pid, runId });
      });
    } catch (error) { record("relay-error", { error: String(error) }); }
  });
  process.on("SIGTERM", () => { worker.kill("SIGTERM"); producer?.kill("SIGTERM"); });
  worker.once("exit", (code, signal) => {
    record("worker-exit", { workerPid: worker.pid, code, signal });
    record("relay-exit");
    process.exit(code ?? 1);
  });
}

async function runRecordingTool(pluginResult) {
const recordFile = process.env.RUNTIME_SHUTDOWN_RECORD_FILE;
if (!recordFile) throw new Error("RUNTIME_SHUTDOWN_RECORD_FILE is required");
const identity = {
  requestId: process.env.PAPERCLIP_REQUEST_ID ?? "",
  workflowRunId: process.env.PAPERCLIP_WORKFLOW_RUN_ID ?? "",
  stepId: process.env.PAPERCLIP_WORKFLOW_STEP_ID ?? "",
  executionGeneration: Number(process.env.PAPERCLIP_EXECUTION_GENERATION ?? "0"),
  pid: process.pid,
};
const event = (name, extra = {}) => appendFileSync(recordFile, JSON.stringify({
  schemaVersion: "runtime-shutdown-recording-tool.v1", event: name,
  nonce: process.env.RUNTIME_SHUTDOWN_NONCE ?? "", identity, ...extra,
}) + "\n");

const gate = process.env.RUNTIME_SHUTDOWN_GATE_FILE;
const cancelled = process.env.RUNTIME_SHUTDOWN_CANCEL_FILE;
if (pluginResult) {
  const input = JSON.parse(readFileSync(0, "utf8"));
  event("started", { mode: "plugin-result", pluginRunId: input.runId, parameters: input.parameters });
  while (gate && !existsSync(gate)) {
    if (cancelled && existsSync(cancelled)) { event("cancelled", { mode: "plugin-result" }); return; }
    await delay(10);
  }
  const result = { content: "recorded plugin result", data: {
    nonce: process.env.RUNTIME_SHUTDOWN_NONCE ?? "", runId: input.runId, marker: input.parameters?.marker ?? null, producerPid: process.pid,
  } };
  event("completed", { mode: "plugin-result", pluginRunId: input.runId, result });
  writeSync(1, JSON.stringify(result) + "\n");
  return;
}

event("started", { secretResolved: process.env.RUNTIME_SHUTDOWN_SECRET === "shutdown-proof-secret" });
while (gate && !existsSync(gate)) {
  if (cancelled && existsSync(cancelled)) {
    event("cancelled");
    process.exit(0);
  }
  await delay(10);
}

if (process.env.PAPERCOMPANY_ARTIFACT_RESULT_FD === "4") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const args = Object.fromEntries(process.argv.slice(2).reduce((rows, token, index, all) => {
    if (!token.startsWith("--") || index % 2 === 1) return rows;
    rows.push([token.slice(2), all[index + 1]]);
    return rows;
  }, []));
  const bytes = Buffer.from(input.content.base64, "base64");
  const manifest = (input.assets ?? []).map((asset) => {
    const assetBytes = Buffer.from(asset.base64, "base64");
    return { fileName: asset.fileName, sha256: createHash("sha256").update(assetBytes).digest("hex"), byteSize: assetBytes.length };
  });
  const result = {
    schemaVersion: "manual-onboarding.qa.v1", command: "qa", mode: "content", section: null,
    ok: true, checks: [{ id: "recording-process", ok: true }], checkedAt: new Date().toISOString(),
    artifactPath: args.out, contentSha256: createHash("sha256").update(bytes).digest("hex"), assetManifest: manifest,
  };
  writeSync(4, JSON.stringify(result));
}
event("completed");
writeFileSync(1, "recorded\n");
}
