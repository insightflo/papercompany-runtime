import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import { activityLog, companies, companySecrets, companySecretVersions, createDb, toolDefinitions, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCoreWorkflowTool } from "../services/workflow/core-tool-executor.js";
import { secretService } from "../services/secrets.js";
import { toolDefinitionRoutes } from "../routes/tool-definitions.js";
import { errorHandler } from "../middleware/index.js";

const root = path.resolve("data/security-check/probes");
describe("tool env secrets (real DB and child process)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let companyId: string;
  let otherCompanyId: string;
  let toolId: string;
  let secretId: string;
  let marker: string;
  beforeAll(async () => {
    await mkdir(root, { recursive: true });
    tempDb = await startEmbeddedPostgresTestDatabase("tool-env-secrets-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "0".repeat(64));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(root, "unused-master.key"));
    companyId = randomUUID(); otherCompanyId = randomUUID(); toolId = randomUUID();
    marker = path.join(root, toolId);
    await db.insert(companies).values([
      { id: companyId, name: "Tool env test", issuePrefix: companyId },
      { id: otherCompanyId, name: "Other company", issuePrefix: otherCompanyId },
    ]);
    secretId = (await secretService(db).create(companyId, {
      name: "tool-test", provider: "local_encrypted", value: "synthetic-tool-token",
    })).id;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(toolDefinitions);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
    await rm(marker, { force: true });
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });
  const config = (env: Record<string, unknown>) => ({
    command: `${process.execPath} ${path.resolve("server/src/__tests__/fixtures/tool-env-probe.mjs")}`,
    env: { TEST_LAUNCH_MARKER: marker, ...env },
  });
  async function execute(env: Record<string, unknown>) {
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "env-probe",
      adapterType: "builtin", adapterConfig: config(env) });
    return executeCoreWorkflowTool({ db, companyId, toolName: "env-probe", parameters: {},
      requestId: randomUUID(), stepEnv: { STEP_VALUE: "step" } });
  }
  it("decrypts secret refs, preserves plain bindings/precedence, excludes inherited master env", async () => {
    const result = await execute({
      CLOUDFLARE_API_KEY: { type: "secret_ref", secretId, version: "latest" },
      LEGACY_TEXT: "unchanged legacy text", PLAIN_TEXT: { type: "plain", value: "explicit plain text" },
      STEP_VALUE: "configured",
    });
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ resolved: true, legacy: true, plain: true,
      masterKeyAbsent: true, masterFileAbsent: true, stepPrecedence: true });
  });
  it.each(["foreign", "missing", "invalid"])("rejects %s binding without launching", async (kind) => {
    const foreignId = (await secretService(db).create(otherCompanyId, {
      name: "foreign", provider: "local_encrypted", value: "synthetic-tool-token",
    })).id;
    const binding = kind === "invalid" ? { type: "plain", value: {} }
      : { type: "secret_ref", secretId: kind === "foreign" ? foreignId : randomUUID() };
    const result = await execute({ CLOUDFLARE_API_KEY: binding });
    expect(result.status).toBe(422);
    expect(result.body.error?.includes("CLOUDFLARE_API_KEY")).toBe(true);
    expect(result.body.error?.includes("synthetic-tool-token")).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
  async function migrate(apply: boolean) {
    return promisify(execFile)(process.execPath, ["--import", path.resolve("cli/node_modules/tsx/dist/loader.mjs"),
      path.resolve("scripts/migrate-tool-env-secrets.ts"), "--tool-name", "migration-probe", ...(apply ? ["--apply"] : [])],
    { env: { ...process.env, DATABASE_URL: tempDb.connectionString } });
  }
  it("migration CLI dry-run writes nothing, apply encrypts, and existing names rotate", async () => {
    const env = { CLOUDFLARE_API_KEY: "synthetic-tool-token", NORMAL: "ordinary" };
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "migration-probe",
      adapterType: "builtin", adapterConfig: config(env) });
    const name = `tool_${toolId.slice(0, 8)}_cloudflare_api_key`;
    const secrets = secretService(db);
    const dry = await migrate(false);
    expect(dry.stdout.includes("synthetic-tool-token")).toBe(false);
    expect(await secrets.getByName(companyId, name)).toBeNull();
    const created = await migrate(true);
    expect(created.stdout.includes("created 1 secrets")).toBe(true);
    const existing = (await secrets.getByName(companyId, name))!;
    await db.update(toolDefinitions).set({ adapterConfig: config(env) }).where(eq(toolDefinitions.id, toolId));
    const applied = await migrate(true);
    expect(applied.stdout.includes("synthetic-tool-token")).toBe(false);
    const [stored] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    const storedEnv = stored.adapterConfig.env as Record<string, unknown>;
    expect(storedEnv.CLOUDFLARE_API_KEY).toEqual({ type: "secret_ref", secretId: existing.id, version: "latest" });
    expect(storedEnv.NORMAL).toBe("ordinary");
    expect((await secrets.getById(existing.id))?.latestVersion).toBe(2);
    expect(await secrets.resolveSecretValue(companyId, existing.id, "latest") === "synthetic-tool-token").toBe(true);
    expect((await migrate(true)).stdout.includes("Updated 0 tools")).toBe(true);
  }, 60_000); // spawns the migration CLI four times; slow under parallel suite load
  it("migration transaction rolls back secret creation when a later binding fails", async () => {
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "migration-probe",
      adapterType: "builtin", adapterConfig: config({ API_KEY: "synthetic", PASSWORD: "synthetic" }) });
    await db.insert(companySecrets).values({ companyId, name: `tool_${toolId.slice(0, 8)}_password`,
      provider: "unsupported-test-provider", latestVersion: 1 });
    const failure = await migrate(true).then(() => null, (error: { stderr: string; code: number }) => error);
    expect(failure?.code).toBe(1);
    expect(failure?.stderr.includes('"failed":1')).toBe(true);
    expect(failure?.stderr.includes("synthetic")).toBe(false);
    expect(await secretService(db).getByName(companyId, `tool_${toolId.slice(0, 8)}_api_key`)).toBeNull();
    const [stored] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    expect(typeof (stored.adapterConfig.env as Record<string, unknown>).API_KEY).toBe("string");
  });
  function app(strictSecretsMode = false) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "test-board", companyIds: [companyId], source: "session" } as never;
      next();
    });
    app.use("/api", toolDefinitionRoutes(db, { strictSecretsMode }));
    app.use(errorHandler); return app;
  }
  const toolsPath = () => `/api/companies/${companyId}/tools`;
  it("masks POST/GET/PATCH only, preserving refs and stored plain values", async () => {
    const env = { CLOUDFLARE_API_TOKEN: "synthetic-tool-token",
      GITHUB_TOKEN: { type: "plain", value: "synthetic-tool-token" },
      SLACK_BOT_TOKEN: { type: "secret_ref", secretId, version: "latest" }, CLOUDFLARE_ACCOUNT_ID: "account" };
    const server = app();
    const created = await request(server).post(toolsPath()).send({ name: "http-probe",
      adapterType: "builtin", adapterConfig: config(env) });
    expect(created.status).toBe(201);
    const list = await request(server).get(toolsPath());
    const patched = await request(server).patch(`${toolsPath()}/${created.body.id}`).send({ adapterConfig: config(env) });
    expect(patched.status).toBe(200);
    for (const tool of [created.body, list.body[0], patched.body]) {
      expect(JSON.stringify(tool.adapterConfig.env.CLOUDFLARE_API_TOKEN) === JSON.stringify({ type: "plain", value: "***REDACTED***" })).toBe(true);
      expect(JSON.stringify(tool.adapterConfig.env.GITHUB_TOKEN) === JSON.stringify({ type: "plain", value: "***REDACTED***" })).toBe(true);
      expect(tool.adapterConfig.env.SLACK_BOT_TOKEN).toEqual(env.SLACK_BOT_TOKEN);
      expect(tool.adapterConfig.env.CLOUDFLARE_ACCOUNT_ID).toEqual({ type: "plain", value: "account" });
    }
    const [stored] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, created.body.id));
    const storedEnv = stored.adapterConfig.env as Record<string, { value: string }>;
    expect(storedEnv.CLOUDFLARE_API_TOKEN.value === "synthetic-tool-token").toBe(true);
    for (const adapterConfig of [created.body.adapterConfig, config({ CLOUDFLARE_API_TOKEN: "***REDACTED***" })]) {
      const roundtrip = await request(server).patch(`${toolsPath()}/${created.body.id}`).send({ adapterConfig });
      expect(roundtrip.status).toBe(422);
      const [unchanged] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, created.body.id));
      expect(isDeepStrictEqual(unchanged, stored)).toBe(true);
    }
  });
  it("masks legacy string token bindings on GET without changing the DB", async () => {
    const adapterConfig = config({ CLOUDFLARE_API_TOKEN: "synthetic-tool-token",
      GITHUB_TOKEN: { type: "plain", value: "synthetic-tool-token" },
      SLACK_BOT_TOKEN: { type: "secret_ref", secretId, version: "latest" }, CLOUDFLARE_ACCOUNT_ID: "account" });
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "legacy-probe",
      adapterType: "builtin", adapterConfig });
    const list = await request(app()).get(toolsPath());
    expect(list.status).toBe(200);
    expect(list.body[0].adapterConfig.env.CLOUDFLARE_API_TOKEN === "***REDACTED***").toBe(true);
    expect(list.body[0].adapterConfig.env.GITHUB_TOKEN.value === "***REDACTED***").toBe(true);
    expect(list.body[0].adapterConfig.env.SLACK_BOT_TOKEN).toEqual((adapterConfig.env as Record<string, unknown>).SLACK_BOT_TOKEN);
    expect(list.body[0].adapterConfig.env.CLOUDFLARE_ACCOUNT_ID).toBe("account");
    const [stored] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    expect(isDeepStrictEqual(stored.adapterConfig, adapterConfig)).toBe(true);
  });
  it.each([false, true])("rejects placeholders and strict inline values for POST/PATCH (strict=%s)", async (strict) => {
    await db.insert(toolDefinitions).values({ id: toolId, companyId, name: "existing",
      adapterType: "builtin", adapterConfig: {} });
    for (const value of strict ? ["***REDACTED***", "synthetic-tool-token"] : ["***REDACTED***", { type: "plain", value: "***REDACTED***" }]) {
      const server = app(strict);
      const payload = { name: "new", adapterType: "builtin", adapterConfig: { env: { API_KEY: value } } };
      expect((await request(server).post(toolsPath()).send(payload)).status).toBe(422);
      expect((await request(server).patch(`${toolsPath()}/${toolId}`).send(payload)).status).toBe(422);
    }
    const [stored] = await db.select().from(toolDefinitions).where(eq(toolDefinitions.id, toolId));
    expect(stored.adapterConfig).toEqual({});
  });
});
