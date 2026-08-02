import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { discoverCommandCodeModelsCached } from "./models.js";
import { sanitizeCommandCodeExtraArgs } from "./env.js";
import { parseCommandCodeJsonl } from "./parse.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api\s*key|invalid\s*api\s*key|not\s+logged\s+in|login\s+required|no\s+credits?|usage\s+limit|rate?\s*limit)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "cmd");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({ code: "commandcode_cwd_valid", level: "info", message: `Working directory is valid: ${cwd}` });
  } catch (err) {
    checks.push({
      code: "commandcode_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = normalizeEnv(config.env);
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));
  const cwdInvalid = checks.some((c) => c.code === "commandcode_cwd_invalid");

  if (cwdInvalid) {
    checks.push({
      code: "commandcode_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({ code: "commandcode_command_resolvable", level: "info", message: `Command is executable: ${command}` });
    } catch (err) {
      checks.push({
        code: "commandcode_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canProbe = checks.every(
    (c) => c.code !== "commandcode_cwd_invalid" && c.code !== "commandcode_command_unresolvable",
  );

  if (canProbe) {
    try {
      const discovered = await discoverCommandCodeModelsCached({ command, cwd, env: runtimeEnv });
      if (discovered.length > 0) {
        checks.push({
          code: "commandcode_models_discovered",
          level: "info",
          message: `Discovered ${discovered.length} model(s) from Command Code.`,
        });
      } else {
        checks.push({
          code: "commandcode_models_empty",
          level: "warn",
          message: "Command Code returned no models.",
          hint: "Run `cmd --list-models` and verify authentication (`cmd status`).",
        });
      }
    } catch (err) {
      checks.push({
        code: "commandcode_models_discovery_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Command Code model discovery failed.",
        hint: "Run `cmd --list-models` manually to verify auth and config.",
      });
    }
  }

  const configuredModel = asString(config.model, "").trim();
  if (configuredModel && canProbe) {
    try {
      const discovered = await discoverCommandCodeModelsCached({ command, cwd, env: runtimeEnv });
      const exists = discovered.some((m: { id: string }) => m.id === configuredModel);
      checks.push({
        code: exists ? "commandcode_model_configured" : "commandcode_model_not_found",
        level: exists ? "info" : "warn",
        message: exists
          ? `Configured model: ${configuredModel}`
          : `Configured model "${configuredModel}" not found in available models.`,
        hint: exists ? undefined : "Run `cmd --list-models` and choose a currently available model id.",
      });
    } catch {
      checks.push({ code: "commandcode_model_configured", level: "info", message: `Configured model: ${configuredModel}` });
    }
  }

  // Hello probe — exercises a real -p run. This performs a model call, so it is
  // the strongest signal that auth, model, and permissions are all wired up.
  if (canProbe && configuredModel) {
    const extraArgs = sanitizeCommandCodeExtraArgs(asStringArray(config.extraArgs)).args;
    const args = [
      "-p",
      "Respond with hello.",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--permission-mode",
      "auto-accept",
      "--trust",
      "--no-auto-update",
      "--model",
      configuredModel,
    ];
    if (asString(config.effort, "").trim()) args.push("--effort", asString(config.effort, "").trim());
    if (extraArgs.length > 0) args.push(...extraArgs);

    try {
      const probe = await runChildProcess(
        `commandcode-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        { cwd, env: runtimeEnv, timeoutSec: 60, graceSec: 5, onLog: async () => {} },
      );
      const parsed = parseCommandCodeJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
      const evidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({ code: "commandcode_hello_probe_timed_out", level: "warn", message: "Command Code hello probe timed out." });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
        const summary = (parsed.finalMessage || parsed.messages.join(" ")).trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "commandcode_hello_probe_passed" : "commandcode_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello ? "Command Code hello probe succeeded." : "Command Code probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
        });
      } else if (AUTH_REQUIRED_RE.test(evidence)) {
        checks.push({
          code: "commandcode_hello_probe_auth_required",
          level: "warn",
          message: "Command Code is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `cmd login` / `cmd status` and verify credits, then retry.",
        });
      } else {
        checks.push({
          code: "commandcode_hello_probe_failed",
          level: "error",
          message: "Command Code hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `cmd -p \"Respond with hello.\" --output-format json` manually to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "commandcode_hello_probe_failed",
        level: "error",
        message: "Command Code hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
