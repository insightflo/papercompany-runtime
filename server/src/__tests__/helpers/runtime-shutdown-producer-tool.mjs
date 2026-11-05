import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Native process-adapter producer for the P6 runtime-shutdown matrix.
// The production heartbeat path (adapters/process/execute.ts) spawns this script for the
// distinct producer agent. It really produces the selected work product, records its
// PID/nonce/agent identity for the parent's proof chain, then blocks on an explicit
// release gate so the parent can verify the live process before registering/completing.
// Nothing is fabricated: exit code 0 happens only after the gate file appears, and a
// bounded max wait fails the process instead of hanging the matrix.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const outDir = required("RUNTIME_SHUTDOWN_PRODUCER_OUT");
const fileName = required("RUNTIME_SHUTDOWN_PRODUCER_FILE");
const recordFile = required("RUNTIME_SHUTDOWN_PRODUCER_RECORD");
const gateFile = required("RUNTIME_SHUTDOWN_PRODUCER_GATE");
const nonce = required("RUNTIME_SHUTDOWN_PRODUCER_NONCE");
const maxWaitMs = Number(process.env.RUNTIME_SHUTDOWN_PRODUCER_MAX_WAIT_MS ?? "240000");

const record = (event, extra = {}) => appendFileSync(recordFile, JSON.stringify({
  schemaVersion: "runtime-shutdown-producer-tool.v1",
  event,
  nonce,
  pid: process.pid,
  agentId: process.env.PAPERCLIP_AGENT_ID ?? "",
  companyId: process.env.PAPERCLIP_COMPANY_ID ?? "",
  ...extra,
}) + "\n");

record("started");
mkdirSync(outDir, { recursive: true });
const content = path.join(outDir, fileName);
writeFileSync(content, JSON.stringify({ title: "Native producer proof", body: nonce, producerPid: process.pid }) + "\n");
record("produced", { content });

const deadline = Date.now() + maxWaitMs;
while (!existsSync(gateFile)) {
  if (Date.now() > deadline) {
    record("gate-timeout");
    process.exit(1);
  }
  await delay(10);
}
record("completed");
