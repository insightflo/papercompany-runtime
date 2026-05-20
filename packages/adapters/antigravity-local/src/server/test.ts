import path from "node:path";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asBoolean,
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { buildAntigravityArgs, extractLatestAntigravityResponse } from "./execute.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({ code: "antigravity_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({ code: "antigravity_command_resolvable", level: "info", message: `Command is executable: ${command}` });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe = checks.every(
    (check) => check.code !== "antigravity_cwd_invalid" && check.code !== "antigravity_command_unresolvable",
  );
  if (canRunProbe) {
    if (!commandLooksLike(command, "agy")) {
      checks.push({
        code: "antigravity_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `agy`.",
        detail: command,
      });
    } else {
      const printTimeout = asString(config.printTimeout, "180s");
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const args = buildAntigravityArgs({
        cwd,
        prompt: "Reply with exactly one line: AGY_SMOKE_OK",
        printTimeout,
        bypassPermissions: asBoolean(config.bypassPermissions, false),
        sandbox: asBoolean(config.sandbox, false),
        sessionId: null,
        extraArgs,
      });
      const probe = await runChildProcess(`antigravity-envtest-${Date.now()}`, command, args, {
        cwd,
        env,
        timeoutSec: 180,
        graceSec: 5,
        onLog: async () => {},
      });
      const summary = extractLatestAntigravityResponse(probe.stdout);
      if (probe.timedOut) {
        checks.push({ code: "antigravity_hello_probe_timed_out", level: "warn", message: "Antigravity hello probe timed out." });
      } else if ((probe.exitCode ?? 1) === 0 && /AGY_SMOKE_OK/.test(summary)) {
        checks.push({ code: "antigravity_hello_probe_passed", level: "info", message: "Antigravity hello probe succeeded." });
      } else {
        checks.push({
          code: "antigravity_hello_probe_failed",
          level: "warn",
          message: "Antigravity CLI did not return the expected hello probe output.",
          detail: extractLatestAntigravityResponse(probe.stderr) || summary,
          hint: "Run `agy --print-timeout 180s --print 'Reply with exactly one line: AGY_SMOKE_OK'` manually to inspect auth and CLI behavior.",
        });
      }
    }
  }

  return { adapterType: "antigravity_local", status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
