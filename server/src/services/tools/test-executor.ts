/**
 * Tool Test Executor
 *
 * Runs a saved company tool through the same real execution path used in
 * workflows: plugin dispatcher first, then core/HTTP/MCP fallback. Returns a
 * bounded structured outcome suitable for the test dialog. Resolved secret
 * values are never returned — the adapter functions redact secrets in their
 * diagnostic paths, and this executor applies an additional defensive
 * redaction pass over the final outcome.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { ToolTestOutcome } from "@paperclipai/shared";
import type { PluginToolDispatcher } from "../plugin-tool-dispatcher.js";
import { secretService } from "../secrets.js";
import {
  executeCoreWorkflowTool,
  type CoreWorkflowToolExecutionResult,
} from "../workflow/core-tool-executor.js";
import { executeHttpWorkflowTool, redactSecret } from "../workflow/http-tool-adapter.js";
import { executeMcpWorkflowTool } from "../workflow/mcp-tool-adapter.js";
import type { ToolDefinition } from "./types.js";

/** Subset of the live plugin tool dispatcher needed for testing. */
export type ToolTestDispatcher = Pick<PluginToolDispatcher, "getTool" | "executeTool">;

export type ToolTestExecutor = typeof executeToolTest;

export type ToolTestDeps = {
  fetchImpl?: typeof fetch;
  resolveSecretValue?: (
    companyId: string,
    secretId: string,
    version: number | "latest",
  ) => Promise<string>;
};

export type ToolTestInput = {
  db: Db;
  companyId: string;
  tool: ToolDefinition;
  input: Record<string, unknown>;
  deps?: ToolTestDeps;
  dispatcher?: ToolTestDispatcher;
};

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type HeaderAuth = { secretId: string; version: number | "latest" };

function resolveHeaderAuth(auth: unknown): HeaderAuth | null {
  const cfg = readObject(auth);
  if (cfg.type !== "header") return null;
  const secretId = typeof cfg.secretId === "string" && cfg.secretId.trim() ? cfg.secretId.trim() : null;
  if (!secretId) return null;
  const version =
    cfg.version === "latest" || (typeof cfg.version === "number" && cfg.version > 0)
      ? (cfg.version as number | "latest")
      : "latest";
  return { secretId, version };
}

function tryParseContent(content: string | undefined): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function toOutcome(result: CoreWorkflowToolExecutionResult): ToolTestOutcome {
  const ok = result.status === 200;
  const status: ToolTestOutcome["status"] = ok
    ? "success"
    : result.status === 403 || result.status === 422
      ? "failure"
      : "error";
  return {
    ok,
    status,
    httpStatus: result.status,
    error: result.body.error,
    result: result.body.data ?? tryParseContent(result.body.content),
    stderr: result.body.stderr,
  };
}

/** Convert a plugin dispatcher ToolExecutionResult into a bounded test outcome. */
function pluginResultToOutcome(execution: {
  result: { content?: string; data?: unknown; error?: string };
}): ToolTestOutcome {
  const { result } = execution;
  const ok = !result.error;
  return {
    ok,
    status: ok ? "success" : "error",
    httpStatus: ok ? 200 : 500,
    error: result.error,
    result: result.data ?? tryParseContent(result.content),
  };
}

function redactJson(data: unknown, secret: string): unknown {
  if (data === undefined || !secret) return data;
  try {
    return JSON.parse(redactSecret(JSON.stringify(data), secret));
  } catch {
    return data;
  }
}

/** Defensive redaction of any resolved auth secret from the final outcome. */
function redactOutcome(outcome: ToolTestOutcome, secret: string | null): ToolTestOutcome {
  if (!secret) return outcome;
  return {
    ...outcome,
    error: outcome.error ? redactSecret(outcome.error, secret) : outcome.error,
    result: redactJson(outcome.result, secret),
  };
}

async function tryResolveAuthSecret(
  companyId: string,
  adapterConfig: unknown,
  resolveSecretValue: ToolTestDeps["resolveSecretValue"],
): Promise<string | null> {
  const auth = resolveHeaderAuth(readObject(adapterConfig).auth);
  if (!auth || !resolveSecretValue) return null;
  try {
    return await resolveSecretValue(companyId, auth.secretId, auth.version);
  } catch {
    return null;
  }
}

/**
 * Execute a saved tool for board testing. Follows the live workflow execution
 * order: plugin dispatcher first (getTool/executeTool), then core/HTTP/MCP
 * fallback. For HTTP/MCP a temporary step output directory is used so the
 * optional artifact persistence path works outside a workflow run.
 */
export async function executeToolTest(input: ToolTestInput): Promise<ToolTestOutcome> {
  const { db, companyId, tool, input: parameters, deps, dispatcher } = input;
  const requestId = `tool-test-${randomUUID()}`;
  const resolveSecretValue = deps?.resolveSecretValue ?? secretService(db).resolveSecretValue;

  if (tool.companyId !== companyId) {
    return { ok: false, status: "error", httpStatus: 403, error: "Tool does not belong to this company" };
  }
  if (!tool.enabled) {
    return { ok: false, status: "failure", httpStatus: 403, error: `Tool "${tool.name}" is disabled` };
  }

  // 1. Plugin dispatcher first — matches live workflow execution order.
  const registeredPluginTool = dispatcher?.getTool(tool.name) ?? null;
  if (registeredPluginTool && dispatcher) {
    try {
      const execution = await dispatcher.executeTool(tool.name, parameters, {
        agentId: "tool-test",
        runId: requestId,
        companyId,
        projectId: "",
      });
      const authSecret = await tryResolveAuthSecret(companyId, tool.adapterConfig, resolveSecretValue);
      return redactOutcome(pluginResultToOutcome(execution), authSecret);
    } catch (err) {
      return {
        ok: false,
        status: "error",
        httpStatus: 500,
        error: err instanceof Error ? err.message : "Plugin tool execution failed",
      };
    }
  }

  // 2. Core/HTTP/MCP fallback.
  if (tool.adapterType === "builtin") {
    const result = await executeCoreWorkflowTool({
      db,
      companyId,
      toolName: tool.name,
      parameters,
      requestId,
      remoteDeps: deps,
    });
    return toOutcome(result);
  }

  if (tool.adapterType !== "http" && tool.adapterType !== "mcp") {
    return {
      ok: false,
      status: "error",
      httpStatus: 501,
      error: `Unsupported adapter type "${tool.adapterType}"`,
    };
  }

  const authSecretValue = await tryResolveAuthSecret(companyId, tool.adapterConfig, resolveSecretValue);
  const tempDir = await mkdtemp(path.join(tmpdir(), "papercompany-tool-test-"));
  try {
    const adapterInput = {
      companyId,
      toolName: tool.name,
      parameters,
      requestId,
      stepOutputDir: tempDir,
      adapterConfig: readObject(tool.adapterConfig),
    };
    const adapterDeps = { fetchImpl: deps?.fetchImpl, resolveSecretValue };
    const result =
      tool.adapterType === "http"
        ? await executeHttpWorkflowTool(adapterInput, adapterDeps)
        : await executeMcpWorkflowTool(adapterInput, adapterDeps);
    return redactOutcome(toOutcome(result), authSecretValue);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
