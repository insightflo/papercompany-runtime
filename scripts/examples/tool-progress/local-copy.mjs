#!/usr/bin/env node
import { writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";

// Run only on an explicitly supplied, stable input file. Output must not exist.
async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } } });
  const executionId = process.env.PAPERCOMPANY_TOOL_EXECUTION_ID;
  if (!values.input || !values.output || process.env.PAPERCOMPANY_TOOL_PROGRESS_FD !== "3" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executionId ?? "")) {
    throw new Error("example_invalid_input");
  }
  const source = await open(values.input, "r");
  let output;
  try {
    const info = await source.stat(); const total = info.size;
    if (!info.isFile() || !Number.isSafeInteger(total) || total <= 0) throw new Error("example_invalid_input");
    output = await open(values.output, "wx", 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let current = 0; let sequence = 0; let lastSent = -Infinity;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (current + bytesRead > total) throw new Error("example_input_changed");
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) throw new Error("example_write_failed");
        offset += bytesWritten;
      }
      current += bytesRead; // Actual completed writes, not elapsed time or log output.
      const now = performance.now();
      if (now - lastSent >= 1000) {
        const frame = Buffer.from(JSON.stringify({ version: 1, executionId, sequence: ++sequence,
          stage: "copy", unit: "bytes", current, total }) + "\n");
        for (let offset = 0; offset < frame.length;) {
          const written = writeSync(3, frame, offset, frame.length - offset);
          if (!written) throw new Error("example_progress_failed");
          offset += written;
        }
        lastSent = now;
      }
    }
    if (current !== total) throw new Error("example_input_changed");
    await output.sync();
    console.log(JSON.stringify({ bytes: current, output: values.output }));
  } finally {
    try { await output?.close(); } finally { await source.close(); }
  }
}
main().catch(() => { console.error("example_copy_failed"); process.exitCode = 1; });
