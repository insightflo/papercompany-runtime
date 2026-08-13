import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "PAPERCLIP_AGENT_JWT_SECRET";
  const ttlEnv = "PAPERCLIP_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "PAPERCLIP_AGENT_JWT_ISSUER";
  const audienceEnv = "PAPERCLIP_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
    paperclipConfig: process.env.PAPERCLIP_CONFIG,
    instanceId: process.env.PAPERCLIP_INSTANCE_ID,
  };

  let tempDir: string | null = null;

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    delete process.env.PAPERCLIP_INSTANCE_ID;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
    if (originalEnv.paperclipConfig === undefined) delete process.env.PAPERCLIP_CONFIG;
    else process.env.PAPERCLIP_CONFIG = originalEnv.paperclipConfig;
    if (originalEnv.instanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalEnv.instanceId;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "paperclip",
      aud: "paperclip-api",
      responsible_user_id: null,
      instance_id: "default",
    });
  });

  it("includes responsible user and non-standard key scope claims", () => {
    const token = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "codex_local",
      "run-1",
      "user-1",
      { kind: "skill_test", issueId: "issue-1" },
    );

    expect(verifyLocalAgentJwt(token!)).toMatchObject({
      responsible_user_id: "user-1",
      key_scope: { kind: "skill_test", issueId: "issue-1" },
      instance_id: "default",
    });
  });

  it("rejects a token signed for another instance or company", () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");
    process.env.PAPERCLIP_INSTANCE_ID = "fork-instance";
    expect(verifyLocalAgentJwt(token!)).toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      sub: "agent-1",
      company_id: "company-2",
      adapter_type: "codex_local",
      run_id: "run-1",
      iat: 1767225600,
      exp: 1767229200,
      iss: "paperclip",
      aud: "paperclip-api",
      instance_id: "default",
    })).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const key = createHmac("sha256", "test-secret").update("jwt:default:company-1").digest("hex");
    const signature = createHmac("sha256", key).update(signingInput).digest("base64url");
    expect(verifyLocalAgentJwt(`${signingInput}.${signature}`)).toBeNull();
  });

  it("loads PAPERCLIP_AGENT_JWT_SECRET from the Paperclip env file when it is absent from process env", () => {
    tempDir = mkdtempSync(join(tmpdir(), "paperclip-agent-jwt-"));
    const configDir = join(tempDir, ".paperclip");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "{}", "utf-8");
    writeFileSync(join(configDir, ".env"), "PAPERCLIP_AGENT_JWT_SECRET=file-secret\n", "utf-8");
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env[secretEnv];

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "hermes_local", "run-1");

    expect(typeof token).toBe("string");
    expect(verifyLocalAgentJwt(token!)).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "hermes_local",
      run_id: "run-1",
    });
  });

  it("returns null when secret is missing", () => {
    tempDir = mkdtempSync(join(tmpdir(), "paperclip-agent-jwt-missing-"));
    const configDir = join(tempDir, ".paperclip");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "{}", "utf-8");
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});
