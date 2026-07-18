#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { KST_CRON_EXPRESSIONS, buildWorkflow } from "./workflow-definition.mjs";

const WORKFLOW_NAME = "Gazua - Market Pulse 30m Collect and A1 Sync";
const DEFAULT_N8N_URL = "https://n8n-auto.showk.ing";
const DEFAULT_API_KEY_FILE = "~/.config/papercompany/n8n-api-key";
const CREDENTIAL_NAMES = ["papercompany-minio-n8n", "papercompany-gazua-webhook", "gazua-a1-market-pulse-ingest"];
const WORKFLOW_URLS = [
  "https://gazua.showk.ing/api/internal/market-pulse/ingest",
  "https://gazua.showk.ing/api/market-pulse",
];

function required(env, key) {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(key + " is required");
  return value;
}

function expandHome(path) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

export function readSyncConfig(env, { readFile = readFileSync } = {}) {
  const apiKeyFile = expandHome(String(env.N8N_API_KEY_FILE ?? DEFAULT_API_KEY_FILE).trim());
  const apiKey = String(readFile(apiKeyFile, "utf8")).trim();
  if (!apiKey) throw new Error("N8N_API_KEY_FILE contained an empty API key");
  const connectPortText = String(env.N8N_CONNECT_PORT ?? "").trim();
  const connectPort = connectPortText ? Number(connectPortText) : null;
  if (connectPortText && (!Number.isInteger(connectPort) || connectPort < 1 || connectPort > 65_535)) throw new Error("N8N_CONNECT_PORT must be a valid TCP port");
  const n8nUrl = String(env.N8N_URL ?? DEFAULT_N8N_URL).trim().replace(/\/$/u, "");
  try { new URL(n8nUrl); } catch { throw new Error("N8N_URL must be an absolute URL"); }
  return {
    n8nUrl,
    connectHost: String(env.N8N_CONNECT_HOST ?? "").trim() || null,
    connectPort,
    apiKey,
    minioCredentialId: required(env, "N8N_MINIO_CREDENTIAL_ID"),
    webhookCredentialId: required(env, "N8N_GAZUA_WEBHOOK_CREDENTIAL_ID"),
    a1CredentialId: required(env, "N8N_GAZUA_A1_CREDENTIAL_ID"),
  };
}

async function tunnelRequest(target, options, config) {
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    const request = requestImpl({
      protocol: target.protocol,
      hostname: config.connectHost ?? target.hostname,
      port: config.connectPort ?? (target.port || (target.protocol === "https:" ? 443 : 80)),
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
      path: target.pathname + target.search,
      method: options.method,
      headers: { Host: target.host, ...options.headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(30_000, () => request.destroy(new Error("n8n API request timed out")));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function api(config, path, { method = "GET", body } = {}) {
  const target = new URL(path, config.n8nUrl + "/");
  const headers = { "X-N8N-API-KEY": config.apiKey, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const serialized = body === undefined ? null : JSON.stringify(body);
  let status;
  let responseBody;
  if (config.connectHost || config.connectPort) {
    ({ status, body: responseBody } = await tunnelRequest(target, { method, headers, body: serialized }, config));
  } else {
    const response = await fetch(target, { method, headers, body: serialized });
    status = response.status;
    responseBody = await response.text();
  }
  if (status < 200 || status >= 300) throw new Error(method + " " + target.pathname + " failed (" + status + "): " + responseBody.slice(0, 800));
  return responseBody ? JSON.parse(responseBody) : null;
}

function writableWorkflow(workflow, prior) {
  const settings = {
    executionOrder: workflow.settings.executionOrder,
    timezone: workflow.settings.timezone,
    availableInMCP: workflow.settings.availableInMCP,
  };
  if (prior?.settings && Object.hasOwn(prior.settings, "errorWorkflow")) settings.errorWorkflow = prior.settings.errorWorkflow;
  return { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings };
}

export async function applyWorkflow(config, { request = api } = {}) {
  const desired = buildWorkflow(config);
  const listing = await request(config, "/api/v1/workflows?limit=250");
  const matches = (listing?.data ?? []).filter((workflow) => workflow.name === WORKFLOW_NAME);
  if (matches.length > 1) throw new Error("More than one exact-name workflow exists; refusing to mutate n8n");
  if (!matches.length) {
    const created = await request(config, "/api/v1/workflows", { method: "POST", body: writableWorkflow(desired) });
    return { workflow: created, created: true };
  }
  const prior = await request(config, "/api/v1/workflows/" + encodeURIComponent(matches[0].id));
  const updated = await request(config, "/api/v1/workflows/" + encodeURIComponent(prior.id), { method: "PUT", body: writableWorkflow(desired, prior) });
  return { workflow: updated, created: false };
}

function preview(config) {
  const workflow = buildWorkflow(config);
  return {
    mode: "preview",
    name: workflow.name,
    nodeCount: workflow.nodes.length,
    scheduleExpressions: KST_CRON_EXPRESSIONS,
    credentialNames: CREDENTIAL_NAMES,
    urls: WORKFLOW_URLS,
  };
}

async function main() {
  const modes = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
  if (modes.length !== 1 || !["--preview", "--apply", "--activate"].includes(modes[0])) throw new Error("Usage: sync-workflow.mjs --preview|--apply|--activate");
  const config = readSyncConfig(process.env);
  if (modes[0] === "--preview") {
    console.log(JSON.stringify(preview(config), null, 2));
    return;
  }
  const result = await applyWorkflow(config);
  if (modes[0] === "--activate") {
    const activated = await api(config, "/api/v1/workflows/" + encodeURIComponent(result.workflow.id) + "/activate", { method: "POST" });
    console.log(JSON.stringify({ name: activated.name ?? result.workflow.name, workflowId: result.workflow.id, created: result.created, active: activated.active ?? true }));
    return;
  }
  console.log(JSON.stringify({ name: result.workflow.name, workflowId: result.workflow.id, created: result.created, active: result.workflow.active ?? false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
