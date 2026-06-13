import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PAPERCLIP_REQUIRED_NODE_MAJOR = 24;
const expectedNodeModuleVersionsByMajor = new Map([
  [24, "137"],
]);

const defaultCrashReportDirs = [
  path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"),
  path.join(path.sep, "Library", "Logs", "DiagnosticReports"),
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeErrorPayload(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

export function resolveDevRunnerDiagnosticsPaths(repoRoot, env = process.env) {
  const logDir = env.PAPERCLIP_DEV_RUNNER_LOG_DIR?.trim()
    ? path.resolve(env.PAPERCLIP_DEV_RUNNER_LOG_DIR.trim())
    : path.join(repoRoot, ".paperclip");

  return {
    logDir,
    eventLogPath: path.join(logDir, "dev-runner-events.ndjson"),
    childLogPath: path.join(logDir, "dev-runner-child.log"),
  };
}

export function appendDevRunnerEvent(eventLogPath, eventName, payload = {}) {
  const event = {
    ts: new Date().toISOString(),
    event: eventName,
    ...asObject(payload),
  };

  mkdirSync(path.dirname(eventLogPath), { recursive: true });
  appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function evaluateNodeRuntime(options = {}) {
  const requiredMajor = Number.isFinite(options.requiredMajor)
    ? options.requiredMajor
    : PAPERCLIP_REQUIRED_NODE_MAJOR;
  const nodeVersion = String(options.nodeVersion ?? process.version);
  const nodeModuleVersion = String(options.nodeModuleVersion ?? process.versions.modules ?? "");
  const currentMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  const expectedNodeModuleVersion = expectedNodeModuleVersionsByMajor.get(requiredMajor) ?? null;

  if (!Number.isFinite(currentMajor)) {
    return {
      ok: false,
      currentMajor: null,
      expectedNodeModuleVersion,
      message: `Unable to parse Node version ${nodeVersion}. Paperclip dev expects Node ${requiredMajor}.`,
    };
  }

  if (currentMajor !== requiredMajor) {
    const expectedAbiText = expectedNodeModuleVersion ? ` / NODE_MODULE_VERSION ${expectedNodeModuleVersion}` : "";
    return {
      ok: false,
      currentMajor,
      expectedNodeModuleVersion,
      message: [
        `Paperclip dev must run on Node ${requiredMajor}${expectedAbiText}.`,
        `Current runtime is ${nodeVersion} / NODE_MODULE_VERSION ${nodeModuleVersion}.`,
        "The server depends on the native re2 module; switching Node major versions without rebuilding re2 causes ABI mismatch build/runtime failures.",
        `Run \`nvm use\` in the repo root, then rebuild re2 only if node_modules was compiled under another Node:`,
        "`npm run rebuild --prefix node_modules/.pnpm/re2@1.24.0/node_modules/re2`",
      ].join(" "),
    };
  }

  if (expectedNodeModuleVersion && nodeModuleVersion !== expectedNodeModuleVersion) {
    return {
      ok: false,
      currentMajor,
      expectedNodeModuleVersion,
      message: [
        `Paperclip dev expected Node ${requiredMajor} to report NODE_MODULE_VERSION ${expectedNodeModuleVersion}.`,
        `Current runtime is ${nodeVersion} / NODE_MODULE_VERSION ${nodeModuleVersion}.`,
        "Reinstall or rebuild the active Node runtime and native modules before starting dev.",
      ].join(" "),
    };
  }

  return {
    ok: true,
    currentMajor,
    expectedNodeModuleVersion,
    message: null,
  };
}

export function findRecentNodeCrashReports(options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : Date.now() - 10 * 60 * 1000;
  const limit = Number.isFinite(options.limit) ? options.limit : 5;
  const dirs = Array.isArray(options.dirs) ? options.dirs : defaultCrashReportDirs;
  const reports = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^node.*\.(ips|crash)$/i.test(name)) continue;
      const filePath = path.join(dir, name);
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }
      if (stats.mtimeMs < sinceMs) continue;
      reports.push({
        path: filePath,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }
  }

  return reports
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, limit);
}

export function createDevRunnerDiagnostics(options) {
  const repoRoot = options.repoRoot;
  const env = options.env ?? process.env;
  const paths = resolveDevRunnerDiagnosticsPaths(repoRoot, env);

  mkdirSync(paths.logDir, { recursive: true });

  function logEvent(eventName, payload = {}) {
    try {
      return appendDevRunnerEvent(paths.eventLogPath, eventName, payload);
    } catch (error) {
      process.stderr.write(`[paperclip] failed to write dev-runner diagnostics: ${safeErrorPayload(error).message}\n`);
      return null;
    }
  }

  function openChildLogStream(headerPayload = {}) {
    mkdirSync(paths.logDir, { recursive: true });
    const stream = createWriteStream(paths.childLogPath, { flags: "a" });
    stream.write(
      `\n[${new Date().toISOString()}] ${JSON.stringify({
        event: "server_child_output_start",
        ...asObject(headerPayload),
      })}\n`,
    );
    return stream;
  }

  return {
    ...paths,
    findRecentNodeCrashReports,
    logEvent,
    openChildLogStream,
    safeErrorPayload,
  };
}
