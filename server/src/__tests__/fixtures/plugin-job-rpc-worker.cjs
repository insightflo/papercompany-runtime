const readline = require("node:readline");

const pending = new Map();
let starts = 0;
let toolStarts = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const response = (id, result) => send({ jsonrpc: "2.0", id, result });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    response(message.id, { ok: true, supportedMethods: ["runJob"] });
  } else if (message.method === "runJob") {
    starts += 1;
    pending.set(message.params.job.runId, message.id);
    send({ jsonrpc: "2.0", method: "streams.emit", params: {
      channel: "fixture", companyId: "fixture", event: "started", runId: message.params.job.runId, starts,
    } });
  } else if (message.method === "executeTool") {
    toolStarts += 1;
    const runId = message.params.runContext.runId;
    pending.set(`tool:${runId}`, message.id);
    send({ jsonrpc: "2.0", method: "streams.emit", params: {
      channel: "fixture", companyId: "fixture", event: "tool-started", runId, starts: toolStarts,
    } });
  } else if (message.method === "fixture.tool-release") {
    const key = `tool:${message.params.runId}`;
    const id = pending.get(key);
    if (id === undefined) return;
    pending.delete(key);
    if (message.params.error) send({ jsonrpc: "2.0", id, error: message.params.error });
    else response(id, message.params.result);
  } else if (message.method === "fixture.host-call") {
    send({ jsonrpc: "2.0", id: "fixture-host", method: "state.get", params: { scopeKind: "instance", stateKey: "held" } });
  } else if (message.id === "fixture-host" && !message.method) {
    send({ jsonrpc: "2.0", method: "streams.emit", params: {
      channel: "fixture", companyId: "fixture", event: "host-response", result: message.result, error: message.error,
    } });
  } else if (message.method === "health") {
    response(message.id, { status: "ok" });
  } else if (message.method === "fixture.release") {
    const id = pending.get(message.params.runId);
    pending.delete(message.params.runId);
    if (message.params.error) {
      send({ jsonrpc: "2.0", id, error: { code: message.params.code, message: message.params.error } });
    } else {
      response(id, null);
    }
    send({ jsonrpc: "2.0", method: "streams.emit", params: {
      channel: "fixture", companyId: "fixture", event: "released", runId: message.params.runId,
    } });
  } else if (message.method === "fixture.crash") {
    process.exit(17);
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", method: "streams.emit", params: { channel: "fixture", companyId: "fixture", event: "shutdown" } });
    response(message.id, null);
    setImmediate(() => process.exit(0));
  }
});
