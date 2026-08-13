import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMigrationConnection } from "./migration-runtime.js";
import {
  exportAgentApiKeyResponsibilityReport,
  type AgentApiKeyResponsibilityRequestedMode,
} from "./agent-api-key-responsibility-report.js";

export type AgentApiKeyResponsibilityReportCliDependencies = {
  resolveConnection: typeof resolveMigrationConnection;
  exportReport: typeof exportAgentApiKeyResponsibilityReport;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
};

const defaultDependencies: AgentApiKeyResponsibilityReportCliDependencies = {
  resolveConnection: resolveMigrationConnection,
  exportReport: exportAgentApiKeyResponsibilityReport,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
};

function parseMode(args: string[]): AgentApiKeyResponsibilityRequestedMode {
  if (args.length === 0) return "auto";
  if (args.length !== 2 || args[0] !== "--mode") {
    throw new Error("Usage: report:agent-api-key-responsibility [--mode auto|preview|stored]");
  }
  const mode = args[1];
  if (mode !== "auto" && mode !== "preview" && mode !== "stored") {
    throw new Error("Usage: report:agent-api-key-responsibility [--mode auto|preview|stored]");
  }
  return mode;
}

export async function runAgentApiKeyResponsibilityReportCli(
  args: string[],
  deps: AgentApiKeyResponsibilityReportCliDependencies = defaultDependencies,
): Promise<number> {
  let resolved: Awaited<ReturnType<typeof resolveMigrationConnection>> | undefined;
  let exitCode = 0;
  try {
    const mode = parseMode(args);
    resolved = await deps.resolveConnection();
    const report = await deps.exportReport(resolved.connectionString, mode);
    deps.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    deps.writeStderr("Failed to export agent API-key responsibility report. Check the mode and database connection.\n");
    exitCode = 1;
  } finally {
    if (resolved) {
      try {
        await resolved.stop();
      } catch {
        deps.writeStderr("Failed to stop the temporary database connection.\n");
        exitCode = 1;
      }
    }
  }
  return exitCode;
}

const isEntryPoint = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntryPoint) {
  process.exitCode = await runAgentApiKeyResponsibilityReportCli(process.argv.slice(2));
}
