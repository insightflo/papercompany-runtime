import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseEnvFileContents } from "dotenv";
import { resolvePaperclipEnvPath } from "./paths.js";
import { resolvePaperclipInstanceId } from "./home-paths.js";
import { normalizeAgentApiKeyScope, type AgentApiKeyScope } from "@paperclipai/shared";

export { normalizeAgentApiKeyScope } from "@paperclipai/shared";
export type { AgentApiKeyScope } from "@paperclipai/shared";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  responsible_user_id?: string | null;
  key_scope?: AgentApiKeyScope | null;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  instance_id?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readSecretFromPaperclipEnvFile(): string | null {
  try {
    const envPath = resolvePaperclipEnvPath();
    if (!existsSync(envPath)) return null;
    const parsed = parseEnvFileContents(readFileSync(envPath, "utf-8"));
    const value = typeof parsed.PAPERCLIP_AGENT_JWT_SECRET === "string"
      ? parsed.PAPERCLIP_AGENT_JWT_SECRET.trim()
      : "";
    return value || null;
  } catch {
    return null;
  }
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || readSecretFromPaperclipEnvFile();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
    instanceId: resolvePaperclipInstanceId(),
    disableLegacyFallback: parseBooleanEnv(process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK),
  };
}

function deriveCompanySigningKey(masterSecret: string, companyId: string, instanceId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLocalAgentJwt(
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
  responsibleUserId?: string | null,
  keyScope: AgentApiKeyScope = { kind: "standard" },
) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    responsible_user_id: responsibleUserId?.trim() || null,
    ...(keyScope.kind === "standard" ? {} : { key_scope: keyScope }),
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
    instance_id: config.instanceId,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signingKey = deriveCompanySigningKey(config.secret, companyId, config.instanceId);
  const signature = signPayload(signingKey, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  if (!companyId) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const derivedSignature = signPayload(
    deriveCompanySigningKey(config.secret, companyId, config.instanceId),
    signingInput,
  );
  let signatureOk = safeCompare(signature, derivedSignature);
  if (!signatureOk && !config.disableLegacyFallback) {
    signatureOk = safeCompare(signature, signPayload(config.secret, signingInput));
  }
  if (!signatureOk) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  const instanceId = typeof claims.instance_id === "string" ? claims.instance_id : undefined;
  if (instanceId && instanceId !== config.instanceId) return null;
  const responsibleUserId = Object.hasOwn(claims, "responsible_user_id")
    ? typeof claims.responsible_user_id === "string" && claims.responsible_user_id.trim()
      ? claims.responsible_user_id.trim()
      : null
    : undefined;
  const keyScope = Object.hasOwn(claims, "key_scope")
    ? normalizeAgentApiKeyScope(claims.key_scope)
    : undefined;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    ...(responsibleUserId !== undefined ? { responsible_user_id: responsibleUserId } : {}),
    ...(keyScope !== undefined ? { key_scope: keyScope } : {}),
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    ...(instanceId ? { instance_id: instanceId } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
