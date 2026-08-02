import fs from "node:fs/promises";

/**
 * Shared fixtures for commandcode execute tests. Extracted from
 * execute.test.ts so the suite and any focused sibling suites can reuse the
 * fake-cmd harness without duplicating it (and to keep each file under 300 lines).
 */

export interface FakeCmdOptions {
  /** NDJSON lines to print to stdout. */
  lines?: string[];
  /** Process exit code. */
  exitCode?: number;
}

export async function writeFakeCmd(commandPath: string, options: FakeCmdOptions = {}): Promise<void> {
  const lines = options.lines ?? [];
  const exitCode = options.exitCode ?? 0;
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({ argv }, null, 2), 'utf8');
}
const lines = ${JSON.stringify(lines)};
for (const line of lines) {
  console.log(line);
}
process.exit(${exitCode});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

export function buildCtx(
  config: Record<string, unknown>,
  opts: { command: string; cwd: string; capture: string; runtime?: Record<string, unknown> },
) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Cmd Coder", adapterType: "commandcode_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null, ...(opts.runtime ?? {}) },
    config: { command: opts.command, cwd: opts.cwd, env: { PAPERCLIP_TEST_CAPTURE_PATH: opts.capture }, promptTemplate: "do the work", ...config },
    context: {},
    authToken: undefined,
    onLog: async () => {},
    onMeta: async () => {},
  };
}

export type CapturePayload = { argv: string[] };

export function resultFrame(extra: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", ...extra });
}
