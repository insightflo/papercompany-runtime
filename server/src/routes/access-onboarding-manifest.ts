import type { Request } from "express";
import type { invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";

export function requestBaseUrl(req: Request) {
  const forwardedProto = req.header("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host =
    req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  if (!host) return "";
  return `${proto}://${host}`;
}

export type JoinDiagnostic = {
  code: string;
  level: "info" | "warn";
  message: string;
  hint?: string;
};

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function normalizeHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1
      ? trimmed.slice(1, end).toLowerCase()
      : trimmed.toLowerCase();
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon > -1) return trimmed.slice(0, firstColon).toLowerCase();
  return trimmed.toLowerCase();
}

export function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect
) {
  const baseUrl = requestBaseUrl(req);
  const onboardingPath = `/api/invites/${token}/onboarding`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const inviteMessage = extractInviteMessage(invite);
  return {
    id: invite.id,
    companyId: invite.companyId,
    inviteType: invite.inviteType,
    allowedJoinTypes: invite.allowedJoinTypes,
    expiresAt: invite.expiresAt,
    onboardingPath,
    onboardingUrl: baseUrl ? `${baseUrl}${onboardingPath}` : onboardingPath,
    onboardingTextPath,
    onboardingTextUrl: baseUrl
      ? `${baseUrl}${onboardingTextPath}`
      : onboardingTextPath,
    skillIndexPath: "/api/skills/index",
    skillIndexUrl: baseUrl
      ? `${baseUrl}/api/skills/index`
      : "/api/skills/index",
    inviteMessage
  };
}

function buildOnboardingDiscoveryDiagnostics(input: {
  apiBaseUrl: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  let apiHost: string | null = null;
  if (input.apiBaseUrl) {
    try {
      apiHost = normalizeHostname(new URL(input.apiBaseUrl).hostname);
    } catch {
      apiHost = null;
    }
  }

  const bindHost = normalizeHostname(input.bindHost);
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  if (apiHost && isLoopbackHost(apiHost)) {
    diagnostics.push({
      code: "openclaw_onboarding_api_loopback",
      level: "warn",
      message:
        "Onboarding URL resolves to loopback hostname. Remote OpenClaw agents cannot reach localhost on your Paperclip host.",
      hint: "Use a reachable hostname/IP (for example Tailscale hostname, Docker host alias, or public domain)."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    (!bindHost || isLoopbackHost(bindHost))
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_loopback_bind",
      level: "warn",
      message: "Paperclip is bound to loopback in authenticated/private mode.",
      hint: "Run with a reachable bind host or use pnpm dev --tailscale-auth for private-network onboarding."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    apiHost &&
    !isLoopbackHost(apiHost) &&
    allowSet.size > 0 &&
    !allowSet.has(apiHost)
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_host_not_allowed",
      level: "warn",
      message: `Onboarding host "${apiHost}" is not in allowed hostnames for authenticated/private mode.`,
      hint: `Run pnpm paperclipai allowed-hostname ${apiHost}`
    });
  }

  return diagnostics;
}

function buildOnboardingConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}): string[] {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) {
      base = new URL(input.apiBaseUrl);
    }
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();

  if (base) {
    candidates.add(base.origin);
  }

  const bindHost = normalizeHostname(input.bindHost);
  if (bindHost && !isLoopbackHost(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && isLoopbackHost(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  return Array.from(candidates);
}

export function buildInviteOnboardingManifest(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const baseUrl = requestBaseUrl(req);
  const skillPath = "/api/skills/paperclip";
  const skillUrl = baseUrl ? `${baseUrl}${skillPath}` : skillPath;
  const registrationEndpointPath = `/api/invites/${token}/accept`;
  const registrationEndpointUrl = baseUrl
    ? `${baseUrl}${registrationEndpointPath}`
    : registrationEndpointPath;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const onboardingTextUrl = baseUrl
    ? `${baseUrl}${onboardingTextPath}`
    : onboardingTextPath;
  const discoveryDiagnostics = buildOnboardingDiscoveryDiagnostics({
    apiBaseUrl: baseUrl,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });
  const connectionCandidates = buildOnboardingConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });

  return {
    invite: toInviteSummaryResponse(req, token, invite),
    onboarding: {
      instructions:
        "Join as an OpenClaw Gateway agent, save your one-time claim secret, wait for board approval, then claim your API key. Save the claim response token to ~/.openclaw/workspace/paperclip-claimed-api-key.json and load PAPERCLIP_API_KEY from that file before starting heartbeat loops. You MUST submit adapterType='openclaw_gateway', set agentDefaultsPayload.url to your ws:// or wss:// OpenClaw gateway endpoint, and include agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth).",
      inviteMessage: extractInviteMessage(invite),
      recommendedAdapterType: "openclaw_gateway",
      requiredFields: {
        requestType: "agent",
        agentName: "Display name for this agent",
        adapterType: "Use 'openclaw_gateway' for OpenClaw Gateway agents",
        capabilities: "Optional capability summary",
        agentDefaultsPayload:
          "Adapter config for OpenClaw gateway. MUST include url (ws:// or wss://) and headers.x-openclaw-token (or legacy x-openclaw-auth). Optional fields: paperclipApiUrl, waitTimeoutMs, sessionKeyStrategy, sessionKey, role, scopes, disableDeviceAuth, devicePrivateKeyPem."
      },
      registrationEndpoint: {
        method: "POST",
        path: registrationEndpointPath,
        url: registrationEndpointUrl
      },
      claimEndpointTemplate: {
        method: "POST",
        path: "/api/join-requests/{requestId}/claim-api-key",
        body: {
          claimSecret:
            "one-time claim secret returned when the join request is created"
        }
      },
      connectivity: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bindHost: opts.bindHost,
        allowedHostnames: opts.allowedHostnames,
        connectionCandidates,
        diagnostics: discoveryDiagnostics,
        guidance:
          opts.deploymentMode === "authenticated" &&
          opts.deploymentExposure === "private"
            ? "If OpenClaw runs on another machine, ensure the Paperclip hostname is reachable and allowed via `pnpm paperclipai allowed-hostname <host>`."
            : "Ensure OpenClaw can reach this Paperclip API base URL for invite, claim, and skill bootstrap calls."
      },
      textInstructions: {
        path: onboardingTextPath,
        url: onboardingTextUrl,
        contentType: "text/plain"
      },
      skill: {
        name: "paperclip",
        path: skillPath,
        url: skillUrl,
        installPath: "~/.openclaw/skills/paperclip/SKILL.md"
      }
    }
  };
}

function extractInviteMessage(
  invite: typeof invites.$inferSelect
): string | null {
  const rawDefaults = invite.defaultsPayload;
  if (
    !rawDefaults ||
    typeof rawDefaults !== "object" ||
    Array.isArray(rawDefaults)
  ) {
    return null;
  }
  const rawMessage = (rawDefaults as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const trimmed = rawMessage.trim();
  return trimmed.length ? trimmed : null;
}
